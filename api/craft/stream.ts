import {
  extractDbSchemaFromRaw,
  extractLiveBuildArtifacts,
  extractPlanStepsFromRaw,
  extractSessionTitleFromRaw,
  findCodeStart,
  sanitizeBuildProse,
  stripReasoningTags,
} from '../_builderCore.js';
import {
  MIN_CHAT_CREDITS_THRESHOLD,
  calculateBuildCreditsForBytes,
  commitGenerationCredits,
  verifyUserCanGenerate,
} from '../_billing.js';
import { authenticateRequestForModeration } from '../_moderation.js';
import { appendClearAuthCookies } from '../_supabaseAuth.js';
import {
  generateMediaAsset,
  type GeneratedMediaResult,
} from '../_mediaService.js';
import {
  finalizeRealtimeOutput,
  prepareRealtimePrompt,
  streamPollinationsRealTime,
  type VisualHintsSpec,
} from '../_realtimeEngine.js';

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
      visualHints?: VisualHintsSpec | null;
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
  const visualHints = body.visualHints ?? options.visualHints ?? null;
  const attachmentDataUrl =
    typeof options.attachmentDataUrl === 'string' &&
    options.attachmentDataUrl.startsWith('data:image/')
      ? options.attachmentDataUrl
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

  const isOwnerRequest = Boolean(modCheck.isOwner || creditCheck.context?.isOwner);
  const effectiveCreditBudget = isOwnerRequest
    ? null
    : creditCheck.creditBudget !== null
      ? creditCheck.creditBudget
      : clientCreditsHint;
  if (
    !isOwnerRequest &&
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
        const startedAt = Date.now();
        sendEvent({
          type: 'phase',
          phase: 'understanding',
          kind: 'chat',
          label: 'Searching live web & thinking...',
        });

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
          secretKeys: options.secretKeys ?? [],
          secretHints: options.secretHints ?? [],
          databaseTables: options.databaseTables ?? [],
          clientTime,
          clientTimeZone,
          visualHints,
        });

        sendEvent({
          type: 'meta',
          kind: prepared.naturalMediaIntent ? 'media' : 'chat',
          modelId: requestedModel || 'pollinations::openai-fast',
          modelName: prepared.requestedModelLabel || 'Free Browser AI',
          provider: requestedGateway || 'pollinations',
          gateway: requestedGateway || 'pollinations',
          isFallback: false,
        });

        // Direct Media Studio execution
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
            billing: creditCheck.billing,
            media: mediaResult,
            modelUsed: mediaResult.modelId || 'pollinations::sana',
            modelName: prepared.requestedModelLabel || 'Free Browser AI Studio',
            provider: mediaResult.gateway,
          });
          closeStream();
          return;
        }

        // True Real-Time Streaming LLM Generation (Zero Hardcoded Templates!)
        let rawAccumulated = '';
        let emittedTitle = '';
        let emittedPlanCount = 0;
        let emittedDbKey = '';
        let emittedProseLen = 0;
        let enteredCodePhase = false;
        let lastFilesKey = '';
        let lastBytesSent = 0;

        await streamPollinationsRealTime({
          systemPrompt: prepared.systemPrompt,
          historyMessages: prepared.historyMessages,
          userPrompt: prepared.userPrompt,
          onReasoningChunk: () => {
            if (!enteredCodePhase) {
              sendEvent({
                type: 'phase',
                phase: 'understanding',
                kind: 'chat',
                label: 'Planning architecture step by step...',
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
              if (
                filesKey !== lastFilesKey ||
                htmlSoFar.length - lastBytesSent >= 450
              ) {
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
            }
          },
        });

        clearInterval(keepAlive);

        const finalized = finalizeRealtimeOutput({
          rawOutput: rawAccumulated,
          message,
          mode,
          previousHtml,
          modelUsed: requestedModel || 'pollinations::openai-fast',
          modelName: prepared.requestedModelLabel || 'Free Browser AI',
          provider: requestedGateway || 'pollinations',
          startedAt,
        });

        if (finalized.kind === 'chat') {
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
            billing: creditCheck.billing,
            modelUsed: finalized.modelUsed,
            modelName: finalized.modelName,
            provider: finalized.provider,
          });
          closeStream();
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
            billing: creditCheck.billing,
            media: mediaResult,
            modelUsed: mediaResult.modelId || 'pollinations::sana',
            modelName: prepared.requestedModelLabel,
            provider: mediaResult.gateway,
          });
          closeStream();
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

        let updatedBilling = creditCheck.billing;
        if (finalCreditsUsed > 0) {
          updatedBilling =
            (await commitGenerationCredits(creditCheck.context, finalCreditsUsed).catch(
              () => null
            )) ?? creditCheck.billing;
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
        });
        closeStream();
      } catch (err) {
        const errorMessage =
          err instanceof Error
            ? err.message
            : 'Unable to reach free AI engine right now.';
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
