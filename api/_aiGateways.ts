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

/**
 * Full Gemini builder lineup (latest Flash & Pro + classic 2.5 Flash & Pro),
 * all powered exclusively by process.env.GEMINI_API_KEY on the server.
 */
export const GEMINI_BUILDER_MODELS: UnifiedAiModel[] = [
  {
    id: 'gemini::gemini-4-hydrogen',
    upstreamModelId: 'gemini-4-hydrogen',
    gateway: 'gemini',
    name: 'Gemini 4 Hydrogen (Flash)',
    provider: 'google',
    contextLength: 1048576,
    isFree: true,
    tierLabel: 'Latest · Fast',
    capabilities: ['Vision', 'Screenshots', 'Code', 'DB'],
    category: 'code',
  },
  {
    id: 'gemini::gemini-3.1-pro-preview',
    upstreamModelId: 'gemini-3.1-pro-preview',
    gateway: 'gemini',
    name: 'Gemini 3.1 Pro',
    provider: 'google',
    contextLength: 1048576,
    isFree: true,
    tierLabel: 'Pro · Coding',
    capabilities: ['Vision', 'Screenshots', 'Code', 'DB'],
    category: 'code',
  },
  {
    id: 'gemini::gemini-3.1-flash-lite',
    upstreamModelId: 'gemini-3.1-flash-lite',
    gateway: 'gemini',
    name: 'Gemini 3.1 Flash Lite',
    provider: 'google',
    contextLength: 1048576,
    isFree: true,
    tierLabel: 'Ultra Fast',
    capabilities: ['Vision', 'Screenshots', 'Code', 'Fast'],
    category: 'code',
  },
  {
    id: 'gemini::gemini-2.5-pro',
    upstreamModelId: 'gemini-2.5-pro',
    gateway: 'gemini',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    contextLength: 1048576,
    isFree: true,
    tierLabel: '2.5 · Pro',
    capabilities: ['Vision', 'Screenshots', 'Code', 'DB'],
    category: 'code',
  },
  {
    id: 'gemini::gemini-2.5-flash',
    upstreamModelId: 'gemini-2.5-flash',
    gateway: 'gemini',
    name: 'Gemini 2.5 Flash',
    provider: 'google',
    contextLength: 1048576,
    isFree: true,
    tierLabel: '2.5 · Flash',
    capabilities: ['Vision', 'Screenshots', 'Code', 'Fast'],
    category: 'code',
  },
  {
    id: 'gemini::gemini-2.5-flash-preview-12-2025',
    upstreamModelId: 'gemini-2.5-flash-preview-12-2025',
    gateway: 'gemini',
    name: 'Gemini 2.5 Flash Preview',
    provider: 'google',
    contextLength: 1048576,
    isFree: true,
    tierLabel: 'Preview · Fast',
    capabilities: ['Vision', 'Screenshots', 'Code', 'Fast'],
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

export function getGatewayOrder(): AiGatewayId[] {
  return ['gemini'];
}

export function parseGatewayModelIdentifier(
  modelId?: string
): { gateway: AiGatewayId; upstreamModelId: string } {
  const raw = typeof modelId === 'string' ? modelId.trim() : '';
  const bare = raw.replace(/^gemini::/i, '').trim();

  const matched = GEMINI_BUILDER_MODELS.find(
    (m) => m.id === raw || m.upstreamModelId === bare
  );
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
      label: 'Google Gemini API',
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
