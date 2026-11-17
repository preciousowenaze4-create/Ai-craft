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
}> {
  const cleanQuery = query.trim().slice(0, 260);
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
      const res = await fetchWithTimeout(commonsUrl, 2600);
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

  const bingImgTask = (async () => {
    try {
      const bingUrl = `https://www.bing.com/images/async?q=${encodeURIComponent(
        cleanQuery
      )}&async=content&first=1&count=12`;
      const res = await fetchWithTimeout(bingUrl, 3200, 'text/html,application/xhtml+xml');
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
      const res = await fetchWithTimeout(ddgHtmlUrl, 2800, 'text/html,application/xhtml+xml');
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

  await Promise.allSettled([ddgTask, ddgHtmlTask, wikiTask, commonsTask, bingImgTask]);
  return {
    query: cleanQuery,
    results: results.slice(0, 8),
    images: images.slice(0, 8),
  };
}

export function formatWebSearchContext(searchData: {
  query: string;
  results: SearchResultItem[];
  images?: SearchImageItem[];
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

  if (sections.length === 0) return '';
  sections.push(
    'Use these verified real-world facts and real images naturally in your design and app data when relevant.'
  );
  return sections.join('\n\n');
}

export function shouldRunChatSearch(message: string, hasPreviousHtml = false): boolean {
  const clean = message.trim();
  if (clean.length < 4) return false;
  if (
    /^(hi|hello|hey|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|great|awesome|lol|haha|good morning|good afternoon|good evening|good night|bye)[!.\s]*$/i.test(
      clean
    )
  ) {
    return false;
  }
  if (
    hasPreviousHtml &&
    /\b(this app|the app|my app|this screen|the screen|the preview|you built|you made|you added|what does (it|this)|how does (it|this)|why is (it|this|there))\b/i.test(
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

export function classifyInitialRoute(
  message: string,
  previousHtml: string,
  attachmentName?: string | null,
  hasAttachmentData = false
): InitialRoute {
  const text = message.trim();
  if (!text) return 'chat';

  const isPoliteBuildCommand =
    /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:build|create|make|design|code|craft|develop|fix|change|edit|update|add|remove|cut|delete|replace|redesign|upgrade|do)\b/i.test(
      text
    );

  if (attachmentName || hasAttachmentData) {
    const asksPureQuestion =
      (/\?$/.test(text) ||
        /^(what|why|how|who|where|when|which|is|are|does|do|explain|tell me)\b/i.test(
          text
        )) &&
      !isPoliteBuildCommand &&
      !/\b(fix|change|edit|cut|remove|delete|build|make|create|update|add|keep|stay|replace|redesign|take out)\b/i.test(
        text
      );
    return asksPureQuestion ? 'auto' : 'build';
  }

  if (
    /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening|good night|thanks|thank you|ok|okay|cool|nice|great|awesome|how are you|who are you|what time|what day|what date)\b/i.test(
      text
    ) &&
    !/\b(build|create|make|app|website|web\s*app|change|fix|update|remove|add|cut)\b/i.test(
      text
    )
  ) {
    return 'chat';
  }

  if (
    /\b(tell me a joke|make me laugh|make sense|make sure|write a (poem|story|essay|email|song|letter)|what time|what day|what date|who are you|what model|how are you|explain\b|define\b|what is\b|what are\b|what does\b|why is\b|why are\b|why did\b|why does\b|how does\b|how do i\b|how did\b|how many\b)\b/i.test(
      text
    ) &&
    !isPoliteBuildCommand &&
    !/\b(do my app|build me|create me|make me)\b/i.test(text)
  ) {
    return 'chat';
  }

  if (/\?\s*$/.test(text) && !isPoliteBuildCommand) {
    return 'auto';
  }

  const hasExplicitAppArtifact =
    /\b(app|mobile\s*app|ios\s*app|android\s*app|website|web\s*app|webpage|landing\s*page|site|storefront|dashboard|ecommerce|e-commerce|online\s*store|store|shop|portfolio|calculator|tracker|clone|prototype|ui|ux|screen|html|preview|widget|interface|todo|to-do|game|player|quiz|planner|calendar|timer|clock|notes|chat\s*app|social|feed|blog|portal|tool|system|manager|finder|generator|converter|form|login|signup|tiktok|instagram|youtube|spotify|netflix|twitter|whatsapp|uber|airbnb|amazon)\b/i.test(
      text
    );

  const hasBuildVerb =
    /\b(build|create|make|design|develop|generate|craft|code|scaffold|implement|redesign|upgrade|convert|do|want|need|give)\b/i.test(
      text
    );

  if (hasExplicitAppArtifact && (hasBuildVerb || /\b(for me|like)\b/i.test(text))) {
    return 'build';
  }

  if (
    /^(?:please\s+)?(?:build|create|make|design|scaffold|craft)\s+(?:me\s+)?(?:an?|the|my)\s+/i.test(
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
    !/^(what|why|how|who|where|when|which|is|are|does|do|did|should|would|could)\b/i.test(
      text
    ) &&
    /\b(change|update|modify|edit|fix|add|remove|cut|delete|take\s*out|replace|make\s+it|switch|turn|redesign|upgrade|rebuild|restructure)\b/i.test(
      text
    )
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
): { markerIdx: number; htmlOffset: number } | null {
  const markerMatch = /<<<\s*AICRAFT_APP_HTML\s*>>>/i.exec(raw);
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
html, body { max-width: 100%; overflow-x: hidden; -webkit-tap-highlight-color: transparent; }
*, *::before, *::after { box-sizing: border-box; }
nav[class*="bottom"], .bottom-nav, footer.app-nav, #bottom-nav { padding-bottom: max(12px, env(safe-area-inset-bottom)); }
</style>`;
    out = /<\/head>/i.test(out)
      ? out.replace(/<\/head>/i, `${safetyStyle}\n</head>`)
      : `${safetyStyle}\n${out}`;

    const safetyScript = `<script data-aicraft-safety-js="1">
(function(){
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
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      patchBrokenImages();
      patchLucidePlaceholders();
    });
  } else {
    patchBrokenImages();
    patchLucidePlaceholders();
  }
  if (typeof MutationObserver !== 'undefined') {
    var obs = new MutationObserver(function() { patchBrokenImages(); });
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
  const idMatches = Array.from(
    previousHtml.matchAll(
      /<(header|nav|main|section|aside|footer|div|form)\b[^>]*\bid=["']([^"']{1,40})["'][^>]*>/gi
    )
  )
    .slice(0, 18)
    .map((m) => `<${m[1].toLowerCase()} id="${m[2]}">`);

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
    );
}

export function sanitizeBuildProse(text: string): string {
  return stripTagMarkers(text)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/```(?:html|htm|css|javascript|js|tsx|ts)?[\s\S]*/gi, '')
    .replace(/<<<\s*AICRAFT_APP_HTML\s*>>>[\s\S]*/gi, '')
    .replace(/<<<\s*END_AICRAFT_APP_HTML\s*>>>[\s\S]*/gi, '')
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
    '- BUILT-IN REAL-TIME DATABASE API: For every app with data persistence, persist records via `await window.AICraft.db.list("table")`, `await window.AICraft.db.insert("table", row)`, `await window.AICraft.db.update("table", id, patch)`, `await window.AICraft.db.remove("table", id)` (and subscribe to updates or re-render immediately on every mutation).',
    '- FULL STANDALONE PWA, CUSTOM BRAND LOGO & BROWSER ACCESS: Every app gets its own standalone hosted browser link (`/app/...`), its own Web App Manifest, its own scoped Service Worker, and its own generated Home Screen icons — it NEVER inherits AI Craft\'s logo! Inside generated apps, use `window.AICraft.pwa` and `window.AICraft.browser` plus standard Web APIs (`navigator.mediaDevices`, `localStorage`, Canvas, Audio, etc.).',
    '- LIVE SEARCH & MEDIA GENERATION IN APPS: Inside generated apps, you can call `await window.AICraft.search(query)` (live web & image results), `await window.AICraft.ask(prompt)`, `await window.AICraft.generateImage(prompt)`, or `await window.AICraft.generateMusic(prompt)`.',
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
  webSearchContext: string;
  previewSummary: string;
  mode: 'mobile' | 'web';
  activeFlags: string[];
}): string {
  const {
    mediaKind,
    requestedModel,
    requestedModelLabel,
    initialRoute,
    shouldGenerateTitle,
    timeContext,
    projectInfraContext,
    webSearchContext,
    previewSummary,
    mode,
    activeFlags,
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
      'You are AI Craft, a calm, helpful, real-time AI assistant with live browser search access.',
      `Real-time clock context: ${timeContext}.`,
      projectInfraContext,
      webSearchContext ? `\n${webSearchContext}` : '',
      previewSummary
        ? `\nContext about the user's current Preview app (for answering questions accurately without rebuilding):\n${previewSummary}`
        : '',
      titleRuleForChat,
      'Respond directly and conversationally in real time to the user message.',
      'The user is chatting or asking a question right now — reply naturally without rebuilding the app or outputting HTML code.',
      'NEVER claim you added or built features into Preview unless you actually built them.',
      'NEVER tell the user to copy and paste code.',
      'Keep formatting clean and readable.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const titleRuleForBuild = shouldGenerateTitle
    ? 'STEP 00 (Short Session Title): Output a single tag `[[TITLE: <Short 2-4 Word App Title>]]` at the very start summarizing the user goal concisely before your PLAN lines.'
    : '';

  const buildRulesBlock = [
    'CALM REPLIT-STYLE STEP-BY-STEP ENGINEERING DISCIPLINE — NEVER RUSH, NEVER STUB, NEVER LIE:',
    '- Slow down and think structurally like a senior Replit full-stack engineer before writing code. Build cleanly section by section so every route, button, form, database table, and screen works together.',
    '- SURGICAL EDIT & SCREENSHOT PRESERVATION RULE (CRITICAL WHEN EDITING AN EXISTING APP): When existing Preview HTML or an attached screenshot is provided, read the existing code/DOM carefully and ONLY remove, cut, restyle, or modify the exact element/screen the user pointed out! Keep all untouched screens, styling, working JavaScript handlers, and database data intact — NEVER wipe the existing app or replace it with a bare shell.',
    '- STRICT HONESTY & NO UNSOLICITED "OPEN" BUTTONS: NEVER claim in your explanation that you built a feature unless that exact screen, button, handler, and DOM content is genuinely implemented and working inside PART 2. Never add an "Open" banner or external "Open" launcher button inside the app unless the user explicitly asks for one.',
    '- REAL-WORLD GROUNDING (ZERO GENERIC PLACEHOLDERS): Use real verified facts, services, names, departments, and real HTTPS photos from `Live Browser & Web Search Results` when available (with clean `onerror` CSS gradient fallbacks). Never output dummy placeholders like "Item 1", "Feature A", or "Lorem ipsum".',
    titleRuleForBuild,
    'STEP 0 (Calm 5-Step Architecture & Database Plan): Output 5 short, crystal-clear planning lines using exact format `[[PLAN: <step>]]` tailored specifically to the user\'s app idea:',
    '  1) `[[PLAN: Researching domain data, brand palette & custom icon — ...]]`',
    '  2) `[[PLAN: Responsive multi-device shell (Android, iOS, Laptop & TV) — ...]]`',
    '  3) `[[PLAN: Real-time database schema (`window.AICraft.db`) — ...]]`',
    '  4) `[[PLAN: Interactive screens & real-time state flows — ...]]`',
    '  5) `[[PLAN: Built-in actions, search & monetization — ...]]`',
    'STEP 0B (Real-Time Database Schema Lines): Output one `[[DB_SCHEMA: table_name(col1:type, col2:type, ...)]]` line per table right after your PLAN lines (allowed column types: `text`, `number`, `boolean`, `timestamp`, `json`). Every interactive app must have real domain tables (e.g., clinic app -> `appointments`, `doctors`, `patients`, `services`; chat app -> `conversations`, `messages`, `contacts`; social feed -> `posts`, `comments`, `creator_profiles`).',
    'STEP 0C (Custom Brand Logo Tag): Output one `[[LOGO: bg=#HEX, accent=#HEX, theme=#HEX, motif=play|chat|bag|music|camera|heart|bolt|star|wallet|map|flame|spark|letter, letters=XX]]` tailored specifically to the user\'s app & colors. NEVER output AI Craft\'s logo.',
    'PART 1 (Honest Architectural Summary): Write 2–3 calm, clear plain-text sentences summarizing ONLY the exact screens, real-time `window.AICraft.db` tables, interactive controls, and real searched content you built below. PROHIBITED IN PART 1: raw HTML/CSS/JS, markdown code fences (```), backticks, or the words "PART 1"/"PART 2"/"PART 3".',
    'PART 2 (Complete Self-Contained Real-Time App): Immediately output <<<AICRAFT_APP_HTML>>> followed by a COMPLETE, self-contained, runnable <!DOCTYPE html> application ending with <<<END_AICRAFT_APP_HTML>>>.',
    'MANDATORY MULTI-SCREEN COMPLETENESS & ANTI-BLANK-SCREEN RULES FOR PART 2:',
    `1. TARGET EXPERIENCE: Design a complete, immediately populated ${targetLabel}. NEVER stop after building only one screen or a shallow skeleton! Build 4 to 6 distinct, fully populated interactive screens using semantic containers: \`<section data-screen="<id>" data-screen-title="<Screen Name>">...</section>\` (for example: messaging apps -> \`chats\` ("Chats"), \`conversation\` ("Conversation"), \`message-info\` ("Message info"), \`new-chat\` ("New Chat"), \`profile\` ("Profile"); social feeds -> \`feed\` ("Feed"), \`discover\` ("Discover"), \`create\` ("Create"), \`inbox\` ("Inbox"), \`profile\` ("Profile"); clinic/business -> \`home\` ("Home"), \`catalog\` ("Services"), \`booking\` ("Book"), \`detail\` ("Details"), \`account\` ("Account")). Populate EVERY screen with full realistic markup, starter records, and working tap navigation!`,
    '2. ZERO FRAGILE EXTERNAL CDNs FOR STYLING OR ICONS: Write ALL layout, spacing, typography, cards, feeds, modals, and animations cleanly inside `<style>...</style>`. DO NOT depend on `cdn.tailwindcss.com`, `unpkg.com/lucide`, React/Babel `<script type="text/babel">`, or icon font CDNs — use PURE INLINE `<svg>` paths (`width="20" height="20" viewBox="0 0 24 24"`) on EVERY icon button so icons never disappear!',
    '3. ANDROID + IOS + LAPTOP/PC + TV VIEWPORT & BOTTOM CLEARANCE MATH: Use `html, body { margin: 0; padding: 0; height: 100dvh; width: 100%; overflow: hidden; }` for app shells with sticky headers/bottom bars, and center app content cleanly inside a responsive container (`width: 100%; max-width: 1120px; margin: 0 auto;` for desktop/laptop/TV views, keeping full width on phones). On Android (`html[data-platform="android"]`) give bottom navigation bars `padding-bottom: max(18px, calc(env(safe-area-inset-bottom, 0px) + 10px))` so Android system nav buttons NEVER overlap or sink into the bottom nav labels, while keeping iOS (`env(safe-area-inset-bottom)`) crisp and natural.',
    '4. CUSTOM BRAND HEAD TAGS & INLINE ICON: Inside `<head>`, include `<meta name="theme-color" content="#HEX" />`, `<meta name="background-color" content="#HEX" />`, `<meta name="aicraft-logo" data-bg="#HEX" data-accent="#HEX" data-theme="#HEX" data-motif="..." data-letters="XX" />`, and render `<svg id="aicraft-app-icon" viewBox="0 0 128 128" ...>` inside the header.',
    '5. REAL-TIME STRUCTURED DATABASE (`window.AICraft.db`): Wire ALL core app data cleanly to `await window.AICraft.db.list(table)`, `insert(table, row)`, `update(table, id, patch)`, `remove(table, id)`. On startup inside `DOMContentLoaded`: seed 5–8 rich realistic starter items grounded in real-world details into `window.AICraft.db` ONLY if `list(table)` returns empty, render immediately to the DOM across every screen, and sync Supabase secrets if configured via `window.AICraft.findSecret(...)`.',
    '6. WORKING DOMAIN FEATURES & REAL SEARCHED IMAGES: Use verified HTTPS image URLs returned by search results (with clean CSS gradient/initials fallbacks on `onerror`) or inline SVG artwork. Build genuine interactive screen navigation, live search (`window.AICraft.search` + local filter), working create/send/booking forms, live replies, and real state updates.',
    '7. ERROR-FREE VANILLA JAVASCRIPT: Write clean vanilla JS inside `<script>...</script>`, wrap initialization cleanly in `DOMContentLoaded` + `try/catch`, null-check DOM lookups, escape dynamic text safely, verify all braces/parentheses match cleanly, and ensure every clickable button works immediately on tap.',
    '8. FINAL VISUAL & CODE SELF-AUDIT BEFORE ENDING: Before outputting `<<<END_AICRAFT_APP_HTML>>>`, check every `<section data-screen>` screen — make sure none are empty, all navigation & buttons work, real avatars/photos load cleanly, and the first screen opens directly onto rich production UI.',
    'PART 3 (Next Suggested Upgrades): Immediately AFTER <<<END_AICRAFT_APP_HTML>>>, output:',
    '[[SUGGESTIONS]]',
    '<Short, specific, immediately tappable upgrade prompt 1>',
    '<Short, specific, immediately tappable upgrade prompt 2>',
    '<Short, specific, immediately tappable upgrade prompt 3>',
    '[[/SUGGESTIONS]]',
  ]
    .filter(Boolean)
    .join('\n');

  if (initialRoute === 'build') {
    return [
      'You are AI Craft, a calm, methodical senior product engineer & full-stack app architect connected directly into a live full-screen Preview workspace.',
      `Real-time clock context: ${timeContext}.`,
      projectInfraContext,
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
    'You are AI Craft, a calm, intelligent real-time AI assistant AND methodical Replit-grade product builder connected to a live Preview workspace.',
    `Real-time clock context: ${timeContext}.`,
    projectInfraContext,
    webSearchContext ? `\n${webSearchContext}` : '',
    previewSummary ? `\nLIVE PREVIEW ENVIRONMENT AWARENESS:\n${previewSummary}` : '',
    'THINK FIRST BEFORE RESPONDING:',
    'First decide carefully whether the user message is:',
    '(A) CHAT / QUESTION: A question, greeting, explanation request, feedback discussion, or normal conversation (even if an app was already built in Preview).',
    `    -> Start your output on the VERY FIRST LINE with exactly \`[[INTENT:CHAT]]\` followed by a newline${shouldGenerateTitle ? ', then `[[TITLE: <Short 2-4 Word Title>]]` followed by a newline' : ''}, then write a natural, helpful conversational reply. Do NOT output HTML, code blocks, or rebuild the app.`,
    '(B) BUILD / EDIT APP: A request to create/build a new app or website, OR ANY request to change, style, restyle, cut, remove, fix, add features, update the Home Screen logo/icon/color, customize browser toolbar theme-color, or build monetization.',
    '    -> Start your output on the VERY FIRST LINE with exactly `[[INTENT:BUILD]]` followed by a newline, then output TWO strictly separated parts:',
    buildRulesBlock,
    activeFlags.length > 0 ? `Enabled capabilities: ${activeFlags.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export { deriveServerSessionTitle, extractLogoDirectiveFromRaw };
