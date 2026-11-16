import { buildFocusedSearchQuery, runLiveBrowserSearch, formatWebSearchContext } from './_builderCore.js';
import { GeminiRouterError, routeMessageWithGemini } from './_geminiRouter.js';
import { assembleModularInterface } from './_moduleAssembler.js';
import { authenticateRequestForModeration } from './_moderation.js';
import { appendClearAuthCookies } from './_supabaseAuth.js';

export async function POST(request: Request): Promise<Response> {
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

    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return Response.json({ error: 'Prompt message is required.' }, { status: 400 });
    }

    const mode = body?.mode === 'web' ? 'web' : 'mobile';
    const webSearchEnabled = body?.webSearchEnabled !== false;
    const shouldAssemble = body?.assemble !== false;

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

    return Response.json(
      {
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
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch (err) {
    if (err instanceof GeminiRouterError) {
      return Response.json(
        {
          error: err.message,
          code: err.code,
        },
        { status: err.status }
      );
    }
    const message =
      err instanceof Error ? err.message : 'Unable to route message through Gemini.';
    return Response.json({ error: message }, { status: 502 });
  }
}
