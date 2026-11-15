import {
  ARCHITECT_PUBLIC_MODEL,
  POLLINATIONS_FALLBACK_MODELS,
  fetchAllGatewayModels,
  getGroqApiKey,
} from './_aiGateways.js';
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
        groqConfigured: result.groqConfigured,
        openRouterConfigured: result.openRouterConfigured,
        huggingFaceConfigured: result.huggingFaceConfigured,
        ngrokConfigured: result.ngrokConfigured,
        pollinationsConfigured: result.pollinationsConfigured,
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
    const groqConfigured = Boolean(getGroqApiKey());
    const openRouterConfigured = Boolean(getOpenRouterApiKey());

    const fallbackModels = [ARCHITECT_PUBLIC_MODEL, ...POLLINATIONS_FALLBACK_MODELS.filter((m) => m.category !== 'code')];

    return Response.json(
      {
        models: fallbackModels,
        groqConfigured,
        openRouterConfigured,
        geminiConfigured,
        pollinationsConfigured: true,
        freeOnly: true,
        error: fallbackModels.length > 0 ? undefined : message,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  }
}
