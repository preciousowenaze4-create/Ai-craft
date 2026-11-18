import {
  applySurgicalPatchesToHtml,
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
import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import {
  DEFAULT_POLLINATIONS_TEXT_URL,
  buildGatewayExecutionPlan,
  getServerFreeAiKeys,
  parseGatewayModelIdentifier,
  resolveUsableGroqModels,
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
  _message: string,
  _hasPreviousHtml: boolean
): 'image' | 'music' | 'video' | null {
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
    const isContinueResume = /\[\[\s*CONTINUE_BUILD\s*\]\]/i.test(message);
    const trimmedExisting =
      previousHtml.length > 120000
        ? `${previousHtml.slice(0, 62000)}\n<!-- ... middle truncated (${previousHtml.length} total chars) ... -->\n${previousHtml.slice(-55000)}`
        : previousHtml;
    const continuationDirective = isContinueResume
      ? `RESUMING STOPPED/PAUSED BUILD WITH ${executionPlan.requestedModelLabel}: Continue building cleanly from the saved progress below! Preserve EVERY existing screen, style, handler, and database table already written, finish any unfinished screens/scripts, and output the complete finished app inside <<<AICRAFT_APP_HTML>>>...<<<END_AICRAFT_APP_HTML>>>.`
      : `EXISTING APP CODEBASE (Active Builder: ${executionPlan.requestedModelLabel} — You are continuing THIS EXACT app seamlessly! Perform SURGICAL additions/edits ONLY using <<<AICRAFT_PATCH>>> (preferred for adding features, buttons, themes, or 1-2 new screens cleanly without touching other screens) OR output full updated <<<AICRAFT_APP_HTML>>> preserving ALL untouched screens, navigation, database tables, and CSS variables):`;

    userBlocks.push(
      `${continuationDirective}\n\`\`\`html\n${trimmedExisting}\n\`\`\``
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
      `ATTACHED SCREENSHOT (${input.attachmentName || 'screenshot.png'}).${hintsLine} Examine every visual layer, card, layout spacing, color, typography, navigation bar, and control in the attached image carefully and match the user's request cleanly.`
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

  const previousHtml = typeof input.previousHtml === 'string' ? input.previousHtml : '';
  let extractedHtml = '';

  if (previousHtml.trim() && /<<<\s*AICRAFT_PATCH\s*>>>/i.test(cleanedRaw)) {
    const patched = applySurgicalPatchesToHtml(previousHtml, cleanedRaw);
    if (patched.html && patched.appliedCount > 0) {
      extractedHtml = patched.html;
    }
  }

  if (!extractedHtml) {
    extractedHtml = extractPreviewHtmlFromRaw(cleanedRaw);
    if (!extractedHtml && /<!doctype|<html|<body|<section|<main/i.test(cleanedRaw)) {
      extractedHtml = finalizePartialPreviewHtml(cleanedRaw);
    }
  }

  const explicitlyChat = /\[\[\s*INTENT\s*:\s*CHAT\s*\]\]/i.test(cleanedRaw) && !extractedHtml;
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

export async function streamServerFreeAiRealTime(params: {
  requestedModel?: string;
  systemPrompt: string;
  historyMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  signal?: AbortSignal;
  onModelMeta?: (meta: { modelId: string; modelName: string; provider: string }) => void;
  onReasoningChunk?: (reasoningText: string) => void;
  onContentChunk: (chunkText: string) => void;
}): Promise<{ rawOutput: string; modelUsed: string; modelName: string; provider: string }> {
  const { geminiKey, groqKey, openrouterKey } = getServerFreeAiKeys();
  const parsedModel = parseGatewayModelIdentifier(params.requestedModel);

  const tryOpenAiCompatibleStream = async (cfg: {
    url: string;
    apiKey: string;
    model: string;
    publicId: string;
    modelName: string;
    provider: string;
    extraHeaders?: Record<string, string>;
  }): Promise<string> => {
    params.onModelMeta?.({
      modelId: cfg.publicId,
      modelName: cfg.modelName,
      provider: cfg.provider,
    });
    const supportsImageUrl =
      cfg.provider !== 'groq' || /llama-4|vision/i.test(cfg.model);
    const userContent: unknown =
      params.attachmentDataUrl &&
      params.attachmentDataUrl.startsWith('data:image/') &&
      supportsImageUrl
        ? [
            { type: 'text', text: params.userPrompt },
            { type: 'image_url', image_url: { url: params.attachmentDataUrl } },
          ]
        : params.userPrompt;

    const response = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(cfg.extraHeaders || {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        max_tokens: 16384,
        messages: [
          { role: 'system', content: params.systemPrompt },
          ...params.historyMessages,
          { role: 'user', content: userContent },
        ],
      }),
      signal: params.signal,
    });

    if (!response.ok || !response.body) {
      const errText = await response.text().catch(() => '');
      throw new Error(
        errText.slice(0, 220) || `${cfg.modelName} returned status ${response.status}`
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                reasoning?: string;
                reasoning_content?: string;
                content?: string;
              };
            }>;
          };
          const delta = parsed?.choices?.[0]?.delta;
          const reasoning = delta?.reasoning || delta?.reasoning_content;
          if (reasoning) params.onReasoningChunk?.(reasoning);
          if (typeof delta?.content === 'string' && delta.content.length > 0) {
            fullContent += delta.content;
            params.onContentChunk(delta.content);
          }
        } catch {
          // ignore malformed SSE chunk
        }
      }
    }

    if (!fullContent.trim()) {
      throw new Error(`${cfg.modelName} returned an empty response.`);
    }
    return fullContent;
  };

  // Prefer Groq directly if explicitly selected & usable
  if (parsedModel.gateway === 'groq' && groqKey) {
    const groqInfo = await resolveUsableGroqModels();
    if (groqInfo.usable && groqInfo.bestModelId) {
      const hasImage = Boolean(
        params.attachmentDataUrl && params.attachmentDataUrl.startsWith('data:image/')
      );
      const chosenGroqModel =
        hasImage && groqInfo.visionModelId
          ? groqInfo.visionModelId
          : /llama-4|vision/i.test(parsedModel.upstreamModelId) ||
              parsedModel.upstreamModelId === groqInfo.bestModelId
            ? parsedModel.upstreamModelId
            : groqInfo.bestModelId;
      try {
        const out = await tryOpenAiCompatibleStream({
          url: 'https://api.groq.com/openai/v1/chat/completions',
          apiKey: groqKey,
          model: chosenGroqModel,
          publicId: `groq::${chosenGroqModel}`,
          modelName: `${chosenGroqModel.split('/').pop()} (Free Server)`,
          provider: 'groq',
        });
        return {
          rawOutput: out,
          modelUsed: `groq::${chosenGroqModel}`,
          modelName: `${chosenGroqModel.split('/').pop()} (Free Server)`,
          provider: 'groq',
        };
      } catch (groqErr) {
        if (!geminiKey && !openrouterKey) {
          throw groqErr;
        }
      }
    }
  }

  // Prefer OpenRouter directly if explicitly selected & key exists
  if (parsedModel.gateway === 'openrouter' && openrouterKey) {
    const out = await tryOpenAiCompatibleStream({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: openrouterKey,
      model: parsedModel.upstreamModelId,
      publicId: `openrouter::${parsedModel.upstreamModelId}`,
      modelName: 'Qwen3 Coder (Free Server)',
      provider: 'openrouter',
      extraHeaders: { 'X-Title': 'AI Craft' },
    });
    return {
      rawOutput: out,
      modelUsed: `openrouter::${parsedModel.upstreamModelId}`,
      modelName: 'Qwen3 Coder (Free Server)',
      provider: 'openrouter',
    };
  }

  // Default & Primary Server Vision + Code Path: @google/genai (gemini-4-hydrogen)
  if (geminiKey) {
    params.onModelMeta?.({
      modelId: 'gemini::gemini-4-hydrogen',
      modelName: 'Gemini Flash (Vision · Free Server)',
      provider: 'google',
    });

    const ai = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const contents: Array<{
      role: 'user' | 'model';
      parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
    }> = params.historyMessages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const userParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
    if (params.attachmentDataUrl && params.attachmentDataUrl.startsWith('data:image/')) {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(
        params.attachmentDataUrl
      );
      if (match?.[1] && match?.[2]) {
        userParts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        });
      }
    }
    userParts.push({ text: params.userPrompt });
    contents.push({ role: 'user', parts: userParts });

    const streamResponse = await ai.models.generateContentStream({
      model: 'gemini-4-hydrogen',
      contents,
      config: {
        systemInstruction: params.systemPrompt,
      },
    });

    let fullContent = '';
    for await (const chunk of streamResponse) {
      if (params.signal?.aborted) break;
      const c = chunk as GenerateContentResponse;
      const text = typeof c.text === 'string' ? c.text : '';
      if (text) {
        fullContent += text;
        params.onContentChunk(text);
      }
    }

    if (fullContent.trim()) {
      return {
        rawOutput: fullContent,
        modelUsed: 'gemini::gemini-4-hydrogen',
        modelName: 'Gemini Flash (Vision · Free Server)',
        provider: 'google',
      };
    }
  }

  if (groqKey) {
    const groqInfo = await resolveUsableGroqModels();
    if (groqInfo.usable && groqInfo.bestModelId) {
      const hasImage = Boolean(
        params.attachmentDataUrl && params.attachmentDataUrl.startsWith('data:image/')
      );
      const chosenGroqModel =
        hasImage && groqInfo.visionModelId
          ? groqInfo.visionModelId
          : groqInfo.bestModelId;
      const out = await tryOpenAiCompatibleStream({
        url: 'https://api.groq.com/openai/v1/chat/completions',
        apiKey: groqKey,
        model: chosenGroqModel,
        publicId: `groq::${chosenGroqModel}`,
        modelName: `${chosenGroqModel.split('/').pop()} (Free Server)`,
        provider: 'groq',
      });
      return {
        rawOutput: out,
        modelUsed: `groq::${chosenGroqModel}`,
        modelName: `${chosenGroqModel.split('/').pop()} (Free Server)`,
        provider: 'groq',
      };
    }
  }

  if (openrouterKey) {
    const out = await tryOpenAiCompatibleStream({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: openrouterKey,
      model: 'qwen/qwen3-coder:free',
      publicId: 'openrouter::qwen/qwen3-coder:free',
      modelName: 'Qwen3 Coder (Free Server)',
      provider: 'openrouter',
      extraHeaders: { 'X-Title': 'AI Craft' },
    });
    return {
      rawOutput: out,
      modelUsed: 'openrouter::qwen/qwen3-coder:free',
      modelName: 'Qwen3 Coder (Free Server)',
      provider: 'openrouter',
    };
  }

  const fallbackOut = await streamPollinationsRealTime({
    systemPrompt: params.systemPrompt,
    historyMessages: params.historyMessages,
    userPrompt: params.userPrompt,
    signal: params.signal,
    onReasoningChunk: params.onReasoningChunk,
    onContentChunk: params.onContentChunk,
  });

  return {
    rawOutput: fallbackOut,
    modelUsed: params.requestedModel || 'puter::gemini-2.5-flash',
    modelName: 'Free Vision & Code Builder',
    provider: 'browser',
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
