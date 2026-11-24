import vm from 'node:vm';
import {
  deriveServerSessionTitle,
  extractLogoDirectiveFromRaw,
  sanitizeSessionTitle,
} from './_appsStore.js';

export interface SearchResultItem {
  title: string;
  snippet: string;
  url: string;
  source: string;
  imageUrl?: string;
}

export interface SearchImageItem {
  title: string;
  imageUrl: string;
  source: string;
}

export interface SearchVideoItem {
  title: string;
  videoUrl: string;
  posterUrl?: string;
  source: string;
}

export interface LiveBuildArtifact {
  path: string;
  action: string;
}

export interface ParsedDbColumn {
  name: string;
  type: 'text' | 'number' | 'boolean' | 'timestamp' | 'json';
  required?: boolean;
}

export interface ParsedDbTable {
  name: string;
  columns: ParsedDbColumn[];
}

export type InitialRoute = 'chat' | 'build' | 'auto';

export const START_MARKER = '<<<AICRAFT_APP_HTML>>>';
export const END_MARKER = '<<<END_AICRAFT_APP_HTML>>>';
export const HOLDBACK_CHARS = 36;

export async function fetchWithTimeout(
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

export function buildFocusedSearchQuery(rawPrompt: string): string {
  const cleaned = String(rawPrompt || '')
    .replace(/\[\[\s*CONTINUE_BUILD\s*\]\]/gi, '')
    .replace(/["'`]/g, ' ')
    .replace(
      /\b(?:please|can you|could you|would you|i want you to|i need you to|help me|build me|build|create me|create|make me|make|design me|design|develop|code|craft|generate|put together|search the|search for|search|find me|look up|an?|the|my|app|mobile app|web app|website|webpage|webapp|clone|like|with|using|that has|for me|so that|real time|real-time|functioning|functional|database|step by step)\b/gi,
      ' '
    )
    .replace(/[^\w\s&+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length >= 3) {
    return cleaned.slice(0, 140).trim();
  }
  return String(rawPrompt || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

export async function runLiveBrowserSearch(query: string): Promise<{
  query: string;
  results: SearchResultItem[];
  images: SearchImageItem[];
  videos: SearchVideoItem[];
}> {
  const cleanQuery = query.trim().slice(0, 260);
  if (!cleanQuery) {
    return { query: '', results: [], images: [], videos: [] };
  }

  const results: SearchResultItem[] = [];
  const images: SearchImageItem[] = [];
  const videos: SearchVideoItem[] = [];
  const seenUrls = new Set<string>();
  const seenImages = new Set<string>();
  const seenVideos = new Set<string>();

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

  const addVideo = (
    title: string,
    videoUrl: string | undefined,
    posterUrl: string | undefined,
    source: string
  ) => {
    if (!videoUrl || !/^https:\/\//i.test(videoUrl)) return;
    if (seenVideos.has(videoUrl)) return;
    seenVideos.add(videoUrl);
    videos.push({
      title: title || cleanQuery,
      videoUrl,
      ...(posterUrl && /^https:\/\//i.test(posterUrl) ? { posterUrl } : {}),
      source,
    });
  };

  const ddgTask = (async () => {
    try {
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(
        cleanQuery
      )}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetchWithTimeout(ddgUrl, 2600);
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
      const res = await fetchWithTimeout(wikiUrl, 2600);
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
      )}&gsrlimit=5&prop=imageinfo&iiprop=url|mime&iiurlwidth=800&format=json`;
      const res = await fetchWithTimeout(commonsUrl, 2400);
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
        const cleanTitle = (page.title || cleanQuery)
          .replace(/^File:/i, '')
          .replace(/\.[a-z0-9]+$/i, '')
          .replace(/[_-]+/g, ' ')
          .trim();
        if (/^video\/(mp4|webm)$/i.test(mime) && info?.url) {
          addVideo(cleanTitle, info.url, info.thumburl, 'Wikimedia Commons Video');
        } else if (/^image\/(jpeg|png|webp)$/i.test(mime)) {
          addImage(cleanTitle, info?.thumburl || info?.url, 'Wikimedia Commons');
        }
      }
    } catch {
      // ignore timeout or network failure
    }
  })();

  const commonsVideoTask = (async () => {
    try {
      const videoQuery =
        cleanQuery
          .replace(/\b(tiktok|reels|shorts|youtube|app|build|create|make|like|video|videos)\b/gi, '')
          .trim() || 'city nature dance';
      const fetchCommonsVideos = async (qStr: string) => {
        const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(
          qStr
        )}&gsrlimit=6&prop=imageinfo&iiprop=url|mime&iiurlwidth=720&format=json`;
        const res = await fetchWithTimeout(url, 2200);
        if (!res.ok) return [];
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
        return data?.query?.pages ? Object.values(data.query.pages) : [];
      };

      let pages = await fetchCommonsVideos(`filemime:video/webm ${videoQuery}`);
      if (pages.length === 0) {
        pages = await fetchCommonsVideos('filemime:video/webm timelapse');
      }
      for (const page of pages) {
        const info = page.imageinfo?.[0];
        const mime = info?.mime || '';
        const vidUrl = info?.url || '';
        if (!/^video\/(webm|mp4)/i.test(mime) && !/\.(?:webm|mp4)(?:\?|$)/i.test(vidUrl)) {
          continue;
        }
        const cleanTitle = (page.title || cleanQuery)
          .replace(/^File:/i, '')
          .replace(/\.[a-z0-9]+$/i, '')
          .replace(/[_-]+/g, ' ')
          .trim();
        addVideo(cleanTitle, vidUrl, info?.thumburl, 'Wikimedia Commons Video');
      }
    } catch {
      // ignore timeout or network failure
    }
  })();

  const bingImgTask = (async () => {
    try {
      const bingUrl = `https://www.bing.com/images/async?q=${encodeURIComponent(
        cleanQuery
      )}&async=content&first=1&count=12`;
      const res = await fetchWithTimeout(bingUrl, 2600, 'text/html,application/xhtml+xml');
      if (!res.ok) return;
      const html = await res.text();
      const matches = Array.from(
        html.matchAll(/murl&quot;:&quot;(https:\/\/[^&"]+)&quot;/g)
      );
      for (const m of matches.slice(0, 10)) {
        const rawUrl = m[1]?.replace(/\\u002f/gi, '/').trim();
        if (
          rawUrl &&
          !/vecteezy\.com|shutterstock\.com|istockphoto\.com|dreamstime\.com|123rf\.com/i.test(
            rawUrl
          )
        ) {
          addImage(cleanQuery, rawUrl, 'Web Image Search');
        }
      }
    } catch {
      // ignore timeout or network failure
    }
  })();

  const ddgHtmlTask = (async () => {
    try {
      const ddgHtmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(
        cleanQuery
      )}`;
      const res = await fetchWithTimeout(ddgHtmlUrl, 2500, 'text/html,application/xhtml+xml');
      if (!res.ok) return;
      const html = await res.text();
      const blocks = html.split(/class="result__body"/i).slice(1, 6);
      for (const block of blocks) {
        const titleMatch = /class="result__a"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        const snippetMatch = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block) ||
          /class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
        const hrefMatch = /href="(https?:\/\/[^"]+)"/i.exec(block);
        const stripHtml = (s: string) =>
          s
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#x27;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();
        const title = titleMatch ? stripHtml(titleMatch[1]) : cleanQuery;
        const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';
        if (snippet.length > 15) {
          addResult({
            title: title || cleanQuery,
            snippet: snippet.slice(0, 280),
            url: hrefMatch ? hrefMatch[1] : '',
            source: 'DuckDuckGo Web',
          });
        }
      }
    } catch {
      // ignore timeout or network failure
    }
  })();

  await Promise.allSettled([
    ddgTask,
    ddgHtmlTask,
    wikiTask,
    commonsTask,
    commonsVideoTask,
    bingImgTask,
  ]);
  return {
    query: cleanQuery,
    results: results.slice(0, 8),
    images: images.slice(0, 8),
    videos: videos.slice(0, 6),
  };
}

export function formatWebSearchContext(searchData: {
  query: string;
  results: SearchResultItem[];
  images?: SearchImageItem[];
  videos?: SearchVideoItem[];
}): string {
  const sections: string[] = [];

  if (searchData.results && searchData.results.length > 0) {
    const lines = searchData.results.map(
      (item, idx) =>
        `${idx + 1}. [${item.source}] ${item.title}: ${item.snippet}${
          item.url ? ` (${item.url})` : ''
        }`
    );
    sections.push(
      `Live Browser & Web Search Results for "${searchData.query}":\n${lines.join('\n')}`
    );
  }

  if (searchData.images && searchData.images.length > 0) {
    const imgLines = searchData.images.map(
      (img, idx) => `${idx + 1}. ${img.title} (${img.source}): ${img.imageUrl}`
    );
    sections.push(
      `Verified Image Search Results (real HTTPS image URLs — only use these exact URLs with clean onerror gradient fallback if relevant):\n${imgLines.join('\n')}`
    );
  }

  if (searchData.videos && searchData.videos.length > 0) {
    const vidLines = searchData.videos.map(
      (vid, idx) =>
        `${idx + 1}. ${vid.title} (${vid.source}): video=${vid.videoUrl}${
          vid.posterUrl ? ` | poster=${vid.posterUrl}` : ''
        }`
    );
    sections.push(
      `Verified Video Search Results (real playable HTTPS WebM/MP4 URLs + posters — wire directly into <video src="..." poster="..." playsinline muted loop> with poster/artwork fallback if relevant):\n${vidLines.join('\n')}`
    );
  }

  if (sections.length === 0) return '';
  sections.push(
    'Use these verified real-world facts, real images, and real playable videos naturally in your design and app data when relevant.'
  );
  return sections.join('\n\n');
}

export function shouldRunChatSearch(message: string, hasPreviousHtml = false): boolean {
  const clean = message.trim();
  const wordCount = clean.split(/\s+/).filter(Boolean).length;
  if (clean.length < 4) return false;
  if (
    /^(hi|hello|hey|yo|sup|don|test|testing|yes|no|yeah|nope|sure|ok|okay|cool|nice|great|awesome|lol|haha|good morning|good afternoon|good evening|good night|bye|good|bro|boss|thanks|thank you|thx)[!.\s]*$/i.test(
      clean
    )
  ) {
    return false;
  }
  if (
    wordCount <= 2 &&
    !/\b(weather|news|price|bitcoin|btc|usd|ngn|score|stock|time)\b/i.test(clean)
  ) {
    return false;
  }
  if (
    /^(who are you|what are you|how are you|what can you do|how do you work|can we chat|just asking)\b/i.test(
      clean
    )
  ) {
    return false;
  }
  if (
    hasPreviousHtml &&
    /\b(this app|the app|my app|this screen|the screen|the preview|you built|you made|you added|what does (it|this)|how does (it|this)|why is (it|this|there)|did you (add|build|put|make))\b/i.test(
      clean
    ) &&
    !/\b(search|google|look up|online|internet|weather|news|price|live data|stock)\b/i.test(
      clean
    )
  ) {
    return false;
  }
  return true;
}

export function isGameBuildPrompt(message: string): boolean {
  return /\b(games?|gmae|arcade|snake|tetris|pong|chess|ludo|checkers|sudoku|puzzle|shooter|racing|runner|flappy|platformer|blackjack|solitaire|memory\s*match|tic[\s-]*tac[\s-]*toe|wordle|brick\s*breaker|minesweeper|tower\s*defense|rpg|trivia\s*game)\b/i.test(
    message
  );
}

export function shouldSkipSlowWebSearchForBuild(
  message: string,
  hasAttachmentData = false
): boolean {
  if (hasAttachmentData) return false;
  const text = message.trim();
  const explicitlyWantsWebData =
    /\b(search|google|look\s*up|online|internet|real\s*photos?|real\s*images?|real\s*videos?|youtube|tiktok|instagram|news|weather|stocks?|crypto|bitcoin|prices?|store|shop|ecommerce|marketplace|restaurant|hotel|clinic|hospital|flight)\b/i.test(
      text
    );
  if (explicitlyWantsWebData) return false;

  if (isGameBuildPrompt(text)) return true;

  return /\b(calculator|timer|stopwatch|countdown|pomodoro|clock|alarm|converter|todo|to-do|checklist|notes?|drawing|sketchpad|paint|piano|drum\s*pad|dice|scoreboard|counter|flashcards?)\b/i.test(
    text
  );
}

export function classifyInitialRoute(
  message: string,
  previousHtml: string,
  attachmentName?: string | null,
  hasAttachmentData = false
): InitialRoute {
  const text = message.trim();
  if (!text) return 'chat';

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  const isPoliteBuildCommand =
    /^(?:can|could|would|will|please)\s+(?:you\s+)?(?:please\s+)?(?:build|bulid|biuld|buil|create|creat|cretae|make|mak|design|desgin|code|craft|develop|devlop|fix|change|edit|update|add|remove|cut|delete|replace|redesign|upgrade|monetize|implement|connect|integrate|wire|turn|switch|put)\b/i.test(
      text
    );

  const hasExplicitAppArtifact =
    /\b(app|mobile\s*app|ios\s*app|android\s*app|website|web\s*app|webpage|landing\s*page|site|storefront|dashboard|ecommerce|e-commerce|online\s*store|store|shop|portfolio|calculator|tracker|clone|prototype|ui|ux|screen|html|preview|widget|interface|todo|to-do|games?|gmae|arcade|snake|tetris|pong|chess|ludo|sudoku|puzzle|shooter|racing|flappy|player|quiz|planner|calendar|timer|clock|notes|chat\s*app|social|feed|blog|portal|tool|system|manager|finder|generator|converter|form|login|signup|paywall|checkout|subscription|monetization|tiktok|instagram|youtube|spotify|netflix|twitter|whatsapp|uber|airbnb|amazon)\b/i.test(
      text
    );

  const hasImperativeBuildVerb =
    /\b(build|bulid|biuld|buil|create|creat|cretae|make|mak|design|desgin|develop|devlop|generate|craft|code|scaffold|implement|redesign|upgrade|convert|monetize|integrate|connect|wire)\b/i.test(
      text
    );

  const hasEditVerb =
    /\b(change|update|modify|edit|fix|add|remove|cut|delete|take\s*out|replace|make\s+it|switch|turn|redesign|upgrade|rebuild|restructure|monetize|put)\b/i.test(
      text
    );

  if (attachmentName || hasAttachmentData) {
    const asksPureQuestion =
      (/\?$/.test(text) ||
        /^(what|why|how|who|where|when|which|is|are|does|do|did|explain|tell me)\b/i.test(
          text
        )) &&
      !isPoliteBuildCommand &&
      !hasEditVerb &&
      !hasImperativeBuildVerb;
    return asksPureQuestion ? 'chat' : 'build';
  }

  // Short casual greetings, names, reactions, or conversational single words with no build/app keywords -> immediate CHAT
  if (
    wordCount <= 3 &&
    !hasExplicitAppArtifact &&
    !hasImperativeBuildVerb &&
    !(previousHtml.trim().length > 0 && hasEditVerb)
  ) {
    return 'chat';
  }

  if (
    /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening|good night|thanks|thank you|ok|okay|cool|nice|great|awesome|how are you|who are you|what time|what day|what date)\b/i.test(
      text
    ) &&
    !hasImperativeBuildVerb &&
    !hasEditVerb
  ) {
    return 'chat';
  }

  // Pure questions / explanations / advice requests (including "how do I monetize an app?" or "did you build X?") -> CHAT unless explicitly commanding a build
  const startsAsQuestion =
    /^(what|why|how|who|where|when|which|is|are|was|were|does|do|did|have you|did you|are you|explain|tell me|can you explain|can you tell me|should i|what's)\b/i.test(
      text
    );

  if (
    (startsAsQuestion || /\?\s*$/.test(text)) &&
    !isPoliteBuildCommand &&
    !/\b(build me|bulid me|create me|make me|do my app|add .+ to (my|the) app|put .+ in (my|the) app)\b/i.test(
      text
    )
  ) {
    return 'chat';
  }

  if (
    /\b(tell me a joke|make me laugh|make sense|make sure|write a (poem|story|essay|email|song|letter)|what time|what day|what date|who are you|what model|how are you|explain\b|define\b)\b/i.test(
      text
    ) &&
    !isPoliteBuildCommand &&
    !/\b(do my app|build me|bulid me|create me|make me)\b/i.test(text)
  ) {
    return 'chat';
  }

  if (
    hasExplicitAppArtifact &&
    (hasImperativeBuildVerb || /\b(for me|like|with)\b/i.test(text) || !startsAsQuestion)
  ) {
    return 'build';
  }

  if (
    /^(?:please\s+)?(?:build|bulid|biuld|create|creat|make|mak|design|scaffold|craft|monetize)\s+(?:me\s+)?(?:an?|the|my)\s+/i.test(
      text
    ) &&
    !/\b(summary|poem|story|joke|essay|recipe|explanation|sentence|paragraph|list|plan)\b/i.test(
      text
    )
  ) {
    return 'build';
  }

  if (
    previousHtml.trim().length > 0 &&
    !startsAsQuestion &&
    hasEditVerb
  ) {
    return 'build';
  }

  return 'auto';
}

export function stripReasoningTags(raw: string): string {
  // Remove complete <think>...</think> blocks emitted by reasoning models (Qwen3 / DeepSeek-R1)
  // AND any trailing unclosed <think> if only reasoning started before markers.
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  const openThinkIdx = cleaned.search(/<think>/i);
  if (openThinkIdx !== -1 && !/<\/think>/i.test(cleaned.slice(openThinkIdx))) {
    cleaned = cleaned.slice(0, openThinkIdx);
  }
  return cleaned;
}

export function findCodeStart(
  raw: string
): { markerIdx: number; htmlOffset: number; isPatch?: boolean } | null {
  const patchMarkerMatch = /<<<\s*AICRAFT_PATCH\s*>>>/i.exec(raw);
  const markerMatch = /<<<\s*AICRAFT_APP_HTML\s*>>>/i.exec(raw);

  if (
    patchMarkerMatch &&
    patchMarkerMatch.index !== undefined &&
    (!markerMatch || patchMarkerMatch.index < markerMatch.index)
  ) {
    return {
      markerIdx: patchMarkerMatch.index,
      htmlOffset: patchMarkerMatch.index + patchMarkerMatch[0].length,
      isPatch: true,
    };
  }

  if (markerMatch && markerMatch.index !== undefined) {
    return {
      markerIdx: markerMatch.index,
      htmlOffset: markerMatch.index + markerMatch[0].length,
    };
  }

  const fenceMatch =
    /```(?:html|htm)?\s*\n?\s*(?=<!doctype|<html|<head|<body|<style|<div|<main|<section)/i.exec(
      raw
    );
  if (fenceMatch && fenceMatch.index !== undefined) {
    return {
      markerIdx: fenceMatch.index,
      htmlOffset: fenceMatch.index + fenceMatch[0].length,
    };
  }

  const rawHtmlMatch = /(?:^|\n)\s*(<!doctype\s+html|<html\b)/i.exec(raw);
  if (rawHtmlMatch && rawHtmlMatch.index !== undefined) {
    const tagIdx = raw.indexOf(rawHtmlMatch[1], rawHtmlMatch.index);
    return { markerIdx: tagIdx, htmlOffset: tagIdx };
  }

  return null;
}

export function assembleHtmlFromScatteredBlocks(raw: string): string {
  const htmlBlocks: string[] = [];
  const cssBlocks: string[] = [];
  const jsBlocks: string[] = [];

  const fenceRegex = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(raw)) !== null) {
    const lang = (match[1] || '').toLowerCase();
    const content = (match[2] || '').trim();
    if (!content) continue;

    if (lang === 'html' || lang === 'htm') {
      htmlBlocks.push(content);
    } else if (lang === 'css') {
      cssBlocks.push(content);
    } else if (lang === 'js' || lang === 'javascript') {
      jsBlocks.push(content);
    } else if (!lang && /<[a-z][^>]*>/i.test(content)) {
      htmlBlocks.push(content);
    }
  }

  if (htmlBlocks.length === 0) return '';

  let bodyHtml = htmlBlocks.join('\n');
  if (/<!doctype|<html\b/i.test(bodyHtml)) {
    if (cssBlocks.length > 0 && !/<style\b/i.test(bodyHtml)) {
      const styleTag = `<style>\n${cssBlocks.join('\n\n')}\n</style>`;
      bodyHtml = /<\/head>/i.test(bodyHtml)
        ? bodyHtml.replace(/<\/head>/i, `${styleTag}\n</head>`)
        : `${styleTag}\n${bodyHtml}`;
    }
    if (jsBlocks.length > 0 && !/<script(?![^>]*\bsrc=)[^>]*>/i.test(bodyHtml)) {
      const scriptTag = `<script>\n${jsBlocks.join('\n\n')}\n</script>`;
      bodyHtml = /<\/body>/i.test(bodyHtml)
        ? bodyHtml.replace(/<\/body>/i, `${scriptTag}\n</body>`)
        : `${bodyHtml}\n${scriptTag}`;
    }
    return bodyHtml.trim();
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; min-height: 100dvh; width: 100%; font-family: system-ui, -apple-system, sans-serif; }
  ${cssBlocks.join('\n\n')}
</style>
</head>
<body>
${bodyHtml}
${jsBlocks.length > 0 ? `<script>\n${jsBlocks.join('\n\n')}\n</script>` : ''}
</body>
</html>`;
}

export function extractPreviewHtmlFromRaw(raw: string): string {
  const cleanRaw = stripReasoningTags(raw);
  const codeStart = findCodeStart(cleanRaw);
  if (codeStart?.isPatch) {
    return '';
  }
  if (codeStart) {
    let rawHtml = cleanRaw.slice(codeStart.htmlOffset);
    const endMarkerMatch = /<<<\s*END_AICRAFT_APP_HTML\s*>>>/i.exec(rawHtml);
    if (endMarkerMatch && endMarkerMatch.index !== undefined) {
      rawHtml = rawHtml.slice(0, endMarkerMatch.index);
    }
    rawHtml = rawHtml
      .trim()
      .replace(/^```(?:html|htm)?\s*/i, '')
      .replace(/\s*```[\s\S]*$/i, '')
      .trim();

    if (rawHtml && /<[a-z][\s\S]*>/i.test(rawHtml)) {
      if (!/<!doctype|<html\b/i.test(rawHtml)) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
</head>
<body style="margin:0;min-height:100dvh;width:100%;">
${rawHtml}
</body>
</html>`;
      }
      return rawHtml;
    }
  }

  return assembleHtmlFromScatteredBlocks(cleanRaw);
}

function stripPatchMarkdownFences(snippet: string): string {
  return snippet
    .replace(/\r\n/g, '\n')
    .trim()
    .replace(/^```(?:html|htm|css|javascript|js)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

/**
 * Finds the character index immediately AFTER the closing tag of the LAST
 * [data-screen] / [data-view] / [data-tab] / [data-page] sibling element so
 * appended screens stay cleanly inside the exact same parent (<main>, .screens, etc.).
 */
function findLastScreenElementEndIndex(html: string): number {
  const openRe =
    /<(section|div|main|article)\b[^>]*\b(?:data-screen|data-view|data-page|data-tab)=["'][^"']+["'][^>]*>/gi;
  let lastEnd = -1;
  let m: RegExpExecArray | null;

  while ((m = openRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const startIdx = m.index;
    const tagPairRe = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'gi');
    tagPairRe.lastIndex = startIdx;
    let depth = 0;
    let tm: RegExpExecArray | null;
    while ((tm = tagPairRe.exec(html)) !== null) {
      if (tm[0].startsWith('</')) {
        depth -= 1;
        if (depth <= 0) {
          lastEnd = tm.index + tm[0].length;
          break;
        }
      } else {
        depth += 1;
      }
    }
  }
  return lastEnd;
}

/**
 * Applies targeted <<<AICRAFT_PATCH>>> operations onto existing HTML cleanly
 * without rebuilding or respoiling untouched screens, styles, handlers, or DB wiring.
 */
export function applySurgicalPatchesToHtml(
  existingHtml: string,
  rawOutput: string
): { html: string; appliedCount: number; failedCount: number } {
  const cleanRaw = stripReasoningTags(rawOutput);
  if (!existingHtml.trim() || !/<<<\s*AICRAFT_PATCH\s*>>>/i.test(cleanRaw)) {
    return { html: '', appliedCount: 0, failedCount: 0 };
  }

  let updated = existingHtml;
  let appliedCount = 0;
  let failedCount = 0;

  const patchBlockRegex =
    /<<<\s*AICRAFT_PATCH\s*>>>([\s\S]*?)(?:<<<\s*END_PATCH\s*>>>|<<<\s*END_AICRAFT_PATCH\s*>>>|$)/gi;
  let match: RegExpExecArray | null;

  while ((match = patchBlockRegex.exec(cleanRaw)) !== null) {
    const block = match[1] || '';

    // 1. SEARCH / REPLACE blocks
    const srRegex =
      /<<<\s*SEARCH\s*>>>\s*\n?([\s\S]*?)\n?<<<\s*REPLACE\s*>>>\s*\n?([\s\S]*?)(?=<<<\s*(?:SEARCH|APPEND_CSS|APPEND_SCREEN|APPEND_SCRIPT|END_PATCH|END_AICRAFT_PATCH)\s*>>>|$)/gi;
    let srMatch: RegExpExecArray | null;
    while ((srMatch = srRegex.exec(block)) !== null) {
      const searchStr = stripPatchMarkdownFences(srMatch[1]);
      const replaceStr = stripPatchMarkdownFences(srMatch[2]);
      if (!searchStr) continue;

      if (updated.includes(searchStr)) {
        updated = updated.replace(searchStr, () => replaceStr);
        appliedCount += 1;
        continue;
      }

      const rawSearch = srMatch[1].replace(/\r\n/g, '\n');
      const rawReplace = srMatch[2].replace(/\r\n/g, '\n');
      if (rawSearch.trim() && updated.includes(rawSearch)) {
        updated = updated.replace(rawSearch, () => rawReplace);
        appliedCount += 1;
        continue;
      }

      // Regex whitespace-normalized fallback match for short-to-medium anchors
      const searchLines = searchStr
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (searchLines.length > 0 && searchLines.length <= 28) {
        const escapedPattern = searchLines
          .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('\\s+');
        try {
          const flexRe = new RegExp(escapedPattern);
          if (flexRe.test(updated)) {
            updated = updated.replace(flexRe, () => replaceStr);
            appliedCount += 1;
            continue;
          }
        } catch {
          // ignore invalid regex
        }
      }

      failedCount += 1;
    }

    // 2. APPEND_CSS blocks (all occurrences, inserted before data-aicraft-safety style if present)
    const cssRegex =
      /<<<\s*APPEND_CSS\s*>>>\s*\n?([\s\S]*?)(?=<<<\s*(?:SEARCH|APPEND_CSS|APPEND_SCREEN|APPEND_SCRIPT|END_PATCH|END_AICRAFT_PATCH)\s*>>>|$)/gi;
    for (const cssMatch of block.matchAll(cssRegex)) {
      const cssSnippet = stripPatchMarkdownFences(cssMatch[1] || '');
      if (!cssSnippet) continue;
      const safetyStyleIdx = updated.indexOf('data-aicraft-safety');
      const targetStyleClose =
        safetyStyleIdx !== -1
          ? updated.toLowerCase().lastIndexOf('</style>', safetyStyleIdx)
          : updated.toLowerCase().lastIndexOf('</style>');
      if (targetStyleClose !== -1) {
        updated = `${updated.slice(0, targetStyleClose)}\n${cssSnippet}\n${updated.slice(targetStyleClose)}`;
        appliedCount += 1;
      } else if (/<\/head>/i.test(updated)) {
        const headClose = updated.toLowerCase().indexOf('</head>');
        updated = `${updated.slice(0, headClose)}<style>\n${cssSnippet}\n</style>\n${updated.slice(headClose)}`;
        appliedCount += 1;
      }
    }

    // 3. APPEND_SCREEN blocks (insert inside existing screen sibling container, never outside <main> or above top <nav>)
    const screenRegex =
      /<<<\s*APPEND_SCREEN\s*>>>\s*\n?([\s\S]*?)(?=<<<\s*(?:SEARCH|APPEND_CSS|APPEND_SCREEN|APPEND_SCRIPT|END_PATCH|END_AICRAFT_PATCH)\s*>>>|$)/gi;
    for (const screenMatch of block.matchAll(screenRegex)) {
      const screenSnippet = stripPatchMarkdownFences(screenMatch[1] || '');
      if (!screenSnippet) continue;
      const siblingEndIdx = findLastScreenElementEndIndex(updated);
      if (siblingEndIdx !== -1) {
        updated = `${updated.slice(0, siblingEndIdx)}\n${screenSnippet}${updated.slice(siblingEndIdx)}`;
        appliedCount += 1;
      } else if (/<\/main>/i.test(updated)) {
        const mainClose = updated.toLowerCase().lastIndexOf('</main>');
        updated = `${updated.slice(0, mainClose)}${screenSnippet}\n${updated.slice(mainClose)}`;
        appliedCount += 1;
      } else if (/<nav\b[^>]*class=["'][^"']*bottom/i.test(updated)) {
        const navIdx = updated.search(/<nav\b[^>]*class=["'][^"']*bottom/i);
        updated = `${updated.slice(0, navIdx)}${screenSnippet}\n${updated.slice(navIdx)}`;
        appliedCount += 1;
      } else if (/<script\b/i.test(updated)) {
        const scriptIdx = updated.toLowerCase().indexOf('<script');
        updated = `${updated.slice(0, scriptIdx)}${screenSnippet}\n${updated.slice(scriptIdx)}`;
        appliedCount += 1;
      } else if (/<\/body>/i.test(updated)) {
        const bodyClose = updated.toLowerCase().lastIndexOf('</body>');
        updated = `${updated.slice(0, bodyClose)}${screenSnippet}\n${updated.slice(bodyClose)}`;
        appliedCount += 1;
      }
    }

    // 4. APPEND_SCRIPT blocks (all occurrences, inserted BEFORE data-aicraft-safety-js)
    const jsRegex =
      /<<<\s*APPEND_SCRIPT\s*>>>\s*\n?([\s\S]*?)(?=<<<\s*(?:SEARCH|APPEND_CSS|APPEND_SCREEN|APPEND_SCRIPT|END_PATCH|END_AICRAFT_PATCH)\s*>>>|$)/gi;
    for (const jsMatch of block.matchAll(jsRegex)) {
      const jsSnippet = stripPatchMarkdownFences(jsMatch[1] || '');
      if (!jsSnippet) continue;
      const beforeSafety = updated.indexOf('data-aicraft-safety-js');
      const targetCloseIdx =
        beforeSafety !== -1
          ? updated.toLowerCase().lastIndexOf('</script>', beforeSafety)
          : updated.toLowerCase().lastIndexOf('</script>');
      if (targetCloseIdx !== -1) {
        updated = `${updated.slice(0, targetCloseIdx)}\n${jsSnippet}\n${updated.slice(targetCloseIdx)}`;
        appliedCount += 1;
      } else if (beforeSafety !== -1) {
        const safetyScriptOpen = updated.toLowerCase().lastIndexOf('<script', beforeSafety);
        if (safetyScriptOpen !== -1) {
          updated = `${updated.slice(0, safetyScriptOpen)}<script>\n${jsSnippet}\n</script>\n${updated.slice(safetyScriptOpen)}`;
          appliedCount += 1;
        }
      } else if (/<\/body>/i.test(updated)) {
        const bodyClose = updated.toLowerCase().lastIndexOf('</body>');
        updated = `${updated.slice(0, bodyClose)}<script>\n${jsSnippet}\n</script>\n${updated.slice(bodyClose)}`;
        appliedCount += 1;
      }
    }
  }

  return {
    html: appliedCount > 0 ? updated : '',
    appliedCount,
    failedCount,
  };
}

export function finalizePartialPreviewHtml(raw: string): string {
  let html = extractPreviewHtmlFromRaw(raw);
  if (!html) return '';

  const lastOpenBracket = html.lastIndexOf('<');
  const lastCloseBracket = html.lastIndexOf('>');
  if (lastOpenBracket > lastCloseBracket && lastOpenBracket > 0) {
    html = html.slice(0, lastOpenBracket).trimEnd();
  }

  const lastScriptOpen = html.toLowerCase().lastIndexOf('<script');
  const lastScriptClose = html.toLowerCase().lastIndexOf('</script>');
  if (lastScriptOpen > lastScriptClose) {
    const lastNewline = html.lastIndexOf('\n');
    if (lastNewline > lastScriptOpen) {
      html = html.slice(0, lastNewline);
    }
    html += '\n</script>';
  }

  const lastStyleOpen = html.toLowerCase().lastIndexOf('<style');
  const lastStyleClose = html.toLowerCase().lastIndexOf('</style>');
  if (lastStyleOpen > lastStyleClose) {
    html += '\n</style>';
  }

  if (!/<\/body>/i.test(html)) html += '\n</body>';
  if (!/<\/html>/i.test(html)) html += '\n</html>';
  return html;
}

/**
 * Validates that generated Preview HTML is a real, complete, runnable app
 * (not a rushed empty shell, blank middle viewport, stub, or broken JS script).
 */
export function validateBuiltAppHtml(html: string): {
  valid: boolean;
  reason?: string;
} {
  const trimmed = html.trim();
  if (!trimmed || trimmed.length < 1600) {
    return {
      valid: false,
      reason: `Preview HTML is too short (${trimmed.length} chars) to be a complete interactive app.`,
    };
  }

  // Reject unclosed tags that indicate mid-generation truncation
  const scriptOpens = (trimmed.match(/<script\b/gi) || []).length;
  const scriptCloses = (trimmed.match(/<\/script>/gi) || []).length;
  if (scriptOpens > scriptCloses) {
    return {
      valid: false,
      reason: 'Preview HTML contains an unclosed <script> block (truncated output).',
    };
  }

  const styleOpens = (trimmed.match(/<style\b/gi) || []).length;
  const styleCloses = (trimmed.match(/<\/style>/gi) || []).length;
  if (styleOpens > styleCloses) {
    return {
      valid: false,
      reason: 'Preview HTML contains an unclosed <style> block (truncated output).',
    };
  }

  // Validate syntax of all inline JavaScript blocks with Node's vm.Script
  const inlineScriptRegex = /<script(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let totalInlineJsChars = 0;
  for (const match of trimmed.matchAll(inlineScriptRegex)) {
    const attrs = (match[1] || '').toLowerCase();
    if (
      attrs.includes('application/json') ||
      attrs.includes('application/ld+json') ||
      attrs.includes('importmap') ||
      attrs.includes('text/babel')
    ) {
      continue;
    }
    const jsCode = (match[2] || '').trim();
    if (!jsCode) continue;
    totalInlineJsChars += jsCode.length;
    try {
      new vm.Script(jsCode);
    } catch (syntaxErr) {
      return {
        valid: false,
        reason: `Inline <script> syntax error: ${
          syntaxErr instanceof Error ? syntaxErr.message : String(syntaxErr)
        }`,
      };
    }
  }

  // Extract visible body markup (excluding style/script)
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(trimmed);
  const bodyContent = (bodyMatch ? bodyMatch[1] : trimmed)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .trim();

  if (bodyContent.length < 180) {
    return {
      valid: false,
      reason: 'Preview <body> lacks substantive visible UI markup.',
    };
  }

  // Reject bare shells whose main viewport container is empty and has near-zero JS to populate it
  const interactiveElements = (
    bodyContent.match(
      /<(?:button|input|select|textarea|section|article|main|form|canvas|svg|a|li)\b/gi
    ) || []
  ).length;
  if (interactiveElements < 4) {
    return {
      valid: false,
      reason: 'Preview UI has fewer than 4 interactive or content elements.',
    };
  }

  if (totalInlineJsChars < 180 && bodyContent.length < 900) {
    return {
      valid: false,
      reason: 'App lacks working interactive JavaScript logic and state persistence.',
    };
  }

  // Catch classic empty placeholder stubs
  if (
    /\b(todo:\s*implement|placeholder\s*content|coming\s+soon\s*\.{0,3}<\/|insert\s+code\s+here)\b/i.test(
      bodyContent
    )
  ) {
    return {
      valid: false,
      reason: 'App output contained unfinished placeholder stub text.',
    };
  }

  return { valid: true };
}

/**
 * Ensures responsive viewport meta, mobile bottom-nav safe-area padding,
 * image onerror graceful fallback, and icon resilience without overriding design.
 */
export function sanitizeAndHardenPreviewHtml(html: string): string {
  let out = html.trim();
  if (!out) return out;

  // Normalize rigid 100vh in CSS declarations to 100dvh so mobile safe-areas never leave a white strip
  out = out.replace(/(:\s*)(100vh\b)/gi, '$1100dvh');

  if (!/<meta\b[^>]*name=["']viewport["']/i.test(out)) {
    const vpTag =
      '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />';
    out = /<head\b[^>]*>/i.test(out)
      ? out.replace(/<head\b[^>]*>/i, (m) => `${m}\n${vpTag}`)
      : `${vpTag}\n${out}`;
  }

  const hasSafetyMarker = out.includes('data-aicraft-safety');
  if (!hasSafetyMarker) {
    const safetyStyle = `<style data-aicraft-safety="1">
:where(html) { width: 100%; height: 100%; min-height: 100%; margin: 0; padding: 0; max-width: 100%; overflow-x: hidden; -webkit-tap-highlight-color: transparent; }
:where(body) { width: 100%; min-height: 100%; margin: 0; padding: 0; max-width: 100%; overflow-x: hidden; }
:where(*, *::before, *::after) { box-sizing: border-box; }
:where(nav[class*="bottom"], .bottom-nav, footer.app-nav, #bottom-nav) { padding-bottom: max(12px, env(safe-area-inset-bottom)); }
</style>`;
    out = /<\/head>/i.test(out)
      ? out.replace(/<\/head>/i, `${safetyStyle}\n</head>`)
      : `${safetyStyle}\n${out}`;

    const safetyScript = `<script data-aicraft-safety-js="1">
(function(){
  function isOpaqueColor(c) {
    return Boolean(c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)' && !/^rgba\\([^)]*,\\s*0(\\.0+)?\\s*\\)$/i.test(c));
  }
  function syncDocumentSurface() {
    try {
      var bg = '';
      var candidates = [
        document.body,
        document.querySelector('[data-screen].active, [data-view].active, main, #app, #root, .app, .app-shell')
      ];
      for (var i = 0; i < candidates.length; i += 1) {
        var node = candidates[i];
        if (!node) continue;
        var computed = window.getComputedStyle(node).backgroundColor;
        if (isOpaqueColor(computed)) { bg = computed; break; }
      }
      if (!bg) {
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta && meta.getAttribute('content')) bg = meta.getAttribute('content');
      }
      if (bg && document.documentElement) {
        document.documentElement.style.backgroundColor = bg;
        try {
          window.parent.postMessage({ type: 'aicraft:surface', color: bg }, '*');
        } catch (e) {}
      }
    } catch (e) {}
  }
  function patchBrokenImages() {
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i += 1) {
      var img = imgs[i];
      if (img.dataset.aicraftImgBound) continue;
      img.dataset.aicraftImgBound = '1';
      if (!img.getAttribute('referrerpolicy')) img.setAttribute('referrerpolicy', 'no-referrer');
      img.addEventListener('error', function() {
        if (this.dataset.aicraftFallbackDone) return;
        this.dataset.aicraftFallbackDone = '1';
        var label = (this.getAttribute('alt') || 'Media').replace(/[<>&"]/g, '').slice(0, 28);
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">' +
          '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0%" stop-color="#1E1B4B"/><stop offset="100%" stop-color="#312E81"/>' +
          '</linearGradient></defs>' +
          '<rect width="400" height="300" fill="url(#g)"/>' +
          '<circle cx="200" cy="130" r="34" fill="rgba(255,255,255,0.12)"/>' +
          '<text x="200" y="198" text-anchor="middle" fill="rgba(255,255,255,0.85)" font-family="system-ui,sans-serif" font-size="16" font-weight="600">' +
          label + '</text></svg>';
        this.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      });
    }
  }
  function patchBrokenVideos() {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i += 1) {
      var vid = videos[i];
      if (vid.dataset.aicraftVidBound) continue;
      vid.dataset.aicraftVidBound = '1';
      vid.setAttribute('playsinline', '');
      vid.setAttribute('webkit-playsinline', '');
      var showPosterFallback = function(v) {
        if (!v || v.dataset.aicraftVidFallback) return;
        v.dataset.aicraftVidFallback = '1';
        var poster = v.getAttribute('poster') || '';
        if (poster) {
          v.style.backgroundImage = 'url("' + poster.replace(/"/g, '') + '")';
          v.style.backgroundSize = 'cover';
          v.style.backgroundPosition = 'center';
        } else {
          v.style.background = 'radial-gradient(circle at 30% 25%, #312E81 0%, #0F172A 65%, #020617 100%)';
        }
      };
      vid.addEventListener('error', function() { showPosterFallback(this); });
      if (!vid.getAttribute('src') && !vid.querySelector('source[src]')) {
        showPosterFallback(vid);
      }
    }
  }
  function ensureVisibleScreen() {
    var screens = document.querySelectorAll('[data-screen], [data-view], [data-tab]');
    if (!screens.length) return;
    var anyVisible = false;
    for (var i = 0; i < screens.length; i += 1) {
      var st = window.getComputedStyle(screens[i]);
      if (st.display !== 'none' && st.visibility !== 'hidden' && screens[i].offsetHeight > 0) {
        anyVisible = true;
        break;
      }
    }
    if (!anyVisible && screens[0]) {
      screens[0].classList.add('active');
      screens[0].style.display = 'flex';
      if (!screens[0].style.flexDirection) screens[0].style.flexDirection = 'column';
      if (!screens[0].style.flex) screens[0].style.flex = '1 1 auto';
      if (!screens[0].style.minHeight) screens[0].style.minHeight = '0';
    }
  }
  function patchLucidePlaceholders() {
    var nodes = document.querySelectorAll('[data-lucide]');
    if (!nodes.length) return;
    setTimeout(function() {
      if (window.lucide && typeof window.lucide.createIcons === 'function') {
        try { window.lucide.createIcons(); } catch (e) {}
      }
      var remaining = document.querySelectorAll('[data-lucide]:empty');
      for (var i = 0; i < remaining.length; i += 1) {
        var el = remaining[i];
        var icon = (el.getAttribute('data-lucide') || '').toLowerCase();
        var path = '<circle cx="12" cy="12" r="5"/>';
        if (icon.indexOf('plus') !== -1 || icon.indexOf('add') !== -1 || icon.indexOf('create') !== -1) {
          path = '<path d="M12 5v14M5 12h14"/>';
        } else if (icon.indexOf('home') !== -1) {
          path = '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>';
        } else if (icon.indexOf('search') !== -1) {
          path = '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>';
        } else if (icon.indexOf('user') !== -1 || icon.indexOf('profile') !== -1) {
          path = '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>';
        } else if (icon.indexOf('heart') !== -1 || icon.indexOf('like') !== -1) {
          path = '<path d="M12 21s-7-4.5-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.5-9 9-9 9z"/>';
        } else if (icon.indexOf('message') !== -1 || icon.indexOf('comment') !== -1 || icon.indexOf('chat') !== -1) {
          path = '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>';
        } else if (icon.indexOf('share') !== -1 || icon.indexOf('send') !== -1) {
          path = '<path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4Z"/>';
        }
        el.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
      }
    }, 350);
  }
  function runAllPatches() {
    syncDocumentSurface();
    patchBrokenImages();
    patchBrokenVideos();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      runAllPatches();
      patchLucidePlaceholders();
      setTimeout(function() { syncDocumentSurface(); ensureVisibleScreen(); }, 450);
    });
  } else {
    runAllPatches();
    patchLucidePlaceholders();
    setTimeout(function() { syncDocumentSurface(); ensureVisibleScreen(); }, 450);
  }
  if (typeof MutationObserver !== 'undefined') {
    var obs = new MutationObserver(function() { runAllPatches(); });
    if (document.documentElement) obs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
</script>`;
    out = /<\/body>/i.test(out)
      ? out.replace(/<\/body>/i, `${safetyScript}\n</body>`)
      : `${out}\n${safetyScript}`;
  }

  return out;
}

export function extractPreviewStructureSummary(previousHtml: string): string {
  if (!previousHtml.trim()) return '';
  const items = extractLiveBuildArtifacts(previousHtml).map(
    (a) => `${a.action} ${a.path}`
  );
  const screenMatches = Array.from(
    previousHtml.matchAll(
      /<(section|div|main|article)\b[^>]*\b(?:data-screen|data-view|data-page|data-tab)=["']([^"']{1,48})["']([^>]*)>/gi
    )
  )
    .slice(0, 12)
    .map((m) => {
      const titleMatch = /\b(?:data-screen-title|data-title|aria-label)=["']([^"']{1,48})["']/i.exec(
        m[0]
      );
      return titleMatch ? `${m[2]} ("${titleMatch[1]}")` : m[2];
    });

  const idMatches = Array.from(
    previousHtml.matchAll(
      /<(header|nav|main|section|aside|footer|div|form)\b[^>]*\bid=["']([^"']{1,40})["'][^>]*>/gi
    )
  )
    .slice(0, 18)
    .map((m) => `<${m[1].toLowerCase()} id="${m[2]}">`);

  const cssVars = Array.from(
    previousHtml.matchAll(/--([a-zA-Z0-9_-]{2,28})\s*:\s*([^;}\n]{1,42})/g)
  )
    .slice(0, 14)
    .map((m) => `--${m[1]}: ${m[2].trim()}`);

  const dbTables = extractDbSchemaFromHtml(previousHtml).map(
    (t) => `${t.name}(${t.columns.map((c) => c.name).join(', ')})`
  );

  const fnMatches = Array.from(
    previousHtml.matchAll(/\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]{1,36})\s*\(/g)
  )
    .slice(0, 14)
    .map((m) => `${m[1]}()`);

  const titleMatch = /<title\b[^>]*>([^<]{1,60})<\/title>/i.exec(previousHtml);
  const themeMatch =
    /<meta\b[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i.exec(
      previousHtml
    );
  const logoMatch = /<meta\b[^>]*name=["']aicraft-logo["'][^>]*>/i.exec(
    previousHtml
  );

  return [
    `Live Preview already holds a rendered app (${previousHtml.length} chars).`,
    titleMatch ? `Current app title: "${titleMatch[1].trim()}".` : '',
    themeMatch ? `Current browser theme-color: ${themeMatch[1].trim()}.` : '',
    logoMatch ? `Current app logo meta: ${logoMatch[0]}.` : '',
    screenMatches.length > 0 ? `Existing screens: ${screenMatches.join(', ')}.` : '',
    cssVars.length > 0 ? `Locked CSS design tokens (DO NOT change unless requested): ${Array.from(new Set(cssVars)).join('; ')}.` : '',
    dbTables.length > 0 ? `Existing window.AICraft.db tables: ${dbTables.join('; ')}.` : '',
    fnMatches.length > 0 ? `Existing JS functions: ${Array.from(new Set(fnMatches)).join(', ')}.` : '',
    items.length > 0 ? `Existing artifacts: ${items.join(', ')}.` : '',
    idMatches.length > 0
      ? `Existing DOM sections/IDs: ${idMatches.join(', ')}.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function sanitizeDbIdent(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function normalizeDbColType(
  rawType: string | undefined,
  colName: string
): ParsedDbColumn['type'] {
  const t = (rawType || '').trim().toLowerCase();
  if (
    t === 'number' ||
    t === 'numeric' ||
    t === 'int' ||
    t === 'integer' ||
    t === 'float' ||
    t === 'decimal'
  ) {
    return 'number';
  }
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (
    t === 'timestamp' ||
    t === 'timestamptz' ||
    t === 'datetime' ||
    t === 'date'
  ) {
    return 'timestamp';
  }
  if (t === 'json' || t === 'jsonb' || t === 'array' || t === 'object') {
    return 'json';
  }
  if (t === 'text' || t === 'string' || t === 'varchar' || t === 'uuid') {
    return 'text';
  }
  if (
    colName === 'created_at' ||
    colName === 'updated_at' ||
    colName.endsWith('_at')
  ) {
    return 'timestamp';
  }
  if (
    colName === 'count' ||
    colName === 'amount' ||
    colName === 'price' ||
    colName === 'likes' ||
    colName === 'views' ||
    colName.endsWith('_count')
  ) {
    return 'number';
  }
  if (colName.startsWith('is_') || colName.startsWith('has_')) return 'boolean';
  return 'text';
}

export function extractDbSchemaFromRaw(raw: string): ParsedDbTable[] {
  const tableMap = new Map<string, ParsedDbTable>();
  const regex = /\[\[\s*DB_SCHEMA\s*:\s*([^\]]+?)\s*\]\]/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const body = match[1].trim();
    const entries = body
      .split(/;|\|/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const tblMatch = /^([a-zA-Z0-9_-]+)\s*(?:\(([^)]*)\))?/.exec(entry);
      if (!tblMatch) continue;
      const tblName = sanitizeDbIdent(tblMatch[1]);
      if (!tblName) continue;
      const rawCols = (tblMatch[2] || 'id:text, created_at:timestamp')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const cols: ParsedDbColumn[] = [];
      const seenCols = new Set<string>();
      for (const colToken of rawCols) {
        const [rawCol, rawType] = colToken.split(':').map((s) => s.trim());
        const colName = sanitizeDbIdent(rawCol || '');
        if (!colName || seenCols.has(colName)) continue;
        seenCols.add(colName);
        cols.push({
          name: colName,
          type: normalizeDbColType(rawType, colName),
          required: colName === 'id',
        });
      }
      if (cols.length === 0) {
        cols.push(
          { name: 'id', type: 'text', required: true },
          { name: 'created_at', type: 'timestamp' }
        );
      }
      tableMap.set(tblName, { name: tblName, columns: cols });
    }
    if (tableMap.size >= 12) break;
  }
  return Array.from(tableMap.values());
}

export function extractDbSchemaFromHtml(html: string): ParsedDbTable[] {
  if (!html) return [];
  const tableMap = new Map<string, Map<string, ParsedDbColumn>>();
  const ensureTable = (rawName: string) => {
    const clean = sanitizeDbIdent(rawName);
    if (!clean) return null;
    let map = tableMap.get(clean);
    if (!map) {
      map = new Map<string, ParsedDbColumn>();
      tableMap.set(clean, map);
    }
    return map;
  };
  const addCol = (
    map: Map<string, ParsedDbColumn>,
    rawCol: string,
    rawType?: string
  ) => {
    const colName = sanitizeDbIdent(rawCol);
    if (!colName || map.has(colName)) return;
    map.set(colName, {
      name: colName,
      type: normalizeDbColType(rawType, colName),
      required: colName === 'id',
    });
  };

  const dbCallRegex =
    /AICraft\.db\.\w+\(\s*['"`]([a-zA-Z0-9_-]+)['"`](?:\s*,\s*(?:['"`][^'"`]*['"`]\s*,\s*)?\{([\s\S]{0,400}?)\})?/g;
  for (const m of html.matchAll(dbCallRegex)) {
    const colMap = ensureTable(m[1] || '');
    if (!colMap) continue;
    addCol(colMap, 'id', 'text');
    if (m[2]) {
      const propRegex = /(?:^|[,{])\s*['"]?([a-zA-Z_][a-zA-Z0-9_]*)['"]?\s*:/g;
      for (const p of m[2].matchAll(propRegex)) {
        if (p[1]) addCol(colMap, p[1]);
      }
    }
    addCol(colMap, 'created_at', 'timestamp');
  }

  return Array.from(tableMap.entries())
    .slice(0, 12)
    .map(([name, cols]) => ({ name, columns: Array.from(cols.values()) }));
}

export function mergeParsedDbTables(
  ...lists: ParsedDbTable[][]
): ParsedDbTable[] {
  const merged = new Map<string, ParsedDbTable>();
  for (const list of lists) {
    for (const tbl of list) {
      const cleanName = sanitizeDbIdent(tbl.name);
      if (!cleanName) continue;
      const existing = merged.get(cleanName);
      if (!existing) {
        merged.set(cleanName, { name: cleanName, columns: [...tbl.columns] });
      } else {
        const seen = new Set(existing.columns.map((c) => c.name));
        for (const col of tbl.columns) {
          if (!seen.has(col.name)) {
            seen.add(col.name);
            existing.columns.push(col);
          }
        }
      }
    }
  }
  return Array.from(merged.values());
}

export function extractSessionTitleFromRaw(raw: string): string {
  const match = /\[\[\s*TITLE\s*:\s*([^\]]+?)\s*\]\]/i.exec(raw);
  return match ? sanitizeSessionTitle(match[1]) : '';
}

export function stripTagMarkers(text: string): string {
  return stripReasoningTags(text)
    .replace(/\[\[\s*INTENT\s*:\s*(?:CHAT|BUILD)\s*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*MODE\s*:\s*(?:CHAT|GENERATE)\s*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*MEDIA_PROMPT\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*TITLE\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*LOGO\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*PLAN\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*DB_SCHEMA\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(
      /\[\[\s*SUGGESTIONS\s*\]\][\s\S]*?(?:\[\[\s*\/\s*SUGGESTIONS\s*\]\]|$)/gi,
      ''
    )
    .replace(
      /\[\[\s*(?:INTENT|MODE|MEDIA_PROMPT|TITLE|LOGO|PLAN|DB_SCHEMA|SUGGESTIONS|\/SUGGESTIONS)[^\]]*$/gi,
      ''
    )
    .replace(/\[$/g, '');
}

export function sanitizeBuildProse(text: string): string {
  return stripTagMarkers(text)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/```(?:html|htm|css|javascript|js|tsx|ts)?[\s\S]*/gi, '')
    .replace(/<<<\s*AICRAFT_APP_HTML\s*>>>[\s\S]*/gi, '')
    .replace(/<<<\s*END_AICRAFT_APP_HTML\s*>>>[\s\S]*/gi, '')
    .replace(/<<<\s*AICRAFT_PATCH\s*>>>[\s\S]*/gi, '')
    .replace(/<<<\s*(?:SEARCH|REPLACE|APPEND_CSS|APPEND_SCREEN|APPEND_SCRIPT|END_PATCH|END_AICRAFT_PATCH)\s*>>>[\s\S]*/gi, '')
    .replace(/<!doctype\s+html[\s\S]*/gi, '')
    .replace(/<html\b[\s\S]*/gi, '')
    .replace(/^\s*(?:PART\s*[123]\s*[:\-–]?)\s*/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractPlanStepsFromRaw(raw: string): string[] {
  const clean = stripReasoningTags(raw);
  const steps: string[] = [];
  const seen = new Set<string>();
  const regex = /\[\[\s*PLAN\s*:\s*([^\]]+?)\s*\]\]/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(clean)) !== null) {
    const step = match[1].replace(/\s+/g, ' ').trim();
    if (step && !seen.has(step.toLowerCase())) {
      seen.add(step.toLowerCase());
      steps.push(step);
    }
    if (steps.length >= 6) break;
  }
  return steps;
}

export function extractSuggestionsFromRaw(raw: string): string[] {
  const blockMatch =
    /\[\[\s*SUGGESTIONS\s*\]\]([\s\S]*?)(?:\[\[\s*\/\s*SUGGESTIONS\s*\]\]|$)/i.exec(
      stripReasoningTags(raw)
    );
  if (!blockMatch) return [];
  const lines = blockMatch[1]
    .split(/\r?\n|\|/)
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•]+|\d+[.)])\s*/, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim()
    )
    .filter((line) => line.length >= 10 && line.length <= 120);

  const unique: string[] = [];
  for (const l of lines) {
    if (!unique.some((u) => u.toLowerCase() === l.toLowerCase())) {
      unique.push(l);
    }
    if (unique.length >= 4) break;
  }
  return unique;
}

export function buildSmartFollowUpSuggestions(
  userMessage: string,
  previewHtml: string,
  mode: 'mobile' | 'web'
): string[] {
  const htmlLower = previewHtml.toLowerCase();
  const msgLower = userMessage.toLowerCase();
  const suggestions: string[] = [];

  if (!/checkout|stripe|payment|billing|receipt/i.test(htmlLower)) {
    suggestions.push(
      'Add a working Pro checkout flow with instant unlock and receipt history'
    );
  } else {
    suggestions.push(
      'Upgrade the monetization dashboard with real-time revenue analytics and promo codes'
    );
  }

  if (!/window\.aicraft\.search/i.test(htmlLower)) {
    suggestions.push(
      'Connect live Google & image search inside the app so users can discover real items'
    );
  } else if (!/dark|theme/i.test(msgLower)) {
    suggestions.push(
      'Add a smooth dark/light theme switcher and custom accent color picker'
    );
  }

  if (mode === 'mobile') {
    suggestions.push(
      'Polish button placement, micro-animations, and add a quick onboarding tour'
    );
  } else {
    suggestions.push(
      'Add interactive real-time charts, filters, and one-click CSV data export'
    );
  }

  return suggestions.slice(0, 3);
}

export function extractLiveBuildArtifacts(htmlSoFar: string): LiveBuildArtifact[] {
  const clean = htmlSoFar.trim();
  if (!clean) return [];

  const artifacts: LiveBuildArtifact[] = [];
  const seen = new Set<string>();
  const add = (artifactPath: string, action: string) => {
    if (!seen.has(artifactPath)) {
      seen.add(artifactPath);
      artifacts.push({ path: artifactPath, action });
    }
  };

  add('index.html', 'Writing');

  if (/<style\b/i.test(clean)) {
    add('styles.css', 'Styling');
  }

  const tagRegex =
    /<(header|nav|canvas|form|footer)\b[^>]*>|<(?:section|template|article|main)\b[^>]*\bid=["']([a-zA-Z0-9_-]{2,36})["'][^>]*>|<\w+\b[^>]*\b(?:data-screen|data-view|data-tab|data-page|data-module)=["']([a-zA-Z0-9_-]{2,36})["'][^>]*>|<div\b[^>]*\bid=["']([a-zA-Z0-9_-]*(?:screen|view|page|tab|feed|post|upload|create|profile|account|home|explore|discover|inbox|chat|message|comment|search|cart|checkout|pricing|paywall|upgrade|pro|premium|billing|revenue|dashboard|settings|player|modal|notification|reel|story|wallet|analytics|monetize|auth|login)[a-zA-Z0-9_-]*)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(clean)) !== null) {
    const semanticTag = match[1]?.toLowerCase();
    const namedView = (match[2] || match[3] || match[4])?.toLowerCase();
    if (semanticTag) {
      if (semanticTag === 'canvas') {
        add('components/canvas.html', 'Rendering');
      } else if (semanticTag === 'nav') {
        add('components/navigation.html', 'Building');
      } else if (semanticTag === 'header') {
        add('components/header.html', 'Building');
      } else if (semanticTag === 'footer') {
        add('components/footer.html', 'Building');
      } else if (semanticTag === 'form') {
        add('components/form.html', 'Building');
      }
    } else if (
      namedView &&
      !/^(app|root|container|wrapper|main|body|content|page|shell)$/i.test(namedView)
    ) {
      add(`screens/${namedView}.html`, 'Building');
    }
    if (artifacts.length >= 12) break;
  }

  if (/\bAICraft\.db\./i.test(clean)) {
    add('database/schema.js', 'Wiring');
  }
  if (/paywall|checkout|pricing|subscribe|stripe|wallet|pro-modal/i.test(clean)) {
    add('modules/monetization.js', 'Building');
  }

  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(clean)) {
    add('app.js', 'Scripting');
  }

  return artifacts;
}

export function buildProjectInfraContext(params: {
  secretHints: Array<{ key: string; hint: string }>;
  secretKeys: string[];
  databaseTables: string[];
}): string {
  const { secretHints, secretKeys, databaseTables } = params;
  const effectiveKeysSummary =
    secretHints.length > 0
      ? secretHints.map((s) => `${s.key} (${s.hint})`).join(', ')
      : secretKeys.join(', ');

  return [
    'PROJECT SECRETS & REAL-TIME DATABASE INFRASTRUCTURE (CRITICAL — READ CAREFULLY):',
    secretHints.length > 0
      ? `- Saved project Secrets configured in this project right now (values are securely injected at runtime in Preview — NEVER ask the user to paste keys into chat): ${effectiveKeysSummary}.`
      : '- No project Secret keys saved yet. Users add any API key/token anytime via the "Secrets" button in the bottom composer toolbar (+ Add secret -> Apply changes).',
    '- RUNTIME SECRETS DISCOVERY: In generated HTML apps, read secrets using `window.AICraft.getSecret("EXACT_KEY")` OR smart pattern lookup `window.AICraft.findSecret("pattern1", "pattern2", ...)` (which searches both custom key names AND credential types). All secrets are also available on `window.AICraft.env`, `window.ENV`, `window.__AICRAFT_ENV__`, and `process.env`.',
    '- RULE WHEN USER SAYS KEYS ARE IN SECRETS: Whenever the user says they pasted a key into Secrets, immediately inspect the configured Secret keys & detected types above, wire them directly into the generated app code using both `getSecret("EXACT_KEY")` and `findSecret(...)` fallback, and confirm which exact key name(s) you connected.',
    databaseTables.length > 0
      ? `- Existing structured project Database tables: ${databaseTables.join('; ')}.`
      : '- The project Database drawer automatically captures and structures real-time tables as the app is built and used.',
    '- REAL SUPABASE + GOOGLE LOGIN + REAL DATABASE WIRING: When Supabase secrets are configured in Secrets OR requested by the user: load `@supabase/supabase-js@2` via `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>`, initialize `window.supabase.createClient(sbUrl, sbKey)` using Secrets (`getSecret` + `findSecret` fallback), wire `supabaseClient.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.href } })` + `onAuthStateChange` + real `supabaseClient.from(table).select/insert/update/delete`, AND sync records into `window.AICraft.db` while emitting `[[DB_SCHEMA: ...]]` lines.',
    '- BUILT-IN REAL-TIME DATABASE API: For every app with data persistence, wire ALL views cleanly to `await window.AICraft.db.list("table")`, `await window.AICraft.db.insert("table", row)`, `await window.AICraft.db.update("table", id, patch)`, and `await window.AICraft.db.remove("table", id)`. Re-render the DOM immediately after every mutation — NEVER hardcode static mock cards that bypass the database.',
    '- CLEAN WEB/APP DELIVERY & OPT-IN LOGO / PWA: Deliver clean, responsive apps inside the browser by default WITHOUT injecting any unsolicited app logo, custom SVG emblem, or PWA "Add to Home Screen" manifest/install UI. ONLY create a brand logo (`[[LOGO:...]]`) or enable PWA Home Screen installability (`<meta name="aicraft-pwa" content="enabled" />`) when the user explicitly asks for a logo/icon, snaps/attaches a logo picture to add to the app, or explicitly asks to make the app installable / Add to Home Screen.',
    '- LIVE SEARCH & MEDIA GENERATION IN APPS: Inside generated apps, you can call `await window.AICraft.search(query)` (returns `{ query, results, images, videos }` with real web facts, HTTPS images, AND playable HTTPS MP4/WebM video URLs + poster images!), `await window.AICraft.ask(prompt)`, `await window.AICraft.generateImage(prompt)`, or `await window.AICraft.generateMusic(prompt)`.',
  ].join('\n');
}

export function buildCraftSystemPrompt(params: {
  mediaKind: 'image' | 'music' | 'video' | null;
  requestedModel: string;
  requestedModelLabel?: string;
  initialRoute: InitialRoute;
  shouldGenerateTitle: boolean;
  timeContext: string;
  projectInfraContext: string;
  projectMemoryContext?: string;
  designBlueprint?: string;
  webSearchContext: string;
  previewSummary: string;
  mode: 'mobile' | 'web';
  activeFlags: string[];
  isGameBuild?: boolean;
}): string {
  const {
    mediaKind,
    requestedModel,
    requestedModelLabel,
    initialRoute,
    shouldGenerateTitle,
    timeContext,
    projectInfraContext,
    projectMemoryContext,
    designBlueprint,
    webSearchContext,
    previewSummary,
    mode,
    activeFlags,
    isGameBuild = false,
  } = params;

  const targetLabel =
    mode === 'mobile'
      ? 'iOS & Android mobile app'
      : 'full-stack web application';

  if (mediaKind !== null) {
    const mediaLabel =
      mediaKind === 'video'
        ? 'Video Generator'
        : mediaKind === 'music'
          ? 'Music Generator'
          : 'Image Generator';
    const selectedLabel = requestedModelLabel || requestedModel || mediaLabel;

    return [
      `You are AI Craft acting specifically in ${mediaLabel} mode (selected model: "${selectedLabel}").`,
      `Real-time clock context: ${timeContext}.`,
      shouldGenerateTitle
        ? 'First output `[[TITLE: <Short 2-4 Word Title>]]` followed by a newline.'
        : '',
      'YOUR ROLE & CAPABILITY RULES (STRICT):',
      `- Right now the user has selected a dedicated ${mediaLabel}. You CANNOT build apps, websites, HTML, or code in this mode — app building belongs to **Code & Build** mode.`,
      "- Decide dynamically and naturally from the user's message:",
      '  (1) CHAT / APP-BUILD REQUEST / QUESTION: If the user asks to build an app or website (for example "build an app like TikTok"), greets you, or asks a general question:',
      `      Start with exactly \`[[MODE:CHAT]]\` followed by a newline, then reply naturally in your own words (warm, concise, never robotic). Explain that you are currently in ${mediaLabel} mode (${selectedLabel}) so you can't build apps right now, suggest switching the model selector to **Code & Build** to build an app, OR invite them to describe the ${mediaKind === 'music' ? 'music track' : mediaKind} they'd like you to generate!`,
      `  (2) CREATE / GENERATE ${mediaKind.toUpperCase()}: If the user asks you to generate, create, make, draw, compose, or render a/an ${mediaKind} (or directly describes a visual scene, song, beat, or video clip):`,
      `      Start with exactly \`[[MODE:GENERATE]]\` followed by a newline, write ONE short, natural sentence confirming what ${mediaKind} you are creating right now, and finish with \`[[MEDIA_PROMPT: <clean, descriptive prompt tailored for ${selectedLabel}>]]\`. Never output HTML, code blocks, or web links.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (initialRoute === 'chat') {
    const titleRuleForChat = shouldGenerateTitle
      ? 'SESSION TITLE LINE: Output a single tag `[[TITLE: <Short 2-4 Word Topic Title>]]` at the very beginning summarizing this conversation concisely, followed by a newline and your helpful conversational reply.'
      : '';

    return [
      'You are AI Craft, a sharp, warm, human-like AI product partner & engineer with live web search access.',
      `Real-time clock context: ${timeContext}.`,
      projectInfraContext,
      projectMemoryContext ? `\n${projectMemoryContext}` : '',
      webSearchContext ? `\n${webSearchContext}` : '',
      previewSummary
        ? `\nContext about what actually exists in the user's current Preview app right now (ONLY reference items that genuinely exist here):\n${previewSummary}`
        : '\nNo app has been built in Preview yet in this session.',
      titleRuleForChat,
      'HOW TO RESPOND RIGHT NOW (CHAT MODE — STRICT):',
      '- SPEED FIRST: reply fast and tight — lead with the answer, keep most replies under 120 words unless the user explicitly asks for detail, no preamble, never restate the question.',
      '- Talk naturally like a real human engineer — concise, helpful, clear, and honest.',
      '- Answer normal questions directly without outputting HTML, code blocks, fake build plans, or rebuilding Preview.',
      '- STRICT HONESTY: NEVER claim you built, added, fixed, changed, or connected anything in Preview unless it genuinely already exists in the context above. If you did not build an app on this turn, never say you did.',
      '- If the user asks how to monetize an app or build something (subscriptions, paywalls, Paystack/Stripe checkout, marketplace fees, ads, credits), give practical real-world guidance AND offer to build it right into their app whenever they ask you to.',
      '- NEVER tell the user to copy and paste code manually.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const titleRuleForBuild = shouldGenerateTitle
    ? 'STEP 00 (Short Session Title): Output a single tag `[[TITLE: <Short 2-4 Word App Title>]]` at the very start summarizing the user goal concisely before your PLAN lines.'
    : '';

  const buildRulesBlock = [
    'CALM SENIOR ENGINEER DISCIPLINE — THINK FIRST, BUILD REAL FUNCTIONAL APPS, NEVER RUSH INTO HARDCODED UI:',
    '- SHIP WORKING FIRST: build the complete functioning flow end-to-end before decorative polish — a smaller fully-working app beats a large half-wired one. Slow down, verify every handler mentally, then output.',
    '- NEVER rush into static HTML or fake hardcoded mockup screens! First pause and design the real domain data model, database tables, state transitions, event handlers, and CRUD workflows.',
    '- ZERO HARDCODED UI / ZERO DEAD STUBS: Every list, feed, dashboard counter, cart, message thread, booking, calendar, profile, filter, search bar, and modal MUST be dynamically rendered in JavaScript from live state persisted in `window.AICraft.db` (plus Secrets/Supabase when configured). NEVER hardcode static repeated HTML cards that cannot be created, edited, toggled, searched, or deleted!',
    '- SURGICAL LAYER EDIT & CROSS-AI CONTINUATION RULE (CRITICAL WHEN AN APP ALREADY EXISTS):',
    '  * Regardless of which AI built the earlier turn, YOU are continuing THAT EXACT codebase right from where it stopped!',
    '  * NEVER rebuild or overwrite the whole app from scratch when the user asks to add, edit, fix, restyle, or remove a specific feature/screen unless they explicitly ask for a brand-new redesign.',
    '  * For targeted edits or feature additions on an existing complete app, PREFER outputting fast surgical patch blocks inside `<<<AICRAFT_PATCH>>>...<<<END_PATCH>>>` (with exact `<<<SEARCH>>>...<<<REPLACE>>>...`, `<<<APPEND_CSS>>>`, `<<<APPEND_SCREEN>>>`, or `<<<APPEND_SCRIPT>>>`) so untouched screens, styles, buttons, and `window.AICraft.db` tables remain 100% intact!',
    '  * When resuming from a stopped/paused incomplete build (`[[CONTINUE_BUILD]]`) OR when restructuring the full shell, preserve ALL existing screens, styles, DB tables, and working handlers cleanly inside `<<<AICRAFT_APP_HTML>>>...<<<END_AICRAFT_APP_HTML>>>`.',
    '- MONETIZATION & REVENUE ARCHITECTURE (WHEN USER REQUESTS MONETIZATION / PAYMENTS / SUBSCRIPTIONS):',
    '  * Whenever the user asks to monetize their app (subscriptions, Pro/VIP plans, paywalls, Stripe/Paystack checkout, in-app wallet/credits, marketplace commissions, digital store checkout, or sponsored listings/ads), build a REAL interactive monetization system backed by `window.AICraft.db` (`plans`, `subscriptions`, `transactions`, `entitlements`, `orders`).',
    '  * Wire configured payment keys automatically via `window.AICraft.findSecret("paystack|stripe|flutterwave")` with real Paystack/Stripe client SDK checkout when a public key is present in `Secrets`, PLUS clean test-mode/sandbox verification, active Pro entitlement gating on premium features, and a live billing/receipts history view.',
    '  * Always be 100% honest in PART 1 about whether live payment keys from `Secrets` were connected or whether checkout currently runs in local Preview sandbox mode until they add their key in `Secrets`.',
    '- STRICT HONESTY & NO LINKS / UNSOLICITED LAUNCHERS: NEVER claim in your explanation that you built a feature unless that exact screen, button, handler, and DB-backed DOM logic is genuinely working inside PART 2. NEVER lie about capabilities or unbuilt actions. NEVER print app URLs/links inside your chat explanation, and never add an unsolicited "Open" banner inside the app.',
    '- REAL-WORLD GROUNDING (ZERO GENERIC PLACEHOLDERS): Use real verified facts, services, names, departments, and real HTTPS photos from `Live Browser & Web Search Results` when available (with clean `onerror` CSS gradient fallbacks). Never output dummy placeholders like "Item 1", "Feature A", or "Lorem ipsum".',
    titleRuleForBuild,
    'STEP 0 (Calm 5-Step Architecture & Database Thinking): Output 5 thoughtful, concrete engineering steps using exact format `[[PLAN: <step>]]` showing what you are designing BEFORE writing code:',
    '  1) `[[PLAN: Analyzing domain workflows & visual architecture — ...]]`',
    '  2) `[[PLAN: Designing real-time database tables & columns (`window.AICraft.db`) — ...]]`',
    '  3) `[[PLAN: Engineering dynamic multi-screen UI & responsive layout — ...]]`',
    '  4) `[[PLAN: Wiring live CRUD actions, search filters & form persistence — ...]]`',
    '  5) `[[PLAN: Verifying runtime handlers, edge cases & interactive states — ...]]`',
    'STEP 0B (Real-Time Database Schema Lines — MANDATORY FOR EVERY INTERACTIVE APP): Output one `[[DB_SCHEMA: table_name(col1:type, col2:type, ...)]]` line per table right after your PLAN lines (allowed column types: `text`, `number`, `boolean`, `timestamp`, `json`). Every interactive app must define real domain tables matching what the app stores (e.g., clinic app -> `appointments`, `doctors`, `patients`, `services`; chat app -> `conversations`, `messages`, `contacts`; store -> `products`, `cart_items`, `orders`).',
    'STEP 0C (STRICT OPT-IN LOGO & PWA RULE — DO NOT HARDCODE):',
    '  * BY DEFAULT: DO NOT output `[[LOGO: ...]]`, DO NOT put `<meta name="aicraft-logo">`, DO NOT hardcode `<svg id="aicraft-app-icon">` or invented brand logos in the header, and DO NOT include `<meta name="aicraft-pwa" content="enabled" />` or "Add to Home Screen" install prompts.',
    '  * ONLY IF the user explicitly asks for a logo/app icon OR snaps/attaches a logo image to add to the app: output `[[LOGO: bg=#HEX, accent=#HEX, theme=#HEX, motif=..., letters=XX]]` and cleanly integrate the user-requested/attached logo into the app header/brand mark.',
    '  * ONLY IF the user explicitly asks to make the app installable / Add to Home Screen / mobile home screen PWA: include `<meta name="aicraft-pwa" content="enabled" />` inside `<head>`.',
    'PART 1 (Honest Architectural Summary): Write 2–3 calm, clear plain-text sentences summarizing ONLY the exact screens, real-time `window.AICraft.db` tables, interactive controls, and real searched content you built or patched below. PROHIBITED IN PART 1: raw HTML/CSS/JS, markdown code fences (```), backticks, URLs/links, or the words "PART 1"/"PART 2"/"PART 3".',
    'PART 2 (Complete Real-Time App OR Surgical Patch): Output EITHER:',
    '  - (A) Full app build: `<<<AICRAFT_APP_HTML>>>` ...complete `<!DOCTYPE html>`... `<<<END_AICRAFT_APP_HTML>>>`',
    '  - (B) Surgical addition/edit on an existing app: `<<<AICRAFT_PATCH>>>` with exact `<<<SEARCH>>>...<<<REPLACE>>>...`, `<<<APPEND_CSS>>>`, `<<<APPEND_SCREEN>>>`, and/or `<<<APPEND_SCRIPT>>>` ending with `<<<END_PATCH>>>`',
    'MANDATORY REAL-APP COMPLETENESS & DYNAMIC ENGINEERING RULES FOR PART 2:',
    isGameBuild
      ? `1. PLAYABLE GAME ENGINE MODE (TARGET: ${targetLabel}): Build a genuinely FUN, immediately playable, tactile game — NEVER force 4–6 business CRUD screens onto a game! Include: (a) a crisp Title / Difficulty start screen or instant play arena with \`requestAnimationFrame\` 60fps delta-time loop on a HiDPI \`<canvas>\` (or responsive interactive game board for board/card/word games), (b) FULL mobile touch controls (drag/swipe + large >=48px on-screen D-pad/action buttons) AND desktop keyboard controls (Arrow keys/WASD/Space/P), (c) top HUD showing Score, Best Score, Lives/Wave/Timer, Pause, and Sound FX Mute toggle using synthesized Web Audio API beeps/chimes, (d) Game Over / Victory overlay with instant \`Play Again\` state reset (cancelling any stale intervals/RAF loops cleanly), and (e) real persistent High Score leaderboard stored in \`window.AICraft.db\` (\`scores\` table, seeded with 3 starter scores). If the user asked generally for "game" or "app like game", craft an addictive, polished Neon Arcade Striker / Brick & Orb Runner game that feels awesome on the very first tap.`
      : `1. TARGET EXPERIENCE: Engineer a complete, genuinely functional ${targetLabel}. NEVER stop after building one screen or static non-working cards! Build 4 to 6 distinct, fully interactive screens using semantic containers: \`<section data-screen="<id>" data-screen-title="<Screen Name>">...</section>\`. Every screen must render real state dynamically via JS functions and respond to user clicks, inputs, filters, edits, and deletions.`,
    '2. ZERO FRAGILE EXTERNAL CDNs FOR STYLING OR ICONS: Write ALL layout, spacing, typography, cards, feeds, modals, and animations cleanly inside `<style>...</style>`. DO NOT depend on `cdn.tailwindcss.com`, `unpkg.com/lucide`, React/Babel `<script type="text/babel">`, or icon font CDNs — use PURE INLINE `<svg>` paths (`width="20" height="20" viewBox="0 0 24 24"`) on EVERY icon button so icons never disappear!',
    '3. ZERO BLANK SCREEN / ZERO EMPTY BLACK FEED & FULL-BLEED VIEWPORT MATH: Use `html, body { margin: 0; padding: 0; width: 100%; height: 100%; min-height: 100dvh; overflow: hidden; background: <matching app surface color>; }` for fixed-nav shells (NO mismatched outer board or bottom white strip!). Every middle scrollable area or feed between top bar & bottom nav MUST have `flex: 1; min-height: 0; overflow-y: auto;` so it NEVER collapses to 0px height! ALWAYS show the default primary screen visible immediately in CSS (`[data-screen].active, [data-screen]:first-of-type { display: flex; }`) BEFORE JavaScript runs, so the screen is NEVER empty!',
    '4. PLAYABLE VIDEO & RICH MEDIA APPS (NO EMPTY BLACK VIDEO BOXES): Whenever building any video feed, reels, short-video, streaming, or discovery app, use real playable HTTPS video URLs from `Verified Video Search Results` AND live `await window.AICraft.search(topic)` (`{ videos, images, results }`). Always set `poster`, `playsinline`, `muted`, `loop`, interactive tap-to-play/pause + mute/unmute controls, swipe/snap scrolling (`scroll-snap-type: y mandatory`), real author overlays, working likes/comments/bookmarks in `window.AICraft.db`, and graceful `poster` + animated canvas/artwork fallback if any clip is still buffering — NEVER leave an empty black center!',
    '5. ANDROID + IOS + LAPTOP/PC + TV SAFE AREA: Center wide desktop/TV layouts cleanly inside a responsive container (`width: 100%; max-width: 1120px; margin: 0 auto;` for desktop/laptop/TV views, full width on mobile). Give bottom navigation bars `padding-bottom: max(14px, env(safe-area-inset-bottom))` and `html[data-platform="android"]` extra clearance so bottom labels never clip.',
    '6. CLEAN `<head>` METADATA (NO UNSOLICITED LOGO OR PWA TAGS): Only include `<meta name="theme-color" content="#HEX" />` matching the app surface. Only include `<meta name="aicraft-logo" ...>` or header logo artwork if the user explicitly requested a logo or attached a logo image, and only include `<meta name="aicraft-pwa" content="enabled" />` if the user explicitly asked for Add to Home Screen / PWA installability.',
    '7. REAL-TIME DATABASE PERSISTENCE (`window.AICraft.db`): Every stateful entity in your app MUST live inside `window.AICraft.db` (`list`, `insert`, `update`, `remove`). Inside `DOMContentLoaded`, check `const existing = await window.AICraft.db.list("table");` — when empty, call `await window.AICraft.db.insert("table", { ... })` with 4–6 rich domain-accurate starter records using real plain object literals so the Database inspector immediately captures real structured records, then render ALL UI dynamically from those stored rows and re-render cleanly after every insert/update/remove. Wire Supabase secrets automatically if configured via `window.AICraft.findSecret(...)`.',
    '8. WORKING DOMAIN FEATURES & REAL SEARCHED IMAGES: Use verified HTTPS image/video URLs returned by search results (with clean CSS gradient/initials fallbacks on `onerror`). Build genuine screen switching, live search (`window.AICraft.search` + live DB filtering), working create/edit/delete forms, validation feedback, toast confirmations, and instant state persistence.',
    '9. ERROR-FREE VANILLA JAVASCRIPT: Write clean vanilla JS inside `<script>...</script>`, wrap initialization cleanly in `DOMContentLoaded` + `try/catch`, null-check DOM lookups, escape dynamic text safely, bind event listeners cleanly (prefer delegation or direct binding after render), verify all braces/parentheses match cleanly, and ensure every clickable button works immediately on tap.',
    '10. FINAL ENGINEERING SELF-AUDIT BEFORE ENDING: Before outputting `<<<END_AICRAFT_APP_HTML>>>` or `<<<END_PATCH>>>`, verify that NO screen relies on hardcoded fake static cards, NO center viewport can collapse or stay blank/black, every `[[DB_SCHEMA: ...]]` table is actively read and written via `window.AICraft.db`, every form & button mutates real state, and zero unsolicited logos or PWA Home Screen tags were injected.',
    'PART 3 (Next Suggested Upgrades): Immediately AFTER <<<END_AICRAFT_APP_HTML>>> or <<<END_PATCH>>>, output:',
    '[[SUGGESTIONS]]',
    '<Short, specific, immediately tappable upgrade prompt 1>',
    '<Short, specific, immediately tappable upgrade prompt 2>',
    '<Short, specific, immediately tappable upgrade prompt 3>',
    '[[/SUGGESTIONS]]',
  ]
    .filter(Boolean)
    .join('\n');

  const designBlock = designBlueprint
    ? `\nBACKEND DESIGN ARCHITECT ENGINE SPECIFICATION (Follow this tailored UI/UX & visual system closely):\n${designBlueprint}`
    : '';

  if (initialRoute === 'build') {
    return [
      'You are AI Craft, a calm, methodical senior product engineer & full-stack app architect connected directly into a live full-screen Preview workspace.',
      `Real-time clock context: ${timeContext}.`,
      projectInfraContext,
      projectMemoryContext ? `\n${projectMemoryContext}` : '',
      designBlock,
      webSearchContext ? `\n${webSearchContext}` : '',
      previewSummary ? `\nLIVE PREVIEW ENVIRONMENT AWARENESS:\n${previewSummary}` : '',
      'CRITICAL OUTPUT CONTRACT — TWO STRICTLY SEPARATED PARTS:',
      buildRulesBlock,
      activeFlags.length > 0 ? `Enabled capabilities: ${activeFlags.join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    'You are AI Craft, a sharp, human-like AI partner AND Lovable-grade full-stack app builder connected to a live Preview workspace.',
    `Real-time clock context: ${timeContext}.`,
    projectInfraContext,
    projectMemoryContext ? `\n${projectMemoryContext}` : '',
    designBlock,
    webSearchContext ? `\n${webSearchContext}` : '',
    previewSummary ? `\nLIVE PREVIEW ENVIRONMENT AWARENESS:\n${previewSummary}` : '',
    'THINK FIRST LIKE A HUMAN BEFORE CHOOSING MODE:',
    'Examine the user message carefully and decide truthfully whether they want (A) a normal conversation/question answer OR (B) an app built/edited/monetized right now:',
    '(A) CHAT / NORMAL QUESTION: Any greeting, name, short remark, normal question, advice/monetization question ("how do I...", "what is...", "did you..."), feedback, or casual discussion — even when an app already exists in Preview.',
    `    -> Start on the VERY FIRST LINE with exactly \`[[INTENT:CHAT]]\` followed by a newline${shouldGenerateTitle ? ', then `[[TITLE: <Short 2-4 Word Title>]]` followed by a newline' : ''}, then reply naturally, warmly, and honestly like a human. Do NOT output HTML, code blocks, fake build plans, or claim you built/changed anything.`,
    '(B) BUILD / EDIT / MONETIZE APP: Only when the user asks you to build, create, modify, fix, restyle, add a feature, connect a secret/database, or implement monetization in their app.',
    '    -> Start on the VERY FIRST LINE with exactly `[[INTENT:BUILD]]` followed by a newline, then output TWO strictly separated parts:',
    buildRulesBlock,
    activeFlags.length > 0 ? `Enabled capabilities: ${activeFlags.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export { deriveServerSessionTitle, extractLogoDirectiveFromRaw };
