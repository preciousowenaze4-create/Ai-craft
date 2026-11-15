import {
  fetchFreeOpenRouterCatalog,
  fetchOpenRouterKeyStatus,
  getGeminiApiKey,
  getOpenRouterApiKey,
  type NormalizedOpenRouterModel,
} from './_openrouterModels.js';

export async function GET(request: Request): Promise<Response> {
  const openRouterKey = getOpenRouterApiKey();
  const geminiConfigured = Boolean(getGeminiApiKey());

  try {
    const reqUrl = new URL(request.url);
    const referer = process.env.APP_URL || `${reqUrl.protocol}//${reqUrl.host}`;
    const forceRefresh = reqUrl.searchParams.get('refresh') === '1';

    const [models, keyStatus] = await Promise.all([
      fetchFreeOpenRouterCatalog(openRouterKey, referer),
      fetchOpenRouterKeyStatus(openRouterKey, referer, forceRefresh),
    ]);

    return Response.json(
      {
        models,
        openRouterConfigured: Boolean(openRouterKey),
        geminiConfigured,
        freeOnly: true,
        keyStatus,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unable to load free OpenRouter models.';
    const fallbackModels: NormalizedOpenRouterModel[] = geminiConfigured
      ? [
          {
            id: 'google/gemini-4-hydrogen',
            name: 'Google: Gemini 4 Hydrogen',
            provider: 'google',
            contextLength: 1048576,
            isFree: true,
            capabilities: ['Code', 'Build', 'Vision'],
            category: 'code',
          },
        ]
      : [];

    return Response.json(
      {
        models: fallbackModels,
        openRouterConfigured: Boolean(openRouterKey),
        geminiConfigured,
        freeOnly: true,
        error: fallbackModels.length > 0 ? undefined : message,
      },
      {
        status: fallbackModels.length > 0 ? 200 : 502,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  }
}
