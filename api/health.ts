import { getServerGeminiApiKey } from './_aiGateways.js';
import {
  getAgentRouterDiagnostic,
  getFreeAiMeshStatus,
  isAgentRouterConfigured,
} from './_freeAiMesh.js';
import { getPaymentSecretKey } from './_paystack.js';
import { getSupabaseConfig } from './_supabaseAuth.js';

export async function GET(): Promise<Response> {
  const sbConfig = getSupabaseConfig();
  const mesh = getFreeAiMeshStatus();
  const agentRouterConfigured = isAgentRouterConfigured();

  return Response.json(
    {
      ok: true,
      geminiConfigured: Boolean(getServerGeminiApiKey()),
      agentRouterConfigured,
      agentRouter: getAgentRouterDiagnostic(),
      serverFreeAiReady: mesh.hasAny,
      freeAiMesh: {
        hasAny: mesh.hasAny,
        hasKeyless: mesh.hasKeyless,
        pollinationsEnabled: mesh.pollinationsEnabled,
        providers: mesh.providers.filter((p) => p.configured).map((p) => p.id),
        modelPool: mesh.modelPool,
      },
      supabaseConfigured: Boolean(sbConfig.url && sbConfig.anonKey),
      paymentsConfigured: Boolean(getPaymentSecretKey()),
      vercelEnv: process.env.VERCEL_ENV || null,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}
