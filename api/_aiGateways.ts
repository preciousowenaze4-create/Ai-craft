import {
  cleanEnvKey,
  isTextToSpeechModel,
  type FreeModelCategory,
  type KeylessGatewayStatus,
  type NormalizedOpenRouterModel,
} from './_openrouterModels.js';

export type AiGatewayId =
  | 'auto'
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

export const ARCHITECT_MODEL_ID = 'auto::free-browser';
export const DEFAULT_POLLINATIONS_TEXT_URL = 'https://text.pollinations.ai';
export const DEFAULT_POLLINATIONS_IMAGE_URL = 'https://image.pollinations.ai';
export const PUTER_BROWSER_SCRIPT_URL = 'https://js.puter.com/v2/';

export const ARCHITECT_PUBLIC_MODEL: UnifiedAiModel = {
  id: ARCHITECT_MODEL_ID,
  upstreamModelId: ARCHITECT_MODEL_ID,
  gateway: 'auto',
  name: 'AI Craft Auto (Free · No Key)',
  provider: 'aicraft',
  contextLength: 1048576,
  isFree: true,
  tierLabel: 'No Key · Instant',
  capabilities: ['Code', 'Build', 'Search', 'Vision'],
  category: 'router',
};

export const PUTER_BROWSER_MODELS: UnifiedAiModel[] = [
  {
    id: 'puter::claude-sonnet-4',
    upstreamModelId: 'claude-sonnet-4',
    gateway: 'puter',
    name: 'Claude Sonnet 4 (Browser Free)',
    provider: 'anthropic',
    contextLength: 200000,
    isFree: true,
    tierLabel: 'Browser Free',
    capabilities: ['Code', 'Vision', 'Build'],
    category: 'code',
  },
  {
    id: 'puter::gpt-4o',
    upstreamModelId: 'gpt-4o',
    gateway: 'puter',
    name: 'GPT-4o (Browser Vision · Free)',
    provider: 'openai',
    contextLength: 128000,
    isFree: true,
    tierLabel: 'Browser Free',
    capabilities: ['Vision', 'Code', 'Build'],
    category: 'code',
  },
  {
    id: 'puter::gemini-2.5-flash',
    upstreamModelId: 'gemini-2.5-flash',
    gateway: 'puter',
    name: 'Gemini 2.5 Flash (Browser Free)',
    provider: 'google',
    contextLength: 1000000,
    isFree: true,
    tierLabel: 'Browser Free',
    capabilities: ['Vision', 'Code', 'Fast'],
    category: 'code',
  },
  {
    id: 'puter::deepseek-chat',
    upstreamModelId: 'deepseek-chat',
    gateway: 'puter',
    name: 'DeepSeek V3 (Browser Free)',
    provider: 'deepseek',
    contextLength: 128000,
    isFree: true,
    tierLabel: 'Browser Free',
    capabilities: ['Code', 'Build'],
    category: 'code',
  },
  {
    id: 'puter::deepseek-reasoner',
    upstreamModelId: 'deepseek-reasoner',
    gateway: 'puter',
    name: 'DeepSeek R1 Reasoner (Free)',
    provider: 'deepseek',
    contextLength: 128000,
    isFree: true,
    tierLabel: 'Browser Free',
    capabilities: ['Reasoning', 'Code'],
    category: 'code',
  },
  {
    id: 'puter::meta-llama/llama-3.3-70b-instruct',
    upstreamModelId: 'meta-llama/llama-3.3-70b-instruct',
    gateway: 'puter',
    name: 'Llama 3.3 70B (Browser Free)',
    provider: 'meta',
    contextLength: 128000,
    isFree: true,
    tierLabel: 'Browser Free',
    capabilities: ['Code', 'Build'],
    category: 'code',
  },
  {
    id: 'puter::qwen/qwen-2.5-coder-32b-instruct',
    upstreamModelId: 'qwen/qwen-2.5-coder-32b-instruct',
    gateway: 'puter',
    name: 'Qwen 2.5 Coder 32B (Free)',
    provider: 'qwen',
    contextLength: 128000,
    isFree: true,
    tierLabel: 'Browser Free',
    capabilities: ['Code', 'Build'],
    category: 'code',
  },
];

export const POLLINATIONS_FALLBACK_MODELS: UnifiedAiModel[] = [
  {
    id: 'pollinations::openai-fast',
    upstreamModelId: 'openai-fast',
    gateway: 'pollinations',
    name: 'GPT-OSS 20B Reasoning (No Login)',
    provider: 'pollinations',
    contextLength: 128000,
    isFree: true,
    tierLabel: 'Zero Login',
    capabilities: ['Code', 'Build', 'Reasoning'],
    category: 'code',
  },
  {
    id: 'pollinations::sana',
    upstreamModelId: 'sana',
    gateway: 'pollinations',
    name: 'Sana Image Studio (Free · No Key)',
    provider: 'pollinations',
    contextLength: 0,
    isFree: true,
    tierLabel: 'Zero Login',
    capabilities: ['Image'],
    category: 'image',
  },
  {
    id: 'web-search::images',
    upstreamModelId: 'google-image-search',
    gateway: 'web-search',
    name: 'Google Image Search Studio (Free)',
    provider: 'web-search',
    contextLength: 0,
    isFree: true,
    tierLabel: 'Live Web',
    capabilities: ['Image', 'Search'],
    category: 'image',
  },
  {
    id: 'pollinations::music-composer',
    upstreamModelId: 'music-composer',
    gateway: 'pollinations',
    name: 'AI Craft Music Studio (Free)',
    provider: 'pollinations',
    contextLength: 0,
    isFree: true,
    tierLabel: 'Zero Login',
    capabilities: ['Music'],
    category: 'music',
  },
];

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
  return ['auto', 'puter', 'pollinations', 'web-search', 'browser'];
}

export function parseGatewayModelIdentifier(
  modelId?: string,
  explicitGateway?: string
): { gateway?: AiGatewayId; upstreamModelId: string } {
  const raw = typeof modelId === 'string' ? modelId.trim() : '';
  const gw = typeof explicitGateway === 'string' ? explicitGateway.trim().toLowerCase() : '';

  if (!raw || raw === 'auto::free-browser' || raw === 'auto::architect') {
    return { gateway: 'auto', upstreamModelId: ARCHITECT_MODEL_ID };
  }
  if (raw.startsWith('puter::')) {
    return { gateway: 'puter', upstreamModelId: raw.slice('puter::'.length) };
  }
  if (raw.startsWith('pollinations::')) {
    return { gateway: 'pollinations', upstreamModelId: raw.slice('pollinations::'.length) };
  }
  if (raw.startsWith('web-search::')) {
    return { gateway: 'web-search', upstreamModelId: raw.slice('web-search::'.length) };
  }
  if (raw.startsWith('browser::')) {
    return { gateway: 'browser', upstreamModelId: raw.slice('browser::'.length) };
  }

  if (gw === 'puter' || gw === 'pollinations' || gw === 'web-search' || gw === 'browser' || gw === 'auto') {
    return { gateway: gw, upstreamModelId: raw };
  }

  return { upstreamModelId: raw };
}

export function classifyGatewayModelCapabilities(modelId: string): {
  capabilities: string[];
  category: FreeModelCategory;
} {
  const lower = modelId.toLowerCase();
  if (/sana|flux|image|photo|draw/.test(lower)) {
    return { capabilities: ['Image'], category: 'image' };
  }
  if (/music|audio|song|composer|beat/.test(lower)) {
    return { capabilities: ['Music'], category: 'music' };
  }
  if (/video|wan|hunyuan/.test(lower)) {
    return { capabilities: ['Video'], category: 'video' };
  }
  return { capabilities: ['Code', 'Build'], category: 'code' };
}

export async function fetchPollinationsCatalog(): Promise<UnifiedAiModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${DEFAULT_POLLINATIONS_TEXT_URL}/models`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) return [...POLLINATIONS_FALLBACK_MODELS];
    const json = (await res.json()) as Array<{
      name?: string;
      description?: string;
      tier?: string;
    }>;
    if (!Array.isArray(json) || json.length === 0) {
      return [...POLLINATIONS_FALLBACK_MODELS];
    }
    const textModels: UnifiedAiModel[] = [];
    for (const entry of json) {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      if (!name || isTextToSpeechModel(name)) continue;
      if (entry.tier && entry.tier !== 'anonymous') continue;
      textModels.push({
        id: `pollinations::${name}`,
        upstreamModelId: name,
        gateway: 'pollinations',
        name:
          name === 'openai-fast'
            ? 'GPT-OSS 20B Reasoning (No Login)'
            : `${name} (Free · No Login)`,
        provider: 'pollinations',
        contextLength: 128000,
        isFree: true,
        tierLabel: 'Zero Login',
        capabilities: ['Code', 'Build', 'Reasoning'],
        category: 'code',
      });
    }
    if (textModels.length === 0) {
      return [...POLLINATIONS_FALLBACK_MODELS];
    }
    return [
      ...textModels,
      ...POLLINATIONS_FALLBACK_MODELS.filter((m) => m.category !== 'code'),
    ];
  } catch {
    return [...POLLINATIONS_FALLBACK_MODELS];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAllGatewayModels(
  _referer: string,
  _forceRefresh = false
): Promise<{
  models: UnifiedAiModel[];
  gateways: GatewayStatusSummary[];
  pollinationsConfigured: boolean;
  puterConfigured: boolean;
}> {
  const pollinationsModels = await fetchPollinationsCatalog().catch(() => [
    ...POLLINATIONS_FALLBACK_MODELS,
  ]);

  const models: UnifiedAiModel[] = [
    ARCHITECT_PUBLIC_MODEL,
    ...pollinationsModels.filter((m) => m.category === 'code'),
    ...PUTER_BROWSER_MODELS,
    ...pollinationsModels.filter((m) => m.category !== 'code'),
  ];

  // Deduplicate by ID preserving priority order
  const deduped: UnifiedAiModel[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    deduped.push(m);
  }

  const gateways: GatewayStatusSummary[] = [
    {
      id: 'auto',
      label: 'Free Browser Smart Auto',
      baseUrl: DEFAULT_POLLINATIONS_TEXT_URL,
      configured: true,
      keyCount: 0,
      modelCount: 1,
      defaultModel: ARCHITECT_MODEL_ID,
    },
    {
      id: 'pollinations',
      label: 'Pollinations Keyless AI',
      baseUrl: DEFAULT_POLLINATIONS_TEXT_URL,
      configured: true,
      keyCount: 0,
      modelCount: pollinationsModels.length,
      defaultModel: 'openai-fast',
    },
    {
      id: 'puter',
      label: 'Puter.js Browser AI',
      baseUrl: PUTER_BROWSER_SCRIPT_URL,
      configured: true,
      keyCount: 0,
      modelCount: PUTER_BROWSER_MODELS.length,
      defaultModel: 'claude-sonnet-4',
    },
    {
      id: 'web-search',
      label: 'Live Web & Image Search',
      baseUrl: 'https://www.bing.com',
      configured: true,
      keyCount: 0,
      modelCount: 1,
      defaultModel: 'google-image-search',
    },
  ];

  return {
    models: deduped,
    gateways,
    pollinationsConfigured: true,
    puterConfigured: true,
  };
}

export function buildGatewayExecutionPlan(params: {
  requestedModel?: string;
  requestedGateway?: string;
  pollinationsCatalog?: UnifiedAiModel[];
}): {
  pollinationsCandidates: GatewayExecutionCandidate[];
  requestedMediaKind: 'image' | 'music' | 'video' | null;
  requestedModelLabel: string;
} {
  const polList =
    params.pollinationsCatalog && params.pollinationsCatalog.length > 0
      ? params.pollinationsCatalog
      : POLLINATIONS_FALLBACK_MODELS;

  const parsed = parseGatewayModelIdentifier(
    params.requestedModel,
    params.requestedGateway
  );

  const allKnown = [
    ARCHITECT_PUBLIC_MODEL,
    ...PUTER_BROWSER_MODELS,
    ...polList,
    ...POLLINATIONS_FALLBACK_MODELS,
  ];
  const matched = allKnown.find(
    (m) => m.id === params.requestedModel || m.upstreamModelId === parsed.upstreamModelId
  );

  let requestedMediaKind: 'image' | 'music' | 'video' | null = null;
  if (matched?.category === 'image') requestedMediaKind = 'image';
  else if (matched?.category === 'music') requestedMediaKind = 'music';
  else if (matched?.category === 'video') requestedMediaKind = 'video';
  else if (parsed.upstreamModelId && parsed.gateway !== 'auto') {
    const cap = classifyGatewayModelCapabilities(parsed.upstreamModelId);
    if (cap.category === 'image' || cap.category === 'music' || cap.category === 'video') {
      requestedMediaKind = cap.category;
    }
  }

  const pollinationsCandidates: GatewayExecutionCandidate[] = polList
    .filter((m) => m.category === 'code' || m.gateway === 'pollinations')
    .filter((m) => m.category !== 'image' && m.category !== 'music' && m.category !== 'video')
    .map((m) => ({
      gateway: 'pollinations' as const,
      gatewayLabel: 'Pollinations Public AI',
      baseUrl: DEFAULT_POLLINATIONS_TEXT_URL,
      apiKey: '',
      publicModelId: m.id,
      upstreamModelId: m.upstreamModelId,
      modelName: m.name,
      provider: m.provider,
      cooldownKey: buildCandidateCooldownKey('pollinations', '', m.upstreamModelId),
    }));

  const requestedModelLabel =
    matched?.name || cleanEnvKey(params.requestedModel, []) || ARCHITECT_PUBLIC_MODEL.name;

  return {
    pollinationsCandidates,
    requestedMediaKind,
    requestedModelLabel,
  };
}
