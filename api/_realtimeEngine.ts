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
  BACKEND_DESIGNER_MODEL_ID,
  GEMINI_BUILDER_MODELS,
  buildGatewayExecutionPlan,
  getServerGeminiApiKey,
  parseGatewayModelIdentifier,
} from './_aiGateways.js';

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

function formatGeminiApiError(err: unknown, modelName: string): string {
  const rawMsg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'AI Craft engine request failed.';
  const lower = rawMsg.toLowerCase();

  if (
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('permission_denied') ||
    lower.includes('403')
  ) {
    return 'Your GEMINI_API_KEY was rejected or is invalid. Please check GEMINI_API_KEY in Vercel Environment Variables (or Settings > Secrets).';
  }
  if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
    return `${modelName} reached its API quota or rate limit. Try switching to AI Craft Pro (4 Hydrogen) or AI Craft Mini (3.1).`;
  }
  if (lower.includes('not_found') || lower.includes('404') || lower.includes('not found')) {
    return `${modelName} is not available on this GEMINI_API_KEY yet. Try switching to AI Craft Pro (4 Hydrogen) or AI Craft 2.5 Flash.`;
  }
  return rawMsg.slice(0, 320);
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
      'Produce a concise, production-ready UI/UX architecture blueprint in 8-10 tight bullet points covering: (1) Exact hex color tokens (background, card surface, primary accent, ink), (2) Typography & layout spacing rhythm, (3) Screen tabs/views (4-6 screens) or targeted surgical layer addition if updating an existing app, (4) Key interactive cards, buttons, and visual polish details. Write ONLY the design blueprint — zero HTML or code blocks.',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  const timeoutPromise = new Promise<string>((resolve) => {
    setTimeout(() => resolve(''), 6000);
  });

  const generatePromise = (async () => {
    try {
      const response = await ai.models.generateContent({
        model: BACKEND_DESIGNER_MODEL_ID,
        contents: [{ role: 'user', parts: designerParts }],
        config: {
          systemInstruction:
            'You are the internal UI/UX Design Architect inside AI Craft. Produce a crisp, practical visual design blueprint (colors, layout hierarchy, components, multi-screen structure) with zero HTML or code fences.',
        },
      });
      return (response.text || '').trim().slice(0, 1400);
    } catch {
      return '';
    }
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

  const wantsSearch =
    input.webSearchEnabled !== false &&
    (initialRoute !== 'chat' || shouldRunChatSearch(message, hasPreviousHtml));

  if (wantsSearch) {
    input.onStage?.({
      phase: 'understanding',
      kind: initialRoute === 'build' ? 'build' : 'chat',
      action: 'Searching',
      label: 'Searching live web & references...',
    });
  }

  const searchData = wantsSearch
    ? await runLiveBrowserSearch(buildFocusedSearchQuery(message))
    : { query: '', results: [], images: [] };

  const webSearchContext = formatWebSearchContext(searchData);
  const previewSummary = extractPreviewStructureSummary(previousHtml);

  const shouldRunDesignEngine =
    !input.forceChat &&
    !naturalMediaIntent &&
    (initialRoute === 'build' || (initialRoute === 'auto' && message.length >= 10));

  let designBlueprint = '';
  if (shouldRunDesignEngine && getServerGeminiApiKey()) {
    input.onStage?.({
      phase: 'understanding',
      kind: initialRoute === 'build' ? 'build' : 'chat',
      action: 'Designing',
      label: 'Designing UI layout & visual architecture...',
    });
    designBlueprint = await runBackendDesignArchitect({
      message,
      mode: input.mode,
      hasPreviousHtml,
      previewSummary,
      attachmentDataUrl: input.attachmentDataUrl,
      visualHints: input.visualHints,
      searchQuery: searchData.query,
    });
  }

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
    projectMemoryContext: input.projectMemoryContext,
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
  const modelUsed = input.modelUsed || 'gemini::gemini-4-hydrogen';
  const modelName = input.modelName || 'AI Craft Pro (4 Hydrogen)';
  const provider = input.provider || 'aicraft';

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
  const geminiKey = getServerGeminiApiKey();
  if (!geminiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured on the server yet. Add GEMINI_API_KEY in Vercel Environment Variables (or Settings > Secrets) and redeploy.'
    );
  }

  const parsedModel = parseGatewayModelIdentifier(params.requestedModel);
  const matched =
    GEMINI_BUILDER_MODELS.find(
      (m) =>
        m.id === params.requestedModel ||
        m.upstreamModelId === parsedModel.upstreamModelId
    ) ?? GEMINI_BUILDER_MODELS[0];

  params.onModelMeta?.({
    modelId: matched.id,
    modelName: matched.name,
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

  try {
    const streamResponse = await ai.models.generateContentStream({
      model: matched.upstreamModelId,
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

    if (!fullContent.trim()) {
      throw new Error(`${matched.name} returned an empty response.`);
    }

    return {
      rawOutput: fullContent,
      modelUsed: matched.id,
      modelName: matched.name,
      provider: 'aicraft',
    };
  } catch (err) {
    throw new Error(formatGeminiApiError(err, matched.name));
  }
}
