import {
  buildCraftSystemPrompt,
  buildFocusedSearchQuery,
  buildProjectInfraContext,
  buildSmartFollowUpSuggestions,
  classifyInitialRoute,
  deriveServerSessionTitle,
  extractDbSchemaFromHtml,
  extractDbSchemaFromRaw,
  extractLiveBuildArtifacts,
  extractLogoDirectiveFromRaw,
  extractPlanStepsFromRaw,
  extractPreviewHtmlFromRaw,
  extractPreviewStructureSummary,
  extractSuggestionsFromRaw,
  finalizePartialPreviewHtml,
  formatWebSearchContext,
  mergeParsedDbTables,
  runLiveBrowserSearch,
  sanitizeAndHardenPreviewHtml,
  sanitizeBuildProse,
  shouldRunChatSearch,
  stripReasoningTags,
  validateBuiltAppHtml,
  type ParsedDbTable,
  type SearchImageItem,
  type SearchResultItem,
} from './_builderCore.js';
import {
  DEFAULT_POLLINATIONS_TEXT_URL,
  buildGatewayExecutionPlan,
} from './_aiGateways.js';

export interface VisualHintsSpec {
  dominantColor?: string;
  surfaceTheme?: 'dark' | 'light';
  width?: number;
  height?: number;
}

export interface PrepareRealtimeInput {
  message: string;
  mode: 'mobile' | 'web';
  requestedModel?: string;
  requestedGateway?: string;
  history?: Array<{ role: string; text: string }>;
  previousHtml?: string;
  webSearchEnabled?: boolean;
  forceChat?: boolean;
  needsTitle?: boolean;
  attachmentName?: string | null;
  attachmentDataUrl?: string | null;
  attachmentText?: string | null;
  secretKeys?: string[];
  secretHints?: Array<{ key?: string; hint?: string }>;
  databaseTables?: string[];
  clientTime?: string;
  clientTimeZone?: string;
  visualHints?: VisualHintsSpec | null;
  reactEnabled?: boolean;
  backendEnabled?: boolean;
}

export interface PreparedRealtimePrompt {
  initialRoute: 'chat' | 'build' | 'auto';
  mediaKind: 'image' | 'music' | 'video' | null;
  naturalMediaIntent: 'image' | 'music' | 'video' | null;
  requestedModelLabel: string;
  shouldGenerateTitle: boolean;
  systemPrompt: string;
  userPrompt: string;
  historyMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  searchData: {
    query: string;
    results: SearchResultItem[];
    images: SearchImageItem[];
  };
  timeContext: string;
}

export function detectNaturalMediaRequest(
  message: string,
  hasPreviousHtml: boolean
): 'image' | 'music' | 'video' | null {
  const lower = message.trim().toLowerCase();
  if (!lower) return null;

  const buildsSoftware =
    /\b(app|website|site|platform|dashboard|store|shop|portal|clone|feed|clinic|booking|tracker|crm|chat\s*app|system)\b/i.test(
      lower
    );

  if (
    /\b(generate|create|make|compose|produce|write)\b.*\b(song|music|beat|track|melody|soundtrack|instrumental|audio|tune)\b/i.test(
      lower
    ) &&
    !buildsSoftware
  ) {
    return 'music';
  }
  if (
    /\b(generate|create|make|draw|paint|render|design)\b.*\b(image|picture|photo|artwork|wallpaper|portrait|logo|illustration)\b/i.test(
      lower
    ) &&
    !buildsSoftware &&
    !hasPreviousHtml
  ) {
    return 'image';
  }
  if (
    /\b(generate|create|make|render)\b.*\b(video|clip|animation|movie)\b/i.test(
      lower
    ) &&
    !buildsSoftware &&
    !hasPreviousHtml
  ) {
    return 'video';
  }
  return null;
}

export async function prepareRealtimePrompt(
  input: PrepareRealtimeInput
): Promise<PreparedRealtimePrompt> {
  const message = input.message.trim();
  const previousHtml = typeof input.previousHtml === 'string' ? input.previousHtml : '';
  const hasPreviousHtml = previousHtml.trim().length > 150;
  const history = Array.isArray(input.history) ? input.history : [];
  const shouldGenerateTitle = history.length === 0 || Boolean(input.needsTitle);

  const executionPlan = buildGatewayExecutionPlan({
    requestedModel: input.requestedModel,
    requestedGateway: input.requestedGateway,
  });

  const mediaKind = executionPlan.requestedMediaKind;
  const naturalMediaIntent =
    mediaKind ?? (input.forceChat ? null : detectNaturalMediaRequest(message, hasPreviousHtml));

  const initialRoute = input.forceChat
    ? 'chat'
    : classifyInitialRoute(
        message,
        previousHtml,
        input.attachmentName,
        Boolean(input.attachmentDataUrl)
      );

  const wantsSearch =
    input.webSearchEnabled !== false &&
    (initialRoute !== 'chat' || shouldRunChatSearch(message, hasPreviousHtml));

  const searchData = wantsSearch
    ? await runLiveBrowserSearch(buildFocusedSearchQuery(message))
    : { query: '', results: [], images: [] };

  const webSearchContext = formatWebSearchContext(searchData);

  const timeContext = [
    input.clientTime ? `User local date/time: ${input.clientTime}` : '',
    input.clientTimeZone ? `User timezone: ${input.clientTimeZone}` : '',
    `Server UTC date/time: ${new Date().toUTCString()}`,
  ]
    .filter(Boolean)
    .join(' | ');

  const secretKeys = Array.isArray(input.secretKeys)
    ? input.secretKeys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
    : [];
  const secretHints = Array.isArray(input.secretHints)
    ? input.secretHints
        .filter(
          (item): item is { key: string; hint: string } =>
            Boolean(item && typeof item.key === 'string' && item.key.trim().length > 0)
        )
        .map((item) => ({
          key: item.key.trim(),
          hint: typeof item.hint === 'string' && item.hint.trim() ? item.hint.trim() : 'configured-secret',
        }))
    : secretKeys.map((key) => ({ key, hint: 'configured-secret' }));

  const databaseTables = Array.isArray(input.databaseTables)
    ? input.databaseTables.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];

  const projectInfraContext = buildProjectInfraContext({
    secretHints,
    secretKeys,
    databaseTables,
  });

  const previewSummary = extractPreviewStructureSummary(previousHtml);

  const activeFlags: string[] = [];
  if (input.reactEnabled) activeFlags.push('Rich interactive SPA views');
  if (input.backendEnabled) activeFlags.push('Persistent real-time database (`window.AICraft.db`)');
  if (input.webSearchEnabled !== false) activeFlags.push('Live browser search & real photography');

  const systemPrompt = buildCraftSystemPrompt({
    mediaKind,
    requestedModel: input.requestedModel || 'auto::free-browser',
    requestedModelLabel: executionPlan.requestedModelLabel,
    initialRoute,
    shouldGenerateTitle,
    timeContext,
    projectInfraContext,
    webSearchContext,
    previewSummary,
    mode: input.mode,
    activeFlags,
  });

  const historyMessages: Array<{ role: 'user' | 'assistant'; content: string }> = history
    .slice(-8)
    .filter((h) => typeof h?.text === 'string' && h.text.trim().length > 0)
    .map((h) => ({
      role: h.role === 'assistant' || h.role === 'model' ? 'assistant' : 'user',
      content: h.text.trim().slice(0, 2200),
    }));

  const userBlocks: string[] = [];

  if (hasPreviousHtml && initialRoute !== 'chat') {
    const trimmedExisting =
      previousHtml.length > 14000
        ? `${previousHtml.slice(0, 7500)}\n<!-- ... middle preserved ... -->\n${previousHtml.slice(-6000)}`
        : previousHtml;
    userBlocks.push(
      `EXISTING PREVIEW HTML (Perform SURGICAL edits only — keep all untouched screens, navigation, database tables, and styles working; do NOT wipe out the existing app unless asked to rebuild from scratch):\n\`\`\`html\n${trimmedExisting}\n\`\`\``
    );
  }

  if (input.attachmentText) {
    userBlocks.push(
      `ATTACHED FILE (${input.attachmentName || 'reference.txt'}):\n${input.attachmentText.slice(0, 6000)}`
    );
  } else if (input.attachmentDataUrl || input.attachmentName) {
    const hintsLine =
      input.visualHints?.dominantColor || input.visualHints?.surfaceTheme
        ? ` Visual palette detected from screenshot: dominant=${input.visualHints.dominantColor || 'neutral'}, surface=${input.visualHints.surfaceTheme || 'light'}, size=${input.visualHints.width || '?'}x${input.visualHints.height || '?'}.`
        : '';
    userBlocks.push(
      `ATTACHED SCREENSHOT (${input.attachmentName || 'screenshot.png'}).${hintsLine} Follow the user's instructions regarding what to remove, add, keep, or fix cleanly.`
    );
  }

  userBlocks.push(`USER REQUEST:\n${message}`);

  return {
    initialRoute,
    mediaKind,
    naturalMediaIntent,
    requestedModelLabel: executionPlan.requestedModelLabel,
    shouldGenerateTitle,
    systemPrompt,
    userPrompt: userBlocks.join('\n\n'),
    historyMessages,
    searchData,
    timeContext,
  };
}

export interface FinalizeRealtimeInput {
  rawOutput: string;
  message: string;
  mode: 'mobile' | 'web';
  previousHtml?: string;
  modelUsed?: string;
  modelName?: string;
  provider?: string;
  startedAt?: number;
}

export interface FinalizedRealtimeResult {
  ok: boolean;
  kind: 'chat' | 'build' | 'media';
  title: string;
  aiText: string;
  previewHtml: string;
  valid: boolean;
  validationReason?: string;
  files: string[];
  planSteps: string[];
  dbTables: ParsedDbTable[];
  suggestions: string[];
  logo?: Record<string, string> | null;
  mediaPrompt?: string;
  thoughtSeconds: number;
  bytesBuilt: number;
  modelUsed: string;
  modelName: string;
  provider: string;
}

export function finalizeRealtimeOutput(
  input: FinalizeRealtimeInput
): FinalizedRealtimeResult {
  const cleanedRaw = stripReasoningTags(input.rawOutput || '');
  const startedAt = typeof input.startedAt === 'number' ? input.startedAt : Date.now();
  const thoughtSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const modelUsed = input.modelUsed || 'auto::free-browser';
  const modelName = input.modelName || 'Free Browser AI';
  const provider = input.provider || 'browser';

  const explicitTitleMatch = /\[\[\s*TITLE\s*:\s*([^\]]+?)\s*\]\]/i.exec(cleanedRaw);
  const title = explicitTitleMatch?.[1]?.trim()
    ? explicitTitleMatch[1].trim().slice(0, 60)
    : deriveServerSessionTitle(input.message, input.mode);

  const planSteps = extractPlanStepsFromRaw(cleanedRaw);
  const logo = extractLogoDirectiveFromRaw(cleanedRaw);

  if (/\[\[\s*MODE\s*:\s*GENERATE\s*\]\]/i.test(cleanedRaw)) {
    const mediaPromptMatch = /\[\[\s*MEDIA_PROMPT\s*:\s*([^\]]+?)\s*\]\]/i.exec(cleanedRaw);
    const aiText = sanitizeBuildProse(cleanedRaw) || `Creating ${input.message}...`;
    return {
      ok: true,
      kind: 'media',
      title,
      aiText,
      previewHtml: '',
      valid: true,
      files: [],
      planSteps,
      dbTables: [],
      suggestions: [],
      logo,
      mediaPrompt: mediaPromptMatch?.[1]?.trim() || input.message,
      thoughtSeconds,
      bytesBuilt: 0,
      modelUsed,
      modelName,
      provider,
    };
  }

  let extractedHtml = extractPreviewHtmlFromRaw(cleanedRaw);
  if (!extractedHtml && /<!doctype|<html|<body|<section|<main/i.test(cleanedRaw)) {
    extractedHtml = finalizePartialPreviewHtml(cleanedRaw);
  }

  const explicitlyChat = /\[\[\s*INTENT\s*:\s*CHAT\s*\]\]/i.test(cleanedRaw);
  if (explicitlyChat || !extractedHtml) {
    const prose = sanitizeBuildProse(cleanedRaw) || cleanedRaw.trim();
    return {
      ok: true,
      kind: 'chat',
      title,
      aiText: prose,
      previewHtml: '',
      valid: true,
      files: [],
      planSteps: [],
      dbTables: [],
      suggestions: [],
      logo: null,
      thoughtSeconds,
      bytesBuilt: 0,
      modelUsed,
      modelName,
      provider,
    };
  }

  const hardenedHtml = sanitizeAndHardenPreviewHtml(extractedHtml);
  const validation = validateBuiltAppHtml(hardenedHtml);
  const files = extractLiveBuildArtifacts(hardenedHtml).map((a) => a.path);
  const dbTables = mergeParsedDbTables(
    extractDbSchemaFromRaw(cleanedRaw),
    extractDbSchemaFromHtml(hardenedHtml)
  );
  const rawSuggestions = extractSuggestionsFromRaw(cleanedRaw);
  const suggestions =
    rawSuggestions.length > 0
      ? rawSuggestions
      : buildSmartFollowUpSuggestions(input.message, hardenedHtml, input.mode);

  let aiText = sanitizeBuildProse(cleanedRaw);
  if (!aiText) {
    aiText = `Built ${title} in real time with ${files.length} files${
      dbTables.length > 0 ? ` and ${dbTables.length} database tables` : ''
    }.`;
  }

  return {
    ok: true,
    kind: 'build',
    title,
    aiText,
    previewHtml: hardenedHtml,
    valid: validation.valid,
    validationReason: validation.reason,
    files,
    planSteps,
    dbTables,
    suggestions,
    logo,
    thoughtSeconds,
    bytesBuilt: hardenedHtml.length,
    modelUsed,
    modelName,
    provider,
  };
}

export async function streamPollinationsRealTime(params: {
  systemPrompt: string;
  historyMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  signal?: AbortSignal;
  onReasoningChunk?: (reasoningText: string) => void;
  onContentChunk: (chunkText: string) => void;
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

  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const resetWatchdog = (ms: number, reason: string) => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      timedOutReason = reason;
      if (!controller.signal.aborted) controller.abort();
    }, ms);
  };

  resetWatchdog(22_000, 'Free Browser AI timed out before responding.');

  let fullContent = '';

  try {
    const response = await fetch(`${DEFAULT_POLLINATIONS_TEXT_URL}/openai`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai-fast',
        stream: true,
        temperature: 0.45,
        messages: [
          { role: 'system', content: params.systemPrompt },
          ...params.historyMessages,
          { role: 'user', content: params.userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      let errMsg = `Free AI gateway returned status ${response.status}`;
      try {
        const errJson = (await response.json()) as {
          error?: { message?: string; code?: string } | string;
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
        // ignore parse failure
      }
      throw new Error(errMsg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    resetWatchdog(25_000, 'Free AI stream stalled mid-response.');

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      resetWatchdog(25_000, 'Free AI stream stalled mid-response.');
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
            const reasoningPart = delta?.reasoning || delta?.reasoning_content;
            if (typeof reasoningPart === 'string' && reasoningPart.length > 0) {
              params.onReasoningChunk?.(reasoningPart);
            }
            const content = delta?.content;
            if (typeof content === 'string' && content.length > 0) {
              fullContent += content;
              params.onContentChunk(content);
            } else if (Array.isArray(content)) {
              for (const part of content) {
                if (typeof part?.text === 'string' && part.text.length > 0) {
                  fullContent += part.text;
                  params.onContentChunk(part.text);
                }
              }
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
          const content = parsed?.choices?.[0]?.delta?.content;
          if (typeof content === 'string' && content.length > 0) {
            fullContent += content;
            params.onContentChunk(content);
          }
        } catch {
          // ignore incomplete tail
        }
      }
    }

    return fullContent;
  } catch (err) {
    if (timedOutReason) {
      throw new Error(timedOutReason);
    }
    throw err;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (params.signal) {
      params.signal.removeEventListener('abort', forwardAbort);
    }
  }
}
