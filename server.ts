import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createClient, type User as SupabaseUser } from '@supabase/supabase-js';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  buildPaymentCallbackHtml,
  getPaymentSecretKey,
  getPlanConfig,
  initializeCheckoutSession,
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
  loadPublishedApp,
  renderAppIconPng,
  renderAppIconSvg,
  sanitizeAppId,
  sanitizeSessionTitle,
  savePublishedApp,
  type AppLogoConfig,
} from './api/_appsStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

import {
  ARCHITECT_PUBLIC_MODEL,
  buildCandidateCooldownKey,
  buildGatewayExecutionPlan,
  fetchAllGatewayModels,
  fetchGroqCatalog,
  fetchHuggingFaceCatalog,
  fetchNgrokCatalog,
  fetchPollinationsCatalog,
  getGatewayOrder,
  getGroqApiKey,
  getHuggingFaceApiKey,
  getNgrokApiKey,
  isGatewayCandidateCoolingDown,
  markGatewayCandidateCooldown,
  POLLINATIONS_FALLBACK_MODELS,
  type AiGatewayId,
  type GatewayExecutionCandidate,
  type UnifiedAiModel,
} from './api/_aiGateways.js';
import {
  generateMediaAsset,
  type GeneratedMediaResult,
} from './api/_mediaService.js';
import {
  cleanEnvKey,
  fetchFreeOpenRouterCatalog,
  getGeminiApiKey,
  getGeminiApiKeyPool,
  getOpenRouterApiKey,
  resolveFreeModelInfo,
  type NormalizedOpenRouterModel,
} from './api/_openrouterModels.js';
import {
  ModerationActionType,
  applyOwnerModerationAction,
  checkExpressUserModeration,
  listAllRealSignedInUsers,
  recordSignedInUser,
  resolveUserWithModeration,
} from './api/_moderation.js';
import {
  END_MARKER,
  HOLDBACK_CHARS,
  type InitialRoute,
  type ParsedDbTable,
  START_MARKER,
  buildFocusedSearchQuery,
  buildCraftSystemPrompt,
  buildProjectInfraContext,
  buildSmartFollowUpSuggestions,
  classifyInitialRoute,
  extractDbSchemaFromHtml,
  extractDbSchemaFromRaw,
  extractLiveBuildArtifacts,
  extractPlanStepsFromRaw,
  extractPreviewHtmlFromRaw,
  extractPreviewStructureSummary,
  extractSessionTitleFromRaw,
  extractSuggestionsFromRaw,
  finalizePartialPreviewHtml,
  findCodeStart,
  formatWebSearchContext,
  mergeParsedDbTables,
  runLiveBrowserSearch,
  sanitizeAndHardenPreviewHtml,
  sanitizeBuildProse,
  shouldRunChatSearch,
  stripReasoningTags,
  stripTagMarkers,
  validateBuiltAppHtml,
} from './api/_builderCore.js';
import {
  GeminiRouterError,
  routeMessageWithGemini,
} from './api/_geminiRouter.js';
import { assembleModularInterface } from './api/_moduleAssembler.js';

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedModels: NormalizedOpenRouterModel[] = [];
let cachedGroqModels: UnifiedAiModel[] = [];
let cachedHfModels: UnifiedAiModel[] = [];
let cachedNgrokModels: UnifiedAiModel[] = [];
let cachedPollinationsModels: UnifiedAiModel[] = [];
let modelsCachedAt = 0;
let modelsCachedKey = '';

interface GeminiKeyClientEntry {
  apiKey: string;
  cooldownKey: string;
  client: GoogleGenAI;
}

function createGeminiClientPool(): GeminiKeyClientEntry[] {
  const keys = getGeminiApiKeyPool();
  const ready: GeminiKeyClientEntry[] = [];
  const cooling: GeminiKeyClientEntry[] = [];
  for (const apiKey of keys) {
    const cooldownKey = buildCandidateCooldownKey(
      'gemini',
      apiKey,
      'gemini-4-hydrogen'
    );
    const entry: GeminiKeyClientEntry = {
      apiKey,
      cooldownKey,
      client: new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      }),
    };
    if (isGatewayCandidateCoolingDown(cooldownKey)) {
      cooling.push(entry);
    } else {
      ready.push(entry);
    }
  }
  return [...ready, ...cooling];
}

function createGeminiClient() {
  return createGeminiClientPool()[0]?.client ?? null;
}

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

function resolveModelInfo(modelId: string): {
  id: string;
  name: string;
  provider: string;
} {
  return resolveFreeModelInfo(modelId, cachedModels);
}

async function fetchOpenRouterModels(forceRefresh = false): Promise<NormalizedOpenRouterModel[]> {
  const openRouterKey = getOpenRouterApiKey();
  const now = Date.now();

  if (
    !forceRefresh &&
    modelsCachedKey === openRouterKey &&
    cachedModels.length > 0 &&
    now - modelsCachedAt < MODELS_CACHE_TTL_MS
  ) {
    return cachedModels;
  }

  const referer = process.env.APP_URL || `http://localhost:${PORT}`;
  const openRouterModels = await fetchFreeOpenRouterCatalog(openRouterKey, referer);

  if (openRouterModels.length > 0) {
    cachedModels = openRouterModels;
    modelsCachedAt = now;
    modelsCachedKey = openRouterKey;
  }

  return openRouterModels;
}

type OpenRouterContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type OpenRouterMessageContent = string | OpenRouterContentPart[];

interface OpenRouterChatMessage {
  role: 'user' | 'assistant';
  content: OpenRouterMessageContent;
}


class GatewayApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GatewayApiError';
    this.status = status;
  }
}

function stripImagesFromMessages(
  messages: OpenRouterChatMessage[]
): OpenRouterChatMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') return msg;
    const textOnly = msg.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n\n');
    return {
      role: msg.role,
      content: textOnly || 'Please process the user request.',
    };
  });
}

async function streamOpenRouterCompletion(
  candidate: GatewayExecutionCandidate,
  systemInstruction: string,
  messages: OpenRouterChatMessage[],
  onTextChunk: (chunkText: string) => void,
  onReasoningChunk?: () => void,
  signal?: AbortSignal
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (candidate.apiKey) {
    headers.Authorization = `Bearer ${candidate.apiKey}`;
  }
  if (candidate.isOpenRouter) {
    headers['HTTP-Referer'] = process.env.APP_URL || `http://localhost:${PORT}`;
    headers['X-Title'] = 'AI Craft';
  }

  const endpointUrl =
    candidate.gateway === 'pollinations'
      ? `${candidate.baseUrl}/openai`
      : `${candidate.baseUrl}/chat/completions`;

  const attemptController = new AbortController();
  let timedOutReason = '';
  let receivedAnyStreamData = false;

  const forwardAbort = () => {
    if (!attemptController.signal.aborted) {
      attemptController.abort();
    }
  };
  if (signal) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetWatchdog = (ms: number, reason: string) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOutReason = reason;
      if (!attemptController.signal.aborted) {
        attemptController.abort();
      }
    }, ms);
  };

  // Initial connect / first-byte timeout: 24s so calm reasoning/thinking models don't abort prematurely
  resetWatchdog(24_000, `${candidate.modelName} timed out before responding`);

  try {
    const sendRequest = async (
      payloadMessages: OpenRouterChatMessage[],
      withMaxTokens = true
    ) =>
      fetch(endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: candidate.upstreamModelId,
          stream: true,
          ...(withMaxTokens ? { max_tokens: 10240 } : {}),
          messages: [
            { role: 'system', content: systemInstruction },
            ...payloadMessages,
          ],
        }),
        signal: attemptController.signal,
      });

    let activeMessages = messages;
    let response = await sendRequest(activeMessages, true);
    const hasImages = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
    );

    // If a text-only model rejects multimodal image_url blocks, retry once as text-only
    if (
      hasImages &&
      (!response.ok || !response.body) &&
      (response.status === 400 || response.status === 404 || response.status === 422)
    ) {
      await response.text().catch(() => '');
      activeMessages = stripImagesFromMessages(messages);
      response = await sendRequest(activeMessages, true);
    }

    if ((!response.ok || !response.body) && response.status === 400) {
      await response.text().catch(() => '');
      response = await sendRequest(activeMessages, false);
    }

    if (!response.ok || !response.body) {
      let errorDetail = `${candidate.gatewayLabel} error (${response.status})`;
      try {
        const errBody = (await response.json()) as {
          error?: { message?: string };
          message?: string;
        };
        if (errBody?.error?.message) {
          errorDetail = errBody.error.message;
        } else if (errBody?.message) {
          errorDetail = errBody.message;
        }
      } catch {
        const text = await response.text().catch(() => '');
        if (text) errorDetail = text.slice(0, 200);
      }
      throw new GatewayApiError(errorDetail, response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    resetWatchdog(22_000, `${candidate.modelName} stalled mid-stream`);

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      receivedAnyStreamData = true;
      resetWatchdog(22_000, `${candidate.modelName} stalled mid-stream`);

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const trimmedLine = rawLine.trim();
        if (!trimmedLine || trimmedLine.startsWith(':')) continue;

        const subFrames = trimmedLine.includes('}data:')
          ? trimmedLine.split(/(?=data:\s*)/)
          : [trimmedLine];

        for (const frame of subFrames) {
          const line = frame.trim();
          if (!line.startsWith('data:')) continue;

          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;

          let parsed: {
            error?: { message?: string };
            choices?: Array<{
              delta?: {
                reasoning?: string;
                reasoning_content?: string;
                content?: string | Array<{ type?: string; text?: string }>;
              };
            }>;
          };

          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          if (parsed?.error?.message) {
            throw new Error(parsed.error.message);
          }

          const delta = parsed?.choices?.[0]?.delta;
          if ((delta?.reasoning || delta?.reasoning_content) && onReasoningChunk) {
            onReasoningChunk();
          }

          const content = delta?.content;
          if (typeof content === 'string' && content.length > 0) {
            onTextChunk(content);
          } else if (Array.isArray(content)) {
            for (const part of content) {
              if (typeof part?.text === 'string' && part.text.length > 0) {
                onTextChunk(part.text);
              }
            }
          }
        }
      }
    }

    if (buffer.trim().startsWith('data:')) {
      const tailFrames = buffer.trim().split(/(?=data:\s*)/);
      for (const frame of tailFrames) {
        const data = frame.trim().slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: { content?: string | Array<{ type?: string; text?: string }> };
            }>;
          };
          const content = parsed?.choices?.[0]?.delta?.content;
          if (typeof content === 'string' && content.length > 0) {
            onTextChunk(content);
          }
        } catch {
          // ignore partial tail
        }
      }
    }

    if (!receivedAnyStreamData) {
      throw new Error(`${candidate.modelName} closed without returning data`);
    }
  } catch (err) {
    if (timedOutReason) {
      throw new GatewayApiError(timedOutReason, 504);
    }
    throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (signal) {
      signal.removeEventListener('abort', forwardAbort);
    }
  }
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
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      geminiConfigured: Boolean(getGeminiApiKey()),
      groqConfigured: Boolean(getGroqApiKey()),
      openRouterConfigured: Boolean(getOpenRouterApiKey()),
      huggingFaceConfigured: Boolean(getHuggingFaceApiKey()),
      ngrokConfigured: Boolean(getNgrokApiKey()),
      pollinationsConfigured: true,
      gatewayOrder: getGatewayOrder(),
      supabaseConfigured: Boolean(sbConfig.url && sbConfig.anonKey),
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
    const users = await listAllRealSignedInUsers();
    res.json({ ok: true, users });
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
    };
    const validActions: ModerationActionType[] = [
      'ban',
      'unban',
      'verify',
      'unverify',
      'restrict',
      'unrestrict',
    ];
    const action =
      typeof body.action === 'string'
        ? (body.action.trim().toLowerCase() as ModerationActionType)
        : ('' as ModerationActionType);

    if (!validActions.includes(action)) {
      res.status(400).json({ error: 'Invalid moderation action.' });
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

  app.get('/api/payments/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ configured: Boolean(getPaymentSecretKey()) });
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
        billingSummary = serializeBillingSummary(upgraded);
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
    res.json({ billing: serializeBillingSummary(state) });
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
        const plan = resolvePlanFromMetadataOrAmount(
          eventPayload.data.metadata,
          amountKobo
        );
        if (amountKobo >= plan.amountKobo) {
          await upgradeUserAccountFromTransaction({
            tx: {
              id: String(eventPayload.data.id ?? reference),
              reference,
              planId: plan.id,
              planName: plan.name,
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
    asset: string
  ) => {
    if (asset === 'manifest') {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.send(JSON.stringify(buildAppManifestJson(record)));
      return true;
    }
    if (asset === 'sw') {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Service-Worker-Allowed', `/app/${record.appId}`);
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.send(buildAppServiceWorkerJs(record));
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
    if (asset && servePublishedAsset(res, record, asset)) {
      return;
    }
    if (req.query.format === 'json') {
      const logo = getAppLogoConfig(record);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        exists: true,
        appId: record.appId,
        projectId: record.projectId,
        title: record.title,
        slug: record.slug,
        mode: record.mode,
        version: record.version,
        themeColor: logo.themeColor,
        logoUrl: `/app/${record.appId}/icon-180.png?v=${record.version}`,
        manifestUrl: `/app/${record.appId}/manifest.webmanifest?v=${record.version}`,
        updatedAt: record.updatedAt,
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.send(buildStandaloneAppHtml(record));
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
    if (!servePublishedAsset(res, record, asset)) {
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
    res.send(buildStandaloneAppHtml(record));
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
      version: nextVersion,
      updatedAt: new Date().toISOString(),
    });

    const logo = getAppLogoConfig(record);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      appId: record.appId,
      slug: record.slug,
      path: `/app/${record.appId}`,
      logoUrl: `/app/${record.appId}/icon-180.png?v=${record.version}`,
      manifestUrl: `/app/${record.appId}/manifest.webmanifest?v=${record.version}`,
      themeColor: logo.themeColor,
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
          fullText: job.aiText,
          previewHtml: job.previewHtml,
          allFiles: job.files,
          suggestions: job.suggestions,
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
      const body = req.body as
        | { audioBase64?: string; mimeType?: string; language?: string }
        | undefined;
      const audioBase64 =
        typeof body?.audioBase64 === 'string' ? body.audioBase64.trim() : '';
      const rawMime =
        typeof body?.mimeType === 'string'
          ? body.mimeType.split(';')[0].trim()
          : '';
      const mimeType = rawMime || 'audio/webm';
      const language =
        typeof body?.language === 'string' ? body.language.trim() : '';

      if (!audioBase64) {
        res.status(400).json({ error: 'Audio data is required.' });
        return;
      }

      const gemini = createGeminiClient();
      if (!gemini) {
        res.status(503).json({
          error: 'Voice transcription backend is not configured yet.',
        });
        return;
      }

      const langHint = language ? ` Primary language hint: ${language}.` : '';
      const response = await gemini.models.generateContent({
        model: 'gemini-3.5-transcribe',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: audioBase64,
              },
            },
            {
              text: `Transcribe the spoken words accurately with natural punctuation. Output ONLY the transcribed words and nothing else.${langHint}`,
            },
          ],
        },
      });

      const text = (response.text ?? '').trim();
      res.json({ text });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to transcribe audio.';
      res.status(502).json({ error: message });
    }
  });

  app.get('/api/models', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const referer = getAppBaseUrl(req);
    try {
      const forceRefresh = req.query.refresh === '1';
      const result = await fetchAllGatewayModels(referer, forceRefresh);

      res.json({
        models: result.models,
        gateways: result.gateways,
        groqConfigured: result.groqConfigured,
        openRouterConfigured: result.openRouterConfigured,
        huggingFaceConfigured: result.huggingFaceConfigured,
        ngrokConfigured: result.ngrokConfigured,
        pollinationsConfigured: result.pollinationsConfigured,
        geminiConfigured: result.geminiConfigured,
        freeOnly: !result.huggingFaceConfigured && !result.ngrokConfigured,
        keyStatus: result.keyStatus,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to load AI gateway models.';
      const fallbackModels = [
        ARCHITECT_PUBLIC_MODEL,
        ...POLLINATIONS_FALLBACK_MODELS.filter((m) => m.category !== 'code'),
      ];
      res.status(200).json({
        models: fallbackModels,
        groqConfigured: Boolean(getGroqApiKey()),
        openRouterConfigured: Boolean(getOpenRouterApiKey()),
        huggingFaceConfigured: Boolean(getHuggingFaceApiKey()),
        ngrokConfigured: Boolean(getNgrokApiKey()),
        pollinationsConfigured: true,
        geminiConfigured: Boolean(getGeminiApiKey()),
        freeOnly: true,
        error: fallbackModels.length > 0 ? undefined : message,
      });
    }
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
        }
      }

      const body = (req.body || {}) as {
        message?: string;
        mode?: string;
        previousHtml?: string;
        history?: Array<{ role: string; text: string }>;
        webSearchEnabled?: boolean;
        assemble?: boolean;
        attachmentName?: string | null;
        attachmentDataUrl?: string | null;
        attachmentMimeType?: string | null;
        attachmentText?: string | null;
        clientTime?: string;
        clientTimeZone?: string;
      };

      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) {
        res.status(400).json({ error: 'Prompt message is required.' });
        return;
      }

      const mode = body.mode === 'web' ? 'web' : 'mobile';
      const webSearchEnabled = body.webSearchEnabled !== false;
      const shouldAssemble = body.assemble !== false;

      const searchData = webSearchEnabled
        ? await runLiveBrowserSearch(buildFocusedSearchQuery(message))
        : { query: '', results: [], images: [] };
      const webSearchContext = formatWebSearchContext(searchData);

      const timeContext = [
        body.clientTime ? `User local date/time: ${body.clientTime}` : '',
        body.clientTimeZone ? `User timezone: ${body.clientTimeZone}` : '',
        `Server UTC date/time: ${new Date().toUTCString()}`,
      ]
        .filter(Boolean)
        .join(' | ');

      const classification = await routeMessageWithGemini({
        message,
        mode,
        history: Array.isArray(body.history) ? body.history : [],
        previousHtml: typeof body.previousHtml === 'string' ? body.previousHtml : '',
        attachmentName: body.attachmentName ?? null,
        attachmentDataUrl: body.attachmentDataUrl ?? null,
        attachmentMimeType: body.attachmentMimeType ?? null,
        attachmentText: body.attachmentText ?? null,
        webSearchContext,
        timeContext,
      });

      const isBuildIntent =
        classification.intent === 'build_app' || classification.intent === 'edit_app';
      const assembled =
        shouldAssemble && isBuildIntent
          ? assembleModularInterface({
              route: classification,
              previousHtml: typeof body.previousHtml === 'string' ? body.previousHtml : '',
              mode,
              searchData,
            })
          : null;

      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        router: classification.modelUsed,
        intent: classification.intent,
        appTitle: classification.appTitle,
        brandTagline: classification.brandTagline,
        summary: classification.replyMessage,
        primaryColor: classification.primaryColor,
        surfaceTheme: classification.surfaceTheme,
        componentIds: assembled?.manifest.componentIds ?? classification.componentIds,
        featureIds: assembled?.manifest.featureIds ?? classification.featureIds,
        addComponentIds: classification.addComponentIds,
        removeComponentIds: classification.removeComponentIds,
        customTabs: assembled?.manifest.customTabs ?? classification.customTabs,
        dataTables: assembled?.dbTables ?? classification.dataTables,
        planSteps: classification.planSteps,
        followUpSuggestions: classification.followUpSuggestions,
        mediaPrompt:
          classification.intent === 'generate_image' ||
          classification.intent === 'generate_music' ||
          classification.intent === 'generate_video'
            ? classification.mediaPrompt
            : undefined,
        ...(assembled
          ? {
              assembledModules: assembled.steps,
              previewHtml: assembled.html,
            }
          : {}),
      });
    } catch (err) {
      if (err instanceof GeminiRouterError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      const message =
        err instanceof Error ? err.message : 'Unable to route message through Gemini.';
      res.status(502).json({ error: message });
    }
  });

  app.post('/api/craft/stream', async (req, res) => {
    req.setTimeout?.(0);
    res.setTimeout?.(0);

    const body = req.body as {
      message?: string;
      mode?: string;
      model?: string;
      gateway?: string;
      clientTime?: string;
      clientTimeZone?: string;
      previousHtml?: string;
      history?: Array<{ role: string; text: string }>;
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
      };
    };

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
          const currentBilling = await reconcileAndLoadBillingState({
            user: auth.user,
            accessToken: auth.accessToken,
            refreshToken: auth.refreshToken,
            checkPaystack: false,
          });
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
    const effectiveCreditBudget =
      serverCreditBudget !== null ? serverCreditBudget : clientCreditsHint;
    if (
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
    }, 3000);

    // Keep AI generation running to completion even if the user closes/leaves the app
    const clientAbort = new AbortController();
    res.on('close', () => {
      clearInterval(keepAlive);
      job.subscribers.delete(res);
    });

    const groqKey = getGroqApiKey();
    const openRouterKey = getOpenRouterApiKey();
    const huggingFaceKey = getHuggingFaceApiKey();
    const ngrokKey = getNgrokApiKey();
    const geminiClients = createGeminiClientPool();

    try {
      const timeContext = [
        clientTime ? `User local date/time: ${clientTime}` : '',
        clientTimeZone ? `User timezone: ${clientTimeZone}` : '',
        `Server UTC date/time: ${new Date().toUTCString()}`,
      ]
        .filter(Boolean)
        .join(' | ');

      sendEvent({
        type: 'phase',
        phase: 'understanding',
        kind: 'chat',
        label: 'Routing intent & classifying modules via Gemini...',
      });

      sendEvent({
        type: 'meta',
        kind: 'chat',
        modelId: 'google/gemini-4-hydrogen',
        modelName: 'Gemini Intent Router',
        provider: 'google',
        gateway: 'gemini',
        isFallback: false,
      });

      const executionPlan = buildGatewayExecutionPlan({
        requestedModel,
        requestedGateway,
        openRouterCatalog: cachedModels,
        huggingFaceCatalog: cachedHfModels,
        ngrokCatalog: cachedNgrokModels,
        groqCatalog: cachedGroqModels,
        pollinationsCatalog:
          cachedPollinationsModels.length > 0
            ? cachedPollinationsModels
            : POLLINATIONS_FALLBACK_MODELS,
      });
      const requestedMediaKind = executionPlan.requestedMediaKind;

      const searchData = webSearchEnabled
        ? await runLiveBrowserSearch(buildFocusedSearchQuery(message))
        : { query: '', results: [], images: [] };
      const webSearchContext = formatWebSearchContext(searchData);

      // Route all incoming user messages directly through Gemini API key as intent router & module classifier
      const classification = await routeMessageWithGemini({
        message,
        mode,
        requestedMediaKind,
        history,
        previousHtml,
        attachmentName: options.attachmentName ?? null,
        attachmentDataUrl,
        attachmentMimeType,
        attachmentText,
        webSearchContext,
        timeContext,
      });

      const shouldGenerateTitle = history.length === 0 || Boolean(options.needsTitle);
      if (shouldGenerateTitle && classification.appTitle) {
        sendEvent({ type: 'title', title: classification.appTitle });
      }

      sendEvent({
        type: 'route',
        intent: classification.intent,
        componentIds: classification.componentIds,
        featureIds: classification.featureIds,
        addComponentIds: classification.addComponentIds,
        removeComponentIds: classification.removeComponentIds,
      });

      const effectiveIntent =
        requestedMediaKind !== null && classification.intent !== 'chat'
          ? (`generate_${requestedMediaKind}` as const)
          : options.forceChat
            ? ('chat' as const)
            : classification.intent;

      clearInterval(keepAlive);

      if (
        effectiveIntent === 'generate_image' ||
        effectiveIntent === 'generate_music' ||
        effectiveIntent === 'generate_video'
      ) {
        const mediaKind =
          effectiveIntent === 'generate_music'
            ? 'music'
            : effectiveIntent === 'generate_video'
              ? 'video'
              : 'image';

        sendEvent({
          type: 'phase',
          phase: 'building',
          kind: 'media',
          label:
            mediaKind === 'video'
              ? 'Generating video...'
              : mediaKind === 'music'
                ? 'Composing music...'
                : 'Generating image...',
        });

        const mediaResult: GeneratedMediaResult = await generateMediaAsset({
          kind: mediaKind,
          prompt: classification.mediaPrompt || message,
          requestedModel,
        });

        sendEvent({ type: 'media', media: mediaResult });
        sendEvent({
          type: 'done',
          kind: 'media',
          title: shouldGenerateTitle ? classification.appTitle : undefined,
          fullText:
            classification.replyMessage ||
            `Generated your ${mediaKind}: "${(classification.mediaPrompt || message).slice(0, 120)}"`,
          previewHtml: '',
          allFiles: [],
          suggestions: [],
          dbTables: [],
          classifiedIntent: effectiveIntent,
          classifiedModules: classification.componentIds,
          classifiedFeatures: classification.featureIds,
          bytesBuilt: 0,
          creditsUsed: 0,
          billing: initialBillingSummary,
          media: mediaResult,
          modelUsed: mediaResult.modelId || 'google/gemini-4-hydrogen',
          modelName: executionPlan.requestedModelLabel || 'Gemini Intent Router',
          provider: mediaResult.gateway,
          startedAt: job.startedAt,
        });
        return;
      }

      if (effectiveIntent === 'chat') {
        sendEvent({ type: 'delta', text: classification.replyMessage });
        sendEvent({
          type: 'done',
          kind: 'chat',
          title: shouldGenerateTitle ? classification.appTitle : undefined,
          fullText: classification.replyMessage,
          previewHtml: '',
          allFiles: [],
          suggestions: classification.followUpSuggestions,
          dbTables: [],
          classifiedIntent: effectiveIntent,
          classifiedModules: classification.componentIds,
          classifiedFeatures: classification.featureIds,
          bytesBuilt: 0,
          creditsUsed: 0,
          billing: initialBillingSummary,
          modelUsed: classification.modelUsed,
          modelName: 'Gemini Intent Router',
          provider: 'google',
          startedAt: job.startedAt,
        });
        return;
      }

      const emittedSteps: string[] = [];
      for (const step of classification.planSteps) {
        emittedSteps.push(step);
        sendEvent({
          type: 'plan',
          step,
          allSteps: [...emittedSteps],
        });
        await new Promise((r) => setTimeout(r, 45));
      }

      const assembled = assembleModularInterface({
        route: classification,
        previousHtml,
        mode,
        searchData,
      });

      sendEvent({
        type: 'route',
        intent: effectiveIntent,
        componentIds: assembled.manifest.componentIds,
        featureIds: assembled.manifest.featureIds,
        addComponentIds: classification.addComponentIds,
        removeComponentIds: classification.removeComponentIds,
      });

      if (assembled.dbTables.length > 0) {
        sendEvent({ type: 'schema', tables: assembled.dbTables });
      }

      sendEvent({
        type: 'phase',
        phase: 'building',
        kind: 'build',
        label: 'Assembling classified modules locally...',
      });

      const builtPaths: string[] = [];
      const totalSteps = Math.max(1, assembled.steps.length);
      for (let idx = 0; idx < assembled.steps.length; idx += 1) {
        const step = assembled.steps[idx];
        builtPaths.push(step.path);
        const partialBytes = Math.round(
          (assembled.html.length * (idx + 1)) / totalSteps
        );
        sendEvent({
          type: 'file',
          action: step.action,
          path: step.path,
          allFiles: [...builtPaths],
          bytesBuilt: partialBytes,
        });
        await new Promise((r) => setTimeout(r, 55));
      }

      const rawCreditsUsed = Math.max(
        1,
        calculateBuildCreditsForBytes(assembled.html.length, {
          filesCount: builtPaths.length,
          dbTablesCount: assembled.dbTables.length,
        })
      );
      const finalCreditsUsed =
        effectiveCreditBudget !== null
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

      const suggestions =
        classification.followUpSuggestions.length > 0
          ? classification.followUpSuggestions
          : buildSmartFollowUpSuggestions(message, assembled.html, mode);

      sendEvent({
        type: 'done',
        kind: 'build',
        title: shouldGenerateTitle ? assembled.manifest.appTitle : undefined,
        logo: assembled.logoDirective,
        fullText: classification.replyMessage,
        previewHtml: assembled.html,
        allFiles: builtPaths,
        suggestions,
        dbTables: assembled.dbTables,
        classifiedIntent: effectiveIntent,
        classifiedModules: assembled.manifest.componentIds,
        classifiedFeatures: assembled.manifest.featureIds,
        bytesBuilt: assembled.html.length,
        creditsUsed: finalCreditsUsed,
        billing: updatedBilling,
        modelUsed: classification.modelUsed,
        modelName: 'Gemini Intent Router',
        provider: 'google',
        startedAt: job.startedAt,
      });
    } catch (err) {
      clearInterval(keepAlive);
      const errorMessage =
        err instanceof GeminiRouterError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Unable to reach Gemini router right now.';
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
