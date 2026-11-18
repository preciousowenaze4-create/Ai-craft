import {
  cleanEnvKey,
  type FreeModelCategory,
  type KeylessGatewayStatus,
  type NormalizedOpenRouterModel,
} from './_openrouterModels.js';

export type AiGatewayId =
  | 'auto'
  | 'gemini'
  | 'groq'
  | 'openrouter'
  | 'puter'
  | 'pollinations'
  | 'browser'
  | 'web-search';

export interface UnifiedAiModel extends NormalizedOpenRouterModel {
  gateway: AiGatewayId;
  upstreamModelId: string;
  tierLabel?: string;
}

export interface GatewayStatusSummary {
  id: AiGatewayId;
  label: string;
  baseUrl: string;
  configured: boolean;
  keyCount: number;
  modelCount: number;
  defaultModel: string;
  keyStatus?: KeylessGatewayStatus;
}

export interface GatewayExecutionCandidate {
  gateway: AiGatewayId;
  gatewayLabel: string;
  baseUrl: string;
  apiKey: string;
  publicModelId: string;
  upstreamModelId: string;
  modelName: string;
  provider: string;
  cooldownKey: string;
}

export const SERVER_GEMINI_MODEL_ID = 'gemini::gemini-4-hydrogen';
export const SERVER_GROQ_MODEL_ID = 'groq::llama-3.3-70b-versatile';
export const SERVER_OPENROUTER_MODEL_ID = 'openrouter::qwen/qwen3-coder:free';
export const DEFAULT_BUILDER_MODEL_ID = 'puter::gemini-2.5-flash';
export const SECONDARY_BUILDER_MODEL_ID = 'puter::claude-sonnet-4-6';
export const PUTER_BROWSER_SCRIPT_URL = 'https://js.puter.com/v2/';

export function getServerFreeAiKeys(): {
  geminiKey: string;
  groqKey: string;
  openrouterKey: string;
} {
  return {
    geminiKey: (process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY || '').trim(),
    groqKey: (process.env.GROQ_API_KEY || '').trim(),
    openrouterKey: (process.env.OPENROUTER_API_KEY || '').trim(),
  };
}

export function hasServerFreeAiKey(): boolean {
  const keys = getServerFreeAiKeys();
  return Boolean(keys.geminiKey || keys.groqKey || keys.openrouterKey);
}

/**
 * Only two verified, full-context Vision + Real-Time Coding builders at a time:
 * - When a free server-side key (GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY) is present,
 *   requests stream server-side with ZERO user sign-in and ZERO third-party subscription popups.
 * - Otherwise, falls back to Puter's lightweight Gemini 2.5 Flash first, plus Claude Sonnet 4.6.
 */
export const PUTER_BROWSER_MODELS: UnifiedAiModel[] = [
  {
    id: 'puter::gemini-2.5-flash',
    upstreamModelId: 'gemini-2.5-flash',
    gateway: 'puter',
    name: 'Gemini 2.5 Flash (Vision · Fast)',
    provider: 'google',
    contextLength: 1048576,
    isFree: true,
    tierLabel: 'Free · Fast',
    capabilities: ['Vision', 'Screenshots', 'Code', 'Fast'],
    category: 'code',
  },
  {
    id: 'puter::claude-sonnet-4-6',
    upstreamModelId: 'claude-sonnet-4-6',
    gateway: 'puter',
    name: 'Claude Sonnet 4.6 (Vision · Builder)',
    provider: 'anthropic',
    contextLength: 1000000,
    isFree: true,
    tierLabel: 'Free · Pro',
    capabilities: ['Vision', 'Screenshots', 'Code', 'DB'],
    category: 'code',
  },
];

const GROQ_PREFERRED_MODELS = [
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'qwen/qwen3-32b',
  'llama-3.1-8b-instant',
];

let cachedGroqModelCheck: {
  keyHash: string;
  checkedAt: number;
  usable: boolean;
  bestModelId: string;
  visionModelId: string;
} | null = null;

export async function resolveUsableGroqModels(
  forceRefresh = false
): Promise<{ usable: boolean; bestModelId: string; visionModelId: string }> {
  const groqKey = getServerFreeAiKeys().groqKey;
  if (!groqKey) {
    return { usable: false, bestModelId: '', visionModelId: '' };
  }
  const keyHash = `${groqKey.slice(0, 6)}:${groqKey.slice(-4)}`;
  if (
    !forceRefresh &&
    cachedGroqModelCheck &&
    cachedGroqModelCheck.keyHash === keyHash &&
    Date.now() - cachedGroqModelCheck.checkedAt < 10 * 60_000
  ) {
    return {
      usable: cachedGroqModelCheck.usable,
      bestModelId: cachedGroqModelCheck.bestModelId,
      visionModelId: cachedGroqModelCheck.visionModelId,
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const resp = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${groqKey}` },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      cachedGroqModelCheck = {
        keyHash,
        checkedAt: Date.now(),
        usable: false,
        bestModelId: '',
        visionModelId: '',
      };
      return { usable: false, bestModelId: '', visionModelId: '' };
    }

    const json = (await resp.json()) as {
      data?: Array<{ id?: string; active?: boolean }>;
    };
    const allIds = (Array.isArray(json.data) ? json.data : [])
      .filter((m) => m && typeof m.id === 'string' && m.active !== false)
      .map((m) => String(m.id))
      .filter(
        (id) =>
          !/whisper|playai|tts|guard|prompt-guard|distil-whisper|safeguard/i.test(id)
      );

    if (allIds.length === 0) {
      cachedGroqModelCheck = {
        keyHash,
        checkedAt: Date.now(),
        usable: false,
        bestModelId: '',
        visionModelId: '',
      };
      return { usable: false, bestModelId: '', visionModelId: '' };
    }

    const bestModelId =
      GROQ_PREFERRED_MODELS.find((pref) => allIds.includes(pref)) || allIds[0];
    const visionModelId =
      allIds.find((id) => /llama-4|vision/i.test(id)) || '';

    cachedGroqModelCheck = {
      keyHash,
      checkedAt: Date.now(),
      usable: true,
      bestModelId,
      visionModelId,
    };
    return { usable: true, bestModelId, visionModelId };
  } catch {
    return {
      usable: false,
      bestModelId: '',
      visionModelId: '',
    };
  }
}

export function getActiveTwoBuilderModels(options?: {
  groqModelId?: string;
  groqUsable?: boolean;
}): UnifiedAiModel[] {
  const { geminiKey, groqKey, openrouterKey } = getServerFreeAiKeys();
  const list: UnifiedAiModel[] = [];

  if (geminiKey) {
    list.push({
      id: SERVER_GEMINI_MODEL_ID,
      upstreamModelId: 'gemini-4-hydrogen',
      gateway: 'gemini',
      name: 'Gemini Flash (Vision · Free Server)',
      provider: 'google',
      contextLength: 1048576,
      isFree: true,
      tierLabel: 'Free · No Login',
      capabilities: ['Vision', 'Screenshots', 'Code', 'DB'],
      category: 'code',
    });
  }

  const useGroq = Boolean(
    groqKey && (options ? options.groqUsable !== false && options.groqModelId : false)
  );
  if (useGroq && options?.groqModelId) {
    const isVision = /llama-4|vision/i.test(options.groqModelId);
    list.push({
      id: `groq::${options.groqModelId}`,
      upstreamModelId: options.groqModelId,
      gateway: 'groq',
      name: isVision
        ? 'Llama 4 Vision (Fast · Free Server)'
        : `${options.groqModelId.split('/').pop()} (Free Server)`,
      provider: 'groq',
      contextLength: 131072,
      isFree: true,
      tierLabel: 'Free · Instant',
      capabilities: isVision
        ? ['Vision', 'Screenshots', 'Code', 'DB']
        : ['Code', 'DB', 'Fast'],
      category: 'code',
    });
  } else if (openrouterKey) {
    list.push({
      id: SERVER_OPENROUTER_MODEL_ID,
      upstreamModelId: 'qwen/qwen3-coder:free',
      gateway: 'openrouter',
      name: 'Qwen3 Coder (Free Server)',
      provider: 'openrouter',
      contextLength: 262144,
      isFree: true,
      tierLabel: 'Free · Server',
      capabilities: ['Code', 'DB'],
      category: 'code',
    });
  }

  for (const puterModel of PUTER_BROWSER_MODELS) {
    if (list.length >= 2) break;
    list.push(puterModel);
  }

  return list.slice(0, 2);
}

export const ARCHITECT_PUBLIC_MODEL: UnifiedAiModel = PUTER_BROWSER_MODELS[0];
export const ARCHITECT_MODEL_ID = DEFAULT_BUILDER_MODEL_ID;
export const DEFAULT_POLLINATIONS_TEXT_URL = 'https://text.pollinations.ai';
export const DEFAULT_POLLINATIONS_IMAGE_URL = 'https://image.pollinations.ai';
export const POLLINATIONS_FALLBACK_MODELS: UnifiedAiModel[] = [];

const endpointCooldowns = new Map<string, number>();

export function buildCandidateCooldownKey(
  gateway: string,
  _apiKey: string,
  upstreamModelId: string
): string {
  return `${gateway}:keyless:${upstreamModelId}`;
}

export function markGatewayCandidateCooldown(
  cooldownKey: string,
  cooldownMs = 45_000
): void {
  endpointCooldowns.set(cooldownKey, Date.now() + cooldownMs);
}

export function isGatewayCandidateCoolingDown(cooldownKey: string): boolean {
  const until = endpointCooldowns.get(cooldownKey);
  if (!until) return false;
  if (Date.now() >= until) {
    endpointCooldowns.delete(cooldownKey);
    return false;
  }
  return true;
}

export function getGatewayOrder(): AiGatewayId[] {
  return hasServerFreeAiKey() ? ['gemini', 'groq', 'openrouter', 'puter'] : ['puter'];
}

export function parseGatewayModelIdentifier(
  modelId?: string
): { gateway: AiGatewayId; upstreamModelId: string } {
  const raw = typeof modelId === 'string' ? modelId.trim() : '';

  if (raw === SERVER_GEMINI_MODEL_ID || raw === 'gemini-4-hydrogen') {
    return { gateway: 'gemini', upstreamModelId: 'gemini-4-hydrogen' };
  }
  if (raw === SERVER_GROQ_MODEL_ID || raw.startsWith('groq::')) {
    return {
      gateway: 'groq',
      upstreamModelId: raw.replace(/^groq::/, '') || 'llama-3.3-70b-versatile',
    };
  }
  if (raw === SERVER_OPENROUTER_MODEL_ID || raw.startsWith('openrouter::')) {
    return {
      gateway: 'openrouter',
      upstreamModelId: raw.replace(/^openrouter::/, '') || 'qwen/qwen3-coder:free',
    };
  }
  if (
    raw === SECONDARY_BUILDER_MODEL_ID ||
    raw === 'claude-sonnet-4-6'
  ) {
    return { gateway: 'puter', upstreamModelId: 'claude-sonnet-4-6' };
  }

  return { gateway: 'puter', upstreamModelId: 'gemini-2.5-flash' };
}

export function classifyGatewayModelCapabilities(): {
  capabilities: string[];
  category: FreeModelCategory;
} {
  return { capabilities: ['Vision', 'Screenshots', 'Code'], category: 'code' };
}

export async function fetchAllGatewayModels(
  _referer: string,
  _forceRefresh = false
): Promise<{
  models: UnifiedAiModel[];
  gateways: GatewayStatusSummary[];
  pollinationsConfigured: boolean;
  puterConfigured: boolean;
  serverFreeAiReady: boolean;
}> {
  const groqCheck = await resolveUsableGroqModels(_forceRefresh);
  const activeModels = getActiveTwoBuilderModels({
    groqUsable: groqCheck.usable,
    groqModelId: groqCheck.bestModelId,
  });
  const serverModels = activeModels.filter((m) => m.gateway !== 'puter');
  const serverReady = serverModels.length > 0;
  const gateways: GatewayStatusSummary[] = [
    ...(serverReady
      ? [
          {
            id: 'gemini' as AiGatewayId,
            label: 'Free Server Vision & Code',
            baseUrl: 'https://generativelanguage.googleapis.com',
            configured: true,
            keyCount: 1,
            modelCount: serverModels.length,
            defaultModel: serverModels[0]?.upstreamModelId || 'gemini-4-hydrogen',
          },
        ]
      : []),
    {
      id: 'puter',
      label: 'Puter Vision & Code',
      baseUrl: PUTER_BROWSER_SCRIPT_URL,
      configured: true,
      keyCount: 0,
      modelCount: activeModels.filter((m) => m.gateway === 'puter').length,
      defaultModel: 'gemini-2.5-flash',
    },
  ];

  return {
    models: activeModels,
    gateways,
    pollinationsConfigured: false,
    puterConfigured: true,
    serverFreeAiReady: serverReady,
  };
}

export function buildGatewayExecutionPlan(params: {
  requestedModel?: string;
  requestedGateway?: string;
}): {
  pollinationsCandidates: GatewayExecutionCandidate[];
  requestedMediaKind: 'image' | 'music' | 'video' | null;
  requestedModelLabel: string;
} {
  const activeModels = getActiveTwoBuilderModels();
  const parsed = parseGatewayModelIdentifier(params.requestedModel);
  const matched =
    activeModels.find(
      (m) => m.id === params.requestedModel || m.upstreamModelId === parsed.upstreamModelId
    ) ??
    PUTER_BROWSER_MODELS.find(
      (m) => m.id === params.requestedModel || m.upstreamModelId === parsed.upstreamModelId
    ) ??
    activeModels[0];

  const requestedModelLabel =
    matched?.name || cleanEnvKey(params.requestedModel, []) || activeModels[0].name;

  return {
    pollinationsCandidates: [],
    requestedMediaKind: null,
    requestedModelLabel,
  };
}
