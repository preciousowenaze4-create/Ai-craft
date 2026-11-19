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
  type SearchVideoItem,
} from './_builderCore.js';
import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import {
  BACKEND_DESIGNER_MODEL_ID,
  GEMINI_BUILDER_MODELS,
  buildGatewayExecutionPlan,
  getOrderedBackendGeminiFailoverModels,
  getServerGeminiApiKey,
  markGatewayCandidateCooldown,
  parseGatewayModelIdentifier,
} from './_aiGateways.js';
import {
  recordGeminiApiError,
  recordGeminiApiUsage,
} from './_geminiUsage.js';

export function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractReadableErrorMessage(err: unknown): string {
  let msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'AI Craft engine request failed.';
  for (let depth = 0; depth < 3; depth += 1) {
    const trimmed = msg.trim();
    if (!trimmed.startsWith('{')) break;
    try {
      const parsed = JSON.parse(trimmed) as {
        message?: string;
        error?: { message?: string } | string;
      };
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        msg = parsed.error;
        continue;
      }
      if (
        parsed.error &&
        typeof parsed.error === 'object' &&
        typeof parsed.error.message === 'string' &&
        parsed.error.message.trim()
      ) {
        msg = parsed.error.message;
        continue;
      }
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        msg = parsed.message;
        continue;
      }
    } catch {
      break;
    }
    break;
  }
  return msg.trim();
}

function isKeyFatalError(rawLower: string): boolean {
  return (
    rawLower.includes('api_key_invalid') ||
    rawLower.includes('api key not valid') ||
    rawLower.includes('api key expired') ||
    rawLower.includes('permission_denied') ||
    rawLower.includes('403')
  );
}

function isModelNotFoundError(rawLower: string): boolean {
  return (
    rawLower.includes('not_found') ||
    rawLower.includes('404') ||
    rawLower.includes('not found') ||
    rawLower.includes('is not supported for')
  );
}

function formatGeminiApiError(err: unknown, modelName: string): string {
  const rawMsg = extractReadableErrorMessage(err);
  const lower = rawMsg.toLowerCase();

  if (isKeyFatalError(lower)) {
    return 'Your GEMINI_API_KEY was rejected or expired. Please check GEMINI_API_KEY in Vercel Environment Variables.';
  }
  if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
    return `${modelName} reached its current API quota limit across all backup models. Please wait a moment or recharge/upgrade GEMINI_API_KEY.`;
  }
  if (
    lower.includes('503') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('overloaded')
  ) {
    return `${modelName} and backup engines are temporarily busy on Google servers. Tap Continue / Retry in a few seconds.`;
  }
  if (isModelNotFoundError(lower)) {
    return `${modelName} could not reach an enabled model on this GEMINI_API_KEY.`;
  }
  return rawMsg.slice(0, 260);
}

export interface VisualHintsSpec {
  dominantColor?: string;
  surfaceTheme?: 'dark' | 'light';
  width?: number;
  height?: number;
}

export interface PrepareRealtimeStageEvent {
  phase: 'understanding' | 'building';
  kind: 'chat' | 'build' | 'media';
  action: string;
  label: string;
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
  projectMemoryContext?: string;
  projectMemoryPromise?: Promise<{ brainContext: string; memory?: unknown }>;
  onStage?: (stage: PrepareRealtimeStageEvent) => void;
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
    videos: SearchVideoItem[];
  };
  timeContext: string;
  designBlueprint?: string;
}

export function detectNaturalMediaRequest(
  _message: string,
  _hasPreviousHtml: boolean
): 'image' | 'music' | 'video' | null {
  return null;
}

/**
 * Hidden Backend Design Architect Engine (powered by Gemini 2.5 Pro).
 * Runs automatically behind the scenes when building or designing an app,
 * producing a concise UI/UX visual blueprint for the active builder model.
 */
async function runBackendDesignArchitect(params: {
  message: string;
  mode: 'mobile' | 'web';
  hasPreviousHtml: boolean;
  previewSummary: string;
  attachmentDataUrl?: string | null;
  visualHints?: VisualHintsSpec | null;
  searchQuery?: string;
}): Promise<string> {
  const geminiKey = getServerGeminiApiKey();
  if (!geminiKey) return '';

  const ai = createGeminiClient(geminiKey);
  const designerParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  if (params.attachmentDataUrl && params.attachmentDataUrl.startsWith('data:image/')) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(
      params.attachmentDataUrl
    );
    if (match?.[1] && match?.[2]) {
      designerParts.push({
        inlineData: {
          mimeType: match[1],
          data: match[2],
        },
      });
    }
  }

  const hintsText =
    params.visualHints?.dominantColor || params.visualHints?.surfaceTheme
      ? `Screenshot cues: dominant=${params.visualHints.dominantColor || 'auto'}, surface=${params.visualHints.surfaceTheme || 'auto'}, size=${params.visualHints.width || '?'}x${params.visualHints.height || '?'}.`
      : '';

  designerParts.push({
    text: [
      `Target: ${params.mode === 'mobile' ? 'Mobile App (Android & iOS)' : 'Responsive Full-Stack Web App'}.`,
      params.hasPreviousHtml && params.previewSummary
        ? `Existing app context:\n${params.previewSummary.slice(0, 900)}`
        : 'Brand new app build from scratch.',
      hintsText,
      params.searchQuery ? `Search topic: ${params.searchQuery}` : '',
      `User goal: "${params.message.slice(0, 900)}"`,
      'Produce a concise, production-ready UI/UX & data architecture blueprint in 8-10 tight bullet points covering: (1) Exact hex color tokens (background, card surface, primary accent, ink), (2) Typography & layout spacing rhythm, (3) Screen tabs/views (4-6 screens) or targeted surgical layer addition if updating an existing app, (4) Real `window.AICraft.db` tables & fields plus real interactive CRUD handlers (zero hardcoded static cards or dead buttons), (5) Do NOT invent a brand logo or PWA Home Screen setup unless the user explicitly requested one or attached a logo image. Write ONLY the blueprint — zero HTML or code blocks.',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  const timeoutPromise = new Promise<string>((resolve) => {
    setTimeout(() => resolve(''), 4200);
  });

  const generatePromise = (async () => {
    const designerModels = [BACKEND_DESIGNER_MODEL_ID, 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
    for (const designerModel of designerModels) {
      try {
        const response = await ai.models.generateContent({
          model: designerModel,
          contents: [{ role: 'user', parts: designerParts }],
          config: {
            systemInstruction:
              'You are the internal UI/UX Design Architect inside AI Craft. Produce a crisp, practical visual design blueprint (colors, layout hierarchy, components, multi-screen structure) with zero HTML or code fences.',
          },
        });
        const textOut = (response.text || '').trim().slice(0, 1400);
        const usage = response.usageMetadata;
        void recordGeminiApiUsage({
          modelId: designerModel,
          promptTokens: usage?.promptTokenCount,
          candidatesTokens: usage?.candidatesTokenCount,
          totalTokens: usage?.totalTokenCount ?? Math.max(120, Math.ceil(textOut.length / 4)),
          source: 'design-architect',
        });
        if (textOut) return textOut;
      } catch (err) {
        const lower = extractReadableErrorMessage(err).toLowerCase();
        if (isKeyFatalError(lower)) {
          void recordGeminiApiError({
            modelId: designerModel,
            error: err,
            source: 'design-architect',
          });
          return '';
        }
        // Silently advance to fallback designer model on 503/404/429
      }
    }
    return '';
  })();

  return Promise.race([generatePromise, timeoutPromise]);
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

  const focusedSearchQuery = buildFocusedSearchQuery(message);
  const wantsSearch =
    input.webSearchEnabled !== false &&
    (initialRoute !== 'chat' || shouldRunChatSearch(message, hasPreviousHtml));

  const previewSummary = extractPreviewStructureSummary(previousHtml);
  const shouldRunDesignEngine =
    !input.forceChat &&
    !naturalMediaIntent &&
    Boolean(getServerGeminiApiKey()) &&
    (initialRoute === 'build' || (initialRoute === 'auto' && message.length >= 10));

  if (wantsSearch || shouldRunDesignEngine) {
    input.onStage?.({
      phase: 'understanding',
      kind: initialRoute === 'build' ? 'build' : 'chat',
      action: wantsSearch ? 'Searching' : 'Designing',
      label:
        wantsSearch && shouldRunDesignEngine
          ? 'Searching live web & designing visual architecture...'
          : wantsSearch
            ? 'Searching live web & references...'
            : 'Designing UI layout & visual architecture...',
    });
  }

  const [searchData, designBlueprint, resolvedMem] = await Promise.all([
    wantsSearch
      ? runLiveBrowserSearch(focusedSearchQuery)
      : Promise.resolve({ query: '', results: [], images: [], videos: [] }),
    shouldRunDesignEngine
      ? runBackendDesignArchitect({
          message,
          mode: input.mode,
          hasPreviousHtml,
          previewSummary,
          attachmentDataUrl: input.attachmentDataUrl,
          visualHints: input.visualHints,
          searchQuery: focusedSearchQuery,
        })
      : Promise.resolve(''),
    input.projectMemoryPromise
      ? input.projectMemoryPromise.catch(() => ({ brainContext: '' }))
      : Promise.resolve({ brainContext: input.projectMemoryContext || '' }),
  ]);

  const effectiveMemoryContext = resolvedMem.brainContext || input.projectMemoryContext || '';
  const webSearchContext = formatWebSearchContext(searchData);

  input.onStage?.({
    phase: 'understanding',
    kind: initialRoute === 'build' ? 'build' : 'chat',
    action: 'Thinking',
    label:
      initialRoute === 'chat'
        ? 'Thinking through your question...'
        : 'Planning screens & database architecture...',
  });

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

  const activeFlags: string[] = [];
  if (input.reactEnabled) activeFlags.push('Rich interactive SPA views');
  if (input.backendEnabled) activeFlags.push('Persistent real-time database (`window.AICraft.db`)');
  if (input.webSearchEnabled !== false) activeFlags.push('Live browser search & real photography');

  const systemPrompt = buildCraftSystemPrompt({
    mediaKind,
    requestedModel: input.requestedModel || 'gemini::gemini-4-hydrogen',
    requestedModelLabel: executionPlan.requestedModelLabel,
    initialRoute,
    shouldGenerateTitle,
    timeContext,
    projectInfraContext,
    projectMemoryContext: effectiveMemoryContext,
    designBlueprint,
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
    designBlueprint,
  };
}

export interface FinalizeRealtimeInput {
  rawOutput: string;
  message: string;
  mode: 'mobile' | 'web';
  previousHtml?: string;
  hasAttachment?: boolean;
  modelUsed?: string;
  modelName?: string;
  provider?: string;
  startedAt?: number;
}

export function userRequestedLogoOrPwa(
  message: string,
  hasAttachment = false,
  rawHasLogoTag = false
): boolean {
  const msg = String(message || '').toLowerCase();
  if (
    /\b(?:logo|app\s*icon|brand\s*icon|favicon|emblem|monogram|wordmark|add\s+to\s+home\s*screen|home\s*screen\s*(?:app|icon)|pwa|installable|standalone\s*app)\b/i.test(
      msg
    )
  ) {
    return true;
  }
  if (hasAttachment && rawHasLogoTag) {
    return true;
  }
  return false;
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
  const modelUsed = input.modelUsed || 'gemini::gemini-4-hydrogen';
  const modelName = input.modelName || 'AI Craft Pro (4 Hydrogen)';
  const provider = input.provider || 'aicraft';

  const explicitTitleMatch = /\[\[\s*TITLE\s*:\s*([^\]]+?)\s*\]\]/i.exec(cleanedRaw);
  const title = explicitTitleMatch?.[1]?.trim()
    ? explicitTitleMatch[1].trim().slice(0, 60)
    : deriveServerSessionTitle(input.message, input.mode);

  const planSteps = extractPlanStepsFromRaw(cleanedRaw);
  const extractedLogo = extractLogoDirectiveFromRaw(cleanedRaw);
  const allowLogoOrPwa = userRequestedLogoOrPwa(
    input.message,
    Boolean(input.hasAttachment),
    Boolean(extractedLogo)
  );
  const logo = allowLogoOrPwa ? extractedLogo : null;

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
  const geminiKey = getServerGeminiApiKey();
  if (!geminiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured on the server yet. Add GEMINI_API_KEY in Vercel Environment Variables (or Settings > Secrets) and redeploy.'
    );
  }

  const parsedModel = parseGatewayModelIdentifier(params.requestedModel);
  const flagshipModel = GEMINI_BUILDER_MODELS[0];
  const failoverCandidates = getOrderedBackendGeminiFailoverModels(
    parsedModel.upstreamModelId
  );

  params.onModelMeta?.({
    modelId: flagshipModel.id,
    modelName: flagshipModel.name,
    provider: 'aicraft',
  });

  const ai = createGeminiClient(geminiKey);

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

  let lastError: unknown = null;
  let lastAttemptedUpstreamId = failoverCandidates[0]?.upstreamModelId || 'gemini-4-hydrogen';

  for (const candidate of failoverCandidates) {
    if (params.signal?.aborted) {
      throw new Error('Request cancelled.');
    }

    lastAttemptedUpstreamId = candidate.upstreamModelId;
    let fullContent = '';
    let emittedAnyChunk = false;
    let lastPromptTokens = 0;
    let lastCandidatesTokens = 0;
    let lastTotalTokens = 0;

    try {
      const streamConnectTimeoutMs = 15000;
      const streamResponse = await Promise.race([
        ai.models.generateContentStream({
          model: candidate.upstreamModelId,
          contents,
          config: {
            systemInstruction: params.systemPrompt,
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${candidate.label} stream timed out waiting for first byte.`)), streamConnectTimeoutMs)
        ),
      ]);

      for await (const chunk of streamResponse) {
        if (params.signal?.aborted) break;
        const c = chunk as GenerateContentResponse;
        if (c.usageMetadata) {
          lastPromptTokens = c.usageMetadata.promptTokenCount ?? lastPromptTokens;
          lastCandidatesTokens = c.usageMetadata.candidatesTokenCount ?? lastCandidatesTokens;
          lastTotalTokens = c.usageMetadata.totalTokenCount ?? lastTotalTokens;
        }
        const text = typeof c.text === 'string' ? c.text : '';
        if (text) {
          fullContent += text;
          emittedAnyChunk = true;
          params.onContentChunk(text);
        }
      }

      if (!fullContent.trim()) {
        throw new Error(`${candidate.label} returned an empty response.`);
      }

      const fallbackEstimate = Math.max(
        1,
        Math.ceil((params.userPrompt.length + params.systemPrompt.length + fullContent.length) / 4)
      );
      await recordGeminiApiUsage({
        modelId: candidate.upstreamModelId,
        promptTokens:
          lastPromptTokens || Math.ceil((params.userPrompt.length + params.systemPrompt.length) / 4),
        candidatesTokens: lastCandidatesTokens || Math.ceil(fullContent.length / 4),
        totalTokens: lastTotalTokens || fallbackEstimate,
        source: 'craft-stream',
      }).catch(() => undefined);

      return {
        rawOutput: fullContent,
        modelUsed: flagshipModel.id,
        modelName: flagshipModel.name,
        provider: 'aicraft',
      };
    } catch (err) {
      lastError = err;
      const lower = extractReadableErrorMessage(err).toLowerCase();

      if (isKeyFatalError(lower)) {
        await recordGeminiApiError({
          modelId: candidate.upstreamModelId,
          error: err,
          source: 'craft-stream',
        }).catch(() => undefined);
        throw new Error(formatGeminiApiError(err, flagshipModel.name));
      }

      // If this model hasn't streamed partial text to the client yet, silently advance
      // to the next healthy Gemini model in the backend failover chain.
      if (!emittedAnyChunk) {
        const cooldownMs = isModelNotFoundError(lower) ? 15 * 60_000 : 45_000;
        markGatewayCandidateCooldown(candidate.cooldownKey, cooldownMs);
        continue;
      }

      // Partial output already streamed; surface clean formatted message
      throw new Error(formatGeminiApiError(err, flagshipModel.name));
    }
  }

  // Only record global exhaustion if ALL models in the backend chain failed
  if (lastError) {
    await recordGeminiApiError({
      modelId: lastAttemptedUpstreamId,
      error: lastError,
      source: 'craft-stream',
    }).catch(() => undefined);
  }
  throw new Error(formatGeminiApiError(lastError, flagshipModel.name));
}

/**
 * Fast single-pass repair if initial HTML failed script syntax or completeness validation.
 */
export async function repairIncompleteBuildHtml(params: {
  brokenHtml: string;
  validationReason: string;
  userMessage: string;
  mode: 'mobile' | 'web';
}): Promise<string> {
  const geminiKey = getServerGeminiApiKey();
  if (!geminiKey || !params.brokenHtml.trim()) return '';

  const ai = createGeminiClient(geminiKey);
  const repairPrompt = [
    `The built ${params.mode} app HTML for "${params.userMessage.slice(0, 200)}" failed validation: ${params.validationReason}`,
    'Fix ONLY the broken/truncated HTML, CSS, or <script> syntax and ensure the main screen content renders immediately with working buttons and zero empty blank viewports.',
    'Output ONLY the complete corrected <!DOCTYPE html>...</html> inside <<<AICRAFT_APP_HTML>>>...<<<END_AICRAFT_APP_HTML>>>.',
    '```html',
    params.brokenHtml.slice(0, 70000),
    '```',
  ].join('\n');

  const repairPromise = (async () => {
    for (const modelId of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
      try {
        const res = await ai.models.generateContent({
          model: modelId,
          contents: [{ role: 'user', parts: [{ text: repairPrompt }] }],
        });
        const raw = (res.text || '').trim();
        const extracted = extractPreviewHtmlFromRaw(raw) || finalizePartialPreviewHtml(raw);
        if (extracted) {
          const hardened = sanitizeAndHardenPreviewHtml(extracted);
          if (validateBuiltAppHtml(hardened).valid) {
            return hardened;
          }
        }
      } catch {
        // try next fast repair model
      }
    }
    return '';
  })();

  return Promise.race([
    repairPromise,
    new Promise<string>((resolve) => setTimeout(() => resolve(''), 12000)),
  ]);
}
