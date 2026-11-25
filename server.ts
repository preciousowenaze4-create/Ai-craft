import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createClient, type User as SupabaseUser } from '@supabase/supabase-js';
import {
  BILLING_PLANS,
  buildPaymentCallbackHtml,
  convertUsdToNgn,
  getPaymentSecretKey,
  getPlanConfig,
  getUsdToNgnRate,
  initializeCheckoutSession,
  isPaidAmountValidForPlan,
  listCustomerTransactions,
  resolvePlanFromMetadataOrAmount,
  verifyCheckoutTransaction,
  verifyWebhookSignature,
} from './api/_paystack.js';
import {
  MIN_CHAT_CREDITS_THRESHOLD,
  VerifiedGenerationContext,
  calculateBuildCreditsForBytes,
  commitGenerationCredits,
  consumeBillingCredit,
  getAuthenticatedSupabaseUser,
  getAvailableCreditsBudget,
  getCreditExhaustionInfo,
  loadCloudWorkspace,
  reconcileAndLoadBillingState,
  saveCloudWorkspace,
  saveUserBillingState,
  serializeBillingSummary,
  upgradeUserAccountFromTransaction,
} from './api/_billing.js';
import {
  buildAppManifestJson,
  buildAppServiceWorkerJs,
  buildNotFoundAppHtml,
  buildStandaloneAppHtml,
  deriveServerSessionTitle,
  extractLogoDirectiveFromRaw,
  filterPublicSafeEnv,
  getAppLogoConfig,
  isAppLogoOrPwaEnabled,
  listPublishedApps,
  loadPublishedApp,
  renderAppIconPng,
  renderAppIconSvg,
  sanitizeAppId,
  sanitizeSessionTitle,
  savePublishedApp,
  type AppLogoConfig,
} from './api/_appsStore.js';
import {
  clearAppTableRows,
  insertAppTableRow,
  listAppTableRows,
  removeAppTableRow,
  updateAppTableRow,
} from './api/_appDataStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

import {
  getServerGeminiApiKey,
  hasServerFreeAiKey,
  resolveDynamicGeminiExecutionMatrix,
} from './api/_aiGateways.js';
import {
  generateMediaAsset,
  type GeneratedMediaResult,
} from './api/_mediaService.js';
import { getFreeAiMeshStatus, getFreeMeshModelOptions } from './api/_freeAiMesh.js';
import { cleanEnvKey } from './api/_openrouterModels.js';
import {
  ModerationActionType,
  applyOwnerModerationAction,
  checkExpressUserModeration,
  isOwnerEmail,
  listAllRealSignedInUsers,
  recordSignedInUser,
  resolveUserWithModeration,
} from './api/_moderation.js';
import {
  type ParsedDbTable,
  extractDbSchemaFromRaw,
  extractLiveBuildArtifacts,
  extractPlanStepsFromRaw,
  extractSessionTitleFromRaw,
  finalizePartialPreviewHtml,
  findCodeStart,
  runLiveBrowserSearch,
  sanitizeBuildProse,
  stripReasoningTags,
} from './api/_builderCore.js';
import {
  createGeminiClient,
  finalizeRealtimeOutput,
  prepareRealtimePrompt,
  repairIncompleteBuildHtml,
  streamServerFreeAiRealTime,
  type VisualHintsSpec,
} from './api/_realtimeEngine.js';
import {
  getGeminiApiUsageSnapshot,
  recordGeminiApiError,
  recordGeminiApiUsage,
  updateOrResetGeminiQuota,
} from './api/_geminiUsage.js';
import { handleMemoryRequest } from './api/_memoryHandler.js';
import {
  getProjectMemory,
  recordBuildCheckpoint,
  saveProjectMemorySnapshot,
} from './api/_projectMemory.js';



function getSupabaseConfig(): { url: string; anonKey: string; serviceRoleKey: string } {
  const urlCandidates = [
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PROJECT_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.VITE_SUPABASE_URL,
  ];
  const anonCandidates = [
    process.env.SUPABASE_ANON_KEY,
    process.env.SUPABASE_PUBLISHABLE_KEY,
    process.env.SUPABASE_PUBLISHABLE_DEFAULT_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
    process.env.VITE_SUPABASE_ANON_KEY,
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    process.env.SUPABASE_PUBLIC_KEY,
    process.env.SUPABASE_KEY,
  ];
  const serviceCandidates = [
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_KEY,
    process.env.SUPABASE_SECRET_KEY,
  ];

  let url = '';
  for (const raw of urlCandidates) {
    const cleaned = cleanEnvKey(raw, ['MY_SUPABASE_URL']);
    if (cleaned && /^https?:\/\//i.test(cleaned)) {
      try {
        url = new URL(cleaned).origin;
      } catch {
        url = cleaned.replace(/\/+(rest|auth|storage|realtime)\/v\d+.*$/i, '').replace(/\/+$/, '');
      }
      break;
    }
  }

  let anonKey = '';
  for (const raw of anonCandidates) {
    const cleaned = cleanEnvKey(raw, ['MY_SUPABASE_ANON_KEY']);
    if (cleaned) {
      anonKey = cleaned;
      break;
    }
  }

  let serviceRoleKey = '';
  for (const raw of serviceCandidates) {
    const cleaned = cleanEnvKey(raw, ['MY_SUPABASE_SERVICE_ROLE_KEY']);
    if (cleaned) {
      serviceRoleKey = cleaned;
      break;
    }
  }

  return {
    url,
    anonKey: anonKey || serviceRoleKey,
    serviceRoleKey,
  };
}

function createBackendSupabaseClient(useImplicitFlow = false) {
  const { url, anonKey } = getSupabaseConfig();
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
      ...(useImplicitFlow ? { flowType: 'implicit' as const } : {}),
    },
  });
}

function getAppBaseUrl(req?: express.Request): string {
  const envUrl = cleanEnvKey(process.env.APP_URL, ['MY_APP_URL']);
  if (envUrl) return envUrl.replace(/\/+$/, '');
  if (req) {
    const proto =
      String(req.headers['x-forwarded-proto'] || '')
        .split(',')[0]
        ?.trim() ||
      req.protocol ||
      'http';
    const host =
      String(req.headers['x-forwarded-host'] || '')
        .split(',')[0]
        ?.trim() || req.get('host');
    if (host) return `${proto}://${host}`.replace(/\/+$/, '');
  }
  return `http://localhost:${PORT}`;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

const SB_ACCESS_COOKIE = 'aicraft_sb_access';
const SB_REFRESH_COOKIE = 'aicraft_sb_refresh';

function setAuthCookies(
  res: express.Response,
  accessToken: string,
  refreshToken?: string | null
) {
  const baseOpts: express.CookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: 60 * 60 * 24 * 7 * 1000,
  };
  res.cookie(SB_ACCESS_COOKIE, accessToken, baseOpts);
  if (refreshToken) {
    res.cookie(SB_REFRESH_COOKIE, refreshToken, {
      ...baseOpts,
      maxAge: 60 * 60 * 24 * 30 * 1000,
    });
  }
}

function clearAuthCookies(res: express.Response) {
  const clearOpts: express.CookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
  };
  res.clearCookie(SB_ACCESS_COOKIE, clearOpts);
  res.clearCookie(SB_REFRESH_COOKIE, clearOpts);
}

function serializeSupabaseUser(user: SupabaseUser | null | undefined) {
  if (!user) return null;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const appMeta = (user.app_metadata ?? {}) as Record<string, unknown>;
  const rawName =
    (typeof meta.full_name === 'string' && meta.full_name.trim()) ||
    (typeof meta.name === 'string' && meta.name.trim()) ||
    (typeof meta.user_name === 'string' && meta.user_name.trim()) ||
    (user.email ? user.email.split('@')[0] : 'AI Craft User');
  const avatarUrl =
    (typeof meta.avatar_url === 'string' && meta.avatar_url.trim()) ||
    (typeof meta.picture === 'string' && meta.picture.trim()) ||
    null;

  return {
    id: user.id,
    email: user.email || '',
    name: rawName,
    avatarUrl,
    provider:
      typeof appMeta.provider === 'string' ? appMeta.provider : 'email',
  };
}

interface CraftJob {
  id: string;
  status: 'running' | 'paused' | 'complete' | 'error';
  startedAt: number;
  updatedAt: number;
  kind: 'chat' | 'build' | 'media';
  title?: string;
  phase: 'understanding' | 'building' | 'paused' | 'complete' | 'error';
  phaseLabel: string;
  modelId?: string;
  modelName?: string;
  provider?: string;
  activeAction: string;
  activeFile: string;
  files: string[];
  planSteps: string[];
  suggestions: string[];
  dbTables: ParsedDbTable[];
  bytesBuilt: number;
  creditsUsed?: number;
  billing?: unknown;
  logo?: Record<string, string>;
  pausedReason?: string;
  pausedMessage?: string;
  aiText: string;
  previewHtml: string;
  media?: GeneratedMediaResult;
  errorMessage?: string;
  subscribers: Set<express.Response>;
}

const JOB_TTL_MS = 45 * 60 * 1000;

function serializeJobSnapshot(job: CraftJob) {
  return {
    type: 'snapshot',
    jobId: job.id,
    status: job.status,
    startedAt: job.startedAt,
    thoughtSeconds: Math.max(1, Math.round((job.updatedAt - job.startedAt) / 1000)),
    kind: job.kind,
    title: job.title,
    phase: job.phase,
    phaseLabel: job.phaseLabel,
    modelId: job.modelId,
    modelName: job.modelName,
    provider: job.provider,
    activeAction: job.activeAction,
    activeFile: job.activeFile,
    files: job.files,
    planSteps: job.planSteps,
    suggestions: job.suggestions,
    dbTables: job.dbTables,
    bytesBuilt: job.bytesBuilt,
    creditsUsed: job.creditsUsed,
    billing: job.billing,
    logo: job.logo,
    pausedReason: job.pausedReason,
    pausedMessage: job.pausedMessage,
    aiText: job.aiText,
    previewHtml: job.previewHtml,
    media: job.media,
    errorMessage: job.errorMessage,
  };
}

async function startServer() {
  const app = express();
  app.use(
    express.json({
      limit: '10mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody =
          buf.toString('utf8');
      },
    })
  );

  const craftJobs = new Map<string, CraftJob>();

  const pruneOldJobs = () => {
    const now = Date.now();
    for (const [id, job] of craftJobs.entries()) {
      if (job.status !== 'running' && now - job.updatedAt > JOB_TTL_MS) {
        craftJobs.delete(id);
      }
    }
  };

  const emitJobEvent = (job: CraftJob, payload: Record<string, unknown>) => {
    job.updatedAt = Date.now();
    const type = typeof payload.type === 'string' ? payload.type : '';

    if (type === 'title' && typeof payload.title === 'string' && payload.title.trim()) {
      job.title = payload.title.trim();
    } else if (type === 'meta') {
      if (payload.kind === 'chat' || payload.kind === 'build' || payload.kind === 'media') {
        job.kind = payload.kind;
      }
      if (typeof payload.modelId === 'string') job.modelId = payload.modelId;
      if (typeof payload.modelName === 'string') job.modelName = payload.modelName;
      if (typeof payload.provider === 'string') job.provider = payload.provider;
    } else if (type === 'phase') {
      if (payload.kind === 'chat' || payload.kind === 'build' || payload.kind === 'media') {
        job.kind = payload.kind;
      }
      if (payload.phase === 'understanding' || payload.phase === 'building') {
        job.phase = payload.phase;
      }
      if (typeof payload.label === 'string') job.phaseLabel = payload.label;
      if (typeof payload.action === 'string') job.activeAction = payload.action;
    } else if (type === 'plan') {
      if (Array.isArray(payload.allSteps)) {
        job.planSteps = payload.allSteps.filter((s): s is string => typeof s === 'string');
      }
    } else if (type === 'schema') {
      if (Array.isArray(payload.tables)) {
        job.dbTables = payload.tables as ParsedDbTable[];
      }
    } else if (type === 'media' && payload.media) {
      job.kind = 'media';
      job.media = payload.media as GeneratedMediaResult;
    } else if (type === 'file') {
      job.kind = 'build';
      if (job.phase === 'understanding') job.phase = 'building';
      if (typeof payload.action === 'string') job.activeAction = payload.action;
      if (typeof payload.path === 'string') job.activeFile = payload.path;
      if (Array.isArray(payload.allFiles)) {
        job.files = payload.allFiles.filter((f): f is string => typeof f === 'string');
      }
      if (typeof payload.bytesBuilt === 'number') job.bytesBuilt = payload.bytesBuilt;
    } else if (type === 'partialHtml') {
      if (typeof payload.previewHtml === 'string' && payload.previewHtml) {
        job.previewHtml = payload.previewHtml;
      }
      if (typeof payload.bytesBuilt === 'number') job.bytesBuilt = payload.bytesBuilt;
    } else if (type === 'progress') {
      if (typeof payload.bytesBuilt === 'number') job.bytesBuilt = payload.bytesBuilt;
    } else if (type === 'reset') {
      job.kind = 'chat';
      job.title = undefined;
      job.phase = 'understanding';
      job.phaseLabel = 'Thinking...';
      job.aiText = '';
      job.files = [];
      job.planSteps = [];
      job.suggestions = [];
      job.dbTables = [];
      job.activeFile = '';
      job.activeAction = 'Thinking';
      job.bytesBuilt = 0;
      job.media = undefined;
    } else if (type === 'delta' && typeof payload.text === 'string') {
      job.aiText += payload.text;
    } else if (type === 'paused') {
      job.status = 'paused';
      job.phase = 'paused';
      job.kind = payload.kind === 'chat' ? 'chat' : 'build';
      job.phaseLabel =
        typeof payload.phaseLabel === 'string' && payload.phaseLabel
          ? payload.phaseLabel
          : 'Paused · 0 tokens left';
      if (typeof payload.title === 'string' && payload.title.trim()) {
        job.title = payload.title.trim();
      }
      job.pausedReason =
        typeof payload.reason === 'string' ? payload.reason : 'MONTHLY_LIMIT_REACHED';
      job.pausedMessage =
        typeof payload.message === 'string'
          ? payload.message
          : 'Credits finished during build.';
      if (typeof payload.fullText === 'string') job.aiText = payload.fullText;
      if (typeof payload.previewHtml === 'string') job.previewHtml = payload.previewHtml;
      if (Array.isArray(payload.allFiles)) {
        job.files = payload.allFiles.filter((f): f is string => typeof f === 'string');
      }
      if (Array.isArray(payload.dbTables)) {
        job.dbTables = payload.dbTables as ParsedDbTable[];
      }
      if (typeof payload.bytesBuilt === 'number') job.bytesBuilt = payload.bytesBuilt;
      if (typeof payload.creditsUsed === 'number') job.creditsUsed = payload.creditsUsed;
      if (typeof payload.modelUsed === 'string') job.modelId = payload.modelUsed;
      if (typeof payload.modelName === 'string') job.modelName = payload.modelName;
      if (typeof payload.provider === 'string') job.provider = payload.provider;
    } else if (type === 'done') {
      job.status = 'complete';
      job.phase = 'complete';
      if (payload.kind === 'chat' || payload.kind === 'build' || payload.kind === 'media') {
        job.kind = payload.kind;
      }
      if (typeof payload.title === 'string' && payload.title.trim()) {
        job.title = payload.title.trim();
      }
      job.phaseLabel =
        job.kind === 'media'
          ? 'Media ready'
          : job.kind === 'chat'
            ? 'Answered'
            : 'Build complete';
      if (typeof payload.fullText === 'string') job.aiText = payload.fullText;
      if (typeof payload.previewHtml === 'string') job.previewHtml = payload.previewHtml;
      if (payload.media) job.media = payload.media as GeneratedMediaResult;
      if (Array.isArray(payload.allFiles)) {
        job.files = payload.allFiles.filter((f): f is string => typeof f === 'string');
      }
      if (Array.isArray(payload.suggestions)) {
        job.suggestions = payload.suggestions.filter((s): s is string => typeof s === 'string');
      }
      if (Array.isArray(payload.dbTables)) {
        job.dbTables = payload.dbTables as ParsedDbTable[];
      }
      if (typeof payload.bytesBuilt === 'number') job.bytesBuilt = payload.bytesBuilt;
      if (typeof payload.creditsUsed === 'number') job.creditsUsed = payload.creditsUsed;
      if (payload.billing !== undefined) job.billing = payload.billing;
      if (payload.logo && typeof payload.logo === 'object') {
        job.logo = payload.logo as Record<string, string>;
      }
      if (typeof payload.modelUsed === 'string') job.modelId = payload.modelUsed;
      if (typeof payload.modelName === 'string') job.modelName = payload.modelName;
      if (typeof payload.provider === 'string') job.provider = payload.provider;
    } else if (type === 'error') {
      job.status = 'error';
      job.phase = 'error';
      job.phaseLabel = 'Error';
      job.errorMessage =
        typeof payload.message === 'string'
          ? payload.message
          : 'AI Craft encountered an error.';
    }

    const encoded = `data: ${JSON.stringify(payload)}\n\n`;
    for (const subscriber of Array.from(job.subscribers)) {
      if (!subscriber.writableEnded) {
        subscriber.write(encoded);
        if (type === 'done' || type === 'paused' || type === 'error') {
          subscriber.end();
          job.subscribers.delete(subscriber);
        }
      } else {
        job.subscribers.delete(subscriber);
      }
    }
  };

  app.get('/api/health', (_req, res) => {
    const sbConfig = getSupabaseConfig();
    const mesh = getFreeAiMeshStatus();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      geminiConfigured: Boolean(getServerGeminiApiKey()),
      serverFreeAiReady: mesh.hasAny,
      freeAiMesh: {
        hasAny: mesh.hasAny,
        hasKeyless: mesh.hasKeyless,
        pollinationsEnabled: mesh.pollinationsEnabled,
        providers: mesh.providers.filter((p) => p.configured).map((p) => p.id),
        modelPool: mesh.modelPool,
      },
      supabaseConfigured: Boolean(sbConfig.url && sbConfig.anonKey),
      paymentsConfigured: Boolean(getPaymentSecretKey()),
    });
  });

  // ---------------------------------------------------------------------------
  // Supabase Backend Authentication Proxy Routes
  // ---------------------------------------------------------------------------
  app.get('/api/auth/config', (req, res) => {
    const sbConfig = getSupabaseConfig();
    const callbackUrl = `${getAppBaseUrl(req)}/api/auth/callback`;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      supabaseConfigured: Boolean(sbConfig.url && sbConfig.anonKey),
      callbackUrl,
    });
  });

  app.get('/api/auth/me', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const supabase = createBackendSupabaseClient();
    if (!supabase) {
      res.json({ configured: false, authenticated: false, user: null });
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const authHeader = String(req.headers.authorization || '');
    const bearerToken = /^bearer\s+/i.test(authHeader)
      ? authHeader.replace(/^bearer\s+/i, '').trim()
      : '';
    const accessToken = bearerToken || cookies[SB_ACCESS_COOKIE] || '';
    const refreshToken =
      (typeof req.headers['x-refresh-token'] === 'string'
        ? req.headers['x-refresh-token'].trim()
        : '') ||
      cookies[SB_REFRESH_COOKIE] ||
      '';

    if (!accessToken && !refreshToken) {
      res.json({ configured: true, authenticated: false, user: null });
      return;
    }

    try {
      if (accessToken) {
        const { data, error } = await supabase.auth.getUser(accessToken);
        if (!error && data.user) {
          await recordSignedInUser(data.user);
          const resolved = await resolveUserWithModeration(data.user);
          if (resolved?.flags.banned) {
            clearAuthCookies(res);
            res.status(403).json({
              configured: true,
              authenticated: false,
              banned: true,
              code: 'ACCOUNT_BANNED',
              user: null,
              error: 'This account has been suspended by the app owner.',
            });
            return;
          }
          res.json({
            configured: true,
            authenticated: true,
            user: resolved?.serialized ?? serializeSupabaseUser(data.user),
            accessToken,
            refreshToken: refreshToken || undefined,
          });
          return;
        }
      }

      if (refreshToken) {
        const { data, error } = await supabase.auth.refreshSession({
          refresh_token: refreshToken,
        });
        if (!error && data.session && data.user) {
          await recordSignedInUser(data.user);
          const resolved = await resolveUserWithModeration(data.user);
          if (resolved?.flags.banned) {
            clearAuthCookies(res);
            res.status(403).json({
              configured: true,
              authenticated: false,
              banned: true,
              code: 'ACCOUNT_BANNED',
              user: null,
              error: 'This account has been suspended by the app owner.',
            });
            return;
          }
          setAuthCookies(
            res,
            data.session.access_token,
            data.session.refresh_token
          );
          res.json({
            configured: true,
            authenticated: true,
            user: resolved?.serialized ?? serializeSupabaseUser(data.user),
            accessToken: data.session.access_token,
            refreshToken: data.session.refresh_token,
          });
          return;
        }
      }

      clearAuthCookies(res);
      res.json({ configured: true, authenticated: false, user: null });
    } catch {
      res.json({ configured: true, authenticated: false, user: null });
    }
  });

  app.post('/api/auth/signup', async (req, res) => {
    const supabase = createBackendSupabaseClient(true);
    if (!supabase) {
      res.status(503).json({
        error:
          'Supabase backend secrets (SUPABASE_URL and SUPABASE_ANON_KEY) are not configured yet.',
      });
      return;
    }

    const body = req.body as { email?: string; password?: string } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    if (password.length < 6) {
      res
        .status(400)
        .json({ error: 'Password must be at least 6 characters long.' });
      return;
    }

    try {
      const callbackUrl = `${getAppBaseUrl(req)}/api/auth/callback`;
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: callbackUrl,
        },
      });

      if (error) {
        if (/already registered|already exists|duplicate/i.test(error.message)) {
          res.status(409).json({
            error:
              'This email already has an account (from Google, GitHub, Apple, or Email). Please sign in instead.',
          });
          return;
        }
        res.status(error.status || 400).json({ error: error.message });
        return;
      }

      if (
        data.user &&
        Array.isArray(data.user.identities) &&
        data.user.identities.length === 0
      ) {
        res.status(409).json({
          error:
            'This email already has an account (from Google, GitHub, Apple, or Email). Please sign in instead.',
        });
        return;
      }

      if (data.session?.access_token) {
        await recordSignedInUser(data.user);
        const resolved = await resolveUserWithModeration(data.user);
        if (resolved?.flags.banned) {
          clearAuthCookies(res);
          res.status(403).json({
            authenticated: false,
            banned: true,
            code: 'ACCOUNT_BANNED',
            error: 'This account has been suspended by the app owner.',
          });
          return;
        }
        setAuthCookies(
          res,
          data.session.access_token,
          data.session.refresh_token
        );
        res.json({
          authenticated: true,
          needsEmailConfirmation: false,
          user: resolved?.serialized ?? serializeSupabaseUser(data.user),
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token,
        });
        return;
      }

      if (data.user) {
        await recordSignedInUser(data.user);
      }
      const resolvedPending = await resolveUserWithModeration(data.user);
      res.json({
        authenticated: false,
        needsEmailConfirmation: true,
        user: resolvedPending?.serialized ?? serializeSupabaseUser(data.user),
        message: 'Check your email to confirm your account, then sign in.',
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to create account with Supabase.',
      });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const supabase = createBackendSupabaseClient();
    if (!supabase) {
      res.status(503).json({
        error:
          'Supabase backend secrets (SUPABASE_URL and SUPABASE_ANON_KEY) are not configured yet.',
      });
      return;
    }

    const body = req.body as { email?: string; password?: string } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!email || !password) {
      res
        .status(400)
        .json({ error: 'Please enter both your email and password.' });
      return;
    }

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error || !data.session || !data.user) {
        res.status(error?.status || 401).json({
          error: error?.message || 'Invalid email or password.',
        });
        return;
      }

      await recordSignedInUser(data.user);
      const resolved = await resolveUserWithModeration(data.user);
      if (resolved?.flags.banned) {
        clearAuthCookies(res);
        res.status(403).json({
          authenticated: false,
          banned: true,
          code: 'ACCOUNT_BANNED',
          error: 'This account has been suspended by the app owner.',
        });
        return;
      }

      setAuthCookies(res, data.session.access_token, data.session.refresh_token);
      res.json({
        authenticated: true,
        user: resolved?.serialized ?? serializeSupabaseUser(data.user),
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Unable to sign in with Supabase right now.',
      });
    }
  });

  app.post('/api/auth/forgot-password', async (req, res) => {
    const supabase = createBackendSupabaseClient(true);
    if (!supabase) {
      res.status(503).json({
        error:
          'Supabase backend secrets (SUPABASE_URL and SUPABASE_ANON_KEY) are not configured yet.',
      });
      return;
    }

    const body = req.body as { email?: string } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }

    try {
      const callbackUrl = `${getAppBaseUrl(req)}/api/auth/callback`;
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: callbackUrl,
      });

      if (error) {
        res.status(error.status || 400).json({ error: error.message });
        return;
      }

      res.json({
        ok: true,
        message: 'Password reset email sent. Check your inbox for the reset link.',
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to send password reset email.',
      });
    }
  });

  app.post('/api/auth/update-password', async (req, res) => {
    const supabase = createBackendSupabaseClient();
    if (!supabase) {
      res.status(503).json({
        error:
          'Supabase backend secrets (SUPABASE_URL and SUPABASE_ANON_KEY) are not configured yet.',
      });
      return;
    }

    const body = req.body as
      | { access_token?: string; refresh_token?: string; password?: string }
      | undefined;
    const accessToken =
      typeof body?.access_token === 'string' ? body.access_token.trim() : '';
    const refreshToken =
      typeof body?.refresh_token === 'string' ? body.refresh_token.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!accessToken || !refreshToken) {
      res.status(400).json({ error: 'Invalid or expired reset session.' });
      return;
    }
    if (password.length < 6) {
      res
        .status(400)
        .json({ error: 'New password must be at least 6 characters long.' });
      return;
    }

    try {
      const { error: setErr } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (setErr) {
        res.status(401).json({ error: setErr.message });
        return;
      }

      const { data, error } = await supabase.auth.updateUser({ password });
      if (error || !data.user) {
        res.status(error?.status || 400).json({
          error: error?.message || 'Unable to update password.',
        });
        return;
      }

      await recordSignedInUser(data.user);
      const resolved = await resolveUserWithModeration(data.user);
      if (resolved?.flags.banned) {
        clearAuthCookies(res);
        res.status(403).json({
          authenticated: false,
          banned: true,
          code: 'ACCOUNT_BANNED',
          error: 'This account has been suspended by the app owner.',
        });
        return;
      }

      setAuthCookies(res, accessToken, refreshToken);
      res.json({
        ok: true,
        user: resolved?.serialized ?? serializeSupabaseUser(data.user),
        accessToken,
        refreshToken,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Unable to update password.',
      });
    }
  });

  app.get('/api/auth/oauth/url', async (req, res) => {
    const supabase = createBackendSupabaseClient(true);
    if (!supabase) {
      res.status(503).json({
        error:
          'Supabase backend secrets (SUPABASE_URL and SUPABASE_ANON_KEY) are not configured yet.',
      });
      return;
    }

    const providerParam = String(req.query.provider || '').toLowerCase();
    if (
      providerParam !== 'google' &&
      providerParam !== 'apple' &&
      providerParam !== 'github'
    ) {
      res.status(400).json({ error: 'Unsupported OAuth provider.' });
      return;
    }

    try {
      const callbackUrl = `${getAppBaseUrl(req)}/api/auth/callback`;
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: providerParam,
        options: {
          redirectTo: callbackUrl,
          skipBrowserRedirect: true,
          ...(providerParam === 'google'
            ? {
                queryParams: {
                  access_type: 'offline',
                  prompt: 'select_account',
                },
              }
            : {}),
        },
      });

      if (error || !data?.url) {
        res.status(400).json({
          error: error?.message || `Failed to create ${providerParam} login URL.`,
        });
        return;
      }

      res.json({ url: data.url });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Unable to initialize OAuth sign in.',
      });
    }
  });

  app.post('/api/auth/session', async (req, res) => {
    const supabase = createBackendSupabaseClient();
    if (!supabase) {
      res.status(503).json({
        error: 'Supabase backend secrets are not configured yet.',
      });
      return;
    }

    const body = req.body as
      | { access_token?: string; refresh_token?: string }
      | undefined;
    const accessToken =
      typeof body?.access_token === 'string' ? body.access_token.trim() : '';
    const refreshToken =
      typeof body?.refresh_token === 'string' ? body.refresh_token.trim() : '';

    if (!accessToken) {
      res.status(400).json({ error: 'Missing Supabase access token.' });
      return;
    }

    try {
      const { data, error } = await supabase.auth.getUser(accessToken);
      if (error || !data.user) {
        res.status(401).json({
          error: error?.message || 'Invalid Supabase session token.',
        });
        return;
      }

      await recordSignedInUser(data.user);
      const resolved = await resolveUserWithModeration(data.user);
      if (resolved?.flags.banned) {
        clearAuthCookies(res);
        res.status(403).json({
          authenticated: false,
          banned: true,
          code: 'ACCOUNT_BANNED',
          error: 'This account has been suspended by the app owner.',
        });
        return;
      }

      setAuthCookies(res, accessToken, refreshToken || null);
      res.json({
        authenticated: true,
        user: resolved?.serialized ?? serializeSupabaseUser(data.user),
        accessToken,
        refreshToken: refreshToken || undefined,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Failed to verify session.',
      });
    }
  });

  app.get('/api/admin', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const auth = await checkExpressUserModeration({
      cookieHeader: req.headers.cookie,
      authorizationHeader: req.headers.authorization,
      refreshTokenHeader:
        typeof req.headers['x-refresh-token'] === 'string'
          ? req.headers['x-refresh-token']
          : undefined,
    });
    if (!auth.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!auth.isOwner) {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }
    const [users, geminiUsage] = await Promise.all([
      listAllRealSignedInUsers(),
      getGeminiApiUsageSnapshot(),
    ]);
    res.json({ ok: true, users, geminiUsage });
  });

  app.post('/api/admin', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const auth = await checkExpressUserModeration({
      cookieHeader: req.headers.cookie,
      authorizationHeader: req.headers.authorization,
      refreshTokenHeader:
        typeof req.headers['x-refresh-token'] === 'string'
          ? req.headers['x-refresh-token']
          : undefined,
    });
    if (!auth.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!auth.isOwner) {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }

    const body = (req.body || {}) as {
      userId?: string;
      email?: string;
      action?: string;
      reason?: string;
      dailyRequestsLimit?: number;
      dailyTokensLimit?: number;
      overallTokensLimit?: number;
    };
    const rawAction =
      typeof body.action === 'string' ? body.action.trim().toLowerCase() : '';

    if (rawAction === 'reset_quota' || rawAction === 'set_quota_limit') {
      const geminiUsage = await updateOrResetGeminiQuota({
        resetUsagePool: rawAction === 'reset_quota',
        dailyRequestsLimit: body.dailyRequestsLimit,
        dailyTokensLimit: body.dailyTokensLimit,
        overallTokensLimit: body.overallTokensLimit,
      });
      res.json({ ok: true, geminiUsage });
      return;
    }

    const validActions: ModerationActionType[] = [
      'ban',
      'unban',
      'verify',
      'unverify',
      'restrict',
      'unrestrict',
    ];
    const action = rawAction as ModerationActionType;

    if (!validActions.includes(action)) {
      res.status(400).json({ error: 'Invalid admin action.' });
      return;
    }

    const result = await applyOwnerModerationAction({
      actorEmail: auth.user.email || '',
      targetUserId: body.userId,
      targetEmail: body.email,
      action,
      reason: body.reason,
    });

    if (result.ok === false) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ ok: true, user: result.user });
  });

  app.post('/api/auth/logout', async (req, res) => {
    clearAuthCookies(res);
    const supabase = createBackendSupabaseClient();
    const authHeader = String(req.headers.authorization || '');
    const token = /^bearer\s+/i.test(authHeader)
      ? authHeader.replace(/^bearer\s+/i, '').trim()
      : '';
    if (supabase && token) {
      try {
        await supabase.auth.getUser(token);
      } catch {
        // ignore cleanup failure
      }
    }
    res.json({ ok: true });
  });

  app.get(['/api/auth/callback', '/api/auth/callback/'], (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Craft — Signing In</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #ffffff;
        color: #0b0b0f;
        padding: 24px;
        text-align: center;
      }
      .card { max-width: 340px; }
      h1 { font-size: 18px; margin: 0 0 8px; font-weight: 700; }
      p { font-size: 14px; color: #52525b; margin: 0; line-height: 1.45; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1 id="title">Completing sign-in…</h1>
      <p id="status">Returning you to AI Craft.</p>
    </div>
    <script>
      (async function () {
        var titleEl = document.getElementById('title');
        var statusEl = document.getElementById('status');
        try {
          var hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
          var queryParams = new URLSearchParams(window.location.search || '');
          var errMsg =
            hashParams.get('error_description') ||
            hashParams.get('error') ||
            queryParams.get('error_description') ||
            queryParams.get('error');

          if (errMsg) {
            titleEl.textContent = 'Sign-in could not complete';
            statusEl.textContent = errMsg;
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', message: errMsg }, '*');
              setTimeout(function () { window.close(); }, 1600);
            } else {
              setTimeout(function () {
                window.location.replace('/?auth_error=' + encodeURIComponent(errMsg));
              }, 700);
            }
            return;
          }

          var accessToken = hashParams.get('access_token') || '';
          var refreshToken = hashParams.get('refresh_token') || '';
          var flowType = hashParams.get('type') || queryParams.get('type') || '';

          if (flowType === 'recovery' && accessToken) {
            try {
              localStorage.setItem(
                'aicraft_sb_recovery_v1',
                JSON.stringify({ accessToken: accessToken, refreshToken: refreshToken })
              );
            } catch (e) {}
            if (window.opener) {
              window.opener.postMessage(
                { type: 'SUPABASE_AUTH_RECOVERY', accessToken: accessToken, refreshToken: refreshToken },
                '*'
              );
              window.close();
            } else {
              window.location.replace('/?auth_recovery=1');
            }
            return;
          }

          if (accessToken) {
            var res = await fetch('/api/auth/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                access_token: accessToken,
                refresh_token: refreshToken
              })
            });
            var rawPayload = await res.text();
            var payload = {};
            try { payload = rawPayload ? JSON.parse(rawPayload) : {}; } catch (e) {}
            if (!res.ok || !payload.authenticated) {
              throw new Error(payload.error || 'Could not validate sign-in session.');
            }
            try {
              localStorage.setItem(
                'aicraft_sb_session_v1',
                JSON.stringify({
                  accessToken: payload.accessToken || accessToken,
                  refreshToken: payload.refreshToken || refreshToken
                })
              );
            } catch (e) {}

            if (window.opener) {
              window.opener.postMessage(
                {
                  type: 'OAUTH_AUTH_SUCCESS',
                  user: payload.user,
                  accessToken: payload.accessToken || accessToken,
                  refreshToken: payload.refreshToken || refreshToken
                },
                '*'
              );
              window.close();
            } else {
              window.location.replace('/');
            }
            return;
          }

          var noTokenMsg = 'Authorization code received. Please enable Implicit OAuth flow in Supabase or use Email sign-in.';
          titleEl.textContent = 'Authorization code received';
          statusEl.textContent = noTokenMsg;
          if (!window.opener) {
            setTimeout(function () {
              window.location.replace('/?auth_error=' + encodeURIComponent(noTokenMsg));
            }, 900);
          }
        } catch (err) {
          var msg = err && err.message ? err.message : 'Authentication failed.';
          titleEl.textContent = 'Sign-in error';
          statusEl.textContent = msg;
          if (window.opener) {
            window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', message: msg }, '*');
          } else {
            setTimeout(function () {
              window.location.replace('/?auth_error=' + encodeURIComponent(msg));
            }, 900);
          }
        }
      })();
    </script>
  </body>
</html>`);
  });

  app.get('/api/payments/config', async (_req, res) => {
    const usdToNgnRate = await getUsdToNgnRate();
    const plans = Object.values(BILLING_PLANS).map((plan) => {
      const conv = convertUsdToNgn(plan.amountUsd, usdToNgnRate);
      return {
        id: plan.id,
        name: plan.name,
        amountUsd: plan.amountUsd,
        amountNgn: conv.amountNgn,
        amountKobo: conv.amountKobo,
        monthlyCredits: plan.monthlyCredits,
        annualCycles: plan.annualCycles,
        dailyLimit: plan.dailyLimit,
        cadenceText: plan.cadenceText,
      };
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      configured: Boolean(getPaymentSecretKey()),
      usdToNgnRate: Number(usdToNgnRate.toFixed(2)),
      plans,
    });
  });

  app.get(['/api/payments/callback', '/api/payments/callback/'], (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buildPaymentCallbackHtml());
  });

  app.get('/api/payments/transactions', async (req, res) => {
    const email = typeof req.query.email === 'string' ? req.query.email : '';
    const data = await listCustomerTransactions(email);
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  });

  app.post('/api/payments/initialize', async (req, res) => {
    const body = (req.body ?? {}) as {
      planId?: string;
      email?: string;
      userId?: string;
    };
    const callbackUrl = `${getAppBaseUrl(req)}/api/payments/callback`;
    const result = await initializeCheckoutSession({
      planId: typeof body.planId === 'string' ? body.planId : '',
      email: typeof body.email === 'string' ? body.email : '',
      userId: typeof body.userId === 'string' ? body.userId : undefined,
      callbackUrl,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      authorizationUrl: result.authorizationUrl,
      reference: result.reference,
      amountUsd: result.amountUsd,
      amountNgn: result.amountNgn,
      usdToNgnRate: result.usdToNgnRate,
    });
  });

  app.post('/api/payments/verify', async (req, res) => {
    const body = (req.body ?? {}) as { reference?: string };
    const reference =
      typeof body.reference === 'string' ? body.reference.trim() : '';
    const result = await verifyCheckoutTransaction(reference);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    let billingSummary = null;
    if (result.verified) {
      const cookies = parseCookies(req.headers.cookie);
      const authHeader = req.headers.authorization || '';
      const bearerToken = /^bearer\s+/i.test(authHeader)
        ? authHeader.replace(/^bearer\s+/i, '').trim()
        : '';
      const accessToken = bearerToken || cookies[SB_ACCESS_COOKIE] || '';
      const refreshToken =
        (typeof req.headers['x-refresh-token'] === 'string'
          ? req.headers['x-refresh-token'].trim()
          : '') ||
        cookies[SB_REFRESH_COOKIE] ||
        '';

      const auth =
        accessToken || refreshToken
          ? await getAuthenticatedSupabaseUser(accessToken, refreshToken)
          : { user: null, accessToken: '', refreshToken: '' };

      const upgraded = await upgradeUserAccountFromTransaction({
        tx: result.transaction,
        authenticatedUser: auth.user,
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
      });

      if (upgraded) {
        billingSummary = serializeBillingSummary(
          upgraded,
          auth.user ? isOwnerEmail(auth.user.email) : false
        );
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      verified: result.verified,
      transaction: result.transaction,
      billing: billingSummary,
    });
  });

  app.get('/api/payments/billing', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const authHeader = req.headers.authorization || '';
    const bearerToken = /^bearer\s+/i.test(authHeader)
      ? authHeader.replace(/^bearer\s+/i, '').trim()
      : '';
    const accessToken = bearerToken || cookies[SB_ACCESS_COOKIE] || '';
    const refreshToken =
      (typeof req.headers['x-refresh-token'] === 'string'
        ? req.headers['x-refresh-token'].trim()
        : '') ||
      cookies[SB_REFRESH_COOKIE] ||
      '';

    const auth = await getAuthenticatedSupabaseUser(accessToken, refreshToken);
    if (!auth.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    const state = await reconcileAndLoadBillingState({
      user: auth.user,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      checkPaystack: true,
    });

    res.setHeader('Cache-Control', 'no-store');
    res.json({ billing: serializeBillingSummary(state, isOwnerEmail(auth.user.email)) });
  });

  app.post('/api/payments/webhook', async (req, res) => {
    const rawBody =
      (req as express.Request & { rawBody?: string }).rawBody ??
      JSON.stringify(req.body ?? {});
    const signatureHeader = req.headers['x-paystack-signature'];
    const signature = Array.isArray(signatureHeader)
      ? signatureHeader[0]
      : signatureHeader;

    if (!verifyWebhookSignature(rawBody, signature)) {
      res.status(401).json({ error: 'Invalid webhook signature.' });
      return;
    }

    const eventPayload = (req.body ?? {}) as {
      event?: string;
      data?: {
        id?: number | string;
        reference?: string;
        amount?: number;
        status?: string;
        paid_at?: string;
        created_at?: string;
        channel?: string;
        customer?: { email?: string };
        metadata?: { userId?: string; [key: string]: unknown };
      };
    };

    if (eventPayload.event === 'charge.success' && eventPayload.data?.reference) {
      const reference = eventPayload.data.reference.trim();
      const verified = await verifyCheckoutTransaction(reference);
      if (verified.ok && verified.verified) {
        await upgradeUserAccountFromTransaction({ tx: verified.transaction });
      } else if (eventPayload.data.status === 'success') {
        const amountKobo = Number(eventPayload.data.amount || 0);
        const liveRate = await getUsdToNgnRate();
        const plan = resolvePlanFromMetadataOrAmount(
          eventPayload.data.metadata,
          amountKobo,
          liveRate
        );
        const isValid = await isPaidAmountValidForPlan({
          plan,
          amountKobo,
          metadata: eventPayload.data.metadata,
        });
        if (isValid) {
          await upgradeUserAccountFromTransaction({
            tx: {
              id: String(eventPayload.data.id ?? reference),
              reference,
              planId: plan.id,
              planName: plan.name,
              amountUsd: plan.amountUsd,
              amountNgn: Math.round(amountKobo / 100),
              amountKobo,
              creditsToAdd: plan.monthlyCredits,
              status: 'paid',
              paidAt:
                eventPayload.data.paid_at ||
                eventPayload.data.created_at ||
                new Date().toISOString(),
              channel: eventPayload.data.channel || 'card',
              email: eventPayload.data.customer?.email || '',
              userId:
                typeof eventPayload.data.metadata?.userId === 'string'
                  ? eventPayload.data.metadata.userId
                  : undefined,
            },
          });
        }
      }
    }

    res.json({ received: true });
  });

  app.get('/api/payments/sync', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const authHeader = req.headers.authorization || '';
    const bearerToken = /^bearer\s+/i.test(authHeader)
      ? authHeader.replace(/^bearer\s+/i, '').trim()
      : '';
    const accessToken = bearerToken || cookies[SB_ACCESS_COOKIE] || '';
    const refreshToken =
      (typeof req.headers['x-refresh-token'] === 'string'
        ? req.headers['x-refresh-token'].trim()
        : '') ||
      cookies[SB_REFRESH_COOKIE] ||
      '';

    const auth = await getAuthenticatedSupabaseUser(accessToken, refreshToken);
    if (!auth.user) {
      res.status(401).json({ synced: false, workspace: null });
      return;
    }

    const workspace = await loadCloudWorkspace(auth.user.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ synced: Boolean(workspace), workspace });
  });

  app.post('/api/payments/sync', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const authHeader = req.headers.authorization || '';
    const bearerToken = /^bearer\s+/i.test(authHeader)
      ? authHeader.replace(/^bearer\s+/i, '').trim()
      : '';
    const accessToken = bearerToken || cookies[SB_ACCESS_COOKIE] || '';
    const refreshToken =
      (typeof req.headers['x-refresh-token'] === 'string'
        ? req.headers['x-refresh-token'].trim()
        : '') ||
      cookies[SB_REFRESH_COOKIE] ||
      '';

    const auth = await getAuthenticatedSupabaseUser(accessToken, refreshToken);
    if (!auth.user) {
      res.status(401).json({ synced: false });
      return;
    }

    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({ synced: false, error: 'Invalid payload.' });
      return;
    }

    const saved = await saveCloudWorkspace(auth.user.id, req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ synced: saved });
  });

  const normalizeAssetParam = (raw: string): string => {
    const s = raw.trim().toLowerCase();
    if (s === 'manifest.webmanifest' || s === 'manifest.json' || s === 'manifest') return 'manifest';
    if (s === 'sw.js' || s === 'sw') return 'sw';
    if (s === 'icon.svg' || s === 'icon-svg') return 'icon-svg';
    if (s === 'icon-180.png' || s === 'apple-touch-icon.png' || s === 'icon-180') return 'icon-180';
    if (s === 'icon-192.png' || s === 'icon-192') return 'icon-192';
    if (s === 'icon-512.png' || s === 'icon-512') return 'icon-512';
    if (s === 'icon-maskable.png' || s === 'icon-maskable') return 'icon-maskable';
    return '';
  };

  const servePublishedAsset = (
    res: express.Response,
    record: NonNullable<Awaited<ReturnType<typeof loadPublishedApp>>>,
    asset: string,
    routePrefix: '/p' | '/app' = '/p'
  ) => {
    if (asset === 'manifest') {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.send(JSON.stringify(buildAppManifestJson(record, routePrefix)));
      return true;
    }
    if (asset === 'sw') {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Service-Worker-Allowed', `${routePrefix}/${record.appId}`);
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.send(buildAppServiceWorkerJs(record, routePrefix));
      return true;
    }
    if (asset === 'icon-svg') {
      const logo = getAppLogoConfig(record);
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(renderAppIconSvg(logo));
      return true;
    }
    if (
      asset === 'icon-180' ||
      asset === 'icon-192' ||
      asset === 'icon-512' ||
      asset === 'icon-maskable'
    ) {
      const logo = getAppLogoConfig(record);
      const pngSize = asset === 'icon-180' ? 180 : asset === 'icon-192' ? 192 : 512;
      const pngBuf = renderAppIconPng(logo, pngSize, {
        maskable: asset === 'icon-maskable',
        opaqueFullBleed: asset === 'icon-180' || asset === 'icon-maskable',
      });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(pngBuf);
      return true;
    }
    return false;
  };

  app.get('/api/apps/gallery', async (_req, res) => {
    const records = await listPublishedApps({ remixOnly: true, limit: 24 });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      apps: records.map((r) => {
        const logo = getAppLogoConfig(r);
        return {
          appId: r.appId,
          title: r.title,
          slug: r.slug,
          mode: r.mode,
          seoTitle: r.seoTitle || r.title,
          seoDescription: r.seoDescription || `${r.title} — Built with AI Craft`,
          themeColor: logo.themeColor,
          logoUrl: `/p/${r.appId}/icon-180.png?v=${r.version}`,
          liveUrl: `/p/${r.appId}`,
          tables: r.tables || [],
          version: r.version,
          updatedAt: r.updatedAt,
        };
      }),
    });
  });

  app.get('/api/apps/:id/remix', async (req, res) => {
    const cleanId = sanitizeAppId(req.params.id || '');
    const record = await loadPublishedApp(cleanId);
    if (!record || !record.html) {
      res.status(404).json({ ok: false, error: 'Published app not found.' });
      return;
    }
    if (!record.allowRemix) {
      res.status(403).json({ ok: false, error: 'This app does not have community remixing enabled.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      app: {
        appId: record.appId,
        title: record.title,
        mode: record.mode,
        html: record.html,
        tables: record.tables || [],
        seoTitle: record.seoTitle,
        seoDescription: record.seoDescription,
      },
    });
  });

  app.get('/api/app-data/:appId/:table', async (req, res) => {
    const rows = await listAppTableRows(req.params.appId || '', req.params.table || 'items');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, rows });
  });

  app.post('/api/app-data/:appId/:table', async (req, res) => {
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const row = await insertAppTableRow(
      req.params.appId || '',
      req.params.table || 'items',
      payload
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, row });
  });

  app.patch('/api/app-data/:appId/:table/:rowId', async (req, res) => {
    const patch =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const row = await updateAppTableRow(
      req.params.appId || '',
      req.params.table || 'items',
      req.params.rowId || '',
      patch
    );
    if (!row) {
      res.status(404).json({ ok: false, error: 'Record not found.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, row });
  });

  app.delete('/api/app-data/:appId/:table/:rowId', async (req, res) => {
    await removeAppTableRow(
      req.params.appId || '',
      req.params.table || 'items',
      req.params.rowId || ''
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });

  app.delete('/api/app-data/:appId/:table', async (req, res) => {
    await clearAppTableRows(req.params.appId || '', req.params.table || 'items');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });

  app.post('/api/export/github', async (req, res) => {
    const body = (req.body || {}) as {
      token?: string;
      repoName?: string;
      description?: string;
      isPrivate?: boolean;
      branch?: string;
      files?: Array<{ path: string; content: string }>;
    };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const rawRepo = typeof body.repoName === 'string' ? body.repoName.trim() : '';
    const files = Array.isArray(body.files)
      ? body.files.filter(
          (f) =>
            f &&
            typeof f.path === 'string' &&
            f.path.trim() &&
            typeof f.content === 'string'
        )
      : [];

    if (!token) {
      res.status(400).json({ ok: false, error: 'GitHub Personal Access Token is required.' });
      return;
    }
    if (!rawRepo) {
      res.status(400).json({ ok: false, error: 'Repository name is required.' });
      return;
    }
    if (files.length === 0) {
      res.status(400).json({ ok: false, error: 'No project files to export.' });
      return;
    }

    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'AI-Craft-Exporter',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    try {
      const userResp = await fetch('https://api.github.com/user', { headers: ghHeaders });
      if (!userResp.ok) {
        const errBody = (await userResp.json().catch(() => ({}))) as { message?: string };
        res.status(401).json({
          ok: false,
          error: errBody.message || 'Invalid GitHub token or missing repo permissions.',
        });
        return;
      }
      const userData = (await userResp.json()) as { login?: string };
      const login = userData.login || '';
      if (!login) {
        res.status(401).json({ ok: false, error: 'Unable to resolve GitHub account.' });
        return;
      }

      const hasOwner = rawRepo.includes('/');
      const [repoOwner, repoSlugRaw] = hasOwner ? rawRepo.split('/', 2) : [login, rawRepo];
      const repoSlug = sanitizeAppId(repoSlugRaw || 'aicraft-app');
      const fullRepo = `${repoOwner}/${repoSlug}`;
      const branch =
        typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : 'main';

      // Check if repository exists; create it under user account if missing
      const checkResp = await fetch(`https://api.github.com/repos/${fullRepo}`, {
        headers: ghHeaders,
      });
      if (checkResp.status === 404) {
        const createResp = await fetch('https://api.github.com/user/repos', {
          method: 'POST',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: repoSlug,
            description:
              typeof body.description === 'string' && body.description.trim()
                ? body.description.trim()
                : 'Built with AI Craft',
            private: Boolean(body.isPrivate),
            auto_init: true,
          }),
        });
        if (!createResp.ok) {
          const createErr = (await createResp.json().catch(() => ({}))) as { message?: string };
          res.status(createResp.status).json({
            ok: false,
            error: createErr.message || `Could not create repository ${fullRepo}.`,
          });
          return;
        }
        // Wait briefly for GitHub's initial commit to propagate
        await new Promise((r) => setTimeout(r, 900));
      } else if (!checkResp.ok) {
        const repoErr = (await checkResp.json().catch(() => ({}))) as { message?: string };
        res.status(checkResp.status).json({
          ok: false,
          error: repoErr.message || `Cannot access repository ${fullRepo}.`,
        });
        return;
      }

      // Push files sequentially via Contents API (handles both new and existing files)
      for (const file of files.slice(0, 24)) {
        const cleanPath = file.path.replace(/^\/+/, '');
        const encodedPath = cleanPath.split('/').map(encodeURIComponent).join('/');
        const apiUrl = `https://api.github.com/repos/${fullRepo}/contents/${encodedPath}`;
        let existingSha: string | undefined;
        const getFileResp = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, {
          headers: ghHeaders,
        });
        if (getFileResp.ok) {
          const fileMeta = (await getFileResp.json().catch(() => ({}))) as { sha?: string };
          existingSha = fileMeta.sha;
        }
        const putResp = await fetch(apiUrl, {
          method: 'PUT',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `Export ${cleanPath} from AI Craft`,
            content: Buffer.from(file.content, 'utf8').toString('base64'),
            branch,
            ...(existingSha ? { sha: existingSha } : {}),
          }),
        });
        if (!putResp.ok) {
          const putErr = (await putResp.json().catch(() => ({}))) as { message?: string };
          res.status(putResp.status).json({
            ok: false,
            error: putErr.message || `Failed to push ${cleanPath} to ${fullRepo}.`,
          });
          return;
        }
      }

      res.json({
        ok: true,
        repoUrl: `https://github.com/${fullRepo}`,
        fullRepo,
        filesCount: files.length,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'GitHub export failed.',
      });
    }
  });

  app.get('/api/apps', async (req, res) => {
    const rawId = typeof req.query.id === 'string' ? req.query.id : '';
    const cleanId = sanitizeAppId(rawId);
    const asset = typeof req.query.asset === 'string' ? normalizeAssetParam(req.query.asset) : '';
    if (!rawId || !cleanId) {
      res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(buildNotFoundAppHtml(rawId || 'app'));
      return;
    }
    const record = await loadPublishedApp(cleanId);
    if (!record || !record.html) {
      if (req.query.format === 'json' || asset === 'manifest') {
        res.status(404).json({ exists: false, appId: cleanId });
        return;
      }
      res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(buildNotFoundAppHtml(cleanId));
      return;
    }
    const routePrefix: '/p' | '/app' =
      typeof req.query.prefix === 'string' && req.query.prefix.toLowerCase() === 'app'
        ? '/app'
        : '/p';
    if (asset && servePublishedAsset(res, record, asset, routePrefix)) {
      return;
    }
    if (req.query.format === 'json') {
      const hasLogoOrPwa = isAppLogoOrPwaEnabled(record);
      const logo = hasLogoOrPwa ? getAppLogoConfig(record) : null;
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        exists: true,
        appId: record.appId,
        projectId: record.projectId,
        title: record.title,
        slug: record.slug,
        mode: record.mode,
        version: record.version,
        seoTitle: record.seoTitle,
        seoDescription: record.seoDescription,
        allowRemix: Boolean(record.allowRemix),
        path: `${routePrefix}/${record.appId}`,
        ...(hasLogoOrPwa && logo
          ? {
              themeColor: logo.themeColor,
              logoUrl: `${routePrefix}/${record.appId}/icon-180.png?v=${record.version}`,
              manifestUrl: `${routePrefix}/${record.appId}/manifest.webmanifest?v=${record.version}`,
            }
          : {}),
        updatedAt: record.updatedAt,
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.send(buildStandaloneAppHtml(record, routePrefix));
  });

  app.get('/app/:id/:asset', async (req, res) => {
    const cleanId = sanitizeAppId(req.params.id || '');
    const asset = normalizeAssetParam(req.params.asset || '');
    if (!asset) {
      res.status(404).send('Asset not found');
      return;
    }
    const record = await loadPublishedApp(cleanId);
    if (!record || !record.html) {
      res.status(404).json({ exists: false, appId: cleanId });
      return;
    }
    if (!servePublishedAsset(res, record, asset, '/app')) {
      res.status(404).send('Asset not found');
    }
  });

  app.get('/app/:id', async (req, res) => {
    const cleanId = sanitizeAppId(req.params.id || '');
    const record = await loadPublishedApp(cleanId);
    if (!record || !record.html) {
      res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(buildNotFoundAppHtml(cleanId));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.send(buildStandaloneAppHtml(record, '/app'));
  });

  app.get('/p/:id/:asset', async (req, res) => {
    const cleanId = sanitizeAppId(req.params.id || '');
    const asset = normalizeAssetParam(req.params.asset || '');
    if (!asset) {
      res.status(404).send('Asset not found');
      return;
    }
    const record = await loadPublishedApp(cleanId);
    if (!record || !record.html) {
      res.status(404).json({ exists: false, appId: cleanId });
      return;
    }
    if (!servePublishedAsset(res, record, asset, '/p')) {
      res.status(404).send('Asset not found');
    }
  });

  app.get('/p/:id', async (req, res) => {
    const cleanId = sanitizeAppId(req.params.id || '');
    const record = await loadPublishedApp(cleanId);
    if (!record || !record.html) {
      res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(buildNotFoundAppHtml(cleanId));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.send(buildStandaloneAppHtml(record, '/p'));
  });

  app.post('/api/apps', async (req, res) => {
    const body = (req.body || {}) as {
      appId?: string;
      projectId?: string;
      title?: string;
      slug?: string;
      mode?: 'mobile' | 'web';
      html?: string;
      publicEnv?: Record<string, string>;
      tables?: string[];
      logo?: Partial<AppLogoConfig>;
      seoTitle?: string;
      seoDescription?: string;
      allowRemix?: boolean;
      version?: number;
    };
    const html = typeof body.html === 'string' ? body.html.trim() : '';
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    if (!html || !projectId) {
      res.status(400).json({ ok: false, error: 'Missing required html or projectId.' });
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const authHeader = req.headers.authorization || '';
    const bearerToken = /^bearer\s+/i.test(authHeader)
      ? authHeader.replace(/^bearer\s+/i, '').trim()
      : '';
    const accessToken = bearerToken || cookies[SB_ACCESS_COOKIE] || '';
    const refreshToken =
      (typeof req.headers['x-refresh-token'] === 'string'
        ? req.headers['x-refresh-token'].trim()
        : '') ||
      cookies[SB_REFRESH_COOKIE] ||
      '';
    const auth =
      accessToken || refreshToken
        ? await getAuthenticatedSupabaseUser(accessToken, refreshToken).catch(() => ({ user: null }))
        : { user: null };

    if (auth.user) {
      const resolved = await resolveUserWithModeration(auth.user);
      if (resolved?.flags.banned) {
        clearAuthCookies(res);
        res.status(403).json({
          ok: false,
          error: 'This account has been suspended by the app owner.',
          code: 'ACCOUNT_BANNED',
          banned: true,
        });
        return;
      }
      if (resolved?.flags.restricted) {
        res.status(403).json({
          ok: false,
          error: 'Your account is currently restricted from publishing apps.',
          code: 'ACCOUNT_RESTRICTED',
          restricted: true,
        });
        return;
      }
    }

    const slug = sanitizeAppId(body.slug || body.title || projectId);
    let targetAppId = sanitizeAppId(body.appId || slug);
    const existing = await loadPublishedApp(targetAppId);
    if (
      existing &&
      existing.projectId !== projectId &&
      (!auth.user || (existing.ownerId && existing.ownerId !== auth.user.id))
    ) {
      const suffix = projectId.replace(/[^a-z0-9]/gi, '').slice(-5).toLowerCase() || 'app';
      targetAppId = sanitizeAppId(`${slug}-${suffix}`);
    }

    const resolvedExisting =
      targetAppId === existing?.appId ? existing : await loadPublishedApp(targetAppId);

    const nextVersion =
      typeof body.version === 'number' && Number.isFinite(body.version) && body.version > 0
        ? Math.floor(body.version)
        : (resolvedExisting?.version ?? 0) + 1;

    const { record } = await savePublishedApp({
      appId: targetAppId,
      projectId,
      ownerId: auth.user?.id || resolvedExisting?.ownerId,
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'AI Craft App',
      slug,
      mode: body.mode === 'web' ? 'web' : 'mobile',
      html,
      publicEnv: filterPublicSafeEnv(body.publicEnv),
      tables: Array.isArray(body.tables) ? body.tables.filter((t) => typeof t === 'string') : [],
      logo: body.logo && typeof body.logo === 'object' ? body.logo : undefined,
      seoTitle:
        typeof body.seoTitle === 'string' && body.seoTitle.trim()
          ? body.seoTitle.trim().slice(0, 90)
          : resolvedExisting?.seoTitle,
      seoDescription:
        typeof body.seoDescription === 'string' && body.seoDescription.trim()
          ? body.seoDescription.trim().slice(0, 200)
          : resolvedExisting?.seoDescription,
      allowRemix:
        typeof body.allowRemix === 'boolean'
          ? body.allowRemix
          : Boolean(resolvedExisting?.allowRemix),
      version: nextVersion,
      updatedAt: new Date().toISOString(),
    });

    const hasLogoOrPwa = isAppLogoOrPwaEnabled(record);
    const logo = hasLogoOrPwa ? getAppLogoConfig(record) : null;

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      appId: record.appId,
      slug: record.slug,
      path: `/p/${record.appId}`,
      seoTitle: record.seoTitle,
      seoDescription: record.seoDescription,
      allowRemix: Boolean(record.allowRemix),
      ...(hasLogoOrPwa && logo
        ? {
            logoUrl: `/p/${record.appId}/icon-180.png?v=${record.version}`,
            manifestUrl: `/p/${record.appId}/manifest.webmanifest?v=${record.version}`,
            themeColor: logo.themeColor,
          }
        : {}),
      version: record.version,
      deployedAt: record.updatedAt,
    });
  });

  app.get('/api/craft/jobs/:jobId', (req, res) => {
    const job = craftJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Background job not found or expired.' });
      return;
    }

    if (req.query.stream !== '1') {
      res.json(serializeJobSnapshot(job));
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(': connected\n\n');
    res.write(`data: ${JSON.stringify(serializeJobSnapshot(job))}\n\n`);

    if (job.status === 'complete') {
      res.write(
        `data: ${JSON.stringify({
          type: 'done',
          kind: job.kind,
          title: job.title,
          logo: job.logo,
          fullText: job.aiText,
          previewHtml: job.previewHtml,
          allFiles: job.files,
          suggestions: job.suggestions,
          dbTables: job.dbTables,
          bytesBuilt: job.bytesBuilt,
          creditsUsed: job.creditsUsed,
          billing: job.billing,
          modelUsed: job.modelId,
          modelName: job.modelName,
          provider: job.provider,
          startedAt: job.startedAt,
        })}\n\n`
      );
      res.end();
      return;
    }

    if (job.status === 'paused') {
      res.write(
        `data: ${JSON.stringify({
          type: 'paused',
          reason: job.pausedReason || 'MONTHLY_LIMIT_REACHED',
          message: job.pausedMessage || 'Remaining credits finished during build.',
          kind: 'build',
          title: job.title,
          fullText: job.aiText,
          previewHtml: job.previewHtml,
          allFiles: job.files,
          dbTables: job.dbTables,
          bytesBuilt: job.bytesBuilt,
          creditsUsed: job.creditsUsed,
          modelUsed: job.modelId,
          modelName: job.modelName,
          provider: job.provider,
          startedAt: job.startedAt,
        })}\n\n`
      );
      res.end();
      return;
    }

    if (job.status === 'error') {
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          message: job.errorMessage || 'AI Craft encountered an error.',
        })}\n\n`
      );
      res.end();
      return;
    }

    job.subscribers.add(res);
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': ping\n\n');
      }
    }, 3000);

    res.on('close', () => {
      clearInterval(keepAlive);
      job.subscribers.delete(res);
    });
  });

  app.get('/api/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      res.json({ query: '', results: [], images: [] });
      return;
    }
    const data = await runLiveBrowserSearch(q);
    res.json(data);
  });

  app.post('/api/search', async (req, res) => {
    const body = req.body as { query?: string; q?: string } | undefined;
    const q = (body?.query || body?.q || '').trim();
    if (!q) {
      res.json({ query: '', results: [], images: [] });
      return;
    }
    const data = await runLiveBrowserSearch(q);
    res.json(data);
  });

  app.post('/api/transcribe', async (req, res) => {
    try {
      const body = req.body as {
        audioBase64?: string;
        mimeType?: string;
        language?: string;
      } | undefined;
      const audioBase64 =
        typeof body?.audioBase64 === 'string' ? body.audioBase64.trim() : '';
      const mimeType =
        typeof body?.mimeType === 'string' && body.mimeType.startsWith('audio/')
          ? body.mimeType.split(';')[0].trim()
          : 'audio/webm';

      if (!audioBase64) {
        res.status(400).json({ error: 'Audio data is required.' });
        return;
      }

      if (!hasServerFreeAiKey()) {
        res.status(422).json({
          error:
            'GEMINI_API_KEY is required for server-side voice transcription, or allow microphone permission in Chrome, Edge, or Safari.',
        });
        return;
      }

      const candidates = await resolveDynamicGeminiExecutionMatrix({ taskKind: 'transcribe' });
      let lastTranscribeErr: unknown = null;
      for (const candidate of candidates.slice(0, 6)) {
        try {
          const ai = createGeminiClient(candidate.apiKey);
          const response = await ai.models.generateContent({
            model: candidate.upstreamModelId,
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: audioBase64,
                  },
                },
                {
                  text: `Transcribe this audio cleanly into plain text${
                    body?.language ? ` (spoken language hint: ${body.language})` : ''
                  }. Return only the spoken words.`,
                },
              ],
            },
          });

          const text = (response.text || '').trim();
          const usage = response.usageMetadata;
          void recordGeminiApiUsage({
            modelId: candidate.upstreamModelId,
            promptTokens: usage?.promptTokenCount,
            candidatesTokens: usage?.candidatesTokenCount,
            totalTokens: usage?.totalTokenCount ?? Math.max(50, Math.ceil(text.length / 4)),
            source: 'transcribe',
          });
          if (!text) {
            res.status(422).json({ error: 'No speech detected in audio recording.' });
            return;
          }

          res.json({ text });
          return;
        } catch (err) {
          lastTranscribeErr = err;
        }
      }

      throw lastTranscribeErr instanceof Error
        ? lastTranscribeErr
        : new Error('Unable to process audio input.');
    } catch (err) {
      void recordGeminiApiError({
        modelId: 'gemini-3.8-flash',
        error: err,
        source: 'transcribe',
      });
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to process audio input.',
      });
    }
  });

  app.get('/api/models', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const mesh = getFreeAiMeshStatus();
    res.json({
      models: getFreeMeshModelOptions(),
      gateways: [
        {
          id: 'free-mesh',
          label: 'Free AI Mesh',
          baseUrl: 'keyless failover across free providers',
          configured: mesh.hasAny,
          keyCount: 0,
          modelCount: mesh.modelPool.activeModels,
          defaultModel: 'mesh::auto',
        },
      ],
      geminiConfigured: false,
      serverFreeAiReady: mesh.hasAny,
      pollinationsConfigured: mesh.pollinationsConfigured,
      puterConfigured: false,
      keyless: mesh.hasKeyless,
      freeAiMesh: {
        hasAny: mesh.hasAny,
        hasKeyless: mesh.hasKeyless,
        providers: mesh.providers.filter((p) => p.configured).map((p) => p.id),
        modelPool: mesh.modelPool,
      },
      modelPool: mesh.modelPool,
      freeOnly: true,
    });
  });

  app.post('/api/media', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const modCheck = await checkExpressUserModeration({
        cookieHeader: req.headers.cookie,
        authorizationHeader: req.headers.authorization,
        refreshTokenHeader:
          typeof req.headers['x-refresh-token'] === 'string'
            ? req.headers['x-refresh-token']
            : undefined,
      });
      if (modCheck.flags?.banned) {
        clearAuthCookies(res);
        res.status(403).json({
          error: 'This account has been suspended by the app owner.',
          code: 'ACCOUNT_BANNED',
          banned: true,
        });
        return;
      }
      if (modCheck.flags?.restricted) {
        res.status(403).json({
          error: 'Your account is currently restricted from generating media.',
          code: 'ACCOUNT_RESTRICTED',
          restricted: true,
        });
        return;
      }
      const body = req.body as {
        kind?: string;
        prompt?: string;
        model?: string;
      };
      const kind =
        body?.kind === 'video'
          ? 'video'
          : body?.kind === 'music'
            ? 'music'
            : 'image';
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      const requestedModel =
        typeof body?.model === 'string' ? body.model.trim() : undefined;
      if (!prompt) {
        res.status(400).json({ error: 'Prompt is required.' });
        return;
      }
      const result = await generateMediaAsset({
        kind,
        prompt,
        requestedModel,
      });
      res.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to generate media.';
      res.status(502).json({ error: message });
    }
  });

  app.all('/api/memory', async (req, res) => {
    try {
      const baseUrl = getAppBaseUrl(req);
      const fullUrl = `${baseUrl}${req.originalUrl || '/api/memory'}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(','));
      }
      const method = req.method.toUpperCase();
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const bodyStr = hasBody && req.body && Object.keys(req.body).length > 0
        ? JSON.stringify(req.body)
        : undefined;
      const webReq = new Request(fullUrl, {
        method,
        headers,
        body: bodyStr,
      });
      const webRes = await handleMemoryRequest(webReq);
      res.status(webRes.status);
      webRes.headers.forEach((val, key) => {
        res.setHeader(key, val);
      });
      const text = await webRes.text();
      res.send(text);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Memory endpoint error.',
      });
    }
  });

  app.post('/api/route', async (req, res) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const authHeader = req.headers.authorization || '';
      const bearerToken = /^bearer\s+/i.test(authHeader)
        ? authHeader.replace(/^bearer\s+/i, '').trim()
        : '';
      const accessToken = bearerToken || cookies[SB_ACCESS_COOKIE] || '';
      const refreshToken =
        (typeof req.headers['x-refresh-token'] === 'string'
          ? req.headers['x-refresh-token'].trim()
          : '') ||
        cookies[SB_REFRESH_COOKIE] ||
        '';

      let generationCreditContext: VerifiedGenerationContext | null = null;
      let initialBillingSummary = null;
      let serverCreditBudget: number | null = null;
      let isOwnerRequest = false;

      if (accessToken || refreshToken) {
        const auth = await getAuthenticatedSupabaseUser(accessToken, refreshToken);
        if (auth.user) {
          const resolvedMod = await resolveUserWithModeration(auth.user);
          if (resolvedMod?.flags.banned) {
            clearAuthCookies(res);
            res.status(403).json({
              error: 'This account has been suspended by the app owner.',
              code: 'ACCOUNT_BANNED',
              banned: true,
            });
            return;
          }
          if (resolvedMod?.flags.restricted) {
            res.status(403).json({
              error: 'Your account is currently restricted from sending messages.',
              code: 'ACCOUNT_RESTRICTED',
              restricted: true,
            });
            return;
          }
          isOwnerRequest = Boolean(
            resolvedMod?.serialized.isOwner || isOwnerEmail(auth.user.email)
          );
          const currentBilling = await reconcileAndLoadBillingState({
            user: auth.user,
            accessToken: auth.accessToken,
            refreshToken: auth.refreshToken,
            checkPaystack: false,
          });
          if (isOwnerRequest) {
            generationCreditContext = {
              user: auth.user,
              accessToken: auth.accessToken,
              refreshToken: auth.refreshToken,
              state: currentBilling,
              isOwner: true,
            };
            initialBillingSummary = serializeBillingSummary(currentBilling, true);
            serverCreditBudget = null;
          } else {
            generationCreditContext = {
              user: auth.user,
              accessToken: auth.accessToken,
              refreshToken: auth.refreshToken,
              state: currentBilling,
            };
            initialBillingSummary = serializeBillingSummary(currentBilling);
            serverCreditBudget = getAvailableCreditsBudget(currentBilling, Date.now());
          }
        }
      }

      const body = (req.body || {}) as {
        action?: 'prepare' | 'finalize';
        projectId?: string;
        turnId?: string;
        message?: string;
        mode?: string;
        model?: string;
        gateway?: string;
        previousHtml?: string;
        history?: Array<{ role: string; text: string }>;
        webSearchEnabled?: boolean;
        forceChat?: boolean;
        needsTitle?: boolean;
        reactEnabled?: boolean;
        backendEnabled?: boolean;
        attachmentName?: string | null;
        attachmentDataUrl?: string | null;
        attachmentMimeType?: string | null;
        attachmentText?: string | null;
        secretKeys?: string[];
        secretHints?: Array<{ key?: string; hint?: string }>;
        databaseTables?: string[];
        clientCreditsRemaining?: number;
        clientTime?: string;
        clientTimeZone?: string;
        visualHints?: VisualHintsSpec | null;
        rawOutput?: string;
        modelUsed?: string;
        modelName?: string;
        provider?: string;
        startedAt?: number;
        options?: Record<string, unknown>;
      };

      const opts = (body.options || {}) as Record<string, unknown>;
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const mode = body.mode === 'web' ? 'web' : 'mobile';
      const projectId =
        typeof body.projectId === 'string' && body.projectId.trim()
          ? body.projectId.trim()
          : '';
      const turnId =
        typeof body.turnId === 'string' && body.turnId.trim()
          ? body.turnId.trim()
          : `turn_${Date.now()}`;

      if (body.action === 'finalize') {
        const rawOutput = typeof body.rawOutput === 'string' ? body.rawOutput : '';
        if (!rawOutput.trim()) {
          res.status(400).json({ error: 'Streamed AI output is empty.' });
          return;
        }

        const finalized = finalizeRealtimeOutput({
          rawOutput,
          message: message || 'App build',
          mode,
          previousHtml: typeof body.previousHtml === 'string' ? body.previousHtml : '',
          hasAttachment: Boolean(body.attachmentDataUrl ?? opts.attachmentDataUrl),
          modelUsed: body.modelUsed,
          modelName: body.modelName,
          provider: body.provider,
          startedAt: body.startedAt,
        });

        let creditsUsed = 0;
        let updatedBilling = initialBillingSummary;
        if (finalized.kind === 'build' && finalized.previewHtml && !isOwnerRequest) {
          const rawCost = Math.max(
            1,
            calculateBuildCreditsForBytes(finalized.previewHtml.length, {
              filesCount: finalized.files.length,
              dbTablesCount: finalized.dbTables.length,
            })
          );
          creditsUsed =
            serverCreditBudget !== null ? Math.min(rawCost, serverCreditBudget) : rawCost;
          if (creditsUsed > 0 && generationCreditContext) {
            updatedBilling =
              (await commitGenerationCredits(generationCreditContext, creditsUsed).catch(
                () => null
              )) ?? initialBillingSummary;
          }
        }

        if (projectId && generationCreditContext?.user?.id) {
          void saveProjectMemorySnapshot(
            {
              userId: generationCreditContext.user.id,
              email: generationCreditContext.user.email || '',
              accessToken: generationCreditContext.accessToken,
            },
            {
              projectId,
              title: finalized.title || undefined,
              mode,
              status: 'complete',
              lastModelUsed: finalized.modelUsed,
              databaseSchema: finalized.dbTables,
              turns: [
                {
                  id: turnId,
                  kind: finalized.kind,
                  userMessage: message || 'App build',
                  aiText: finalized.aiText,
                  phase: 'complete',
                  phaseLabel: finalized.kind === 'build' ? 'Build complete' : 'Answered',
                  activeAction: finalized.kind === 'build' ? 'Built' : 'Answered',
                  activeFile: finalized.files[0] || 'index.html',
                  files: finalized.files,
                  planSteps: finalized.planSteps,
                  previewHtml: finalized.previewHtml,
                  bytesBuilt: finalized.bytesBuilt,
                  modelId: finalized.modelUsed,
                },
              ],
            }
          ).catch(() => {});
        }

        res.setHeader('Cache-Control', 'no-store');
        res.json({
          ...finalized,
          creditsUsed,
          billing: updatedBilling,
        });
        return;
      }

      if (!message) {
        res.status(400).json({ error: 'Prompt message is required.' });
        return;
      }

      const clientCreditsHint =
        typeof (body.clientCreditsRemaining ?? opts.clientCreditsRemaining) === 'number'
          ? Math.max(
              0,
              Math.floor(
                Number(body.clientCreditsRemaining ?? opts.clientCreditsRemaining)
              )
            )
          : null;

      if (!isOwnerRequest) {
        if (serverCreditBudget !== null && serverCreditBudget <= MIN_CHAT_CREDITS_THRESHOLD) {
          res.status(402).json({
            error: `You have ${serverCreditBudget.toLocaleString()} tokens remaining. Top up or upgrade a plan to continue.`,
            code: 'LOW_CREDITS_THRESHOLD',
            billing: initialBillingSummary,
          });
          return;
        }
        if (
          serverCreditBudget === null &&
          clientCreditsHint !== null &&
          clientCreditsHint <= MIN_CHAT_CREDITS_THRESHOLD
        ) {
          res.status(402).json({
            error: `You have ${clientCreditsHint.toLocaleString()} tokens remaining. Top up or upgrade a plan to continue.`,
            code: 'LOW_CREDITS_THRESHOLD',
          });
          return;
        }
      }

      let routeProjectMemoryContext = '';
      if (projectId && generationCreditContext?.user?.id) {
        const memRes = await getProjectMemory(
          {
            userId: generationCreditContext.user.id,
            email: generationCreditContext.user.email || '',
            accessToken: generationCreditContext.accessToken,
          },
          projectId
        ).catch(() => ({ brainContext: '' }));
        routeProjectMemoryContext = memRes.brainContext || '';
      }

      const prepared = await prepareRealtimePrompt({
        message,
        mode,
        requestedModel: typeof body.model === 'string' ? body.model : undefined,
        requestedGateway: typeof body.gateway === 'string' ? body.gateway : undefined,
        history: Array.isArray(body.history) ? body.history : [],
        previousHtml: typeof body.previousHtml === 'string' ? body.previousHtml : '',
        webSearchEnabled: (body.webSearchEnabled ?? opts.webSearchEnabled) !== false,
        forceChat: Boolean(body.forceChat ?? opts.forceChat),
        needsTitle: Boolean(body.needsTitle ?? opts.needsTitle),
        reactEnabled: Boolean(body.reactEnabled ?? opts.reactEnabled),
        backendEnabled: Boolean(body.backendEnabled ?? opts.backendEnabled),
        attachmentName:
          typeof (body.attachmentName ?? opts.attachmentName) === 'string'
            ? String(body.attachmentName ?? opts.attachmentName)
            : null,
        attachmentDataUrl:
          typeof (body.attachmentDataUrl ?? opts.attachmentDataUrl) === 'string'
            ? String(body.attachmentDataUrl ?? opts.attachmentDataUrl)
            : null,
        attachmentText:
          typeof (body.attachmentText ?? opts.attachmentText) === 'string'
            ? String(body.attachmentText ?? opts.attachmentText)
            : null,
        secretKeys: Array.isArray(body.secretKeys ?? opts.secretKeys)
          ? ((body.secretKeys ?? opts.secretKeys) as string[])
          : [],
        secretHints: Array.isArray(body.secretHints ?? opts.secretHints)
          ? ((body.secretHints ?? opts.secretHints) as Array<{ key?: string; hint?: string }>)
          : [],
        databaseTables: Array.isArray(body.databaseTables ?? opts.databaseTables)
          ? ((body.databaseTables ?? opts.databaseTables) as string[])
          : [],
        clientTime: body.clientTime,
        clientTimeZone: body.clientTimeZone,
        visualHints: (body.visualHints ?? opts.visualHints ?? null) as VisualHintsSpec | null,
        projectMemoryContext: routeProjectMemoryContext,
      });

      if (body.action === 'prepare') {
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          ok: true,
          isOwnerRequest,
          billing: initialBillingSummary,
          ...prepared,
        });
        return;
      }

      let rawOutput = '';
      const previousHtmlForRoute =
        typeof body.previousHtml === 'string' ? body.previousHtml : '';
      const streamRes = await streamServerFreeAiRealTime({
        requestedModel: typeof body.model === 'string' ? body.model : undefined,
        initialRoute: prepared.initialRoute,
        systemPrompt: prepared.systemPrompt,
        historyMessages: prepared.historyMessages,
        userPrompt: prepared.userPrompt,
        attachmentDataUrl:
          typeof (body.attachmentDataUrl ?? opts.attachmentDataUrl) === 'string'
            ? String(body.attachmentDataUrl ?? opts.attachmentDataUrl)
            : null,
        allowParallelAgents:
          prepared.initialRoute === 'build' &&
          !prepared.isPatchMode &&
          previousHtmlForRoute.trim().length === 0 &&
          !/\[\[\s*CONTINUE_BUILD\s*\]\]/i.test(
            typeof body.message === 'string' ? body.message : ''
          ),
        onReplaceRawOutput: (raw) => {
          rawOutput = raw;
        },
        onContentChunk: (chunk) => {
          rawOutput += chunk;
        },
      });

      const finalized = finalizeRealtimeOutput({
        rawOutput,
        message,
        mode,
        previousHtml: typeof body.previousHtml === 'string' ? body.previousHtml : '',
        hasAttachment: Boolean(body.attachmentDataUrl ?? opts.attachmentDataUrl),
        modelUsed: streamRes.modelUsed,
        modelName: streamRes.modelName,
        provider: streamRes.provider,
      });

      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ...finalized,
        searchData: prepared.searchData,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to run free browser AI.';
      res.status(502).json({ error: message });
    }
  });

  app.post('/api/craft/stream', async (req, res) => {
    req.setTimeout?.(0);
    res.setTimeout?.(0);

    const body = req.body as {
      projectId?: string;
      turnId?: string;
      message?: string;
      mode?: string;
      model?: string;
      gateway?: string;
      clientTime?: string;
      clientTimeZone?: string;
      previousHtml?: string;
      history?: Array<{ role: string; text: string }>;
      clientClassification?: Record<string, unknown> | null;
      visualHints?: VisualHintsSpec | null;
      options?: {
        reactEnabled?: boolean;
        backendEnabled?: boolean;
        webSearchEnabled?: boolean;
        forceChat?: boolean;
        attachmentName?: string | null;
        attachmentDataUrl?: string | null;
        attachmentMimeType?: string | null;
        attachmentText?: string | null;
        secretKeys?: string[];
        secretHints?: Array<{ key?: string; hint?: string }>;
        databaseTables?: string[];
        clientCreditsRemaining?: number;
        needsTitle?: boolean;
        clientClassification?: Record<string, unknown> | null;
        visualHints?: VisualHintsSpec | null;
      };
    };

    const projectId = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
    const turnId =
      typeof body?.turnId === 'string' && body.turnId.trim()
        ? body.turnId.trim()
        : `turn_${Date.now()}`;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const mode = body?.mode === 'web' ? 'web' : 'mobile';
    const requestedModel =
      typeof body?.model === 'string' ? body.model.trim() : '';
    const requestedGateway =
      typeof body?.gateway === 'string' ? body.gateway.trim() : '';
    const clientTime =
      typeof body?.clientTime === 'string' ? body.clientTime.trim() : '';
    const clientTimeZone =
      typeof body?.clientTimeZone === 'string' ? body.clientTimeZone.trim() : '';
    const previousHtml =
      typeof body?.previousHtml === 'string' ? body.previousHtml : '';
    const history = Array.isArray(body?.history) ? body.history : [];
    const options = body?.options ?? {};
    const attachmentDataUrl =
      typeof options.attachmentDataUrl === 'string' &&
      options.attachmentDataUrl.startsWith('data:image/')
        ? options.attachmentDataUrl
        : null;
    const attachmentMimeType =
      typeof options.attachmentMimeType === 'string'
        ? options.attachmentMimeType
        : null;
    const attachmentText =
      typeof options.attachmentText === 'string' && options.attachmentText.trim()
        ? options.attachmentText.trim().slice(0, 12000)
        : null;
    const webSearchEnabled = options.webSearchEnabled !== false;
    const secretKeys = Array.isArray(options.secretKeys)
      ? options.secretKeys
          .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
          .map((k) => k.trim())
          .slice(0, 30)
      : [];
    const secretHints = Array.isArray(options.secretHints)
      ? options.secretHints
          .filter(
            (item): item is { key: string; hint: string } =>
              Boolean(item && typeof item.key === 'string' && item.key.trim().length > 0)
          )
          .map((item) => ({
            key: item.key.trim(),
            hint: typeof item.hint === 'string' && item.hint.trim() ? item.hint.trim() : 'configured-secret',
          }))
          .slice(0, 30)
      : secretKeys.map((key) => ({ key, hint: 'configured-secret' }));
    const databaseTables = Array.isArray(options.databaseTables)
      ? options.databaseTables
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .map((t) => t.trim())
          .slice(0, 20)
      : [];
    const clientCreditsHint =
      typeof options.clientCreditsRemaining === 'number' &&
      Number.isFinite(options.clientCreditsRemaining)
        ? Math.max(0, Math.floor(options.clientCreditsRemaining))
        : null;

    if (!message) {
      res.status(400).json({ error: 'Prompt message is required.' });
      return;
    }

    let generationCreditContext: VerifiedGenerationContext | null = null;
    let initialBillingSummary = null;
    let serverCreditBudget: number | null = null;
    let isOwnerRequest = false;
    {
      const cookies = parseCookies(req.headers.cookie);
      const authHeader = req.headers.authorization || '';
      const bearerToken = /^bearer\s+/i.test(authHeader)
        ? authHeader.replace(/^bearer\s+/i, '').trim()
        : '';
      const accessToken = bearerToken || cookies[SB_ACCESS_COOKIE] || '';
      const refreshToken =
        (typeof req.headers['x-refresh-token'] === 'string'
          ? req.headers['x-refresh-token'].trim()
          : '') ||
        cookies[SB_REFRESH_COOKIE] ||
        '';

      if (accessToken || refreshToken) {
        const auth = await getAuthenticatedSupabaseUser(accessToken, refreshToken);
        if (auth.user) {
          const resolvedMod = await resolveUserWithModeration(auth.user);
          if (resolvedMod?.flags.banned) {
            clearAuthCookies(res);
            res.status(403).json({
              error: 'This account has been suspended by the app owner.',
              code: 'ACCOUNT_BANNED',
              banned: true,
            });
            return;
          }
          if (resolvedMod?.flags.restricted) {
            res.status(403).json({
              error: 'Your account is currently restricted from building or chatting.',
              code: 'ACCOUNT_RESTRICTED',
              restricted: true,
            });
            return;
          }
          isOwnerRequest = Boolean(
            resolvedMod?.serialized.isOwner || isOwnerEmail(auth.user.email)
          );
          const currentBilling = await reconcileAndLoadBillingState({
            user: auth.user,
            accessToken: auth.accessToken,
            refreshToken: auth.refreshToken,
            checkPaystack: false,
          });
          if (isOwnerRequest) {
            generationCreditContext = {
              user: auth.user,
              accessToken: auth.accessToken,
              refreshToken: auth.refreshToken,
              state: currentBilling,
              isOwner: true,
            };
            initialBillingSummary = serializeBillingSummary(currentBilling, true);
            serverCreditBudget = null;
          } else {
            const availableBudget = getAvailableCreditsBudget(currentBilling, Date.now());
            if (availableBudget <= MIN_CHAT_CREDITS_THRESHOLD) {
              const plan = getPlanConfig(currentBilling.tier);
              const hitDaily =
                plan.dailyLimit !== null && currentBilling.dailyCreditsUsed >= plan.dailyLimit;
              res.status(402).json({
                error: hitDaily
                  ? `Daily limit reached (${(plan.dailyLimit ?? 0).toLocaleString()} credits/day on ${plan.name}). Resets in 24 hours or upgrade your plan.`
                  : `You have ${availableBudget.toLocaleString()} tokens remaining (minimum ${MIN_CHAT_CREDITS_THRESHOLD + 1} tokens required to chat or build). Top up or upgrade a plan to continue.`,
                code: hitDaily ? 'DAILY_LIMIT_REACHED' : 'LOW_CREDITS_THRESHOLD',
                billing: serializeBillingSummary(currentBilling),
              });
              return;
            }
            generationCreditContext = {
              user: auth.user,
              accessToken: auth.accessToken,
              refreshToken: auth.refreshToken,
              state: currentBilling,
            };
            initialBillingSummary = serializeBillingSummary(currentBilling);
            serverCreditBudget = availableBudget;
          }
        }
      }
    }
    const effectiveCreditBudget = isOwnerRequest
      ? null
      : serverCreditBudget !== null
        ? serverCreditBudget
        : clientCreditsHint;
    if (
      !isOwnerRequest &&
      serverCreditBudget === null &&
      clientCreditsHint !== null &&
      clientCreditsHint <= MIN_CHAT_CREDITS_THRESHOLD
    ) {
      res.status(402).json({
        error: `You have ${clientCreditsHint.toLocaleString()} tokens remaining (minimum ${MIN_CHAT_CREDITS_THRESHOLD + 1} tokens required to chat or build). Top up or upgrade a plan to continue.`,
        code: 'LOW_CREDITS_THRESHOLD',
      });
      return;
    }

    pruneOldJobs();

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    const job: CraftJob = {
      id: jobId,
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      kind: 'chat',
      phase: 'understanding',
      phaseLabel: 'Thinking...',
      activeAction: 'Thinking',
      activeFile: '',
      files: [],
      planSteps: [],
      suggestions: [],
      dbTables: [],
      bytesBuilt: 0,
      aiText: '',
      previewHtml: '',
      subscribers: new Set([res]),
    };
    craftJobs.set(jobId, job);

    const sendEvent = (payload: Record<string, unknown>) => {
      emitJobEvent(job, payload);
    };

    sendEvent({ type: 'job', jobId: job.id, startedAt: job.startedAt });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': ping\n\n');
      } else {
        clearInterval(keepAlive);
      }
    }, 2000);

    // Keep AI generation running to completion even if the user closes/leaves the app
    const clientAbort = new AbortController();
    res.on('close', () => {
      clearInterval(keepAlive);
      job.subscribers.delete(res);
    });

    let rawAccumulated = '';

    try {
      sendEvent({
        type: 'phase',
        phase: 'understanding',
        kind: 'chat',
        label: 'Searching live web & thinking...',
      });

      const memAuth =
        projectId && generationCreditContext?.user?.id
          ? {
              userId: generationCreditContext.user.id,
              email: generationCreditContext.user.email || '',
              accessToken: generationCreditContext.accessToken,
            }
          : null;
      const projectMemoryPromise = memAuth
        ? getProjectMemory(memAuth, projectId).catch(() => ({
            brainContext: '',
            memory: null,
          }))
        : Promise.resolve({ brainContext: '', memory: null });

      const visualHints = body?.visualHints ?? options.visualHints ?? null;
      const prepared = await prepareRealtimePrompt({
        message,
        mode,
        requestedModel,
        requestedGateway,
        history,
        previousHtml,
        webSearchEnabled,
        forceChat: Boolean(options.forceChat),
        needsTitle: Boolean(options.needsTitle),
        reactEnabled: Boolean(options.reactEnabled),
        backendEnabled: Boolean(options.backendEnabled),
        attachmentName: options.attachmentName ?? null,
        attachmentDataUrl,
        attachmentText,
        secretKeys,
        secretHints,
        databaseTables,
        clientTime,
        clientTimeZone,
        visualHints,
        projectMemoryPromise,
        onStage: (stage) => {
          sendEvent({
            type: 'phase',
            phase: stage.phase,
            kind: stage.kind,
            action: stage.action,
            label: stage.label,
          });
        },
      });

      sendEvent({
        type: 'meta',
        kind: prepared.naturalMediaIntent ? 'media' : 'chat',
        modelId: requestedModel || 'mesh::auto',
        modelName: prepared.requestedModelLabel || 'Free AI Mesh · Auto',
        provider: 'free-mesh',
        gateway: 'mesh',
        isFallback: false,
      });

      if (prepared.naturalMediaIntent) {
        const mediaKind = prepared.naturalMediaIntent;
        sendEvent({
          type: 'phase',
          phase: 'building',
          kind: 'media',
          label:
            mediaKind === 'video'
              ? 'Generating motion preview...'
              : mediaKind === 'music'
                ? 'Composing custom studio track...'
                : 'Generating image & searching visual references...',
        });

        const mediaResult: GeneratedMediaResult = await generateMediaAsset({
          kind: mediaKind,
          prompt: message,
          requestedModel,
        });

        clearInterval(keepAlive);
        sendEvent({ type: 'media', media: mediaResult });
        sendEvent({
          type: 'done',
          kind: 'media',
          fullText: `Generated your ${mediaKind}: "${message.slice(0, 120)}"`,
          previewHtml: '',
          allFiles: [],
          suggestions: [],
          dbTables: [],
          bytesBuilt: 0,
          creditsUsed: 0,
          billing: initialBillingSummary,
          media: mediaResult,
          modelUsed: mediaResult.modelId || 'free-media',
          modelName: prepared.requestedModelLabel || 'Free AI Studio',
          provider: mediaResult.gateway,
          startedAt: job.startedAt,
        });
        return;
      }

      rawAccumulated = '';
      let emittedTitle = '';
      let emittedPlanCount = 0;
      let emittedDbKey = '';
      let emittedProseLen = 0;
      let enteredCodePhase = false;
      let lastFilesKey = '';
      let lastBytesSent = 0;
      let lastPreviewBytesSent = 0;
      let emittedReasoningPhase = false;

      let activeModelUsed = requestedModel || 'mesh::auto';
      let activeModelName = prepared.requestedModelLabel || 'Free AI Mesh · Auto';
      let activeProvider = 'free-mesh';
      let parallelMergedRaw: string | null = null;

      let lastReasoningUpdateAt = 0;
      let reasoningBuffer = '';

      await streamServerFreeAiRealTime({
        requestedModel,
        initialRoute: prepared.initialRoute,
        systemPrompt: prepared.systemPrompt,
        historyMessages: prepared.historyMessages,
        userPrompt: prepared.userPrompt,
        attachmentDataUrl,
        signal: clientAbort.signal,
        // Fresh full builds fan out to 3 agents (architect streams live while
        // designer + engineer draft concurrently); patches/continues stay on
        // the single live stream.
        allowParallelAgents:
          prepared.initialRoute === 'build' &&
          !prepared.isPatchMode &&
          previousHtml.trim().length === 0 &&
          !/\[\[\s*CONTINUE_BUILD\s*\]\]/i.test(message),
        onAgentsSnapshot: (agents) => {
          sendEvent({ type: 'agents', agents });
        },
        onReplaceRawOutput: (raw, previewHtml) => {
          parallelMergedRaw = raw;
          sendEvent({
            type: 'previewReplace',
            previewHtml,
            bytesBuilt: previewHtml.length,
          });
        },
        onModelMeta: (meta) => {
          activeModelUsed = meta.modelId;
          activeModelName = meta.modelName;
          activeProvider = meta.provider;
          sendEvent({
            type: 'meta',
            kind: 'chat',
            modelId: meta.modelId,
            modelName: meta.modelName,
            provider: meta.provider,
            gateway: meta.provider,
            isFallback: false,
          });
        },
        onReasoningChunk: (reasoningChunk) => {
          if (enteredCodePhase) return;
          reasoningBuffer = `${reasoningBuffer}${reasoningChunk}`.slice(-600);
          const now = Date.now();
          if (!emittedReasoningPhase || now - lastReasoningUpdateAt >= 1600) {
            emittedReasoningPhase = true;
            lastReasoningUpdateAt = now;
            const headingMatches = Array.from(reasoningBuffer.matchAll(/\*\*([^*\n]{4,72})\*\*/g));
            const latestHeading =
              headingMatches[headingMatches.length - 1]?.[1]?.trim() ||
              'Planning screens, data & layout step by step...';
            sendEvent({
              type: 'phase',
              phase: 'understanding',
              kind: prepared.initialRoute === 'build' ? 'build' : 'chat',
              action: 'Thinking',
              label: latestHeading,
            });
          }
        },
        onContentChunk: (chunk) => {
          rawAccumulated += chunk;
          const cleanSoFar = stripReasoningTags(rawAccumulated);

          const foundTitle = extractSessionTitleFromRaw(cleanSoFar);
          if (foundTitle && foundTitle !== emittedTitle) {
            emittedTitle = foundTitle;
            sendEvent({ type: 'title', title: foundTitle });
          }

          const stepsSoFar = extractPlanStepsFromRaw(cleanSoFar);
          while (emittedPlanCount < stepsSoFar.length) {
            const nextStep = stepsSoFar[emittedPlanCount];
            emittedPlanCount += 1;
            sendEvent({
              type: 'plan',
              step: nextStep,
              allSteps: stepsSoFar.slice(0, emittedPlanCount),
            });
          }

          const tablesSoFar = extractDbSchemaFromRaw(cleanSoFar);
          if (tablesSoFar.length > 0) {
            const key = tablesSoFar.map((t) => `${t.name}:${t.columns.length}`).join('|');
            if (key !== emittedDbKey) {
              emittedDbKey = key;
              sendEvent({ type: 'schema', tables: tablesSoFar });
            }
          }

          const codeStart = findCodeStart(cleanSoFar);
          if (!codeStart) {
            const proseSoFar = sanitizeBuildProse(cleanSoFar);
            if (proseSoFar.length > emittedProseLen) {
              const delta = proseSoFar.slice(emittedProseLen);
              emittedProseLen = proseSoFar.length;
              if (delta) {
                sendEvent({ type: 'delta', text: delta });
              }
            }
          } else {
            const preCodeProse = sanitizeBuildProse(cleanSoFar.slice(0, codeStart.markerIdx));
            if (preCodeProse.length > emittedProseLen) {
              const delta = preCodeProse.slice(emittedProseLen);
              emittedProseLen = preCodeProse.length;
              if (delta) {
                sendEvent({ type: 'delta', text: delta });
              }
            }

            if (!enteredCodePhase) {
              enteredCodePhase = true;
              sendEvent({
                type: 'phase',
                phase: 'building',
                kind: 'build',
                label: 'Writing real-time code...',
              });
            }

            const htmlSoFar = cleanSoFar
              .slice(codeStart.htmlOffset)
              .replace(/<<<\s*END_AICRAFT_APP_HTML\s*>>>[\s\S]*/i, '');
            const artifacts = extractLiveBuildArtifacts(htmlSoFar);
            const paths = artifacts.map((a) => a.path);
            const filesKey = paths.join('|');
            if (filesKey !== lastFilesKey || htmlSoFar.length - lastBytesSent >= 450) {
              lastFilesKey = filesKey;
              lastBytesSent = htmlSoFar.length;
              const active = artifacts[artifacts.length - 1];
              sendEvent({
                type: 'file',
                action: active?.action || 'Coding',
                path: active?.path || 'index.html',
                allFiles: paths,
                bytesBuilt: htmlSoFar.length,
              });
            }
            if (htmlSoFar.length >= 450 && htmlSoFar.length - lastPreviewBytesSent >= 1400) {
              lastPreviewBytesSent = htmlSoFar.length;
              const liveHtml = finalizePartialPreviewHtml(cleanSoFar);
              if (liveHtml) {
                sendEvent({
                  type: 'partialHtml',
                  previewHtml: liveHtml,
                  bytesBuilt: htmlSoFar.length,
                });
              }
            }
          }
        },
      });

      // 3-agent merge finished → swap the architect's streamed draft for the
      // final merged HTML (designer CSS + engineer JS) before finalization.
      if (parallelMergedRaw) {
        rawAccumulated = parallelMergedRaw;
      }

      clearInterval(keepAlive);

      if (enteredCodePhase) {
        sendEvent({
          type: 'phase',
          phase: 'building',
          kind: 'build',
          action: 'Checking',
          label: 'Checking code & live preview...',
        });
      }

      const finalized = finalizeRealtimeOutput({
        rawOutput: rawAccumulated,
        message,
        mode,
        previousHtml,
        hasAttachment: Boolean(attachmentDataUrl),
        modelUsed: activeModelUsed,
        modelName: activeModelName,
        provider: activeProvider,
        startedAt: job.startedAt,
      });

      if (
        finalized.kind === 'build' &&
        !finalized.valid &&
        finalized.previewHtml &&
        Date.now() - job.startedAt < 45000
      ) {
        sendEvent({
          type: 'phase',
          phase: 'building',
          kind: 'build',
          action: 'Checking',
          label: 'Verifying scripts & polishing live UI...',
        });
        const repairedHtml = await repairIncompleteBuildHtml({
          brokenHtml: finalized.previewHtml,
          validationReason: finalized.validationReason || 'Incomplete app output',
          userMessage: message,
          mode,
        });
        if (repairedHtml) {
          finalized.previewHtml = repairedHtml;
          finalized.bytesBuilt = repairedHtml.length;
          finalized.valid = true;
        }
      }

      if (finalized.kind === 'chat') {
        if (memAuth) {
          void saveProjectMemorySnapshot(memAuth, {
            projectId,
            title: finalized.title || undefined,
            mode,
            lastModelUsed: finalized.modelUsed,
            turns: [
              {
                id: turnId,
                kind: 'chat',
                userMessage: message,
                aiText: finalized.aiText,
                phase: 'complete',
                phaseLabel: 'Answered',
                modelId: finalized.modelUsed,
              },
            ],
          }).catch(() => {});
        }
        sendEvent({
          type: 'done',
          kind: 'chat',
          title: prepared.shouldGenerateTitle ? finalized.title : undefined,
          fullText: finalized.aiText,
          previewHtml: '',
          allFiles: [],
          suggestions: [],
          dbTables: [],
          bytesBuilt: 0,
          creditsUsed: 0,
          billing: initialBillingSummary,
          modelUsed: finalized.modelUsed,
          modelName: finalized.modelName,
          provider: finalized.provider,
          startedAt: job.startedAt,
        });
        return;
      }

      if (finalized.kind === 'media') {
        const mediaResult: GeneratedMediaResult = await generateMediaAsset({
          kind: 'image',
          prompt: finalized.mediaPrompt || message,
          requestedModel,
        });
        sendEvent({ type: 'media', media: mediaResult });
        sendEvent({
          type: 'done',
          kind: 'media',
          title: prepared.shouldGenerateTitle ? finalized.title : undefined,
          fullText: finalized.aiText,
          previewHtml: '',
          allFiles: [],
          suggestions: [],
          dbTables: [],
          bytesBuilt: 0,
          creditsUsed: 0,
          billing: initialBillingSummary,
          media: mediaResult,
          modelUsed: mediaResult.modelId || 'free-media',
          modelName: prepared.requestedModelLabel,
          provider: mediaResult.gateway,
          startedAt: job.startedAt,
        });
        return;
      }

      const rawCreditsUsed = isOwnerRequest
        ? 0
        : Math.max(
            1,
            calculateBuildCreditsForBytes(finalized.previewHtml.length, {
              filesCount: finalized.files.length,
              dbTablesCount: finalized.dbTables.length,
            })
          );
      const finalCreditsUsed = isOwnerRequest
        ? 0
        : effectiveCreditBudget !== null
          ? Math.min(rawCreditsUsed, effectiveCreditBudget)
          : rawCreditsUsed;

      let updatedBilling = initialBillingSummary;
      if (finalCreditsUsed > 0 && generationCreditContext) {
        updatedBilling =
          (await commitGenerationCredits(
            generationCreditContext,
            finalCreditsUsed
          ).catch(() => null)) ?? initialBillingSummary;
      }

      if (memAuth) {
        void saveProjectMemorySnapshot(memAuth, {
          projectId,
          title: finalized.title || undefined,
          mode,
          status: 'complete',
          lastModelUsed: finalized.modelUsed,
          databaseSchema: finalized.dbTables,
          turns: [
            {
              id: turnId,
              kind: 'build',
              userMessage: message,
              aiText: finalized.aiText,
              phase: 'complete',
              phaseLabel: 'Build complete',
              activeAction: 'Built',
              activeFile: finalized.files[0] || 'index.html',
              files: finalized.files,
              planSteps: finalized.planSteps,
              previewHtml: finalized.previewHtml,
              bytesBuilt: finalized.bytesBuilt,
              modelId: finalized.modelUsed,
            },
          ],
        }).catch(() => {});
      }

      sendEvent({
        type: 'done',
        kind: 'build',
        title: prepared.shouldGenerateTitle ? finalized.title : undefined,
        logo: finalized.logo ?? undefined,
        fullText: finalized.aiText,
        previewHtml: finalized.previewHtml,
        allFiles: finalized.files,
        suggestions: finalized.suggestions,
        dbTables: finalized.dbTables,
        bytesBuilt: finalized.bytesBuilt,
        creditsUsed: finalCreditsUsed,
        billing: updatedBilling,
        modelUsed: finalized.modelUsed,
        modelName: finalized.modelName,
        provider: finalized.provider,
        startedAt: job.startedAt,
      });
    } catch (err) {
      clearInterval(keepAlive);
      const savedPartial = rawAccumulated
        ? finalizePartialPreviewHtml(stripReasoningTags(rawAccumulated))
        : '';
      if (savedPartial && savedPartial.length >= 450) {
        sendEvent({
          type: 'partialHtml',
          previewHtml: savedPartial,
          bytesBuilt: savedPartial.length,
        });
      }
      const errorMessage =
        err instanceof Error ? err.message : 'Unable to reach free AI engine right now.';
      if (projectId && generationCreditContext?.user?.id) {
        void recordBuildCheckpoint(
          {
            userId: generationCreditContext.user.id,
            email: generationCreditContext.user.email || '',
            accessToken: generationCreditContext.accessToken,
          },
          {
            projectId,
            mode,
            turnId,
            phase: 'error',
            phaseLabel: 'Paused on error',
            pausedReason: 'STREAM_ERROR',
            pausedMessage: errorMessage,
            unfinishedTaskTitle: message.slice(0, 120),
            partialHtml: savedPartial || undefined,
          }
        ).catch(() => {});
      }
      sendEvent({
        type: 'error',
        message: errorMessage,
      });
    }
  });

  // Serve 3D head GLB pre-gzipped with immutable browser caching for instant load
  const glbCandidates = [
    path.join(__dirname, 'public', 'psichedelic_abstract_geometry_loop_animation.glb'),
    path.join(__dirname, 'dist', 'psichedelic_abstract_geometry_loop_animation.glb'),
    path.join(__dirname, 'psichedelic_abstract_geometry_loop_animation.glb'),
  ];
  const glbPath = glbCandidates.find((p) => fs.existsSync(p));
  const glbRaw = glbPath ? fs.readFileSync(glbPath) : null;
  const glbGzip = glbRaw ? zlib.gzipSync(glbRaw, { level: 6 }) : null;

  app.get('/psichedelic_abstract_geometry_loop_animation.glb', (req, res) => {
    if (!glbRaw) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Vary', 'Accept-Encoding');
    const acceptEnc = String(req.headers['accept-encoding'] || '');
    if (glbGzip && acceptEnc.includes('gzip')) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(glbGzip.length));
      res.status(200).send(glbGzip);
      return;
    }
    res.setHeader('Content-Length', String(glbRaw.length));
    res.status(200).send(glbRaw);
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AI Craft server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start AI Craft server:', err);
  process.exit(1);
});
