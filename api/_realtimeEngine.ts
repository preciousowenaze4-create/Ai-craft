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
  isGameBuildPrompt,
  mergeParsedDbTables,
  runLiveBrowserSearch,
  sanitizeAndHardenPreviewHtml,
  sanitizeBuildProse,
  shouldRunChatSearch,
  shouldSkipSlowWebSearchForBuild,
  stripReasoningTags,
  validateBuiltAppHtml,
  type ParsedDbTable,
  type SearchImageItem,
  type SearchResultItem,
  type SearchVideoItem,
} from './_builderCore.js';
import { GoogleGenAI } from '@google/genai';
import {
  buildGatewayExecutionPlan,
  hasServerFreeAiKey,
  markApiKeyInvalidCooldown,
  markGatewayCandidateCooldown,
  resolveDynamicGeminiExecutionMatrix,
} from './_aiGateways.js';
import { recordGeminiApiUsage } from './_geminiUsage.js';
import {
  completeFreeAiMesh,
  isFreeAiMeshAvailable,
  isMeshParallelBuildsEnabled,
  streamFreeAiMesh,
} from './_freeAiMesh.js';

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

function isInvalidApiKeyError(rawLower: string): boolean {
  return (
    rawLower.includes('api_key_invalid') ||
    rawLower.includes('api key not valid') ||
    rawLower.includes('api key expired') ||
    rawLower.includes('reported as leaked') ||
    rawLower.includes('consumer_suspended') ||
    rawLower.includes('project has been suspended')
  );
}

function isModelRetiredOrUnavailableError(rawLower: string): boolean {
  return (
    rawLower.includes('not_found') ||
    rawLower.includes('404') ||
    rawLower.includes('not found') ||
    rawLower.includes('no longer available') ||
    rawLower.includes('is deprecated') ||
    rawLower.includes('deprecated') ||
    rawLower.includes('retired') ||
    rawLower.includes('shut down') ||
    rawLower.includes('shutdown') ||
    rawLower.includes('update your code') ||
    rawLower.includes('is not supported for') ||
    rawLower.includes('permission_denied') ||
    rawLower.includes('403') ||
    rawLower.includes('paid tier') ||
    rawLower.includes('billing')
  );
}

function isThinkingConfigRejectedError(rawLower: string): boolean {
  return (
    rawLower.includes('thinking') ||
    rawLower.includes('thinkinglevel') ||
    rawLower.includes('thinkingbudget') ||
    rawLower.includes('includethoughts') ||
    (rawLower.includes('invalid_argument') && rawLower.includes('config'))
  );
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
  isPatchMode?: boolean;
  isGameBuild?: boolean;
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
  const hasGemini = hasServerFreeAiKey();
  if (!hasGemini && !isFreeAiMeshAvailable()) return '';

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
    if (hasGemini) {
      const candidates = await resolveDynamicGeminiExecutionMatrix({ taskKind: 'design' });
      const clientMap = new Map<string, GoogleGenAI>();
      const badKeys = new Set<string>();

      for (const candidate of candidates.slice(0, 6)) {
        if (badKeys.has(candidate.keyFingerprint)) continue;
        let ai = clientMap.get(candidate.apiKey);
        if (!ai) {
          ai = createGeminiClient(candidate.apiKey);
          clientMap.set(candidate.apiKey, ai);
        }

        try {
          const response = await ai.models.generateContent({
            model: candidate.upstreamModelId,
            contents: [{ role: 'user', parts: designerParts }],
            config: {
              systemInstruction:
                'You are the internal UI/UX Design Architect inside AI Craft. Produce a crisp, practical visual design blueprint (colors, layout hierarchy, components, multi-screen structure) with zero HTML or code fences.',
            },
          });
          const textOut = (response.text || '').trim().slice(0, 1400);
          const usage = response.usageMetadata;
          void recordGeminiApiUsage({
            modelId: candidate.upstreamModelId,
            promptTokens: usage?.promptTokenCount,
            candidatesTokens: usage?.candidatesTokenCount,
            totalTokens: usage?.totalTokenCount ?? Math.max(120, Math.ceil(textOut.length / 4)),
            source: 'design-architect',
          });
          if (textOut) return textOut;
        } catch (err) {
          const lower = extractReadableErrorMessage(err).toLowerCase();
          if (isInvalidApiKeyError(lower)) {
            markApiKeyInvalidCooldown(candidate.apiKey);
            badKeys.add(candidate.keyFingerprint);
          } else if (isModelRetiredOrUnavailableError(lower)) {
            markGatewayCandidateCooldown(candidate.cooldownKey, 6 * 60 * 60_000, true);
          } else {
            markGatewayCandidateCooldown(candidate.cooldownKey, 45_000, false);
          }
        }
      }
    }

    // Free AI mesh fallback so the design pre-pass also runs keyless.
    const meshText = await completeFreeAiMesh({
      taskKind: 'chat',
      systemPrompt:
        'You are the internal UI/UX Design Architect inside AI Craft. Produce a crisp, practical visual design blueprint (colors, layout hierarchy, components, multi-screen structure) with zero HTML or code fences.',
      userPrompt: designerParts
        .map((p) => p.text || '')
        .filter(Boolean)
        .join('\n'),
      attachmentDataUrl: params.attachmentDataUrl ?? null,
      timeoutMs: 3800,
    });
    return meshText ? meshText.trim().slice(0, 1400) : '';
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

  const isGameBuild = initialRoute === 'build' && isGameBuildPrompt(message);
  const focusedSearchQuery = buildFocusedSearchQuery(message);
  const skipBuildSearch =
    initialRoute === 'build' &&
    shouldSkipSlowWebSearchForBuild(message, Boolean(input.attachmentDataUrl));
  const wantsSearch =
    input.webSearchEnabled !== false &&
    !skipBuildSearch &&
    (initialRoute !== 'chat' || shouldRunChatSearch(message, hasPreviousHtml));

  const previewSummary = extractPreviewStructureSummary(previousHtml);
  const wantsFullRedesign =
    /\b(redesign|restyle\s*(?:all|everything|the\s*whole|entire)|rebuild\s*from\s*scratch|start\s*over|completely\s*new)\b/i.test(
      message
    );
  const isPatchMode =
    hasPreviousHtml &&
    initialRoute !== 'chat' &&
    !wantsFullRedesign &&
    !/\[\[\s*CONTINUE_BUILD\s*\]\]/i.test(message);

  // Only invoke the extra visual architect pre-pass when a screenshot is attached or user explicitly asks for a full redesign.
  const shouldRunDesignEngine =
    !input.forceChat &&
    !naturalMediaIntent &&
    (hasServerFreeAiKey() || isFreeAiMeshAvailable()) &&
    initialRoute === 'build' &&
    (Boolean(input.attachmentDataUrl) || wantsFullRedesign);

  if (wantsSearch || shouldRunDesignEngine) {
    input.onStage?.({
      phase: 'understanding',
      kind: initialRoute === 'build' ? 'build' : 'chat',
      action: 'Building',
      label: wantsSearch
        ? 'Searching references...'
        : 'Analyzing layout & screenshot...',
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
    action: initialRoute === 'build' ? 'Building' : 'Thinking',
    label:
      initialRoute === 'build'
        ? isGameBuild
          ? 'Designing game mechanics & controls...'
          : isPatchMode
            ? 'Planning update...'
            : 'Planning app layout & database...'
        : initialRoute === 'chat'
          ? 'Thinking...'
          : 'Understanding request...',
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
  if (input.webSearchEnabled !== false && !skipBuildSearch) {
    activeFlags.push('Live browser search & real photography');
  }

  const systemPrompt = buildCraftSystemPrompt({
    mediaKind,
    requestedModel: input.requestedModel || 'mesh::auto',
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
    isGameBuild,
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
    const cleanedPreviousForPrompt = previousHtml
      .replace(/<style\b[^>]*data-aicraft-safety[^>]*>[\s\S]*?<\/style>\s*/gi, '')
      .replace(/<script\b[^>]*data-aicraft-safety-js[^>]*>[\s\S]*?<\/script>\s*/gi, '');
    const trimmedExisting =
      cleanedPreviousForPrompt.length > 120000
        ? `${cleanedPreviousForPrompt.slice(0, 62000)}\n<!-- ... middle truncated (${cleanedPreviousForPrompt.length} total chars) ... -->\n${cleanedPreviousForPrompt.slice(-55000)}`
        : cleanedPreviousForPrompt;
    const continuationDirective = isContinueResume
      ? `RESUMING STOPPED/PAUSED BUILD WITH ${executionPlan.requestedModelLabel}: Continue building cleanly from the saved progress below! Preserve EVERY existing screen, style, handler, and database table already written, finish any unfinished screens/scripts, and output the complete finished app inside <<<AICRAFT_APP_HTML>>>...<<<END_AICRAFT_APP_HTML>>>.`
      : wantsFullRedesign
        ? `EXISTING APP CODEBASE (Active Builder: ${executionPlan.requestedModelLabel} — User explicitly requested a redesign/overhaul. Preserve existing domain features and \`window.AICraft.db\` data tables while applying the requested redesign cleanly inside <<<AICRAFT_APP_HTML>>>...<<<END_AICRAFT_APP_HTML>>>):`
        : `EXISTING APP CODEBASE — VISUAL LOCK & SURGICAL EDIT MODE (Active Builder: ${executionPlan.requestedModelLabel}):
CRITICAL PRESERVATION RULES:
- DO NOT change existing \`:root\` CSS variables, colors, fonts, body layout, header bar, bottom nav bar, or untouched screens!
- DO NOT rewrite the entire HTML unless restructuring everything is strictly unavoidable.
- USE \`<<<AICRAFT_PATCH>>>...<<<END_PATCH>>>\` with exact \`<<<SEARCH>>>...<<<REPLACE>>>...\` anchors (copied character-for-character from the code below), \`<<<APPEND_CSS>>>\`, \`<<<APPEND_SCREEN>>>\`, and/or \`<<<APPEND_SCRIPT>>>\` so the existing app keeps 100% of its exact visual look & working features:`;

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
    isPatchMode,
    isGameBuild,
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
  const modelUsed = input.modelUsed || 'mesh::auto';
  const modelName = input.modelName || 'Free AI Mesh · Auto';
  const provider = input.provider || 'free-mesh';

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
  const hasPatchDirective =
    previousHtml.trim().length > 0 && /<<<\s*AICRAFT_PATCH\s*>>>/i.test(cleanedRaw);
  let extractedHtml = '';
  let patchFailedCompletely = false;

  if (hasPatchDirective) {
    const patched = applySurgicalPatchesToHtml(previousHtml, cleanedRaw);
    if (patched.html && patched.appliedCount > 0) {
      extractedHtml = patched.html;
    }
  }

  if (!extractedHtml) {
    extractedHtml = extractPreviewHtmlFromRaw(cleanedRaw);
    if (!extractedHtml && /<!doctype|<html|<body|<section|<main/i.test(cleanedRaw) && !hasPatchDirective) {
      extractedHtml = finalizePartialPreviewHtml(cleanedRaw);
    }
  }

  if (!extractedHtml && hasPatchDirective) {
    // Never fall back to kind:'chat' or wipe out previousHtml when a patch fails to match anchors
    extractedHtml = previousHtml;
    patchFailedCompletely = true;
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
  const validation = patchFailedCompletely
    ? {
        valid: false,
        reason: `Surgical patch anchors did not match existing HTML while updating "${input.message.slice(0, 120)}". Preserve existing styles/screens and apply the requested addition cleanly.`,
      }
    : validateBuiltAppHtml(hardenedHtml);
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

export interface RealtimeAgentStatus {
  role: 'architect' | 'designer' | 'engineer';
  status: 'running' | 'done' | 'failed';
  durationMs?: number;
  provider?: string;
  model?: string;
}

interface StreamServerFreeAiParams {
  requestedModel?: string;
  initialRoute?: 'chat' | 'build' | 'auto';
  /** Set by patch/continue callers — those never fan out to parallel agents. */
  isFastPatch?: boolean;
  systemPrompt: string;
  historyMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  signal?: AbortSignal;
  /** Fresh full builds run 3 agents (architect + designer + engineer) at once. */
  allowParallelAgents?: boolean;
  onModelMeta?: (meta: { modelId: string; modelName: string; provider: string }) => void;
  onReasoningChunk?: (reasoningText: string) => void;
  onContentChunk: (chunkText: string) => void;
  /** Live 3-agent progress: emitted at start and on every agent completion. */
  onAgentsSnapshot?: (agents: RealtimeAgentStatus[]) => void;
  /** Fires when the 3-agent merge produced the final HTML (replaces the stream). */
  onReplaceRawOutput?: (rawOutput: string, previewHtml: string) => void;
}

const MESH_ROLE_DIRECTIVES: Record<RealtimeAgentStatus['role'], string> = {
  architect:
    'MESH_ROLE=architect. You are the lead application architect on a 3-agent build team. Output ONLY the complete single-file HTML application (from <!DOCTYPE html> to </html>) with correct document structure, all screens, the domain data model, and fully wired JavaScript. Prioritize a complete working end-to-end flow over decorative polish.',
  designer:
    'MESH_ROLE=designer. You are the UI/UX design specialist on a 3-agent build team. Output ONLY a complete single-file HTML document whose strength is exceptional visual design: refined CSS design tokens, typography, spacing, visual hierarchy, micro-animations, and responsive layout for every screen.',
  engineer:
    'MESH_ROLE=engineer. You are the front-end reliability engineer on a 3-agent build team. Output ONLY a complete single-file HTML document whose strength is rock-solid interactivity: state management, CRUD handlers, form validation, edge cases, and error-free vanilla JavaScript.',
};

function withMeshRoleDirective(
  systemPrompt: string,
  role: RealtimeAgentStatus['role']
): string {
  return `${systemPrompt}\n\n${MESH_ROLE_DIRECTIVES[role]}`;
}

function extractLongestInlineStyle(html: string): string {
  const match = /<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(html);
  return (match?.[1] || '').trim();
}

function extractMainInlineScript(html: string): string {
  const regex = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  let best = '';
  for (const match of html.matchAll(regex)) {
    const code = (match[1] || '').trim();
    if (code.length > best.length) best = code;
  }
  return best;
}

function collectDomIds(html: string): Set<string> {
  const ids = new Set<string>();
  for (const match of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) {
    ids.add(match[1]);
  }
  return ids;
}

function collectScriptDomRefs(script: string): string[] {
  const refs = new Set<string>();
  for (const match of script.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) {
    refs.add(match[1]);
  }
  for (const match of script.matchAll(/querySelector\(\s*["']#([A-Za-z0-9_-]+)["']\s*\)/g)) {
    refs.add(match[1]);
  }
  return [...refs];
}

function spliceMergedHtmlIntoRaw(raw: string, html: string): string {
  if (
    /<<<\s*AICRAFT_APP_HTML\s*>>>/i.test(raw) &&
    /<<<\s*END_AICRAFT_APP_HTML\s*>>>/i.test(raw)
  ) {
    return raw.replace(
      /(<<<\s*AICRAFT_APP_HTML\s*>>>)[\s\S]*?(<<<\s*END_AICRAFT_APP_HTML\s*>>>)/i,
      (_m, open: string, close: string) => `${open}\n${html}\n${close}`
    );
  }
  const docStart = raw.search(/<!doctype|<html\b/i);
  if (docStart >= 0) return `${raw.slice(0, docStart)}${html}\n`;
  return html;
}

/**
 * Deterministic 3-agent merge: architect HTML is the base; the designer's
 * <style> and the engineer's main <script> are adopted only when safe —
 * CSS is cosmetic, and the script is adopted only if every DOM id it
 * references exists in the architect's document (so no handler breaks).
 */
function mergeParallelAgentHtml(
  baseHtml: string,
  designerHtml: string,
  engineerHtml: string
): { html: string; applied: string[] } {
  let html = baseHtml;
  const applied: string[] = [];

  const designerStyle = designerHtml ? extractLongestInlineStyle(designerHtml) : '';
  if (designerStyle.length >= 120) {
    if (/<style\b[^>]*>[\s\S]*?<\/style>/i.test(html)) {
      const next = html.replace(
        /(<style\b[^>]*>)[\s\S]*?(<\/style>)/i,
        (_m, open: string, close: string) => `${open}\n${designerStyle}\n${close}`
      );
      if (next !== html) {
        html = next;
        applied.push('designer');
      }
    } else if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `<style>\n${designerStyle}\n</style>\n</head>`);
      applied.push('designer');
    }
  }

  const engineerScript = engineerHtml ? extractMainInlineScript(engineerHtml) : '';
  if (engineerScript.length >= 300) {
    const baseIds = collectDomIds(baseHtml);
    const refs = collectScriptDomRefs(engineerScript);
    const safe = refs.every((id) => baseIds.has(id));
    if (safe) {
      const scriptTag = `<script>\n${engineerScript}\n</script>`;
      let bestIdx = -1;
      let bestLen = 0;
      const inlineRegex = /<script(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/gi;
      for (const match of html.matchAll(inlineRegex)) {
        if (match.index !== undefined && match[0].length > bestLen) {
          bestLen = match[0].length;
          bestIdx = match.index;
        }
      }
      if (bestIdx >= 0 && bestLen >= 300) {
        html = `${html.slice(0, bestIdx)}${scriptTag}${html.slice(bestIdx + bestLen)}`;
        applied.push('engineer');
      } else if (/<\/body>/i.test(html)) {
        html = html.replace(/<\/body>/i, `${scriptTag}\n</body>`);
        applied.push('engineer');
      }
    }
  }

  return { html, applied };
}

/**
 * 3-agent parallel build: the architect streams the live preview while the
 * designer and engineer draft concurrently; a safety-checked merge then
 * swaps designer CSS + engineer JS into the architect's document.
 */
async function runParallelBuildAgents(
  params: StreamServerFreeAiParams
): Promise<{ rawOutput: string; modelUsed: string; modelName: string; provider: string }> {
  const agents: RealtimeAgentStatus[] = [
    { role: 'architect', status: 'running' },
    { role: 'designer', status: 'running' },
    { role: 'engineer', status: 'running' },
  ];
  const startedAt = Date.now();
  const emitSnapshot = () => params.onAgentsSnapshot?.(agents.map((a) => ({ ...a })));
  const markAgent = (
    role: RealtimeAgentStatus['role'],
    patch: Partial<RealtimeAgentStatus>
  ) => {
    const agent = agents.find((a) => a.role === role);
    if (!agent) return;
    Object.assign(agent, patch);
    if (patch.status && patch.status !== 'running' && agent.durationMs === undefined) {
      agent.durationMs = Date.now() - startedAt;
    }
    emitSnapshot();
  };
  emitSnapshot();

  const runSideAgent = (role: 'designer' | 'engineer') =>
    completeFreeAiMesh({
      taskKind: 'build',
      systemPrompt: withMeshRoleDirective(params.systemPrompt, role),
      historyMessages: params.historyMessages,
      userPrompt: params.userPrompt,
      attachmentDataUrl: params.attachmentDataUrl ?? null,
      signal: params.signal,
      timeoutMs: 35_000,
    });

  const sideAgent = async (role: 'designer' | 'engineer'): Promise<string | null> => {
    let html = await runSideAgent(role).catch(() => null);
    if (!html && !params.signal?.aborted) {
      // Fault isolation: one busy/failed lane must NOT break the build.
      // Keep the chip "running" and hand the role to another free AI pass.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      html = await runSideAgent(role).catch(() => null);
    }
    markAgent(role, html ? { status: 'done' } : { status: 'failed' });
    return html;
  };

  // Stagger side agents so the architect grabs the single-flight provider
  // slot first — fewer same-IP "previous request still running" collisions
  // on Pollinations Classic while all 3 AIs build at once.
  const designerPromise = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return sideAgent('designer');
  })();
  const engineerPromise = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    return sideAgent('engineer');
  })();

  let architectResult: {
    rawOutput: string;
    modelUsed: string;
    modelName: string;
    provider: string;
  };
  const runArchitectLane = () =>
    streamFreeAiMesh({
      taskKind: 'build',
      systemPrompt: withMeshRoleDirective(params.systemPrompt, 'architect'),
      historyMessages: params.historyMessages,
      userPrompt: params.userPrompt,
      attachmentDataUrl: params.attachmentDataUrl ?? null,
      signal: params.signal,
      onModelMeta: params.onModelMeta,
      onContentChunk: params.onContentChunk,
      onReasoningChunk: params.onReasoningChunk,
    });

  try {
    architectResult = await runArchitectLane();
  } catch (err) {
    if (params.signal?.aborted) {
      await Promise.allSettled([designerPromise, engineerPromise]);
      markAgent('architect', { status: 'failed' });
      throw err;
    }
    // One full architect failover: a busy storm or dead lane must not kill
    // the build on the first strike — another free AI retries the role.
    try {
      architectResult = await runArchitectLane();
    } catch (err2) {
      await Promise.allSettled([designerPromise, engineerPromise]);
      markAgent('architect', { status: 'failed' });
      throw err2;
    }
  }
  markAgent('architect', {
    status: 'done',
    provider: architectResult.provider,
    model: architectResult.modelUsed,
  });

  const [designerHtml, engineerHtml] = await Promise.all([
    designerPromise,
    engineerPromise,
  ]);

  const baseHtml = extractPreviewHtmlFromRaw(architectResult.rawOutput);
  if (baseHtml && (designerHtml || engineerHtml)) {
    const merged = mergeParallelAgentHtml(baseHtml, designerHtml || '', engineerHtml || '');
    if (merged.html !== baseHtml && validateBuiltAppHtml(merged.html).valid) {
      const finalRaw = spliceMergedHtmlIntoRaw(architectResult.rawOutput, merged.html);
      params.onReplaceRawOutput?.(finalRaw, merged.html);
      return { ...architectResult, rawOutput: finalRaw };
    }
  }
  return architectResult;
}

/**
 * The single chat/build engine: ALWAYS the free AI mesh — zero API keys
 * required, daily-quota failover across the whole free-model catalog, and
 * (for fresh full builds) three agents building architecture + UI + logic
 * at the same time. The old Gemini-key path was removed entirely.
 */
export async function streamServerFreeAiRealTime(
  params: StreamServerFreeAiParams
): Promise<{ rawOutput: string; modelUsed: string; modelName: string; provider: string }> {
  const route = params.initialRoute || 'build';
  const taskKind = route === 'chat' ? 'chat' : 'build';

  const runFreeAiMeshLane = () =>
    streamFreeAiMesh({
      taskKind,
      systemPrompt: params.systemPrompt,
      historyMessages: params.historyMessages,
      userPrompt: params.userPrompt,
      attachmentDataUrl: params.attachmentDataUrl ?? null,
      signal: params.signal,
      onModelMeta: params.onModelMeta,
      onContentChunk: params.onContentChunk,
      onReasoningChunk: params.onReasoningChunk,
    });

  const parallelRequested =
    Boolean(params.allowParallelAgents) &&
    taskKind === 'build' &&
    !params.isFastPatch &&
    isMeshParallelBuildsEnabled();

  if (parallelRequested) {
    return runParallelBuildAgents(params);
  }
  return runFreeAiMeshLane();
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
  if (!params.brokenHtml.trim()) return '';

  const repairPrompt = [
    `The built ${params.mode} app HTML for "${params.userMessage.slice(0, 200)}" failed validation: ${params.validationReason}`,
    'Fix ONLY the broken/truncated HTML, CSS, or <script> syntax and ensure the main screen content renders immediately with working buttons and zero empty blank viewports.',
    'Output ONLY the complete corrected <!DOCTYPE html>...</html> inside <<<AICRAFT_APP_HTML>>>...<<<END_AICRAFT_APP_HTML>>>.',
    '```html',
    params.brokenHtml.slice(0, 70000),
    '```',
  ].join('\n');

  const extractAndHarden = (raw: string): string => {
    const extracted = extractPreviewHtmlFromRaw(raw) || finalizePartialPreviewHtml(raw);
    if (!extracted) return '';
    const hardened = sanitizeAndHardenPreviewHtml(extracted);
    return validateBuiltAppHtml(hardened).valid ? hardened : '';
  };

  const repairPromise = (async () => {
    if (hasServerFreeAiKey()) {
      const candidates = await resolveDynamicGeminiExecutionMatrix({ taskKind: 'repair' });
      const clientMap = new Map<string, GoogleGenAI>();
      for (const candidate of candidates.slice(0, 5)) {
        let ai = clientMap.get(candidate.apiKey);
        if (!ai) {
          ai = createGeminiClient(candidate.apiKey);
          clientMap.set(candidate.apiKey, ai);
        }
        try {
          const res = await ai.models.generateContent({
            model: candidate.upstreamModelId,
            contents: [{ role: 'user', parts: [{ text: repairPrompt }] }],
          });
          const raw = (res.text || '').trim();
          const hardened = extractAndHarden(raw);
          if (hardened) return hardened;
        } catch {
          // try next fast repair candidate
        }
      }
    }

    // Free AI mesh fallback (self-hosted / free-tier providers / keyless
    // Pollinations) so repair also works with zero Gemini keys configured.
    if (isFreeAiMeshAvailable()) {
      const meshRaw = await completeFreeAiMesh({
        taskKind: 'build',
        systemPrompt:
          'You are a strict single-file HTML repair engine. Output ONLY the complete corrected document, no commentary.',
        userPrompt: repairPrompt,
        timeoutMs: 10000,
      });
      if (meshRaw) {
        const hardened = extractAndHarden(meshRaw);
        if (hardened) return hardened;
      }
    }
    return '';
  })();

  return Promise.race([
    repairPromise,
    new Promise<string>((resolve) => setTimeout(() => resolve(''), 12000)),
  ]);
}
