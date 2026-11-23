import {
  GEMINI_BUILDER_MODELS,
  fetchAllGatewayModels,
  hasServerFreeAiKey,
} from './_aiGateways.js';
import { getFreeAiMeshStatus } from './_freeAiMesh.js';

export async function GET(request: Request): Promise<Response> {
  try {
    const reqUrl = new URL(request.url);
    const referer = process.env.APP_URL || `${reqUrl.protocol}//${reqUrl.host}`;
    const forceRefresh = reqUrl.searchParams.get('refresh') === '1';

    const result = await fetchAllGatewayModels(referer, forceRefresh);
    const mesh = getFreeAiMeshStatus();

    return Response.json(
      {
        models: result.models,
        gateways: result.gateways,
        geminiConfigured: result.geminiConfigured,
        serverFreeAiReady: result.geminiConfigured || mesh.hasAny,
        pollinationsConfigured: mesh.pollinationsConfigured,
        puterConfigured: false,
        keyless: mesh.hasKeyless,
        freeAiMesh: {
          hasAny: mesh.hasAny,
          hasKeyless: mesh.hasKeyless,
          providers: mesh.providers.filter((p) => p.configured).map((p) => p.id),
        },
        freeOnly: true,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch {
    const mesh = getFreeAiMeshStatus();
    return Response.json(
      {
        models: GEMINI_BUILDER_MODELS,
        geminiConfigured: hasServerFreeAiKey(),
        serverFreeAiReady: hasServerFreeAiKey() || mesh.hasAny,
        pollinationsConfigured: mesh.pollinationsConfigured,
        puterConfigured: false,
        keyless: mesh.hasKeyless,
        freeAiMesh: {
          hasAny: mesh.hasAny,
          hasKeyless: mesh.hasKeyless,
          providers: mesh.providers.filter((p) => p.configured).map((p) => p.id),
        },
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
