import {
  fetchAllGatewayModels,
  getActiveTwoBuilderModels,
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
        pollinationsConfigured: false,
        puterConfigured: true,
        serverFreeAiReady: result.serverFreeAiReady,
        keyless: !result.serverFreeAiReady,
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
        models: getActiveTwoBuilderModels(),
        pollinationsConfigured: false,
        puterConfigured: true,
        serverFreeAiReady: hasServerFreeAiKey(),
        keyless: !hasServerFreeAiKey(),
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
