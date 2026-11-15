import { fetchAllGatewayModels } from './_aiGateways.js';
import { getGeminiApiKey, getOpenRouterApiKey } from './_openrouterModels.js';

export async function GET(request: Request): Promise<Response> {
  try {
    const reqUrl = new URL(request.url);
    const referer = process.env.APP_URL || `${reqUrl.protocol}//${reqUrl.host}`;
    const forceRefresh = reqUrl.searchParams.get('refresh') === '1';

    const result = await fetchAllGatewayModels(referer, forceRefresh);

    return Response.json(
      {
        models: result.models,
        gateways: result.gateways,
        openRouterConfigured: result.openRouterConfigured,
        huggingFaceConfigured: result.huggingFaceConfigured,
        ngrokConfigured: result.ngrokConfigured,
        geminiConfigured: result.geminiConfigured,
        freeOnly: !result.huggingFaceConfigured && !result.ngrokConfigured,
        keyStatus: result.keyStatus,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unable to load AI gateway models.';
    const geminiConfigured = Boolean(getGeminiApiKey());
    const openRouterConfigured = Boolean(getOpenRouterApiKey());

    const fallbackModels = geminiConfigured
      ? [
          {
            id: 'google/gemini-4-hydrogen',
            upstreamModelId: 'gemini-4-hydrogen',
            gateway: 'gemini' as const,
            name: 'Google: Gemini 4 Hydrogen',
            provider: 'google',
            contextLength: 1048576,
            isFree: true,
            tierLabel: 'Built-in',
            capabilities: ['Code', 'Build', 'Vision'],
            category: 'code' as const,
          },
        ]
      : [];

    return Response.json(
      {
        models: fallbackModels,
        openRouterConfigured,
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
