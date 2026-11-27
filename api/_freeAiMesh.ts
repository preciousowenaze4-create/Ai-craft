/**
 * AI Craft — Gemini Brain Engine
 *
 * Routes every chat, thinking, and app-build request directly to Google Gemini
 * via the official `@google/genai` SDK (`GEMINI_API_KEY`).
 *
 * Features:
 * - Native Gemini 4 & 3.1 streaming via `ai.models.generateContentStream`
 * - Thought summaries streamed via `part.thought` -> `onReasoningChunk`
 * - Strict Gemini 4 config discipline (zero temperature/topP/topK/thinkingBudget overrides)
 * - Multimodal image understanding via `inlineData` attachments
 * - Model & multi-key cooldown + daily quota failover
 */

import { GoogleGenAI, type Content, type GenerateContentConfig, type Part } from '@google/genai';
import {
  DEFAULT_GEMINI_BASE_URL,
  GEMINI_BUILDER_MODELS,
  buildCandidateCooldownKey,
  discoverLiveGeminiModelsForKey,
  gatewayCandidateCooldownRemainingMs,
  getEnvGeminiModelsOverride,
  getGeminiBaseUrlOverride,
  getGeminiEffectiveBaseUrl,
  getGeminiEndpointOverrides,
  getGeminiEnvKeyEndpointPairs,
  getServerGeminiApiKeys,
  inferGeminiThinkingMode,
  isBuilderCompatibleGeminiModel,
  isGatewayCandidateHardBlocked,
  isGemini4SeriesModel,
  makeGeminiDisplayLabel,
  markApiKeyInvalidCooldown,
  markGatewayCandidateCooldown,
  parseGatewayModelIdentifier,
  scoreDiscoveredGeminiModel,
} from './_aiGateways.js';
import {
  FREE_MODEL_CATALOG,
  nextDailyResetAt,
  staticCatalogSize,
  utcQuotaDay,
} from './_freeAiCatalog.js';
import {
  recordGeminiApiError,
  recordGeminiApiUsage,
} from './_geminiUsage.js';

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
      'GEMINI_API_KEY is not configured on the backend. Add your Gemini API key in Settings > Secrets (or Vercel environment variables).'
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
      `Gemini request failed${tail ? ` (${tail})` : ''}. Check your GEMINI_API_KEY in Settings > Secrets and try again.`
    );
    this.name = 'FreeAiMeshAllFailedError';
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Env & helper utilities
// ---------------------------------------------------------------------------

function readEnvNumber(name: string, defaultValue: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return Math.floor(parsed);
}

function createSdkClient(apiKey: string, baseUrl?: string): GoogleGenAI {
  const baseUrlOverride = baseUrl || getGeminiBaseUrlOverride();
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

// ---------------------------------------------------------------------------
// Abortable sleep + concurrency guard
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
      throw new MeshHttpError('Timed out waiting for Gemini slot', null);
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
// Gemini credentials, model discovery & diagnostics
// ---------------------------------------------------------------------------

let lastGeminiDiag: {
  checkedAt: string;
  endpoint: string;
  status: number | null;
  message: string;
} | null = null;

function sanitizeDiagMessage(rawMessage: string): string {
  return String(rawMessage || '')
    .replace(/AIza[A-Za-z0-9_-]{8,}/g, 'AIza***')
    .replace(/key=[A-Za-z0-9._-]+/gi, 'key=***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .trim()
    .slice(0, 220);
}

function recordGeminiDiag(
  endpoint: string,
  status: number | null,
  rawMessage: string
): void {
  lastGeminiDiag = {
    checkedAt: new Date().toISOString(),
    endpoint,
    status,
    message: sanitizeDiagMessage(rawMessage),
  };
}

export function getGeminiDiagnostic(): {
  configured: boolean;
  keyCount: number;
  apiOrigin: string;
  lastCheckedAt: string | null;
  lastEndpoint: string | null;
  lastStatus: number | null;
  lastMessage: string | null;
} {
  const keys = getServerGeminiApiKeys();
  return {
    configured: keys.length > 0,
    keyCount: keys.length,
    apiOrigin: getGeminiEffectiveBaseUrl() || DEFAULT_GEMINI_BASE_URL,
    lastCheckedAt: lastGeminiDiag?.checkedAt ?? null,
    lastEndpoint: lastGeminiDiag?.endpoint ?? null,
    lastStatus: lastGeminiDiag?.status ?? null,
    lastMessage: lastGeminiDiag?.message ?? null,
  };
}

export function isGeminiConfigured(): boolean {
  return getServerGeminiApiKeys().length > 0;
}

export function getGeminiApiOrigin(): string {
  return getGeminiEffectiveBaseUrl();
}

let geminiModelsCache: {
  signature: string;
  models: string[];
  at: number;
} | null = null;

function currentDiscoverySignature(): string {
  const keys = getServerGeminiApiKeys();
  const origin = getGeminiEffectiveBaseUrl();
  const keyHead = keys.map((k) => k.slice(-6)).join(',');
  return `${origin}::${keyHead}`;
}

export async function refreshGeminiModelsIfConfigured(): Promise<string[]> {
  const keys = getServerGeminiApiKeys();
  if (keys.length === 0) return [];
  const pairs = getGeminiEnvKeyEndpointPairs();
  const endpoints = getGeminiEndpointOverrides();
  const defaultOrigin = getGeminiEffectiveBaseUrl();
  const sig = currentDiscoverySignature();

  const discoveryTasks: Array<Promise<string[]>> = [];
  const seenProbe = new Set<string>();

  for (const pair of pairs) {
    const targetOrigin = pair.isOpenAiStyle
      ? ''
      : pair.baseUrl || defaultOrigin;
    if (!targetOrigin) continue;
    const probeKey = `${pair.apiKey}::${targetOrigin}`;
    if (!seenProbe.has(probeKey)) {
      seenProbe.add(probeKey);
      discoveryTasks.push(
        discoverLiveGeminiModelsForKey(pair.apiKey, true, targetOrigin).catch(() => [])
      );
    }
    if (discoveryTasks.length >= 6) break;
  }

  for (const ep of endpoints) {
    if (ep.isOpenAiStyle) continue;
    for (const k of keys.slice(0, 3)) {
      const probeKey = `${k}::${ep.baseUrl}`;
      if (!seenProbe.has(probeKey)) {
        seenProbe.add(probeKey);
        discoveryTasks.push(
          discoverLiveGeminiModelsForKey(k, true, ep.baseUrl).catch(() => [])
        );
      }
    }
  }

  const results = await Promise.all(discoveryTasks);
  const discovered = Array.from(new Set(results.flat()));
  if (discovered.length > 0) {
    geminiModelsCache = { signature: sig, models: discovered, at: Date.now() };
    recordGeminiDiag(
      `${defaultOrigin}/v1beta/models`,
      200,
      `ok (${discovered.length} models)`
    );
  }
  return resolveGeminiModels();
}

function resolveGeminiModels(taskKind: 'chat' | 'build' = 'build'): string[] {
  const envModels = getEnvGeminiModelsOverride();
  if (envModels.length > 0) {
    return envModels.slice(0, 14);
  }

  const sig = currentDiscoverySignature();
  const cachedModels =
    geminiModelsCache && geminiModelsCache.signature === sig
      ? geminiModelsCache.models
      : [];

  const live = [...cachedModels].sort(
    (a, b) => scoreDiscoveredGeminiModel(b, taskKind) - scoreDiscoveredGeminiModel(a, taskKind)
  );
  const baseList =
    live.length > 0
      ? [
          ...FREE_MODEL_CATALOG.gemini.filter((m) => live.includes(m)),
          ...live.filter((m) => !FREE_MODEL_CATALOG.gemini.includes(m)),
          ...FREE_MODEL_CATALOG.gemini.filter((m) => !live.includes(m)),
        ]
      : FREE_MODEL_CATALOG.gemini;

  return Array.from(new Set(baseList)).slice(0, 14);
}

// ---------------------------------------------------------------------------
// Candidates, cooldowns, quotas & budgets
// ---------------------------------------------------------------------------

interface MeshCandidate {
  providerId: 'gemini';
  providerLabel: string;
  keyless: boolean;
  apiKey: string;
  model: string;
  baseUrl?: string;
  isOpenAiStyle?: boolean;
  cooldownKey: string;
}

const MAX_MODELS_PER_KEY = 14;
const MAX_ATTEMPTS_PER_WALK = 24;

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
  const keyCount = Math.max(1, getServerGeminiApiKeys().length);
  const maxAttempts = Math.min(MAX_ATTEMPTS_PER_WALK, Math.max(10, keyCount * 8));
  if (taskKind === 'chat') {
    return { firstByteMs: 35_000, idleMs: 40_000, walkMs: 90_000, maxAttempts };
  }
  return { firstByteMs: 55_000, idleMs: 65_000, walkMs: 140_000, maxAttempts };
}

function resolveKeyEndpointBindings(): Array<{
  apiKey: string;
  baseUrl?: string;
  isOpenAiStyle?: boolean;
  hintedModel?: string;
}> {
  const pairs = getGeminiEnvKeyEndpointPairs();
  if (pairs.length === 0) return [];
  const endpoints = getGeminiEndpointOverrides();
  const out: Array<{
    apiKey: string;
    baseUrl?: string;
    isOpenAiStyle?: boolean;
    hintedModel?: string;
  }> = [];
  const seen = new Set<string>();

  for (const pair of pairs) {
    if (pair.baseUrl) {
      const k = `${pair.apiKey}::${pair.baseUrl}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(pair);
      }
    } else if (endpoints.length > 0) {
      for (const ep of endpoints) {
        const k = `${pair.apiKey}::${ep.rawEndpointUrl}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({
            apiKey: pair.apiKey,
            baseUrl: ep.baseUrl,
            isOpenAiStyle: ep.isOpenAiStyle,
            hintedModel: ep.hintedModel,
          });
        }
      }
    } else {
      const k = `${pair.apiKey}::default`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(pair);
      }
    }
  }
  return out;
}

function enumerateMeshCandidates(
  taskKind: 'chat' | 'build' = 'build'
): Array<{ candidate: MeshCandidate; coolingMs: number }> {
  const bindings = resolveKeyEndpointBindings();
  if (bindings.length === 0) return [];
  const models = resolveGeminiModels(taskKind).slice(0, MAX_MODELS_PER_KEY);
  const all: Array<{ candidate: MeshCandidate; coolingMs: number }> = [];

  for (const model of models) {
    if (isDailyQuotaExhausted('gemini', model)) continue;
    for (const binding of bindings) {
      const effectiveModel = binding.hintedModel && models.length === 0
        ? binding.hintedModel
        : model;
      const cooldownKey = `${buildCandidateCooldownKey(
        'gemini',
        binding.apiKey,
        effectiveModel
      )}:${binding.baseUrl || 'default'}`;
      if (isGatewayCandidateHardBlocked(cooldownKey)) continue;
      all.push({
        candidate: {
          providerId: 'gemini',
          providerLabel: 'Google Gemini',
          keyless: false,
          apiKey: binding.apiKey,
          model: effectiveModel,
          ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
          ...(binding.isOpenAiStyle ? { isOpenAiStyle: true } : {}),
          cooldownKey,
        },
        coolingMs: gatewayCandidateCooldownRemainingMs(cooldownKey),
      });
    }
  }
  return all;
}

function buildMeshCandidates(taskKind: 'chat' | 'build' = 'build'): MeshCandidate[] {
  const out: MeshCandidate[] = [];
  for (const entry of enumerateMeshCandidates(taskKind)) {
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

  const parsed = parseGatewayModelIdentifier(req);
  const targetModel = parsed.upstreamModelId;
  if (!targetModel) return candidates;

  const exact = candidates.filter((c) => c.model === targetModel);
  const others = candidates.filter((c) => c.model !== targetModel);
  if (exact.length > 0) {
    return [...exact, ...others];
  }

  const sig = currentDiscoverySignature();
  const liveDiscovered =
    geminiModelsCache && geminiModelsCache.signature === sig
      ? geminiModelsCache.models
      : [];
  const envModels = getEnvGeminiModelsOverride();
  const shouldInjectRequestedFallback =
    (liveDiscovered.length === 0 || liveDiscovered.includes(targetModel)) &&
    (envModels.length === 0 || envModels.includes(targetModel));

  const keys = getServerGeminiApiKeys();
  if (
    shouldInjectRequestedFallback &&
    keys.length > 0 &&
    !isDailyQuotaExhausted('gemini', targetModel)
  ) {
    const bindings = resolveKeyEndpointBindings();
    const fallbackEntries: MeshCandidate[] = [];
    for (const binding of bindings) {
      const cooldownKey = `${buildCandidateCooldownKey(
        'gemini',
        binding.apiKey,
        targetModel
      )}:${binding.baseUrl || 'default'}`;
      if (
        !isGatewayCandidateHardBlocked(cooldownKey) &&
        gatewayCandidateCooldownRemainingMs(cooldownKey) <= 0
      ) {
        fallbackEntries.push({
          providerId: 'gemini',
          providerLabel: 'Google Gemini',
          keyless: false,
          apiKey: binding.apiKey,
          model: targetModel,
          ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
          ...(binding.isOpenAiStyle ? { isOpenAiStyle: true } : {}),
          cooldownKey,
        });
      }
    }
    if (fallbackEntries.length > 0) {
      return [...fallbackEntries, ...others];
    }
  }

  return others;
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
  const configured = isGeminiConfigured();
  const models = resolveGeminiModels();
  const providers: MeshProviderStatus[] = [
    {
      id: 'gemini',
      label: 'Google Gemini',
      keyless: false,
      configured,
      modelCount: configured ? models.length : 0,
    },
  ];
  return {
    providers,
    hasAny: configured,
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
  const base: FreeMeshModelOption[] = GEMINI_BUILDER_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    contextLength: m.contextLength,
    isFree: m.isFree,
    gateway: m.gateway,
    tierLabel: m.tierLabel,
    capabilities: m.capabilities,
    category: m.category,
  }));

  const seen = new Set(base.map((m) => m.id));
  const sig = currentDiscoverySignature();
  const discovered =
    geminiModelsCache && geminiModelsCache.signature === sig
      ? geminiModelsCache.models
      : [];
  const extras = [...getEnvGeminiModelsOverride(), ...discovered];
  for (const upstream of extras) {
    const id = `gemini::${upstream}`;
    if (seen.has(id)) continue;
    seen.add(id);
    base.push({
      id,
      name: makeGeminiDisplayLabel(upstream),
      provider: 'gemini',
      contextLength: 1048576,
      isFree: true,
      gateway: 'gemini',
      tierLabel: 'Live · Endpoint',
      capabilities: ['Chat', 'Code', 'Vision'],
      category: 'code',
    });
  }

  return base;
}

interface MeshErrorInfo {
  status: number | null;
  message: string;
}

function unwrapJsonErrorPayload(
  rawText: string,
  depth = 0
): { status: number | null; message: string } | null {
  if (depth > 3 || typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed) as
      | {
          error?: { message?: string; code?: string | number; status?: string };
          message?: string;
          code?: string | number;
        }
      | Array<{ error?: { message?: string; code?: string | number }; message?: string }>;
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!obj || typeof obj !== 'object') return null;
    const rawCode = obj.error?.code ?? obj.code;
    const numericCode =
      typeof rawCode === 'number'
        ? rawCode
        : typeof rawCode === 'string' && /^\d{3}$/.test(rawCode)
          ? Number(rawCode)
          : null;
    const innerMsg = obj.error?.message || obj.message || '';
    if (innerMsg) {
      const nested = unwrapJsonErrorPayload(innerMsg, depth + 1);
      if (nested) {
        return {
          status: nested.status ?? numericCode,
          message: nested.message,
        };
      }
      return { status: numericCode, message: innerMsg };
    }
    return numericCode ? { status: numericCode, message: trimmed } : null;
  } catch {
    return null;
  }
}

function normalizeMeshError(err: unknown): MeshErrorInfo {
  if (err && typeof err === 'object') {
    const anyErr = err as {
      status?: number;
      statusCode?: number;
      message?: string;
      body?: unknown;
    };
    let status =
      typeof anyErr.status === 'number'
        ? anyErr.status
        : typeof anyErr.statusCode === 'number'
          ? anyErr.statusCode
          : null;
    let message = typeof anyErr.message === 'string' ? anyErr.message : String(err);

    const unwrappedFromMessage = unwrapJsonErrorPayload(message);
    if (unwrappedFromMessage) {
      status = status ?? unwrappedFromMessage.status;
      message = unwrappedFromMessage.message || message;
    }

    if (anyErr.body != null) {
      const text =
        typeof anyErr.body === 'string' ? anyErr.body : JSON.stringify(anyErr.body);
      const unwrappedBody = unwrapJsonErrorPayload(text);
      if (unwrappedBody) {
        status = status ?? unwrappedBody.status;
        message = unwrappedBody.message || message;
      }
    }

    if (status === null && /\b429\b|RESOURCE_EXHAUSTED/i.test(message)) {
      status = 429;
    } else if (status === null && /\b401\b|\b403\b|PERMISSION_DENIED|API_KEY_INVALID/i.test(message)) {
      status = /401|UNAUTHENTICATED/i.test(message) ? 401 : 403;
    }

    return { status, message: message.slice(0, 300) };
  }
  return { status: null, message: String(err).slice(0, 300) };
}

export function isBusyMeshError(info: MeshErrorInfo): boolean {
  const lower = info.message.toLowerCase();
  return /previous request is still running|1 request at a time|overloaded|try again shortly/.test(
    lower
  );
}

function isAuthError(info: MeshErrorInfo): boolean {
  const lower = info.message.toLowerCase();
  return (
    info.status === 401 ||
    info.status === 403 ||
    /api_key_invalid|invalid.?api.?key|api key not valid|unauthorized|permission_denied|forbidden/.test(
      lower
    )
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
    return { ms: 5_000, hard: false };
  }
  if (
    info.status === 404 ||
    /model[_ ]?not[_ ]?found|is not found|not supported for generatecontent|unknown model/.test(
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
    /resource_exhausted|rate.?limit|too many requests|quota|limit reached|overloaded/.test(lower)
  ) {
    return { ms: 45_000, hard: false };
  }
  if (info.status !== null && info.status >= 500) {
    return { ms: 20_000, hard: false };
  }
  return { ms: 20_000, hard: false };
}

// ---------------------------------------------------------------------------
// Gemini Content Building & Config Rules
// ---------------------------------------------------------------------------

function buildGeminiContents(params: {
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  withImage?: boolean;
}): Content[] {
  const contents: Content[] = [];
  for (const item of (params.historyMessages || []).slice(-16)) {
    const text = typeof item?.content === 'string' ? item.content.trim() : '';
    if (!text) continue;
    contents.push({
      role: item.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: text.slice(0, 4500) }],
    });
  }

  const userParts: Part[] = [];
  if (params.withImage && params.attachmentDataUrl?.startsWith('data:image/')) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i.exec(
      params.attachmentDataUrl
    );
    if (match?.[1] && match?.[2]) {
      userParts.push({
        inlineData: {
          mimeType: match[1],
          data: match[2],
        },
      });
    }
  }
  userParts.push({ text: params.userPrompt.slice(0, 30000) });
  contents.push({ role: 'user', parts: userParts });
  return contents;
}

function buildGeminiGenerateConfig(
  modelId: string,
  systemPrompt: string,
  abortSignal?: AbortSignal,
  enableWebSearch?: boolean,
  enableThinking = true
): GenerateContentConfig {
  const isG4 = isGemini4SeriesModel(modelId);
  const thinkingMode = inferGeminiThinkingMode(modelId);

  const config: GenerateContentConfig = {
    abortSignal,
  };

  const trimmedSys = systemPrompt.trim();
  if (trimmedSys) {
    config.systemInstruction = trimmedSys.slice(0, 60000);
  }

  // Strictly obey Gemini 4 config rules:
  // NEVER pass temperature, topP, topK, candidateCount, or thinkingBudget on Gemini 4 models.
  if (enableThinking) {
    if (isG4 || thinkingMode === 'level') {
      config.thinkingConfig = {
        includeThoughts: true,
      };
    }
  }

  if (enableWebSearch) {
    config.tools = [{ googleSearch: {} }];
  }

  return config;
}

// ---------------------------------------------------------------------------
// Streaming & Non-Streaming Execution
// ---------------------------------------------------------------------------

export interface MeshGroundingMeta {
  queries: string[];
  sources: Array<{ title: string; url: string }>;
}

interface MeshAttemptParams {
  taskKind: 'chat' | 'build';
  systemPrompt: string;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  attachmentDataUrl?: string | null;
  enableWebSearch?: boolean;
  onGrounding?: (meta: MeshGroundingMeta) => void;
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

async function streamOpenAiCompatibleCandidate(
  candidate: MeshCandidate,
  params: MeshAttemptParams,
  signal: AbortSignal,
  onChunk: (text: string) => void
): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];
  if (params.systemPrompt.trim()) {
    messages.push({ role: 'system', content: params.systemPrompt.trim() });
  }
  for (const h of (params.historyMessages || []).slice(-16)) {
    if (h.content?.trim()) {
      messages.push({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content.trim().slice(0, 4500),
      });
    }
  }
  messages.push({ role: 'user', content: params.userPrompt.slice(0, 30000) });

  const endpoint = candidate.baseUrl!;
  const resp = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${candidate.apiKey}`,
      'User-Agent': 'aistudio-build',
    },
    body: JSON.stringify({
      model: candidate.model,
      messages,
      stream: true,
    }),
  });

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new MeshHttpError(
      bodyText || `HTTP ${resp.status} from endpoint`,
      resp.status,
      bodyText
    );
  }

  const contentType = resp.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const jsonData = (await resp.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string }; text?: string }> }
      | Array<{ choices?: Array<{ message?: { content?: string }; text?: string }> }>
      | null;
    const items = Array.isArray(jsonData) ? jsonData : jsonData ? [jsonData] : [];
    const text = items
      .map((item) => item?.choices?.[0]?.message?.content || item?.choices?.[0]?.text || '')
      .join('');
    if (text) onChunk(text);
    return text;
  }

  const reader = resp.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let buf = '';
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: { content?: string };
            message?: { content?: string };
          }>;
        };
        const delta =
          parsed?.choices?.[0]?.delta?.content ??
          parsed?.choices?.[0]?.message?.content ??
          '';
        if (delta) {
          raw += delta;
          onChunk(delta);
        }
      } catch {
        // ignore partial line
      }
    }
  }
  return raw;
}

function extractTextAndGroundingFromCandidatesPayload(
  payload: unknown,
  onGrounding?: (meta: MeshGroundingMeta) => void,
  onReasoning?: (text: string) => void
): string {
  const blocks = Array.isArray(payload) ? payload : payload ? [payload] : [];
  let text = '';
  const seenQueries = new Set<string>();
  const seenUrls = new Set<string>();

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const cand = (block as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean }> };
        groundingMetadata?: {
          webSearchQueries?: unknown[];
          groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
        };
      }>;
    }).candidates?.[0];
    if (!cand) continue;

    if (cand.groundingMetadata && onGrounding) {
      const newQueries: string[] = [];
      const newSources: Array<{ title: string; url: string }> = [];
      for (const q of cand.groundingMetadata.webSearchQueries || []) {
        const cleanQ = typeof q === 'string' ? q.trim() : '';
        if (cleanQ && !seenQueries.has(cleanQ)) {
          seenQueries.add(cleanQ);
          newQueries.push(cleanQ);
        }
      }
      for (const gc of cand.groundingMetadata.groundingChunks || []) {
        const uri = typeof gc?.web?.uri === 'string' ? gc.web.uri.trim() : '';
        const title =
          typeof gc?.web?.title === 'string' && gc.web.title.trim()
            ? gc.web.title.trim()
            : uri;
        if (uri && !seenUrls.has(uri)) {
          seenUrls.add(uri);
          newSources.push({ title, url: uri });
        }
      }
      if (newQueries.length > 0 || newSources.length > 0) {
        onGrounding({ queries: newQueries, sources: newSources });
      }
    }

    for (const part of cand.content?.parts || []) {
      if (!part?.text) continue;
      if (part.thought) {
        onReasoning?.(part.text);
      } else {
        text += part.text;
      }
    }
  }
  return text;
}

async function streamOneMeshCandidateRaw(
  candidate: MeshCandidate,
  params: MeshAttemptParams,
  onChunk: (text: string) => void,
  onReasoning?: (text: string) => void
): Promise<string> {
  const hasImage = Boolean(params.attachmentDataUrl?.startsWith('data:image/'));
  const maxPasses = hasImage || params.enableWebSearch ? 3 : 2;
  let useImagePass = hasImage;
  let useSearchPass = Boolean(params.enableWebSearch);
  let useThinkingPass = true;
  let lastErr: unknown = null;
  const endpointOrigin = candidate.baseUrl || getGeminiEffectiveBaseUrl();

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const withImage = useImagePass;
    const withSearch = useSearchPass;
    const withThinking = useThinkingPass;
    const controller = new AbortController();
    const outerSignal = params.signal?.signal;
    if (outerSignal?.aborted) throw new Error('Request cancelled.');
    const onOuterAbort = () => controller.abort();
    outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

    let gotFirstEvent = false;
    let firstByteTimedOut = false;
    let idleTimedOut = false;

    const firstByteTimer = setTimeout(() => {
      if (!gotFirstEvent) {
        firstByteTimedOut = true;
        controller.abort();
      }
    }, params.firstByteTimeoutMs);

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const idleMs = params.idleTimeoutMs ?? 45_000;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, idleMs);
    };

    try {
      if (candidate.isOpenAiStyle && candidate.baseUrl) {
        resetIdle();
        const text = await streamOpenAiCompatibleCandidate(
          candidate,
          params,
          controller.signal,
          (chunk) => {
            if (!gotFirstEvent) {
              gotFirstEvent = true;
              clearTimeout(firstByteTimer);
            }
            resetIdle();
            onChunk(chunk);
          }
        );
        gotFirstEvent = true;
        clearTimeout(firstByteTimer);
        recordGeminiDiag(endpointOrigin, 200, 'connected');
        if (text.trim()) {
          void recordGeminiApiUsage({
            modelId: candidate.model,
            totalTokens: Math.max(40, Math.ceil((params.userPrompt.length + text.length) / 4)),
            source: params.taskKind,
          });
        }
        return text;
      }

      const ai = createSdkClient(candidate.apiKey, candidate.baseUrl);
      const contents = buildGeminiContents({
        historyMessages: params.historyMessages,
        userPrompt: params.userPrompt,
        attachmentDataUrl: params.attachmentDataUrl,
        withImage,
      });
      const config = buildGeminiGenerateConfig(
        candidate.model,
        params.systemPrompt,
        controller.signal,
        withSearch,
        withThinking
      );

      let raw = '';
      let promptTokens = 0;
      let candidatesTokens = 0;
      let totalTokens = 0;
      const seenQueries = new Set<string>();
      const seenSourceUrls = new Set<string>();

      try {
        const stream = await ai.models.generateContentStream({
          model: candidate.model,
          contents,
          config,
        });

        resetIdle();

        for await (const chunk of stream) {
          if (!gotFirstEvent) {
            gotFirstEvent = true;
            clearTimeout(firstByteTimer);
          }
          resetIdle();

          const groundingMeta = chunk.candidates?.[0]?.groundingMetadata;
          if (groundingMeta && params.onGrounding) {
            const newQueries: string[] = [];
            const newSources: Array<{ title: string; url: string }> = [];
            if (Array.isArray(groundingMeta.webSearchQueries)) {
              for (const q of groundingMeta.webSearchQueries) {
                const cleanQ = typeof q === 'string' ? q.trim() : '';
                if (cleanQ && !seenQueries.has(cleanQ)) {
                  seenQueries.add(cleanQ);
                  newQueries.push(cleanQ);
                }
              }
            }
            if (Array.isArray(groundingMeta.groundingChunks)) {
              for (const gChunk of groundingMeta.groundingChunks) {
                const uri = typeof gChunk?.web?.uri === 'string' ? gChunk.web.uri.trim() : '';
                const title =
                  typeof gChunk?.web?.title === 'string' && gChunk.web.title.trim()
                    ? gChunk.web.title.trim()
                    : uri;
                if (uri && !seenSourceUrls.has(uri)) {
                  seenSourceUrls.add(uri);
                  newSources.push({ title, url: uri });
                }
              }
            }
            if (newQueries.length > 0 || newSources.length > 0) {
              params.onGrounding({ queries: newQueries, sources: newSources });
            }
          }

          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          if (parts.length > 0) {
            for (const part of parts) {
              if (!part?.text) continue;
              if (part.thought) {
                onReasoning?.(part.text);
              } else {
                raw += part.text;
                onChunk(part.text);
              }
            }
          } else if (typeof chunk.text === 'string' && chunk.text) {
            raw += chunk.text;
            onChunk(chunk.text);
          }

          if (chunk.usageMetadata) {
            promptTokens = chunk.usageMetadata.promptTokenCount ?? promptTokens;
            candidatesTokens = chunk.usageMetadata.candidatesTokenCount ?? candidatesTokens;
            totalTokens = chunk.usageMetadata.totalTokenCount ?? totalTokens;
          }
        }
      } catch (streamErr) {
        // Custom proxy endpoints sometimes return a JSON array/object instead of SSE
        const streamErrMsg =
          streamErr instanceof Error ? streamErr.message : String(streamErr);
        const isLikelyStreamParseError =
          !raw.trim() &&
          !/401|403|404|429|resource_exhausted|quota|api.?key/i.test(streamErrMsg) &&
          /json|sse|parse|syntaxerror|unexpected token|stream|body|empty/i.test(streamErrMsg);
        if (!isLikelyStreamParseError) {
          throw streamErr;
        }
        const fallbackResp = await fetch(
          `${endpointOrigin}/v1beta/models/${encodeURIComponent(candidate.model)}:generateContent?key=${encodeURIComponent(candidate.apiKey)}`,
          {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'aistudio-build',
              'x-goog-api-key': candidate.apiKey,
            },
            body: JSON.stringify({
              contents,
              ...(config.systemInstruction
                ? { systemInstruction: { parts: [{ text: String(config.systemInstruction) }] } }
                : {}),
              ...(config.tools ? { tools: config.tools } : {}),
            }),
          }
        );
        if (!fallbackResp.ok) {
          const errText = await fallbackResp.text().catch(() => '');
          throw new MeshHttpError(errText || `HTTP ${fallbackResp.status}`, fallbackResp.status, errText);
        }
        const jsonPayload = await fallbackResp.json();
        const extracted = extractTextAndGroundingFromCandidatesPayload(
          jsonPayload,
          params.onGrounding,
          onReasoning
        );
        if (extracted) {
          gotFirstEvent = true;
          clearTimeout(firstByteTimer);
          raw = extracted;
          onChunk(extracted);
        } else {
          throw streamErr;
        }
      }

      recordGeminiDiag(
        `${endpointOrigin}/v1beta/models/${candidate.model}`,
        200,
        'connected'
      );

      if (raw.trim()) {
        void recordGeminiApiUsage({
          modelId: candidate.model,
          promptTokens,
          candidatesTokens,
          totalTokens:
            totalTokens || Math.max(40, Math.ceil((params.userPrompt.length + raw.length) / 4)),
          source: params.taskKind,
        });
      }

      return raw;
    } catch (err) {
      lastErr = err;
      const info = normalizeMeshError(err);
      const friendlyErr = firstByteTimedOut
        ? new MeshHttpError('Timed out waiting for Gemini response', null)
        : idleTimedOut
          ? new MeshHttpError('Gemini stream stalled before completing', null)
          : err;
      recordGeminiDiag(
        `${endpointOrigin}/v1beta/models/${candidate.model}`,
        info.status,
        friendlyErr instanceof Error ? friendlyErr.message : info.message
      );

      const retryableStatus =
        info.status !== null &&
        [400, 403, 404, 413, 415, 422, 429].includes(info.status);
      if (pass + 1 < maxPasses && retryableStatus) {
        if (
          withSearch &&
          ([400, 413, 415, 422].includes(info.status!) ||
            /tool|search|grounding|unsupported|invalid|quota|resource_exhausted/i.test(
              info.message
            ))
        ) {
          useSearchPass = false;
          continue;
        }
        if (
          withThinking &&
          info.status === 400 &&
          /thinking|thought|includethoughts|config|unsupported/i.test(info.message)
        ) {
          useThinkingPass = false;
          continue;
        }
        if (withImage && [400, 413, 415, 422].includes(info.status!)) {
          useImagePass = false;
          continue;
        }
      }
      throw friendlyErr;
    } finally {
      clearTimeout(firstByteTimer);
      if (idleTimer) clearTimeout(idleTimer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    }
  }

  throw lastErr ?? new MeshHttpError('Gemini request failed', null);
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

async function completeOneMeshCandidate(
  candidate: MeshCandidate,
  params: MeshAttemptParams
): Promise<string> {
  await acquireProviderSlot(candidate.providerId, params.signal?.signal);
  try {
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
  enableWebSearch?: boolean;
  signal?: AbortSignal;
  onModelMeta?: (meta: { modelId: string; modelName: string; provider: string }) => void;
  onContentChunk?: (chunkText: string) => void;
  onReasoningChunk?: (reasoningText: string) => void;
  onGrounding?: (meta: MeshGroundingMeta) => void;
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
  const modelId = `gemini::${candidate.model}`;
  const modelName = makeGeminiDisplayLabel(candidate.model);
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
        enableWebSearch: walk.enableWebSearch,
        onGrounding: walk.onGrounding,
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
    if (isAuthError(info)) {
      markApiKeyInvalidCooldown(candidate.apiKey, 5 * 60_000);
    }
    throw err;
  } finally {
    unlink();
  }
}

export async function streamFreeAiMesh(params: MeshWalkParams): Promise<MeshStreamResult> {
  const sig = currentDiscoverySignature();
  if ((!geminiModelsCache || geminiModelsCache.signature !== sig) && isGeminiConfigured()) {
    await Promise.race([
      refreshGeminiModelsIfConfigured().catch(() => undefined),
      sleepWithSignal(1_800, params.signal).catch(() => undefined),
    ]);
  }

  const budget = budgetFor(params.taskKind);
  let cooldownWaits = 0;

  const tryWaitForCooldowns = async (): Promise<boolean> => {
    if (cooldownWaits >= 1) return false;
    if (!getFreeAiMeshStatus().hasAny) return false;
    if (buildMeshCandidates(params.taskKind).length > 0) return false;
    const earliest = earliestMeshCooldownMs();
    if (earliest <= 0) return false;
    const capMs = readEnvNumber('MESH_COOLDOWN_WAIT_MS', 8_000);
    if (earliest > capMs) return false;
    cooldownWaits += 1;
    await sleepWithSignal(Math.min(earliest + 300, capMs + 300), params.signal).catch(
      () => undefined
    );
    return buildMeshCandidates(params.taskKind).length > 0;
  };

  let candidates = prioritizeCandidatesForRequestedModel(
    buildMeshCandidates(params.taskKind),
    params.requestedModel
  );
  if (candidates.length === 0) {
    if (getFreeAiMeshStatus().hasAny) {
      if (await tryWaitForCooldowns()) {
        candidates = prioritizeCandidatesForRequestedModel(
          buildMeshCandidates(params.taskKind),
          params.requestedModel
        );
      } else {
        throw new FreeAiMeshAllFailedError([
          lastGeminiDiag?.message ||
            'Gemini models are temporarily cooling down after recent quota or rate-limit responses',
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
        if (isAuthError(info) && getServerGeminiApiKeys().length <= 1) {
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
  const finalErr = new FreeAiMeshAllFailedError(details);
  void recordGeminiApiError({
    modelId: candidates[0]?.model || 'gemini-4-hydrogen',
    error: finalErr,
    source: params.taskKind,
  });
  throw finalErr;
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
      if (isAuthError(info) && getServerGeminiApiKeys().length <= 1) return null;
    } finally {
      unlink();
    }
  }
  return null;
}
