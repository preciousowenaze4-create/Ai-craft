import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { getServerGeminiApiKey } from './_aiGateways.js';
import { getSupabaseConfig } from './_supabaseAuth.js';

const USAGE_BUCKET = 'aicraft-user-data';
const USAGE_OBJECT_PATH = '__moderation/gemini_usage.json';

export const DEFAULT_DAILY_REQUESTS_LIMIT = 1500;
export const DEFAULT_DAILY_TOKENS_LIMIT = 1000000;
export const DEFAULT_OVERALL_TOKENS_LIMIT = 2000000;

export type GeminiQuotaStatus =
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'exhausted'
  | 'unconfigured';

export interface PersistedGeminiUsage {
  version: 1;
  keyFingerprint: string;
  keyMask: string;
  dailyDate: string;
  dailyRequestsUsed: number;
  dailyRequestsLimit: number;
  dailyTokensUsed: number;
  dailyTokensLimit: number;
  cycleRequestsUsed: number;
  cycleTokensUsed: number;
  overallTokensLimit: number;
  lifetimeRequestsUsed: number;
  lifetimeTokensUsed: number;
  quotaExhausted: boolean;
  exhaustedReason?: string;
  lastErrorAt?: string;
  lastUsageAt?: string;
  lastModelId?: string;
  lastSource?: string;
  updatedAt: string;
}

export interface GeminiApiUsageSnapshot {
  keyConfigured: boolean;
  keyMask: string;
  dailyDate: string;
  dailyRequestsUsed: number;
  dailyRequestsLimit: number;
  dailyRequestsRemaining: number;
  dailyTokensUsed: number;
  dailyTokensLimit: number;
  dailyTokensRemaining: number;
  cycleRequestsUsed: number;
  cycleTokensUsed: number;
  overallTokensLimit: number;
  overallTokensRemaining: number;
  lifetimeRequestsUsed: number;
  lifetimeTokensUsed: number;
  dailyRemainingPercent: number;
  overallRemainingPercent: number;
  remainingPercent: number;
  quotaExhausted: boolean;
  exhaustedReason?: string;
  lastErrorAt?: string;
  lastUsageAt?: string;
  lastModelId?: string;
  status: GeminiQuotaStatus;
  updatedAt: string;
}

function getLocalUsageCachePath(): string {
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  return isServerless
    ? '/tmp/.aicraft-gemini-usage.json'
    : path.resolve(process.cwd(), '.aicraft-gemini-usage.json');
}

function getUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function computeKeyIdentity(): {
  keyConfigured: boolean;
  keyFingerprint: string;
  keyMask: string;
} {
  const key = getServerGeminiApiKey();
  if (!key) {
    return {
      keyConfigured: false,
      keyFingerprint: '',
      keyMask: 'Not set',
    };
  }
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  const tail = key.length >= 4 ? key.slice(-4) : key;
  return {
    keyConfigured: true,
    keyFingerprint: hash,
    keyMask: `••••${tail}`,
  };
}

function createDefaultState(): PersistedGeminiUsage {
  const id = computeKeyIdentity();
  return {
    version: 1,
    keyFingerprint: id.keyFingerprint,
    keyMask: id.keyMask,
    dailyDate: getUtcDateKey(),
    dailyRequestsUsed: 0,
    dailyRequestsLimit: DEFAULT_DAILY_REQUESTS_LIMIT,
    dailyTokensUsed: 0,
    dailyTokensLimit: DEFAULT_DAILY_TOKENS_LIMIT,
    cycleRequestsUsed: 0,
    cycleTokensUsed: 0,
    overallTokensLimit: DEFAULT_OVERALL_TOKENS_LIMIT,
    lifetimeRequestsUsed: 0,
    lifetimeTokensUsed: 0,
    quotaExhausted: false,
    updatedAt: new Date(0).toISOString(),
  };
}

let memoryState: PersistedGeminiUsage | null = null;
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueueLocked<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(fn, fn);
  mutationQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function createServiceClient() {
  const { url, serviceRoleKey } = getSupabaseConfig();
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function sanitizePositiveInt(value: unknown, fallback: number, min = 1, max = 1_000_000_000): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < min) return fallback;
  return Math.min(max, Math.round(num));
}

function sanitizeNonNegativeInt(value: unknown, fallback = 0): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.round(num);
}

function normalizePersistedState(raw: Partial<PersistedGeminiUsage> | null | undefined): PersistedGeminiUsage {
  const base = createDefaultState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: 1,
    keyFingerprint: typeof raw.keyFingerprint === 'string' ? raw.keyFingerprint : base.keyFingerprint,
    keyMask: typeof raw.keyMask === 'string' ? raw.keyMask : base.keyMask,
    dailyDate:
      typeof raw.dailyDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.dailyDate)
        ? raw.dailyDate
        : base.dailyDate,
    dailyRequestsUsed: sanitizeNonNegativeInt(raw.dailyRequestsUsed, 0),
    dailyRequestsLimit: sanitizePositiveInt(raw.dailyRequestsLimit, DEFAULT_DAILY_REQUESTS_LIMIT, 10, 10_000_000),
    dailyTokensUsed: sanitizeNonNegativeInt(raw.dailyTokensUsed, 0),
    dailyTokensLimit: sanitizePositiveInt(raw.dailyTokensLimit, DEFAULT_DAILY_TOKENS_LIMIT, 1000, 1_000_000_000),
    cycleRequestsUsed: sanitizeNonNegativeInt(raw.cycleRequestsUsed, 0),
    cycleTokensUsed: sanitizeNonNegativeInt(raw.cycleTokensUsed, 0),
    overallTokensLimit: sanitizePositiveInt(raw.overallTokensLimit, DEFAULT_OVERALL_TOKENS_LIMIT, 1000, 1_000_000_000),
    lifetimeRequestsUsed: sanitizeNonNegativeInt(raw.lifetimeRequestsUsed, 0),
    lifetimeTokensUsed: sanitizeNonNegativeInt(raw.lifetimeTokensUsed, 0),
    quotaExhausted: Boolean(raw.quotaExhausted),
    exhaustedReason: typeof raw.exhaustedReason === 'string' ? raw.exhaustedReason : undefined,
    lastErrorAt: typeof raw.lastErrorAt === 'string' ? raw.lastErrorAt : undefined,
    lastUsageAt: typeof raw.lastUsageAt === 'string' ? raw.lastUsageAt : undefined,
    lastModelId: typeof raw.lastModelId === 'string' ? raw.lastModelId : undefined,
    lastSource: typeof raw.lastSource === 'string' ? raw.lastSource : undefined,
    updatedAt:
      typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt))
        ? raw.updatedAt
        : base.updatedAt,
  };
}

function readDiskCache(): PersistedGeminiUsage | null {
  try {
    const filePath = getLocalUsageCachePath();
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    return normalizePersistedState(JSON.parse(raw) as Partial<PersistedGeminiUsage>);
  } catch {
    return null;
  }
}

function writeDiskCache(state: PersistedGeminiUsage): void {
  try {
    fs.writeFileSync(getLocalUsageCachePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // ignore read-only FS in serverless
  }
}

function pickFresherState(
  a: PersistedGeminiUsage | null,
  b: PersistedGeminiUsage | null
): PersistedGeminiUsage {
  if (!a && !b) return createDefaultState();
  if (!a) return b!;
  if (!b) return a;
  const timeA = Date.parse(a.updatedAt || '') || 0;
  const timeB = Date.parse(b.updatedAt || '') || 0;
  if (timeB > timeA) return b;
  if (timeA > timeB) return a;
  return b.lifetimeTokensUsed >= a.lifetimeTokensUsed ? b : a;
}

function reconcileKeyAndDay(state: PersistedGeminiUsage): {
  state: PersistedGeminiUsage;
  changed: boolean;
} {
  let changed = false;
  const id = computeKeyIdentity();
  const today = getUtcDateKey();
  const next = { ...state };

  // Auto-detect when owner rotates/upgrades GEMINI_API_KEY in Vercel/env
  if (id.keyConfigured && next.keyFingerprint && id.keyFingerprint !== next.keyFingerprint) {
    next.keyFingerprint = id.keyFingerprint;
    next.keyMask = id.keyMask;
    next.dailyDate = today;
    next.dailyRequestsUsed = 0;
    next.dailyTokensUsed = 0;
    next.cycleRequestsUsed = 0;
    next.cycleTokensUsed = 0;
    next.quotaExhausted = false;
    next.exhaustedReason = undefined;
    next.lastErrorAt = undefined;
    next.updatedAt = new Date().toISOString();
    changed = true;
  } else if (id.keyConfigured && (!next.keyFingerprint || next.keyMask !== id.keyMask)) {
    next.keyFingerprint = id.keyFingerprint;
    next.keyMask = id.keyMask;
    changed = true;
  } else if (!id.keyConfigured && next.keyMask !== 'Not set') {
    next.keyMask = 'Not set';
  }

  // Roll daily UTC quota counters at UTC midnight (while preserving permanent cycle + lifetime)
  if (next.dailyDate !== today) {
    next.dailyDate = today;
    next.dailyRequestsUsed = 0;
    next.dailyTokensUsed = 0;
    // Only auto-clear exhausted flag on new UTC day if it wasn't an exhausted cycle pool or invalid key
    if (
      next.quotaExhausted &&
      next.cycleTokensUsed < next.overallTokensLimit &&
      !/invalid|expired|billing|disabled/i.test(next.exhaustedReason || '')
    ) {
      next.quotaExhausted = false;
      next.exhaustedReason = undefined;
    }
    next.updatedAt = new Date().toISOString();
    changed = true;
  }

  return { state: next, changed };
}

async function ensureBucket(adminClient: NonNullable<ReturnType<typeof createServiceClient>>) {
  try {
    const { data: buckets } = await adminClient.storage.listBuckets();
    if (buckets?.some((b) => b.name === USAGE_BUCKET)) return;
    await adminClient.storage.createBucket(USAGE_BUCKET, {
      public: false,
      fileSizeLimit: 10485760,
    });
  } catch {
    // ignore if exists
  }
}

async function loadStateFromSources(): Promise<PersistedGeminiUsage> {
  const disk = readDiskCache();
  let merged = pickFresherState(memoryState, disk);

  const adminClient = createServiceClient();
  if (adminClient) {
    try {
      const { data, error } = await adminClient.storage
        .from(USAGE_BUCKET)
        .download(USAGE_OBJECT_PATH);
      if (!error && data) {
        const text = await data.text();
        if (text.trim()) {
          const cloud = normalizePersistedState(
            JSON.parse(text) as Partial<PersistedGeminiUsage>
          );
          merged = pickFresherState(merged, cloud);
        }
      }
    } catch {
      // keep disk/memory state
    }
  }

  const reconciled = reconcileKeyAndDay(merged);
  memoryState = reconciled.state;
  writeDiskCache(reconciled.state);
  if (reconciled.changed && adminClient) {
    void persistStateToCloud(reconciled.state);
  }
  return reconciled.state;
}

async function persistStateToCloud(state: PersistedGeminiUsage): Promise<void> {
  memoryState = state;
  writeDiskCache(state);
  const adminClient = createServiceClient();
  if (!adminClient) return;

  try {
    await ensureBucket(adminClient);
    const body = Buffer.from(JSON.stringify(state), 'utf8');
    await adminClient.storage.from(USAGE_BUCKET).upload(USAGE_OBJECT_PATH, body, {
      upsert: true,
      contentType: 'application/json',
    });
  } catch {
    // disk & memory still persisted
  }
}

export function buildUsageSnapshot(state: PersistedGeminiUsage): GeminiApiUsageSnapshot {
  const { keyConfigured, keyMask } = computeKeyIdentity();
  const dailyRequestsRemaining = Math.max(0, state.dailyRequestsLimit - state.dailyRequestsUsed);
  const dailyTokensRemaining = Math.max(0, state.dailyTokensLimit - state.dailyTokensUsed);
  const overallTokensRemaining = Math.max(0, state.overallTokensLimit - state.cycleTokensUsed);

  const dailyReqPct =
    state.dailyRequestsLimit > 0
      ? (dailyRequestsRemaining / state.dailyRequestsLimit) * 100
      : 0;
  const dailyTokPct =
    state.dailyTokensLimit > 0 ? (dailyTokensRemaining / state.dailyTokensLimit) * 100 : 0;
  const dailyRemainingPercent = Number(
    Math.max(0, Math.min(100, Math.min(dailyReqPct, dailyTokPct))).toFixed(1)
  );

  const overallRemainingPercent = Number(
    Math.max(
      0,
      Math.min(
        100,
        state.overallTokensLimit > 0
          ? (overallTokensRemaining / state.overallTokensLimit) * 100
          : 0
      )
    ).toFixed(1)
  );

  const effectivelyExhausted =
    state.quotaExhausted ||
    dailyRequestsRemaining <= 0 ||
    dailyTokensRemaining <= 0 ||
    overallTokensRemaining <= 0;

  const remainingPercent = !keyConfigured
    ? 0
    : effectivelyExhausted
      ? 0
      : Number(Math.min(dailyRemainingPercent, overallRemainingPercent).toFixed(1));

  let status: GeminiQuotaStatus = 'healthy';
  if (!keyConfigured) {
    status = 'unconfigured';
  } else if (effectivelyExhausted || remainingPercent <= 0) {
    status = 'exhausted';
  } else if (remainingPercent <= 15) {
    status = 'critical';
  } else if (remainingPercent <= 35) {
    status = 'warning';
  }

  return {
    keyConfigured,
    keyMask: keyConfigured ? keyMask : state.keyMask || 'Not set',
    dailyDate: state.dailyDate,
    dailyRequestsUsed: state.dailyRequestsUsed,
    dailyRequestsLimit: state.dailyRequestsLimit,
    dailyRequestsRemaining,
    dailyTokensUsed: state.dailyTokensUsed,
    dailyTokensLimit: state.dailyTokensLimit,
    dailyTokensRemaining,
    cycleRequestsUsed: state.cycleRequestsUsed,
    cycleTokensUsed: state.cycleTokensUsed,
    overallTokensLimit: state.overallTokensLimit,
    overallTokensRemaining,
    lifetimeRequestsUsed: state.lifetimeRequestsUsed,
    lifetimeTokensUsed: state.lifetimeTokensUsed,
    dailyRemainingPercent,
    overallRemainingPercent,
    remainingPercent,
    quotaExhausted: Boolean(effectivelyExhausted && keyConfigured),
    exhaustedReason: state.exhaustedReason,
    lastErrorAt: state.lastErrorAt,
    lastUsageAt: state.lastUsageAt,
    lastModelId: state.lastModelId,
    status,
    updatedAt: state.updatedAt,
  };
}

export async function getGeminiApiUsageSnapshot(): Promise<GeminiApiUsageSnapshot> {
  const state = await enqueueLocked(async () => loadStateFromSources());
  return buildUsageSnapshot(state);
}

export interface RecordGeminiUsageInput {
  modelId: string;
  promptTokens?: number;
  candidatesTokens?: number;
  totalTokens?: number;
  requests?: number;
  source?: string;
}

export async function recordGeminiApiUsage(
  input: RecordGeminiUsageInput
): Promise<GeminiApiUsageSnapshot> {
  const state = await enqueueLocked(async () => {
    const current = await loadStateFromSources();
    const prompt = sanitizeNonNegativeInt(input.promptTokens, 0);
    const candidates = sanitizeNonNegativeInt(input.candidatesTokens, 0);
    const total = Math.max(
      sanitizeNonNegativeInt(input.totalTokens, 0),
      prompt + candidates,
      1
    );
    const reqInc = sanitizePositiveInt(input.requests, 1, 1, 100);
    const now = new Date().toISOString();

    const updated: PersistedGeminiUsage = {
      ...current,
      dailyRequestsUsed: current.dailyRequestsUsed + reqInc,
      dailyTokensUsed: current.dailyTokensUsed + total,
      cycleRequestsUsed: current.cycleRequestsUsed + reqInc,
      cycleTokensUsed: current.cycleTokensUsed + total,
      lifetimeRequestsUsed: current.lifetimeRequestsUsed + reqInc,
      lifetimeTokensUsed: current.lifetimeTokensUsed + total,
      lastUsageAt: now,
      lastModelId: input.modelId,
      lastSource: input.source,
      updatedAt: now,
    };

    if (
      updated.dailyRequestsUsed >= updated.dailyRequestsLimit ||
      updated.dailyTokensUsed >= updated.dailyTokensLimit
    ) {
      updated.quotaExhausted = true;
      updated.exhaustedReason =
        updated.exhaustedReason ||
        'Daily free Gemini API limit reached. Recharge or wait for UTC daily reset.';
    } else if (updated.cycleTokensUsed >= updated.overallTokensLimit) {
      updated.quotaExhausted = true;
      updated.exhaustedReason =
        updated.exhaustedReason ||
        'Configured Gemini API key quota pool reached 0. Upgrade/recharge key and reset pool.';
    }

    await persistStateToCloud(updated);
    return updated;
  });

  return buildUsageSnapshot(state);
}

export function isGeminiQuotaOrKeyError(error: unknown): boolean {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error || '');
  return /429|resource_exhausted|quota|rate[-_ ]?limit|exceeded.*quota|billing|payment required|insufficient|api_key_invalid|key expired|leaked|403/i.test(
    raw
  );
}

export async function recordGeminiApiError(params: {
  modelId: string;
  error: unknown;
  source?: string;
}): Promise<GeminiApiUsageSnapshot | null> {
  if (!isGeminiQuotaOrKeyError(params.error)) return null;
  const rawMessage =
    params.error instanceof Error
      ? params.error.message
      : typeof params.error === 'string'
        ? params.error
        : 'Gemini API quota exhausted.';

  const state = await enqueueLocked(async () => {
    const current = await loadStateFromSources();
    const now = new Date().toISOString();
    const updated: PersistedGeminiUsage = {
      ...current,
      quotaExhausted: true,
      exhaustedReason: rawMessage.slice(0, 220),
      lastErrorAt: now,
      lastModelId: params.modelId,
      lastSource: params.source,
      updatedAt: now,
    };
    await persistStateToCloud(updated);
    return updated;
  });

  return buildUsageSnapshot(state);
}

export async function updateOrResetGeminiQuota(params: {
  resetUsagePool?: boolean;
  dailyRequestsLimit?: number;
  dailyTokensLimit?: number;
  overallTokensLimit?: number;
}): Promise<GeminiApiUsageSnapshot> {
  const state = await enqueueLocked(async () => {
    const current = await loadStateFromSources();
    const now = new Date().toISOString();
    const nextDailyReqLimit =
      params.dailyRequestsLimit !== undefined
        ? sanitizePositiveInt(
            params.dailyRequestsLimit,
            current.dailyRequestsLimit,
            10,
            10_000_000
          )
        : current.dailyRequestsLimit;
    const nextDailyTokLimit =
      params.dailyTokensLimit !== undefined
        ? sanitizePositiveInt(
            params.dailyTokensLimit,
            current.dailyTokensLimit,
            1000,
            1_000_000_000
          )
        : current.dailyTokensLimit;
    const nextOverallLimit =
      params.overallTokensLimit !== undefined
        ? sanitizePositiveInt(
            params.overallTokensLimit,
            current.overallTokensLimit,
            1000,
            1_000_000_000
          )
        : current.overallTokensLimit;

    const updated: PersistedGeminiUsage = {
      ...current,
      dailyRequestsLimit: nextDailyReqLimit,
      dailyTokensLimit: nextDailyTokLimit,
      overallTokensLimit: nextOverallLimit,
      dailyRequestsUsed: params.resetUsagePool ? 0 : current.dailyRequestsUsed,
      dailyTokensUsed: params.resetUsagePool ? 0 : current.dailyTokensUsed,
      cycleRequestsUsed: params.resetUsagePool ? 0 : current.cycleRequestsUsed,
      cycleTokensUsed: params.resetUsagePool ? 0 : current.cycleTokensUsed,
      quotaExhausted: params.resetUsagePool
        ? false
        : current.dailyRequestsUsed >= nextDailyReqLimit ||
          current.dailyTokensUsed >= nextDailyTokLimit ||
          current.cycleTokensUsed >= nextOverallLimit,
      exhaustedReason: params.resetUsagePool ? undefined : current.exhaustedReason,
      lastErrorAt: params.resetUsagePool ? undefined : current.lastErrorAt,
      updatedAt: now,
    };

    await persistStateToCloud(updated);
    return updated;
  });

  return buildUsageSnapshot(state);
}
