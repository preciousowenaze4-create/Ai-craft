export const config = {
  runtime: 'edge',
};

interface SearchResultItem {
  title: string;
  snippet: string;
  url: string;
  source: string;
  imageUrl?: string;
}

interface SearchImageItem {
  title: string;
  imageUrl: string;
  source: string;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs = 3000,
  acceptHeader = 'application/json'
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: acceptHeader,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function runLiveBrowserSearch(query: string): Promise<{
  query: string;
  results: SearchResultItem[];
  images: SearchImageItem[];
}> {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return { query: '', results: [], images: [] };
  }

  const results: SearchResultItem[] = [];
  const images: SearchImageItem[] = [];
  const seenUrls = new Set<string>();
  const seenImages = new Set<string>();

  const addResult = (item: SearchResultItem) => {
    if (!item.snippet.trim() && !item.title.trim()) return;
    const key = item.url || item.title.toLowerCase();
    if (seenUrls.has(key)) return;
    seenUrls.add(key);
    results.push(item);
  };

  const addImage = (title: string, imageUrl: string | undefined, source: string) => {
    if (!imageUrl || !/^https:\/\//i.test(imageUrl)) return;
    if (/\.(?:svg|ico|gif)(?:\?|$)/i.test(imageUrl)) return;
    if (seenImages.has(imageUrl)) return;
    seenImages.add(imageUrl);
    images.push({ title: title || cleanQuery, imageUrl, source });
  };

  const ddgTask = (async () => {
    try {
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(cleanQuery)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetchWithTimeout(ddgUrl, 2800);
      if (!res.ok) return;
      const data = (await res.json()) as {
        Heading?: string;
        AbstractText?: string;
        AbstractURL?: string;
        AbstractSource?: string;
        Image?: string;
        Answer?: string;
        RelatedTopics?: Array<{
          Text?: string;
          FirstURL?: string;
          Topics?: Array<{ Text?: string; FirstURL?: string }>;
        }>;
      };

      if (data.Image && /^https?:\/\//i.test(data.Image)) {
        const normalizedImg = data.Image.startsWith('http://')
          ? `https://${data.Image.slice(7)}`
          : data.Image;
        addImage(data.Heading || cleanQuery, normalizedImg, 'DuckDuckGo');
      }

      if (data.Answer) {
        addResult({
          title: data.Heading || cleanQuery,
          snippet: data.Answer,
          url: data.AbstractURL || '',
          source: 'DuckDuckGo Instant Answer',
        });
      }

      if (data.AbstractText) {
        addResult({
          title: data.Heading || cleanQuery,
          snippet: data.AbstractText,
          url: data.AbstractURL || '',
          source: data.AbstractSource || 'DuckDuckGo',
        });
      }

      const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
      for (const item of related) {
        if (item.Text && item.FirstURL) {
          addResult({
            title: item.Text.split(' - ')[0] || cleanQuery,
            snippet: item.Text,
            url: item.FirstURL,
            source: 'Web',
          });
        } else if (Array.isArray(item.Topics)) {
          for (const sub of item.Topics.slice(0, 3)) {
            if (sub.Text && sub.FirstURL) {
              addResult({
                title: sub.Text.split(' - ')[0] || cleanQuery,
                snippet: sub.Text,
                url: sub.FirstURL,
                source: 'Web',
              });
            }
          }
        }
        if (results.length >= 6) break;
      }
    } catch {
      // ignore timeout or network failure
    }
  })();

  const wikiTask = (async () => {
    try {
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
        cleanQuery
      )}&gsrlimit=4&prop=pageimages|extracts&pithumbsize=720&exintro=1&explaintext=1&exchars=240&format=json`;
      const res = await fetchWithTimeout(wikiUrl, 2800);
      if (!res.ok) return;
      const data = (await res.json()) as {
        query?: {
          pages?: Record<
            string,
            {
              pageid?: number;
              title?: string;
              extract?: string;
              thumbnail?: { source?: string };
            }
          >;
        };
      };
      const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
      for (const page of pages) {
        const title = page.title?.trim() || '';
        const snippet = (page.extract || '').trim();
        const thumb = page.thumbnail?.source?.trim();
        if (thumb) {
          addImage(title || cleanQuery, thumb, 'Wikipedia Images');
        }
        if (title && snippet) {
          addResult({
            title,
            snippet,
            url: `https://en.wikipedia.org/?curid=${page.pageid ?? ''}`,
            source: 'Wikipedia',
            ...(thumb && /\.(?:jpg|jpeg|png|webp)(?:\?|$)/i.test(thumb)
              ? { imageUrl: thumb }
              : {}),
          });
        }
      }
    } catch {
      // ignore timeout or network failure
    }
  })();

  const commonsTask = (async () => {
    try {
      const commonsUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(
        cleanQuery
      )}&gsrlimit=5&prop=imageinfo&iiprop=url|mime&iiurlwidth=720&format=json`;
      const res = await fetchWithTimeout(commonsUrl, 2800);
      if (!res.ok) return;
      const data = (await res.json()) as {
        query?: {
          pages?: Record<
            string,
            {
              title?: string;
              imageinfo?: Array<{ thumburl?: string; url?: string; mime?: string }>;
            }
          >;
        };
      };
      const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
      for (const page of pages) {
        const info = page.imageinfo?.[0];
        const mime = info?.mime || '';
        if (!/^image\/(jpeg|png|webp)$/i.test(mime)) continue;
        const imgUrl = info?.thumburl || info?.url;
        const cleanTitle = (page.title || cleanQuery)
          .replace(/^File:/i, '')
          .replace(/\.[a-z0-9]+$/i, '')
          .replace(/[_-]+/g, ' ')
          .trim();
        addImage(cleanTitle, imgUrl, 'Wikimedia Commons');
      }
    } catch {
      // ignore timeout or network failure
    }
  })();

  const bingImagesTask = (async () => {
    try {
      const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(
        cleanQuery
      )}&form=HDRSC2&first=1`;
      const res = await fetchWithTimeout(
        bingUrl,
        3200,
        'text/html,application/xhtml+xml'
      );
      if (!res.ok) return;
      const html = await res.text();
      const matches = html.matchAll(/murl&quot;:&quot;(https:\/\/[^&]+?)&quot;/gi);
      let count = 0;
      for (const m of matches) {
        const imgUrl = m[1]
          ?.replace(/\\u002f/gi, '/')
          .replace(/\\u003a/gi, ':');
        if (!imgUrl) continue;
        addImage(cleanQuery, imgUrl, 'Bing Web Images');
        count += 1;
        if (count >= 6) break;
      }
    } catch {
      // ignore timeout or network failure
    }
  })();

  await Promise.allSettled([ddgTask, bingImagesTask, wikiTask, commonsTask]);
  return {
    query: cleanQuery,
    results: results.slice(0, 8),
    images: images.slice(0, 8),
  };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) {
    return Response.json({ query: '', results: [], images: [] });
  }
  const data = await runLiveBrowserSearch(q);
  return Response.json(data);
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { query?: string; q?: string };
    const q = (body?.query || body?.q || '').trim();
    if (!q) {
      return Response.json({ query: '', results: [], images: [] });
    }
    const data = await runLiveBrowserSearch(q);
    return Response.json(data);
  } catch {
    return Response.json({ error: 'Invalid search payload.' }, { status: 400 });
  }
}
