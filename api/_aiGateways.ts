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
  baseUrl?: string;
  isOpenAiStyle?: boolean;
}

export const SERVER_GEMINI_MODEL_ID = 'gemini::gemini-4-hydrogen';
export const DEFAULT_BUILDER_MODEL_ID = 'gemini::gemini-4-hydrogen';
export const SECONDARY_BUILDER_MODEL_ID = 'gemini::gemini-3.1-flash-lite';
export const BACKEND_DESIGNER_MODEL_ID = 'gemini-3.1-flash-lite';

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

const KEY_PLACEHOLDERS = [
  'MY_GEMINI_API_KEY',
  'YOUR_GEMINI_API_KEY',
  'GEMINI_API_KEY',
  'REPLACE_ME',
];

export interface ParsedEnvKeyEntry {
  apiKey: string;
  baseUrl?: string;
  hintedModel?: string;
  isOpenAiStyle?: boolean;
}

function stripWrappingQuotesAndBrackets(part: string): string {
  let s = part.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^[\[\s]+/, '').replace(/[\]\s]+$/, '').trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function parseEnvListValue(raw: string | undefined): string[] {
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean);
      }
    } catch {
      // fall through to bracket-stripped splitting
    }
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const listCandidate =
        parsed.keys ?? parsed.models ?? parsed.endpoints ?? parsed.items;
      if (Array.isArray(listCandidate)) {
        return listCandidate
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean);
      }
    } catch {
      // fall through
    }
  }

  const inner =
    trimmed.startsWith('[') && trimmed.endsWith(']')
      ? trimmed.slice(1, -1)
      : trimmed;
  return inner
    .split(/[\r\n,;|]+/)
    .map((p) => stripWrappingQuotesAndBrackets(p))
    .filter(Boolean);
}

export function normalizeGeminiEndpointUrl(rawUrl: string): {
  baseUrl: string;
  rawEndpointUrl: string;
  hintedModel?: string;
  isOpenAiStyle: boolean;
} | null {
  const cleaned = cleanEnvKey(rawUrl, ['MY_GEMINI_ENDPOINT', 'YOUR_ENDPOINT']);
  if (!cleaned || !/^https?:\/\//i.test(cleaned)) return null;

  const withoutQuery = cleaned.split(/[?#]/)[0].replace(/\/+$/, '');
  if (/\/(?:chat\/completions|openai(?:\/v1)?)$/i.test(withoutQuery)) {
    return {
      baseUrl: withoutQuery,
      rawEndpointUrl: withoutQuery,
      isOpenAiStyle: true,
    };
  }

  let hintedModel: string | undefined;
  let base = withoutQuery;
  const modelEndpointMatch =
    /\/v1(?:beta|alpha)?\/models\/([^/:?#]+)(?::[a-zA-Z0-9_]+)?$/i.exec(base) ||
    /\/models\/([^/:?#]+)(?::[a-zA-Z0-9_]+)?$/i.exec(base);
  if (modelEndpointMatch?.[1]) {
    hintedModel = modelEndpointMatch[1].trim();
  }

  base = base
    .replace(/\/v1(?:beta|alpha)?\/models(?:\/[^?#]*)?$/i, '')
    .replace(/\/models(?:\/[^?#]*)?$/i, '')
    .replace(/\/v1(?:beta|alpha)?$/i, '')
    .replace(/\/+$/, '');

  if (!/^https?:\/\/[^/]+/i.test(base)) return null;
  return {
    baseUrl: base,
    rawEndpointUrl: withoutQuery,
    ...(hintedModel ? { hintedModel } : {}),
    isOpenAiStyle: false,
  };
}

function parseKeyEntriesFromRaw(raw: string | undefined): ParsedEnvKeyEntry[] {
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const rows = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? Array.isArray((parsed as Record<string, unknown>).keys)
            ? ((parsed as Record<string, unknown>).keys as unknown[])
            : [parsed]
          : [];
      const out: ParsedEnvKeyEntry[] = [];
      for (const row of rows) {
        if (typeof row === 'string') {
          const apiKey = cleanEnvKey(row, KEY_PLACEHOLDERS);
          if (apiKey.length >= 16) out.push({ apiKey });
        } else if (row && typeof row === 'object') {
          const obj = row as Record<string, unknown>;
          const rawKey =
            obj.apiKey ?? obj.api_key ?? obj.key ?? obj.token ?? obj.secret;
          const apiKey =
            typeof rawKey === 'string'
              ? cleanEnvKey(rawKey, KEY_PLACEHOLDERS)
              : '';
          const rawUrl =
            obj.endpoint ?? obj.baseUrl ?? obj.base_url ?? obj.url ?? obj.apiUrl;
          const normUrl =
            typeof rawUrl === 'string' ? normalizeGeminiEndpointUrl(rawUrl) : null;
          const rawModel = obj.model ?? obj.modelId;
          const hintedModel =
            typeof rawModel === 'string' && rawModel.trim()
              ? rawModel.trim()
              : normUrl?.hintedModel;
          if (apiKey.length >= 16) {
            out.push({
              apiKey,
              ...(normUrl ? { baseUrl: normUrl.baseUrl, isOpenAiStyle: normUrl.isOpenAiStyle } : {}),
              ...(hintedModel ? { hintedModel } : {}),
            });
          }
        }
      }
      if (out.length > 0) return out;
    } catch {
      // fall through to string splitting
    }
  }

  return parseEnvListValue(trimmed)
    .map((part) => cleanEnvKey(part, KEY_PLACEHOLDERS))
    .filter((k) => k.length >= 16)
    .map((apiKey) => ({ apiKey }));
}

export function getGeminiEndpointOverrides(): Array<{
  baseUrl: string;
  rawEndpointUrl: string;
  hintedModel?: string;
  isOpenAiStyle: boolean;
}> {
  const endpointVars: Array<string | undefined> = [
    process.env.GEMINI_API_BASE_URL,
    process.env.GEMINI_BASE_URL,
    process.env.GEMINI_API_ENDPOINT,
    process.env.GEMINI_ENDPOINT,
    process.env.GEMINI_ENDPOINTS,
    process.env.GEMINI_API_ENDPOINTS,
    process.env.GEMINI_API_URL,
    process.env.GOOGLE_GEMINI_BASE_URL,
    process.env.GOOGLE_GEMINI_ENDPOINT,
    process.env.GOOGLE_API_BASE_URL,
    process.env.AI_ENDPOINT,
    process.env.AI_API_ENDPOINT,
    process.env.API_ENDPOINT,
  ];

  const out: Array<{
    baseUrl: string;
    rawEndpointUrl: string;
    hintedModel?: string;
    isOpenAiStyle: boolean;
  }> = [];
  const seen = new Set<string>();

  for (const raw of endpointVars) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const items = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object'
            ? [
                (parsed as Record<string, unknown>).endpoint ??
                  (parsed as Record<string, unknown>).baseUrl ??
                  (parsed as Record<string, unknown>).url,
              ]
            : [];
        for (const item of items) {
          const candidateUrl =
            typeof item === 'string'
              ? item
              : item && typeof item === 'object'
                ? String(
                    (item as Record<string, unknown>).endpoint ??
                      (item as Record<string, unknown>).baseUrl ??
                      (item as Record<string, unknown>).url ??
                      ''
                  )
                : '';
          const norm = normalizeGeminiEndpointUrl(candidateUrl);
          if (norm && !seen.has(norm.rawEndpointUrl)) {
            seen.add(norm.rawEndpointUrl);
            out.push(norm);
          }
        }
        continue;
      } catch {
        // fall through
      }
    }

    for (const part of parseEnvListValue(trimmed)) {
      const norm = normalizeGeminiEndpointUrl(part);
      if (norm && !seen.has(norm.rawEndpointUrl)) {
        seen.add(norm.rawEndpointUrl);
        out.push(norm);
      }
    }
  }

  for (const entry of getGeminiEnvKeyEndpointPairs()) {
    if (entry.baseUrl) {
      const norm = normalizeGeminiEndpointUrl(entry.baseUrl);
      if (norm && !seen.has(norm.rawEndpointUrl)) {
        seen.add(norm.rawEndpointUrl);
        out.push(norm);
      }
    }
  }

  return out;
}

export function getGeminiBaseUrlOverride(): string {
  const first = getGeminiEndpointOverrides()[0];
  return first ? first.baseUrl : '';
}

export function getGeminiEffectiveBaseUrl(): string {
  return getGeminiBaseUrlOverride() || DEFAULT_GEMINI_BASE_URL;
}

export function getGeminiEnvKeyEndpointPairs(): ParsedEnvKeyEntry[] {
  const explicitEnvVars = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEYS,
    process.env.GEMINI_KEYS,
    process.env.GEMINI_KEY_ARRAY,
    process.env.GEMINI_KEY_LIST,
    process.env.GEMINI_API_KEY_ARRAY,
    process.env.GEMINI_API_CONFIG,
    process.env.GEMINI_CONFIG,
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
    process.env.GEMINI_API_KEY_6,
    process.env.GEMINI_API_KEY_7,
    process.env.GEMINI_API_KEY_8,
    process.env.GEMINI_API_KEY_9,
    process.env.GEMINI_API_KEY_10,
    process.env.BACKUP_GEMINI_API_KEY,
    process.env.GEMINI_BACKUP_KEY,
    process.env.GEMINI_API_KEY_BACKUP,
    process.env.SECONDARY_GEMINI_API_KEY,
    process.env.MY_GEMINI_API_KEY,
    process.env.YOUR_GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_API_KEYS,
    process.env.GOOGLE_GEMINI_API_KEY,
    process.env.GOOGLE_GEMINI_API_KEYS,
    process.env.AI_API_KEY,
    process.env.AI_API_KEYS,
    process.env.API_KEYS,
  ];

  // Also scan any numbered or array-suffixed Gemini/Google env variables dynamically
  for (const [envName, envVal] of Object.entries(process.env)) {
    if (
      /^(?:GEMINI|GOOGLE_GEMINI|GOOGLE_AI|AI_CRAFT_GEMINI)(?:_API)?_KEYS?(?:_\d+|_BACKUP|_ARRAY|_LIST)?$/i.test(
        envName
      )
    ) {
      explicitEnvVars.push(envVal);
    }
  }

  const seen = new Set<string>();
  const entries: ParsedEnvKeyEntry[] = [];
  for (const raw of explicitEnvVars) {
    for (const candidate of parseKeyEntriesFromRaw(raw)) {
      const dedup = `${candidate.apiKey}::${candidate.baseUrl || ''}`;
      if (!seen.has(dedup)) {
        seen.add(dedup);
        entries.push(candidate);
      }
    }
  }
  return entries;
}

export function getServerGeminiApiKeys(): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const entry of getGeminiEnvKeyEndpointPairs()) {
    if (!seen.has(entry.apiKey)) {
      seen.add(entry.apiKey);
      keys.push(entry.apiKey);
    }
  }
  return keys;
}

export function getEnvGeminiModelsOverride(): string[] {
  const rawVars = [
    process.env.GEMINI_MODEL,
    process.env.GEMINI_MODELS,
    process.env.GEMINI_MODEL_ARRAY,
    process.env.GEMINI_MODELS_ARRAY,
    process.env.AI_MODELS,
    process.env.AI_MODEL,
  ];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawVars) {
    for (const item of parseEnvListValue(raw)) {
      const bare = item.replace(/^(?:gemini::|models\/)/i, '').trim();
      if (bare && isBuilderCompatibleGeminiModel(bare) && !seen.has(bare)) {
        seen.add(bare);
        out.push(bare);
      }
    }
  }
  for (const ep of getGeminiEndpointOverrides()) {
    if (ep.hintedModel && isBuilderCompatibleGeminiModel(ep.hintedModel) && !seen.has(ep.hintedModel)) {
      seen.add(ep.hintedModel);
      out.push(ep.hintedModel);
    }
  }
  return out;
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
 * Active modern Gemini models supported via `@google/genai`.
 * Free-tier friendly models lead the chain before paid-only reasoning variants.
 */
export const BACKEND_GEMINI_FAILOVER_CHAIN: ReadonlyArray<{
  upstreamModelId: string;
  label: string;
}> = [
  { upstreamModelId: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
  { upstreamModelId: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
  { upstreamModelId: 'gemini-4-neon', label: 'Gemini 4 Neon' },
  { upstreamModelId: 'gemini-4-argon', label: 'Gemini 4 Argon' },
  { upstreamModelId: 'gemini-4-carbon', label: 'Gemini 4 Carbon' },
  { upstreamModelId: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  { upstreamModelId: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { upstreamModelId: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash-Lite Preview' },
  { upstreamModelId: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { upstreamModelId: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
];

export const FREE_MESH_MODEL_LABELS: Record<string, string> = {
  'gemini::gemini-4-hydrogen': 'Gemini 4 Hydrogen',
  'gemini::gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
  'gemini::gemini-4-neon': 'Gemini 4 Neon',
  'gemini::gemini-4-argon': 'Gemini 4 Argon',
  'gemini::gemini-4-carbon': 'Gemini 4 Carbon',
};

export const GEMINI_BUILDER_MODELS: UnifiedAiModel[] = [
  {
    id: 'gemini::gemini-4-hydrogen',
    upstreamModelId: 'gemini-4-hydrogen',
    gateway: 'gemini',
    name: 'Gemini 4 Hydrogen',
    provider: 'gemini',
    contextLength: 1048576,
    isFree: true,
    tierLabel: 'Flagship · Thinking',
    capabilities: ['Thinking', 'Chat', 'Code', 'Vision'],
    category: 'code',
  },
  {
    id: 'gemini::gemini-3.1-flash-lite',
    upstreamModelId: 'gemini-3.1-flash-lite',
    gateway: 'gemini',
    name: 'Gemini 3.1 Flash-Lite',
    provider: 'gemini',
    contextLength: 1048576,
    isFree: true,
    tierLabel: 'Fast · Free Tier',
    capabilities: ['Fast', 'Chat', 'Code', 'Vision'],
    category: 'code',
  },
  {
    id: 'gemini::gemini-4-neon',
    upstreamModelId: 'gemini-4-neon',
    gateway: 'gemini',
    name: 'Gemini 4 Neon',
    provider: 'gemini',
    contextLength: 1048576,
    isFree: false,
    tierLabel: 'Pro · Architecture',
    capabilities: ['Architecture', 'Thinking', 'Code'],
    category: 'code',
  },
  {
    id: 'gemini::gemini-4-argon',
    upstreamModelId: 'gemini-4-argon',
    gateway: 'gemini',
    name: 'Gemini 4 Argon',
    provider: 'gemini',
    contextLength: 1048576,
    isFree: false,
    tierLabel: 'Code Specialist',
    capabilities: ['Coding', 'Debug', 'Refactor'],
    category: 'code',
  },
  {
    id: 'gemini::gemini-4-carbon',
    upstreamModelId: 'gemini-4-carbon',
    gateway: 'gemini',
    name: 'Gemini 4 Carbon',
    provider: 'gemini',
    contextLength: 1048576,
    isFree: false,
    tierLabel: 'Deep Reasoning',
    capabilities: ['Reasoning', 'Review', 'Code'],
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

/** Milliseconds until this cooldown expires (0 = not cooling down). */
export function gatewayCandidateCooldownRemainingMs(cooldownKey: string): number {
  const entry = endpointCooldowns.get(cooldownKey);
  if (!entry) return 0;
  const remaining = entry.until - Date.now();
  if (remaining <= 0) {
    endpointCooldowns.delete(cooldownKey);
    return 0;
  }
  return remaining;
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
    /^gemini-2\.0(?:\b|-)/.test(lower) ||
    /^gemini-3\.8\b/.test(lower) ||
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

  if (lower === 'gemini-4-hydrogen') score += preferFast ? 210 : 250;
  else if (lower === 'gemini-3.1-flash-lite') score += preferFast ? 245 : 220;
  else if (lower === 'gemini-4-neon') score += preferFast ? 110 : 185;
  else if (lower === 'gemini-4-argon') score += preferFast ? 120 : 175;
  else if (lower === 'gemini-4-carbon') score += preferFast ? 105 : 165;
  else if (lower === 'gemini-3-flash-preview') score += preferFast ? 190 : 155;
  else if (lower === 'gemini-3.1-pro-preview') score += preferFast ? 100 : 150;
  else if (lower.includes('hydrogen')) score += 180;
  else if (lower.includes('neon')) score += preferFast ? 95 : 155;
  else if (lower.includes('pro')) score += preferFast ? 90 : 145;
  else if (lower.includes('flash') && !lower.includes('lite')) score += preferFast ? 180 : 140;
  else if (lower.includes('argon')) score += 120;
  else if (lower.includes('carbon')) score += 110;
  else if (lower.includes('lite')) score += preferFast ? 170 : 115;

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
  forceRefresh = false,
  baseUrlOverride?: string
): Promise<string[]> {
  if (!apiKey) return [];
  const origin =
    (baseUrlOverride ? normalizeGeminiEndpointUrl(baseUrlOverride)?.baseUrl : '') ||
    getGeminiEffectiveBaseUrl();
  const fp = `${computeApiKeyFingerprint(apiKey)}:${origin}`;
  const cached = discoveredModelsCache.get(fp);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
    return cached.models;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3800);
    const url = `${origin}/v1beta/models?key=${encodeURIComponent(
      apiKey
    )}&pageSize=100`;
    const resp = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'aistudio-build',
        'x-goog-api-key': apiKey,
      },
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      return cached?.models || [];
    }

    const data = (await resp.json().catch(() => null)) as
      | {
          models?: Array<{
            name?: string;
            id?: string;
            supportedGenerationMethods?: string[];
          }>;
          data?: Array<{ id?: string; name?: string }>;
        }
      | Array<{ name?: string; id?: string; supportedGenerationMethods?: string[] }>
      | null;

    const rawModels = Array.isArray(data)
      ? data
      : Array.isArray(data?.models)
        ? data.models
        : Array.isArray(data?.data)
          ? data.data
          : [];
    const usable: string[] = [];
    for (const item of rawModels) {
      const methods =
        'supportedGenerationMethods' in item &&
        Array.isArray(item.supportedGenerationMethods)
          ? item.supportedGenerationMethods
          : [];
      if (methods.length > 0 && !methods.includes('generateContent')) continue;
      const rawName =
        typeof item === 'string'
          ? item
          : String(item?.name || item?.id || '');
      const bare = rawName.replace(/^models\//i, '').trim();
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

export function makeGeminiDisplayLabel(upstreamModelId: string): string {
  const staticEntry = BACKEND_GEMINI_FAILOVER_CHAIN.find(
    (m) => m.upstreamModelId === upstreamModelId
  );
  if (staticEntry) return staticEntry.label;
  return `Gemini (${upstreamModelId})`;
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

  const pairs = getGeminiEnvKeyEndpointPairs();
  const pairByKey = new Map<string, ParsedEnvKeyEntry>();
  for (const p of pairs) {
    if (!pairByKey.has(p.apiKey) || p.baseUrl) {
      pairByKey.set(p.apiKey, p);
    }
  }
  const defaultEp = getGeminiEndpointOverrides().find((ep) => !ep.isOpenAiStyle);

  const discoveredPerKey = await Promise.all(
    keysToUse.map((k) => {
      const pair = pairByKey.get(k);
      const baseOverride = !pair?.isOpenAiStyle
        ? pair?.baseUrl || defaultEp?.baseUrl
        : undefined;
      return discoverLiveGeminiModelsForKey(k, forceRefresh, baseOverride);
    })
  );

  const readyCandidates: DynamicGeminiCandidate[] = [];
  const coolingCandidates: DynamicGeminiCandidate[] = [];
  const seenKeyModel = new Set<string>();

  const perKeyOrderedModels: Array<{ apiKey: string; items: DynamicGeminiCandidate[] }> =
    keysToUse.map((apiKey, keyIdx) => {
      const pair = pairByKey.get(apiKey);
      const effectiveBaseUrl = pair?.baseUrl || defaultEp?.baseUrl;
      const fp = computeApiKeyFingerprint(apiKey);
      const mask = computeApiKeyMask(apiKey);
      const liveList = [...(discoveredPerKey[keyIdx] || [])].sort(
        (a, b) =>
          scoreDiscoveredGeminiModel(b, taskKind) - scoreDiscoveredGeminiModel(a, taskKind)
      );

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
        label: makeGeminiDisplayLabel(id),
        cooldownKey: buildCandidateCooldownKey('gemini', apiKey, id),
        confirmedLive,
        thinkingMode: inferGeminiThinkingMode(id),
        isGemini4Series: isGemini4SeriesModel(id),
        ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
        ...(pair?.isOpenAiStyle ? { isOpenAiStyle: true } : {}),
      }));

      return { apiKey, items };
    });

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
  const bare = raw.replace(/^(?:gemini|models)::/i, '').replace(/^models\//i, '').trim();

  if (
    bare &&
    bare !== 'auto' &&
    !raw.startsWith('agentrouter::') &&
    !raw.startsWith('mesh::') &&
    !isDeprecatedGeminiModelId(bare)
  ) {
    const matched =
      GEMINI_BUILDER_MODELS.find(
        (m) => m.id === raw || m.upstreamModelId === bare
      ) ??
      BACKEND_GEMINI_FAILOVER_CHAIN.find((m) => m.upstreamModelId === bare);

    if (matched) {
      return { gateway: 'gemini', upstreamModelId: matched.upstreamModelId };
    }
    if (bare.startsWith('gemini-') && isBuilderCompatibleGeminiModel(bare)) {
      return { gateway: 'gemini', upstreamModelId: bare };
    }
  }

  return { gateway: 'gemini', upstreamModelId: 'gemini-4-hydrogen' };
}

export function classifyGatewayModelCapabilities(): {
  capabilities: string[];
  category: FreeModelCategory;
} {
  return { capabilities: ['Thinking', 'Vision', 'Code', 'DB'], category: 'code' };
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
      label: 'Google Gemini',
      baseUrl: getGeminiEffectiveBaseUrl(),
      configured: geminiConfigured,
      keyCount: keys.length,
      modelCount: GEMINI_BUILDER_MODELS.length,
      defaultModel: DEFAULT_BUILDER_MODEL_ID,
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
    ) ?? null;

  return {
    pollinationsCandidates: [],
    requestedMediaKind: null,
    requestedModelLabel: matched ? matched.name : makeGeminiDisplayLabel(parsed.upstreamModelId),
  };
}
