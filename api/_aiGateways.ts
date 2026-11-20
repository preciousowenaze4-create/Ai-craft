import crypto from 'node:crypto';
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

export type GeminiTaskKind =
  | 'build'
  | 'chat'
  | 'design'
  | 'repair'
  | 'media'
  | 'transcribe';

export type GeminiThinkingMode = 'level' | 'budget' | 'none';

export interface DynamicGeminiCandidate {
  apiKey: string;
  keyFingerprint: string;
  keyMask: string;
  upstreamModelId: string;
  label: string;
  cooldownKey: string;
  confirmedLive: boolean;
  thinkingMode: GeminiThinkingMode;
  isGemini4Series: boolean;
}

export const SERVER_GEMINI_MODEL_ID = 'gemini::gemini-4-hydrogen';
export const DEFAULT_BUILDER_MODEL_ID = 'gemini::gemini-4-hydrogen';
export const SECONDARY_BUILDER_MODEL_ID = 'gemini::gemini-3.8-flash';
export const BACKEND_DESIGNER_MODEL_ID = 'gemini-3.8-flash';

const KEY_PLACEHOLDERS = [
  'MY_GEMINI_API_KEY',
  'YOUR_GEMINI_API_KEY',
  'GEMINI_API_KEY',
  'REPLACE_ME',
];

function parseMultiKeysFromRaw(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(/[\r\n,;]+/)
    .map((part) => cleanEnvKey(part, KEY_PLACEHOLDERS))
    .filter((k) => k.length >= 16);
}

export function getServerGeminiApiKeys(): string[] {
  const envVars = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
    process.env.GEMINI_API_KEY_6,
    process.env.GEMINI_API_KEY_7,
    process.env.GEMINI_API_KEY_8,
    process.env.BACKUP_GEMINI_API_KEY,
    process.env.GEMINI_BACKUP_KEY,
    process.env.GEMINI_API_KEY_BACKUP,
    process.env.SECONDARY_GEMINI_API_KEY,
    process.env.MY_GEMINI_API_KEY,
    process.env.YOUR_GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
  ];

  const seen = new Set<string>();
  const keys: string[] = [];
  for (const raw of envVars) {
    for (const candidate of parseMultiKeysFromRaw(raw)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        keys.push(candidate);
      }
    }
  }
  return keys;
}

export function getServerGeminiApiKey(): string {
  return getServerGeminiApiKeys()[0] || '';
}

export function getServerFreeAiKeys(): { geminiKey: string } {
  return {
    geminiKey: getServerGeminiApiKey(),
  };
}

export function hasServerFreeAiKey(): boolean {
  return getServerGeminiApiKeys().length > 0;
}

export function computeApiKeyFingerprint(apiKey: string): string {
  if (!apiKey) return 'none';
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}

export function computeApiKeyMask(apiKey: string): string {
  if (!apiKey) return 'Not set';
  return `••••${apiKey.slice(-4)}`;
}

/**
 * Active modern Gemini models (never includes retired gemini-1.* or gemini-2.0-*).
 * Serves as a baseline seed combined with live Google `/v1beta/models` auto-discovery.
 */
export const BACKEND_GEMINI_FAILOVER_CHAIN: ReadonlyArray<{
  upstreamModelId: string;
  label: string;
}> = [
  { upstreamModelId: 'gemini-4-hydrogen', label: 'AI Craft Pro (4 Hydrogen)' },
  { upstreamModelId: 'gemini-3.8-flash', label: 'AI Craft 3.8 Flash' },
  { upstreamModelId: 'gemini-2.5-flash', label: 'AI Craft 2.5 Flash' },
  { upstreamModelId: 'gemini-2.5-pro', label: 'AI Craft 2.5 Pro' },
  { upstreamModelId: 'gemini-4-neon', label: 'AI Craft 4 Neon' },
  { upstreamModelId: 'gemini-4-argon', label: 'AI Craft 4 Argon' },
  { upstreamModelId: 'gemini-4-carbon', label: 'AI Craft 4 Carbon' },
  { upstreamModelId: 'gemini-3.1-pro-preview', label: 'AI Craft 3.1 Pro' },
  { upstreamModelId: 'gemini-3-flash-preview', label: 'AI Craft 3 Flash' },
  { upstreamModelId: 'gemini-3.1-flash-lite', label: 'AI Craft 3.1 Lite' },
  { upstreamModelId: 'gemini-3.1-flash-lite-preview', label: 'AI Craft 3.1 Mini' },
  { upstreamModelId: 'gemini-2.5-flash-lite', label: 'AI Craft 2.5 Lite' },
];

/**
 * Visible AI Craft builder lineup (single unified flagship AI shown to users).
 * All other Gemini models & keys run automatically in the backend failover matrix.
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

const endpointCooldowns = new Map<string, { until: number; hard: boolean }>();
const invalidKeyCooldowns = new Map<string, number>();

export function buildCandidateCooldownKey(
  gateway: string,
  apiKey: string,
  upstreamModelId: string
): string {
  const fp = computeApiKeyFingerprint(apiKey);
  return `${gateway}:${fp}:${upstreamModelId}`;
}

export function markGatewayCandidateCooldown(
  cooldownKey: string,
  cooldownMs = 45_000,
  hardBlock = false
): void {
  endpointCooldowns.set(cooldownKey, {
    until: Date.now() + cooldownMs,
    hard: hardBlock,
  });
}

export function isGatewayCandidateCoolingDown(cooldownKey: string): boolean {
  const entry = endpointCooldowns.get(cooldownKey);
  if (!entry) return false;
  if (Date.now() >= entry.until) {
    endpointCooldowns.delete(cooldownKey);
    return false;
  }
  return true;
}

export function isGatewayCandidateHardBlocked(cooldownKey: string): boolean {
  const entry = endpointCooldowns.get(cooldownKey);
  if (!entry) return false;
  if (Date.now() >= entry.until) {
    endpointCooldowns.delete(cooldownKey);
    return false;
  }
  return entry.hard;
}

export function markApiKeyInvalidCooldown(apiKey: string, cooldownMs = 10 * 60_000): void {
  const fp = computeApiKeyFingerprint(apiKey);
  invalidKeyCooldowns.set(fp, Date.now() + cooldownMs);
}

export function isApiKeyInvalidCoolingDown(apiKey: string): boolean {
  const fp = computeApiKeyFingerprint(apiKey);
  const until = invalidKeyCooldowns.get(fp);
  if (!until) return false;
  if (Date.now() >= until) {
    invalidKeyCooldowns.delete(fp);
    return false;
  }
  return true;
}

export function inferGeminiThinkingMode(modelId: string): GeminiThinkingMode {
  const lower = modelId.toLowerCase();
  if (/^gemini-(?:[4-9]|[1-9]\d|3(?:\.\d+)?)\b/.test(lower)) {
    return lower.includes('lite') ? 'none' : 'level';
  }
  if (/^gemini-2\.5\b/.test(lower)) {
    return lower.includes('lite') ? 'none' : 'budget';
  }
  return 'none';
}

export function isGemini4SeriesModel(modelId: string): boolean {
  return /^gemini-(?:[4-9]|[1-9]\d)\b/i.test(modelId.trim());
}

export function isDeprecatedGeminiModelId(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase().replace(/^models\//, '');
  if (!lower.startsWith('gemini')) return false;
  return (
    /^gemini-1\./.test(lower) ||
    /^gemini-2\.0\b/.test(lower) ||
    /^gemini-pro(?:-vision)?$/.test(lower)
  );
}

export function isBuilderCompatibleGeminiModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase().replace(/^models\//, '');
  if (!lower.startsWith('gemini-')) return false;
  if (isDeprecatedGeminiModelId(lower)) return false;
  if (
    /embedding|aqa|imagen|veo|lyria|tts|transcribe|robotics|computer-use|image|nano-banana|genie|decision|-live\b|native-audio|-audio\b|bisect|customtools|experimental-research/i.test(
      lower
    )
  ) {
    return false;
  }
  return true;
}

function parseGeminiVersionScore(modelId: string): number {
  const m = /^gemini-(\d+)(?:\.(\d+))?/i.exec(modelId.trim());
  if (!m) return 0;
  const major = Number(m[1] || 0);
  const minor = Number(m[2] || 0);
  return major * 100 + minor;
}

export function scoreDiscoveredGeminiModel(
  modelId: string,
  taskKind: GeminiTaskKind = 'build'
): number {
  const lower = modelId.toLowerCase();
  let score = parseGeminiVersionScore(lower) * 10;

  const preferFast =
    taskKind === 'design' ||
    taskKind === 'repair' ||
    taskKind === 'media' ||
    taskKind === 'transcribe';

  if (lower === 'gemini-4-hydrogen') score += preferFast ? 140 : 220;
  else if (lower === 'gemini-3.8-flash') score += preferFast ? 210 : 190;
  else if (lower === 'gemini-2.5-flash') score += preferFast ? 195 : 145;
  else if (lower === 'gemini-2.5-pro') score += preferFast ? 110 : 165;
  else if (lower.includes('hydrogen')) score += 175;
  else if (lower.includes('neon')) score += preferFast ? 95 : 155;
  else if (lower.includes('pro')) score += preferFast ? 90 : 150;
  else if (lower.includes('flash') && !lower.includes('lite')) score += preferFast ? 180 : 140;
  else if (lower.includes('argon')) score += 120;
  else if (lower.includes('carbon')) score += 110;
  else if (lower.includes('lite')) score += preferFast ? 115 : 85;

  if (lower.includes('preview') || lower.includes('-exp')) score -= 18;
  if (/-\d{2}-\d{2,4}$/.test(lower) || /-\d{3}$/.test(lower)) score -= 8;
  return score;
}

interface DiscoveredModelsCacheEntry {
  models: string[];
  fetchedAt: number;
}

const DISCOVERY_CACHE_TTL_MS = 10 * 60_000;
const discoveredModelsCache = new Map<string, DiscoveredModelsCacheEntry>();

export function invalidateDiscoveredGeminiModelsCache(apiKey?: string): void {
  if (apiKey) {
    discoveredModelsCache.delete(computeApiKeyFingerprint(apiKey));
  } else {
    discoveredModelsCache.clear();
  }
}

export async function discoverLiveGeminiModelsForKey(
  apiKey: string,
  forceRefresh = false
): Promise<string[]> {
  if (!apiKey) return [];
  const fp = computeApiKeyFingerprint(apiKey);
  const cached = discoveredModelsCache.get(fp);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
    return cached.models;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3800);
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
      apiKey
    )}&pageSize=100`;
    const resp = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      return cached?.models || [];
    }

    const data = (await resp.json().catch(() => null)) as {
      models?: Array<{
        name?: string;
        supportedGenerationMethods?: string[];
      }>;
    } | null;

    const rawModels = Array.isArray(data?.models) ? data.models : [];
    const usable: string[] = [];
    for (const item of rawModels) {
      const methods = Array.isArray(item?.supportedGenerationMethods)
        ? item.supportedGenerationMethods
        : [];
      if (!methods.includes('generateContent')) continue;
      const bare = String(item?.name || '').replace(/^models\//i, '').trim();
      if (!bare || !isBuilderCompatibleGeminiModel(bare)) continue;
      usable.push(bare);
    }

    const deduped = Array.from(new Set(usable));
    if (deduped.length > 0) {
      discoveredModelsCache.set(fp, {
        models: deduped,
        fetchedAt: Date.now(),
      });
    }
    return deduped;
  } catch {
    return cached?.models || [];
  }
}

function makeModelDisplayLabel(upstreamModelId: string): string {
  const staticEntry = BACKEND_GEMINI_FAILOVER_CHAIN.find(
    (m) => m.upstreamModelId === upstreamModelId
  );
  if (staticEntry) return staticEntry.label;
  return `AI Craft (${upstreamModelId})`;
}

export async function resolveDynamicGeminiExecutionMatrix(options?: {
  preferredUpstreamId?: string;
  forceRefresh?: boolean;
  taskKind?: GeminiTaskKind;
}): Promise<DynamicGeminiCandidate[]> {
  const allKeys = getServerGeminiApiKeys();
  if (allKeys.length === 0) return [];

  const taskKind: GeminiTaskKind = options?.taskKind || 'build';
  const forceRefresh = Boolean(options?.forceRefresh);
  const preferredId =
    options?.preferredUpstreamId && !isDeprecatedGeminiModelId(options.preferredUpstreamId)
      ? options.preferredUpstreamId
      : undefined;

  const activeKeys = allKeys.filter((k) => !isApiKeyInvalidCoolingDown(k));
  const keysToUse = activeKeys.length > 0 ? activeKeys : allKeys;

  const discoveredPerKey = await Promise.all(
    keysToUse.map((k) => discoverLiveGeminiModelsForKey(k, forceRefresh))
  );

  const readyCandidates: DynamicGeminiCandidate[] = [];
  const coolingCandidates: DynamicGeminiCandidate[] = [];
  const seenKeyModel = new Set<string>();

  const perKeyOrderedModels: Array<{ apiKey: string; items: DynamicGeminiCandidate[] }> =
    keysToUse.map((apiKey, keyIdx) => {
      const fp = computeApiKeyFingerprint(apiKey);
      const mask = computeApiKeyMask(apiKey);
      const liveList = [...(discoveredPerKey[keyIdx] || [])].sort(
        (a, b) =>
          scoreDiscoveredGeminiModel(b, taskKind) - scoreDiscoveredGeminiModel(a, taskKind)
      );

      // Put preferred model at the front if it's confirmed live OR when discovery returned nothing
      if (preferredId) {
        const liveIdx = liveList.indexOf(preferredId);
        if (liveIdx > 0) {
          const [picked] = liveList.splice(liveIdx, 1);
          liveList.unshift(picked);
        }
      }

      const baselineOrdered = [...BACKEND_GEMINI_FAILOVER_CHAIN]
        .sort(
          (a, b) =>
            scoreDiscoveredGeminiModel(b.upstreamModelId, taskKind) -
            scoreDiscoveredGeminiModel(a.upstreamModelId, taskKind)
        )
        .map((m) => m.upstreamModelId);

      if (preferredId) {
        const baseIdx = baselineOrdered.indexOf(preferredId);
        if (baseIdx > 0) {
          const [picked] = baselineOrdered.splice(baseIdx, 1);
          baselineOrdered.unshift(picked);
        } else if (baseIdx === -1) {
          baselineOrdered.unshift(preferredId);
        }
      }

      const combinedIds: Array<{ id: string; confirmedLive: boolean }> = [];
      const localSeen = new Set<string>();

      for (const id of liveList) {
        if (!localSeen.has(id)) {
          localSeen.add(id);
          combinedIds.push({ id, confirmedLive: true });
        }
      }
      for (const id of baselineOrdered) {
        if (!localSeen.has(id)) {
          localSeen.add(id);
          combinedIds.push({ id, confirmedLive: false });
        }
      }

      const items: DynamicGeminiCandidate[] = combinedIds.map(({ id, confirmedLive }) => ({
        apiKey,
        keyFingerprint: fp,
        keyMask: mask,
        upstreamModelId: id,
        label: makeModelDisplayLabel(id),
        cooldownKey: buildCandidateCooldownKey('gemini', apiKey, id),
        confirmedLive,
        thinkingMode: inferGeminiThinkingMode(id),
        isGemini4Series: isGemini4SeriesModel(id),
      }));

      return { apiKey, items };
    });

  // Interleave confirmed live models across keys first, then unconfirmed baseline models
  const maxLen = Math.max(0, ...perKeyOrderedModels.map((entry) => entry.items.length));
  for (let pass = 0; pass < 2; pass += 1) {
    const wantLive = pass === 0;
    for (let idx = 0; idx < maxLen; idx += 1) {
      for (const entry of perKeyOrderedModels) {
        const item = entry.items[idx];
        if (!item || item.confirmedLive !== wantLive) continue;
        const dedupKey = `${item.keyFingerprint}::${item.upstreamModelId}`;
        if (seenKeyModel.has(dedupKey)) continue;
        seenKeyModel.add(dedupKey);
        if (isGatewayCandidateHardBlocked(item.cooldownKey)) {
          continue;
        }
        if (isGatewayCandidateCoolingDown(item.cooldownKey)) {
          coolingCandidates.push(item);
        } else {
          readyCandidates.push(item);
        }
      }
    }
  }

  return [...readyCandidates, ...coolingCandidates];
}

export function getOrderedBackendGeminiFailoverModels(
  preferredUpstreamId?: string
): Array<{ upstreamModelId: string; label: string; cooldownKey: string }> {
  const apiKey = getServerGeminiApiKey();
  const base = [...BACKEND_GEMINI_FAILOVER_CHAIN];
  if (preferredUpstreamId && !isDeprecatedGeminiModelId(preferredUpstreamId)) {
    const idx = base.findIndex((m) => m.upstreamModelId === preferredUpstreamId);
    if (idx > 0) {
      const [picked] = base.splice(idx, 1);
      base.unshift(picked);
    }
  }
  const withKeys = base.map((m) => ({
    ...m,
    cooldownKey: buildCandidateCooldownKey('gemini', apiKey, m.upstreamModelId),
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

  if (bare && !isDeprecatedGeminiModelId(bare)) {
    const matched =
      GEMINI_BUILDER_MODELS.find(
        (m) => m.id === raw || m.upstreamModelId === bare
      ) ??
      BACKEND_GEMINI_FAILOVER_CHAIN.find((m) => m.upstreamModelId === bare);

    if (matched) {
      return { gateway: 'gemini', upstreamModelId: matched.upstreamModelId };
    }
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
  forceRefresh = false
): Promise<{
  models: UnifiedAiModel[];
  gateways: GatewayStatusSummary[];
  pollinationsConfigured: boolean;
  puterConfigured: boolean;
  serverFreeAiReady: boolean;
  geminiConfigured: boolean;
}> {
  const keys = getServerGeminiApiKeys();
  const geminiConfigured = keys.length > 0;
  if (forceRefresh && keys[0]) {
    await discoverLiveGeminiModelsForKey(keys[0], true).catch(() => []);
  }
  const gateways: GatewayStatusSummary[] = [
    {
      id: 'gemini',
      label: 'AI Craft Engine',
      baseUrl: 'https://generativelanguage.googleapis.com',
      configured: geminiConfigured,
      keyCount: keys.length,
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
