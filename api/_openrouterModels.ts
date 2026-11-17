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

export interface KeylessGatewayStatus {
  configured: boolean;
  valid: boolean | null;
  isFreeTier: boolean | null;
  limitRemaining: number | null;
}

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

export function isTextToSpeechModel(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(?:tts|text-to-speech|text_to_speech|speech-synthesis|speecht5|voice-clone|voice\s+cloning|kokoro|bark|parler|fish-speech|xtts|piper|vits|mms-tts|orpheus|sesame-csm|chatterbox|f5-tts|cosyvoice|styletts|tortoise-tts|elevenlabs)\b/i.test(
    text
  );
}
