import {
  applySurgicalPatchesToHtmlClient,
  closePartialHtmlForLivePreview,
} from './screenExtractor';

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
  partialHtml?: string;
}

export interface StreamRealTimeBrowserAiParams {
  modelId: string;
  systemPrompt: string;
  historyMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  previousHtml?: string;
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
    /<<<\s*AICRAFT_PATCH\s*>>>/i,
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

export async function signInPuterClient(): Promise<boolean> {
  const puter = getPuterGlobal();
  if (!puter?.auth?.signIn) return false;
  try {
    await puter.auth.signIn();
    return isPuterSignedInClient();
  } catch {
    return isPuterSignedInClient();
  }
}

function formatBrowserAiError(
  err: unknown,
  fallback = 'Unable to reach free browser AI right now.'
): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  if (typeof err === 'string' && err.trim()) {
    return err.trim();
  }
  if (err && typeof err === 'object') {
    const obj = err as {
      message?: unknown;
      msg?: unknown;
      error?: unknown;
      code?: unknown;
    };
    if (typeof obj.message === 'string' && obj.message.trim()) {
      return obj.message.trim();
    }
    if (typeof obj.msg === 'string' && obj.msg.trim()) {
      return obj.msg.trim();
    }
    if (typeof obj.error === 'string' && obj.error.trim()) {
      return obj.error.trim();
    }
    if (obj.error && typeof obj.error === 'object') {
      const inner = obj.error as { message?: unknown; msg?: unknown; code?: unknown };
      if (typeof inner.message === 'string' && inner.message.trim()) {
        return inner.message.trim();
      }
      if (typeof inner.msg === 'string' && inner.msg.trim()) {
        return inner.msg.trim();
      }
      if (typeof inner.code === 'string' && inner.code.trim()) {
        return `AI provider error (${inner.code.trim()})`;
      }
    }
    if (typeof obj.code === 'string' && obj.code.trim()) {
      return `AI provider error (${obj.code.trim()})`;
    }
  }
  return fallback;
}

export function normalizeBuilderModelId(rawId?: string | null): string {
  const trimmed = (rawId || '').trim();
  if (trimmed === 'gemini::gemini-4-hydrogen' || trimmed === 'gemini-4-hydrogen') {
    return 'gemini::gemini-4-hydrogen';
  }
  if (trimmed.startsWith('groq::')) {
    return trimmed;
  }
  if (trimmed.startsWith('openrouter::')) {
    return trimmed;
  }
  if (trimmed === 'puter::claude-sonnet-4-6' || trimmed === 'claude-sonnet-4-6') {
    return 'puter::claude-sonnet-4-6';
  }
  return 'puter::gemini-2.5-flash';
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
  upstreamModelId: 'claude-sonnet-4-6' | 'gemini-2.5-flash';
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
    throw new Error('Free Puter AI SDK is loading — please try again in a moment.');
  }

  if (!isPuterSignedInClient()) {
    const signedIn = await signInPuterClient();
    if (!signedIn) {
      throw new Error(
        'Please complete the 1-tap free Puter sign-in to unlock real screenshot vision & uninterrupted building.'
      );
    }
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
        max_tokens: 16384,
      }
    );
  } else {
    messages.push({ role: 'user', content: params.userPrompt });
    streamOrResponse = await puter.ai.chat(messages, {
      model: params.upstreamModelId,
      stream: true,
      max_tokens: 16384,
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

export async function streamRealTimeBrowserAi(
  params: StreamRealTimeBrowserAiParams
): Promise<StreamRealTimeBrowserAiResult> {
  const normalizedSelected = normalizeBuilderModelId(params.modelId);
  const previousHtml = typeof params.previousHtml === 'string' ? params.previousHtml : '';

  let rawAccumulated = '';
  let lastTitle = '';
  let lastPlanCount = 0;
  let lastDbCount = 0;
  let enteredBuildPhase = false;
  let lastEmitAt = 0;
  let lastBytesEmitted = 0;
  let lastHtmlEmitAt = 0;
  let lastScreenCloseCount = 0;

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

    const isPatchMode = /<<<\s*AICRAFT_PATCH\s*>>>/i.test(cleaned) && Boolean(previousHtml.trim());

    if (!enteredBuildPhase) {
      enteredBuildPhase = true;
      params.onPhaseChange?.(
        'building',
        isPatchMode
          ? 'Applying surgical edits cleanly to existing layers...'
          : 'Drawing live screens & wiring real-time database...'
      );
      const proseBeforeCode = sanitizeProseClient(cleaned);
      if (proseBeforeCode) {
        params.onProseUpdate?.(proseBeforeCode);
      }
    }

    const htmlSlice = cleaned.slice(codeIdx);
    const screenCloseCount = (htmlSlice.match(/<\/section>/gi) || []).length;
    const shouldUpdatePreview =
      force ||
      isPatchMode ||
      screenCloseCount > lastScreenCloseCount ||
      (now - lastHtmlEmitAt >= 900 && htmlSlice.length > 900);

    if (force || now - lastEmitAt >= 180 || htmlSlice.length - lastBytesEmitted >= 280) {
      lastEmitAt = now;
      lastBytesEmitted = htmlSlice.length;

      let effectiveHtml = htmlSlice;
      if (isPatchMode) {
        const patched = applySurgicalPatchesToHtmlClient(previousHtml, cleaned);
        if (patched) effectiveHtml = patched;
      }

      const progress = extractClientBuildArtifacts(effectiveHtml);
      if (shouldUpdatePreview) {
        lastHtmlEmitAt = now;
        lastScreenCloseCount = screenCloseCount;
        const partial = isPatchMode
          ? effectiveHtml !== htmlSlice
            ? effectiveHtml
            : undefined
          : closePartialHtmlForLivePreview(htmlSlice);
        if (partial && partial.length > 260) {
          progress.partialHtml = partial;
        }
      }
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
    lastHtmlEmitAt = 0;
    lastScreenCloseCount = 0;
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

  const TWO_REAL_BUILDERS: Array<{
    upstreamModelId: 'gemini-2.5-flash' | 'claude-sonnet-4-6';
    publicModelId: string;
    modelName: string;
    provider: string;
  }> = [
    {
      upstreamModelId: 'gemini-2.5-flash',
      publicModelId: 'puter::gemini-2.5-flash',
      modelName: 'Gemini 2.5 Flash (Vision · Fast)',
      provider: 'google',
    },
    {
      upstreamModelId: 'claude-sonnet-4-6',
      publicModelId: 'puter::claude-sonnet-4-6',
      modelName: 'Claude Sonnet 4.6 (Vision · Builder)',
      provider: 'anthropic',
    },
  ];

  // Put user's chosen builder first (lightweight Gemini 2.5 Flash default, Claude Sonnet 4.6 when selected)
  const attempts =
    normalizedSelected === 'puter::claude-sonnet-4-6'
      ? [TWO_REAL_BUILDERS[1], TWO_REAL_BUILDERS[0]]
      : [TWO_REAL_BUILDERS[0], TWO_REAL_BUILDERS[1]];

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
      const rawOutput = await streamViaPuterClient({
        upstreamModelId: attempt.upstreamModelId,
        modelName: attempt.modelName,
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
      const errMsg = formatBrowserAiError(err);
      if (/insufficient|funding|balance|credit|subscribe|payment|402|quota/i.test(errMsg)) {
        throw new Error(
          'Your Puter browser trial allowance has finished for this Puter account. Switch to a free server-backed builder or try another account.'
        );
      }
      if (/1-tap free puter sign-in|auth|sign|cancel|closed/i.test(errMsg)) {
        throw new Error(errMsg);
      }
      lastError = new Error(errMsg);
    }
  }

  throw new Error(
    formatBrowserAiError(lastError, 'Unable to reach free Vision & Code AI right now.')
  );
}
