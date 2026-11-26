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
  getGeminiBaseUrlOverride,
  getGeminiEffectiveBaseUrl,
  getServerGeminiApiKeys,
  inferGeminiThinkingMode,
  isBuilderCompatibleGeminiModel,
  isGatewayCandidateHardBlocked,
  isGemini4SeriesModel,
  makeGeminiDisplayLabel,
  markApiKeyInvalidCooldown,
  markGatewayCandidateCooldown,
  parseGatewayModelIdentifier,
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

function createSdkClient(apiKey: string): GoogleGenAI {
  const baseUrlOverride = getGeminiBaseUrlOverride();
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

let geminiModelsCache: { models: string[]; at: number } | null = null;

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

export async function refreshGeminiModelsIfConfigured(): Promise<string[]> {
  const keys = getServerGeminiApiKeys();
  if (keys.length === 0) return [];
  const discovered = await discoverLiveGeminiModelsForKey(keys[0], true).catch(() => []);
  if (discovered.length > 0) {
    geminiModelsCache = { models: discovered, at: Date.now() };
    recordGeminiDiag(`${getGeminiEffectiveBaseUrl()}/v1beta/models`, 200, `ok (${discovered.length} models)`);
  }
  return resolveGeminiModels();
}

function resolveGeminiModels(): string[] {
  const singleOverride = (process.env.GEMINI_MODEL || '').trim();
  const csvOverride = readEnvCsv('GEMINI_MODELS');
  const envModels = [
    ...singleOverride.split(',').map((s) => s.trim()).filter(Boolean),
    ...csvOverride,
  ]
    .filter((m) => isBuilderCompatibleGeminiModel(m))
    .filter((m, idx, arr) => arr.indexOf(m) === idx);

  if (envModels.length > 0) {
    return envModels.slice(0, 12);
  }

  const live = geminiModelsCache?.models || [];
  const baseList =
    live.length > 0
      ? [
          ...FREE_MODEL_CATALOG.gemini.filter((m) => live.includes(m)),
          ...live.filter((m) => !FREE_MODEL_CATALOG.gemini.includes(m)),
        ]
      : FREE_MODEL_CATALOG.gemini;

  return baseList.slice(0, 12);
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
  cooldownKey: string;
}

const MAX_MODELS_PER_KEY = 8;
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
    return { firstByteMs: 35_000, idleMs: 40_000, walkMs: 90_000, maxAttempts: 6 };
  }
  return { firstByteMs: 55_000, idleMs: 65_000, walkMs: 140_000, maxAttempts: 8 };
}

function enumerateMeshCandidates(): Array<{ candidate: MeshCandidate; coolingMs: number }> {
  const keys = getServerGeminiApiKeys();
  if (keys.length === 0) return [];
  const models = resolveGeminiModels().slice(0, MAX_MODELS_PER_KEY);
  const all: Array<{ candidate: MeshCandidate; coolingMs: number }> = [];

  for (const model of models) {
    if (isDailyQuotaExhausted('gemini', model)) continue;
    for (const apiKey of keys) {
      const cooldownKey = buildCandidateCooldownKey('gemini', apiKey, model);
      if (isGatewayCandidateHardBlocked(cooldownKey)) continue;
      all.push({
        candidate: {
          providerId: 'gemini',
          providerLabel: 'Google Gemini',
          keyless: false,
          apiKey,
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

  const parsed = parseGatewayModelIdentifier(req);
  const targetModel = parsed.upstreamModelId;
  if (!targetModel) return candidates;

  const exact = candidates.filter((c) => c.model === targetModel);
  const others = candidates.filter((c) => c.model !== targetModel);
  if (exact.length > 0) {
    return [...exact, ...others];
  }

  const keys = getServerGeminiApiKeys();
  if (keys.length > 0 && !isDailyQuotaExhausted('gemini', targetModel)) {
    const fallbackEntries: MeshCandidate[] = [];
    for (const apiKey of keys) {
      const cooldownKey = buildCandidateCooldownKey('gemini', apiKey, targetModel);
      if (
        !isGatewayCandidateHardBlocked(cooldownKey) &&
        gatewayCandidateCooldownRemainingMs(cooldownKey) <= 0
      ) {
        fallbackEntries.push({
          providerId: 'gemini',
          providerLabel: 'Google Gemini',
          keyless: false,
          apiKey,
          model: targetModel,
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
  return GEMINI_BUILDER_MODELS.map((m) => ({
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
          error?: { message?: string; code?: string | number; status?: string };
          message?: string;
        };
        message = parsed?.error?.message || parsed?.message || message;
      } catch {
        // ignore JSON parse issues
      }
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
  for (const item of (params.historyMessages || []).slice(-10)) {
    const text = typeof item?.content === 'string' ? item.content.trim() : '';
    if (!text) continue;
    contents.push({
      role: item.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: text.slice(0, 4000) }],
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
  abortSignal?: AbortSignal
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
  if (isG4) {
    config.thinkingConfig = {
      includeThoughts: true,
    };
  } else if (thinkingMode === 'level') {
    config.thinkingConfig = {
      includeThoughts: true,
    };
  }

  return config;
}

// ---------------------------------------------------------------------------
// Streaming & Non-Streaming Execution
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

async function streamOneMeshCandidateRaw(
  candidate: MeshCandidate,
  params: MeshAttemptParams,
  onChunk: (text: string) => void,
  onReasoning?: (text: string) => void
): Promise<string> {
  const hasImage = Boolean(params.attachmentDataUrl?.startsWith('data:image/'));
  const maxImagePasses = hasImage ? 2 : 1;
  let lastErr: unknown = null;

  for (let pass = 0; pass < maxImagePasses; pass += 1) {
    const withImage = hasImage && pass === 0;
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
      const ai = createSdkClient(candidate.apiKey);
      const contents = buildGeminiContents({
        historyMessages: params.historyMessages,
        userPrompt: params.userPrompt,
        attachmentDataUrl: params.attachmentDataUrl,
        withImage,
      });
      const config = buildGeminiGenerateConfig(
        candidate.model,
        params.systemPrompt,
        controller.signal
      );

      const stream = await ai.models.generateContentStream({
        model: candidate.model,
        contents,
        config,
      });

      resetIdle();
      let raw = '';
      let promptTokens = 0;
      let candidatesTokens = 0;
      let totalTokens = 0;

      for await (const chunk of stream) {
        if (!gotFirstEvent) {
          gotFirstEvent = true;
          clearTimeout(firstByteTimer);
        }
        resetIdle();

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

      recordGeminiDiag(
        `${getGeminiEffectiveBaseUrl()}/v1beta/models/${candidate.model}`,
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
        `${getGeminiEffectiveBaseUrl()}/v1beta/models/${candidate.model}`,
        info.status,
        friendlyErr instanceof Error ? friendlyErr.message : info.message
      );

      if (
        withImage &&
        info.status !== null &&
        [400, 413, 415, 422].includes(info.status)
      ) {
        continue;
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
    void recordGeminiApiError({
      modelId: candidate.model,
      error: err,
      source: walk.taskKind,
    });
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
      if (isAuthError(info) && getServerGeminiApiKeys().length <= 1) return null;
    } finally {
      unlink();
    }
  }
  return null;
}
