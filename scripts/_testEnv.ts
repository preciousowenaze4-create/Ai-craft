/**
 * Scrub ambient AI-provider credentials from the environment so the test
 * suites behave identically on dev machines, sandboxes, and CI runners.
 * Each test re-configures only the local mock lanes it needs afterwards.
 *
 * This matters because GitHub Actions runners have OPEN networks (unlike
 * sandboxes that block live providers) — without scrubbing, a keyless lane
 * like Pollinations or an ambient GITHUB_TOKEN could answer for real and
 * break assertions.
 */
const AI_ENV_VARS = [
  // Gemini key pool (see getServerGeminiApiKeys in api/_aiGateways.ts)
  'GEMINI_API_KEY',
  'GEMINI_API_KEY_1',
  'GEMINI_API_KEY_2',
  'GEMINI_API_KEY_3',
  'GEMINI_API_KEY_4',
  'GEMINI_API_KEY_5',
  'GEMINI_API_KEY_6',
  'GEMINI_API_KEY_7',
  'GEMINI_API_KEY_8',
  'BACKUP_GEMINI_API_KEY',
  'GEMINI_BACKUP_KEY',
  'GEMINI_API_KEY_BACKUP',
  'SECONDARY_GEMINI_API_KEY',
  'MY_GEMINI_API_KEY',
  'YOUR_GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  // Free AI mesh providers (see api/_freeAiMesh.ts)
  'SELF_HOSTED_LLM_URL',
  'SELF_HOSTED_LLM_MODEL',
  'SELF_HOSTED_LLM_API_KEY',
  'AGENTROUTER_API_KEY',
  'AGENT_ROUTER_API_KEY',
  'AGENTROUTER_KEY',
  'AGENTROUTER_BASE_URL',
  'AGENTROUTER_MODEL',
  'AGENTROUTER_MODELS',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_MODEL',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_KEY',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODELS',
  'MISTRAL_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_TOKEN',
  'HUGGINGFACE_MODELS',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_MODELS',
  'TOGETHER_API_KEY',
  'TOGETHER_MODELS',
  'DEEPINFRA_API_KEY',
  'DEEPINFRA_MODELS',
  'POLLINATIONS_ENABLED',
  'POLLINATIONS_BASE_URL',
  'POLLINATIONS_API_KEY',
  'POLLINATIONS_MODELS',
  'MESH_DAILY_LIMIT_PER_MODEL',
  'MESH_PARALLEL_BUILDS',
];

export function scrubAiEnv(): void {
  for (const name of AI_ENV_VARS) {
    delete process.env[name];
  }
}

/**
 * Empty-string overrides for every AI env var. Useful when spawning
 * `server.ts` (which runs `dotenv/config`): dotenv only fills keys that are
 * *absent* from process.env, so present-but-empty values prevent a dev
 * machine's `.env` file from re-introducing real credentials mid-test.
 */
export function emptyAiEnv(): Record<string, string> {
  return Object.fromEntries(AI_ENV_VARS.map((name) => [name, '']));
}
