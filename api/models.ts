import {
  getAgentRouterApiOrigin,
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
          {
            id: 'agentrouter',
            label: 'AgentRouter',
            baseUrl: getAgentRouterApiOrigin(),
            configured: agentRouterConfigured,
            keyCount: agentRouterConfigured ? 1 : 0,
            modelCount:
              mesh.providers.find((p) => p.id === 'agentrouter')?.modelCount || 5,
            defaultModel: 'agentrouter::auto',
          },
        ],
        agentRouterConfigured,
        geminiConfigured: false,
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
        agentRouterConfigured: isAgentRouterConfigured(),
        geminiConfigured: false,
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
