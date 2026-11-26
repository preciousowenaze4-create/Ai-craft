import { hasServerFreeAiKey } from './_aiGateways.js';
import {
  getFreeAiMeshStatus,
  getFreeMeshModelOptions,
  isAgentRouterConfigured,
  refreshAgentRouterModelsIfConfigured,
} from './_freeAiMesh.js';

export async function GET(request: Request): Promise<Response> {
  try {
    const reqUrl = new URL(request.url, 'http://localhost');
    if (reqUrl.searchParams.get('refresh') === '1' && isAgentRouterConfigured()) {
      await refreshAgentRouterModelsIfConfigured().catch(() => []);
    }
    const mesh = getFreeAiMeshStatus();
    const agentRouterConfigured = isAgentRouterConfigured();

    return Response.json(
      {
        models: getFreeMeshModelOptions(),
        gateways: [
          ...(agentRouterConfigured
            ? [
                {
                  id: 'agentrouter',
                  label: 'AgentRouter',
                  baseUrl: (process.env.AGENTROUTER_BASE_URL || 'https://co.agentrouter.org/v1').trim(),
                  configured: true,
                  keyCount: 1,
                  modelCount:
                    mesh.providers.find((p) => p.id === 'agentrouter')?.modelCount || 11,
                  defaultModel: 'agentrouter::auto',
                },
              ]
            : []),
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
        agentRouterConfigured,
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
        freeOnly: !agentRouterConfigured,
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
        agentRouterConfigured: isAgentRouterConfigured(),
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
        freeOnly: !isAgentRouterConfigured(),
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
