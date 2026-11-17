import {
  ARCHITECT_PUBLIC_MODEL,
  POLLINATIONS_FALLBACK_MODELS,
  PUTER_BROWSER_MODELS,
  fetchAllGatewayModels,
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
        pollinationsConfigured: result.pollinationsConfigured,
        puterConfigured: result.puterConfigured,
        keyless: true,
        freeOnly: true,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch {
    const fallbackModels = [
      ARCHITECT_PUBLIC_MODEL,
      ...POLLINATIONS_FALLBACK_MODELS.filter((m) => m.category === 'code'),
      ...PUTER_BROWSER_MODELS,
      ...POLLINATIONS_FALLBACK_MODELS.filter((m) => m.category !== 'code'),
    ];

    return Response.json(
      {
        models: fallbackModels,
        pollinationsConfigured: true,
        puterConfigured: true,
        keyless: true,
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
