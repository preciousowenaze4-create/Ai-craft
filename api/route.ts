import { authenticateRequestForModeration } from './_moderation.js';
import { appendClearAuthCookies } from './_supabaseAuth.js';
import {
  MIN_CHAT_CREDITS_THRESHOLD,
  calculateBuildCreditsForBytes,
  commitGenerationCredits,
  verifyUserCanGenerate,
} from './_billing.js';
import {
  finalizeRealtimeOutput,
  prepareRealtimePrompt,
  streamServerFreeAiRealTime,
  type VisualHintsSpec,
} from './_realtimeEngine.js';
import { handleMemoryRequest } from './_memoryHandler.js';
import { getProjectMemory, saveProjectMemorySnapshot } from './_projectMemory.js';

function isMemorySubroute(request: Request): boolean {
  try {
    const u = new URL(request.url);
    return u.searchParams.get('__memory') === '1' || u.pathname.startsWith('/api/memory');
  } catch {
    return false;
  }
}

export async function GET(request: Request): Promise<Response> {
  if (isMemorySubroute(request)) {
    return handleMemoryRequest(request);
  }
  return Response.json({ ok: true, service: 'ai-craft-router' }, { status: 200 });
}

export async function DELETE(request: Request): Promise<Response> {
  if (isMemorySubroute(request)) {
    return handleMemoryRequest(request);
  }
  return Response.json({ error: 'Method not allowed.' }, { status: 405 });
}

export async function POST(request: Request): Promise<Response> {
  if (isMemorySubroute(request)) {
    return handleMemoryRequest(request);
  }
  try {
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
          error: 'Your account is currently restricted from sending messages.',
          code: 'ACCOUNT_RESTRICTED',
          restricted: true,
        },
        { status: 403 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
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
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const mode = body?.mode === 'web' ? 'web' : 'mobile';
    const projectId =
      typeof body?.projectId === 'string' && body.projectId.trim()
        ? body.projectId.trim()
        : '';
    const turnId =
      typeof body?.turnId === 'string' && body.turnId.trim()
        ? body.turnId.trim()
        : `turn_${Date.now()}`;

    if (body.action === 'finalize') {
      const rawOutput = typeof body.rawOutput === 'string' ? body.rawOutput : '';
      if (!rawOutput.trim()) {
        return Response.json({ error: 'Streamed AI output is empty.' }, { status: 400 });
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
      let updatedBilling = creditCheck.billing;
      if (finalized.kind === 'build' && finalized.previewHtml && !isOwnerRequest) {
        const rawCost = Math.max(
          1,
          calculateBuildCreditsForBytes(finalized.previewHtml.length, {
            filesCount: finalized.files.length,
            dbTablesCount: finalized.dbTables.length,
          })
        );
        creditsUsed =
          creditCheck.creditBudget !== null
            ? Math.min(rawCost, creditCheck.creditBudget)
            : rawCost;
        if (creditsUsed > 0) {
          updatedBilling =
            (await commitGenerationCredits(creditCheck.context, creditsUsed).catch(
              () => null
            )) ?? creditCheck.billing;
        }
      }

      if (projectId && creditCheck.context?.user?.id) {
        const memAuth = {
          userId: creditCheck.context.user.id,
          email: creditCheck.context.user.email || '',
          accessToken: creditCheck.context.accessToken,
        };
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
        }).catch(() => {});
      }

      return Response.json(
        {
          ...finalized,
          creditsUsed,
          billing: updatedBilling,
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (!message) {
      return Response.json({ error: 'Prompt message is required.' }, { status: 400 });
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
    const clientCreditsHint =
      typeof (body.clientCreditsRemaining ?? opts.clientCreditsRemaining) === 'number'
        ? Math.max(
            0,
            Math.floor(
              Number(body.clientCreditsRemaining ?? opts.clientCreditsRemaining)
            )
          )
        : null;

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

    let projectMemoryContext = '';
    if (projectId && creditCheck.context?.user?.id) {
      const memRes = await getProjectMemory(
        {
          userId: creditCheck.context.user.id,
          email: creditCheck.context.user.email || '',
          accessToken: creditCheck.context.accessToken,
        },
        projectId
      ).catch(() => ({ brainContext: '' }));
      projectMemoryContext = memRes.brainContext || '';
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
      projectMemoryContext,
    });

    if (body.action === 'prepare') {
      return Response.json(
        {
          ok: true,
          isOwnerRequest,
          billing: creditCheck.billing,
          ...prepared,
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
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

    return Response.json(
      {
        ...finalized,
        searchData: prepared.searchData,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Unable to run free browser AI right now.';
    return Response.json({ error: message }, { status: 502 });
  }
}
