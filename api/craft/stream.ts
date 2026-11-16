import {
  buildFocusedSearchQuery,
  buildSmartFollowUpSuggestions,
  formatWebSearchContext,
  runLiveBrowserSearch,
} from '../_builderCore.js';
import {
  GeminiRouterError,
  routeMessageWithGemini,
} from '../_geminiRouter.js';
import { assembleModularInterface } from '../_moduleAssembler.js';
import {
  MIN_CHAT_CREDITS_THRESHOLD,
  calculateBuildCreditsForBytes,
  commitGenerationCredits,
  verifyUserCanGenerate,
} from '../_billing.js';
import { authenticateRequestForModeration } from '../_moderation.js';
import { appendClearAuthCookies } from '../_supabaseAuth.js';
import { buildGatewayExecutionPlan } from '../_aiGateways.js';
import {
  generateMediaAsset,
  type GeneratedMediaResult,
} from '../_mediaService.js';

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: Request): Promise<Response> {
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
      needsTitle?: boolean;
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
          openRouterCatalog: [],
          huggingFaceCatalog: [],
          ngrokCatalog: [],
          groqCatalog: [],
          pollinationsCatalog: [],
        });
        const requestedMediaKind = executionPlan.requestedMediaKind;

        const searchData = webSearchEnabled
          ? await runLiveBrowserSearch(buildFocusedSearchQuery(message))
          : { query: '', results: [], images: [] };
        const webSearchContext = formatWebSearchContext(searchData);

        const timeContext = [
          clientTime ? `User local date/time: ${clientTime}` : '',
          clientTimeZone ? `User timezone: ${clientTimeZone}` : '',
          `Server UTC date/time: ${new Date().toUTCString()}`,
        ]
          .filter(Boolean)
          .join(' | ');

        // Route every incoming message directly to Gemini API key as intent router & module classifier
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

        const shouldGenerateTitle =
          history.length === 0 || Boolean(options.needsTitle);
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

        // Branch 1: Media Generation (Image / Music / Video)
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
            billing: creditCheck.billing,
            media: mediaResult,
            modelUsed: mediaResult.modelId || 'google/gemini-4-hydrogen',
            modelName: executionPlan.requestedModelLabel || 'Gemini Intent Router',
            provider: mediaResult.gateway,
          });
          closeStream();
          return;
        }

        // Branch 2: Pure Conversational Chat
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
            billing: creditCheck.billing,
            modelUsed: classification.modelUsed,
            modelName: 'Gemini Intent Router',
            provider: 'google',
          });
          closeStream();
          return;
        }

        // Branch 3: Local Modular Interface Assembly (No code from Gemini!)
        const emittedSteps: string[] = [];
        for (const step of classification.planSteps) {
          emittedSteps.push(step);
          sendEvent({
            type: 'plan',
            step,
            allSteps: [...emittedSteps],
          });
          await waitMs(45);
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
          await waitMs(55);
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
        let updatedBilling = creditCheck.billing;
        if (finalCreditsUsed > 0) {
          updatedBilling =
            (await commitGenerationCredits(creditCheck.context, finalCreditsUsed).catch(
              () => null
            )) ?? creditCheck.billing;
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
        });
        closeStream();
      } catch (err) {
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
