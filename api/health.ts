import {
  getGatewayOrder,
  getGroqApiKey,
  getHuggingFaceApiKey,
  getNgrokApiKey,
} from './_aiGateways.js';
import { getGeminiApiKey, getOpenRouterApiKey } from './_openrouterModels.js';
import { getPaymentSecretKey } from './_paystack.js';
import { getSupabaseConfig } from './_supabaseAuth.js';

export async function GET(): Promise<Response> {
  const sbConfig = getSupabaseConfig();
  const groqConfigured = Boolean(getGroqApiKey());
  const openRouterConfigured = Boolean(getOpenRouterApiKey());
  const huggingFaceConfigured = Boolean(getHuggingFaceApiKey());
  const ngrokConfigured = Boolean(getNgrokApiKey());
  const geminiConfigured = Boolean(getGeminiApiKey());

  return Response.json(
    {
      ok: true,
      geminiConfigured,
      groqConfigured,
      openRouterConfigured,
      huggingFaceConfigured,
      ngrokConfigured,
      pollinationsConfigured: true,
      gatewayOrder: getGatewayOrder(),
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
