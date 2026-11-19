import { getServerGeminiApiKey } from './_aiGateways.js';
import { getPaymentSecretKey } from './_paystack.js';
import { getSupabaseConfig } from './_supabaseAuth.js';

export async function GET(): Promise<Response> {
  const sbConfig = getSupabaseConfig();

  return Response.json(
    {
      ok: true,
      geminiConfigured: Boolean(getServerGeminiApiKey()),
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
