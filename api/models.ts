import { hasServerFreeAiKey } from './_aiGateways.js';
import { getFreeAiMeshStatus, getFreeMeshModelOptions } from './_freeAiMesh.js';

export async function GET(request: Request): Promise<Response> {
  try {
    const mesh = getFreeAiMeshStatus();

    return Response.json(
      {
        models: getFreeMeshModelOptions(),
        gateways: [
          {
            id: 'free-mesh',
            label: 'Free AI Mesh',
            baseUrl: 'keyless failover across free providers',
            configured: mesh.hasAny,
            keyCount: 0,
            modelCount: mesh.modelPool.activeModels,
            defaultModel: 'mesh::auto',
          },
        ],
        geminiConfigured: false,
        serverFreeAiReady: mesh.hasAny,
        pollinationsConfigured: mesh.pollinationsConfigured,
        puterConfigured: false,
        keyless: mesh.hasKeyless,
        freeAiMesh: {
          hasAny: mesh.hasAny,
          hasKeyless: mesh.hasKeyless,
          providers: mesh.providers.filter((p) => p.configured).map((p) => p.id),
          modelPool: mesh.modelPool,
        },
        modelPool: mesh.modelPool,
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
        models: getFreeMeshModelOptions(),
        geminiConfigured: hasServerFreeAiKey(),
        serverFreeAiReady: mesh.hasAny,
        pollinationsConfigured: mesh.pollinationsConfigured,
        puterConfigured: false,
        keyless: mesh.hasKeyless,
        freeAiMesh: {
          hasAny: mesh.hasAny,
          hasKeyless: mesh.hasKeyless,
          providers: mesh.providers.filter((p) => p.configured).map((p) => p.id),
          modelPool: mesh.modelPool,
        },
        modelPool: mesh.modelPool,
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
