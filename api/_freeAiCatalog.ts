/**
 * AI Craft — Free AI Model Catalog
 *
 * A curated, keyless-first catalog of the free-tier models we know across
 * every provider the mesh supports. Each (provider, model) pair is one "AI"
 * in the pool: the mesh walks them in order, skips anything rate-limited
 * (cooldowns) or over its daily quota, and fails over to the next one — so
 * when one hits its limit another continues automatically.
 *
 * Quotas reset every day at 00:00 UTC (keys are date-stamped, so reset is
 * automatic — no cron, no stored state to clean up).
 *
 * The static lists below are the offline baseline. On top of them:
 *  - Pollinations refreshes its live /models list (see _freeAiMesh.ts).
 *  - OpenRouter's public model index is polled when an OPENROUTER_API_KEY
 *    is configured and filtered to $0 prompt-price (:free) models, growing
 *    the catalog automatically without any code change.
 *
 * Everything here is informational — the mesh only *serves* requests from
 * providers that are actually configured in the environment.
 */

/** Curated free-tier model IDs per mesh provider (real, known entries). */
export const FREE_MODEL_CATALOG: Record<string, string[]> = {
  groq: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'meta-llama/llama-4-maverick-17b-128e-instruct',
    'qwen/qwen3-32b',
    'qwen/qwen3-235b-a22b-instruct',
    'deepseek-r1-distill-llama-70b',
    'gemma2-9b-it',
    'qwen-qwq-32b',
    'openai/gpt-oss-20b',
    'openai/gpt-oss-120b',
    'allam-2-7b',
    'qwen/qwen3-30b-a3b',
    'moonshotai/kimi-k2-instruct',
  ],
  cerebras: [
    'llama-3.3-70b',
    'llama-3.1-8b',
    'llama3.1-8b',
    'qwen-3-32b',
    'qwen3-32b',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen3-235b-a22b',
    'llama-3.1-70b',
  ],
  openrouter: [
    'deepseek/deepseek-chat-v3-0324:free',
    'deepseek/deepseek-r1:free',
    'deepseek/deepseek-r1-0528:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'meta-llama/llama-4-maverick:free',
    'meta-llama/llama-4-scout:free',
    'meta-llama/llama-3.2-3b-instruct:free',
    'qwen/qwen3-235b-a22b:free',
    'qwen/qwen3-coder:free',
    'qwen/qwen3-14b:free',
    'qwen/qwen3-30b-a3b:free',
    'qwen/qwq-32b:free',
    'qwen/qwen2.5-72b-instruct:free',
    'google/gemma-3-27b-it:free',
    'google/gemma-3-12b-it:free',
    'google/gemma-2-9b-it:free',
    'mistralai/mistral-small-3.1-24b-instruct:free',
    'mistralai/mistral-7b-instruct:free',
    'mistralai/mistral-nemo:free',
    'moonshotai/kimi-k2:free',
    'moonshotai/kimi-dev-72b:free',
    'z-ai/glm-4.5-air:free',
    'z-ai/glm-4-32b:free',
    'thudm/glm-4-9b-chat:free',
    'microsoft/phi-4:free',
    'microsoft/phi-4-reasoning-plus:free',
    'microsoft/phi-3.5-moe:free',
    'nvidia/llama-3.1-nemotron-70b-instruct:free',
    'nvidia/nemotron-nano-9b-v2:free',
    'openai/gpt-oss-20b:free',
    'openai/gpt-oss-120b:free',
    'agentica-org/deepcoder-14b-preview:free',
    'arliai/qwq-32b:free',
    'tngtech/deepseek-r1t2:free',
    'minimax/minimax-m1:free',
    'rekaai/reka-flash-3:free',
    'sarvamai/sarvam-m:free',
    'cognitivecomputations/dolphin3.0-mistral-24b:free',
    'inflection/inflection-3-pi:free',
    'ibm/granite-3.3-8b-instruct:free',
    'huggingfaceh4/zephyr-7b-beta:free',
    'openchat/openchat-3.5:free',
    'nousresearch/hermes-3-llama-3.1-70b:free',
    'meta-llama/llama-3.2-1b-instruct:free',
    'meta-llama/llama-3.1-8b-instruct:free',
    'meta-llama/llama-3.2-11b-vision-instruct:free',
    'meta-llama/llama-3.2-90b-vision-instruct:free',
    'nousresearch/Meta-Llama-3.1-70B-Instruct:free',
    'nousresearch/hermes-4-70b:free',
    'google/gemma-3-4b-it:free',
    'google/gemma-3-1b-it:free',
    'google/gemma-3-27b-it:free',
    'google/gemma-2-2b-it:free',
    'qwen/qwen3-4b:free',
    'qwen/qwen3-0.6b:free',
    'qwen/qwen3-8b:free',
    'qwen/qwen3-32b:free',
    'qwen/qwen3-235b-a22b-2507:free',
    'qwen/qwen2.5-7b-instruct:free',
    'qwen/qwen2.5-coder-1.5b-instruct:free',
    'qwen/qwen2.5-vl-72b-instruct:free',
    'mistralai/mistral-7b-instruct-v0.3:free',
    'mistralai/mistral-small-24b-instruct-2501:free',
    'microsoft/phi-3-mini-128k-instruct:free',
    'microsoft/mai-ds-r1:free',
    'microsoft/phi-4-multimodal-instruct:free',
    'z-ai/glm-4.5:free',
    'z-ai/glm-4.6:free',
    'moonshotai/kimi-k2-0905-preview:free',
    'internlm/internlm3-8b-instruct:free',
    'internlm/internlm2_5-7b-chat:free',
    'internlm/internlm2_5-20b-chat:free',
    'openbmb/minicpm3-4b:free',
    'sao10k/l3-70b-euryale-x1:free',
    'sao10k/fimbulvetr-11b-v2:free',
    'undi95/remm-slerp-l2-13b:free',
    'gryphe/mythomax-l2-13b:free',
    'jondurbin/airoboros-l2-70b:free',
    'teknium/OpenHermes-2.5-Mistral-7B:free',
    'cognitivecomputations/dolphin3.0-r1-mistral-24b:free',
    'huggingfaceh4/starcoder2-15b:free',
    '01-ai/yi-1.5-9b-chat:free',
    '01-ai/yi-34b-chat:free',
    'thudm/chatglm3-6b:free',
    'minimax/minimax-m2:free',
    'ibm/granite-4.0-h-small:free',
    'deepseek/deepseek-v3-1-terminus:free',
    'minimax/minimax-m1-0324:free',
    'qwen/qwen3-coder-480b:free',
    'qwen/qwen3-coder-480b-a3b:free',
    'arliai/qwq-32b-preview:free',
  ],
  mistral: [
    'mistral-small-latest',
    'open-mistral-nemo',
    'mistral-large-latest',
    'codestral-latest',
    'ministral-8b-latest',
    'mistral-7b-instruct-v0.3',
    'mistral-medium-latest',
    'magistral-medium-latest',
    'open-mistral-7b',
  ],
  huggingface: [
    'meta-llama/Llama-3.3-70B-Instruct:fast',
    'Qwen/Qwen3-30B-A3B:fast',
    'mistralai/Mistral-7B-Instruct-v0.3:fast',
    'meta-llama/Meta-Llama-3.1-8B-Instruct:fast',
    'Qwen/Qwen2.5-72B-Instruct:fast',
    'google/gemma-2-9b-it:fast',
    'deepseek-ai/DeepSeek-R1:fast',
    'Qwen/Qwen2.5-Coder-32B-Instruct:fast',
    'google/gemma-2-27b-it:fast',
    'mistralai/Mistral-Nemo-Instruct-2407:fast',
    'microsoft/Phi-3.5-mini-instruct:fast',
  ],
  github: [
    'openai/gpt-4o-mini',
    'openai/gpt-4o',
    'openai/gpt-4.1',
    'openai/gpt-4.1-mini',
    'openai/gpt-4.1-nano',
    'openai/o1-mini',
    'openai/o3-mini',
    'openai/gpt-4-turbo',
    'meta-llama/Llama-3.3-70B-Instruct',
    'meta-llama/Meta-Llama-3.1-8B-Instruct',
    'meta-llama/Meta-Llama-3.1-70B-Instruct',
    'meta-llama/Llama-3.2-1B-Instruct',
    'meta-llama/Llama-3.2-3B-Instruct',
    'meta-llama/Llama-3.2-11B-Vision-Instruct',
    'meta-llama/Llama-3.2-90B-Vision-Instruct',
    'deepseek/DeepSeek-V3',
    'deepseek/DeepSeek-R1',
    'deepseek/DeepSeek-R1-0528',
    'deepseek/DeepSeek-Coder-V2-Lite-Instruct',
    'Qwen/Qwen2.5-72B-Instruct',
    'Qwen/Qwen2.5-Coder-32B-Instruct',
    'mistralai/Mistral-small-24B-Instruct-2501',
    'mistralai/Mistral-7B-Instruct-v0.3',
    'mistralai/Ministral-8B-Instruct-2410',
    'AI21-Jamba-Jamba-1.5-Mini',
    'AI21-Jamba-Jamba-1.5-Large',
    'Microsoft/Phi-4',
    'Microsoft/phi-3.5-moe',
    'Microsoft/phi-3-mini-128k-instruct',
    'Microsoft/Phi-3.5-vision-instruct',
    'Cohere/command-r7b-12-2024',
    'Cohere/command-r-plus',
    'openai/o3',
    'openai/o4-mini',
    'mistralai/Mistral-Nemo-Instruct-2407',
    'mistralai/codestral-2501',
    'Qwen/QwQ-32B',
    'Qwen/Qwen2.5-VL-72B-Instruct',
    'Microsoft/Phi-4-Mini-Instruct',
    'Cohere/command-r-08-2024',
    'meta-llama/Llama-3.1-405B-Instruct',
    'meta-llama/Llama-4-Scout-17B-16E-Instruct',
  ],
  together: [
    'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
    'Qwen/Qwen2.5-72B-Instruct-Turbo',
    'deepseek-ai/DeepSeek-V3',
    'mistralai/Mistral-7B-Instruct-v0.3',
    'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
    'mistralai/Mixtral-8x22B-Instruct-v0.1',
    'google/gemma-2-9b-it',
    'Qwen/Qwen2.5-Coder-32B-Instruct',
  ],
  deepinfra: [
    'meta-llama/Llama-3.3-70B-Instruct',
    'deepseek-ai/DeepSeek-V3',
    'Qwen/Qwen2.5-72B-Instruct',
    'meta-llama/Meta-Llama-3.1-70B-Instruct',
    'mistralai/Mistral-7B-Instruct-v0.3',
    'google/gemma-2-9b-it',
    'Qwen/Qwen2.5-Coder-32B-Instruct',
    'deepseek-ai/DeepSeek-R1',
    'meta-llama/Llama-3.1-405B-Instruct',
    'google/gemma-2-27b-it',
    'Qwen/Qwen2.5-14B-Instruct',
    'microsoft/Phi-3.5-mini-instruct',
  ],
  pollinations: [
    'openai',
    'openai-fast',
    'openai-large',
    'qwen-coder',
    'deepseek',
    'deepseek-reasoning',
    'mistral',
    'llama-fast',
    'phi',
    'gemma',
    'nova-fast',
    'searchgpt',
    'llama',
  ],
  'self-hosted': [],
  'openai-compatible': [],
};

/** Total number of cataloged free models (static baseline). */
export function staticCatalogSize(): number {
  let total = 0;
  for (const models of Object.values(FREE_MODEL_CATALOG)) {
    total += models.length;
  }
  return total;
}

/** Next UTC midnight — when every provider/model daily quota resets. */
export function nextDailyResetAt(now: Date = new Date()): string {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );
  return new Date(next).toISOString();
}

/** Current UTC calendar day (YYYY-MM-DD) — stamps daily quota keys. */
export function utcQuotaDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
