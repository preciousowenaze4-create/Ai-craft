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
    const tail = details.slice(-3).join('; ');
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

function readEnvKey(...names: string[]): string {
  for (const name of names) {
    const raw = (process.env[name] || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) continue;
    if (/^(my[_-]|your[_-]|xxx+|<|change[-_]?me|placeholder)/i.test(raw)) continue;
    return raw;
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
  return [...preferred, ...rest].slice(0, 24);
}

const MESH_PROVIDERS: MeshProviderDef[] = [
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

const MAX_MODELS_PER_PROVIDER = 5;
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

/** Chat = fast (raced); build = roomier (single live stream / agents). */
function budgetFor(taskKind: 'chat' | 'build'): MeshWalkBudget {
  if (taskKind === 'chat') {
    return { firstByteMs: 6_000, idleMs: 20_000, walkMs: 30_000, maxAttempts: 8 };
  }
  return { firstByteMs: 10_000, idleMs: 45_000, walkMs: 65_000, maxAttempts: 12 };
}

function buildMeshCandidates(): MeshCandidate[] {
  const out: MeshCandidate[] = [];
  for (const def of MESH_PROVIDERS) {
    if (out.length >= MAX_ATTEMPTS_PER_WALK) break;
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
      if (isGatewayCandidateCoolingDown(cooldownKey)) continue;
      out.push({
        providerId: def.id,
        providerLabel: def.label,
        keyless: def.keyless,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        model,
        cooldownKey,
      });
      if (out.length >= MAX_ATTEMPTS_PER_WALK) break;
    }
  }
  return out;
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
  return [
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
    },
  ];
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

function cooldownForMeshError(info: MeshErrorInfo): { ms: number; hard: boolean } {
  const lower = info.message.toLowerCase();
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
      detail?: string;
    };
    const msg = obj.error?.message || obj.message || obj.detail;
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
      throw new MeshHttpError(
        extractOpenAiError(json, text || `HTTP ${res.status}`),
        res.status,
        json ?? text
      );
    }
    return res;
  } catch (err) {
    if (err instanceof MeshHttpError) throw err;
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
async function streamOneMeshCandidate(
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

async function completeOneMeshCandidate(
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
  const { json, text } = await readMeshResponseBody(res);
  const errField = (json as { error?: unknown } | null)?.error;
  if (errField) {
    throw new MeshHttpError(extractOpenAiError(json, 'provider error'), res.status, json);
  }
  const content =
    ((json as { choices?: Array<{ message?: { content?: string } }> } | null)?.choices?.[0]
      ?.message?.content as string | undefined) || '';
  return content || text;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface MeshWalkParams {
  taskKind: 'chat' | 'build';
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
}): Promise<MeshStreamResult> {
  const { candidate, walk, budget } = params;
  const modelId = `mesh::${candidate.providerId}::${candidate.model}`;
  const modelName = `${candidate.providerLabel} · ${candidate.model}`;
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
    markGatewayCandidateCooldown(candidate.cooldownKey, 45_000, false);
    throw new MeshHttpError('empty response', null);
  } catch (err) {
    // Content already reached the caller — surface immediately so the engine
    // can finalize partial HTML exactly like the previous path did.
    if (emitted) throw err;
    if (walk.signal?.aborted) throw new Error('Request cancelled.');
    const info = normalizeMeshError(err);
    const { ms, hard } = cooldownForMeshError(info);
    markGatewayCandidateCooldown(candidate.cooldownKey, ms, hard);
    throw err;
  } finally {
    unlink();
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

  const settled = await Promise.all(
    candidates.map((candidate, idx) =>
      runMeshStreamAttempt({
        candidate,
        walk,
        budget,
        onForwardChunk: (chunk) => {
          if (leaderIdx === null) leaderIdx = idx;
          if (leaderIdx === idx) walk.onContentChunk?.(chunk);
          // A non-leader's chunks are suppressed — the client only ever sees
          // one coherent stream.
        },
      })
        .then((result) => ({ idx, ok: true as const, result }))
        .catch((err: unknown) => ({ idx, ok: false as const, err }))
    )
  );

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
  const candidates = buildMeshCandidates();
  if (candidates.length === 0) {
    // Distinguish "nothing configured" from "everything configured but cooling
    // down / quota-capped" so the user gets an actionable message.
    if (getFreeAiMeshStatus().hasAny) {
      throw new FreeAiMeshAllFailedError([
        'all configured engines are cooling down after recent errors',
      ]);
    }
    throw new FreeAiMeshUnavailableError();
  }

  const deadlineAt = Date.now() + budget.walkMs;
  const details: string[] = [];
  let attempts = 0;
  let nextIndex = 0;

  // Fast path: chat races the top candidates so the quickest free AI answers.
  if (params.taskKind === 'chat' && candidates.length > 1) {
    const raceCount = Math.min(3, candidates.length);
    attempts += raceCount;
    nextIndex = raceCount;
    const raced = await raceMeshAttempts({
      candidates: candidates.slice(0, raceCount),
      walk: params,
      budget,
    });
    if (raced.kind === 'success') return raced.result;
    if (raced.kind === 'leader-failed') throw raced.err;
    details.push(...raced.details);
  }

  for (let i = nextIndex; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (params.signal?.aborted) throw new Error('Request cancelled.');
    if (Date.now() > deadlineAt || attempts >= budget.maxAttempts) break;
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
      details.push(`${candidate.providerId}: ${info.message}`);
    }
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
  systemPrompt: string;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  signal?: AbortSignal;
  /** Per-attempt first-byte budget (callers race this against their own timer). */
  timeoutMs?: number;
}): Promise<string | null> {
  const candidates = buildMeshCandidates();
  if (candidates.length === 0) return null;

  const deadlineAt = Date.now() + Math.max(5_000, params.timeoutMs ?? 25_000);
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
        firstByteTimeoutMs: Math.max(3_000, Math.min(params.timeoutMs ?? 25_000, 25_000)),
      });
      if (out.trim()) {
        recordDailyUsage(candidate.providerId, candidate.model);
        return out;
      }
      markGatewayCandidateCooldown(candidate.cooldownKey, 45_000, false);
    } catch (err) {
      if (params.signal?.aborted) return null;
      const info = normalizeMeshError(err);
      const { ms, hard } = cooldownForMeshError(info);
      markGatewayCandidateCooldown(candidate.cooldownKey, ms, hard);
    } finally {
      unlink();
    }
  }
  return null;
}
