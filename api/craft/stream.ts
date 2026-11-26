import {
  extractDbSchemaFromRaw,
  extractLiveBuildArtifacts,
  extractPlanStepsFromRaw,
  extractSessionTitleFromRaw,
  finalizePartialPreviewHtml,
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
  repairIncompleteBuildHtml,
  streamServerFreeAiRealTime,
  type VisualHintsSpec,
} from '../_realtimeEngine.js';
import { isAgentRouterConfigured } from '../_freeAiMesh.js';
import {
  getProjectMemory,
  recordBuildCheckpoint,
  saveProjectMemorySnapshot,
} from '../_projectMemory.js';

export async function POST(request: Request): Promise<Response> {
  let body: {
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

  const projectId = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
  const turnId =
    typeof body?.turnId === 'string' && body.turnId.trim()
      ? body.turnId.trim()
      : `turn_${Date.now()}`;
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
      }, 2000);

      const closeStream = () => {
        clearInterval(keepAlive);
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      let rawAccumulated = '';

      try {
        const startedAt = Date.now();
        sendEvent({
          type: 'phase',
          phase: 'understanding',
          kind: 'chat',
          action: 'Building',
          label: 'Understanding request...',
        });

        const memAuth =
          projectId && creditCheck.context?.user?.id
            ? {
                userId: creditCheck.context.user.id,
                email: creditCheck.context.user.email || '',
                accessToken: creditCheck.context.accessToken,
              }
            : null;
        const projectMemoryPromise = memAuth
          ? getProjectMemory(memAuth, projectId).catch(() => ({
              brainContext: '',
              memory: null,
            }))
          : Promise.resolve({ brainContext: '', memory: null });

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

        const agentRouterPrimary =
          isAgentRouterConfigured() &&
          (!requestedModel || requestedModel.startsWith('agentrouter::'));

        sendEvent({
          type: 'meta',
          kind: prepared.naturalMediaIntent ? 'media' : 'chat',
          modelId:
            requestedModel || (agentRouterPrimary ? 'agentrouter::auto' : 'mesh::auto'),
          modelName:
            prepared.requestedModelLabel ||
            (agentRouterPrimary ? 'AgentRouter · Auto' : 'Free AI Mesh · Auto'),
          provider: agentRouterPrimary ? 'agentrouter' : 'free-mesh',
          gateway: agentRouterPrimary ? 'agentrouter' : 'mesh',
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
            modelUsed: mediaResult.modelId || 'free-media',
            modelName: prepared.requestedModelLabel || 'Free AI Studio',
            provider: mediaResult.gateway,
          });
          closeStream();
          return;
        }

        // True Real-Time Streaming LLM Generation (Zero Hardcoded Templates!)
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

        let activeModelUsed =
          requestedModel || (agentRouterPrimary ? 'agentrouter::auto' : 'mesh::auto');
        let activeModelName =
          prepared.requestedModelLabel ||
          (agentRouterPrimary ? 'AgentRouter · Auto' : 'Free AI Mesh · Auto');
        let activeProvider = agentRouterPrimary ? 'agentrouter' : 'free-mesh';
        let parallelMergedRaw: string | null = null;

        let lastReasoningUpdateAt = 0;
        let reasoningBuffer = '';

        await streamServerFreeAiRealTime({
          requestedModel,
          initialRoute: prepared.initialRoute,
          isFastPatch: Boolean(prepared.isPatchMode),
          systemPrompt: prepared.systemPrompt,
          historyMessages: prepared.historyMessages,
          userPrompt: prepared.userPrompt,
          attachmentDataUrl,
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
                (prepared.initialRoute === 'build'
                  ? 'Planning layout & logic...'
                  : 'Thinking...');
              sendEvent({
                type: 'phase',
                phase: 'understanding',
                kind: prepared.initialRoute === 'build' ? 'build' : 'chat',
                action: prepared.initialRoute === 'build' ? 'Building' : 'Thinking',
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
                  action: 'Coding',
                  label: codeStart.isPatch
                    ? 'Updating code...'
                    : 'Coding app files...',
                });
              }

              const htmlSoFar = cleanSoFar
                .slice(codeStart.htmlOffset)
                .replace(/<<<\s*(?:END_AICRAFT_APP_HTML|END_PATCH|END_AICRAFT_PATCH)\s*>>>[\s\S]*/i, '');
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
                  action: 'Coding',
                  path: active?.path || 'index.html',
                  allFiles: paths,
                  bytesBuilt: htmlSoFar.length,
                });
              }
              if (
                !codeStart.isPatch &&
                htmlSoFar.length >= 450 &&
                htmlSoFar.length - lastPreviewBytesSent >= 1400
              ) {
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

        if (parallelMergedRaw) {
          rawAccumulated = parallelMergedRaw;
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
          startedAt,
        });

        if (
          finalized.kind === 'build' &&
          !finalized.valid &&
          finalized.previewHtml &&
          Date.now() - startedAt < 42000
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
            modelUsed: mediaResult.modelId || 'free-media',
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
        });
        closeStream();
      } catch (err) {
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
          err instanceof Error
            ? err.message
            : 'Unable to reach free AI engine right now.';
        if (projectId && creditCheck.context?.user?.id) {
          void recordBuildCheckpoint(
            {
              userId: creditCheck.context.user.id,
              email: creditCheck.context.user.email || '',
              accessToken: creditCheck.context.accessToken,
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
