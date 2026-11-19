import {
  cleanEnvKey,
  type FreeModelCategory,
  type KeylessGatewayStatus,
  type NormalizedOpenRouterModel,
} from './_openrouterModels.js';

export type AiGatewayId = 'auto' | 'gemini' | 'web-search' | 'browser';

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
export const DEFAULT_BUILDER_MODEL_ID = 'gemini::gemini-4-hydrogen';
export const SECONDARY_BUILDER_MODEL_ID = 'gemini::gemini-3.1-pro-preview';
export const BACKEND_DESIGNER_MODEL_ID = 'gemini-2.5-pro';

export function getServerGeminiApiKey(): string {
  return cleanEnvKey(process.env.GEMINI_API_KEY, [
    'MY_GEMINI_API_KEY',
    'YOUR_GEMINI_API_KEY',
  ]);
}

export function getServerFreeAiKeys(): { geminiKey: string } {
  return {
    geminiKey: getServerGeminiApiKey(),
  };
}

export function hasServerFreeAiKey(): boolean {
  return Boolean(getServerGeminiApiKey());
}

export const BACKEND_GEMINI_FAILOVER_CHAIN: ReadonlyArray<{
  upstreamModelId: string;
  label: string;
}> = [
  { upstreamModelId: 'gemini-4-hydrogen', label: 'AI Craft Pro (4 Hydrogen)' },
  { upstreamModelId: 'gemini-2.5-pro', label: 'AI Craft Pro Engine (2.5 Pro)' },
  { upstreamModelId: 'gemini-2.5-flash', label: 'AI Craft 2.5 Flash' },
  { upstreamModelId: 'gemini-3.1-pro-preview', label: 'AI Craft 3.1 Pro' },
  { upstreamModelId: 'gemini-3.1-flash-lite-preview', label: 'AI Craft 3.1 Mini Preview' },
  { upstreamModelId: 'gemini-3.1-flash-lite', label: 'AI Craft 3.1 Lite' },
  { upstreamModelId: 'gemini-2.5-flash-lite', label: 'AI Craft 2.5 Lite' },
  { upstreamModelId: 'gemini-2.0-flash', label: 'AI Craft 2.0 Flash' },
];

/**
 * Visible AI Craft builder lineup (single unified flagship AI shown to users).
 * All other Gemini models run automatically in the backend failover chain
 * if the flagship model hits 503 high demand, 404, or rate limits.
 */
export const GEMINI_BUILDER_MODELS: UnifiedAiModel[] = [
  {
    id: 'gemini::gemini-4-hydrogen',
    upstreamModelId: 'gemini-4-hydrogen',
    gateway: 'gemini',
    name: 'AI Craft Pro (4 Hydrogen)',
    provider: 'aicraft',
    contextLength: 1048576,
    isFree: true,
    tierLabel: 'Flagship · Auto',
    capabilities: ['Vision', 'Screenshots', 'Code', 'DB'],
    category: 'code',
  },
];

export function getActiveTwoBuilderModels(): UnifiedAiModel[] {
  return GEMINI_BUILDER_MODELS;
}

export const ARCHITECT_PUBLIC_MODEL: UnifiedAiModel = GEMINI_BUILDER_MODELS[0];
export const ARCHITECT_MODEL_ID = DEFAULT_BUILDER_MODEL_ID;

const endpointCooldowns = new Map<string, number>();

export function buildCandidateCooldownKey(
  gateway: string,
  _apiKey: string,
  upstreamModelId: string
): string {
  return `${gateway}:${upstreamModelId}`;
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

export function getOrderedBackendGeminiFailoverModels(
  preferredUpstreamId?: string
): Array<{ upstreamModelId: string; label: string; cooldownKey: string }> {
  const base = [...BACKEND_GEMINI_FAILOVER_CHAIN];
  if (preferredUpstreamId) {
    const idx = base.findIndex((m) => m.upstreamModelId === preferredUpstreamId);
    if (idx > 0) {
      const [picked] = base.splice(idx, 1);
      base.unshift(picked);
    }
  }
  const withKeys = base.map((m) => ({
    ...m,
    cooldownKey: buildCandidateCooldownKey('gemini', '', m.upstreamModelId),
  }));
  const ready = withKeys.filter((m) => !isGatewayCandidateCoolingDown(m.cooldownKey));
  const cooling = withKeys.filter((m) => isGatewayCandidateCoolingDown(m.cooldownKey));
  return [...ready, ...cooling];
}

export function getGatewayOrder(): AiGatewayId[] {
  return ['gemini'];
}

export function parseGatewayModelIdentifier(
  modelId?: string
): { gateway: AiGatewayId; upstreamModelId: string } {
  const raw = typeof modelId === 'string' ? modelId.trim() : '';
  const bare = raw.replace(/^gemini::/i, '').trim();

  const matched =
    GEMINI_BUILDER_MODELS.find(
      (m) => m.id === raw || m.upstreamModelId === bare
    ) ??
    BACKEND_GEMINI_FAILOVER_CHAIN.find((m) => m.upstreamModelId === bare);

  if (matched) {
    return { gateway: 'gemini', upstreamModelId: matched.upstreamModelId };
  }

  return { gateway: 'gemini', upstreamModelId: 'gemini-4-hydrogen' };
}

export function classifyGatewayModelCapabilities(): {
  capabilities: string[];
  category: FreeModelCategory;
} {
  return { capabilities: ['Vision', 'Screenshots', 'Code', 'DB'], category: 'code' };
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
  geminiConfigured: boolean;
}> {
  const geminiConfigured = Boolean(getServerGeminiApiKey());
  const gateways: GatewayStatusSummary[] = [
    {
      id: 'gemini',
      label: 'AI Craft Engine',
      baseUrl: 'https://generativelanguage.googleapis.com',
      configured: geminiConfigured,
      keyCount: geminiConfigured ? 1 : 0,
      modelCount: GEMINI_BUILDER_MODELS.length,
      defaultModel: 'gemini-4-hydrogen',
    },
  ];

  return {
    models: GEMINI_BUILDER_MODELS,
    gateways,
    pollinationsConfigured: false,
    puterConfigured: false,
    serverFreeAiReady: geminiConfigured,
    geminiConfigured,
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
  const parsed = parseGatewayModelIdentifier(params.requestedModel);
  const matched =
    GEMINI_BUILDER_MODELS.find(
      (m) => m.id === params.requestedModel || m.upstreamModelId === parsed.upstreamModelId
    ) ?? GEMINI_BUILDER_MODELS[0];

  return {
    pollinationsCandidates: [],
    requestedMediaKind: null,
    requestedModelLabel: matched.name,
  };
}
