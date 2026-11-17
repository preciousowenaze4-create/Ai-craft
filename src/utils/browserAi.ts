export interface BrowserVisualHints {
  dominantColor?: string;
  surfaceTheme?: 'dark' | 'light';
  width?: number;
  height?: number;
}

export interface ParsedClientDbTable {
  name: string;
  columns: Array<{
    name: string;
    type: 'text' | 'number' | 'boolean' | 'timestamp' | 'json';
    required?: boolean;
  }>;
}

export interface RealTimeBuildProgress {
  files: string[];
  activeAction: string;
  activeFile: string;
  bytesBuilt: number;
}

export interface StreamRealTimeBrowserAiParams {
  modelId: string;
  systemPrompt: string;
  historyMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  signal?: AbortSignal;
  onModelSelected?: (info: {
    modelId: string;
    modelName: string;
    provider: string;
  }) => void;
  onReasoning?: (delta: string) => void;
  onTitle?: (title: string) => void;
  onPlanSteps?: (steps: string[]) => void;
  onDbTables?: (tables: ParsedClientDbTable[]) => void;
  onPhaseChange?: (phase: 'understanding' | 'building', label: string) => void;
  onProseUpdate?: (proseText: string) => void;
  onBuildProgress?: (info: RealTimeBuildProgress) => void;
}

export interface StreamRealTimeBrowserAiResult {
  rawOutput: string;
  modelUsed: string;
  modelName: string;
  provider: string;
}

interface PuterWindowGlobal {
  puter?: {
    auth?: {
      isSignedIn?: () => boolean;
      signIn?: () => Promise<unknown>;
    };
    ai?: {
      chat?: (
        prompt: string | Array<Record<string, unknown>>,
        imageOrOptions?: string | Record<string, unknown>,
        options?: Record<string, unknown>
      ) => Promise<unknown>;
    };
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return (
    '#' +
    [clamp(r), clamp(g), clamp(b)]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')
  );
}

export async function analyzeAttachmentVisualHints(
  dataUrl?: string | null
): Promise<BrowserVisualHints | null> {
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    !dataUrl ||
    !dataUrl.startsWith('data:image/')
  ) {
    return null;
  }

  return new Promise((resolve) => {
    const img = new Image();
    const timer = window.setTimeout(() => resolve(null), 2200);

    img.onload = () => {
      window.clearTimeout(timer);
      try {
        const w = Math.max(1, img.naturalWidth || img.width || 1);
        const h = Math.max(1, img.naturalHeight || img.height || 1);
        const canvas = document.createElement('canvas');
        const sampleSize = 24;
        canvas.width = sampleSize;
        canvas.height = sampleSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve({ width: w, height: h });
          return;
        }
        ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
        const pixels = ctx.getImageData(0, 0, sampleSize, sampleSize).data;

        let lumSum = 0;
        let pixelCount = 0;
        let vividScoreBest = -1;
        let vividR = 124;
        let vividG = 58;
        let vividB = 237;
        let avgR = 0;
        let avgG = 0;
        let avgB = 0;

        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3];
          if (alpha < 40) continue;
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          avgR += r;
          avgG += g;
          avgB += b;
          pixelCount += 1;

          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          lumSum += lum;

          const maxC = Math.max(r, g, b);
          const minC = Math.min(r, g, b);
          const sat = maxC - minC;
          if (sat > 42 && lum > 25 && lum < 235 && sat > vividScoreBest) {
            vividScoreBest = sat;
            vividR = r;
            vividG = g;
            vividB = b;
          }
        }

        if (pixelCount === 0) {
          resolve({ width: w, height: h });
          return;
        }

        const meanLum = lumSum / pixelCount;
        const dominantColor =
          vividScoreBest > 42
            ? rgbToHex(vividR, vividG, vividB)
            : rgbToHex(avgR / pixelCount, avgG / pixelCount, avgB / pixelCount);

        resolve({
          dominantColor,
          surfaceTheme: meanLum < 118 ? 'dark' : 'light',
          width: w,
          height: h,
        });
      } catch {
        resolve(null);
      }
    };

    img.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };

    img.src = dataUrl;
  });
}

export function stripReasoningTagsClient(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thought>[\s\S]*$/gi, '')
    .trim();
}

export function findCodeStartIndex(raw: string): number {
  const patterns = [
    /<<<\s*AICRAFT_APP_HTML\s*>>>/i,
    /```\s*html/i,
    /<!doctype\s+html/i,
    /<html\b/i,
  ];
  let earliest = -1;
  for (const p of patterns) {
    const idx = raw.search(p);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx;
    }
  }
  return earliest;
}

function extractTitleDirectiveClient(raw: string): string | null {
  const match = /\[\[\s*TITLE\s*:\s*([^\]]+?)\s*\]\]/i.exec(raw);
  return match?.[1]?.trim() || null;
}

function extractPlanStepsClient(raw: string): string[] {
  const steps: string[] = [];
  const regex = /\[\[\s*PLAN\s*:\s*([^\]]+?)\s*\]\]/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const step = match[1]?.trim();
    if (step && !steps.includes(step)) {
      steps.push(step);
    }
  }
  return steps.slice(0, 8);
}

function extractDbSchemaClient(raw: string): ParsedClientDbTable[] {
  const tables: ParsedClientDbTable[] = [];
  const seen = new Set<string>();
  const regex = /\[\[\s*DB_SCHEMA\s*:\s*([^\]]+?)\s*\]\]/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const spec = match[1]?.trim();
    if (!spec) continue;
    const segments = spec.split(/;\s*/);
    for (const seg of segments) {
      const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(([^)]+)\))?$/.exec(seg.trim());
      if (!m) continue;
      const tableName = m[1].toLowerCase();
      if (seen.has(tableName)) continue;
      seen.add(tableName);
      const rawCols = (m[2] || 'id:text,created_at:timestamp')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const columns = rawCols.map((colStr) => {
        const [colNameRaw, colTypeRaw] = colStr.split(':').map((s) => s.trim());
        const normalizedType =
          colTypeRaw === 'number' ||
          colTypeRaw === 'boolean' ||
          colTypeRaw === 'timestamp' ||
          colTypeRaw === 'json'
            ? colTypeRaw
            : 'text';
        return {
          name: (colNameRaw || 'field').toLowerCase().replace(/[^a-z0-9_]/g, '_'),
          type: normalizedType as 'text' | 'number' | 'boolean' | 'timestamp' | 'json',
          required: colNameRaw === 'id',
        };
      });
      tables.push({ name: tableName, columns });
    }
  }
  return tables;
}

function sanitizeProseClient(raw: string): string {
  const cleaned = stripReasoningTagsClient(raw);
  const codeIdx = findCodeStartIndex(cleaned);
  const proseSection = codeIdx !== -1 ? cleaned.slice(0, codeIdx) : cleaned;
  return proseSection
    .replace(/\[\[\s*INTENT\s*:\s*(?:CHAT|BUILD)\s*\]\]\s*/gi, '')
    .replace(/\[\[\s*MODE\s*:\s*(?:CHAT|GENERATE)\s*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*MEDIA_PROMPT\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*TITLE\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*LOGO\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*PLAN\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*DB_SCHEMA\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*SUGGESTIONS\s*\]\][\s\S]*?(?:\[\[\s*\/\s*SUGGESTIONS\s*\]\]|$)/gi, '')
    .replace(/```[\s\S]*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractClientBuildArtifacts(
  htmlSoFar: string
): RealTimeBuildProgress {
  const files: string[] = [];
  const pushUnique = (path: string) => {
    if (!files.includes(path)) files.push(path);
  };

  if (/<html|<!doctype|<head|<body/i.test(htmlSoFar)) {
    pushUnique('index.html');
  }
  if (/<style\b/i.test(htmlSoFar)) {
    pushUnique('styles.css');
  }
  if (/AICraft\.db|supabase|localStorage/i.test(htmlSoFar)) {
    pushUnique('database/schema.js');
  }
  if (/paywall|upgrade|subscribe|checkout|wallet|billing/i.test(htmlSoFar)) {
    pushUnique('modules/monetization.js');
  }
  if (/<header\b/i.test(htmlSoFar)) {
    pushUnique('components/header.html');
  }
  if (/<nav\b|tab-bar|bottom-nav|sidebar/i.test(htmlSoFar)) {
    pushUnique('components/navigation.html');
  }

  const sectionMatches = htmlSoFar.matchAll(
    /<(?:section|main|div)[^>]+(?:id|data-screen|data-tab)=["']([a-zA-Z0-9_-]{2,32})["']/gi
  );
  for (const m of sectionMatches) {
    const slug = m[1]?.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (slug && !['app', 'root', 'main', 'container', 'wrapper'].includes(slug)) {
      pushUnique(`screens/${slug}.html`);
      if (files.length >= 10) break;
    }
  }

  if (/<script\b/i.test(htmlSoFar)) {
    pushUnique('app.js');
  }

  const activeFile = files[files.length - 1] || 'index.html';
  const activeAction = activeFile.endsWith('.js')
    ? 'Coding'
    : activeFile === 'styles.css'
      ? 'Styling'
      : 'Building';

  return {
    files,
    activeAction,
    activeFile,
    bytesBuilt: htmlSoFar.length,
  };
}

function getPuterGlobal(): PuterWindowGlobal['puter'] | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as PuterWindowGlobal).puter ?? null;
}

export function isPuterSignedInClient(): boolean {
  const puter = getPuterGlobal();
  if (!puter?.auth?.isSignedIn) return false;
  try {
    return Boolean(puter.auth.isSignedIn());
  } catch {
    return false;
  }
}

function extractChunkTextFromPuterPart(part: unknown): {
  content: string;
  reasoning: string;
} {
  if (typeof part === 'string') {
    return { content: part, reasoning: '' };
  }
  if (!part || typeof part !== 'object') {
    return { content: '', reasoning: '' };
  }
  const p = part as {
    text?: unknown;
    reasoning?: unknown;
    delta?: { content?: unknown; reasoning?: unknown };
    choices?: Array<{
      delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown };
    }>;
    message?: { content?: unknown };
  };
  const reasoning =
    (typeof p.reasoning === 'string' && p.reasoning) ||
    (typeof p.delta?.reasoning === 'string' && p.delta.reasoning) ||
    (typeof p.choices?.[0]?.delta?.reasoning === 'string' && p.choices[0].delta.reasoning) ||
    (typeof p.choices?.[0]?.delta?.reasoning_content === 'string' &&
      p.choices[0].delta.reasoning_content) ||
    '';

  let content = '';
  if (typeof p.text === 'string') content = p.text;
  else if (typeof p.delta?.content === 'string') content = p.delta.content;
  else if (typeof p.choices?.[0]?.delta?.content === 'string') {
    content = p.choices[0].delta.content;
  } else if (typeof p.message?.content === 'string') {
    content = p.message.content;
  }

  return { content, reasoning };
}

async function streamViaPuterClient(params: {
  upstreamModelId: string;
  modelName: string;
  systemPrompt: string;
  historyMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  signal?: AbortSignal;
  onChunk: (contentDelta: string, reasoningDelta: string) => void;
}): Promise<string> {
  const puter = getPuterGlobal();
  if (!puter?.ai?.chat) {
    throw new Error('Puter browser AI SDK is not loaded yet.');
  }

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: params.systemPrompt },
    ...params.historyMessages.map((m) => ({ role: m.role, content: m.content })),
  ];

  let streamOrResponse: unknown;
  if (params.attachmentDataUrl && params.attachmentDataUrl.startsWith('data:image/')) {
    const combinedPrompt = `${params.systemPrompt}\n\n${
      params.historyMessages.length > 0
        ? params.historyMessages
            .map((m) => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
            .join('\n\n') + '\n\n'
        : ''
    }${params.userPrompt}`;
    streamOrResponse = await puter.ai.chat(
      combinedPrompt,
      params.attachmentDataUrl,
      {
        model: params.upstreamModelId,
        stream: true,
      }
    );
  } else {
    messages.push({ role: 'user', content: params.userPrompt });
    streamOrResponse = await puter.ai.chat(messages, {
      model: params.upstreamModelId,
      stream: true,
    });
  }

  let accumulated = '';
  if (
    streamOrResponse &&
    typeof streamOrResponse === 'object' &&
    Symbol.asyncIterator in streamOrResponse
  ) {
    const iterable = streamOrResponse as AsyncIterable<unknown>;
    for await (const part of iterable) {
      if (params.signal?.aborted) {
        const abortErr = new Error('Aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const { content, reasoning } = extractChunkTextFromPuterPart(part);
      if (content || reasoning) {
        accumulated += content;
        params.onChunk(content, reasoning);
      }
    }
  } else {
    const { content, reasoning } = extractChunkTextFromPuterPart(streamOrResponse);
    if (content || reasoning) {
      accumulated += content;
      params.onChunk(content, reasoning);
    }
  }

  if (!accumulated.trim()) {
    throw new Error(`${params.modelName} returned an empty response.`);
  }
  return accumulated;
}

async function streamViaBrowserPollinations(params: {
  upstreamModelId: string;
  systemPrompt: string;
  historyMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  signal?: AbortSignal;
  onChunk: (contentDelta: string, reasoningDelta: string) => void;
}): Promise<string> {
  const controller = new AbortController();
  let timedOutReason = '';

  const forwardAbort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (params.signal) {
    if (params.signal.aborted) forwardAbort();
    else params.signal.addEventListener('abort', forwardAbort, { once: true });
  }

  let watchdog: number | null = null;
  const resetWatchdog = (ms: number, reason: string) => {
    if (watchdog !== null) window.clearTimeout(watchdog);
    watchdog = window.setTimeout(() => {
      timedOutReason = reason;
      if (!controller.signal.aborted) controller.abort();
    }, ms);
  };

  resetWatchdog(20_000, 'Free Browser AI timed out before responding.');

  const userContent: unknown =
    params.attachmentDataUrl && params.attachmentDataUrl.startsWith('data:image/')
      ? [
          { type: 'image_url', image_url: { url: params.attachmentDataUrl } },
          { type: 'text', text: params.userPrompt },
        ]
      : params.userPrompt;

  let fullContent = '';

  try {
    const response = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: params.upstreamModelId || 'openai-fast',
        stream: true,
        temperature: 0.45,
        messages: [
          { role: 'system', content: params.systemPrompt },
          ...params.historyMessages,
          { role: 'user', content: userContent },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      let errMsg = `Pollinations returned status ${response.status}`;
      try {
        const errJson = (await response.json()) as {
          error?: { message?: string } | string;
          message?: string;
        };
        if (typeof errJson?.error === 'object' && errJson.error?.message) {
          errMsg = errJson.error.message;
        } else if (typeof errJson?.error === 'string') {
          errMsg = errJson.error;
        } else if (errJson?.message) {
          errMsg = errJson.message;
        }
      } catch {
        // ignore parse error
      }
      const err = new Error(errMsg) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    resetWatchdog(25_000, 'Free Browser AI stream stalled mid-response.');

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      resetWatchdog(25_000, 'Free Browser AI stream stalled mid-response.');
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const trimmedLine = rawLine.trim();
        if (!trimmedLine || trimmedLine.startsWith(':')) continue;

        const subFrames = trimmedLine.includes('}data:')
          ? trimmedLine.split(/(?=data:\s*)/)
          : [trimmedLine];

        for (const frame of subFrames) {
          const line = frame.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data) as {
              error?: { message?: string };
              choices?: Array<{
                delta?: {
                  reasoning?: string;
                  reasoning_content?: string;
                  content?: string | Array<{ type?: string; text?: string }>;
                };
              }>;
            };
            if (parsed?.error?.message) {
              throw new Error(parsed.error.message);
            }
            const delta = parsed?.choices?.[0]?.delta;
            const reasoningPart = delta?.reasoning || delta?.reasoning_content || '';
            let contentPart = '';
            if (typeof delta?.content === 'string') {
              contentPart = delta.content;
            } else if (Array.isArray(delta?.content)) {
              for (const part of delta.content) {
                if (typeof part?.text === 'string') contentPart += part.text;
              }
            }
            if (contentPart || reasoningPart) {
              fullContent += contentPart;
              params.onChunk(contentPart, reasoningPart);
            }
          } catch (innerErr) {
            if (innerErr instanceof SyntaxError) continue;
            throw innerErr;
          }
        }
      }
    }

    if (buffer.trim().startsWith('data:')) {
      const tailFrames = buffer.trim().split(/(?=data:\s*)/);
      for (const frame of tailFrames) {
        const data = frame.trim().slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const contentPart = parsed?.choices?.[0]?.delta?.content || '';
          if (contentPart) {
            fullContent += contentPart;
            params.onChunk(contentPart, '');
          }
        } catch {
          // ignore incomplete tail
        }
      }
    }

    if (!fullContent.trim()) {
      throw new Error('Pollinations stream completed without generating output.');
    }

    return fullContent;
  } catch (err) {
    if (timedOutReason) {
      throw new Error(timedOutReason);
    }
    throw err;
  } finally {
    if (watchdog !== null) window.clearTimeout(watchdog);
    if (params.signal) {
      params.signal.removeEventListener('abort', forwardAbort);
    }
  }
}

export async function streamRealTimeBrowserAi(
  params: StreamRealTimeBrowserAiParams
): Promise<StreamRealTimeBrowserAiResult> {
  const requestedModel = (params.modelId || 'auto::free-browser').trim();
  const isExplicitPuter = requestedModel.startsWith('puter::');
  const isExplicitPollinations = requestedModel.startsWith('pollinations::');
  const puterReady = Boolean(getPuterGlobal()?.ai?.chat);
  const puterSignedIn = isPuterSignedInClient();

  let rawAccumulated = '';
  let lastTitle = '';
  let lastPlanCount = 0;
  let lastDbCount = 0;
  let enteredBuildPhase = false;
  let lastEmitAt = 0;
  let lastBytesEmitted = 0;

  const processLiveTokenUpdate = (force = false) => {
    const cleaned = stripReasoningTagsClient(rawAccumulated);
    if (!cleaned) return;

    const title = extractTitleDirectiveClient(cleaned);
    if (title && title !== lastTitle) {
      lastTitle = title;
      params.onTitle?.(title);
    }

    const planSteps = extractPlanStepsClient(cleaned);
    if (planSteps.length > lastPlanCount) {
      lastPlanCount = planSteps.length;
      params.onPlanSteps?.(planSteps);
    }

    const dbTables = extractDbSchemaClient(cleaned);
    if (dbTables.length > lastDbCount) {
      lastDbCount = dbTables.length;
      params.onDbTables?.(dbTables);
    }

    const codeIdx = findCodeStartIndex(cleaned);
    const now = Date.now();

    if (codeIdx === -1) {
      if (force || now - lastEmitAt >= 90) {
        lastEmitAt = now;
        const prose = sanitizeProseClient(cleaned);
        if (prose) {
          params.onProseUpdate?.(prose);
        }
      }
      return;
    }

    if (!enteredBuildPhase) {
      enteredBuildPhase = true;
      params.onPhaseChange?.('building', 'Writing real-time application code...');
      const proseBeforeCode = sanitizeProseClient(cleaned);
      if (proseBeforeCode) {
        params.onProseUpdate?.(proseBeforeCode);
      }
    }

    const htmlSlice = cleaned.slice(codeIdx);
    if (force || now - lastEmitAt >= 150 || htmlSlice.length - lastBytesEmitted >= 280) {
      lastEmitAt = now;
      lastBytesEmitted = htmlSlice.length;
      const progress = extractClientBuildArtifacts(htmlSlice);
      params.onBuildProgress?.(progress);
    }
  };

  const resetProgress = () => {
    rawAccumulated = '';
    lastTitle = '';
    lastPlanCount = 0;
    lastDbCount = 0;
    enteredBuildPhase = false;
    lastEmitAt = 0;
    lastBytesEmitted = 0;
  };

  const handleChunk = (contentDelta: string, reasoningDelta: string) => {
    if (reasoningDelta) {
      params.onReasoning?.(reasoningDelta);
    }
    if (contentDelta) {
      rawAccumulated += contentDelta;
      processLiveTokenUpdate(false);
    }
  };

  // Build ordered real-time browser provider attempts (zero hardcoded templates)
  type Attempt =
    | {
        kind: 'puter';
        upstreamModelId: string;
        publicModelId: string;
        modelName: string;
        provider: string;
      }
    | {
        kind: 'pollinations';
        upstreamModelId: string;
        publicModelId: string;
        modelName: string;
        provider: string;
      };

  const attempts: Attempt[] = [];
  if (isExplicitPuter) {
    const upstreamId = requestedModel.slice('puter::'.length) || 'claude-sonnet-4';
    const puterProvider = upstreamId.includes('claude')
      ? 'anthropic'
      : upstreamId.includes('gpt')
        ? 'openai'
        : upstreamId.includes('gemini')
          ? 'google'
          : upstreamId.includes('deepseek')
            ? 'deepseek'
            : 'puter';
    attempts.push({
      kind: 'puter',
      upstreamModelId: upstreamId,
      publicModelId: requestedModel,
      modelName: `${upstreamId} (Browser Free)`,
      provider: puterProvider,
    });
    attempts.push({
      kind: 'pollinations',
      upstreamModelId: 'openai-fast',
      publicModelId: 'pollinations::openai-fast',
      modelName: 'GPT-OSS 20B Reasoning (No Login)',
      provider: 'pollinations',
    });
  } else if (isExplicitPollinations) {
    const upstreamId = requestedModel.slice('pollinations::'.length) || 'openai-fast';
    attempts.push({
      kind: 'pollinations',
      upstreamModelId: upstreamId,
      publicModelId: requestedModel,
      modelName:
        upstreamId === 'openai-fast'
          ? 'GPT-OSS 20B Reasoning (No Login)'
          : `${upstreamId} (Free · No Login)`,
      provider: 'pollinations',
    });
    if (puterReady && puterSignedIn) {
      attempts.push({
        kind: 'puter',
        upstreamModelId: 'claude-sonnet-4',
        publicModelId: 'puter::claude-sonnet-4',
        modelName: 'Claude Sonnet 4 (Browser Free)',
        provider: 'anthropic',
      });
    }
  } else {
    // Auto Free Browser mode:
    // Prefer signed-in Puter frontier models when authenticated (especially for screenshot vision),
    // otherwise start with zero-login browser-direct Pollinations SSE, with Puter failover if signed in.
    if (puterReady && puterSignedIn) {
      const autoPuterModel = params.attachmentDataUrl ? 'gpt-4o' : 'claude-sonnet-4';
      attempts.push({
        kind: 'puter',
        upstreamModelId: autoPuterModel,
        publicModelId: `puter::${autoPuterModel}`,
        modelName:
          autoPuterModel === 'gpt-4o'
            ? 'GPT-4o (Browser Vision · Free)'
            : 'Claude Sonnet 4 (Browser Free)',
        provider: autoPuterModel === 'gpt-4o' ? 'openai' : 'anthropic',
      });
    }
    attempts.push({
      kind: 'pollinations',
      upstreamModelId: 'openai-fast',
      publicModelId: 'pollinations::openai-fast',
      modelName: 'GPT-OSS 20B Reasoning (No Login)',
      provider: 'pollinations',
    });
  }

  let lastError: unknown = null;

  for (const attempt of attempts) {
    if (params.signal?.aborted) {
      const abortErr = new Error('Aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    resetProgress();
    params.onModelSelected?.({
      modelId: attempt.publicModelId,
      modelName: attempt.modelName,
      provider: attempt.provider,
    });

    try {
      const rawOutput =
        attempt.kind === 'puter'
          ? await streamViaPuterClient({
              upstreamModelId: attempt.upstreamModelId,
              modelName: attempt.modelName,
              systemPrompt: params.systemPrompt,
              historyMessages: params.historyMessages,
              userPrompt: params.userPrompt,
              attachmentDataUrl: params.attachmentDataUrl,
              signal: params.signal,
              onChunk: handleChunk,
            })
          : await streamViaBrowserPollinations({
              upstreamModelId: attempt.upstreamModelId,
              systemPrompt: params.systemPrompt,
              historyMessages: params.historyMessages,
              userPrompt: params.userPrompt,
              attachmentDataUrl: params.attachmentDataUrl,
              signal: params.signal,
              onChunk: handleChunk,
            });

      rawAccumulated = rawOutput;
      processLiveTokenUpdate(true);

      return {
        rawOutput,
        modelUsed: attempt.publicModelId,
        modelName: attempt.modelName,
        provider: attempt.provider,
      };
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to reach free browser AI right now.');
}
