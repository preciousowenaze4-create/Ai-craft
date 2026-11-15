export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export type FreeModelCategory = 'router' | 'code' | 'image' | 'music' | 'video' | 'chat';

export interface NormalizedOpenRouterModel {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  isFree: boolean;
  capabilities?: string[];
  category?: FreeModelCategory;
}

export interface OpenRouterApiModel {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number;
  endpoints?: string[];
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: Record<string, string | number | undefined>;
}

export interface OpenRouterKeyStatus {
  configured: boolean;
  valid: boolean | null;
  isFreeTier: boolean | null;
  limitRemaining: number | null;
}

const PRIORITY_FREE_MODEL_ORDER: string[] = [
  'openrouter/free',
  'cohere/north-mini-code:free',
  'particle-ai/particle-1:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'baidu/ernie-5.5-flash-preview:free',
  'recursive/flint-v1.0:free',
  'inclusionai/ling-3.2-flash:free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'dots-studio/dots-3-note-preview:free',
  'liquid/lfm-3-1.7b:free',
];

const keyStatusCache = new Map<
  string,
  { status: OpenRouterKeyStatus; fetchedAt: number }
>();

export function cleanEnvKey(
  raw: string | undefined,
  placeholders: string[]
): string {
  if (typeof raw !== 'string') return '';
  let cleaned = raw.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (/^bearer\s+/i.test(cleaned)) {
    cleaned = cleaned.replace(/^bearer\s+/i, '').trim();
  }
  if (!cleaned || placeholders.includes(cleaned)) return '';
  return cleaned;
}

export function parseEnvKeyPool(
  rawCandidates: Array<string | undefined>,
  placeholders: string[]
): string[] {
  const pool: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawCandidates) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    // Allow users to optionally provide comma/newline/semicolon-separated own backup keys
    const parts = raw.split(/[\n,;]+/);
    for (const part of parts) {
      const cleaned = cleanEnvKey(part, placeholders);
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      pool.push(cleaned);
    }
  }
  return pool;
}

export function getOpenRouterApiKeyPool(): string[] {
  const rawCandidates = [
    process.env.OPENROUTER_API_KEY,
    process.env.OPENROUTER_API_KEY_2,
    process.env.OPENROUTER_API_KEY_3,
    process.env.OPENROUTER_API_KEY_4,
    process.env.OPENROUTER_API_KEY_5,
    process.env.OPEN_ROUTER_API_KEY,
    process.env.OPENROUTER_KEY,
    process.env.OPENROUTER_API,
    process.env.OPENROUTER_TOKEN,
    process.env.NEXT_PUBLIC_OPENROUTER_API_KEY,
    process.env.VITE_OPENROUTER_API_KEY,
  ];
  const pool = parseEnvKeyPool(rawCandidates, ['MY_OPENROUTER_API_KEY']).filter(
    (k) => !k.startsWith('AIza')
  );
  const apiKey = cleanEnvKey(process.env.API_KEY, ['MY_OPENROUTER_API_KEY']);
  if (apiKey.startsWith('sk-or-') && !pool.includes(apiKey)) {
    pool.push(apiKey);
  }
  return pool;
}

export function getOpenRouterApiKey(): string {
  return getOpenRouterApiKeyPool()[0] || '';
}

export function getGeminiApiKeyPool(): string[] {
  const candidates = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    process.env.VITE_GEMINI_API_KEY,
  ];
  return parseEnvKeyPool(candidates, ['MY_GEMINI_API_KEY']);
}

export function getGeminiApiKey(): string {
  return getGeminiApiKeyPool()[0] || '';
}

export function isTextToSpeechModel(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(?:tts|text-to-speech|text_to_speech|speech-synthesis|speecht5|voice-clone|voice\s+cloning|kokoro|bark|parler|fish-speech|xtts|piper|vits|mms-tts|orpheus|sesame-csm|chatterbox|f5-tts|cosyvoice|styletts|tortoise-tts|elevenlabs)\b/i.test(
    text
  );
}

export function isRestrictedHarnessModel(id: string): boolean {
  return id.endsWith(':batch') || id.startsWith('thinkingmachines/');
}

function hasZeroPricingOnly(
  pricing: Record<string, string | number | undefined> | undefined
): boolean {
  if (!pricing || typeof pricing !== 'object') return false;
  const numericEntries = Object.values(pricing).filter(
    (v) => v !== undefined && v !== null && String(v).trim() !== ''
  );
  if (numericEntries.length === 0) return false;
  return numericEntries.every((v) => {
    const num = Number(v);
    return Number.isFinite(num) && num === 0;
  });
}

function hasPaidFlatFeeDisclaimer(description: string | undefined): boolean {
  if (!description) return false;
  return /(?:priced\s+at|costs?|billed\s+at)\s*\$\s*\d+(?:\.\d+)?|\$\s*0?\.\d+\s*(?:\/|\s*per\s+)(?:song|clip|track|audio|image|picture|minute|second|request|call|generation|video|1m|1k)/i.test(
    description
  );
}

export function isTrulyFreeOpenRouterModel(item: OpenRouterApiModel): boolean {
  const id = typeof item?.id === 'string' ? item.id.trim() : '';
  if (!id || isRestrictedHarnessModel(id)) return false;

  // Exclude Text-to-Speech models explicitly
  if (isTextToSpeechModel(`${id} ${item?.name || ''} ${item?.description || ''}`)) {
    return false;
  }

  if (
    Array.isArray(item?.endpoints) &&
    item.endpoints.length > 0 &&
    !item.endpoints.includes('/api/v1/chat/completions')
  ) {
    return false;
  }

  // Strictly require an explicit free OpenRouter identifier (:free or openrouter/free)
  // so non-free models with hidden per-clip / per-song / per-image billing never slip through
  const hasExplicitFreeTag = id.endsWith(':free') || id === 'openrouter/free';
  if (!hasExplicitFreeTag) return false;

  if (!hasZeroPricingOnly(item.pricing)) return false;
  if (hasPaidFlatFeeDisclaimer(item.description)) return false;

  return true;
}

function classifyFreeModel(item: OpenRouterApiModel): {
  capabilities: string[];
  category: FreeModelCategory;
} {
  const id = (item.id || '').toLowerCase();
  const name = (item.name || '').toLowerCase();
  const desc = (item.description || '').toLowerCase();
  const inMods = Array.isArray(item.architecture?.input_modalities)
    ? item.architecture!.input_modalities.map((m) => String(m).toLowerCase())
    : [];
  const outMods = Array.isArray(item.architecture?.output_modalities)
    ? item.architecture!.output_modalities.map((m) => String(m).toLowerCase())
    : [];
  const ctx =
    typeof item.context_length === 'number' && Number.isFinite(item.context_length)
      ? item.context_length
      : 0;

  if (id === 'openrouter/free') {
    return {
      capabilities: ['Auto Free', 'Code', 'Build'],
      category: 'router',
    };
  }

  const caps: string[] = [];
  const canImage = outMods.includes('image');
  const canMusic = outMods.includes('audio');
  const canVision = inMods.includes('image') || inMods.includes('video');
  const blob = `${id} ${name} ${desc}`;
  const canCode =
    /code|coding|coder|software|agentic|programming|developer|html|react|ui|reasoning|instruct|flash|ultra|super|mini-code|particle-1|flint|gemma|ernie|ling/.test(
      blob
    ) || ctx >= 32000;

  if (canImage) caps.push('Image');
  if (canMusic) caps.push('Music');
  if (canCode) {
    caps.push('Code');
    caps.push('Build');
  }
  if (canVision) caps.push('Vision');
  if (caps.length === 0) caps.push('Chat');

  const category: FreeModelCategory = canImage
    ? 'image'
    : canMusic
      ? 'music'
      : canCode
        ? 'code'
        : 'chat';

  return { capabilities: caps, category };
}

export function normalizeFreeOpenRouterModels(
  rawList: OpenRouterApiModel[]
): NormalizedOpenRouterModel[] {
  const normalized: NormalizedOpenRouterModel[] = [];
  const seen = new Set<string>();

  for (const item of rawList) {
    if (!isTrulyFreeOpenRouterModel(item)) continue;
    const id = item.id!.trim();
    if (seen.has(id)) continue;
    seen.add(id);

    const slashIndex = id.indexOf('/');
    const provider = slashIndex > 0 ? id.slice(0, slashIndex) : 'openrouter';
    const rawName =
      typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : id;
    const contextLength =
      typeof item?.context_length === 'number' &&
      Number.isFinite(item.context_length)
        ? item.context_length
        : 0;
    const { capabilities, category } = classifyFreeModel(item);

    normalized.push({
      id,
      name: rawName,
      provider,
      contextLength,
      isFree: true,
      capabilities,
      category,
    });
  }

  normalized.sort((a, b) => {
    const idxA = PRIORITY_FREE_MODEL_ORDER.indexOf(a.id);
    const idxB = PRIORITY_FREE_MODEL_ORDER.indexOf(b.id);
    if (idxA !== -1 || idxB !== -1) {
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    }
    return a.name.localeCompare(b.name);
  });

  return normalized;
}

export async function fetchOpenRouterKeyStatus(
  apiKey: string,
  referer: string,
  forceRefresh = false
): Promise<OpenRouterKeyStatus> {
  if (!apiKey) {
    return {
      configured: false,
      valid: null,
      isFreeTier: null,
      limitRemaining: null,
    };
  }

  const cached = keyStatusCache.get(apiKey);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < 60_000) {
    return cached.status;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/key`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': referer,
        'X-Title': 'AI Craft',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const status: OpenRouterKeyStatus = {
        configured: true,
        valid: res.status === 401 || res.status === 403 ? false : null,
        isFreeTier: null,
        limitRemaining: null,
      };
      keyStatusCache.set(apiKey, { status, fetchedAt: Date.now() });
      return status;
    }
    const json = (await res.json()) as {
      data?: {
        is_free_tier?: boolean;
        limit_remaining?: number | null;
      };
    };
    const status: OpenRouterKeyStatus = {
      configured: true,
      valid: true,
      isFreeTier:
        typeof json?.data?.is_free_tier === 'boolean'
          ? json.data.is_free_tier
          : null,
      limitRemaining:
        typeof json?.data?.limit_remaining === 'number'
          ? json.data.limit_remaining
          : null,
    };
    keyStatusCache.set(apiKey, { status, fetchedAt: Date.now() });
    return status;
  } catch {
    return {
      configured: true,
      valid: null,
      isFreeTier: null,
      limitRemaining: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchFreeOpenRouterCatalog(
  apiKey: string,
  referer: string
): Promise<NormalizedOpenRouterModel[]> {
  const headers: Record<string, string> = {
    'HTTP-Referer': referer,
    'X-Title': 'AI Craft',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(
      `Failed to fetch OpenRouter models (${response.status})${
        errText ? `: ${errText.slice(0, 140)}` : ''
      }`
    );
  }

  const json = (await response.json()) as { data?: OpenRouterApiModel[] };
  const rawList = Array.isArray(json?.data) ? json.data : [];
  return normalizeFreeOpenRouterModels(rawList);
}

export function isCandidateFreeOpenRouterModel(
  modelId: string | undefined,
  catalog: NormalizedOpenRouterModel[]
): boolean {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  if (!id || isRestrictedHarnessModel(id)) return false;
  if (id === 'openrouter/auto') return false;
  if (catalog.length > 0) {
    return catalog.some((m) => m.id === id && m.isFree);
  }
  return id === 'openrouter/free' || id.endsWith(':free');
}

export function resolveFreeModelInfo(
  modelId: string,
  catalog: NormalizedOpenRouterModel[]
): { id: string; name: string; provider: string } {
  const found = catalog.find((m) => m.id === modelId);
  if (found) {
    return { id: found.id, name: found.name, provider: found.provider };
  }
  const slashIdx = modelId.indexOf('/');
  const provider = slashIdx > 0 ? modelId.slice(0, slashIdx) : 'openrouter';
  const shortName = slashIdx > 0 ? modelId.slice(slashIdx + 1) : modelId;
  return { id: modelId, name: shortName, provider };
}
