import {
  GEMINI_BUILDER_MODELS,
  fetchAllGatewayModels,
  hasServerFreeAiKey,
} from './_aiGateways.js';

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
        geminiConfigured: result.geminiConfigured,
        serverFreeAiReady: result.serverFreeAiReady,
        pollinationsConfigured: false,
        puterConfigured: false,
        keyless: false,
        freeOnly: true,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch {
    return Response.json(
      {
        models: GEMINI_BUILDER_MODELS,
        geminiConfigured: hasServerFreeAiKey(),
        serverFreeAiReady: hasServerFreeAiKey(),
        pollinationsConfigured: false,
        puterConfigured: false,
        keyless: false,
        freeOnly: true,
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
