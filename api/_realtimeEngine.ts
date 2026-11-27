import {
  applySurgicalPatchesToHtml,
  buildCraftSystemPrompt,
  buildFocusedSearchQuery,
  buildProjectInfraContext,
  classifyInitialRoute,
  deriveServerSessionTitle,
  detectArtifactCompletionStates,
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
  getGeminiBaseUrlOverride,
} from './_aiGateways.js';
import {
  completeFreeAiMesh,
  isFreeAiMeshAvailable,
  isMeshParallelBuildsEnabled,
  streamFreeAiMesh,
  type MeshGroundingMeta,
} from './_freeAiMesh.js';

export function createGeminiClient(apiKey: string): GoogleGenAI {
  const baseUrlOverride = getGeminiBaseUrlOverride();
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      ...(baseUrlOverride ? { baseUrl: baseUrlOverride } : {}),
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export interface VisualHintsSpec {
  dominantColor?: string;
  surfaceTheme?: 'dark' | 'light';
  width?: number;
  height?: number;
}

export interface StreamBuildStep {
  id: string;
  kind?: 'thought' | 'search' | 'read' | 'edit' | 'check';
  label: string;
  detail?: string;
  file?: string;
  files?: Array<{ path: string; status: 'running' | 'complete' }>;
  queries?: string[];
  sources?: Array<{ title: string; url: string }>;
  action?: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  startedAt?: number;
  endedAt?: number;
  durationSec?: number;
}

export interface PrepareRealtimeStageEvent {
  phase: 'understanding' | 'building';
  kind: 'chat' | 'build' | 'media';
  stepKind?: 'thought' | 'search' | 'read';
  stepStatus?: 'running' | 'complete';
  action: string;
  label: string;
  queries?: string[];
  sources?: Array<{ title: string; url: string }>;
}

export function createRealtimeStepTracker(
  onStep: (step: StreamBuildStep) => void
) {
  const steps: StreamBuildStep[] = [];
  let thoughtSeq = 0;
  let activeThoughtId: string | null = null;
  let thoughtText = '';
  let lastThoughtEmitAt = 0;
  let lastEditEmitKey = '';
  let lastEditEmitAt = 0;

  const cloneStep = (s: StreamBuildStep): StreamBuildStep => ({
    ...s,
    files: s.files ? s.files.map((f) => ({ ...f })) : undefined,
    queries: s.queries ? [...s.queries] : undefined,
    sources: s.sources ? s.sources.map((src) => ({ ...src })) : undefined,
  });

  const upsertStep = (next: StreamBuildStep) => {
    const idx = steps.findIndex((s) => s.id === next.id);
    if (idx === -1) {
      steps.push(cloneStep(next));
    } else {
      steps[idx] = cloneStep({ ...steps[idx], ...next });
    }
    onStep(cloneStep(steps[idx === -1 ? steps.length - 1 : idx]));
  };

  const handleStage = (stage: PrepareRealtimeStageEvent) => {
    if (!stage.stepKind) return;
    const now = Date.now();
    const id = stage.stepKind === 'read' ? 'step-read' : 'step-search-pre';
    const existing = steps.find((s) => s.id === id);
    const startedAt = existing?.startedAt ?? now;
    const isComplete = stage.stepStatus === 'complete';
    const endedAt = isComplete ? now : undefined;
    const durationSec =
      isComplete && endedAt
        ? Math.max(1, Math.round((endedAt - startedAt) / 1000))
        : undefined;
    upsertStep({
      id,
      kind: stage.stepKind,
      action: stage.action,
      label: stage.label,
      queries: stage.queries,
      sources: stage.sources,
      status: isComplete ? 'complete' : 'running',
      startedAt,
      endedAt,
      durationSec,
    });
  };

  const pushReasoning = (chunkText: string) => {
    const chunk = chunkText || '';
    if (!chunk) return;
    const now = Date.now();
    if (!activeThoughtId) {
      thoughtSeq += 1;
      activeThoughtId = `step-thought-${thoughtSeq}`;
      thoughtText = '';
      lastThoughtEmitAt = 0;
    }
    thoughtText = `${thoughtText}${chunk}`.slice(-1800);
    if (now - lastThoughtEmitAt < 350 && steps.some((s) => s.id === activeThoughtId)) {
      return;
    }
    lastThoughtEmitAt = now;
    const existing = steps.find((s) => s.id === activeThoughtId);
    const headingMatches = Array.from(thoughtText.matchAll(/\*\*([^*\n]{4,72})\*\*/g));
    const latestHeading =
      headingMatches[headingMatches.length - 1]?.[1]?.trim() || 'Thinking...';
    upsertStep({
      id: activeThoughtId,
      kind: 'thought',
      action: 'Thinking',
      label: latestHeading,
      detail: thoughtText.trim(),
      status: 'running',
      startedAt: existing?.startedAt ?? now,
    });
  };

  const completeActiveThought = () => {
    if (!activeThoughtId) return;
    const existing = steps.find((s) => s.id === activeThoughtId);
    if (existing) {
      const now = Date.now();
      const startedAt = existing.startedAt ?? now;
      const durationSec = Math.max(1, Math.round((now - startedAt) / 1000));
      upsertStep({
        ...existing,
        action: 'Thought',
        label: `Thought for ${durationSec}s`,
        detail: thoughtText.trim() || existing.detail,
        status: 'complete',
        endedAt: now,
        durationSec,
      });
    }
    activeThoughtId = null;
    thoughtText = '';
  };

  const pushGrounding = (meta: MeshGroundingMeta) => {
    const queries = (meta.queries || []).filter(Boolean);
    const sources = (meta.sources || []).filter((s) => s.url);
    if (queries.length === 0 && sources.length === 0) return;
    const now = Date.now();
    const existing = steps.find((s) => s.id === 'step-search-grounding');
    const mergedQueries = Array.from(
      new Set([...(existing?.queries || []), ...queries])
    ).slice(0, 6);
    const mergedSources = Array.from(
      new Map(
        [...(existing?.sources || []), ...sources].map((src) => [src.url, src])
      ).values()
    ).slice(0, 8);
    upsertStep({
      id: 'step-search-grounding',
      kind: 'search',
      action: 'Searched web',
      label: mergedQueries[0]
        ? `Searched web: ${mergedQueries[0]}`
        : 'Searched web',
      queries: mergedQueries,
      sources: mergedSources,
      status: 'complete',
      startedAt: existing?.startedAt ?? now,
      endedAt: now,
      durationSec: 1,
    });
  };

  const pushCodeProgress = (htmlSoFar: string, isPatch: boolean) => {
    completeActiveThought();
    const now = Date.now();
    const states = isPatch
      ? [{ path: 'index.html', action: 'Editing', status: 'running' as const }]
      : detectArtifactCompletionStates(htmlSoFar);
    if (states.length === 0) return;
    const activeItem =
      [...states].reverse().find((s) => s.status === 'running') ||
      states[states.length - 1];
    const editKey = states.map((s) => `${s.path}:${s.status}`).join('|');
    if (editKey === lastEditEmitKey && now - lastEditEmitAt < 500) {
      return;
    }
    lastEditEmitKey = editKey;
    lastEditEmitAt = now;
    const existing = steps.find((s) => s.id === 'step-edit-files');
    upsertStep({
      id: 'step-edit-files',
      kind: 'edit',
      action: isPatch ? 'Editing file' : 'Editing files',
      label: activeItem ? `Editing ${activeItem.path}` : 'Editing files',
      file: activeItem?.path || 'index.html',
      files: states.map((s) => ({ path: s.path, status: s.status })),
      status: 'running',
      startedAt: existing?.startedAt ?? now,
    });
  };

  const startCheck = (label = 'Checking files & live preview') => {
    completeActiveThought();
    const now = Date.now();
    const existing = steps.find((s) => s.id === 'step-check');
    upsertStep({
      id: 'step-check',
      kind: 'check',
      action: 'Checking',
      label,
      status: 'running',
      startedAt: existing?.startedAt ?? now,
    });
  };

  const finishSteps = (finalFiles: string[]): StreamBuildStep[] => {
    completeActiveThought();
    const now = Date.now();

    const preRead = steps.find((s) => s.id === 'step-read');
    if (preRead && preRead.status !== 'complete') {
      upsertStep({
        ...preRead,
        status: 'complete',
        endedAt: now,
        durationSec: Math.max(1, Math.round((now - (preRead.startedAt ?? now)) / 1000)),
      });
    }

    const preSearch = steps.find((s) => s.id === 'step-search-pre');
    if (preSearch && preSearch.status !== 'complete') {
      upsertStep({
        ...preSearch,
        status: 'complete',
        endedAt: now,
        durationSec: Math.max(1, Math.round((now - (preSearch.startedAt ?? now)) / 1000)),
      });
    }

    const editStep = steps.find((s) => s.id === 'step-edit-files');
    if (editStep || finalFiles.length > 0) {
      const mergedPaths = Array.from(
        new Set([
          ...(editStep?.files?.map((f) => f.path) || []),
          ...finalFiles,
        ])
      );
      const startedAt = editStep?.startedAt ?? now;
      upsertStep({
        id: 'step-edit-files',
        kind: 'edit',
        action: 'Edited files',
        label: mergedPaths.length > 1 ? 'Edited files' : `Edited ${mergedPaths[0] || 'index.html'}`,
        file: mergedPaths[0] || 'index.html',
        files: mergedPaths.map((p) => ({ path: p, status: 'complete' as const })),
        status: 'complete',
        startedAt,
        endedAt: now,
        durationSec: Math.max(1, Math.round((now - startedAt) / 1000)),
      });
    }

    const checkStep = steps.find((s) => s.id === 'step-check');
    if (checkStep) {
      const startedAt = checkStep.startedAt ?? now;
      upsertStep({
        ...checkStep,
        action: 'Checked',
        label: 'Verified live preview & database',
        status: 'complete',
        endedAt: now,
        durationSec: Math.max(1, Math.round((now - startedAt) / 1000)),
      });
    }

    return steps.map(cloneStep);
  };

  return {
    handleStage,
    pushReasoning,
    completeActiveThought,
    pushGrounding,
    pushCodeProgress,
    startCheck,
    finishSteps,
    getSteps: () => steps.map(cloneStep),
  };
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
  testMode?: boolean;
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
  hasPreviousHtml?: boolean;
  isPatchMode?: boolean;
  isGameBuild?: boolean;
  testMode?: boolean;
  didRunWebSearch?: boolean;
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
  message: string,
  hasPreviousHtml: boolean,
  hasAttachment = false
): 'image' | 'music' | 'video' | null {
  const msg = String(message || '').trim();
  if (!msg) return null;

  // Never generate standalone images inside an active app/preview session — keep evolving the app in real time.
  if (hasPreviousHtml) {
    return null;
  }

  // Never intercept requests to build or modify an app, website, preview, UI, database, or game.
  if (
    /\b(?:preview|app|application|website|web\s*app|site|dashboard|game|platform|store|shop|portal|screen|page|feed|layout|card|component|database|schema|ui|ux|test\s*mode|gallery\s+app|photo\s+editor\s+app)\b/i.test(
      msg
    )
  ) {
    return null;
  }

  // Informational questions about capabilities belong in chat, not image generation.
  if (
    /^(?:can|do|does|how|why|what|is|are|will)\b.*\b(?:image|picture|photo|generate|create)\b\??$/i.test(
      msg
    ) &&
    !/^(?:can you\s+)?(?:create|generate|draw|make|paint|render|edit)\s+(?:an?\s+|me\s+an?\s+|this\s+)?(?:image|picture|photo|artwork|illustration|wallpaper|portrait|logo)\b/i.test(
      msg
    )
  ) {
    return null;
  }

  // Direct standalone text-to-image requests only.
  if (
    /\b(?:generate|create|make|draw|paint|render|sketch|illustrate|design|produce)\s+(?:an?\s+|me\s+an?\s+|the\s+)?(?:ultra[- ]?(?:realistic|hd)|realistic|4k|2k|high[- ]?(?:quality|res)|cinematic|anime|3d|cartoon|digital|minimalist|futuristic|neon|cyberpunk|cute|fantasy|studio)?\s*(?:image|picture|photo|photograph|artwork|illustration|wallpaper|portrait|poster|cover\s*art|icon|emblem|banner)\b/i.test(
      msg
    )
  ) {
    return 'image';
  }

  // Image-to-image / editing requests when user attached an image outside app building.
  if (
    hasAttachment &&
    /\b(?:edit|transform|turn|convert|recreate|reimagine|restyle|enhance|upscale|change|replace|remove|add|put|place|make|generate|create|bring\s+out|render)\b.*\b(?:image|picture|photo|background|style|look\s+like|into|exactly\s+like)\b/i.test(
      msg
    )
  ) {
    return 'image';
  }

  return null;
}

/**
 * Backend UI/UX Design Architect pass powered by Gemini.
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
  if (!isFreeAiMeshAvailable()) return '';

  const hintsText =
    params.visualHints?.dominantColor || params.visualHints?.surfaceTheme
      ? `Screenshot cues: dominant=${params.visualHints.dominantColor || 'auto'}, surface=${params.visualHints.surfaceTheme || 'auto'}, size=${params.visualHints.width || '?'}x${params.visualHints.height || '?'}.`
      : '';

  const userPrompt = [
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
    .join('\n');

  const timeoutPromise = new Promise<string>((resolve) => {
    setTimeout(() => resolve(''), 4200);
  });

  const generatePromise = (async () => {
    const meshText = await completeFreeAiMesh({
      taskKind: 'chat',
      systemPrompt:
        'You are the internal UI/UX Design Architect inside AI Craft. Produce a crisp, practical visual design blueprint (colors, layout hierarchy, components, multi-screen structure) with zero HTML or code fences.',
      userPrompt,
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

  const hasAttachment = Boolean(
    input.attachmentDataUrl && input.attachmentDataUrl.startsWith('data:image/')
  );
  const mediaKind = executionPlan.requestedMediaKind;
  const testMode = Boolean(input.testMode);
  const naturalMediaIntent =
    mediaKind ??
    (input.forceChat || testMode
      ? null
      : detectNaturalMediaRequest(message, hasPreviousHtml, hasAttachment));

  const previewSummary = extractPreviewStructureSummary(previousHtml);
  const existingIsVue = /\b(?:createApp|defineComponent)\b|vue\.global\.prod\.js/i.test(
    previousHtml
  );
  const wantsRestructure =
    /\b(redesign|restructure|reorganiz(?:e|ing)|refactor|overhaul|rearchitect|rework|convert\s+to|switch\s+(?:to|layout|nav)|change\s+(?:the\s+)?(?:entire\s+|whole\s+|full\s+|app\s+)?(?:layout|structure|architecture|navigation|nav\s*bar|tabs?)|make\s+it\s+(?:look\s+like\s+)?(?:a\s+)?(?:real|standard|proper)\s+mobile|restyle\s*(?:all|everything|the\s*whole|entire)|rebuild(?:\s+from\s*scratch)?|start\s*over|completely\s*new)\b/i.test(
      message
    ) ||
    (input.mode === 'mobile' &&
      hasPreviousHtml &&
      !existingIsVue &&
      /\b(vue|ionic|capacitor|mobile\s*(?:app|layout|ui|navigation|tabs)|standard\s*mobile|bottom\s*tabs?|stack\s*navigation)\b/i.test(
        message
      ));

  const initialRoute: 'chat' | 'build' | 'auto' = input.forceChat
    ? 'chat'
    : /\[\[\s*CONTINUE_BUILD\s*\]\]/i.test(message) || wantsRestructure
      ? 'build'
      : classifyInitialRoute(message, previousHtml, input.attachmentName, hasAttachment);

  const isGameBuild = initialRoute === 'build' && isGameBuildPrompt(message);
  const focusedSearchQuery = buildFocusedSearchQuery(message);
  const skipBuildSearch =
    initialRoute === 'build' &&
    shouldSkipSlowWebSearchForBuild(message, Boolean(input.attachmentDataUrl));
  const wantsSearch =
    input.webSearchEnabled !== false &&
    !skipBuildSearch &&
    (initialRoute === 'build' || shouldRunChatSearch(message, hasPreviousHtml));

  const isPatchMode =
    hasPreviousHtml &&
    initialRoute !== 'chat' &&
    !wantsRestructure &&
    !/\[\[\s*CONTINUE_BUILD\s*\]\]/i.test(message);

  // Only invoke the extra visual architect pre-pass when an image screenshot is attached.
  const shouldRunDesignEngine =
    !input.forceChat &&
    !naturalMediaIntent &&
    isFreeAiMeshAvailable() &&
    Boolean(input.attachmentDataUrl);

  if (hasPreviousHtml && initialRoute !== 'chat') {
    input.onStage?.({
      phase: 'understanding',
      kind: 'build',
      stepKind: 'read',
      stepStatus: 'running',
      action: 'Reading',
      label: 'Reading project files (index.html)',
    });
  }

  if (wantsSearch) {
    input.onStage?.({
      phase: 'understanding',
      kind: initialRoute === 'build' ? 'build' : 'chat',
      stepKind: 'search',
      stepStatus: 'running',
      action: 'Searching',
      label: `Searching web: ${focusedSearchQuery}`,
      queries: [focusedSearchQuery],
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

  if (hasPreviousHtml && initialRoute !== 'chat') {
    input.onStage?.({
      phase: 'understanding',
      kind: 'build',
      stepKind: 'read',
      stepStatus: 'complete',
      action: 'Read',
      label: 'Read project files (index.html)',
    });
  }

  if (wantsSearch) {
    const searchSources = (searchData.results || [])
      .filter((r) => typeof r?.url === 'string' && r.url.startsWith('http'))
      .slice(0, 6)
      .map((r) => ({ title: r.title || r.url, url: r.url }));
    input.onStage?.({
      phase: 'understanding',
      kind: initialRoute === 'build' ? 'build' : 'chat',
      stepKind: 'search',
      stepStatus: 'complete',
      action: 'Searched',
      label: `Searched web: ${focusedSearchQuery}`,
      queries: [focusedSearchQuery],
      sources: searchSources,
    });
  }

  const effectiveMemoryContext = resolvedMem.brainContext || input.projectMemoryContext || '';
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
    testMode,
  });

  const activeFlags: string[] = [];
  if (testMode) activeFlags.push('Test Mode ON (isolated __test server database)');
  if (input.reactEnabled) activeFlags.push('Rich interactive SPA views');
  if (input.backendEnabled) activeFlags.push('Persistent real-time database (`window.AICraft.db`)');
  if (input.webSearchEnabled !== false && !skipBuildSearch) {
    activeFlags.push('Live browser search & real photography');
  }

  const systemPrompt = buildCraftSystemPrompt({
    mediaKind,
    requestedModel: input.requestedModel || 'gemini::gemini-4-hydrogen',
    requestedModelLabel: !input.requestedModel
      ? 'Gemini 4 Hydrogen'
      : executionPlan.requestedModelLabel,
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
    hasPreviousHtml,
    testMode,
  });

  const historyMessages: Array<{ role: 'user' | 'assistant'; content: string }> = history
    .slice(-14)
    .filter((h) => typeof h?.text === 'string' && h.text.trim().length > 0)
    .map((h) => ({
      role: h.role === 'assistant' || h.role === 'model' ? 'assistant' : 'user',
      content: h.text.trim().slice(0, 2800),
    }));

  const userBlocks: string[] = [];

  if (hasPreviousHtml && initialRoute !== 'chat') {
    const isContinueResume = /\[\[\s*CONTINUE_BUILD\s*\]\]/i.test(message);
    const cleanedPreviousForPrompt = previousHtml
      .replace(/<style\b[^>]*data-aicraft-safety[^>]*>[\s\S]*?<\/style>\s*/gi, '')
      .replace(/<script\b[^>]*data-aicraft-safety-js[^>]*>[\s\S]*?<\/script>\s*/gi, '');
    const fileManifest = extractLiveBuildArtifacts(cleanedPreviousForPrompt)
      .map((a) => `- ${a.path}`)
      .join('\n');
    const trimmedExisting =
      cleanedPreviousForPrompt.length > 120000
        ? `${cleanedPreviousForPrompt.slice(0, 62000)}\n<!-- ... middle truncated (${cleanedPreviousForPrompt.length} total chars) ... -->\n${cleanedPreviousForPrompt.slice(-55000)}`
        : cleanedPreviousForPrompt;
    const continuationDirective = isContinueResume
      ? `RESUMING STOPPED/PAUSED BUILD WITH ${executionPlan.requestedModelLabel}: Continue building cleanly from CURRENT_PROJECT_FILES below! Preserve EVERY existing screen, Vue component, style, handler, and database table already written, finish any unfinished screens/scripts, and output the complete finished app inside <<<AICRAFT_APP_HTML>>>...<<<END_AICRAFT_APP_HTML>>>.`
      : wantsRestructure
        ? `CURRENT_PROJECT_FILES — STRUCTURAL UPDATE & ARCHITECTURE MODE (Active Builder: ${executionPlan.requestedModelLabel}):
MANDATORY ARCHITECT RULES:
1. Never just chat or repeat unchanged boilerplate when files already exist.
2. Inspect CURRENT_PROJECT_FILES below carefully and apply REAL structural changes (mobile Vue components, layout architecture, navigation tabs/stack, logic, and state) directly to the actual code.
3. Preserve domain data tables (\`window.AICraft.db\`) and working features that still fit the restructured design, and output the complete restructured application inside \`<<<AICRAFT_APP_HTML>>>...<<<END_AICRAFT_APP_HTML>>>\`.`
        : `CURRENT_PROJECT_FILES — TARGETED UPDATE MODE (Active Builder: ${executionPlan.requestedModelLabel}):
MANDATORY EDIT RULES:
1. Inspect CURRENT_PROJECT_FILES below carefully — NEVER just chat or repeat unchanged boilerplate.
2. Apply real code modifications matching the user's request (modifying templates, components, layout, logic, or state directly). If asked to remove/delete a section or control, cleanly remove it from HTML/CSS/JS.
3. For localized updates, use \`<<<AICRAFT_PATCH>>>...<<<END_PATCH>>>\` with exact \`<<<SEARCH>>>...<<<REPLACE>>>...\` anchors copied verbatim from \`index.html\` below, \`<<<APPEND_CSS>>>\`, \`<<<APPEND_SCREEN>>>\`, and/or \`<<<APPEND_SCRIPT>>>\`. If the requested change restructures components or navigation across sections, output the full updated app inside \`<<<AICRAFT_APP_HTML>>>...<<<END_AICRAFT_APP_HTML>>>\`.`;

    userBlocks.push(
      `${continuationDirective}\n\nCURRENT_PROJECT_FILES:\n${fileManifest || '- index.html'}\n\n=== FILE: index.html ===\n\`\`\`html\n${trimmedExisting}\n\`\`\``
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
    hasPreviousHtml,
    isPatchMode,
    isGameBuild,
    testMode,
    didRunWebSearch: wantsSearch,
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
  patchFailedCompletely?: boolean;
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
  const modelName = input.modelName || 'Gemini 4 Hydrogen';
  const provider = input.provider || 'gemini';

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

  const previousHtml = typeof input.previousHtml === 'string' ? input.previousHtml : '';
  const hasPreviousApp = previousHtml.trim().length > 150;

  if (!hasPreviousApp && /\[\[\s*MODE\s*:\s*GENERATE\s*\]\]/i.test(cleanedRaw)) {
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
        reason: `Surgical patch anchors did not match existing HTML while updating "${input.message.slice(0, 120)}". Apply the requested edit/removal directly to the existing app cleanly.`,
      }
    : validateBuiltAppHtml(hardenedHtml);
  const files = extractLiveBuildArtifacts(hardenedHtml).map((a) => a.path);
  const dbTables = mergeParsedDbTables(
    extractDbSchemaFromRaw(cleanedRaw),
    extractDbSchemaFromHtml(hardenedHtml)
  );
  const suggestions = extractSuggestionsFromRaw(cleanedRaw);

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
    patchFailedCompletely,
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
  /** Enable Gemini native Google Search grounding tool on live generation. */
  enableWebSearch?: boolean;
  systemPrompt: string;
  historyMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  signal?: AbortSignal;
  /** Fresh full builds run 3 agents (architect + designer + engineer) at once. */
  allowParallelAgents?: boolean;
  onModelMeta?: (meta: { modelId: string; modelName: string; provider: string }) => void;
  onReasoningChunk?: (reasoningText: string) => void;
  onGrounding?: (meta: MeshGroundingMeta) => void;
  onContentChunk: (chunkText: string) => void;
  /** Live 3-agent progress: emitted at start and on every agent completion. */
  onAgentsSnapshot?: (agents: RealtimeAgentStatus[]) => void;
  /** Fires when the 3-agent merge produced the final HTML (replaces the stream). */
  onReplaceRawOutput?: (rawOutput: string, previewHtml: string) => void;
}

const MESH_ROLE_DIRECTIVES: Record<RealtimeAgentStatus['role'], string> = {
  architect:
    'MESH_ROLE=architect. You are the lead application architect on a 3-agent build team. First output concise [[PLAN: ...]] architectural steps, then output the complete single-file HTML application inside <<<AICRAFT_APP_HTML>>>...<<<END_AICRAFT_APP_HTML>>> with clean modular Vue 3 / mobile-first architecture (when building a mobile app), all screens, domain data model, and fully wired interactive state.',
  designer:
    'MESH_ROLE=designer. You are the UI/UX design specialist on a 3-agent build team. Output a complete single-file HTML document whose strength is refined CSS design tokens, mobile safe areas, touch-friendly spacing (>=44px), typography, visual hierarchy, and smooth transitions.',
  engineer:
    'MESH_ROLE=engineer. You are the front-end reliability engineer on a 3-agent build team. Output a complete single-file HTML document whose strength is rock-solid Vue 3 / JavaScript interactivity: state management, navigation stack, CRUD handlers synced with window.AICraft.db, form validation, and error-free execution.',
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

function collectTemplateIds(html: string): string[] {
  const ids: string[] = [];
  for (const m of html.matchAll(
    /<(?:template|script\b[^>]*type=["']text\/x-template["'])\b[^>]*\bid=["']([^"']+)["']/gi
  )) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

/**
 * Deterministic 3-agent merge: architect HTML is the base; the designer's
 * <style> and the engineer's main <script> are adopted only when structurally safe —
 * never overwriting Vue component templates or mismatched class/DOM structures.
 */
function mergeParallelAgentHtml(
  baseHtml: string,
  designerHtml: string,
  engineerHtml: string
): { html: string; applied: string[] } {
  let html = baseHtml;
  const applied: string[] = [];
  const baseIsVue = /\b(?:createApp|defineComponent)\b|vue\.global\.prod\.js/i.test(
    baseHtml
  );

  const designerStyle = designerHtml ? extractLongestInlineStyle(designerHtml) : '';
  if (designerStyle.length >= 120 && !baseIsVue) {
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
    const engineerIsVue = /\b(?:createApp|defineComponent)\b/i.test(engineerScript);
    const baseTemplateIds = collectTemplateIds(baseHtml);
    const engineerUsesAllTemplates = baseTemplateIds.every((tplId) =>
      engineerScript.includes(tplId)
    );
    const baseIds = collectDomIds(baseHtml);
    const refs = collectScriptDomRefs(engineerScript);
    const safe =
      refs.every((id) => baseIds.has(id)) &&
      (!baseIsVue || (engineerIsVue && engineerUsesAllTemplates));
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
      requestedModel: params.requestedModel,
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
      requestedModel: params.requestedModel,
      systemPrompt: withMeshRoleDirective(params.systemPrompt, 'architect'),
      historyMessages: params.historyMessages,
      userPrompt: params.userPrompt,
      attachmentDataUrl: params.attachmentDataUrl ?? null,
      enableWebSearch: Boolean(params.enableWebSearch),
      signal: params.signal,
      onModelMeta: params.onModelMeta,
      onContentChunk: params.onContentChunk,
      onReasoningChunk: params.onReasoningChunk,
      onGrounding: params.onGrounding,
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
 * The single chat/build engine powered by the Gemini API mesh.
 */
export async function streamServerFreeAiRealTime(
  params: StreamServerFreeAiParams
): Promise<{ rawOutput: string; modelUsed: string; modelName: string; provider: string }> {
  const route = params.initialRoute || 'build';
  const taskKind = route === 'chat' ? 'chat' : 'build';

  const runFreeAiMeshLane = () =>
    streamFreeAiMesh({
      taskKind,
      requestedModel: params.requestedModel,
      systemPrompt: params.systemPrompt,
      historyMessages: params.historyMessages,
      userPrompt: params.userPrompt,
      attachmentDataUrl: params.attachmentDataUrl ?? null,
      enableWebSearch: Boolean(params.enableWebSearch),
      signal: params.signal,
      onModelMeta: params.onModelMeta,
      onContentChunk: params.onContentChunk,
      onReasoningChunk: params.onReasoningChunk,
      onGrounding: params.onGrounding,
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
 * Fast single-pass repair if initial HTML failed script syntax or completeness validation,
 * OR fallback full-document edit when a surgical patch missed anchors.
 */
export async function repairIncompleteBuildHtml(params: {
  brokenHtml: string;
  validationReason: string;
  userMessage: string;
  mode: 'mobile' | 'web';
  isPatchFallback?: boolean;
}): Promise<string> {
  if (!params.brokenHtml.trim()) return '';

  const repairPrompt = params.isPatchFallback
    ? [
        `Apply this exact user request directly to the existing ${params.mode} app HTML: "${params.userMessage}"`,
        'Preserve working features, database tables (`window.AICraft.db`), and unrelated styles, while directly applying all requested additions, updates, or removals.',
        'Output ONLY the complete updated <!DOCTYPE html>...</html> inside <<<AICRAFT_APP_HTML>>>...<<<END_AICRAFT_APP_HTML>>>.',
        '```html',
        params.brokenHtml.slice(0, 70000),
        '```',
      ].join('\n')
    : [
        `The built ${params.mode} app HTML for "${params.userMessage.slice(0, 200)}" failed validation: ${params.validationReason}`,
        'Fix ONLY the broken/truncated HTML, CSS, Vue <template>/defineComponent wiring, or <script> syntax and ensure the main screen content renders immediately with working buttons and zero empty blank viewports (use <script src="/vendor/vue.global.prod.js"></script> if Vue is used).',
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
    if (isFreeAiMeshAvailable()) {
      const meshRaw = await completeFreeAiMesh({
        taskKind: 'build',
        systemPrompt: params.isPatchFallback
          ? 'You are a precise single-file HTML application editor. Apply the user request cleanly to the provided HTML and output ONLY the complete updated document inside <<<AICRAFT_APP_HTML>>>...<<<END_AICRAFT_APP_HTML>>>.'
          : 'You are a strict single-file HTML repair engine. Output ONLY the complete corrected document, no commentary.',
        userPrompt: repairPrompt,
        timeoutMs: params.isPatchFallback ? 14000 : 10000,
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
    new Promise<string>((resolve) =>
      setTimeout(() => resolve(''), params.isPatchFallback ? 15000 : 12000)
    ),
  ]);
}
