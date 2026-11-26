/**
 * AI Craft — Free AI Mesh (the ONLY chat/build engine — zero API keys needed)
 *
 * One ordered multi-provider failover layer over every free AI endpoint we know:
 *
 *   1. Self-hosted GPU (SELF_HOSTED_LLM_* — OpenAI-compatible / Ollama / TGI)
 *   2. Generic OpenAI-compatible (OPENAI_COMPATIBLE_BASE_URL / KEY / MODEL)
 *   3. Groq, Cerebras, OpenRouter (:free models), Mistral, HuggingFace router,
 *      GitHub Models, Together, DeepInfra — free tiers (activate when their key
 *      or an ambient token happens to exist; never required)
 *   4. Pollinations — keyless text lane, on by default with zero configuration
 *
 * The old Gemini-first path was removed: chat and build always run through
 * this mesh. Providers cooperate through the shared cooldown registry in
 * `_aiGateways` (keys `mesh:<provider>:<fp>:<model>`): a provider that
 * rate-limits is skipped instantly by every later request.
 *
 * Daily quotas: every (provider, model) pair gets `MESH_DAILY_LIMIT_PER_MODEL`
 * requests per UTC day (default 400). Quota keys are date-stamped, so limits
 * reset automatically at 00:00 UTC and an exhausted model is skipped while the
 * rest of the pool keeps serving — "if one hits limit, another continues".
 *
 * Speed:
 *  - chat walks race the top-3 candidates concurrently — first response with
 *    content wins (tight budgets: 6s first byte, 20s idle, 30s walk).
 *  - build walks stream one lane live (10s first byte, 45s idle, 65s walk);
 *    fresh builds additionally fan out to 3 parallel agents (architect +
 *    designer + engineer) inside `_realtimeEngine`.
 *
 * Concurrency & self-heal:
 *  - every HTTP call acquires a per-provider single-flight slot first
 *    (Pollinations Classic = 1 request per IP, env MESH_POLLINATIONS_CONCURRENCY),
 *    so races and parallel agents queue instead of colliding;
 *  - the chat race cancels losing lanes the moment the winner settles;
 *  - "previous request is still running" busy errors cool for ~6s only, and
 *    a walk whose candidates are ALL briefly cooling waits (bounded, env
 *    MESH_COOLDOWN_WAIT_MS) for the earliest one instead of erroring —
 *    cooldowns always expire; nothing is ever permanent.
 *
 * Design rules:
 *  - Never throws for "no provider configured" silently — callers gate on
 *    `isFreeAiMeshAvailable()`; `streamFreeAiMesh` throws typed friendly errors.
 *  - `completeFreeAiMesh` (non-streaming, repair/design/agents) never throws —
 *    null on failure, so optional sub-passes degrade instead of breaking.
 *  - Partial output already streamed ⇒ rethrow immediately (caller finalizes
 *    partial HTML exactly like the previous path did).
 */

import {
  buildCandidateCooldownKey,
  gatewayCandidateCooldownRemainingMs,
  isGatewayCandidateCoolingDown,
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
      'No free AI engine is reachable right now. The keyless Pollinations lane is enabled by default — please retry in a few seconds.'
    );
    this.name = 'FreeAiMeshUnavailableError';
  }
}

export class FreeAiMeshAllFailedError extends Error {
  readonly code = 'mesh_all_failed' as const;
  readonly details: string[];
  constructor(details: string[]) {
    // Keep the user-facing bubble SHORT: each detail is already capped by
    // normalizeMeshError, but three long provider messages still made a wall
    // of red text on mobile. Show the last two, hard-truncated.
    const tail = details
      .slice(-2)
      .map((d) => (d.length > 110 ? `${d.slice(0, 110)}...` : d))
      .join('; ');
    super(
      `All free AI engines are busy or unreachable right now${tail ? ` (${tail})` : ''}. Please retry in a few seconds.`
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
  const strippedQuotes = s.replace(/^[`"'\u201c\u201d\u2018\u2019]+|[`"'\u201c\u201d\u2018\u2019;,]+$/g, '').trim();
  const hadQuotes = strippedQuotes !== s;
  s = strippedQuotes;
  const hadBearerPrefix = /^bearer\s+/i.test(s);
  if (hadBearerPrefix) {
    s = s.replace(/^bearer\s+/i, '').trim();
  }
  const hadWhitespace = /\s/.test(s);
  if (hadWhitespace) {
    // If someone pasted a multi-line snippet or wrapped key, prefer an sk-... token if present,
    // otherwise collapse internal line breaks/whitespace.
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

function readEnvKey(...names: string[]): string {
  for (const name of names) {
    const { cleaned, looksLikeUrl } = cleanPastedSecret(process.env[name]);
    if (!cleaned || looksLikeUrl) continue;
    if (/^(my[_-]|your[_-]|xxx+|<|change[-_]?me|placeholder)/i.test(cleaned)) continue;
    return cleaned;
  }
  return '';
}

function readEnvFlag(name: string, defaultValue = true): boolean {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
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

/** Normalize a base URL to a full OpenAI-style chat-completions endpoint. */
function toChatCompletionsUrl(rawBase: string): string {
  const base = rawBase.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

// ---------------------------------------------------------------------------
// Abortable sleep + per-provider single-flight slots.
//
// Pollinations' Classic API answers ONE request at a time per IP — firing the
// chat race (or 3 parallel build agents) at it concurrently is exactly what
// produced "Your previous request is still running" on every attempt, which
// then cooled every model and surfaced "all configured engines are cooling
// down". Every mesh HTTP call now acquires its provider's slot first, so
// concurrent walks queue instead of colliding; busy errors additionally get
// a SHORT cooldown (see cooldownForMeshError) so the next attempt recovers
// in seconds — cooldowns are never permanent.
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

function providerConcurrencyLimit(providerId: string): number {
  if (providerId === 'pollinations') {
    // Pollinations Classic = 1 request at a time per IP (keyless).
    return Math.max(1, readEnvNumber('MESH_POLLINATIONS_CONCURRENCY', 1));
  }
  return Math.max(1, readEnvNumber('MESH_PROVIDER_CONCURRENCY', 6));
}

async function acquireProviderSlot(
  providerId: string,
  signal?: AbortSignal
): Promise<void> {
  const limit = providerConcurrencyLimit(providerId);
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
      throw new MeshHttpError('timed out waiting for provider slot', null);
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
// Provider registry (ordered — first healthy candidate wins)
// ---------------------------------------------------------------------------

interface ResolvedMeshProvider {
  baseUrl: string;
  apiKey: string;
  models: string[];
  headers?: Record<string, string>;
}

interface MeshProviderDef {
  id: string;
  label: string;
  keyless: boolean;
  /** Reads env on every call so tests can inject config after import. */
  resolve(): ResolvedMeshProvider | null;
}

const POLLINATIONS_FALLBACK_MODELS = FREE_MODEL_CATALOG.pollinations;

let pollinationsModelsCache: { models: string[]; at: number } | null = null;
let pollinationsRefreshInFlight = false;

function schedulePollinationsModelsRefresh(baseUrl: string): void {
  if (pollinationsRefreshInFlight) return;
  pollinationsRefreshInFlight = true;
  const origin = baseUrl.replace(/\/openai\/?$/i, '').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  fetch(`${origin}/models`, { signal: controller.signal })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: unknown) => {
      if (!Array.isArray(data)) return;
      const names: string[] = [];
      for (const entry of data) {
        const name =
          typeof entry === 'string'
            ? entry
            : entry && typeof entry === 'object' && 'name' in entry
              ? String((entry as { name: unknown }).name || '')
              : '';
        if (!name) continue;
        const lower = name.toLowerCase();
        if (/nsfw|porn|xxx|hentai|uncensored|erotic/.test(lower)) continue;
        if (/^(true|1)$/i.test(String((entry as { nsfw?: unknown }).nsfw ?? ''))) continue;
        names.push(name);
        if (names.length >= 40) break;
      }
      if (names.length > 0) {
        pollinationsModelsCache = { models: names, at: Date.now() };
      }
    })
    .catch(() => undefined)
    .finally(() => {
      pollinationsRefreshInFlight = false;
      clearTimeout(timer);
    });
}

function resolvePollinationsModels(baseUrl: string): string[] {
  const override = readEnvCsv('POLLINATIONS_MODELS');
  if (override.length > 0) return override;
  const cacheFresh =
    pollinationsModelsCache && Date.now() - pollinationsModelsCache.at < 10 * 60_000;
  if (!cacheFresh) {
    // Non-blocking: serve the static list now, refresh in background for next time.
    schedulePollinationsModelsRefresh(baseUrl);
    return POLLINATIONS_FALLBACK_MODELS;
  }
  const cached = pollinationsModelsCache!.models;
  // Prefer well-known stable names first, then the rest of the live list.
  const preferred = POLLINATIONS_FALLBACK_MODELS.filter((m) => cached.includes(m));
  const rest = cached.filter((m) => !preferred.includes(m));
  return [...preferred, ...rest].slice(0, 40);
}

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
    if (/^(my[_-]|your[_-]|xxx+|<|change[-_]?me|placeholder)/i.test(info.cleaned)) continue;
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
      lengthOk: keyInfo.cleaned.length >= 16,
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
        if (/^(whisper|tts|dall-e|gpt-image|text-embedding|embedding|moderation)/i.test(id)) {
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
      if (/^(whisper|tts|dall-e|gpt-image|text-embedding|embedding|moderation)/i.test(id)) {
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
        apiKey: creds.apiKey,
        models: resolveAgentRouterModels(creds.v1Origin, creds.apiKey),
        headers: {
          'User-Agent': 'codex_cli_rs/0.34.0',
          'X-Title': 'AI Craft',
        },
      };
    },
  },
  {
    id: 'self-hosted',
    label: 'Self-Hosted GPU',
    keyless: false,
    resolve() {
      const url = (process.env.SELF_HOSTED_LLM_URL || '').trim();
      if (!url || !/^https?:\/\//i.test(url)) return null;
      const model =
        (process.env.SELF_HOSTED_LLM_MODEL || '').trim() || 'self-hosted/open-source-coder';
      const apiKey = readEnvKey('SELF_HOSTED_LLM_API_KEY');
      return { baseUrl: toChatCompletionsUrl(url), apiKey, models: [model] };
    },
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-Compatible',
    keyless: false,
    resolve() {
      const url = (process.env.OPENAI_COMPATIBLE_BASE_URL || '').trim();
      if (!url || !/^https?:\/\//i.test(url)) return null;
      const model =
        (process.env.OPENAI_COMPATIBLE_MODEL || '').trim() || 'gpt-4o-mini';
      const apiKey = readEnvKey('OPENAI_COMPATIBLE_API_KEY', 'OPENAI_COMPATIBLE_KEY');
      return { baseUrl: toChatCompletionsUrl(url), apiKey, models: [model] };
    },
  },
  {
    id: 'groq',
    label: 'Groq',
    keyless: false,
    resolve() {
      const apiKey = readEnvKey('GROQ_API_KEY');
      if (!apiKey) return null;
      return {
        baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
        apiKey,
        models: FREE_MODEL_CATALOG.groq,
      };
    },
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    keyless: false,
    resolve() {
      const apiKey = readEnvKey('CEREBRAS_API_KEY');
      if (!apiKey) return null;
      return {
        baseUrl: 'https://api.cerebras.ai/v1/chat/completions',
        apiKey,
        models: FREE_MODEL_CATALOG.cerebras,
      };
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyless: false,
    resolve() {
      const apiKey = readEnvKey('OPENROUTER_API_KEY');
      if (!apiKey) return null;
      const override = readEnvCsv('OPENROUTER_MODELS');
      const appUrl = (process.env.APP_URL || '').trim();
      return {
        baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey,
        models: override.length > 0 ? override : FREE_MODEL_CATALOG.openrouter,
        headers: appUrl
          ? { 'HTTP-Referer': appUrl, 'X-Title': 'AI Craft' }
          : { 'X-Title': 'AI Craft' },
      };
    },
  },
  {
    id: 'mistral',
    label: 'Mistral',
    keyless: false,
    resolve() {
      const apiKey = readEnvKey('MISTRAL_API_KEY');
      if (!apiKey) return null;
      return {
        baseUrl: 'https://api.mistral.ai/v1/chat/completions',
        apiKey,
        models: FREE_MODEL_CATALOG.mistral,
      };
    },
  },
  {
    id: 'huggingface',
    label: 'HuggingFace',
    keyless: false,
    resolve() {
      const apiKey = readEnvKey('HF_TOKEN', 'HUGGINGFACE_API_TOKEN');
      if (!apiKey) return null;
      const override = readEnvCsv('HUGGINGFACE_MODELS');
      return {
        baseUrl: 'https://router.huggingface.co/v1/chat/completions',
        apiKey,
        models: override.length > 0 ? override : FREE_MODEL_CATALOG.huggingface,
      };
    },
  },
  {
    id: 'github',
    label: 'GitHub Models',
    keyless: false,
    resolve() {
      const apiKey = readEnvKey('GITHUB_TOKEN', 'GH_TOKEN');
      if (!apiKey) return null;
      const override = readEnvCsv('GITHUB_MODELS');
      return {
        baseUrl: 'https://models.github.ai/inference/chat/completions',
        apiKey,
        models: override.length > 0 ? override : FREE_MODEL_CATALOG.github,
      };
    },
  },
  {
    id: 'together',
    label: 'Together',
    keyless: false,
    resolve() {
      const apiKey = readEnvKey('TOGETHER_API_KEY');
      if (!apiKey) return null;
      const override = readEnvCsv('TOGETHER_MODELS');
      return {
        baseUrl: 'https://api.together.xyz/v1/chat/completions',
        apiKey,
        models: override.length > 0 ? override : FREE_MODEL_CATALOG.together,
      };
    },
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    keyless: false,
    resolve() {
      const apiKey = readEnvKey('DEEPINFRA_API_KEY');
      if (!apiKey) return null;
      const override = readEnvCsv('DEEPINFRA_MODELS');
      return {
        baseUrl: 'https://api.deepinfra.com/v1/openai/chat/completions',
        apiKey,
        models: override.length > 0 ? override : FREE_MODEL_CATALOG.deepinfra,
      };
    },
  },
  {
    id: 'pollinations',
    label: 'Pollinations',
    keyless: true,
    resolve() {
      if (!readEnvFlag('POLLINATIONS_ENABLED', true)) return null;
      const baseUrl =
        (process.env.POLLINATIONS_BASE_URL || '').trim() ||
        'https://text.pollinations.ai/openai';
      if (!/^https?:\/\//i.test(baseUrl)) return null;
      const apiKey = readEnvKey('POLLINATIONS_API_KEY');
      const models = resolvePollinationsModels(baseUrl);
      if (models.length === 0) return null;
      return { baseUrl, apiKey, models };
    },
  },
];

// ---------------------------------------------------------------------------
// Candidates, cooldowns, error classification
// ---------------------------------------------------------------------------

interface MeshCandidate {
  providerId: string;
  providerLabel: string;
  keyless: boolean;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  model: string;
  cooldownKey: string;
}

const MAX_MODELS_PER_PROVIDER = 8;
const MAX_ATTEMPTS_PER_WALK = 12;

// ---------------------------------------------------------------------------
// Daily quotas (reset automatically at 00:00 UTC) + walk budgets
// ---------------------------------------------------------------------------

/** Successful responses per (provider, model) per UTC day. */
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

/** Test/diagnostics hook: current quota-day usage counts. */
export function getMeshDailyUsage(): Record<string, number> {
  return Object.fromEntries(dailyUsage);
}

/** Test hook: clear quota counters (quota day itself rolls over at 00:00 UTC). */
export function resetMeshDailyUsage(): void {
  dailyUsage.clear();
}

/** Fresh full builds fan out to 3 parallel agents unless opted out. */
export function isMeshParallelBuildsEnabled(): boolean {
  return readEnvFlag('MESH_PARALLEL_BUILDS', true);
}

interface MeshWalkBudget {
  firstByteMs: number;
  idleMs: number;
  walkMs: number;
  maxAttempts: number;
}

/** Chat = fast (raced when keyless); build = roomier (single live stream / agents). */
function budgetFor(taskKind: 'chat' | 'build'): MeshWalkBudget {
  const hasPrimaryRouter = isAgentRouterConfigured();
  if (taskKind === 'chat') {
    return hasPrimaryRouter
      ? { firstByteMs: 15_000, idleMs: 25_000, walkMs: 50_000, maxAttempts: 8 }
      : { firstByteMs: 6_000, idleMs: 20_000, walkMs: 30_000, maxAttempts: 8 };
  }
  return hasPrimaryRouter
    ? { firstByteMs: 24_000, idleMs: 55_000, walkMs: 90_000, maxAttempts: 12 }
    : { firstByteMs: 10_000, idleMs: 45_000, walkMs: 65_000, maxAttempts: 12 };
}

/** Every candidate the walk may consider, with its remaining cooldown
 *  (0 = usable right now). Quota-exhausted models are excluded entirely. */
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
      // Daily quota exhausted → this AI rests until 00:00 UTC; walk the rest.
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
  if (!req || candidates.length <= 1) return candidates;

  if (req.startsWith('agentrouter::')) {
    const targetModel = req.slice('agentrouter::'.length).trim();
    if (!targetModel || targetModel === 'auto') {
      const ar = candidates.filter((c) => c.providerId === 'agentrouter');
      const rest = candidates.filter((c) => c.providerId !== 'agentrouter');
      return [...ar, ...rest];
    }
    const exact = candidates.filter(
      (c) => c.providerId === 'agentrouter' && c.model === targetModel
    );
    const sameProvider = candidates.filter(
      (c) => c.providerId === 'agentrouter' && c.model !== targetModel
    );
    const others = candidates.filter((c) => c.providerId !== 'agentrouter');
    if (exact.length > 0) {
      return [...exact, ...sameProvider, ...others];
    }
    // Requested a specific upstream AgentRouter model ID not in top slice — prepend an on-demand candidate if configured
    const creds = getAgentRouterCredentials();
    if (creds) {
      const cooldownKey = buildCandidateCooldownKey(
        'mesh:agentrouter',
        creds.apiKey,
        targetModel
      );
      if (gatewayCandidateCooldownRemainingMs(cooldownKey) <= 0 && !isDailyQuotaExhausted('agentrouter', targetModel)) {
        return [
          {
            providerId: 'agentrouter',
            providerLabel: 'AgentRouter',
            keyless: false,
            baseUrl: creds.baseUrl,
            apiKey: creds.apiKey,
            headers: {
              'User-Agent': 'codex_cli_rs/0.34.0',
              'X-Title': 'AI Craft',
            },
            model: targetModel,
            cooldownKey,
          },
          ...sameProvider,
          ...others,
        ];
      }
    }
    return [...sameProvider, ...others];
  }

  if (req === 'mesh::reasoning') {
    const isReasoning = (m: string) => /r1|reason|opus|gpt-5|kimi|qwq/i.test(m);
    const preferred = candidates.filter((c) => isReasoning(c.model));
    const rest = candidates.filter((c) => !isReasoning(c.model));
    return [...preferred, ...rest];
  }

  if (req === 'mesh::coder') {
    const isCoder = (m: string) => /coder|sonnet|claude|gpt-5|deepseek|glm/i.test(m);
    const preferred = candidates.filter((c) => isCoder(c.model));
    const rest = candidates.filter((c) => !isCoder(c.model));
    return [...preferred, ...rest];
  }

  return candidates;
}

/** Smallest remaining cooldown across every cooling candidate — 0 when at
 *  least one candidate is usable or nothing is cooling at all. */
function earliestMeshCooldownMs(): number {
  let earliest = 0;
  for (const entry of enumerateMeshCandidates()) {
    if (entry.coolingMs <= 0) return 0; // someone is usable
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
    /** Candidates usable right now (configured, not cooling, not quota-capped). */
    activeModels: number;
    /** Total free models cataloged across every known provider. */
    catalogSize: number;
    /** When every daily quota resets (next 00:00 UTC). */
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
    hasKeyless: providers.some((p) => p.configured && p.keyless),
    pollinationsEnabled: readEnvFlag('POLLINATIONS_ENABLED', true),
    pollinationsConfigured: Boolean(providers.find((p) => p.id === 'pollinations')?.configured),
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

/**
 * Selector entries for the model picker — the mesh auto-routes to the
 * fastest healthy free lane regardless of which entry is picked, so these
 * are preference profiles, not hard bindings. Zero API keys, zero config.
 */
export function getFreeMeshModelOptions(): FreeMeshModelOption[] {
  const pool = getFreeAiMeshStatus().modelPool;
  const resetLabel = 'Daily reset 00:00 UTC';
  const creds = getAgentRouterCredentials();
  const options: FreeMeshModelOption[] = [];

  if (creds) {
    const arModels = resolveAgentRouterModels(creds.v1Origin, creds.apiKey);
    options.push({
      id: 'agentrouter::auto',
      name: 'AgentRouter · Auto (Primary Brain)',
      provider: 'agentrouter',
      contextLength: 262144,
      isFree: false,
      gateway: 'auto',
      tierLabel: 'Primary Brain',
      capabilities: ['Chat', 'Code', 'Vision'],
      category: 'code',
    });
    for (const modelId of arModels.slice(0, 8)) {
      options.push({
        id: `agentrouter::${modelId}`,
        name: `AgentRouter · ${modelId}`,
        provider: 'agentrouter',
        contextLength: 262144,
        isFree: false,
        gateway: 'auto',
        tierLabel: 'AgentRouter API',
        capabilities: ['Chat', 'Code'],
        category: 'code',
      });
    }
  }

  options.push(
    {
      id: 'mesh::auto',
      name: 'Free AI Mesh · Auto (fastest lane)',
      provider: 'free-mesh',
      contextLength: 262144,
      isFree: true,
      gateway: 'auto',
      tierLabel: `Auto · ${pool.catalogSize}+ free models`,
      capabilities: ['Chat', 'Code', 'Vision'],
      category: 'code',
    },
    {
      id: 'mesh::fast',
      name: 'Free AI Mesh · Fast chat',
      provider: 'free-mesh',
      contextLength: 131072,
      isFree: true,
      gateway: 'auto',
      tierLabel: `Racing lanes · ${resetLabel}`,
      capabilities: ['Chat'],
      category: 'chat',
    },
    {
      id: 'mesh::coder',
      name: 'Free AI Mesh · Code specialist',
      provider: 'free-mesh',
      contextLength: 262144,
      isFree: true,
      gateway: 'auto',
      tierLabel: `Builder lanes · ${resetLabel}`,
      capabilities: ['Code'],
      category: 'code',
    },
    {
      id: 'mesh::reasoning',
      name: 'Free AI Mesh · Deep reasoning',
      provider: 'free-mesh',
      contextLength: 262144,
      isFree: true,
      gateway: 'auto',
      tierLabel: `Reasoning lanes · ${resetLabel}`,
      capabilities: ['Chat', 'Code'],
      category: 'chat',
    },
    {
      id: 'mesh::creative',
      name: 'Free AI Mesh · Creative writing',
      provider: 'free-mesh',
      contextLength: 131072,
      isFree: true,
      gateway: 'auto',
      tierLabel: `Creative lanes · ${resetLabel}`,
      capabilities: ['Chat'],
      category: 'chat',
    }
  );
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
        };
        message = parsed?.error?.message || parsed?.message || message;
      } catch {
        // keep original message
      }
    }
    return { status, message: message.slice(0, 300) };
  }
  return { status: null, message: String(err).slice(0, 300) };
}

/** Pollinations-style "someone else is using this lane right now" — always
 *  transient; callers should wait out the short cooldown and retry instead of
 *  burning the walk / failing the agent. */
export function isBusyMeshError(info: MeshErrorInfo): boolean {
  const lower = info.message.toLowerCase();
  return /previous request is still running|1 request at a time per ip|wait for it to finish/.test(
    lower
  );
}

export function cooldownForMeshError(
  info: MeshErrorInfo
): { ms: number; hard: boolean } {
  const lower = info.message.toLowerCase();
  // Pollinations "previous request is still running / 1 request at a time per
  // IP" (and pollen-key nags) are TRANSIENT concurrency busy — the next
  // attempt gets the single-flight slot, so cool for seconds only. Checked
  // BEFORE every other branch (busy arrives with various status codes) so a
  // busy storm can never pin models on 45–90s cooldowns.
  if (isBusyMeshError(info)) {
    return { ms: 6_000, hard: false };
  }
  if (
    info.status === 401 ||
    info.status === 403 ||
    /invalid.?api.?key|incorrect api key|unauthorized|forbidden|authentication/.test(lower)
  ) {
    return { ms: 10 * 60_000, hard: false };
  }
  if (
    info.status === 404 ||
    /model[_ ]?not[_ ]?found|does not exist|unknown model|no such model|deprecated model/.test(
      lower
    )
  ) {
    return { ms: 6 * 60 * 60_000, hard: true };
  }
  if (info.status === 402 || /\bbilling\b|payment required|credit/.test(lower)) {
    return { ms: 6 * 60 * 60_000, hard: true };
  }
  if (
    info.status === 429 ||
    /rate.?limit|too many requests|quota|quota exceeded|limit reached|overloaded/.test(lower)
  ) {
    return { ms: 90_000, hard: false };
  }
  if (info.status !== null && info.status >= 500) {
    return { ms: 30_000, hard: false };
  }
  // Network errors, timeouts, 4xx payload issues → short cooldown, try next lane.
  return { ms: 45_000, hard: false };
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

// ---------------------------------------------------------------------------
// HTTP: one candidate, streaming + non-streaming
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

async function postMeshJson(
  candidate: MeshCandidate,
  body: Record<string, unknown>,
  params: MeshAttemptParams
): Promise<Response> {
  const controller = params.signal ?? new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, params.firstByteTimeoutMs);
  try {
    const res = await fetch(candidate.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json, text/plain',
        ...(candidate.apiKey ? { Authorization: `Bearer ${candidate.apiKey}` } : {}),
        ...(candidate.headers || {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const { text, json } = await readMeshResponseBody(res).catch(() => ({
        text: '',
        json: null,
      }));
      const errMsg = extractOpenAiError(json, text || `HTTP ${res.status}`);
      if (candidate.providerId === 'agentrouter') {
        recordAgentRouterDiag(`${candidate.baseUrl} [${candidate.model}]`, res.status, errMsg);
      }
      throw new MeshHttpError(errMsg, res.status, json ?? text);
    }
    if (candidate.providerId === 'agentrouter') {
      recordAgentRouterDiag(`${candidate.baseUrl} [${candidate.model}]`, res.status, 'connected');
    }
    return res;
  } catch (err) {
    if (err instanceof MeshHttpError) throw err;
    const msg = timedOut
      ? 'Timed out waiting for first byte'
      : err instanceof Error
        ? err.message
        : String(err);
    if (candidate.providerId === 'agentrouter') {
      recordAgentRouterDiag(`${candidate.baseUrl} [${candidate.model}]`, null, msg);
    }
    if (timedOut) throw new MeshHttpError('Timed out waiting for first byte', null);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stream one candidate to completion. Emits content via `onChunk` /
 * `onReasoningChunk`. Returns the accumulated raw output (may be '').
 * Throws MeshHttpError / abort errors; callers classify + cool down.
 */
async function streamOneMeshCandidateRaw(
  candidate: MeshCandidate,
  params: MeshAttemptParams,
  onChunk: (text: string) => void,
  onReasoning?: (text: string) => void
): Promise<string> {
  const messages = buildMeshMessages({
    systemPrompt: params.systemPrompt,
    historyMessages: params.historyMessages,
    userPrompt: params.userPrompt,
    attachmentDataUrl: params.attachmentDataUrl,
    withImage: true,
  });

  const buildBody = (withImage: boolean): Record<string, unknown> => ({
    model: candidate.model,
    messages: withImage
      ? messages
      : buildMeshMessages({
          systemPrompt: params.systemPrompt,
          historyMessages: params.historyMessages,
          userPrompt: params.userPrompt,
          attachmentDataUrl: params.attachmentDataUrl,
          withImage: false,
        }),
    stream: true,
    temperature: params.taskKind === 'build' ? 0.4 : 0.7,
  });

  const hasImage = Boolean(params.attachmentDataUrl?.startsWith('data:image/'));
  let attemptWithImage = hasImage;
  // One silent retry without the image when the provider rejects multimodal payloads.
  for (let imageRetry = 0; imageRetry < 2; imageRetry += 1) {
    let res: Response;
    try {
      res = await postMeshJson(candidate, buildBody(attemptWithImage), params);
    } catch (err) {
      const info = normalizeMeshError(err);
      const canRetryWithoutImage =
        attemptWithImage &&
        info.status !== null &&
        [400, 413, 415, 422].includes(info.status);
      if (canRetryWithoutImage) {
        attemptWithImage = false;
        continue;
      }
      throw err;
    }

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

    // Provider ignored `stream` and returned a plain JSON payload.
    if (contentType.includes('application/json')) {
      const { json, text } = await readMeshResponseBody(res);
      const errField = (json as { error?: unknown } | null)?.error;
      if (errField) {
        throw new MeshHttpError(extractOpenAiError(json, 'provider error'), res.status, json);
      }
      const content =
        ((json as { choices?: Array<{ message?: { content?: string } }> } | null)?.choices?.[0]
          ?.message?.content as string | undefined) || '';
      if (content) onChunk(content);
      return content || text;
    }

    // SSE (or plain-text chunked) stream.
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
          if (!line) continue;
          if (!isEventStream && !line.startsWith('data:')) {
            if (
              !raw &&
              /^<!doctype\s+html|^<html\b|aliyun_waf|CF_APP_WAF/i.test(line)
            ) {
              throw new MeshHttpError(
                'Upstream returned an HTML/WAF challenge instead of an API stream',
                502
              );
            }
            // Plain-text chunked body.
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
          const obj = parsed as {
            error?: { message?: string };
            choices?: Array<{
              delta?: { content?: string; reasoning_content?: string; reasoning?: string };
              message?: { content?: string };
            }>;
          };
          if (obj.error) {
            throw new MeshHttpError(
              extractOpenAiError(obj, 'provider stream error'),
              res.status,
              obj
            );
          }
          const choice = obj.choices?.[0];
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
  return '';
}

/** Stream one candidate while holding its provider's single-flight slot
 *  (queueing instead of colliding — Pollinations Classic = 1 request/IP). */
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
  const messages = buildMeshMessages({
    systemPrompt: params.systemPrompt,
    historyMessages: params.historyMessages,
    userPrompt: params.userPrompt,
    attachmentDataUrl: params.attachmentDataUrl,
    withImage: Boolean(params.attachmentDataUrl?.startsWith('data:image/')),
  });
  const res = await postMeshJson(
    candidate,
    {
      model: candidate.model,
      messages,
      stream: false,
      temperature: params.taskKind === 'build' ? 0.4 : 0.7,
    },
    params
  );
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const { json, text } = await readMeshResponseBody(res);
  if (
    contentType.includes('text/html') ||
    (!json && /^<!doctype\s+html|<html\b|aliyun_waf|CF_APP_WAF/i.test(text))
  ) {
    throw new MeshHttpError(
      'Upstream returned an HTML/WAF page instead of an API response',
      502,
      text.slice(0, 300)
    );
  }
  const errField = (json as { error?: unknown } | null)?.error;
  if (errField) {
    throw new MeshHttpError(extractOpenAiError(json, 'provider error'), res.status, json);
  }
  const content =
    ((json as { choices?: Array<{ message?: { content?: string } }> } | null)?.choices?.[0]
      ?.message?.content as string | undefined) || '';
  return content || text;
}

/** Non-streaming attempt while holding the provider's single-flight slot —
 *  the queue wait happens BEFORE the caller's first-byte timer starts, so
 *  side agents queued behind a long architect stream keep their budget. */
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

/**
 * Run ONE candidate attempt: emit meta → stream → classify.
 * On failure the lane is already cooldown-marked and the error rethrown.
 * If content was already forwarded to the client the error is rethrown
 * WITHOUT cooldown (partial-output semantics — caller finalizes partial HTML).
 */
async function runMeshStreamAttempt(params: {
  candidate: MeshCandidate;
  walk: MeshWalkParams;
  budget: MeshWalkBudget;
  onForwardChunk: (chunk: string) => void;
  /** Per-attempt cancel from raceMeshAttempts (leader already won). */
  raceSignal?: AbortSignal;
}): Promise<MeshStreamResult> {
  const { candidate, walk, budget } = params;
  const modelId =
    candidate.providerId === 'agentrouter'
      ? `agentrouter::${candidate.model}`
      : `mesh::${candidate.providerId}::${candidate.model}`;
  const modelName = `${candidate.providerLabel} · ${candidate.model}`;
  walk.onModelMeta?.({ modelId, modelName, provider: candidate.providerId });

  const controller = new AbortController();
  const unlink = linkSignal(walk.signal, controller);
  const unlinkRace = linkSignal(params.raceSignal, controller);
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
    markGatewayCandidateCooldown(candidate.cooldownKey, 45_000, false);
    throw new MeshHttpError('empty response', null);
  } catch (err) {
    // Content already reached the caller — surface immediately so the engine
    // can finalize partial HTML exactly like the previous path did.
    if (emitted) throw err;
    // Cancelled by the caller OR by the race (another lane already won) —
    // never cooldown-mark a healthy model just because we stopped asking.
    if (walk.signal?.aborted || params.raceSignal?.aborted) {
      throw new Error('Request cancelled.');
    }
    const info = normalizeMeshError(err);
    const { ms, hard } = cooldownForMeshError(info);
    markGatewayCandidateCooldown(candidate.cooldownKey, ms, hard);
    throw err;
  } finally {
    unlink();
    unlinkRace();
  }
}

type MeshRaceOutcome =
  | { kind: 'success'; result: MeshStreamResult }
  /** The candidate that streamed to the client died mid-output — rethrow. */
  | { kind: 'leader-failed'; err: unknown }
  /** Nobody produced content — details feed the aggregate friendly error. */
  | { kind: 'all-failed'; details: string[] };

/**
 * Race the top-N candidates concurrently (chat speed path). The first
 * candidate to emit a content chunk becomes the leader and is the only one
 * whose chunks reach the client; the others keep running for redundancy and
 * simply get ignored if they finish. If the leader dies after streaming,
 * its error is rethrown (partial-output semantics). If nobody streams,
 * the caller falls through to the remaining candidates sequentially.
 */
async function raceMeshAttempts(params: {
  candidates: MeshCandidate[];
  walk: MeshWalkParams;
  budget: MeshWalkBudget;
}): Promise<MeshRaceOutcome> {
  const { candidates, walk, budget } = params;
  let leaderIdx: number | null = null;
  const attemptControllers = candidates.map(() => new AbortController());
  let notifyLeaderSettled: () => void = () => undefined;
  const leaderSettled = new Promise<void>((resolve) => {
    notifyLeaderSettled = resolve;
  });

  const settledPromise = Promise.all(
    candidates.map((candidate, idx) =>
      runMeshStreamAttempt({
        candidate,
        walk,
        budget,
        raceSignal: attemptControllers[idx].signal,
        onForwardChunk: (chunk) => {
          if (leaderIdx === null) leaderIdx = idx;
          if (leaderIdx === idx) walk.onContentChunk?.(chunk);
          // A non-leader's chunks are suppressed — the client only ever sees
          // one coherent stream.
        },
      })
        .then((result) => ({ idx, ok: true as const, result }))
        .catch((err: unknown) => ({ idx, ok: false as const, err }))
        .then((entry) => {
          if (leaderIdx === idx) notifyLeaderSettled();
          return entry;
        })
    )
  );

  // The leader decided the stream — cancel every other attempt (including
  // ones still queued on the provider single-flight slot) so chat returns
  // the moment the winner finishes instead of waiting for the slowest lane.
  void leaderSettled.then(() => {
    attemptControllers.forEach((controller, idx) => {
      if (idx !== leaderIdx) controller.abort();
    });
  });

  const settled = await settledPromise;

  if (leaderIdx !== null) {
    const leader = settled[leaderIdx];
    if (leader?.ok) return { kind: 'success', result: leader.result };
    if (leader && !leader.ok) return { kind: 'leader-failed', err: leader.err };
  }
  const details = settled.map((entry) => {
    if (entry.ok) return `${candidates[entry.idx].providerId}: empty response`;
    const info = normalizeMeshError(entry.err);
    return `${candidates[entry.idx].providerId}: ${info.message}`;
  });
  return { kind: 'all-failed', details };
}

/** Top-N race picks with at most one lane per provider — two models of the
 *  SAME provider would only queue behind each other on the single-flight
 *  slot, so racing them together just wasted the walk budget. */
function pickRaceCandidates(candidates: MeshCandidate[], count: number): MeshCandidate[] {
  const picked: MeshCandidate[] = [];
  const seenProviders = new Set<string>();
  for (const candidate of candidates) {
    if (picked.length >= count) break;
    if (seenProviders.has(candidate.providerId)) continue;
    seenProviders.add(candidate.providerId);
    picked.push(candidate);
  }
  for (const candidate of candidates) {
    if (picked.length >= count) break;
    if (!picked.includes(candidate)) picked.push(candidate);
  }
  return picked;
}

/**
 * Streaming failover walk across the whole mesh.
 *  - chat: races the top-3 candidates, then falls back sequentially.
 *  - build: streams one lane live in order (the parallel 3-agent fan-out for
 *    fresh builds lives in `_realtimeEngine` and calls this for the architect).
 * Returns the winning candidate's full output.
 * Throws FreeAiMeshUnavailableError / FreeAiMeshAllFailedError / rethrows
 * partial-output or cancellation errors immediately.
 */
export async function streamFreeAiMesh(params: MeshWalkParams): Promise<MeshStreamResult> {
  const budget = budgetFor(params.taskKind);
  let cooldownWaits = 0;

  // Bounded self-heal: when every configured engine is only SHORT-cooling
  // (busy storms recover in seconds), wait for the earliest one instead of
  // surfacing "all configured engines are cooling down". Long cooldowns
  // (rate-limit 90s, network 45s…) still fail fast with the friendly error.
  const tryWaitForCooldowns = async (): Promise<boolean> => {
    // Up to two bounded waits per walk: busy cooldowns are 6s, so one wait
    // can expire while a cross-instance lane still holds the provider —
    // a second short wait gives it room to finish instead of failing.
    if (cooldownWaits >= 2) return false;
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
    // Distinguish "nothing configured" from "everything configured but cooling
    // down / quota-capped" so the user gets an actionable message.
    if (getFreeAiMeshStatus().hasAny) {
      if (await tryWaitForCooldowns()) {
        candidates = prioritizeCandidatesForRequestedModel(
          buildMeshCandidates(),
          params.requestedModel
        );
      } else {
        throw new FreeAiMeshAllFailedError([
          'all configured engines are cooling down after recent errors',
        ]);
      }
    } else {
      throw new FreeAiMeshUnavailableError();
    }
  }

  const deadlineAt = Date.now() + budget.walkMs;
  const details: string[] = [];
  let attempts = 0;
  const racedSet = new Set<MeshCandidate>();

  // When AgentRouter (or another explicit primary API key) leads, route directly
  // through that brain first so fast keyless fallback lanes don't steal chat turns.
  const primaryIsExplicitBrain = candidates[0]?.providerId === 'agentrouter';

  // Fast path: keyless chat races the top candidates so the quickest free AI answers.
  // One lane per provider — same-provider models would only queue behind
  // each other on the single-flight slot.
  if (params.taskKind === 'chat' && !primaryIsExplicitBrain && candidates.length > 1) {
    const racePicks = pickRaceCandidates(candidates, Math.min(3, candidates.length));
    attempts += racePicks.length;
    for (const pick of racePicks) racedSet.add(pick);
    const raced = await raceMeshAttempts({
      candidates: racePicks,
      walk: params,
      budget,
    });
    if (raced.kind === 'success') return raced.result;
    if (raced.kind === 'leader-failed') throw raced.err;
    details.push(...raced.details);
  }

  const runSequential = async (list: MeshCandidate[]): Promise<MeshStreamResult | null> => {
    for (const candidate of list) {
      if (racedSet.has(candidate)) continue;
      if (params.signal?.aborted) throw new Error('Request cancelled.');
      if (Date.now() > deadlineAt || attempts >= budget.maxAttempts) return null;
      attempts += 1;
      let busyRetries = 0;
      for (;;) {
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
          // Another lane (chat race, side agent, separate serverless instance)
          // holds this provider right now. Wait out the 6s busy cooldown and
          // retry THIS lane once — a fault elsewhere must not fail the walk.
          if (
            isBusyMeshError(info) &&
            busyRetries < 1 &&
            Date.now() + 6_800 < deadlineAt
          ) {
            busyRetries += 1;
            await sleepWithSignal(6_400, params.signal).catch(() => undefined);
            if (params.signal?.aborted) throw new Error('Request cancelled.');
            continue;
          }
          details.push(`${candidate.providerId}: ${info.message}`);
          break;
        }
      }
    }
    return null;
  };

  const firstPass = await runSequential(candidates);
  if (firstPass) return firstPass;

  // Everything failed or raced — one bounded cooldown wait, then retry
  // whatever recovered (busy cooldowns expire in seconds; never permanent).
  if (await tryWaitForCooldowns()) {
    const retryPass = await runSequential(buildMeshCandidates());
    if (retryPass) return retryPass;
  }

  if (attempts === 0) throw new FreeAiMeshUnavailableError();
  throw new FreeAiMeshAllFailedError(details);
}

/**
 * Non-streaming failover walk for optional sub-passes (repair, design
 * architect). NEVER throws — returns null when no lane produced output, so
 * callers can degrade gracefully inside their own timeouts.
 */
export async function completeFreeAiMesh(params: {
  taskKind: 'chat' | 'build';
  requestedModel?: string;
  systemPrompt: string;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  signal?: AbortSignal;
  /** Per-attempt first-byte budget (callers race this against their own timer). */
  timeoutMs?: number;
}): Promise<string | null> {
  const attemptMs = Math.max(3_000, Math.min(params.timeoutMs ?? 25_000, 25_000));
  let candidates = prioritizeCandidatesForRequestedModel(
    buildMeshCandidates(),
    params.requestedModel
  );
  if (candidates.length === 0) {
    // Short busy cooldowns: wait them out once (bounded) instead of silently
    // degrading the caller to architect-only output.
    const earliest = earliestMeshCooldownMs();
    // Must be able to cover a full 6s busy cooldown (was 5s — always too
    // short, so side agents failed instantly while Pollinations was busy).
    const waitCapMs = Math.min(attemptMs, 8_000);
    if (earliest > 0 && earliest <= waitCapMs && getFreeAiMeshStatus().hasAny) {
      await sleepWithSignal(earliest + 200, params.signal).catch(() => undefined);
      candidates = prioritizeCandidatesForRequestedModel(
        buildMeshCandidates(),
        params.requestedModel
      );
    }
    if (candidates.length === 0) return null;
  }

  // Queue-tolerant deadline: the first-byte budget starts only AFTER the
  // single-flight slot is granted (inside completeOneMeshCandidate), so a
  // side agent queued behind a long architect stream must not have its whole
  // budget consumed while waiting. Grace covers the slot wait itself.
  const deadlineAt = Date.now() + attemptMs + 130_000;
  for (const candidate of candidates) {
    if (params.signal?.aborted) return null;
    if (Date.now() > deadlineAt) return null;
    let busyRetries = 0;
    for (;;) {
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
        markGatewayCandidateCooldown(candidate.cooldownKey, 45_000, false);
        break;
      } catch (err) {
        if (params.signal?.aborted) return null;
        const info = normalizeMeshError(err);
        const { ms, hard } = cooldownForMeshError(info);
        markGatewayCandidateCooldown(candidate.cooldownKey, ms, hard);
        // Busy = another lane holds the provider. Wait out the short cooldown
        // and retry this lane once before moving on (fault isolation).
        if (
          isBusyMeshError(info) &&
          !hard &&
          busyRetries < 1 &&
          Date.now() + ms + 600 < deadlineAt
        ) {
          busyRetries += 1;
          await sleepWithSignal(ms + 400, params.signal).catch(() => undefined);
          if (params.signal?.aborted) return null;
          continue;
        }
        break;
      } finally {
        unlink();
      }
    }
  }
  return null;
}
