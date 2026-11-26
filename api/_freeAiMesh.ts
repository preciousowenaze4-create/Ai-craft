/**
 * AI Craft — AgentRouter Brain Engine
 *
 * Routes every chat and build request directly to the user's configured
 * AgentRouter backend (`AGENTROUTER_API_KEY` + `AGENTROUTER_BASE_URL`).
 * All built-in free/keyless providers (Pollinations, Groq, Cerebras, OpenRouter,
 * Mistral, HuggingFace, GitHub, Together, DeepInfra, etc.) have been removed.
 *
 * Supports all 3 AgentRouter wire protocols seen in AgentRouter model badges:
 *  - `/v1/chat/completions` (OpenAI Chat Completions)
 *  - `/v1/responses` (OpenAI Responses API fallback)
 *  - `/v1/messages` (Anthropic Claude native for `claude-*` models)
 */

import {
  buildCandidateCooldownKey,
  gatewayCandidateCooldownRemainingMs,
  markGatewayCandidateCooldown,
} from './_aiGateways.js';
import {
  FREE_MODEL_CATALOG,
  nextDailyResetAt,
  staticCatalogSize,
  utcQuotaDay,
} from './_freeAiCatalog.js';

// ---------------------------------------------------------------------------
// Types & typed errors
// ---------------------------------------------------------------------------

export interface MeshStreamResult {
  rawOutput: string;
  modelUsed: string;
  modelName: string;
  provider: string;
}

export interface MeshProviderStatus {
  id: string;
  label: string;
  keyless: boolean;
  configured: boolean;
  modelCount: number;
}

export class FreeAiMeshUnavailableError extends Error {
  readonly code = 'mesh_unavailable' as const;
  constructor() {
    super(
      'AgentRouter API key is not configured on the backend. Add AGENTROUTER_API_KEY in your project Secrets.'
    );
    this.name = 'FreeAiMeshUnavailableError';
  }
}

export class FreeAiMeshAllFailedError extends Error {
  readonly code = 'mesh_all_failed' as const;
  readonly details: string[];
  constructor(details: string[]) {
    const tail = details
      .slice(-2)
      .map((d) => (d.length > 140 ? `${d.slice(0, 140)}...` : d))
      .join('; ');
    super(
      `AgentRouter request failed${tail ? ` (${tail})` : ''}. Check your AgentRouter API key and try again.`
    );
    this.name = 'FreeAiMeshAllFailedError';
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function cleanPastedSecret(rawValue: string | undefined): {
  cleaned: string;
  hadQuotes: boolean;
  hadAssignPrefix: boolean;
  hadBearerPrefix: boolean;
  hadWhitespace: boolean;
  looksLikeUrl: boolean;
} {
  if (typeof rawValue !== 'string') {
    return {
      cleaned: '',
      hadQuotes: false,
      hadAssignPrefix: false,
      hadBearerPrefix: false,
      hadWhitespace: false,
      looksLikeUrl: false,
    };
  }
  let s = rawValue.trim();
  const hadAssignPrefix = /^(?:export\s+)?[A-Z0-9_]+\s*=\s*/i.test(s);
  if (hadAssignPrefix) {
    s = s.replace(/^(?:export\s+)?[A-Z0-9_]+\s*=\s*/i, '').trim();
  }
  const strippedQuotes = s
    .replace(/^[`"'\u201c\u201d\u2018\u2019]+|[`"'\u201c\u201d\u2018\u2019;,]+$/g, '')
    .trim();
  const hadQuotes = strippedQuotes !== s;
  s = strippedQuotes;
  const hadBearerPrefix = /^bearer\s+/i.test(s);
  if (hadBearerPrefix) {
    s = s.replace(/^bearer\s+/i, '').trim();
  }
  const hadWhitespace = /\s/.test(s);
  if (hadWhitespace) {
    const skMatch = s.match(/sk-[A-Za-z0-9._-]+/);
    s = skMatch ? skMatch[0] : s.replace(/\s+/g, '');
  }
  const looksLikeUrl = /^https?:\/\//i.test(s);
  return {
    cleaned: s,
    hadQuotes,
    hadAssignPrefix,
    hadBearerPrefix,
    hadWhitespace,
    looksLikeUrl,
  };
}

function readEnvCsv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function readEnvNumber(name: string, defaultValue: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return Math.floor(parsed);
}

function toChatCompletionsUrl(rawBase: string): string {
  const base = rawBase.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function toResponsesUrl(v1Origin: string): string {
  const base = v1Origin.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return /\/v1$/i.test(base) ? `${base}/responses` : `${base}/v1/responses`;
}

function toMessagesUrl(v1Origin: string): string {
  const base = v1Origin.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

// ---------------------------------------------------------------------------
// Abortable sleep + per-provider concurrency slot
// ---------------------------------------------------------------------------

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request cancelled.'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Request cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const providerInFlight = new Map<string, number>();

function providerConcurrencyLimit(): number {
  return Math.max(1, readEnvNumber('MESH_PROVIDER_CONCURRENCY', 6));
}

async function acquireProviderSlot(
  providerId: string,
  signal?: AbortSignal
): Promise<void> {
  const limit = providerConcurrencyLimit();
  const startedAt = Date.now();
  const maxWaitMs = 120_000;
  for (;;) {
    if (signal?.aborted) throw new Error('Request cancelled.');
    const current = providerInFlight.get(providerId) ?? 0;
    if (current < limit) {
      providerInFlight.set(providerId, current + 1);
      return;
    }
    if (Date.now() - startedAt > maxWaitMs) {
      throw new MeshHttpError('Timed out waiting for AgentRouter slot', null);
    }
    await sleepWithSignal(120, signal);
  }
}

function releaseProviderSlot(providerId: string): void {
  const current = providerInFlight.get(providerId) ?? 0;
  if (current <= 1) providerInFlight.delete(providerId);
  else providerInFlight.set(providerId, current - 1);
}

// ---------------------------------------------------------------------------
// AgentRouter credentials, model discovery & diagnostics
// ---------------------------------------------------------------------------

const AGENTROUTER_DEFAULT_BASE = 'https://co.agentrouter.org/v1';

let agentRouterModelsCache: { models: string[]; at: number } | null = null;
let agentRouterRefreshInFlight = false;

function normalizeAgentRouterOrigin(rawBase: string): string {
  const trimmed = rawBase.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return AGENTROUTER_DEFAULT_BASE;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    // agentrouter.org (root/www) serves the web dashboard behind an interactive
    // Aliyun WAF captcha; API calls use co.agentrouter.org/v1.
    if (host === 'agentrouter.org' || host === 'www.agentrouter.org') {
      parsed.protocol = 'https:';
      parsed.hostname = 'co.agentrouter.org';
    }
    const cleanPath = parsed.pathname
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/i, '');
    const v1Path = /\/v1$/i.test(cleanPath)
      ? cleanPath
      : cleanPath && cleanPath !== '/'
        ? `${cleanPath}/v1`
        : '/v1';
    return `${parsed.origin}${v1Path}`;
  } catch {
    return AGENTROUTER_DEFAULT_BASE;
  }
}

function getAgentRouterCredentials(): {
  apiKey: string;
  baseUrl: string;
  v1Origin: string;
  keyEnvName: string;
  baseEnvName: string;
  keyShape: {
    hadQuotes: boolean;
    hadAssignPrefix: boolean;
    hadBearerPrefix: boolean;
    hadWhitespace: boolean;
    looksLikeUrl: boolean;
    looksLikeSkToken: boolean;
    lengthOk: boolean;
  };
} | null {
  const keyNames = [
    'AGENTROUTER_API_KEY',
    'AGENT_ROUTER_API_KEY',
    'AGENTROUTER_KEY',
    'AGENTROUTER_TOKEN',
  ];
  let matchedKeyName = '';
  let keyInfo = cleanPastedSecret(undefined);
  for (const name of keyNames) {
    const info = cleanPastedSecret(process.env[name]);
    if (!info.cleaned) continue;
    if (/^(my[_-]|your[_-]|xxx+|<|change[-_]?me|placeholder)/i.test(info.cleaned)) {
      continue;
    }
    matchedKeyName = name;
    keyInfo = info;
    break;
  }
  if (!matchedKeyName || !keyInfo.cleaned || keyInfo.looksLikeUrl) return null;

  const baseNames = ['AGENTROUTER_BASE_URL', 'AGENT_ROUTER_BASE_URL'];
  let matchedBaseName = '';
  let rawBase = '';
  for (const name of baseNames) {
    const val = (process.env[name] || '').trim().replace(/^["'`]|["'`]$/g, '');
    if (val && /^https?:\/\//i.test(val)) {
      matchedBaseName = name;
      rawBase = val;
      break;
    }
  }
  if (!rawBase) rawBase = AGENTROUTER_DEFAULT_BASE;
  const v1Origin = normalizeAgentRouterOrigin(rawBase);
  return {
    apiKey: keyInfo.cleaned,
    baseUrl: toChatCompletionsUrl(v1Origin),
    v1Origin,
    keyEnvName: matchedKeyName,
    baseEnvName: matchedBaseName || 'default',
    keyShape: {
      hadQuotes: keyInfo.hadQuotes,
      hadAssignPrefix: keyInfo.hadAssignPrefix,
      hadBearerPrefix: keyInfo.hadBearerPrefix,
      hadWhitespace: keyInfo.hadWhitespace,
      looksLikeUrl: keyInfo.looksLikeUrl,
      looksLikeSkToken: /^sk-/i.test(keyInfo.cleaned),
      lengthOk: keyInfo.cleaned.length >= 12,
    },
  };
}

let lastAgentRouterDiag: {
  checkedAt: string;
  endpoint: string;
  status: number | null;
  message: string;
} | null = null;

function sanitizeDiagMessage(rawMessage: string): string {
  return String(rawMessage || '')
    .replace(/sk-[A-Za-z0-9._-]{6,}/g, 'sk-***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .trim()
    .slice(0, 220);
}

function recordAgentRouterDiag(
  endpoint: string,
  status: number | null,
  rawMessage: string
): void {
  lastAgentRouterDiag = {
    checkedAt: new Date().toISOString(),
    endpoint,
    status,
    message: sanitizeDiagMessage(rawMessage),
  };
}

export function getAgentRouterDiagnostic(): {
  configured: boolean;
  apiOrigin: string;
  lastCheckedAt: string | null;
  lastEndpoint: string | null;
  lastStatus: number | null;
  lastMessage: string | null;
} {
  const creds = getAgentRouterCredentials();
  return {
    configured: Boolean(creds),
    apiOrigin: creds?.v1Origin || AGENTROUTER_DEFAULT_BASE,
    lastCheckedAt: lastAgentRouterDiag?.checkedAt ?? null,
    lastEndpoint: lastAgentRouterDiag?.endpoint ?? null,
    lastStatus: lastAgentRouterDiag?.status ?? null,
    lastMessage: lastAgentRouterDiag?.message ?? null,
  };
}

export function isAgentRouterConfigured(): boolean {
  return Boolean(getAgentRouterCredentials());
}

export function getAgentRouterApiOrigin(): string {
  return getAgentRouterCredentials()?.v1Origin || AGENTROUTER_DEFAULT_BASE;
}

const AGENTROUTER_CLIENT_HEADERS = {
  'User-Agent': 'codex_cli_rs/0.34.0',
  Accept: 'application/json',
};

function scheduleAgentRouterModelsRefresh(v1Origin: string, apiKey: string): void {
  if (agentRouterRefreshInFlight) return;
  agentRouterRefreshInFlight = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  fetch(`${v1Origin}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...AGENTROUTER_CLIENT_HEADERS,
    },
    signal: controller.signal,
  })
    .then((res) => {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok || ct.includes('text/html')) return null;
      return res.json();
    })
    .then((payload: unknown) => {
      const list = Array.isArray((payload as { data?: unknown[] } | null)?.data)
        ? (payload as { data: unknown[] }).data
        : Array.isArray(payload)
          ? payload
          : [];
      const names: string[] = [];
      for (const entry of list) {
        const id =
          typeof entry === 'string'
            ? entry.trim()
            : entry && typeof entry === 'object' && 'id' in entry
              ? String((entry as { id: unknown }).id || '').trim()
              : '';
        if (!id || names.includes(id)) continue;
        if (
          /^(whisper|tts|dall-e|gpt-image|text-embedding|embedding|moderation)/i.test(id)
        ) {
          continue;
        }
        names.push(id);
        if (names.length >= 40) break;
      }
      if (names.length > 0) {
        agentRouterModelsCache = { models: names, at: Date.now() };
      }
    })
    .catch(() => undefined)
    .finally(() => {
      agentRouterRefreshInFlight = false;
      clearTimeout(timer);
    });
}

export async function refreshAgentRouterModelsIfConfigured(): Promise<string[]> {
  const creds = getAgentRouterCredentials();
  if (!creds) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(`${creds.v1Origin}/models`, {
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        ...AGENTROUTER_CLIENT_HEADERS,
      },
      signal: controller.signal,
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || ct.includes('text/html')) {
      const errBody = await res.text().catch(() => '');
      recordAgentRouterDiag(
        `${creds.v1Origin}/models`,
        res.status,
        ct.includes('text/html') ? 'HTML/WAF response' : errBody || `HTTP ${res.status}`
      );
      return resolveAgentRouterModels(creds.v1Origin, creds.apiKey);
    }
    const payload = (await res.json().catch(() => null)) as
      | { data?: unknown[]; code?: number; msg?: string }
      | unknown[]
      | null;
    if (
      payload &&
      !Array.isArray(payload) &&
      typeof payload.code === 'number' &&
      payload.code !== 0 &&
      payload.code !== 200
    ) {
      recordAgentRouterDiag(
        `${creds.v1Origin}/models`,
        payload.code,
        payload.msg || 'AgentRouter error'
      );
      return resolveAgentRouterModels(creds.v1Origin, creds.apiKey);
    }
    const list = Array.isArray((payload as { data?: unknown[] } | null)?.data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray(payload)
        ? payload
        : [];
    recordAgentRouterDiag(
      `${creds.v1Origin}/models`,
      res.status,
      `ok (${list.length} models)`
    );
    const names: string[] = [];
    for (const entry of list) {
      const id =
        typeof entry === 'string'
          ? entry.trim()
          : entry && typeof entry === 'object' && 'id' in entry
            ? String((entry as { id: unknown }).id || '').trim()
            : '';
      if (!id || names.includes(id)) continue;
      if (
        /^(whisper|tts|dall-e|gpt-image|text-embedding|embedding|moderation)/i.test(id)
      ) {
        continue;
      }
      names.push(id);
      if (names.length >= 40) break;
    }
    if (names.length > 0) {
      agentRouterModelsCache = { models: names, at: Date.now() };
    }
  } catch {
    // keep cached/fallback list
  } finally {
    clearTimeout(timer);
  }
  return resolveAgentRouterModels(creds.v1Origin, creds.apiKey);
}

function resolveAgentRouterModels(v1Origin: string, apiKey: string): string[] {
  const singleOverride = (process.env.AGENTROUTER_MODEL || '').trim();
  const csvOverride = readEnvCsv('AGENTROUTER_MODELS');
  const envModels = [
    ...singleOverride.split(',').map((s) => s.trim()).filter(Boolean),
    ...csvOverride,
  ].filter((m, idx, arr) => arr.indexOf(m) === idx);

  const cacheFresh =
    agentRouterModelsCache && Date.now() - agentRouterModelsCache.at < 10 * 60_000;
  if (!cacheFresh) {
    scheduleAgentRouterModelsRefresh(v1Origin, apiKey);
  }
  const live = agentRouterModelsCache?.models || [];
  const baseList =
    live.length > 0
      ? [
          ...FREE_MODEL_CATALOG.agentrouter.filter((m) => live.includes(m)),
          ...live.filter((m) => !FREE_MODEL_CATALOG.agentrouter.includes(m)),
        ]
      : FREE_MODEL_CATALOG.agentrouter;

  if (envModels.length > 0) {
    return [...envModels, ...baseList.filter((m) => !envModels.includes(m))].slice(0, 24);
  }
  return baseList.slice(0, 24);
}

interface ResolvedMeshProvider {
  baseUrl: string;
  v1Origin: string;
  apiKey: string;
  models: string[];
  headers?: Record<string, string>;
}

interface MeshProviderDef {
  id: string;
  label: string;
  keyless: boolean;
  resolve(): ResolvedMeshProvider | null;
}

const MESH_PROVIDERS: MeshProviderDef[] = [
  {
    id: 'agentrouter',
    label: 'AgentRouter',
    keyless: false,
    resolve() {
      const creds = getAgentRouterCredentials();
      if (!creds) return null;
      return {
        baseUrl: creds.baseUrl,
        v1Origin: creds.v1Origin,
        apiKey: creds.apiKey,
        models: resolveAgentRouterModels(creds.v1Origin, creds.apiKey),
        headers: {
          'User-Agent': 'codex_cli_rs/0.34.0',
          'X-Title': 'AI Craft',
        },
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Candidates, cooldowns, quotas & budgets
// ---------------------------------------------------------------------------

interface MeshCandidate {
  providerId: string;
  providerLabel: string;
  keyless: boolean;
  baseUrl: string;
  v1Origin: string;
  apiKey: string;
  headers?: Record<string, string>;
  model: string;
  cooldownKey: string;
}

const MAX_MODELS_PER_PROVIDER = 8;
const MAX_ATTEMPTS_PER_WALK = 8;

const dailyUsage = new Map<string, number>();

function dailyQuotaKey(providerId: string, model: string): string {
  return `${providerId}|${model}|${utcQuotaDay()}`;
}

function dailyLimitPerModel(): number {
  return readEnvNumber('MESH_DAILY_LIMIT_PER_MODEL', 400);
}

function isDailyQuotaExhausted(providerId: string, model: string): boolean {
  const used = dailyUsage.get(dailyQuotaKey(providerId, model)) ?? 0;
  return used >= dailyLimitPerModel();
}

function recordDailyUsage(providerId: string, model: string): void {
  const key = dailyQuotaKey(providerId, model);
  dailyUsage.set(key, (dailyUsage.get(key) ?? 0) + 1);
}

export function getMeshDailyUsage(): Record<string, number> {
  return Object.fromEntries(dailyUsage);
}

export function resetMeshDailyUsage(): void {
  dailyUsage.clear();
}

/** Single-brain AgentRouter execution (never spawns 3 competing free AIs). */
export function isMeshParallelBuildsEnabled(): boolean {
  return false;
}

interface MeshWalkBudget {
  firstByteMs: number;
  idleMs: number;
  walkMs: number;
  maxAttempts: number;
}

function budgetFor(taskKind: 'chat' | 'build'): MeshWalkBudget {
  if (taskKind === 'chat') {
    return { firstByteMs: 30_000, idleMs: 35_000, walkMs: 75_000, maxAttempts: 6 };
  }
  return { firstByteMs: 45_000, idleMs: 60_000, walkMs: 120_000, maxAttempts: 8 };
}

function enumerateMeshCandidates(): Array<{ candidate: MeshCandidate; coolingMs: number }> {
  const all: Array<{ candidate: MeshCandidate; coolingMs: number }> = [];
  for (const def of MESH_PROVIDERS) {
    let resolved: ResolvedMeshProvider | null = null;
    try {
      resolved = def.resolve();
    } catch {
      resolved = null;
    }
    if (!resolved) continue;
    for (const model of resolved.models.slice(0, MAX_MODELS_PER_PROVIDER)) {
      if (isDailyQuotaExhausted(def.id, model)) continue;
      const cooldownKey = buildCandidateCooldownKey(
        `mesh:${def.id}`,
        resolved.apiKey || def.id,
        model
      );
      all.push({
        candidate: {
          providerId: def.id,
          providerLabel: def.label,
          keyless: def.keyless,
          baseUrl: resolved.baseUrl,
          v1Origin: resolved.v1Origin,
          apiKey: resolved.apiKey,
          headers: resolved.headers,
          model,
          cooldownKey,
        },
        coolingMs: gatewayCandidateCooldownRemainingMs(cooldownKey),
      });
    }
  }
  return all;
}

function buildMeshCandidates(): MeshCandidate[] {
  const out: MeshCandidate[] = [];
  for (const entry of enumerateMeshCandidates()) {
    if (entry.coolingMs > 0) continue;
    out.push(entry.candidate);
    if (out.length >= MAX_ATTEMPTS_PER_WALK) break;
  }
  return out;
}

function prioritizeCandidatesForRequestedModel(
  candidates: MeshCandidate[],
  requestedModel?: string
): MeshCandidate[] {
  const req = (requestedModel || '').trim();
  if (!req) return candidates;

  if (req.startsWith('agentrouter::')) {
    const targetModel = req.slice('agentrouter::'.length).trim();
    if (!targetModel || targetModel === 'auto') {
      return candidates;
    }
    const exact = candidates.filter((c) => c.model === targetModel);
    const sameProvider = candidates.filter((c) => c.model !== targetModel);
    if (exact.length > 0) {
      return [...exact, ...sameProvider];
    }
    const creds = getAgentRouterCredentials();
    if (creds) {
      const cooldownKey = buildCandidateCooldownKey(
        'mesh:agentrouter',
        creds.apiKey,
        targetModel
      );
      if (
        gatewayCandidateCooldownRemainingMs(cooldownKey) <= 0 &&
        !isDailyQuotaExhausted('agentrouter', targetModel)
      ) {
        return [
          {
            providerId: 'agentrouter',
            providerLabel: 'AgentRouter',
            keyless: false,
            baseUrl: creds.baseUrl,
            v1Origin: creds.v1Origin,
            apiKey: creds.apiKey,
            headers: {
              'User-Agent': 'codex_cli_rs/0.34.0',
              'X-Title': 'AI Craft',
            },
            model: targetModel,
            cooldownKey,
          },
          ...sameProvider,
        ];
      }
    }
    return sameProvider;
  }

  return candidates;
}

function earliestMeshCooldownMs(): number {
  let earliest = 0;
  for (const entry of enumerateMeshCandidates()) {
    if (entry.coolingMs <= 0) return 0;
    if (earliest === 0 || entry.coolingMs < earliest) earliest = entry.coolingMs;
  }
  return earliest;
}

export function isFreeAiMeshAvailable(): boolean {
  try {
    return buildMeshCandidates().length > 0;
  } catch {
    return false;
  }
}

export function getFreeAiMeshStatus(): {
  providers: MeshProviderStatus[];
  hasAny: boolean;
  hasKeyless: boolean;
  pollinationsEnabled: boolean;
  pollinationsConfigured: boolean;
  modelPool: {
    activeModels: number;
    catalogSize: number;
    dailyResetsAt: string;
    dailyLimitPerModel: number;
  };
} {
  const providers: MeshProviderStatus[] = [];
  for (const def of MESH_PROVIDERS) {
    let resolved: ResolvedMeshProvider | null = null;
    try {
      resolved = def.resolve();
    } catch {
      resolved = null;
    }
    providers.push({
      id: def.id,
      label: def.label,
      keyless: def.keyless,
      configured: Boolean(resolved),
      modelCount: resolved ? resolved.models.length : 0,
    });
  }
  const hasAny = providers.some((p) => p.configured);
  return {
    providers,
    hasAny,
    hasKeyless: false,
    pollinationsEnabled: false,
    pollinationsConfigured: false,
    modelPool: {
      activeModels: (() => {
        try {
          return buildMeshCandidates().length;
        } catch {
          return 0;
        }
      })(),
      catalogSize: staticCatalogSize(),
      dailyResetsAt: nextDailyResetAt(),
      dailyLimitPerModel: dailyLimitPerModel(),
    },
  };
}

export interface FreeMeshModelOption {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  isFree: boolean;
  gateway?: 'auto' | 'gemini' | 'web-search' | 'browser';
  tierLabel?: string;
  capabilities?: string[];
  category?: 'router' | 'code' | 'image' | 'music' | 'video' | 'chat';
}

export function getFreeMeshModelOptions(): FreeMeshModelOption[] {
  const creds = getAgentRouterCredentials();
  const arModels = creds
    ? resolveAgentRouterModels(creds.v1Origin, creds.apiKey)
    : FREE_MODEL_CATALOG.agentrouter;

  const options: FreeMeshModelOption[] = [
    {
      id: 'agentrouter::auto',
      name: 'AgentRouter · Auto',
      provider: 'agentrouter',
      contextLength: 262144,
      isFree: false,
      gateway: 'auto',
      tierLabel: 'Thinking · Auto',
      capabilities: ['Thinking', 'Chat', 'Code'],
      category: 'code',
    },
  ];

  for (const modelId of arModels.slice(0, 12)) {
    const isClaudeNative = /^claude/i.test(modelId);
    options.push({
      id: `agentrouter::${modelId}`,
      name: `AgentRouter · ${modelId}`,
      provider: 'agentrouter',
      contextLength: 262144,
      isFree: false,
      gateway: 'auto',
      tierLabel: isClaudeNative ? 'Claude Native' : 'Chat · Responses',
      capabilities: ['Thinking', 'Chat', 'Code'],
      category: 'code',
    });
  }

  return options;
}

interface MeshErrorInfo {
  status: number | null;
  message: string;
}

function normalizeMeshError(err: unknown): MeshErrorInfo {
  if (err && typeof err === 'object') {
    const anyErr = err as {
      status?: number;
      statusCode?: number;
      message?: string;
      body?: unknown;
    };
    const status =
      typeof anyErr.status === 'number'
        ? anyErr.status
        : typeof anyErr.statusCode === 'number'
          ? anyErr.statusCode
          : null;
    let message = typeof anyErr.message === 'string' ? anyErr.message : String(err);
    if (anyErr.body != null) {
      try {
        const text =
          typeof anyErr.body === 'string' ? anyErr.body : JSON.stringify(anyErr.body);
        const parsed = JSON.parse(text) as {
          error?: { message?: string; code?: string; type?: string };
          message?: string;
          msg?: string;
        };
        message = parsed?.error?.message || parsed?.message || parsed?.msg || message;
      } catch {
        // keep original message
      }
    }
    return { status, message: message.slice(0, 300) };
  }
  return { status: null, message: String(err).slice(0, 300) };
}

export function isBusyMeshError(info: MeshErrorInfo): boolean {
  const lower = info.message.toLowerCase();
  return /previous request is still running|1 request at a time per ip|wait for it to finish/.test(
    lower
  );
}

function isAuthError(info: MeshErrorInfo): boolean {
  const lower = info.message.toLowerCase();
  return (
    info.status === 401 ||
    info.status === 403 ||
    /invalid.?api.?key|incorrect api key|unauthorized|forbidden|authentication/.test(lower)
  );
}

export function cooldownForMeshError(
  info: MeshErrorInfo
): { ms: number; hard: boolean } {
  const lower = info.message.toLowerCase();
  if (isBusyMeshError(info)) {
    return { ms: 6_000, hard: false };
  }
  if (isAuthError(info)) {
    // Keep auth cooldown short (15s) so if the user updates their key or retries,
    // it recovers promptly without sticking for 10 minutes.
    return { ms: 15_000, hard: false };
  }
  if (
    info.status === 404 ||
    /model[_ ]?not[_ ]?found|does not exist|unknown model|no such model|deprecated model/.test(
      lower
    )
  ) {
    return { ms: 5 * 60_000, hard: true };
  }
  if (info.status === 402 || /\bbilling\b|payment required|credit/.test(lower)) {
    return { ms: 5 * 60_000, hard: true };
  }
  if (
    info.status === 429 ||
    /rate.?limit|too many requests|quota|quota exceeded|limit reached|overloaded/.test(lower)
  ) {
    return { ms: 45_000, hard: false };
  }
  if (info.status !== null && info.status >= 500) {
    return { ms: 20_000, hard: false };
  }
  return { ms: 20_000, hard: false };
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------

interface MeshMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

function buildMeshMessages(params: {
  systemPrompt: string;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  withImage?: boolean;
}): MeshMessage[] {
  const messages: MeshMessage[] = [];
  const system = params.systemPrompt.trim();
  if (system) messages.push({ role: 'system', content: system.slice(0, 60000) });
  const history = params.historyMessages || [];
  for (const item of history.slice(-10)) {
    if (!item?.content) continue;
    messages.push({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: String(item.content).slice(0, 4000),
    });
  }
  const prompt = params.userPrompt.slice(0, 30000);
  if (params.withImage && params.attachmentDataUrl?.startsWith('data:image/')) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: params.attachmentDataUrl } },
      ],
    });
  } else {
    messages.push({ role: 'user', content: prompt });
  }
  return messages;
}

function buildAnthropicMessages(params: {
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  withImage?: boolean;
}): Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> {
  const out: Array<{
    role: 'user' | 'assistant';
    content: string | Array<Record<string, unknown>>;
  }> = [];
  for (const item of (params.historyMessages || []).slice(-10)) {
    if (!item?.content) continue;
    out.push({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: String(item.content).slice(0, 4000),
    });
  }
  const prompt = params.userPrompt.slice(0, 30000);
  if (params.withImage && params.attachmentDataUrl?.startsWith('data:image/')) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(
      params.attachmentDataUrl
    );
    if (match?.[1] && match?.[2]) {
      out.push({
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: match[1], data: match[2] },
          },
          { type: 'text', text: prompt },
        ],
      });
      return out;
    }
  }
  out.push({ role: 'user', content: prompt });
  return out;
}

// ---------------------------------------------------------------------------
// HTTP: one candidate, streaming + non-streaming (Chat Completions, Responses, Claude Messages)
// ---------------------------------------------------------------------------

interface MeshAttemptParams {
  taskKind: 'chat' | 'build';
  systemPrompt: string;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  signal?: AbortController;
  firstByteTimeoutMs: number;
  idleTimeoutMs?: number;
}

class MeshHttpError extends Error {
  readonly status: number | null;
  readonly body: unknown;
  constructor(message: string, status: number | null, body?: unknown) {
    super(message);
    this.name = 'MeshHttpError';
    this.status = status;
    this.body = body;
  }
}

async function readMeshResponseBody(res: Response): Promise<{ text: string; json: unknown }> {
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { text, json };
}

function extractOpenAiError(json: unknown, fallback: string): string {
  if (json && typeof json === 'object') {
    const obj = json as {
      error?: { message?: string; code?: string; type?: string };
      message?: string;
      msg?: string;
      detail?: string;
    };
    const msg = obj.error?.message || obj.message || obj.msg || obj.detail;
    if (typeof msg === 'string' && msg.trim()) return msg.slice(0, 300);
  }
  return fallback.slice(0, 300);
}

async function postJsonEndpoint(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  candidate: MeshCandidate,
  params: MeshAttemptParams
): Promise<Response> {
  const controller = new AbortController();
  const outerSignal = params.signal?.signal;
  if (outerSignal?.aborted) throw new Error('Request cancelled.');
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, params.firstByteTimeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const { text, json } = await readMeshResponseBody(res).catch(() => ({
        text: '',
        json: null,
      }));
      const errMsg = extractOpenAiError(json, text || `HTTP ${res.status}`);
      recordAgentRouterDiag(`${url} [${candidate.model}]`, res.status, errMsg);
      throw new MeshHttpError(errMsg, res.status, json ?? text);
    }
    recordAgentRouterDiag(`${url} [${candidate.model}]`, res.status, 'connected');
    return res;
  } catch (err) {
    if (err instanceof MeshHttpError) throw err;
    const msg = timedOut
      ? 'Timed out waiting for AgentRouter response'
      : err instanceof Error
        ? err.message
        : String(err);
    recordAgentRouterDiag(`${url} [${candidate.model}]`, null, msg);
    if (timedOut) throw new MeshHttpError('Timed out waiting for AgentRouter response', null);
    throw err;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

type ProtocolKind = 'chat_completions' | 'responses' | 'anthropic_messages';

function protocolsForCandidate(model: string): ProtocolKind[] {
  if (/^claude/i.test(model.trim())) {
    return ['anthropic_messages', 'chat_completions', 'responses'];
  }
  return ['chat_completions', 'responses'];
}

function shouldFallbackProtocol(err: unknown): boolean {
  const info = normalizeMeshError(err);
  if (isAuthError(info)) return false;
  const lower = info.message.toLowerCase();
  return (
    info.status === 404 ||
    info.status === 405 ||
    info.status === 415 ||
    /unsupported|not supported|unknown endpoint|use \/v1\/(responses|messages)|claude_native/.test(
      lower
    )
  );
}

async function consumeSseOrJsonStream(
  res: Response,
  protocol: ProtocolKind,
  params: MeshAttemptParams,
  onChunk: (text: string) => void,
  onReasoning?: (text: string) => void
): Promise<string> {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.body) {
    throw new MeshHttpError('Empty response body', res.status);
  }

  if (contentType.includes('text/html')) {
    const { text } = await readMeshResponseBody(res).catch(() => ({ text: '' }));
    throw new MeshHttpError(
      'Upstream returned an HTML/WAF page instead of an API response',
      502,
      text.slice(0, 300)
    );
  }

  if (contentType.includes('application/json')) {
    const { json, text } = await readMeshResponseBody(res);
    const errField =
      (json as { error?: unknown; code?: number; msg?: string } | null)?.error ||
      ((json as { code?: number } | null)?.code &&
      (json as { code?: number }).code !== 0 &&
      (json as { code?: number }).code !== 200
        ? (json as { msg?: string }).msg || 'AgentRouter error'
        : null);
    if (errField) {
      throw new MeshHttpError(extractOpenAiError(json, 'AgentRouter error'), res.status, json);
    }

    if (protocol === 'anthropic_messages') {
      const blocks = Array.isArray((json as { content?: unknown[] } | null)?.content)
        ? ((json as { content: Array<{ type?: string; text?: string; thinking?: string }> }).content)
        : [];
      let out = '';
      for (const blk of blocks) {
        if (blk?.type === 'thinking' && blk.thinking && onReasoning) {
          onReasoning(blk.thinking);
        } else if (blk?.type === 'text' && blk.text) {
          out += blk.text;
        }
      }
      if (out) onChunk(out);
      return out || text;
    }

    if (protocol === 'responses') {
      const respObj = json as {
        output_text?: string;
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      } | null;
      let out = typeof respObj?.output_text === 'string' ? respObj.output_text : '';
      if (!out && Array.isArray(respObj?.output)) {
        for (const item of respObj.output) {
          for (const part of item.content || []) {
            if (typeof part.text === 'string') out += part.text;
          }
        }
      }
      if (out) onChunk(out);
      return out || text;
    }

    const msgObj = (
      json as {
        choices?: Array<{
          message?: { content?: string; reasoning_content?: string; reasoning?: string };
        }>;
      } | null
    )?.choices?.[0]?.message;
    const reasoning = msgObj?.reasoning_content || msgObj?.reasoning || '';
    if (reasoning && onReasoning) onReasoning(reasoning);
    const content = msgObj?.content || '';
    if (content) onChunk(content);
    return content || text;
  }

  // SSE or plain-text stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const idleMs = params.idleTimeoutMs ?? 45_000;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try {
        reader.cancel().catch(() => undefined);
      } catch {
        // ignore
      }
    }, idleMs);
  };
  resetIdle();
  const isEventStream = contentType.includes('event-stream');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        newlineIdx = buffer.indexOf('\n');
        if (!line || line.startsWith('event:') || line.startsWith(':')) continue;
        if (!isEventStream && !line.startsWith('data:')) {
          if (!raw && /^<!doctype\s+html|^<html\b|aliyun_waf|CF_APP_WAF/i.test(line)) {
            throw new MeshHttpError(
              'Upstream returned an HTML/WAF challenge instead of an API stream',
              502
            );
          }
          raw += line;
          onChunk(line);
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== 'object') continue;
        const obj = parsed as Record<string, unknown>;
        if (obj.error) {
          throw new MeshHttpError(
            extractOpenAiError(obj, 'AgentRouter stream error'),
            res.status,
            obj
          );
        }

        if (protocol === 'anthropic_messages') {
          const evType = typeof obj.type === 'string' ? obj.type : '';
          if (evType === 'content_block_delta') {
            const delta = obj.delta as
              | { type?: string; text?: string; thinking?: string }
              | undefined;
            if (delta?.type === 'thinking_delta' && delta.thinking && onReasoning) {
              onReasoning(delta.thinking);
            } else if (delta?.type === 'text_delta' && delta.text) {
              raw += delta.text;
              onChunk(delta.text);
            }
          }
          continue;
        }

        if (protocol === 'responses') {
          const evType = typeof obj.type === 'string' ? obj.type : '';
          const deltaText = typeof obj.delta === 'string' ? obj.delta : '';
          if (
            (evType.includes('reasoning') && evType.endsWith('.delta')) &&
            deltaText &&
            onReasoning
          ) {
            onReasoning(deltaText);
          } else if (evType === 'response.output_text.delta' && deltaText) {
            raw += deltaText;
            onChunk(deltaText);
          } else if (evType === 'response.failed') {
            throw new MeshHttpError(
              extractOpenAiError(obj.response || obj, 'Responses API failed'),
              res.status,
              obj
            );
          }
          continue;
        }

        // OpenAI Chat Completions SSE
        const choices = obj.choices as
          | Array<{
              delta?: { content?: string; reasoning_content?: string; reasoning?: string };
              message?: { content?: string };
            }>
          | undefined;
        const choice = choices?.[0];
        if (!choice) continue;
        const reasoning =
          choice.delta?.reasoning_content || choice.delta?.reasoning || '';
        if (reasoning && onReasoning) onReasoning(reasoning);
        const piece = choice.delta?.content || choice.message?.content || '';
        if (piece) {
          raw += piece;
          onChunk(piece);
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
  return raw;
}

async function streamOneMeshCandidateRaw(
  candidate: MeshCandidate,
  params: MeshAttemptParams,
  onChunk: (text: string) => void,
  onReasoning?: (text: string) => void
): Promise<string> {
  const protocols = protocolsForCandidate(candidate.model);
  const hasImage = Boolean(params.attachmentDataUrl?.startsWith('data:image/'));
  let lastErr: unknown = null;

  for (const protocol of protocols) {
    let attemptWithImage = hasImage;
    for (let imageRetry = 0; imageRetry < 2; imageRetry += 1) {
      let url = candidate.baseUrl;
      let headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json, text/plain',
        Authorization: `Bearer ${candidate.apiKey}`,
        ...(candidate.headers || {}),
      };
      let body: Record<string, unknown>;

      if (protocol === 'anthropic_messages') {
        url = toMessagesUrl(candidate.v1Origin);
        headers = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          'x-api-key': candidate.apiKey,
          Authorization: `Bearer ${candidate.apiKey}`,
          'anthropic-version': '2023-06-01',
          ...(candidate.headers || {}),
        };
        body = {
          model: candidate.model,
          max_tokens: 8192,
          ...(params.systemPrompt.trim()
            ? { system: params.systemPrompt.trim().slice(0, 60000) }
            : {}),
          messages: buildAnthropicMessages({
            historyMessages: params.historyMessages,
            userPrompt: params.userPrompt,
            attachmentDataUrl: params.attachmentDataUrl,
            withImage: attemptWithImage,
          }),
          stream: true,
        };
      } else if (protocol === 'responses') {
        url = toResponsesUrl(candidate.v1Origin);
        const msgs = buildMeshMessages({
          systemPrompt: '',
          historyMessages: params.historyMessages,
          userPrompt: params.userPrompt,
          attachmentDataUrl: params.attachmentDataUrl,
          withImage: attemptWithImage,
        });
        body = {
          model: candidate.model,
          ...(params.systemPrompt.trim()
            ? { instructions: params.systemPrompt.trim().slice(0, 60000) }
            : {}),
          input: msgs.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        };
      } else {
        url = candidate.baseUrl;
        body = {
          model: candidate.model,
          messages: buildMeshMessages({
            systemPrompt: params.systemPrompt,
            historyMessages: params.historyMessages,
            userPrompt: params.userPrompt,
            attachmentDataUrl: params.attachmentDataUrl,
            withImage: attemptWithImage,
          }),
          stream: true,
          temperature: params.taskKind === 'build' ? 0.45 : 0.7,
        };
      }

      try {
        const res = await postJsonEndpoint(url, headers, body, candidate, params);
        return await consumeSseOrJsonStream(
          res,
          protocol,
          params,
          onChunk,
          onReasoning
        );
      } catch (err) {
        lastErr = err;
        const info = normalizeMeshError(err);
        if (
          attemptWithImage &&
          info.status !== null &&
          [400, 413, 415, 422].includes(info.status)
        ) {
          attemptWithImage = false;
          continue;
        }
        if (shouldFallbackProtocol(err)) {
          break; // try next protocol
        }
        throw err;
      }
    }
  }

  throw lastErr ?? new MeshHttpError('AgentRouter request failed', null);
}

async function streamOneMeshCandidate(
  candidate: MeshCandidate,
  params: MeshAttemptParams,
  onChunk: (text: string) => void,
  onReasoning?: (text: string) => void
): Promise<string> {
  await acquireProviderSlot(candidate.providerId, params.signal?.signal);
  try {
    return await streamOneMeshCandidateRaw(candidate, params, onChunk, onReasoning);
  } finally {
    releaseProviderSlot(candidate.providerId);
  }
}

async function completeOneMeshCandidateRaw(
  candidate: MeshCandidate,
  params: MeshAttemptParams
): Promise<string> {
  let out = '';
  const raw = await streamOneMeshCandidateRaw(
    candidate,
    params,
    (chunk) => {
      out += chunk;
    },
    undefined
  );
  return out || raw;
}

async function completeOneMeshCandidate(
  candidate: MeshCandidate,
  params: MeshAttemptParams
): Promise<string> {
  await acquireProviderSlot(candidate.providerId, params.signal?.signal);
  try {
    return await completeOneMeshCandidateRaw(candidate, params);
  } finally {
    releaseProviderSlot(candidate.providerId);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface MeshWalkParams {
  taskKind: 'chat' | 'build';
  requestedModel?: string;
  systemPrompt: string;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  signal?: AbortSignal;
  onModelMeta?: (meta: { modelId: string; modelName: string; provider: string }) => void;
  onContentChunk?: (chunkText: string) => void;
  onReasoningChunk?: (reasoningText: string) => void;
}

function linkSignal(
  outer: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (!outer) return () => undefined;
  if (outer.aborted) controller.abort();
  const onAbort = () => controller.abort();
  outer.addEventListener('abort', onAbort, { once: true });
  return () => outer.removeEventListener('abort', onAbort);
}

async function runMeshStreamAttempt(params: {
  candidate: MeshCandidate;
  walk: MeshWalkParams;
  budget: MeshWalkBudget;
  onForwardChunk: (chunk: string) => void;
}): Promise<MeshStreamResult> {
  const { candidate, walk, budget } = params;
  const modelId = `agentrouter::${candidate.model}`;
  const modelName = `AgentRouter · ${candidate.model}`;
  walk.onModelMeta?.({ modelId, modelName, provider: candidate.providerId });

  const controller = new AbortController();
  const unlink = linkSignal(walk.signal, controller);
  let emitted = false;
  try {
    const raw = await streamOneMeshCandidate(
      candidate,
      {
        taskKind: walk.taskKind,
        systemPrompt: walk.systemPrompt,
        historyMessages: walk.historyMessages,
        userPrompt: walk.userPrompt,
        attachmentDataUrl: walk.attachmentDataUrl,
        signal: controller,
        firstByteTimeoutMs: budget.firstByteMs,
        idleTimeoutMs: budget.idleMs,
      },
      (chunk) => {
        emitted = true;
        params.onForwardChunk(chunk);
      },
      walk.onReasoningChunk
    );
    if (raw.trim()) {
      recordDailyUsage(candidate.providerId, candidate.model);
      return { rawOutput: raw, modelUsed: modelId, modelName, provider: candidate.providerId };
    }
    markGatewayCandidateCooldown(candidate.cooldownKey, 20_000, false);
    throw new MeshHttpError('empty response', null);
  } catch (err) {
    if (emitted) throw err;
    if (walk.signal?.aborted) {
      throw new Error('Request cancelled.');
    }
    const info = normalizeMeshError(err);
    const { ms, hard } = cooldownForMeshError(info);
    markGatewayCandidateCooldown(candidate.cooldownKey, ms, hard);
    throw err;
  } finally {
    unlink();
  }
}

export async function streamFreeAiMesh(params: MeshWalkParams): Promise<MeshStreamResult> {
  const budget = budgetFor(params.taskKind);
  let cooldownWaits = 0;

  const tryWaitForCooldowns = async (): Promise<boolean> => {
    if (cooldownWaits >= 1) return false;
    if (!getFreeAiMeshStatus().hasAny) return false;
    if (buildMeshCandidates().length > 0) return false;
    const earliest = earliestMeshCooldownMs();
    if (earliest <= 0) return false;
    const capMs = readEnvNumber('MESH_COOLDOWN_WAIT_MS', 8_000);
    if (earliest > capMs) return false;
    cooldownWaits += 1;
    await sleepWithSignal(Math.min(earliest + 300, capMs + 300), params.signal).catch(
      () => undefined
    );
    return buildMeshCandidates().length > 0;
  };

  let candidates = prioritizeCandidatesForRequestedModel(
    buildMeshCandidates(),
    params.requestedModel
  );
  if (candidates.length === 0) {
    if (getFreeAiMeshStatus().hasAny) {
      if (await tryWaitForCooldowns()) {
        candidates = prioritizeCandidatesForRequestedModel(
          buildMeshCandidates(),
          params.requestedModel
        );
      } else {
        throw new FreeAiMeshAllFailedError([
          lastAgentRouterDiag?.message ||
            'AgentRouter models are temporarily cooling down after recent errors',
        ]);
      }
    } else {
      throw new FreeAiMeshUnavailableError();
    }
  }

  const deadlineAt = Date.now() + budget.walkMs;
  const details: string[] = [];
  let attempts = 0;

  const runSequential = async (list: MeshCandidate[]): Promise<MeshStreamResult | null> => {
    for (const candidate of list) {
      if (params.signal?.aborted) throw new Error('Request cancelled.');
      if (Date.now() > deadlineAt || attempts >= budget.maxAttempts) return null;
      attempts += 1;
      try {
        return await runMeshStreamAttempt({
          candidate,
          walk: params,
          budget,
          onForwardChunk: (chunk) => params.onContentChunk?.(chunk),
        });
      } catch (err) {
        if (params.signal?.aborted) throw new Error('Request cancelled.');
        const info = normalizeMeshError(err);
        details.push(`${candidate.model}: ${info.message}`);
        // Auth failures apply to the AgentRouter API key as a whole — fail fast
        // with the exact upstream error instead of retrying 5 other models.
        if (isAuthError(info)) {
          throw new FreeAiMeshAllFailedError(details);
        }
      }
    }
    return null;
  };

  const firstPass = await runSequential(candidates);
  if (firstPass) return firstPass;

  if (await tryWaitForCooldowns()) {
    const retryPass = await runSequential(
      prioritizeCandidatesForRequestedModel(buildMeshCandidates(), params.requestedModel)
    );
    if (retryPass) return retryPass;
  }

  if (attempts === 0) throw new FreeAiMeshUnavailableError();
  throw new FreeAiMeshAllFailedError(details);
}

export async function completeFreeAiMesh(params: {
  taskKind: 'chat' | 'build';
  requestedModel?: string;
  systemPrompt: string;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string | null> {
  const attemptMs = Math.max(3_000, Math.min(params.timeoutMs ?? 25_000, 25_000));
  const candidates = prioritizeCandidatesForRequestedModel(
    buildMeshCandidates(),
    params.requestedModel
  );
  if (candidates.length === 0) return null;

  const deadlineAt = Date.now() + attemptMs + 30_000;
  for (const candidate of candidates) {
    if (params.signal?.aborted) return null;
    if (Date.now() > deadlineAt) return null;
    const controller = new AbortController();
    const unlink = linkSignal(params.signal, controller);
    try {
      const out = await completeOneMeshCandidate(candidate, {
        taskKind: params.taskKind,
        systemPrompt: params.systemPrompt,
        historyMessages: params.historyMessages,
        userPrompt: params.userPrompt,
        attachmentDataUrl: params.attachmentDataUrl,
        signal: controller,
        firstByteTimeoutMs: attemptMs,
      });
      if (out.trim()) {
        recordDailyUsage(candidate.providerId, candidate.model);
        return out;
      }
      markGatewayCandidateCooldown(candidate.cooldownKey, 20_000, false);
    } catch (err) {
      if (params.signal?.aborted) return null;
      const info = normalizeMeshError(err);
      const { ms, hard } = cooldownForMeshError(info);
      markGatewayCandidateCooldown(candidate.cooldownKey, ms, hard);
      if (isAuthError(info)) return null;
    } finally {
      unlink();
    }
  }
  return null;
}
