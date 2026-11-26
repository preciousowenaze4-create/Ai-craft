import { getServerGeminiApiKeys } from './_aiGateways.js';
import {
  getFreeAiMeshStatus,
  getFreeMeshModelOptions,
  getGeminiApiOrigin,
  isGeminiConfigured,
  refreshGeminiModelsIfConfigured,
} from './_freeAiMesh.js';

export async function GET(request: Request): Promise<Response> {
  try {
    const reqUrl = new URL(request.url, 'http://localhost');
    if (reqUrl.searchParams.get('refresh') === '1' && isGeminiConfigured()) {
      await refreshGeminiModelsIfConfigured().catch(() => []);
    }
    const mesh = getFreeAiMeshStatus();
    const geminiConfigured = isGeminiConfigured();
    const keyCount = getServerGeminiApiKeys().length;

    return Response.json(
      {
        models: getFreeMeshModelOptions(),
        gateways: [
          {
            id: 'gemini',
            label: 'Google Gemini',
            baseUrl: getGeminiApiOrigin(),
            configured: geminiConfigured,
            keyCount,
            modelCount:
              mesh.providers.find((p) => p.id === 'gemini')?.modelCount || 5,
            defaultModel: 'gemini::gemini-4-hydrogen',
          },
        ],
        geminiConfigured,
        serverFreeAiReady: mesh.hasAny,
        pollinationsConfigured: false,
        puterConfigured: false,
        keyless: false,
        freeAiMesh: {
          hasAny: mesh.hasAny,
          hasKeyless: false,
          providers: mesh.providers.filter((p) => p.configured).map((p) => p.id),
          modelPool: mesh.modelPool,
        },
        modelPool: mesh.modelPool,
        freeOnly: false,
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
        models: getFreeMeshModelOptions(),
        geminiConfigured: isGeminiConfigured(),
        serverFreeAiReady: mesh.hasAny,
        pollinationsConfigured: false,
        puterConfigured: false,
        keyless: false,
        freeAiMesh: {
          hasAny: mesh.hasAny,
          hasKeyless: false,
          providers: mesh.providers.filter((p) => p.configured).map((p) => p.id),
          modelPool: mesh.modelPool,
        },
        modelPool: mesh.modelPool,
        freeOnly: false,
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
