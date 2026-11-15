import {
  OPENROUTER_BASE_URL,
  cleanEnvKey,
  fetchFreeOpenRouterCatalog,
  fetchOpenRouterKeyStatus,
  getGeminiApiKeyPool,
  getOpenRouterApiKeyPool,
  isCandidateFreeOpenRouterModel,
  isTextToSpeechModel,
  parseEnvKeyPool,
  resolveFreeModelInfo,
  type FreeModelCategory,
  type NormalizedOpenRouterModel,
  type OpenRouterKeyStatus,
} from './_openrouterModels.js';

export type AiGatewayId =
  | 'openrouter'
  | 'huggingface'
  | 'ngrok'
  | 'pollinations'
  | 'gemini';

export interface UnifiedAiModel extends NormalizedOpenRouterModel {
  gateway: AiGatewayId;
  upstreamModelId: string;
  tierLabel?: string;
}

export interface GatewayStatusSummary {
  id: AiGatewayId;
  label: string;
  baseUrl: string;
  configured: boolean;
  keyCount: number;
  modelCount: number;
  defaultModel: string;
  keyStatus?: OpenRouterKeyStatus;
}

export interface GatewayExecutionCandidate {
  gateway: AiGatewayId;
  gatewayLabel: string;
  baseUrl: string;
  apiKey: string;
  /** Prefixed or unique ID used by the UI & SSE meta events */
  publicModelId: string;
  /** Exact model ID sent in the upstream API request body */
  upstreamModelId: string;
  modelName: string;
  provider: string;
  isOpenRouter?: boolean;
  cooldownKey: string;
}

export const DEFAULT_HUGGING_FACE_BASE_URL = 'https://router.huggingface.co/v1';
export const DEFAULT_HUGGING_FACE_INFERENCE_URL =
  'https://router.huggingface.co/hf-inference/models';
export const DEFAULT_NGROK_AI_GATEWAY_URL = 'https://gateway.ngrok.ai/v1';
export const DEFAULT_POLLINATIONS_TEXT_URL = 'https://text.pollinations.ai';
export const DEFAULT_POLLINATIONS_IMAGE_URL = 'https://image.pollinations.ai';

const DEFAULT_GATEWAY_ORDER: AiGatewayId[] = [
  'openrouter',
  'huggingface',
  'ngrok',
  'pollinations',
  'gemini',
];

// Rate-limit & quota cooldown tracker so throttled models/keys are automatically
// skipped in favor of fresh free models & gateways until cooldown expires.
const endpointCooldowns = new Map<string, number>();

export function buildCandidateCooldownKey(
  gateway: AiGatewayId,
  apiKey: string,
  upstreamModelId: string
): string {
  const keyTail = apiKey ? apiKey.slice(-6) : 'nokey';
  return `${gateway}:${keyTail}:${upstreamModelId}`;
}

export function markGatewayCandidateCooldown(
  cooldownKey: string,
  cooldownMs = 75_000
): void {
  endpointCooldowns.set(cooldownKey, Date.now() + cooldownMs);
}

export function isGatewayCandidateCoolingDown(cooldownKey: string): boolean {
  const until = endpointCooldowns.get(cooldownKey);
  if (!until) return false;
  if (Date.now() >= until) {
    endpointCooldowns.delete(cooldownKey);
    return false;
  }
  return true;
}

export const HUGGING_FACE_IMAGE_FALLBACKS: Array<{
  id: string;
  name: string;
}> = [
  {
    id: 'black-forest-labs/FLUX.1-schnell',
    name: 'HF: FLUX.1 Schnell (Image)',
  },
  {
    id: 'stabilityai/stable-diffusion-xl-base-1.0',
    name: 'HF: Stable Diffusion XL (Image)',
  },
  {
    id: 'Tongyi-MAI/Z-Image-Turbo',
    name: 'HF: Z-Image Turbo (Image)',
  },
  {
    id: 'stabilityai/stable-diffusion-3.5-medium',
    name: 'HF: Stable Diffusion 3.5 Medium (Image)',
  },
];

export const HUGGING_FACE_MUSIC_FALLBACKS: Array<{
  id: string;
  name: string;
}> = [
  {
    id: 'stabilityai/stable-audio-3-medium',
    name: 'HF: Stable Audio 3 Medium (Music)',
  },
  {
    id: 'stabilityai/stable-audio-open-1.0',
    name: 'HF: Stable Audio Open 1.0 (Music)',
  },
  {
    id: 'facebook/musicgen-small',
    name: 'HF: MusicGen Small (Music)',
  },
];

export const HUGGING_FACE_VIDEO_FALLBACKS: Array<{
  id: string;
  name: string;
}> = [
  {
    id: 'Wan-AI/Wan2.2-TI2V-5B',
    name: 'HF: Wan 2.2 TI2V 5B (Video)',
  },
  {
    id: 'Wan-AI/Wan2.1-T2V-1.3B',
    name: 'HF: Wan 2.1 T2V 1.3B (Video)',
  },
  {
    id: 'tencent/HunyuanVideo',
    name: 'HF: HunyuanVideo (Video)',
  },
  {
    id: 'Lightricks/LTX-Video-0.9.5',
    name: 'HF: LTX Video 0.9.5 (Video)',
  },
];

export const POLLINATIONS_FALLBACK_MODELS: UnifiedAiModel[] = [
  {
    id: 'pollinations::openai-fast',
    upstreamModelId: 'openai-fast',
    gateway: 'pollinations',
    name: 'Pollinations: GPT-OSS 20B (Built-in Free)',
    provider: 'pollinations',
    contextLength: 128000,
    isFree: true,
    tierLabel: 'Built-in Free',
    capabilities: ['Code', 'Build', 'Reasoning'],
    category: 'code',
  },
  {
    id: 'pollinations::sana',
    upstreamModelId: 'sana',
    gateway: 'pollinations',
    name: 'Pollinations: Sana Image (Built-in Free)',
    provider: 'pollinations',
    contextLength: 0,
    isFree: true,
    tierLabel: 'Built-in Free',
    capabilities: ['Image'],
    category: 'image',
  },
  {
    id: 'pollinations::music-composer',
    upstreamModelId: 'music-composer',
    gateway: 'pollinations',
    name: 'AI Craft: Free Music Studio (Built-in)',
    provider: 'pollinations',
    contextLength: 0,
    isFree: true,
    tierLabel: 'Built-in Free',
    capabilities: ['Music'],
    category: 'music',
  },
];

const CURATED_HUGGING_FACE_CODE_MODELS: Array<{
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  isFree: boolean;
  capabilities: string[];
  category: FreeModelCategory;
  tierLabel: string;
}> = [
  {
    id: 'deepseek-ai/DeepSeek-V4-Flash:cheapest',
    name: 'HF: DeepSeek V4 Flash (Free Credit)',
    provider: 'deepseek-ai',
    contextLength: 1048576,
    isFree: true,
    capabilities: ['Code', 'Build', 'Reasoning'],
    category: 'code',
    tierLabel: 'Free Tier',
  },
  {
    id: 'google/gemma-4-31B-it:cheapest',
    name: 'HF: Gemma 4 31B IT (Free Credit)',
    provider: 'google',
    contextLength: 262144,
    isFree: true,
    capabilities: ['Code', 'Build', 'Vision'],
    category: 'code',
    tierLabel: 'Free Tier',
  },
  {
    id: 'Qwen/Qwen3.8-Flash-Next-FP8:cheapest',
    name: 'HF: Qwen 3.8 Flash (Free Credit)',
    provider: 'Qwen',
    contextLength: 1048576,
    isFree: true,
    capabilities: ['Code', 'Build'],
    category: 'code',
    tierLabel: 'Free Tier',
  },
  {
    id: 'openai/gpt-oss-120b:cheapest',
    name: 'HF: GPT-OSS 120B (Free Credit)',
    provider: 'openai',
    contextLength: 131072,
    isFree: true,
    capabilities: ['Code', 'Build'],
    category: 'code',
    tierLabel: 'Free Tier',
  },
  {
    id: 'zai-org/GLM-5.3-Flash:cheapest',
    name: 'HF: GLM 5.3 Flash (Free Credit)',
    provider: 'zai-org',
    contextLength: 1048576,
    isFree: true,
    capabilities: ['Code', 'Build'],
    category: 'code',
    tierLabel: 'Free Tier',
  },
  {
    id: 'meta-llama/Llama-3.1-8B-Instruct:cheapest',
    name: 'HF: Llama 3.1 8B Instruct (Free Credit)',
    provider: 'meta-llama',
    contextLength: 131072,
    isFree: true,
    capabilities: ['Code', 'Build'],
    category: 'code',
    tierLabel: 'Free Tier',
  },
];

function normalizeBaseUrl(raw: string | undefined, fallback: string): string {
  const cleaned = cleanEnvKey(raw, []);
  if (!cleaned) return fallback;
  return cleaned.replace(/\/+$/, '');
}

export function getOpenRouterBaseUrl(): string {
  return normalizeBaseUrl(process.env.OPENROUTER_BASE_URL, OPENROUTER_BASE_URL);
}

export function getHuggingFaceBaseUrl(): string {
  return normalizeBaseUrl(
    process.env.HUGGING_FACE_BASE_URL || process.env.HF_ROUTER_BASE_URL,
    DEFAULT_HUGGING_FACE_BASE_URL
  );
}

export function getNgrokGatewayBaseUrl(): string {
  return normalizeBaseUrl(
    process.env.NGROK_AI_GATEWAY_URL ||
      process.env.NGROK_GATEWAY_URL ||
      process.env.NGROK_BASE_URL,
    DEFAULT_NGROK_AI_GATEWAY_URL
  );
}

export function getHuggingFaceApiKeyPool(): string[] {
  const candidates = [
    process.env.HUGGING_FACE_API_KEY,
    process.env.HUGGING_FACE_API_KEY_2,
    process.env.HUGGING_FACE_API_KEY_3,
    process.env.HUGGING_FACE_API_KEY_4,
    process.env.HUGGING_FACE_API_KEY_5,
    process.env.HUGGINGFACE_API_KEY,
    process.env.HUGGING_FACE_TOKEN,
    process.env.HUGGINGFACE_TOKEN,
    process.env.HF_TOKEN,
    process.env.HF_TOKEN_2,
    process.env.HF_API_KEY,
    process.env.NEXT_PUBLIC_HUGGING_FACE_API_KEY,
    process.env.VITE_HUGGING_FACE_API_KEY,
  ];
  return parseEnvKeyPool(candidates, [
    'MY_HUGGING_FACE_API_KEY',
    'MY_HF_TOKEN',
  ]);
}

export function getHuggingFaceApiKey(): string {
  return getHuggingFaceApiKeyPool()[0] || '';
}

export function getNgrokApiKeyPool(): string[] {
  const candidates = [
    process.env.NGROK_API_KEY,
    process.env.NGROK_API_KEY_2,
    process.env.NGROK_API_KEY_3,
    process.env.NGROK_API_KEY_4,
    process.env.NGROK_API_KEY_5,
    process.env.NGROK_AI_GATEWAY_KEY,
    process.env.NGROK_GATEWAY_API_KEY,
    process.env.NGROK_GATEWAY_KEY,
    process.env.NGROK_TOKEN,
    process.env.NGROK_AUTHTOKEN,
    process.env.NEXT_PUBLIC_NGROK_API_KEY,
    process.env.VITE_NGROK_API_KEY,
  ];
  return parseEnvKeyPool(candidates, ['MY_NGROK_API_KEY']);
}

export function getNgrokApiKey(): string {
  return getNgrokApiKeyPool()[0] || '';
}

export function getGatewayOrder(): AiGatewayId[] {
  const rawPrimary = cleanEnvKey(process.env.AI_PRIMARY_GATEWAY, []).toLowerCase();
  const rawOrder = cleanEnvKey(process.env.AI_GATEWAY_ORDER, []).toLowerCase();

  const order: AiGatewayId[] = [];
  const pushValid = (token: string) => {
    const t = token.trim();
    const mapped: AiGatewayId | null =
      t === 'openrouter' || t === 'or'
        ? 'openrouter'
        : t === 'huggingface' || t === 'hugging_face' || t === 'hf'
          ? 'huggingface'
          : t === 'ngrok' || t === 'ngrok_ai'
            ? 'ngrok'
            : t === 'pollinations' || t === 'public'
              ? 'pollinations'
              : t === 'gemini' || t === 'google'
                ? 'gemini'
                : null;
    if (mapped && !order.includes(mapped)) {
      order.push(mapped);
    }
  };

  if (rawPrimary) pushValid(rawPrimary);
  if (rawOrder) {
    for (const part of rawOrder.split(',')) {
      pushValid(part);
    }
  }
  for (const fallback of DEFAULT_GATEWAY_ORDER) {
    if (!order.includes(fallback)) order.push(fallback);
  }
  return order;
}

export function parseGatewayModelIdentifier(
  rawId: string | undefined,
  explicitGateway?: string
): { gateway?: AiGatewayId; upstreamModelId: string } {
  const trimmed = typeof rawId === 'string' ? rawId.trim() : '';
  const cleanExplicit =
    typeof explicitGateway === 'string'
      ? explicitGateway.trim().toLowerCase()
      : '';

  const explicitGw: AiGatewayId | undefined =
    cleanExplicit === 'openrouter'
      ? 'openrouter'
      : cleanExplicit === 'huggingface' || cleanExplicit === 'hf'
        ? 'huggingface'
        : cleanExplicit === 'ngrok'
          ? 'ngrok'
          : cleanExplicit === 'pollinations'
            ? 'pollinations'
            : cleanExplicit === 'gemini'
              ? 'gemini'
              : undefined;

  if (trimmed.startsWith('hf::')) {
    return { gateway: 'huggingface', upstreamModelId: trimmed.slice(4).trim() };
  }
  if (trimmed.startsWith('huggingface::')) {
    return { gateway: 'huggingface', upstreamModelId: trimmed.slice(13).trim() };
  }
  if (trimmed.startsWith('ngrok::')) {
    return { gateway: 'ngrok', upstreamModelId: trimmed.slice(7).trim() };
  }
  if (trimmed.startsWith('pollinations::')) {
    return { gateway: 'pollinations', upstreamModelId: trimmed.slice(14).trim() };
  }
  if (trimmed.startsWith('openrouter::')) {
    return { gateway: 'openrouter', upstreamModelId: trimmed.slice(12).trim() };
  }
  if (
    trimmed === 'google/gemini-4-hydrogen' ||
    trimmed === 'gemini-4-hydrogen'
  ) {
    return {
      gateway: explicitGw || 'gemini',
      upstreamModelId: 'gemini-4-hydrogen',
    };
  }
  return { gateway: explicitGw, upstreamModelId: trimmed };
}

interface HfRouterProviderEntry {
  provider?: string;
  status?: string;
  context_length?: number;
  pricing?: { input?: number; output?: number };
  is_free?: boolean;
}

interface HfRouterModelItem {
  id?: string;
  owned_by?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  providers?: HfRouterProviderEntry[];
}

interface HfHubModelItem {
  id?: string;
  tags?: string[];
  pipeline_tag?: string;
}

function classifyGatewayModelCapabilities(
  modelId: string,
  inMods: string[] = [],
  outMods: string[] = [],
  contextLength = 0
): { capabilities: string[]; category: FreeModelCategory } {
  const blob = modelId.toLowerCase();
  const caps: string[] = [];
  const canVideo =
    outMods.includes('video') ||
    /(?:text-to-video|t2v|ti2v|hunyuanvideo|ltx-video|wan2|cogvideo|mochi-1|sora|veo)/.test(
      blob
    );
  const canImage =
    !canVideo &&
    (outMods.includes('image') ||
      /(?:flux|stable-diffusion|sdxl|z-image|qwen-image|krea|ideogram|dall-e|imagen|sana|gpt-image)/.test(
        blob
      ));
  const canMusic =
    !canVideo &&
    (outMods.includes('audio') ||
      /(?:stable-audio|musicgen|audiogen|riffusion|music)/.test(blob)) &&
    !isTextToSpeechModel(blob);
  const canVision = inMods.includes('image') || inMods.includes('video');
  const canCode =
    !canVideo &&
    !canImage &&
    !canMusic &&
    (/code|coder|deepseek|qwen|gemma|llama|gpt-oss|gpt-4|gpt-5|claude|gemini|glm|flash|mini|instruct|reasoning|ultra|super|particle|openai-fast/.test(
      blob
    ) ||
      contextLength >= 16000);

  if (canVideo) caps.push('Video');
  if (canImage) caps.push('Image');
  if (canMusic) caps.push('Music');
  if (canCode) {
    caps.push('Code');
    caps.push('Build');
  }
  if (canVision) caps.push('Vision');
  if (caps.length === 0) caps.push('Chat');

  const category: FreeModelCategory = canVideo
    ? 'video'
    : canImage
      ? 'image'
      : canMusic
        ? 'music'
        : canCode
          ? 'code'
          : 'chat';

  return { capabilities: caps, category };
}

async function fetchWarmHuggingFaceMediaModels(
  apiKey: string
): Promise<UnifiedAiModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);

  const imageModels: UnifiedAiModel[] = [];
  const musicModels: UnifiedAiModel[] = [];
  const videoModels: UnifiedAiModel[] = [];

  try {
    const [imgRes, audioRes, videoRes] = await Promise.all([
      fetch(
        'https://huggingface.co/api/models?pipeline_tag=text-to-image&inference=warm&sort=downloads&direction=-1&limit=10',
        { headers, signal: controller.signal }
      ).catch(() => null),
      fetch(
        'https://huggingface.co/api/models?pipeline_tag=text-to-audio&inference=warm&sort=downloads&direction=-1&limit=15',
        { headers, signal: controller.signal }
      ).catch(() => null),
      fetch(
        'https://huggingface.co/api/models?pipeline_tag=text-to-video&inference=warm&sort=downloads&direction=-1&limit=12',
        { headers, signal: controller.signal }
      ).catch(() => null),
    ]);

    const seenImg = new Set<string>();
    if (imgRes && imgRes.ok) {
      const list = (await imgRes.json()) as HfHubModelItem[];
      if (Array.isArray(list)) {
        for (const item of list) {
          const id = typeof item?.id === 'string' ? item.id.trim() : '';
          if (!id || seenImg.has(id)) continue;
          const tagsBlob = `${id} ${(item.tags || []).join(' ')}`;
          if (isTextToSpeechModel(tagsBlob)) continue;
          if (/nsfw|lora/i.test(tagsBlob)) continue;
          seenImg.add(id);
          const shortName = id.split('/').pop() || id;
          imageModels.push({
            id: `hf::${id}`,
            upstreamModelId: id,
            gateway: 'huggingface',
            name: `HF: ${shortName} (Image)`,
            provider: 'huggingface',
            contextLength: 0,
            isFree: true,
            tierLabel: 'Free Tier',
            capabilities: ['Image'],
            category: 'image',
          });
          if (imageModels.length >= 6) break;
        }
      }
    }

    const seenMusic = new Set<string>();
    if (audioRes && audioRes.ok) {
      const list = (await audioRes.json()) as HfHubModelItem[];
      if (Array.isArray(list)) {
        for (const item of list) {
          const id = typeof item?.id === 'string' ? item.id.trim() : '';
          if (!id || seenMusic.has(id)) continue;
          const tags = Array.isArray(item.tags) ? item.tags.join(' ') : '';
          const tagsBlob = `${id} ${tags}`;
          // Strictly filter out TTS/speech models — keep ONLY music/sound generation
          if (isTextToSpeechModel(tagsBlob)) continue;
          if (!/music|stable-audio|audiogen|riffusion|song|instrumental/i.test(tagsBlob)) {
            continue;
          }
          seenMusic.add(id);
          const shortName = id.split('/').pop() || id;
          musicModels.push({
            id: `hf::${id}`,
            upstreamModelId: id,
            gateway: 'huggingface',
            name: `HF: ${shortName} (Music)`,
            provider: 'huggingface',
            contextLength: 0,
            isFree: true,
            tierLabel: 'Free Tier',
            capabilities: ['Music'],
            category: 'music',
          });
          if (musicModels.length >= 4) break;
        }
      }
    }

    const seenVideo = new Set<string>();
    if (videoRes && videoRes.ok) {
      const list = (await videoRes.json()) as HfHubModelItem[];
      if (Array.isArray(list)) {
        for (const item of list) {
          const id = typeof item?.id === 'string' ? item.id.trim() : '';
          if (!id || seenVideo.has(id)) continue;
          const tags = Array.isArray(item.tags) ? item.tags.join(' ') : '';
          const tagsBlob = `${id} ${tags}`;
          if (isTextToSpeechModel(tagsBlob)) continue;
          if (/lora|nsfw|controlnet|adapter/i.test(tagsBlob)) continue;
          seenVideo.add(id);
          const shortName = id.split('/').pop() || id;
          videoModels.push({
            id: `hf::${id}`,
            upstreamModelId: id,
            gateway: 'huggingface',
            name: `HF: ${shortName} (Video)`,
            provider: 'huggingface',
            contextLength: 0,
            isFree: true,
            tierLabel: 'Free Tier',
            capabilities: ['Video'],
            category: 'video',
          });
          if (videoModels.length >= 5) break;
        }
      }
    }
  } catch {
    // Fall back to curated warm models below
  } finally {
    clearTimeout(timer);
  }

  for (const fb of HUGGING_FACE_IMAGE_FALLBACKS) {
    if (!imageModels.some((m) => m.upstreamModelId === fb.id)) {
      imageModels.push({
        id: `hf::${fb.id}`,
        upstreamModelId: fb.id,
        gateway: 'huggingface',
        name: fb.name,
        provider: 'huggingface',
        contextLength: 0,
        isFree: true,
        tierLabel: 'Free Tier',
        capabilities: ['Image'],
        category: 'image',
      });
    }
  }

  for (const fb of HUGGING_FACE_MUSIC_FALLBACKS) {
    if (!musicModels.some((m) => m.upstreamModelId === fb.id)) {
      musicModels.push({
        id: `hf::${fb.id}`,
        upstreamModelId: fb.id,
        gateway: 'huggingface',
        name: fb.name,
        provider: 'huggingface',
        contextLength: 0,
        isFree: true,
        tierLabel: 'Free Tier',
        capabilities: ['Music'],
        category: 'music',
      });
    }
  }

  for (const fb of HUGGING_FACE_VIDEO_FALLBACKS) {
    if (!videoModels.some((m) => m.upstreamModelId === fb.id)) {
      videoModels.push({
        id: `hf::${fb.id}`,
        upstreamModelId: fb.id,
        gateway: 'huggingface',
        name: fb.name,
        provider: 'huggingface',
        contextLength: 0,
        isFree: true,
        tierLabel: 'Free Tier',
        capabilities: ['Video'],
        category: 'video',
      });
    }
  }

  return [
    ...imageModels.slice(0, 6),
    ...musicModels.slice(0, 4),
    ...videoModels.slice(0, 5),
  ];
}

export async function fetchPollinationsCatalog(): Promise<UnifiedAiModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2800);
  const collected: UnifiedAiModel[] = [];
  const seen = new Set<string>();

  try {
    const [textRes, imgRes] = await Promise.all([
      fetch(`${DEFAULT_POLLINATIONS_TEXT_URL}/models`, {
        signal: controller.signal,
      }).catch(() => null),
      fetch(`${DEFAULT_POLLINATIONS_IMAGE_URL}/models`, {
        signal: controller.signal,
      }).catch(() => null),
    ]);

    if (textRes && textRes.ok) {
      const list = (await textRes.json()) as Array<{
        name?: string;
        description?: string;
        tier?: string;
        output_modalities?: string[];
      }>;
      if (Array.isArray(list)) {
        for (const item of list) {
          const id = typeof item?.name === 'string' ? item.name.trim() : '';
          if (!id || seen.has(`text:${id}`)) continue;
          const outMods = Array.isArray(item.output_modalities)
            ? item.output_modalities.map((m) => String(m).toLowerCase())
            : ['text'];
          // Strictly skip audio/TTS text endpoints on Pollinations
          if (outMods.includes('audio')) continue;
          if (isTextToSpeechModel(`${id} ${item.description || ''}`)) continue;
          seen.add(`text:${id}`);
          collected.push({
            id: `pollinations::${id}`,
            upstreamModelId: id,
            gateway: 'pollinations',
            name: `Pollinations: ${item.description || id}`,
            provider: 'pollinations',
            contextLength: 128000,
            isFree: true,
            tierLabel: 'Built-in Free',
            capabilities: ['Code', 'Build', 'Reasoning'],
            category: 'code',
          });
        }
      }
    }

    if (imgRes && imgRes.ok) {
      const list = (await imgRes.json()) as Array<string | { name?: string }>;
      if (Array.isArray(list)) {
        for (const item of list) {
          const id =
            typeof item === 'string'
              ? item.trim()
              : typeof item?.name === 'string'
                ? item.name.trim()
                : '';
          if (!id || seen.has(`img:${id}`)) continue;
          if (isTextToSpeechModel(id)) continue;
          seen.add(`img:${id}`);
          collected.push({
            id: `pollinations::${id}`,
            upstreamModelId: id,
            gateway: 'pollinations',
            name: `Pollinations: ${id.charAt(0).toUpperCase() + id.slice(1)} (Image)`,
            provider: 'pollinations',
            contextLength: 0,
            isFree: true,
            tierLabel: 'No Key Needed',
            capabilities: ['Image'],
            category: 'image',
          });
        }
      }
    }
  } catch {
    // Use curated fallbacks below
  } finally {
    clearTimeout(timer);
  }

  for (const fb of POLLINATIONS_FALLBACK_MODELS) {
    if (!collected.some((m) => m.id === fb.id)) {
      collected.push(fb);
    }
  }

  return collected;
}

export async function fetchHuggingFaceCatalog(
  apiKey: string
): Promise<UnifiedAiModel[]> {
  if (!apiKey) return [];

  const baseUrl = getHuggingFaceBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);

  let codeModels: UnifiedAiModel[] = [];

  try {
    const [routerRes, mediaModels] = await Promise.all([
      fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      }).catch(() => null),
      fetchWarmHuggingFaceMediaModels(apiKey),
    ]);

    if (routerRes && routerRes.ok) {
      const json = (await routerRes.json()) as { data?: HfRouterModelItem[] };
      const rawList = Array.isArray(json?.data) ? json.data : [];

      type ScoredHfModel = {
        model: UnifiedAiModel;
        isFree: boolean;
        costScore: number;
        priorityRank: number;
      };

      const priorityPrefixes = [
        'deepseek-ai/deepseek-v4-flash',
        'google/gemma-4-31b-it',
        'qwen/qwen3.8-flash',
        'openai/gpt-oss-120b',
        'zai-org/glm-5.3-flash',
        'meta-llama/llama-3.1-8b-instruct',
        'google/gemma-4-26b-a4b-it',
        'meta-llama/llama-3.3-70b-instruct',
        'openai/gpt-oss-20b',
      ];

      const collected: ScoredHfModel[] = [];
      const seen = new Set<string>();
      const defaultEnvModel = cleanEnvKey(
        process.env.HUGGING_FACE_DEFAULT_MODEL,
        []
      );

      for (const item of rawList) {
        const baseId = typeof item?.id === 'string' ? item.id.trim() : '';
        if (!baseId || seen.has(baseId)) continue;
        if (isTextToSpeechModel(baseId)) continue;
        if (/abliterat|stheno|roleplay|nsfw|uncensored/i.test(baseId)) continue;

        const liveProviders = Array.isArray(item.providers)
          ? item.providers.filter((p) => p?.status === 'live')
          : [];
        if (liveProviders.length === 0) continue;

        const freeProvider = liveProviders.find(
          (p) =>
            p.is_free === true ||
            (p.pricing &&
              Number(p.pricing.input) === 0 &&
              Number(p.pricing.output) === 0)
        );

        const cheapestProvider = [...liveProviders].sort((a, b) => {
          const aCost =
            (Number(a.pricing?.input) || 999) + (Number(a.pricing?.output) || 999);
          const bCost =
            (Number(b.pricing?.input) || 999) + (Number(b.pricing?.output) || 999);
          return aCost - bCost;
        })[0];

        const chosenProvider = freeProvider || cheapestProvider;
        const inCost = Number(chosenProvider?.pricing?.input ?? 99);
        const outCost = Number(chosenProvider?.pricing?.output ?? 99);
        const isStrictlyFree = Boolean(freeProvider);
        const isFreeCreditEligible = inCost <= 0.25 && outCost <= 0.8;

        if (!isStrictlyFree && !isFreeCreditEligible && baseId !== defaultEnvModel) {
          continue;
        }

        seen.add(baseId);
        const inMods = Array.isArray(item.architecture?.input_modalities)
          ? item.architecture!.input_modalities.map((m) => String(m).toLowerCase())
          : [];
        const outMods = Array.isArray(item.architecture?.output_modalities)
          ? item.architecture!.output_modalities.map((m) => String(m).toLowerCase())
          : [];
        const ctx = Number(chosenProvider?.context_length || 0);
        const { capabilities, category } = classifyGatewayModelCapabilities(
          baseId,
          inMods,
          outMods,
          ctx
        );

        const routedUpstreamId =
          isStrictlyFree && freeProvider?.provider
            ? `${baseId}:${freeProvider.provider}`
            : `${baseId}:cheapest`;

        const shortName = baseId.includes('/') ? baseId.split('/')[1] : baseId;
        const priorityIdx = priorityPrefixes.findIndex((prefix) =>
          baseId.toLowerCase().startsWith(prefix)
        );

        collected.push({
          isFree: isStrictlyFree,
          costScore: inCost + outCost,
          priorityRank: priorityIdx === -1 ? 999 : priorityIdx,
          model: {
            id: `hf::${routedUpstreamId}`,
            upstreamModelId: routedUpstreamId,
            gateway: 'huggingface',
            name: `HF: ${shortName}`,
            provider: 'huggingface',
            contextLength: ctx,
            isFree: true,
            tierLabel: isStrictlyFree ? 'Free' : 'Free Credit',
            capabilities,
            category,
          },
        });
      }

      collected.sort((a, b) => {
        if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
        if (a.costScore !== b.costScore) return a.costScore - b.costScore;
        return a.model.name.localeCompare(b.model.name);
      });

      codeModels = collected.slice(0, 12).map((c) => c.model);

      if (
        defaultEnvModel &&
        !isTextToSpeechModel(defaultEnvModel) &&
        !codeModels.some((m) => m.upstreamModelId === defaultEnvModel)
      ) {
        const { capabilities, category } =
          classifyGatewayModelCapabilities(defaultEnvModel);
        codeModels.unshift({
          id: `hf::${defaultEnvModel}`,
          upstreamModelId: defaultEnvModel,
          gateway: 'huggingface',
          name: `HF: ${defaultEnvModel.split('/').pop() || defaultEnvModel}`,
          provider: 'huggingface',
          contextLength: 131072,
          isFree: true,
          tierLabel: 'Configured',
          capabilities,
          category,
        });
      }
    }

    if (codeModels.length === 0) {
      codeModels = buildFallbackHuggingFaceCodeModels();
    }

    return [...codeModels, ...mediaModels];
  } catch {
    return [
      ...buildFallbackHuggingFaceCodeModels(),
      ...HUGGING_FACE_IMAGE_FALLBACKS.map((fb) => ({
        id: `hf::${fb.id}`,
        upstreamModelId: fb.id,
        gateway: 'huggingface' as const,
        name: fb.name,
        provider: 'huggingface',
        contextLength: 0,
        isFree: true,
        tierLabel: 'Free Tier',
        capabilities: ['Image'],
        category: 'image' as const,
      })),
      ...HUGGING_FACE_MUSIC_FALLBACKS.map((fb) => ({
        id: `hf::${fb.id}`,
        upstreamModelId: fb.id,
        gateway: 'huggingface' as const,
        name: fb.name,
        provider: 'huggingface',
        contextLength: 0,
        isFree: true,
        tierLabel: 'Free Tier',
        capabilities: ['Music'],
        category: 'music' as const,
      })),
      ...HUGGING_FACE_VIDEO_FALLBACKS.map((fb) => ({
        id: `hf::${fb.id}`,
        upstreamModelId: fb.id,
        gateway: 'huggingface' as const,
        name: fb.name,
        provider: 'huggingface',
        contextLength: 0,
        isFree: true,
        tierLabel: 'Free Tier',
        capabilities: ['Video'],
        category: 'video' as const,
      })),
    ];
  } finally {
    clearTimeout(timer);
  }
}

function buildFallbackHuggingFaceCodeModels(): UnifiedAiModel[] {
  const defaultEnvModel = cleanEnvKey(process.env.HUGGING_FACE_DEFAULT_MODEL, []);
  const list: UnifiedAiModel[] = CURATED_HUGGING_FACE_CODE_MODELS.map((m) => ({
    ...m,
    id: `hf::${m.id}`,
    upstreamModelId: m.id,
    gateway: 'huggingface' as const,
    provider: 'huggingface',
  }));
  if (
    defaultEnvModel &&
    !isTextToSpeechModel(defaultEnvModel) &&
    !list.some((m) => m.upstreamModelId === defaultEnvModel)
  ) {
    const { capabilities, category } =
      classifyGatewayModelCapabilities(defaultEnvModel);
    list.unshift({
      id: `hf::${defaultEnvModel}`,
      upstreamModelId: defaultEnvModel,
      gateway: 'huggingface',
      name: `HF: ${defaultEnvModel.split('/').pop() || defaultEnvModel}`,
      provider: 'huggingface',
      contextLength: 131072,
      isFree: true,
      tierLabel: 'Configured',
      capabilities,
      category,
    });
  }
  return list;
}

interface NgrokModelItem {
  id?: string;
  name?: string;
  owned_by?: string;
  context_length?: number;
}

export async function fetchNgrokCatalog(apiKey: string): Promise<UnifiedAiModel[]> {
  if (!apiKey) return [];

  const baseUrl = getNgrokGatewayBaseUrl();
  const defaultEnvModel = cleanEnvKey(process.env.NGROK_DEFAULT_MODEL, []);
  const extraEnvModels = cleanEnvKey(process.env.NGROK_MODELS, [])
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);

  const collected: UnifiedAiModel[] = [];
  const seen = new Set<string>();

  const pushNgrokModel = (
    rawId: string,
    rawName?: string,
    contextLength = 128000,
    explicitTier?: string
  ) => {
    const cleanId = rawId.trim();
    if (!cleanId || seen.has(cleanId)) return;
    if (isTextToSpeechModel(`${cleanId} ${rawName || ''}`)) return;
    seen.add(cleanId);

    const lower = cleanId.toLowerCase();
    const isFreeTag = lower.endsWith(':free') || lower.includes('free');
    const isLowCostTag =
      isFreeTag ||
      /mini|flash|nano|haiku|small|lite|8b|cheapest|local|ollama/.test(lower);
    const { capabilities, category } = classifyGatewayModelCapabilities(
      cleanId,
      [],
      [],
      contextLength
    );
    const shortName = rawName?.trim() || cleanId;

    collected.push({
      id: `ngrok::${cleanId}`,
      upstreamModelId: cleanId,
      gateway: 'ngrok',
      name: shortName.toLowerCase().startsWith('ngrok')
        ? shortName
        : `ngrok: ${shortName}`,
      provider: 'ngrok',
      contextLength,
      isFree: isFreeTag || isLowCostTag,
      tierLabel:
        explicitTier || (isFreeTag ? 'Free' : isLowCostTag ? 'Low Cost' : 'Gateway'),
      capabilities,
      category,
    });
  };

  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (res.ok) {
      const json = (await res.json()) as { data?: NgrokModelItem[] } | NgrokModelItem[];
      const rawList = Array.isArray(json)
        ? json
        : Array.isArray(json?.data)
          ? json.data
          : [];

      const sorted = [...rawList]
        .filter((item) => {
          const id = (item?.id || '').toLowerCase();
          return (
            Boolean(id) &&
            !isTextToSpeechModel(id) &&
            !/abliterat|stheno|roleplay|nsfw|uncensored/i.test(id)
          );
        })
        .sort((a, b) => {
          const aId = (a.id || '').toLowerCase();
          const bId = (b.id || '').toLowerCase();
          const score = (id: string) => {
            if (id.endsWith(':free') || id.includes('free')) return 0;
            if (/deepseek|gemini|claude|gpt-4o-mini|gpt-5|qwen|llama|codestral|gemma|flash|mini|nano|haiku/.test(id)) return 1;
            if (/flux|stable-diffusion|imagen|dall-e|image|music|audio/.test(id)) return 2;
            return 3;
          };
          const diff = score(aId) - score(bId);
          return diff !== 0 ? diff : aId.localeCompare(bId);
        });

      for (const item of sorted.slice(0, 16)) {
        if (typeof item?.id === 'string' && item.id.trim()) {
          pushNgrokModel(item.id, item.name, item.context_length || 128000);
        }
      }
    }
  } catch {
    // Fall back to configured/standard ngrok gateway models below
  } finally {
    clearTimeout(timer);
  }

  if (defaultEnvModel) {
    pushNgrokModel(defaultEnvModel, defaultEnvModel, 128000, 'Configured');
  }
  for (const extra of extraEnvModels) {
    pushNgrokModel(extra, extra, 128000);
  }

  if (collected.length === 0) {
    pushNgrokModel('gpt-4o-mini', 'gpt-4o-mini', 128000, 'Low Cost');
    pushNgrokModel('gpt-4o', 'gpt-4o', 128000, 'Gateway');
  }

  return collected;
}

export async function fetchAllGatewayModels(
  referer: string,
  forceRefresh = false
): Promise<{
  models: UnifiedAiModel[];
  gateways: GatewayStatusSummary[];
  openRouterConfigured: boolean;
  huggingFaceConfigured: boolean;
  ngrokConfigured: boolean;
  pollinationsConfigured: boolean;
  geminiConfigured: boolean;
  keyStatus: OpenRouterKeyStatus;
}> {
  const openRouterPool = getOpenRouterApiKeyPool();
  const huggingFacePool = getHuggingFaceApiKeyPool();
  const ngrokPool = getNgrokApiKeyPool();
  const geminiPool = getGeminiApiKeyPool();

  const openRouterKey = openRouterPool[0] || '';
  const huggingFaceKey = huggingFacePool[0] || '';
  const ngrokKey = ngrokPool[0] || '';
  const geminiConfigured = geminiPool.length > 0;

  const [orResult, orKeyStatus, hfModels, ngrokModels, pollinationsModels] =
    await Promise.all([
      fetchFreeOpenRouterCatalog(openRouterKey, referer)
        .then((list) => ({ ok: true as const, list }))
        .catch(() => ({ ok: false as const, list: [] as NormalizedOpenRouterModel[] })),
      fetchOpenRouterKeyStatus(openRouterKey, referer, forceRefresh),
      huggingFaceKey ? fetchHuggingFaceCatalog(huggingFaceKey) : Promise.resolve([]),
      ngrokKey ? fetchNgrokCatalog(ngrokKey) : Promise.resolve([]),
      fetchPollinationsCatalog().catch(() => [...POLLINATIONS_FALLBACK_MODELS]),
    ]);

  const orModels: UnifiedAiModel[] = orResult.list
    .filter((m) => !isTextToSpeechModel(`${m.id} ${m.name}`))
    .map((m) => ({
      ...m,
      gateway: 'openrouter',
      upstreamModelId: m.id,
      tierLabel: 'Free',
    }));

  const geminiModels: UnifiedAiModel[] =
    geminiConfigured &&
    orModels.length === 0 &&
    hfModels.length === 0 &&
    ngrokModels.length === 0
      ? [
          {
            id: 'google/gemini-4-hydrogen',
            upstreamModelId: 'gemini-4-hydrogen',
            gateway: 'gemini',
            name: 'Google: Gemini 4 Hydrogen',
            provider: 'google',
            contextLength: 1048576,
            isFree: true,
            tierLabel: 'Built-in',
            capabilities: ['Code', 'Build', 'Vision'],
            category: 'code',
          },
        ]
      : [];

  const anyGatewayKeyConfigured = Boolean(
    openRouterKey || huggingFaceKey || ngrokKey || geminiConfigured
  );

  const gatewayOrder = getGatewayOrder();
  const models: UnifiedAiModel[] = [];

  for (const gw of gatewayOrder) {
    if (gw === 'openrouter') {
      if (openRouterKey || !anyGatewayKeyConfigured) {
        models.push(...orModels);
      }
    } else if (gw === 'huggingface' && huggingFaceKey) {
      models.push(...hfModels);
    } else if (gw === 'ngrok' && ngrokKey) {
      models.push(...ngrokModels);
    } else if (gw === 'pollinations') {
      models.push(...pollinationsModels);
    } else if (gw === 'gemini') {
      models.push(...geminiModels);
    }
  }

  const gateways: GatewayStatusSummary[] = [
    {
      id: 'openrouter',
      label: 'OpenRouter (:free)',
      baseUrl: getOpenRouterBaseUrl(),
      configured: openRouterPool.length > 0,
      keyCount: openRouterPool.length,
      modelCount: orModels.length,
      defaultModel:
        cleanEnvKey(process.env.OPENROUTER_FALLBACK_MODEL, []) || 'openrouter/free',
      keyStatus: orKeyStatus,
    },
    {
      id: 'huggingface',
      label: 'Hugging Face Router',
      baseUrl: getHuggingFaceBaseUrl(),
      configured: huggingFacePool.length > 0,
      keyCount: huggingFacePool.length,
      modelCount: hfModels.length,
      defaultModel:
        cleanEnvKey(process.env.HUGGING_FACE_DEFAULT_MODEL, []) ||
        hfModels[0]?.upstreamModelId ||
        'deepseek-ai/DeepSeek-V4-Flash:cheapest',
    },
    {
      id: 'ngrok',
      label: 'ngrok AI Gateway',
      baseUrl: getNgrokGatewayBaseUrl(),
      configured: ngrokPool.length > 0,
      keyCount: ngrokPool.length,
      modelCount: ngrokModels.length,
      defaultModel:
        cleanEnvKey(process.env.NGROK_DEFAULT_MODEL, []) ||
        ngrokModels[0]?.upstreamModelId ||
        'gpt-4o-mini',
    },
    {
      id: 'pollinations',
      label: 'Pollinations Public AI',
      baseUrl: DEFAULT_POLLINATIONS_TEXT_URL,
      configured: true,
      keyCount: 0,
      modelCount: pollinationsModels.length,
      defaultModel: 'openai-fast',
    },
    {
      id: 'gemini',
      label: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      configured: geminiConfigured,
      keyCount: geminiPool.length,
      modelCount: geminiConfigured ? 1 : 0,
      defaultModel: 'gemini-4-hydrogen',
    },
  ];

  return {
    models,
    gateways,
    openRouterConfigured: openRouterPool.length > 0,
    huggingFaceConfigured: huggingFacePool.length > 0,
    ngrokConfigured: ngrokPool.length > 0,
    pollinationsConfigured: true,
    geminiConfigured,
    keyStatus: orKeyStatus,
  };
}

export function buildGatewayExecutionPlan(params: {
  requestedModel?: string;
  requestedGateway?: string;
  openRouterCatalog: NormalizedOpenRouterModel[];
  huggingFaceCatalog: UnifiedAiModel[];
  ngrokCatalog: UnifiedAiModel[];
  pollinationsCatalog?: UnifiedAiModel[];
}): {
  openaiCandidates: GatewayExecutionCandidate[];
  hasAnyOpenAiGatewayKey: boolean;
  preferGeminiDirectly: boolean;
  requestedMediaKind: 'image' | 'music' | 'video' | null;
  requestedModelLabel?: string;
} {
  const openRouterPool = getOpenRouterApiKeyPool();
  const huggingFacePool = getHuggingFaceApiKeyPool();
  const ngrokPool = getNgrokApiKeyPool();
  const geminiPool = getGeminiApiKeyPool();
  const polList =
    params.pollinationsCatalog && params.pollinationsCatalog.length > 0
      ? params.pollinationsCatalog
      : POLLINATIONS_FALLBACK_MODELS;

  const parsed = parseGatewayModelIdentifier(
    params.requestedModel,
    params.requestedGateway
  );

  let preferredGateway = parsed.gateway;
  if (!preferredGateway && parsed.upstreamModelId) {
    if (
      params.huggingFaceCatalog.some(
        (m) => m.upstreamModelId === parsed.upstreamModelId
      )
    ) {
      preferredGateway = 'huggingface';
    } else if (
      params.ngrokCatalog.some((m) => m.upstreamModelId === parsed.upstreamModelId)
    ) {
      preferredGateway = 'ngrok';
    } else if (
      polList.some((m) => m.upstreamModelId === parsed.upstreamModelId)
    ) {
      preferredGateway = 'pollinations';
    } else if (
      isCandidateFreeOpenRouterModel(
        parsed.upstreamModelId,
        params.openRouterCatalog
      )
    ) {
      preferredGateway = 'openrouter';
    }
  }

  // Detect if the user explicitly picked a dedicated Image, Music, or Video model
  let requestedMediaKind: 'image' | 'music' | 'video' | null = null;
  let requestedModelLabel: string | undefined;

  if (parsed.upstreamModelId) {
    const matchedHf = params.huggingFaceCatalog.find(
      (m) => m.upstreamModelId === parsed.upstreamModelId
    );
    const matchedNgrok = params.ngrokCatalog.find(
      (m) => m.upstreamModelId === parsed.upstreamModelId
    );
    const matchedPol = polList.find(
      (m) => m.upstreamModelId === parsed.upstreamModelId
    );
    const matched = matchedHf || matchedNgrok || matchedPol;
    requestedModelLabel = matched?.name;
    if (matched?.category === 'video') requestedMediaKind = 'video';
    else if (matched?.category === 'image') requestedMediaKind = 'image';
    else if (matched?.category === 'music') requestedMediaKind = 'music';
    else {
      const { category } = classifyGatewayModelCapabilities(parsed.upstreamModelId);
      if (category === 'video' || category === 'image' || category === 'music') {
        requestedMediaKind = category;
      }
    }
  }

  const baseOrder = getGatewayOrder().filter(
    (g): g is Exclude<AiGatewayId, 'gemini'> => g !== 'gemini'
  );
  const orderedGateways =
    preferredGateway && preferredGateway !== 'gemini' && requestedMediaKind === null
      ? [preferredGateway, ...baseOrder.filter((g) => g !== preferredGateway)]
      : baseOrder;

  const readyCandidates: GatewayExecutionCandidate[] = [];
  const coolingCandidates: GatewayExecutionCandidate[] = [];
  const seenKey = new Set<string>();

  const pushCandidate = (cand: Omit<GatewayExecutionCandidate, 'cooldownKey'>) => {
    if (isTextToSpeechModel(cand.upstreamModelId)) return;
    const cooldownKey = buildCandidateCooldownKey(
      cand.gateway,
      cand.apiKey,
      cand.upstreamModelId
    );
    if (seenKey.has(cooldownKey)) return;
    seenKey.add(cooldownKey);

    const fullCand: GatewayExecutionCandidate = { ...cand, cooldownKey };
    if (isGatewayCandidateCoolingDown(cooldownKey)) {
      coolingCandidates.push(fullCand);
    } else {
      readyCandidates.push(fullCand);
    }
  };

  for (const gw of orderedGateways) {
    if (gw === 'openrouter' && openRouterPool.length > 0) {
      const orBase = getOpenRouterBaseUrl();
      const addOrForAllKeys = (id: string | undefined) => {
        const trimmed = id?.trim();
        if (
          !trimmed ||
          !isCandidateFreeOpenRouterModel(trimmed, params.openRouterCatalog)
        ) {
          return;
        }
        const info = resolveFreeModelInfo(trimmed, params.openRouterCatalog);
        for (const apiKey of openRouterPool) {
          pushCandidate({
            gateway: 'openrouter',
            gatewayLabel: 'OpenRouter',
            baseUrl: orBase,
            apiKey,
            publicModelId: info.id,
            upstreamModelId: info.id,
            modelName: info.name,
            provider: info.provider,
            isOpenRouter: true,
          });
        }
      };

      if (
        preferredGateway === 'openrouter' &&
        parsed.upstreamModelId &&
        requestedMediaKind === null
      ) {
        addOrForAllKeys(parsed.upstreamModelId);
      }
      addOrForAllKeys(process.env.OPENROUTER_FALLBACK_MODEL);
      addOrForAllKeys('openrouter/free');
      // Add ALL remaining healthy :free OpenRouter models for automatic limit failover
      for (const m of params.openRouterCatalog) {
        if (
          m.isFree &&
          m.category !== 'image' &&
          m.category !== 'music' &&
          m.category !== 'video'
        ) {
          addOrForAllKeys(m.id);
        }
      }
    } else if (gw === 'huggingface' && huggingFacePool.length > 0) {
      const hfBase = getHuggingFaceBaseUrl();
      const hfCodeList = (
        params.huggingFaceCatalog.length > 0
          ? params.huggingFaceCatalog
          : buildFallbackHuggingFaceCodeModels()
      ).filter(
        (m) => m.category !== 'image' && m.category !== 'music' && m.category !== 'video'
      );

      const addHfForAllKeys = (upstreamId: string | undefined, name?: string) => {
        const trimmed = upstreamId?.trim();
        if (!trimmed) return;
        const matched = hfCodeList.find((m) => m.upstreamModelId === trimmed);
        for (const apiKey of huggingFacePool) {
          pushCandidate({
            gateway: 'huggingface',
            gatewayLabel: 'Hugging Face',
            baseUrl: hfBase,
            apiKey,
            publicModelId: `hf::${trimmed}`,
            upstreamModelId: trimmed,
            modelName:
              name ||
              matched?.name ||
              `HF: ${trimmed.split('/').pop() || trimmed}`,
            provider: 'huggingface',
          });
        }
      };

      if (
        preferredGateway === 'huggingface' &&
        parsed.upstreamModelId &&
        requestedMediaKind === null
      ) {
        addHfForAllKeys(parsed.upstreamModelId);
      }
      addHfForAllKeys(cleanEnvKey(process.env.HUGGING_FACE_DEFAULT_MODEL, []));
      for (const m of hfCodeList) {
        addHfForAllKeys(m.upstreamModelId, m.name);
      }
    } else if (gw === 'ngrok' && ngrokPool.length > 0) {
      const ngrokBase = getNgrokGatewayBaseUrl();
      const ngrokList = params.ngrokCatalog.filter(
        (m) => m.category !== 'image' && m.category !== 'music' && m.category !== 'video'
      );

      const addNgrokForAllKeys = (upstreamId: string | undefined, name?: string) => {
        const trimmed = upstreamId?.trim();
        if (!trimmed) return;
        const matched = ngrokList.find((m) => m.upstreamModelId === trimmed);
        for (const apiKey of ngrokPool) {
          pushCandidate({
            gateway: 'ngrok',
            gatewayLabel: 'ngrok AI Gateway',
            baseUrl: ngrokBase,
            apiKey,
            publicModelId: `ngrok::${trimmed}`,
            upstreamModelId: trimmed,
            modelName: name || matched?.name || `ngrok: ${trimmed}`,
            provider: 'ngrok',
          });
        }
      };

      if (
        preferredGateway === 'ngrok' &&
        parsed.upstreamModelId &&
        requestedMediaKind === null
      ) {
        addNgrokForAllKeys(parsed.upstreamModelId);
      }
      addNgrokForAllKeys(cleanEnvKey(process.env.NGROK_DEFAULT_MODEL, []));
      for (const m of ngrokList) {
        addNgrokForAllKeys(m.upstreamModelId, m.name);
      }
      if (ngrokList.length === 0) {
        addNgrokForAllKeys('gpt-4o-mini', 'ngrok: gpt-4o-mini');
        addNgrokForAllKeys('gpt-4o', 'ngrok: gpt-4o');
      }
    } else if (gw === 'pollinations') {
      const polTextModels = polList.filter(
        (m) => m.category !== 'image' && m.category !== 'music' && m.category !== 'video'
      );
      if (
        preferredGateway === 'pollinations' &&
        parsed.upstreamModelId &&
        requestedMediaKind === null
      ) {
        const matched = polTextModels.find(
          (m) => m.upstreamModelId === parsed.upstreamModelId
        );
        pushCandidate({
          gateway: 'pollinations',
          gatewayLabel: 'Pollinations Public AI',
          baseUrl: DEFAULT_POLLINATIONS_TEXT_URL,
          apiKey: '',
          publicModelId: `pollinations::${parsed.upstreamModelId}`,
          upstreamModelId: parsed.upstreamModelId,
          modelName: matched?.name || `Pollinations: ${parsed.upstreamModelId}`,
          provider: 'pollinations',
        });
      }
      for (const m of polTextModels) {
        pushCandidate({
          gateway: 'pollinations',
          gatewayLabel: 'Pollinations Public AI',
          baseUrl: DEFAULT_POLLINATIONS_TEXT_URL,
          apiKey: '',
          publicModelId: m.id,
          upstreamModelId: m.upstreamModelId,
          modelName: m.name,
          provider: 'pollinations',
        });
      }
    }
  }

  // Try non-cooling-down candidates first, then cooling candidates as last resort (capped at 22)
  const openaiCandidates = [...readyCandidates, ...coolingCandidates].slice(0, 22);

  return {
    openaiCandidates,
    hasAnyOpenAiGatewayKey:
      openRouterPool.length > 0 ||
      huggingFacePool.length > 0 ||
      ngrokPool.length > 0 ||
      openaiCandidates.length > 0,
    preferGeminiDirectly:
      preferredGateway === 'gemini' && geminiPool.length > 0 && requestedMediaKind === null,
    requestedMediaKind,
    requestedModelLabel,
  };
}
