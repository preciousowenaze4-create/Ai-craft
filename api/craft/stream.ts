import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  END_MARKER,
  HOLDBACK_CHARS,
  type InitialRoute,
  type ParsedDbTable,
  START_MARKER,
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
} from '../_builderCore.js';
import {
  deriveServerSessionTitle,
  extractLogoDirectiveFromRaw,
} from '../_appsStore.js';
import {
  MIN_CHAT_CREDITS_THRESHOLD,
  calculateBuildCreditsForBytes,
  commitGenerationCredits,
  getCreditExhaustionInfo,
  verifyUserCanGenerate,
} from '../_billing.js';
import { authenticateRequestForModeration } from '../_moderation.js';
import { appendClearAuthCookies } from '../_supabaseAuth.js';
import {
  buildCandidateCooldownKey,
  buildGatewayExecutionPlan,
  fetchGroqCatalog,
  fetchHuggingFaceCatalog,
  fetchNgrokCatalog,
  fetchPollinationsCatalog,
  getGroqApiKey,
  getHuggingFaceApiKey,
  getNgrokApiKey,
  isGatewayCandidateCoolingDown,
  markGatewayCandidateCooldown,
  POLLINATIONS_FALLBACK_MODELS,
  type AiGatewayId,
  type GatewayExecutionCandidate,
  type UnifiedAiModel,
} from '../_aiGateways.js';
import {
  generateMediaAsset,
  type GeneratedMediaResult,
} from '../_mediaService.js';
import {
  fetchFreeOpenRouterCatalog,
  getGeminiApiKeyPool,
  getOpenRouterApiKey,
  resolveFreeModelInfo as resolveModelInfo,
  type NormalizedOpenRouterModel,
} from '../_openrouterModels.js';

class GatewayApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GatewayApiError';
    this.status = status;
  }
}

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

async function fetchFreeOpenRouterFallbacks(
  apiKey: string,
  referer: string
): Promise<NormalizedOpenRouterModel[]> {
  try {
    return await fetchFreeOpenRouterCatalog(apiKey, referer);
  } catch {
    return [];
  }
}

type OpenRouterContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type OpenRouterMessageContent = string | OpenRouterContentPart[];

interface OpenRouterChatMessage {
  role: 'user' | 'assistant';
  content: OpenRouterMessageContent;
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
  referer: string,
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
    headers['HTTP-Referer'] = referer;
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

    // Extend watchdog once headers arrive; allow 22s per chunk gap
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

        // Handle gateways (like Pollinations) that occasionally concatenate multiple `data:` frames without newlines
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

    // Flush any final complete frame left in buffer if upstream closed without trailing newline
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

export async function POST(request: Request): Promise<Response> {
  const reqUrl = new URL(request.url);
  const referer = process.env.APP_URL || `${reqUrl.protocol}//${reqUrl.host}`;

  let body: {
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
    };
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON request body.' }, { status: 400 });
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  const mode = body?.mode === 'web' ? 'web' : 'mobile';
  const requestedModel = typeof body?.model === 'string' ? body.model.trim() : '';
  const requestedGateway =
    typeof body?.gateway === 'string' ? body.gateway.trim() : '';
  const clientTime = typeof body?.clientTime === 'string' ? body.clientTime.trim() : '';
  const clientTimeZone =
    typeof body?.clientTimeZone === 'string' ? body.clientTimeZone.trim() : '';
  const previousHtml = typeof body?.previousHtml === 'string' ? body.previousHtml : '';
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
    return Response.json({ error: 'Prompt message is required.' }, { status: 400 });
  }

  const modCheck = await authenticateRequestForModeration(request);
  if (modCheck.flags?.banned) {
    const headers = new Headers();
    appendClearAuthCookies(headers);
    return Response.json(
      {
        error: 'This account has been suspended by the app owner.',
        code: 'ACCOUNT_BANNED',
        banned: true,
      },
      { status: 403, headers }
    );
  }
  if (modCheck.flags?.restricted) {
    return Response.json(
      {
        error: 'Your account is currently restricted from building or chatting.',
        code: 'ACCOUNT_RESTRICTED',
        restricted: true,
      },
      { status: 403 }
    );
  }

  const creditCheck = await verifyUserCanGenerate(request);
  if (!creditCheck.allowed) {
    return Response.json(
      {
        error: creditCheck.error,
        code: creditCheck.code,
        billing: creditCheck.billing,
      },
      { status: creditCheck.status }
    );
  }
  const effectiveCreditBudget =
    creditCheck.creditBudget !== null ? creditCheck.creditBudget : clientCreditsHint;
  if (
    creditCheck.creditBudget === null &&
    clientCreditsHint !== null &&
    clientCreditsHint <= MIN_CHAT_CREDITS_THRESHOLD
  ) {
    return Response.json(
      {
        error: `You have ${clientCreditsHint.toLocaleString()} tokens remaining (minimum ${MIN_CHAT_CREDITS_THRESHOLD + 1} tokens required to chat or build). Top up or upgrade a plan to continue.`,
        code: 'LOW_CREDITS_THRESHOLD',
      },
      { status: 402 }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const enqueueRaw = (raw: string) => {
        if (!closed) {
          controller.enqueue(encoder.encode(raw));
        }
      };

      const sendEvent = (payload: Record<string, unknown>) => {
        enqueueRaw(`data: ${JSON.stringify(payload)}\n\n`);
      };

      enqueueRaw(': connected\n\n');

      const keepAlive = setInterval(() => {
        enqueueRaw(': ping\n\n');
      }, 3000);

      const closeStream = () => {
        clearInterval(keepAlive);
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      try {
        const groqKey = getGroqApiKey();
        const openRouterKey = getOpenRouterApiKey();
        const huggingFaceKey = getHuggingFaceApiKey();
        const ngrokKey = getNgrokApiKey();
        const geminiClients = createGeminiClientPool();

        // Always begin in normal Thinking mode — never jump straight to Building
        sendEvent({
          type: 'phase',
          phase: 'understanding',
          kind: 'chat',
          label: 'Thinking...',
        });

        const [orList, hfList, ngrokList, groqList, polList] = await Promise.all([
          openRouterKey
            ? fetchFreeOpenRouterFallbacks(openRouterKey, referer)
            : Promise.resolve([]),
          huggingFaceKey
            ? fetchHuggingFaceCatalog(huggingFaceKey).catch(() => [])
            : Promise.resolve([]),
          ngrokKey
            ? fetchNgrokCatalog(ngrokKey).catch(() => [])
            : Promise.resolve([]),
          groqKey
            ? fetchGroqCatalog(groqKey).catch(() => [])
            : Promise.resolve([]),
          fetchPollinationsCatalog().catch(() => [...POLLINATIONS_FALLBACK_MODELS]),
        ]);
        const catalog: NormalizedOpenRouterModel[] = orList;
        const hfCatalog: UnifiedAiModel[] = hfList;
        const ngrokCatalog: UnifiedAiModel[] = ngrokList;
        const groqCatalog: UnifiedAiModel[] = groqList;
        const polCatalog: UnifiedAiModel[] = polList;

        const executionPlan = buildGatewayExecutionPlan({
          requestedModel,
          requestedGateway,
          openRouterCatalog: catalog,
          huggingFaceCatalog: hfCatalog,
          ngrokCatalog,
          groqCatalog,
          pollinationsCatalog: polCatalog,
        });

        const mediaKind = executionPlan.requestedMediaKind;

        const initialRoute: InitialRoute =
          mediaKind !== null
            ? 'chat'
            : options.forceChat
              ? 'chat'
              : classifyInitialRoute(
                  message,
                  previousHtml,
                  options.attachmentName,
                  Boolean(attachmentDataUrl || attachmentText)
                );

        const now = new Date();
        const timeContext = [
          clientTime ? `User local date/time: ${clientTime}` : '',
          clientTimeZone ? `User timezone: ${clientTimeZone}` : '',
          `Server UTC date/time: ${now.toUTCString()}`,
        ]
          .filter(Boolean)
          .join(' | ');

        let webSearchContext = '';
        if (
          mediaKind === null &&
          webSearchEnabled &&
          (initialRoute !== 'chat' ||
            shouldRunChatSearch(message, previousHtml.trim().length > 0))
        ) {
          const searchData = await runLiveBrowserSearch(message);
          webSearchContext = formatWebSearchContext(searchData);
        }

        const activeFlags: string[] = [];
        if (mode === 'web' && options.reactEnabled) activeFlags.push('React UI');
        if (options.backendEnabled) activeFlags.push('Backend database & API');
        if (webSearchEnabled) activeFlags.push('Live browser web search');
        if (options.attachmentName) {
          activeFlags.push(`Attached reference: ${options.attachmentName}`);
        }
        if (secretKeys.length > 0) {
          activeFlags.push(`Project secrets keys configured: ${secretKeys.join(', ')}`);
        }
        if (databaseTables.length > 0) {
          activeFlags.push(`Existing project database tables: ${databaseTables.join('; ')}`);
        }

        const projectInfraContext = buildProjectInfraContext({
          secretHints,
          secretKeys,
          databaseTables,
        });

        const previewSummary = extractPreviewStructureSummary(previousHtml);

        const shouldGenerateTitle =
          history.length === 0 || Boolean((options as { needsTitle?: boolean }).needsTitle);

        const systemInstruction = buildCraftSystemPrompt({
          mediaKind,
          requestedModel,
          requestedModelLabel: executionPlan.requestedModelLabel,
          initialRoute,
          shouldGenerateTitle,
          timeContext,
          projectInfraContext,
          webSearchContext,
          previewSummary,
          mode,
          activeFlags,
        });

        const conversationMessages: OpenRouterChatMessage[] = history
          .slice(-8)
          .filter((item) => typeof item?.text === 'string' && item.text.trim().length > 0)
          .map((item) => ({
            role: item.role === 'user' ? 'user' : 'assistant',
            content: item.text,
          }));

        const userTextParts: string[] = [];
        if (previousHtml && initialRoute !== 'chat') {
          userTextParts.push(
            `Existing Preview app HTML (for context or surgical updates if building/editing):\n${previousHtml.slice(0, 28000)}`
          );
        } else if (previousHtml && initialRoute === 'chat') {
          userTextParts.push(
            `Current Preview app summary (user is chatting/asking a question):\n${previewSummary}`
          );
        }
        if (attachmentText) {
          userTextParts.push(
            `Attached reference text (${options.attachmentName || 'file'}):\n${attachmentText}`
          );
        } else if (attachmentDataUrl) {
          userTextParts.push(
            `The user attached a visual screenshot (${options.attachmentName || 'screenshot.jpg'}). Inspect what is shown carefully against the Live Preview app.`
          );
        }
        userTextParts.push(`User request:\n${message}`);
        const currentUserText = userTextParts.join('\n\n');

        const currentUserContent: OpenRouterMessageContent = attachmentDataUrl
          ? [
              { type: 'text', text: currentUserText },
              { type: 'image_url', image_url: { url: attachmentDataUrl } },
            ]
          : currentUserText;

        conversationMessages.push({ role: 'user', content: currentUserContent });

        let fullRaw = '';
        let headerBuffer = '';
        let headerResolved = initialRoute !== 'auto';
        let resolvedKind: 'chat' | 'build' =
          initialRoute === 'build' ? 'build' : 'chat';
        let emittedBuildPhase = false;
        let emittedProseLength = 0;
        let reachedHtml = false;
        let htmlStartIndex = -1;
        let emittedFiles: string[] = [];
        let emittedPlanSteps: string[] = [];
        let emittedDbSignature = '';
        let emittedDbTables: ParsedDbTable[] = [];
        let emittedTitle = '';
        let lastProgressSentAt = 0;
        let buildCreditsEmitted = 0;
        let lastCreditEmitAt = 0;
        let creditsCommitted = false;
        let modelUsed = '';
        let noticedReasoning = false;
        let pausedDueToCredits = false;
        let pausedDueToStreamLimit = false;
        const generationAbort = new AbortController();
        const forwardRequestAbort = () => {
          if (!generationAbort.signal.aborted) {
            generationAbort.abort();
          }
        };
        if (request.signal.aborted) {
          forwardRequestAbort();
        } else {
          request.signal.addEventListener('abort', forwardRequestAbort, { once: true });
        }

        // Graceful 48s Vercel timeout guard so partial builds flush cleanly instead of dropping socket mid-stream
        const serverlessBudgetTimer = setTimeout(() => {
          if (pausedDueToCredits || pausedDueToStreamLimit) return;
          pausedDueToStreamLimit = true;
          if (!generationAbort.signal.aborted) {
            generationAbort.abort();
          }
        }, 48_000);

        const triggerCreditPause = () => {
          if (pausedDueToCredits) return;
          pausedDueToCredits = true;
          if (!generationAbort.signal.aborted) {
            generationAbort.abort();
          }
        };

        const resetStreamParser = () => {
          if (
            emittedProseLength > 0 ||
            emittedFiles.length > 0 ||
            emittedPlanSteps.length > 0 ||
            emittedDbTables.length > 0 ||
            emittedBuildPhase ||
            buildCreditsEmitted > 0
          ) {
            sendEvent({ type: 'reset' });
          }
          fullRaw = '';
          headerBuffer = '';
          headerResolved = initialRoute !== 'auto';
          resolvedKind = initialRoute === 'build' ? 'build' : 'chat';
          emittedBuildPhase = false;
          emittedProseLength = 0;
          reachedHtml = false;
          htmlStartIndex = -1;
          emittedFiles = [];
          emittedPlanSteps = [];
          emittedDbSignature = '';
          emittedDbTables = [];
          emittedTitle = '';
          lastProgressSentAt = 0;
          buildCreditsEmitted = 0;
          lastCreditEmitAt = 0;
          noticedReasoning = false;
        };

        const syncLivePlanSteps = (rawSoFar: string) => {
          if (shouldGenerateTitle && !emittedTitle) {
            const parsedTitle = extractSessionTitleFromRaw(rawSoFar);
            if (parsedTitle) {
              emittedTitle = parsedTitle;
              sendEvent({ type: 'title', title: parsedTitle });
            }
          }

          const steps = extractPlanStepsFromRaw(rawSoFar);
          for (const step of steps) {
            if (!emittedPlanSteps.includes(step)) {
              emittedPlanSteps.push(step);
              if (!emittedBuildPhase) {
                sendEvent({
                  type: 'phase',
                  phase: 'understanding',
                  kind: resolvedKind,
                  label: 'Planning architecture & design...',
                });
              }
              sendEvent({
                type: 'plan',
                step,
                allSteps: [...emittedPlanSteps],
              });
            }
          }

          const dbTables = extractDbSchemaFromRaw(rawSoFar);
          if (dbTables.length > 0) {
            const sig = JSON.stringify(dbTables);
            if (sig !== emittedDbSignature) {
              emittedDbSignature = sig;
              emittedDbTables = dbTables;
              sendEvent({
                type: 'schema',
                tables: dbTables,
              });
            }
          }
        };

        const promoteToBuildPhase = () => {
          resolvedKind = 'build';
          if (effectiveCreditBudget !== null && effectiveCreditBudget <= 0) {
            triggerCreditPause();
            return;
          }
          if (!emittedBuildPhase) {
            emittedBuildPhase = true;
            sendEvent({
              type: 'phase',
              phase: 'building',
              kind: 'build',
              label: 'Building live app...',
            });
          }
        };

        const syncLiveBuildArtifacts = (htmlSoFar: string) => {
          const cleanHtml = htmlSoFar.split(END_MARKER)[0] ?? htmlSoFar;
          const artifacts = extractLiveBuildArtifacts(cleanHtml);
          let emittedNewFile = false;

          for (const art of artifacts) {
            if (!emittedFiles.includes(art.path)) {
              emittedFiles.push(art.path);
              emittedNewFile = true;
              sendEvent({
                type: 'file',
                action: art.action,
                path: art.path,
                allFiles: [...emittedFiles],
                bytesBuilt: cleanHtml.length,
              });
            }
          }

          const nowMs = Date.now();
          if (!emittedNewFile && nowMs - lastProgressSentAt >= 220) {
            lastProgressSentAt = nowMs;
            sendEvent({
              type: 'progress',
              bytesBuilt: cleanHtml.length,
            });
          }

          const targetCredits = calculateBuildCreditsForBytes(cleanHtml.length, {
            filesCount: emittedFiles.length,
            dbTablesCount: emittedDbTables.length,
          });
          const cappedTargetCredits =
            effectiveCreditBudget !== null
              ? Math.min(targetCredits, effectiveCreditBudget)
              : targetCredits;
          buildCreditsEmitted = Math.max(buildCreditsEmitted, cappedTargetCredits);
        };

        const emitCleanProseRange = (upToIndex: number) => {
          if (upToIndex <= emittedProseLength) return;
          const rawSlice = fullRaw.slice(emittedProseLength, upToIndex);
          if (!rawSlice || fullRaw.slice(0, upToIndex).includes('```')) return;
          const cleanDelta = stripTagMarkers(rawSlice)
            .replace(/<<<[\s\S]*/g, '')
            .replace(/```[\s\S]*/g, '')
            .replace(/^\s*(?:PART\s*[123]\s*[:\-–]?)\s*/gim, '');
          if (cleanDelta) {
            sendEvent({ type: 'delta', text: cleanDelta });
          }
          emittedProseLength = upToIndex;
        };

        const safeProseTailEnd = (): number => {
          const baseSafeEnd = Math.max(
            emittedProseLength,
            fullRaw.length - Math.max(HOLDBACK_CHARS, 72)
          );
          const pendingChunk = fullRaw.slice(emittedProseLength, baseSafeEnd);
          const unclosedBracketOffset = pendingChunk.lastIndexOf('[[');
          if (
            unclosedBracketOffset !== -1 &&
            !pendingChunk.slice(unclosedBracketOffset).includes(']]')
          ) {
            return emittedProseLength + unclosedBracketOffset;
          }
          return baseSafeEnd;
        };

        const processBodyChunk = (bodyChunk: string) => {
          if (!bodyChunk) return;
          fullRaw += bodyChunk;

          if (!reachedHtml) {
            syncLivePlanSteps(fullRaw);
          }

          if (resolvedKind === 'chat') {
            if (initialRoute === 'chat') {
              const trimmedStart = fullRaw.trimStart();
              if (
                emittedProseLength === 0 &&
                (trimmedStart.length === 0 || trimmedStart.startsWith('['))
              ) {
                const titleDone = /\[\[\s*TITLE\s*:[^\]]+\]\]/i.test(fullRaw);
                const notTag =
                  trimmedStart.length >= 2 && !trimmedStart.startsWith('[[');
                if (titleDone || notTag || fullRaw.length > 90) {
                  emitCleanProseRange(fullRaw.length);
                }
                return;
              }
              emitCleanProseRange(fullRaw.length);
              return;
            }

            const codeStart = findCodeStart(fullRaw);
            if (codeStart) {
              emitCleanProseRange(codeStart.markerIdx);
              reachedHtml = true;
              htmlStartIndex = codeStart.htmlOffset;
              promoteToBuildPhase();
              syncLiveBuildArtifacts(fullRaw.slice(htmlStartIndex));
            } else {
              emitCleanProseRange(safeProseTailEnd());
            }
            return;
          }

          if (!reachedHtml) {
            const codeStart = findCodeStart(fullRaw);
            if (codeStart) {
              emitCleanProseRange(codeStart.markerIdx);
              reachedHtml = true;
              htmlStartIndex = codeStart.htmlOffset;
              promoteToBuildPhase();
              syncLiveBuildArtifacts(fullRaw.slice(htmlStartIndex));
            } else {
              emitCleanProseRange(safeProseTailEnd());
            }
          } else if (htmlStartIndex !== -1) {
            syncLiveBuildArtifacts(fullRaw.slice(htmlStartIndex));
          }
        };

        const handleTextChunk = (text: string) => {
          if (!text) return;

          if (!headerResolved) {
            headerBuffer += text;
            // Strip any leading <think>...</think> reasoning block emitted by models before checking header intent
            const cleanedHeader = stripReasoningTags(headerBuffer);
            if (/^\s*<(?:think|thought|reasoning)\b/i.test(headerBuffer) && !cleanedHeader) {
              return;
            }
            const inspectHeader = cleanedHeader || headerBuffer;
            const intentMatch =
              /^\s*\[\[\s*INTENT\s*:\s*(CHAT|BUILD)\s*\]\]\s*\n?/i.exec(
                inspectHeader
              );
            if (intentMatch) {
              headerResolved = true;
              resolvedKind =
                intentMatch[1].toUpperCase() === 'BUILD' ? 'build' : 'chat';
              const remainder = inspectHeader.slice(intentMatch[0].length);
              headerBuffer = '';
              if (remainder) {
                processBodyChunk(remainder);
              }
              return;
            }

            const trimmedStart = inspectHeader.trimStart();
            const couldStillBeTag =
              trimmedStart.length === 0 ||
              ('[['.startsWith(trimmedStart) ||
                (trimmedStart.startsWith('[') &&
                  inspectHeader.length < 36 &&
                  !trimmedStart.includes('\n')));

            if (!couldStillBeTag) {
              headerResolved = true;
              resolvedKind = findCodeStart(inspectHeader) ? 'build' : 'chat';
              headerBuffer = '';
              processBodyChunk(inspectHeader);
            }
            return;
          }

          processBodyChunk(text);
        };

        const flushPendingStreamBuffer = () => {
          if (!headerResolved && headerBuffer) {
            headerResolved = true;
            const cleaned = headerBuffer.replace(
              /^\s*\[\[\s*INTENT\s*:\s*(CHAT|BUILD)\s*\]\]\s*\n?/i,
              (_, kind: string) => {
                resolvedKind = kind.toUpperCase() === 'BUILD' ? 'build' : 'chat';
                return '';
              }
            );
            headerBuffer = '';
            if (cleaned) {
              processBodyChunk(cleaned);
            }
          }
          if (
            resolvedKind === 'chat' &&
            emittedProseLength < fullRaw.length &&
            !findCodeStart(fullRaw)
          ) {
            const tail = stripTagMarkers(fullRaw.slice(emittedProseLength)).trim();
            if (tail) {
              sendEvent({ type: 'delta', text: tail });
              emittedProseLength = fullRaw.length;
            }
          }
        };

        let succeeded = false;
        let lastError: Error | null = null;
        const runtimeSelection: { candidate: GatewayExecutionCandidate | null } = {
          candidate: null,
        };
        let hasAttemptedAnyEngine = false;

        const failedAuthGateways = new Set<AiGatewayId>();

        const runOpenAiPool = async (
          candidates: GatewayExecutionCandidate[],
          isFallbackPhase: boolean
        ) => {
          for (let i = 0; i < candidates.length; i += 1) {
            const candidate = candidates[i];
            if (request.signal.aborted || pausedDueToCredits || pausedDueToStreamLimit) {
              break;
            }
            if (failedAuthGateways.has(candidate.gateway)) continue;

            const isRetryAttempt = hasAttemptedAnyEngine;
            hasAttemptedAnyEngine = true;

            try {
              if (isRetryAttempt) {
                resetStreamParser();
              }

              // When generating via dedicated Image/Music/Video model, keep active branding on that media model
              if (mediaKind === null) {
                sendEvent({
                  type: 'meta',
                  kind: 'chat',
                  modelId: candidate.publicModelId,
                  modelName: candidate.modelName,
                  provider: candidate.provider,
                  gateway: candidate.gateway,
                  isFallback: isFallbackPhase || i > 0,
                });
              }

              if ((isFallbackPhase || i > 0) && mediaKind === null) {
                sendEvent({
                  type: 'phase',
                  phase: 'understanding',
                  kind: 'chat',
                  label: `Routing via ${candidate.modelName}...`,
                });
              }

              await streamOpenRouterCompletion(
                candidate,
                referer,
                systemInstruction,
                conversationMessages,
                handleTextChunk,
                () => {
                  if (!noticedReasoning && !emittedBuildPhase) {
                    noticedReasoning = true;
                    sendEvent({
                      type: 'phase',
                      phase: 'understanding',
                      kind: 'chat',
                      label: 'Thinking...',
                    });
                  }
                },
                generationAbort.signal
              );

              flushPendingStreamBuffer();

              if (pausedDueToCredits || pausedDueToStreamLimit) {
                modelUsed = candidate.publicModelId;
                runtimeSelection.candidate = candidate;
                break;
              }

              if (!fullRaw.trim()) {
                throw new Error(
                  `Model ${candidate.publicModelId} returned an empty response.`
                );
              }

              if (resolvedKind === 'build' && mediaKind === null) {
                const extractedHtml = extractPreviewHtmlFromRaw(fullRaw);
                const validation = validateBuiltAppHtml(extractedHtml);
                if (!validation.valid) {
                  throw new Error(
                    `Model ${candidate.publicModelId} incomplete build: ${validation.reason || 'unusable HTML'}`
                  );
                }
              }

              modelUsed = candidate.publicModelId;
              runtimeSelection.candidate = candidate;
              succeeded = true;
              break;
            } catch (err) {
              if (pausedDueToCredits || pausedDueToStreamLimit) {
                modelUsed = candidate.publicModelId;
                runtimeSelection.candidate = candidate;
                break;
              }
              if (request.signal.aborted) break;
              const errMsg = err instanceof Error ? err.message : String(err);
              const isGenuineInvalidKey =
                err instanceof GatewayApiError &&
                (err.status === 401 || err.status === 403) &&
                /no auth credentials|user not found|invalid api key|unauthorized|authentication failed|invalid token/i.test(
                  errMsg
                ) &&
                !/harness|model|endpoint/i.test(errMsg);

              if (isGenuineInvalidKey) {
                markGatewayCandidateCooldown(candidate.cooldownKey, 120_000);
                failedAuthGateways.add(candidate.gateway);
                const envVarName =
                  candidate.gateway === 'groq'
                    ? 'GROQ_API_KEY'
                    : candidate.gateway === 'huggingface'
                      ? 'HUGGING_FACE_API_KEY'
                      : candidate.gateway === 'ngrok'
                        ? 'NGROK_API_KEY'
                        : 'OPENROUTER_API_KEY';
                lastError = new Error(
                  `${candidate.gatewayLabel} authentication failed (${errMsg}). Please check ${envVarName} in your environment variables.`
                );
                continue;
              }
              if (
                err instanceof GatewayApiError &&
                (err.status === 429 ||
                  err.status === 402 ||
                  err.status === 503 ||
                  err.status === 502 ||
                  err.status === 504)
              ) {
                markGatewayCandidateCooldown(candidate.cooldownKey, 75_000);
              }
              lastError = err instanceof Error ? err : new Error(errMsg);
            }
          }
        };

        const runGeminiPool = async (isFallbackPhase: boolean) => {
          if (geminiClients.length === 0) return;

          const conversationContext = history
            .slice(-6)
            .map((item) => `${item.role === 'user' ? 'User' : 'AI Craft'}: ${item.text}`)
            .join('\n');

          const promptParts: string[] = [];
          if (conversationContext) {
            promptParts.push(`Conversation history:\n${conversationContext}`);
          }
          if (previousHtml && initialRoute !== 'chat') {
            promptParts.push(
              `Existing Preview app HTML (for context or surgical updates if building/editing):\n${previousHtml.slice(0, 28000)}`
            );
          } else if (previousHtml && initialRoute === 'chat') {
            promptParts.push(
              `Current Preview app summary (user is chatting/asking a question):\n${previewSummary}`
            );
          }
          if (attachmentText) {
            promptParts.push(
              `Attached reference text (${options.attachmentName || 'file'}):\n${attachmentText}`
            );
          } else if (attachmentDataUrl) {
            promptParts.push(
              `The user attached a screenshot (${options.attachmentName || 'screenshot.jpg'}). Inspect it visually together with the Live Preview app and apply the exact edits or build requested.`
            );
          }
          promptParts.push(`User request:\n${message}`);
          const fullPrompt = promptParts.join('\n\n');

          let geminiContents:
            | string
            | {
                parts: Array<
                  | { inlineData: { mimeType: string; data: string } }
                  | { text: string }
                >;
              } = fullPrompt;

          if (attachmentDataUrl) {
            const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(
              attachmentDataUrl
            );
            if (match) {
              geminiContents = {
                parts: [
                  {
                    inlineData: {
                      mimeType: attachmentMimeType || match[1],
                      data: match[2],
                    },
                  },
                  { text: fullPrompt },
                ],
              };
            }
          }

          for (let gIdx = 0; gIdx < geminiClients.length; gIdx += 1) {
            const entry = geminiClients[gIdx];
            if (request.signal.aborted || pausedDueToCredits || pausedDueToStreamLimit) {
              break;
            }

            const isRetryAttempt = hasAttemptedAnyEngine;
            hasAttemptedAnyEngine = true;

            try {
              if (isRetryAttempt) {
                resetStreamParser();
              }

              if (mediaKind === null) {
                sendEvent({
                  type: 'meta',
                  kind: 'chat',
                  modelId: 'google/gemini-4-hydrogen',
                  modelName: 'AI Craft Architect · Gemini',
                  provider: 'google',
                  gateway: 'gemini',
                  isFallback: isFallbackPhase || gIdx > 0,
                });
              }

              const runGeminiStream = async (withSearchTool: boolean) =>
                entry.client.models.generateContentStream({
                  model: 'gemini-4-hydrogen',
                  contents: geminiContents,
                  config: {
                    systemInstruction,
                    thinkingConfig: {
                      thinkingLevel:
                        initialRoute === 'chat'
                          ? ThinkingLevel.MEDIUM
                          : ThinkingLevel.HIGH,
                    },
                    ...(withSearchTool ? { tools: [{ googleSearch: {} }] } : {}),
                  },
                });

              let geminiStream;
              try {
                geminiStream = await runGeminiStream(webSearchEnabled);
              } catch (toolErr) {
                if (webSearchEnabled) {
                  geminiStream = await runGeminiStream(false);
                } else {
                  throw toolErr;
                }
              }

              for await (const chunk of geminiStream) {
                if (request.signal.aborted || pausedDueToCredits || pausedDueToStreamLimit) {
                  break;
                }
                if (chunk.text) {
                  handleTextChunk(chunk.text);
                  if (pausedDueToCredits || pausedDueToStreamLimit) break;
                }
              }

              flushPendingStreamBuffer();

              if (pausedDueToCredits || pausedDueToStreamLimit) {
                modelUsed = 'google/gemini-4-hydrogen';
                runtimeSelection.candidate = null;
                break;
              }

              if (!fullRaw.trim()) {
                throw new Error('Gemini returned an empty response.');
              }

              if (resolvedKind === 'build' && mediaKind === null) {
                const extractedHtml = extractPreviewHtmlFromRaw(fullRaw);
                const validation = validateBuiltAppHtml(extractedHtml);
                if (!validation.valid) {
                  throw new Error(
                    `Gemini incomplete build: ${validation.reason || 'unusable HTML'}`
                  );
                }
              }

              modelUsed = 'google/gemini-4-hydrogen';
              runtimeSelection.candidate = null;
              succeeded = true;
              break;
            } catch (err) {
              if (pausedDueToCredits || pausedDueToStreamLimit) {
                modelUsed = 'google/gemini-4-hydrogen';
                runtimeSelection.candidate = null;
                break;
              }
              if (request.signal.aborted) break;
              const errMsg = err instanceof Error ? err.message : String(err);
              if (
                /429|quota|rate.?limit|resource_exhausted|too many requests|exceeded/i.test(
                  errMsg
                )
              ) {
                markGatewayCandidateCooldown(entry.cooldownKey, 75_000);
              } else if (/api key not valid|invalid api key|unauthorized|401|403/i.test(errMsg)) {
                markGatewayCandidateCooldown(entry.cooldownKey, 120_000);
              }
              lastError = err instanceof Error ? err : new Error(errMsg);
            }
          }
        };

        if (executionPlan.preferGeminiFirst) {
          await runGeminiPool(false);
          if (
            !succeeded &&
            !pausedDueToCredits &&
            !pausedDueToStreamLimit &&
            !request.signal.aborted
          ) {
            await runOpenAiPool(executionPlan.keyedOpenAiCandidates, geminiClients.length > 0);
          }
          if (
            !succeeded &&
            !pausedDueToCredits &&
            !pausedDueToStreamLimit &&
            !request.signal.aborted
          ) {
            await runOpenAiPool(executionPlan.pollinationsCandidates, true);
          }
        } else {
          await runOpenAiPool(executionPlan.keyedOpenAiCandidates, false);
          if (
            !succeeded &&
            !pausedDueToCredits &&
            !pausedDueToStreamLimit &&
            !request.signal.aborted
          ) {
            await runGeminiPool(executionPlan.keyedOpenAiCandidates.length > 0);
          }
          if (
            !succeeded &&
            !pausedDueToCredits &&
            !pausedDueToStreamLimit &&
            !request.signal.aborted
          ) {
            await runOpenAiPool(executionPlan.pollinationsCandidates, true);
          }
        }

        clearTimeout(serverlessBudgetTimer);

        if (request.signal.aborted && !pausedDueToCredits && !pausedDueToStreamLimit) {
          if (!creditsCommitted && resolvedKind === 'build' && buildCreditsEmitted > 0) {
            creditsCommitted = true;
            const toCommit =
              effectiveCreditBudget !== null
                ? Math.min(buildCreditsEmitted, effectiveCreditBudget)
                : buildCreditsEmitted;
            await commitGenerationCredits(creditCheck.context, toCommit).catch(() => null);
          }
          closeStream();
          return;
        }

        if (pausedDueToCredits || pausedDueToStreamLimit) {
          const partialHtml = sanitizeAndHardenPreviewHtml(
            finalizePartialPreviewHtml(fullRaw)
          );
          const codeStart = findCodeStart(fullRaw);
          const partialProse = codeStart
            ? sanitizeBuildProse(fullRaw.slice(0, codeStart.markerIdx))
            : sanitizeBuildProse(fullRaw);
          const partialFiles = partialHtml
            ? extractLiveBuildArtifacts(partialHtml).map((a) => a.path)
            : emittedFiles;
          const partialDbTables = mergeParsedDbTables(
            emittedDbTables,
            extractDbSchemaFromRaw(fullRaw),
            extractDbSchemaFromHtml(partialHtml)
          );
          if (partialDbTables.length > 0) {
            sendEvent({ type: 'schema', tables: partialDbTables });
          }

          const creditsToConsume = pausedDueToCredits
            ? effectiveCreditBudget !== null
              ? Math.max(0, effectiveCreditBudget)
              : buildCreditsEmitted
            : Math.min(
                effectiveCreditBudget ?? Number.MAX_SAFE_INTEGER,
                buildCreditsEmitted
              );
          let updatedBilling = creditCheck.billing;
          if (!creditsCommitted && creditsToConsume > 0) {
            creditsCommitted = true;
            updatedBilling =
              (await commitGenerationCredits(creditCheck.context, creditsToConsume).catch(
                () => null
              )) ?? creditCheck.billing;
          }
          const exhaustInfo = pausedDueToStreamLimit
            ? {
                code: 'STREAM_INTERRUPTED' as const,
                error:
                  'Paused near serverless timeout with your build progress safely saved. Tap Continue to finish the rest.',
              }
            : creditCheck.context
              ? getCreditExhaustionInfo({
                  ...creditCheck.context.state,
                  monthlyCreditsRemaining: Math.max(
                    0,
                    updatedBilling?.monthlyCreditsRemaining ??
                      creditCheck.context.state.monthlyCreditsRemaining - creditsToConsume
                  ),
                  dailyCreditsUsed:
                    updatedBilling?.dailyCreditsUsed ??
                    creditCheck.context.state.dailyCreditsUsed + creditsToConsume,
                })
              : {
                  code: 'MONTHLY_LIMIT_REACHED' as const,
                  error:
                    'Your remaining credits reached 0 during building. Building is paused with all progress saved until credits reset or you upgrade.',
                };

          const finalTitle =
            emittedTitle ||
            (shouldGenerateTitle
              ? deriveServerSessionTitle(message, mode, partialHtml)
              : undefined);
          if (finalTitle && finalTitle !== emittedTitle) {
            emittedTitle = finalTitle;
            sendEvent({ type: 'title', title: finalTitle });
          }

          const finalLogo = extractLogoDirectiveFromRaw(fullRaw) ?? undefined;
          const finalInfo = runtimeSelection.candidate
            ? {
                id: runtimeSelection.candidate.publicModelId,
                name: runtimeSelection.candidate.modelName,
                provider: runtimeSelection.candidate.provider,
              }
            : resolveModelInfo(modelUsed || 'openrouter/free', catalog);
          sendEvent({
            type: 'paused',
            reason: exhaustInfo.code,
            message: exhaustInfo.error,
            phaseLabel: pausedDueToStreamLimit ? 'Paused · Ready to continue' : undefined,
            kind: partialHtml || resolvedKind === 'build' ? 'build' : 'chat',
            title: finalTitle,
            logo: finalLogo,
            fullText:
              partialProse ||
              'Build progress was automatically saved. Tap Continue to pick up right where we left off.',
            previewHtml: partialHtml,
            allFiles: partialFiles,
            dbTables: partialDbTables,
            bytesBuilt: partialHtml.length,
            creditsUsed: creditsToConsume,
            billing: updatedBilling,
            modelUsed: finalInfo.id,
            modelName: finalInfo.name,
            provider: finalInfo.provider,
          });
          closeStream();
          return;
        }

        if (!succeeded) {
          throw lastError ?? new Error('Unable to reach AI Craft engine right now.');
        }

        // Dynamic role-aware Image / Music / Video generation (NO web link, NO HTML preview)
        if (mediaKind !== null) {
          const isGenerateMode =
            /\[\[\s*MODE\s*:\s*GENERATE\s*\]\]/i.test(fullRaw) ||
            /\[\[\s*MEDIA_PROMPT\s*:/i.test(fullRaw);
          const mediaPromptMatch = /\[\[\s*MEDIA_PROMPT\s*:\s*([^\]]+?)\s*\]\]/i.exec(
            fullRaw
          );
          const finalTitle =
            emittedTitle ||
            (shouldGenerateTitle
              ? deriveServerSessionTitle(message, mode, '')
              : undefined);
          if (finalTitle && finalTitle !== emittedTitle) {
            emittedTitle = finalTitle;
            sendEvent({ type: 'title', title: finalTitle });
          }

          const cleanReplyText = stripTagMarkers(fullRaw).trim();

          if (isGenerateMode) {
            const generationPrompt = (mediaPromptMatch?.[1] || message).trim();
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
              prompt: generationPrompt,
              requestedModel,
            });

            sendEvent({
              type: 'media',
              media: mediaResult,
            });

            sendEvent({
              type: 'done',
              kind: 'media',
              title: finalTitle,
              fullText:
                cleanReplyText ||
                `Generated your ${mediaKind}: "${generationPrompt.slice(0, 120)}"`,
              previewHtml: '',
              allFiles: [],
              suggestions: [],
              dbTables: [],
              bytesBuilt: 0,
              creditsUsed: 0,
              billing: creditCheck.billing,
              media: mediaResult,
              modelUsed: requestedModel || mediaResult.modelId,
              modelName: executionPlan.requestedModelLabel || mediaResult.modelId,
              provider: mediaResult.gateway,
            });
            closeStream();
            return;
          }

          const finalInfo = runtimeSelection.candidate
            ? {
                id: runtimeSelection.candidate.publicModelId,
                name: runtimeSelection.candidate.modelName,
                provider: runtimeSelection.candidate.provider,
              }
            : resolveModelInfo(modelUsed, catalog);

          sendEvent({
            type: 'done',
            kind: 'chat',
            title: finalTitle,
            fullText: cleanReplyText,
            previewHtml: '',
            allFiles: [],
            suggestions: [],
            dbTables: [],
            bytesBuilt: 0,
            creditsUsed: 0,
            billing: creditCheck.billing,
            modelUsed: requestedModel || finalInfo.id,
            modelName: executionPlan.requestedModelLabel || finalInfo.name,
            provider: finalInfo.provider,
          });
          closeStream();
          return;
        }

        let finalProse = '';
        let previewHtml = '';
        let finalFiles: string[] = [];
        let finalSuggestions: string[] = [];
        let finalDbTables: ParsedDbTable[] = [];

        if (resolvedKind === 'chat') {
          finalProse = stripTagMarkers(fullRaw).trim();
        } else {
          const codeStart = findCodeStart(fullRaw);
          if (codeStart) {
            finalProse = sanitizeBuildProse(fullRaw.slice(0, codeStart.markerIdx));
          } else {
            finalProse = sanitizeBuildProse(fullRaw);
          }

          previewHtml = sanitizeAndHardenPreviewHtml(
            extractPreviewHtmlFromRaw(fullRaw)
          );
          const parsedSuggestions = extractSuggestionsFromRaw(fullRaw);
          finalSuggestions =
            parsedSuggestions.length > 0
              ? parsedSuggestions
              : buildSmartFollowUpSuggestions(message, previewHtml, mode);

          finalDbTables = mergeParsedDbTables(
            emittedDbTables,
            extractDbSchemaFromRaw(fullRaw),
            extractDbSchemaFromHtml(previewHtml)
          );

          if (!finalProse && previewHtml) {
            finalProse =
              'Your real-time app is thoughtfully structured, styled, and ready with monetization built in. Tap Preview to try it live, or pick an upgrade below.';
          }

          if (previewHtml) {
            finalFiles = extractLiveBuildArtifacts(previewHtml).map((a) => a.path);
            sendEvent({
              type: 'file',
              action: 'Built',
              path: finalFiles[0] || 'index.html',
              allFiles: finalFiles,
              bytesBuilt: previewHtml.length,
            });
          }

          if (finalDbTables.length > 0) {
            sendEvent({
              type: 'schema',
              tables: finalDbTables,
            });
          }
        }

        const finalTitle =
          emittedTitle ||
          (shouldGenerateTitle
            ? deriveServerSessionTitle(message, mode, previewHtml)
            : undefined);
        if (finalTitle && finalTitle !== emittedTitle) {
          emittedTitle = finalTitle;
          sendEvent({ type: 'title', title: finalTitle });
        }

        const rawCreditsUsed =
          resolvedKind === 'build' && (previewHtml.length > 0 || finalFiles.length > 0)
            ? Math.max(
                1,
                calculateBuildCreditsForBytes(previewHtml.length, {
                  filesCount: finalFiles.length,
                  dbTablesCount: finalDbTables.length,
                })
              )
            : 0;
        const finalCreditsUsed =
          effectiveCreditBudget !== null
            ? Math.min(rawCreditsUsed, effectiveCreditBudget)
            : rawCreditsUsed;
        let updatedBilling = creditCheck.billing;
        if (finalCreditsUsed > 0 && !creditsCommitted) {
          creditsCommitted = true;
          updatedBilling =
            (await commitGenerationCredits(creditCheck.context, finalCreditsUsed).catch(
              () => null
            )) ?? creditCheck.billing;
        }

        const finalLogo = extractLogoDirectiveFromRaw(fullRaw) ?? undefined;
        const finalInfo = runtimeSelection.candidate
          ? {
              id: runtimeSelection.candidate.publicModelId,
              name: runtimeSelection.candidate.modelName,
              provider: runtimeSelection.candidate.provider,
            }
          : resolveModelInfo(modelUsed, catalog);
        sendEvent({
          type: 'done',
          kind: resolvedKind,
          title: finalTitle,
          logo: finalLogo,
          fullText: finalProse,
          previewHtml,
          allFiles: finalFiles,
          suggestions: finalSuggestions,
          dbTables: finalDbTables,
          bytesBuilt: previewHtml.length,
          creditsUsed: finalCreditsUsed,
          billing: updatedBilling,
          modelUsed: finalInfo.id,
          modelName: finalInfo.name,
          provider: finalInfo.provider,
        });
        closeStream();
      } catch (err) {
        const errorMessage =
          err instanceof Error
            ? err.message
            : 'Unable to reach AI Craft engine right now.';
        sendEvent({
          type: 'error',
          message: errorMessage,
        });
        closeStream();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
