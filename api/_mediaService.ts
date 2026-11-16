import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import {
  DEFAULT_HUGGING_FACE_INFERENCE_URL,
  DEFAULT_POLLINATIONS_IMAGE_URL,
  DEFAULT_POLLINATIONS_TEXT_URL,
  HUGGING_FACE_IMAGE_FALLBACKS,
  HUGGING_FACE_MUSIC_FALLBACKS,
  HUGGING_FACE_VIDEO_FALLBACKS,
  buildCandidateCooldownKey,
  getGroqApiKeyPool,
  getGroqBaseUrl,
  getHuggingFaceApiKeyPool,
  getNgrokApiKeyPool,
  getNgrokGatewayBaseUrl,
  isGatewayCandidateCoolingDown,
  markGatewayCandidateCooldown,
  parseGatewayModelIdentifier,
} from './_aiGateways.js';
import { runLiveBrowserSearch } from './_builderCore.js';
import {
  getGeminiApiKeyPool,
  getOpenRouterApiKeyPool,
  isTextToSpeechModel,
  OPENROUTER_BASE_URL,
} from './_openrouterModels.js';

export type MediaAssetKind = 'image' | 'music' | 'video';

export interface GeneratedMediaResult {
  kind: MediaAssetKind;
  prompt: string;
  dataUrl: string;
  mimeType: string;
  modelId: string;
  gateway: 'google' | 'huggingface' | 'ngrok' | 'pollinations' | 'web-search';
  lyrics?: string;
}

function bufferToDataUrl(buf: ArrayBuffer | Uint8Array, mimeType: string): string {
  const b = Buffer.isBuffer(buf)
    ? buf
    : buf instanceof Uint8Array
      ? Buffer.from(buf)
      : Buffer.from(buf);
  return `data:${mimeType};base64,${b.toString('base64')}`;
}

function looksLikeValidImageBuffer(buf: Uint8Array): boolean {
  if (buf.byteLength < 1024) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return true;
  }
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return true;
  }
  return false;
}

async function fetchImageBytesAsDataUrl(
  imageUrl: string,
  timeoutMs = 5500
): Promise<{ dataUrl: string; mimeType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
      },
    });
    if (!res.ok) return null;
    const rawMime = (res.headers.get('content-type') || '')
      .split(';')[0]
      ?.trim()
      .toLowerCase();
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!looksLikeValidImageBuffer(buf)) return null;
    const detectedMime =
      rawMime && rawMime.startsWith('image/') && !rawMime.includes('svg')
        ? rawMime
        : buf[0] === 0x89
          ? 'image/png'
          : buf[0] === 0x52
            ? 'image/webp'
            : 'image/jpeg';
    return {
      dataUrl: bufferToDataUrl(buf, detectedMime),
      mimeType: detectedMime,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchVerifiedWebImageFallback(
  prompt: string
): Promise<GeneratedMediaResult | null> {
  try {
    const searchData = await runLiveBrowserSearch(prompt);
    const candidates = searchData.images.map((i) => i.imageUrl).filter(Boolean);
    for (const url of candidates.slice(0, 6)) {
      const downloaded = await fetchImageBytesAsDataUrl(url, 4500);
      if (downloaded) {
        return {
          kind: 'image',
          prompt,
          dataUrl: downloaded.dataUrl,
          mimeType: downloaded.mimeType,
          modelId: 'google-image-search',
          gateway: 'web-search',
        };
      }
    }
  } catch {
    // ignore search fallback error
  }
  return null;
}

async function generateGeminiImage(
  prompt: string,
  requestedModel?: string
): Promise<GeneratedMediaResult | null> {
  const geminiKeys = getGeminiApiKeyPool();
  if (geminiKeys.length === 0) return null;

  const targetModel =
    requestedModel && /nano-banana/i.test(requestedModel)
      ? 'gemini-nano-banana-2.1'
      : 'gemini-3.1-flash-lite-image';

  for (const apiKey of geminiKeys.slice(0, 2)) {
    const cooldownKey = buildCandidateCooldownKey('gemini', apiKey, targetModel);
    if (isGatewayCandidateCoolingDown(cooldownKey)) continue;
    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });
      const response = await ai.models.generateContent({
        model: targetModel,
        contents: { parts: [{ text: prompt }] },
        config: {
          imageConfig: {
            aspectRatio: '1:1',
          },
          ...(targetModel === 'gemini-nano-banana-2.1'
            ? {
                tools: [
                  {
                    googleSearch: {
                      searchTypes: {
                        webSearch: {},
                        imageSearch: {},
                      },
                    },
                  },
                ],
              }
            : {}),
        },
      });

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          const mimeType = part.inlineData.mimeType ?? 'image/png';
          return {
            kind: 'image',
            prompt,
            dataUrl: `data:${mimeType};base64,${part.inlineData.data}`,
            mimeType,
            modelId: `gemini::${targetModel}`,
            gateway: 'google',
          };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|401|403|quota|resource_exhausted|api key/i.test(msg)) {
        markGatewayCandidateCooldown(cooldownKey, 75_000);
      }
    }
  }
  return null;
}

async function generateGeminiMusic(
  prompt: string
): Promise<GeneratedMediaResult | null> {
  const geminiKeys = getGeminiApiKeyPool();
  if (geminiKeys.length === 0) return null;

  for (const apiKey of geminiKeys.slice(0, 2)) {
    const cooldownKey = buildCandidateCooldownKey(
      'gemini',
      apiKey,
      'lyria-3-clip-preview'
    );
    if (isGatewayCandidateCoolingDown(cooldownKey)) continue;
    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });
      const response = await ai.models.generateContentStream({
        model: 'lyria-3-clip-preview',
        contents: prompt,
      });

      const audioChunks: Buffer[] = [];
      let lyrics = '';
      let mimeType = 'audio/mpeg';

      for await (const chunk of response) {
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (!parts) continue;
        for (const part of parts) {
          if (part.inlineData?.data) {
            if (audioChunks.length === 0 && part.inlineData.mimeType) {
              mimeType = part.inlineData.mimeType;
            }
            audioChunks.push(Buffer.from(part.inlineData.data, 'base64'));
          }
          if (part.text) {
            lyrics += part.text;
          }
        }
      }

      if (audioChunks.length > 0) {
        const fullAudio = Buffer.concat(audioChunks);
        return {
          kind: 'music',
          prompt,
          dataUrl: bufferToDataUrl(fullAudio, mimeType),
          mimeType,
          modelId: 'gemini::lyria-3-clip-preview',
          gateway: 'google',
          ...(lyrics.trim() ? { lyrics: lyrics.trim() } : {}),
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|401|403|quota|resource_exhausted|paid|api key/i.test(msg)) {
        markGatewayCandidateCooldown(cooldownKey, 90_000);
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Rich AI-Orchestrated Polyphonic Music Composition & Multi-Engine DSP       */
/* -------------------------------------------------------------------------- */

type GrooveStyle =
  | 'afrobeat'
  | 'amapiano'
  | 'trap'
  | 'drill'
  | 'lofi'
  | 'jazz'
  | 'rnb'
  | 'pop'
  | 'edm'
  | 'synthwave'
  | 'reggae'
  | 'rock'
  | 'cinematic'
  | 'acoustic';

type LeadInstrument =
  | 'electric_piano'
  | 'plucked_guitar'
  | 'supersaw'
  | 'bell_mallet'
  | 'warm_lead'
  | 'brass_lead';

type BassStyle =
  | 'sub_808'
  | 'log_drum'
  | 'walking'
  | 'funk_slap'
  | 'rolling_synth';

interface MusicArrangementPlan {
  bpm: number;
  rootMidi: number;
  scaleIntervals: number[];
  chords: number[][];
  melodyA: number[];
  melodyB: number[];
  arpeggio: number[];
  groove: GrooveStyle;
  leadInstrument: LeadInstrument;
  bassStyle: BassStyle;
  swing: number; // 0..0.38
  seed: number;
}

function fnv1aHash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function inferPromptArrangement(prompt: string): MusicArrangementPlan {
  const lower = prompt.toLowerCase();
  // Mix prompt hash with per-generation cryptographic nonce so every generation has fresh phrasing
  const nonce = crypto.randomInt(1, 0x7fffffff);
  const seed = (fnv1aHash(prompt) ^ nonce) >>> 0;
  const pick = <T,>(arr: T[], offset = 0): T =>
    arr[(seed + offset * 2654435761) % arr.length];

  const groove: GrooveStyle =
    /amapiano|log\s*drum/.test(lower)
      ? 'amapiano'
      : /afro|burna|wizkid|tems|rema|asake|highlife/.test(lower)
        ? 'afrobeat'
        : /reggae|dancehall|dub|roots|jamaica/.test(lower)
          ? 'reggae'
          : /drill|uk\s*drill|ny\s*drill/.test(lower)
            ? 'drill'
            : /trap|808|hip.?hop|rap|boom\s*bap/.test(lower)
              ? 'trap'
              : /jazz|swing|sax|paris|bossa|bebop|blue\s*note/.test(lower)
                ? 'jazz'
                : /lofi|lo-fi|chill|study|rain|sleep|ambient|calm|meditat/.test(lower)
                  ? 'lofi'
                  : /r&b|rnb|soul|neo.?soul|slow\s*jam/.test(lower)
                    ? 'rnb'
                    : /synthwave|retro|80s|cyberpunk|outrun|vaporwave/.test(lower)
                      ? 'synthwave'
                      : /edm|house|techno|club|rave|trance|dance|electronic|dubstep/.test(lower)
                        ? 'edm'
                        : /rock|metal|punk|indie|alt|grunge/.test(lower)
                          ? 'rock'
                          : /cinematic|epic|orchestra|film|trailer|heroic|dramatic/.test(lower)
                            ? 'cinematic'
                            : /acoustic|folk|country|guitar|piano\s*ballad|ballad|unplugged/.test(lower)
                              ? 'acoustic'
                              : 'pop';

  const bpmRanges: Record<GrooveStyle, [number, number]> = {
    afrobeat: [100, 118],
    amapiano: [110, 117],
    trap: [128, 148],
    drill: [138, 146],
    lofi: [72, 90],
    jazz: [88, 126],
    rnb: [76, 98],
    pop: [96, 124],
    edm: [120, 132],
    synthwave: [98, 118],
    reggae: [74, 92],
    rock: [108, 138],
    cinematic: [78, 108],
    acoustic: [76, 112],
  };

  let [minBpm, maxBpm] = bpmRanges[groove];
  if (/fast|upbeat|high\s*energy|hype|sprint|party|intense/.test(lower)) {
    minBpm = Math.min(maxBpm, minBpm + Math.round((maxBpm - minBpm) * 0.55));
  } else if (/slow|chill|calm|soft|gentle|relax|night|sleep/.test(lower)) {
    maxBpm = Math.max(minBpm, maxBpm - Math.round((maxBpm - minBpm) * 0.55));
  }
  const bpm = minBpm + (seed % Math.max(1, maxBpm - minBpm + 1));

  // Scales based on mood/genre
  const isMinorMood =
    groove === 'trap' ||
    groove === 'drill' ||
    groove === 'synthwave' ||
    /dark|sad|melanchol|minor|night|moody|emotional|lonely|broken|mystery|epic/.test(lower);

  const scales: Record<string, number[]> = {
    major: [0, 2, 4, 5, 7, 9, 11],
    naturalMinor: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
    pentatonicMajor: [0, 2, 4, 7, 9, 12, 14],
    blues: [0, 3, 5, 6, 7, 10, 12],
  };

  let scaleIntervals = scales.major;
  if (groove === 'jazz') {
    scaleIntervals = isMinorMood ? scales.dorian : scales.mixolydian;
  } else if (groove === 'drill' || groove === 'trap') {
    scaleIntervals = /dark|evil|drill/.test(lower)
      ? scales.harmonicMinor
      : scales.naturalMinor;
  } else if (isMinorMood) {
    scaleIntervals = pick([scales.naturalMinor, scales.dorian], 1);
  } else if (groove === 'afrobeat' || groove === 'rnb') {
    scaleIntervals = pick([scales.major, scales.dorian, scales.pentatonicMajor], 1);
  } else {
    scaleIntervals = pick([scales.major, scales.mixolydian, scales.pentatonicMajor], 1);
  }

  // Pick varied musical keys across C3..G4 (48..67) so songs are never stuck in C or Am
  const rootPool = [48, 50, 52, 53, 55, 57, 58, 60, 62, 64];
  const rootMidi = pick(rootPool, 2);

  // Rich library of distinct 4-to-8-bar chord progressions
  const minorProgressions: number[][][] = [
    [[0, 3, 7, 10], [5, 8, 12, 15], [3, 7, 10, 14], [7, 10, 14, 17]], // i - iv - III - v
    [[0, 3, 7, 10], [-4, 0, 3, 7], [-2, 2, 5, 9], [-5, -1, 2, 7]], // i - VI - VII - V
    [[0, 3, 7, 14], [8, 12, 15, 19], [3, 7, 10, 14], [10, 14, 17, 21]], // i9 - VI7 - III7 - VII
    [[0, 3, 7, 10], [7, 10, 14, 17], [8, 12, 15, 19], [5, 8, 12, 15]], // i - v - VI - iv
  ];
  const majorProgressions: number[][][] = [
    [[0, 4, 7, 11], [7, 11, 14, 17], [9, 12, 16, 19], [5, 9, 12, 16]], // I - V - vi - IV
    [[2, 5, 9, 12], [7, 11, 14, 17], [0, 4, 7, 11], [9, 12, 16, 19]], // ii7 - V7 - Imaj7 - vi7 (jazz/rnb)
    [[5, 9, 12, 16], [7, 11, 14, 17], [4, 7, 11, 14], [9, 12, 16, 19]], // IVmaj7 - V - iii7 - vi7
    [[0, 4, 7, 11], [5, 9, 12, 16], [9, 12, 16, 19], [7, 11, 14, 19]], // I - IV - vi - V
    [[0, 4, 7, 14], [9, 12, 16, 21], [2, 5, 9, 12], [7, 11, 14, 17]], // Iadd9 - vi9 - ii7 - V7
  ];

  const baseProgression = isMinorMood
    ? pick(minorProgressions, 3)
    : pick(majorProgressions, 3);
  // Extend into 8 bars with subtle turnaround tension in bar 8
  const turnChord = [...baseProgression[baseProgression.length - 1]];
  turnChord[turnChord.length - 1] += 2;
  const chords = [...baseProgression, ...baseProgression.slice(0, 3), turnChord];

  // Musical motif-based melody generator (Section A verse + Section B chorus lift)
  const buildMotifSection = (octaveLift: number, salt: number): number[] => {
    const out: number[] = [];
    let cursor = ((seed + salt) % scaleIntervals.length);
    const motif = [0, 1, 2, 1, 3, 2, 0, -1];
    for (let bar = 0; bar < 4; bar += 1) {
      for (let step = 0; step < 8; step += 1) {
        const mIdx = (bar * 3 + step + ((seed >>> (bar + 1)) & 3)) % motif.length;
        const motion = motif[mIdx];
        // Rest density varies by groove
        const restMod = groove === 'lofi' || groove === 'jazz' ? 4 : 6;
        if (step % 2 === 1 && ((seed + bar * 7 + step + salt) % restMod === 0)) {
          out.push(-1);
          continue;
        }
        if (motion === -1 && step > 2) {
          out.push(-1);
          continue;
        }
        cursor = (cursor + motion + scaleIntervals.length) % scaleIntervals.length;
        const octave = octaveLift + (bar === 2 && step < 4 ? 12 : 0);
        out.push(scaleIntervals[cursor] + octave);
      }
    }
    return out;
  };

  const melodyA = buildMotifSection(0, 11);
  const melodyB = buildMotifSection(groove === 'edm' || groove === 'pop' ? 12 : 0, 37);

  const arpeggio: number[] = [];
  for (let i = 0; i < 16; i += 1) {
    arpeggio.push(scaleIntervals[(i * 2 + (seed % 5)) % scaleIntervals.length]);
  }

  let leadInstrument: LeadInstrument = pick<LeadInstrument>(
    ['electric_piano', 'plucked_guitar', 'supersaw', 'bell_mallet', 'warm_lead', 'brass_lead'],
    5
  );
  if (/piano|keys|rhodes|jazz|lofi|ballad/.test(lower)) leadInstrument = 'electric_piano';
  else if (/guitar|acoustic|reggae|afro|folk|country/.test(lower)) leadInstrument = 'plucked_guitar';
  else if (/edm|synth|cyber|techno|house|rave|trance/.test(lower)) leadInstrument = 'supersaw';
  else if (/marimba|bell|kalimba|celesta|music\s*box|tropical/.test(lower)) leadInstrument = 'bell_mallet';
  else if (/cinematic|epic|orchestra|brass|hero|trailer/.test(lower)) leadInstrument = 'brass_lead';

  const bassStyle: BassStyle =
    groove === 'amapiano'
      ? 'log_drum'
      : groove === 'trap' || groove === 'drill'
        ? 'sub_808'
        : groove === 'jazz' || groove === 'lofi'
          ? 'walking'
          : groove === 'edm' || groove === 'synthwave'
            ? 'rolling_synth'
            : 'funk_slap';

  const swing =
    groove === 'jazz' || groove === 'lofi'
      ? 0.24
      : groove === 'afrobeat' || groove === 'amapiano' || groove === 'rnb'
        ? 0.14
        : 0;

  return {
    bpm,
    rootMidi,
    scaleIntervals,
    chords,
    melodyA,
    melodyB,
    arpeggio,
    groove,
    leadInstrument,
    bassStyle,
    swing,
    seed,
  };
}

async function composeArrangementWithAi(
  prompt: string
): Promise<MusicArrangementPlan> {
  const fallback = inferPromptArrangement(prompt);
  const systemPrompt =
    'You are an award-winning music producer. Output ONLY compact valid JSON (no markdown, no explanation) composing an original track tailored strictly to the prompt: {"bpm":integer(68..156),"rootMidi":integer(48..65),"groove":"afrobeat"|"amapiano"|"trap"|"drill"|"lofi"|"jazz"|"rnb"|"pop"|"edm"|"synthwave"|"reggae"|"rock"|"cinematic"|"acoustic","leadInstrument":"electric_piano"|"plucked_guitar"|"supersaw"|"bell_mallet"|"warm_lead"|"brass_lead","bassStyle":"sub_808"|"log_drum"|"walking"|"funk_slap"|"rolling_synth","swing":number(0..0.32),"chords":[[4 integers] x4..8],"melodyA":[32 integers -1..24],"melodyB":[32 integers -1..24]}. Be wildly creative and match the exact genre, mood, and tempo requested.';

  const parseAiPlan = (raw: string): MusicArrangementPlan | null => {
    const jsonMatch = /\{[\s\S]*\}/.exec(raw);
    if (!jsonMatch) return null;
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const bpm =
        typeof parsed.bpm === 'number' && Number.isFinite(parsed.bpm)
          ? Math.max(66, Math.min(160, Math.round(parsed.bpm)))
          : fallback.bpm;
      const rootMidi =
        typeof parsed.rootMidi === 'number' && Number.isFinite(parsed.rootMidi)
          ? Math.max(45, Math.min(67, Math.round(parsed.rootMidi)))
          : fallback.rootMidi;
      const validGrooves: GrooveStyle[] = [
        'afrobeat',
        'amapiano',
        'trap',
        'drill',
        'lofi',
        'jazz',
        'rnb',
        'pop',
        'edm',
        'synthwave',
        'reggae',
        'rock',
        'cinematic',
        'acoustic',
      ];
      const groove = validGrooves.includes(parsed.groove as GrooveStyle)
        ? (parsed.groove as GrooveStyle)
        : fallback.groove;
      const validLeads: LeadInstrument[] = [
        'electric_piano',
        'plucked_guitar',
        'supersaw',
        'bell_mallet',
        'warm_lead',
        'brass_lead',
      ];
      const leadInstrument = validLeads.includes(
        parsed.leadInstrument as LeadInstrument
      )
        ? (parsed.leadInstrument as LeadInstrument)
        : fallback.leadInstrument;
      const validBass: BassStyle[] = [
        'sub_808',
        'log_drum',
        'walking',
        'funk_slap',
        'rolling_synth',
      ];
      const bassStyle = validBass.includes(parsed.bassStyle as BassStyle)
        ? (parsed.bassStyle as BassStyle)
        : fallback.bassStyle;
      const swing =
        typeof parsed.swing === 'number' && Number.isFinite(parsed.swing)
          ? Math.max(0, Math.min(0.35, parsed.swing))
          : fallback.swing;

      const rawChords = parsed.chords;
      const chords =
        Array.isArray(rawChords) &&
        rawChords.length >= 2 &&
        rawChords.every(
          (c) =>
            Array.isArray(c) &&
            c.length >= 3 &&
            c.every((n) => typeof n === 'number' && Number.isFinite(n))
        )
          ? rawChords
              .slice(0, 8)
              .map((c: number[]) =>
                c.slice(0, 4).map((n) => Math.max(-12, Math.min(24, Math.round(n))))
              )
          : fallback.chords;

      const normMelody = (arr: unknown, fb: number[]) =>
        Array.isArray(arr) &&
        arr.length >= 8 &&
        arr.every((n) => typeof n === 'number' && Number.isFinite(n))
          ? Array.from({ length: 32 }, (_, idx) => {
              const v = Math.round(arr[idx % arr.length] as number);
              return v < 0 ? -1 : Math.min(24, v);
            })
          : fb;

      return {
        ...fallback,
        bpm,
        rootMidi,
        groove,
        leadInstrument,
        bassStyle,
        swing,
        chords: chords.length >= 8 ? chords : [...chords, ...chords].slice(0, 8),
        melodyA: normMelody(parsed.melodyA ?? parsed.melody, fallback.melodyA),
        melodyB: normMelody(parsed.melodyB ?? parsed.melody, fallback.melodyB),
      };
    } catch {
      return null;
    }
  };

  // 1. Try fast configured LLM gateways (Gemini -> Groq -> OpenRouter -> Pollinations)
  const groqKey = getGroqApiKeyPool()[0];
  if (groqKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      const res = await fetch(`${getGroqBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${groqKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.95,
          max_tokens: 600,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        }),
        signal: controller.signal,
      });
      if (res.ok) {
        const j = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const plan = parseAiPlan(j?.choices?.[0]?.message?.content || '');
        if (plan) return plan;
      }
    } catch {
      // fall through
    } finally {
      clearTimeout(timer);
    }
  }

  const orKey = getOpenRouterApiKeyPool()[0];
  if (orKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${orKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'AI Craft Music Studio',
        },
        body: JSON.stringify({
          model: 'openrouter/free',
          temperature: 0.95,
          max_tokens: 600,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        }),
        signal: controller.signal,
      });
      if (res.ok) {
        const j = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const plan = parseAiPlan(j?.choices?.[0]?.message?.content || '');
        if (plan) return plan;
      }
    } catch {
      // fall through
    } finally {
      clearTimeout(timer);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(`${DEFAULT_POLLINATIONS_TEXT_URL}/openai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai-fast',
        temperature: 0.95,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (res.ok) {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const plan = parseAiPlan(data?.choices?.[0]?.message?.content || '');
      if (plan) return plan;
    }
  } catch {
    // use rich deterministic prompt-seeded plan
  } finally {
    clearTimeout(timer);
  }

  return fallback;
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function renderArrangementToStereoWav(plan: MusicArrangementPlan): Buffer {
  const sampleRate = 22050;
  const beatSeconds = 60 / plan.bpm;
  const barSeconds = beatSeconds * 4;
  // Render full 8-bar arrangement (Verse A -> Chorus B lift), clamped comfortably 12..19s
  const totalSeconds = Math.max(12, Math.min(19, barSeconds * 8));
  const totalSamples = Math.floor(sampleRate * totalSeconds);
  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);

  const stepSeconds = beatSeconds / 2; // eighth-note base grid
  const totalSteps = Math.floor(totalSeconds / stepSeconds);

  let rng = (plan.seed || 0x9e3779b9) >>> 0;
  if (rng === 0) rng = 0x9e3779b9;
  const nextNoise = () => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return ((rng >>> 0) / 0xffffffff) * 2 - 1;
  };

  for (let s = 0; s < totalSteps; s += 1) {
    const swingOffsetSec = s % 2 === 1 ? stepSeconds * plan.swing : 0;
    const startSample = Math.min(
      totalSamples - 1,
      Math.floor((s * stepSeconds + swingOffsetSec) * sampleRate)
    );
    const barIdx = Math.floor(s / 8) % plan.chords.length;
    const isChorus = barIdx >= 4;
    const stepInBar = s % 8;
    const chord = plan.chords[barIdx];

    // 1. Expressive Polyphonic Harmony (Chords: Skank for Reggae, Rhodes for Jazz/RnB/Lofi, Warm Strings/Pad for Cinematic/EDM)
    const strikeChord =
      plan.groove === 'reggae'
        ? stepInBar === 2 || stepInBar === 6
        : plan.groove === 'afrobeat' || plan.groove === 'amapiano'
          ? stepInBar === 0 || stepInBar === 3 || stepInBar === 6
          : plan.groove === 'pop' || plan.groove === 'rock'
            ? stepInBar === 0 || stepInBar === 4
            : stepInBar === 0;

    if (strikeChord) {
      const chordDur =
        plan.groove === 'reggae'
          ? stepSeconds * 0.85
          : stepInBar === 0
            ? barSeconds * 0.92
            : beatSeconds * 1.4;
      const chordLen = Math.min(
        totalSamples - startSample,
        Math.floor(chordDur * sampleRate)
      );
      const chordGain =
        (isChorus ? 0.13 : 0.1) / Math.max(1, chord.length * 0.6);

      for (let i = 0; i < chordLen; i += 1) {
        const t = i / sampleRate;
        const attack = Math.min(
          1,
          t / (plan.groove === 'cinematic' || plan.groove === 'lofi' ? 0.09 : 0.018)
        );
        const decayRate =
          plan.groove === 'reggae'
            ? 6.5
            : plan.groove === 'afrobeat' || plan.groove === 'jazz'
              ? 2.2
              : 0.75;
        const env = attack * Math.exp(-t * decayRate);
        let sumL = 0;
        let sumR = 0;
        for (let n = 0; n < chord.length; n += 1) {
          const freq = midiToHz(plan.rootMidi + chord[n]);
          const pan = (n / Math.max(1, chord.length - 1) - 0.5) * 0.55;
          // FM electric-piano / warm analog choir blend
          const mod =
            plan.leadInstrument === 'electric_piano'
              ? Math.sin(2 * Math.PI * freq * 2 * t) * Math.exp(-t * 4) * 0.85
              : Math.sin(2 * Math.PI * freq * 1.004 * t) * 0.35;
          const wave =
            Math.sin(2 * Math.PI * freq * t + mod * 0.65) * 0.72 +
            Math.sin(2 * Math.PI * freq * 2 * t) * 0.18 +
            Math.sin(2 * Math.PI * freq * 0.5 * t) * 0.1;
          sumL += wave * (1 - pan);
          sumR += wave * (1 + pan);
        }
        left[startSample + i] += sumL * env * chordGain;
        right[startSample + i] += sumR * env * chordGain;
      }
    }

    // 2. Genre-Authentic Bassline (Amapiano Log Drum, Deep 808, Walking Jazz, Funk Slap, Rolling EDM Synth)
    const playBass =
      plan.bassStyle === 'rolling_synth'
        ? true
        : plan.bassStyle === 'walking'
          ? stepInBar % 2 === 0
          : plan.bassStyle === 'log_drum'
            ? stepInBar === 0 || stepInBar === 3 || stepInBar === 6 || (isChorus && stepInBar === 7)
            : plan.groove === 'reggae'
              ? stepInBar === 0 || stepInBar === 3 || stepInBar === 5
              : stepInBar === 0 || stepInBar === 3 || (stepInBar === 6 && isChorus);

    if (playBass) {
      const noteOffset =
        plan.bassStyle === 'walking'
          ? chord[(stepInBar / 2) % chord.length]
          : stepInBar === 6 && chord.length > 2
            ? chord[2] - 12
            : chord[0];
      const bassFreq = midiToHz(plan.rootMidi - 12 + noteOffset);
      const bassDur = Math.min(
        totalSamples - startSample,
        Math.floor(
          stepSeconds * (plan.bassStyle === 'sub_808' ? 2.4 : 1.35) * sampleRate
        )
      );
      for (let i = 0; i < bassDur; i += 1) {
        const t = i / sampleRate;
        const env =
          Math.min(1, t / 0.008) *
          Math.exp(-t * (plan.bassStyle === 'log_drum' ? 7.2 : 3.4));
        const pitchBend =
          plan.bassStyle === 'log_drum' || plan.bassStyle === 'sub_808'
            ? 1 + 0.55 * Math.exp(-t * 32)
            : 1;
        const f = bassFreq * pitchBend;
        const harmonic =
          plan.bassStyle === 'log_drum'
            ? Math.sin(2 * Math.PI * f * t) * 0.7 +
              Math.sin(2 * Math.PI * f * 3 * t) * Math.exp(-t * 18) * 0.35
            : plan.bassStyle === 'funk_slap' || plan.bassStyle === 'rolling_synth'
              ? Math.tanh(
                  (Math.sin(2 * Math.PI * f * t) +
                    Math.sin(2 * Math.PI * f * 2 * t) * 0.45 +
                    Math.sin(2 * Math.PI * f * 3 * t) * 0.2) *
                    1.4
                ) * 0.72
              : Math.sin(2 * Math.PI * f * t) * 0.85 +
                Math.sin(2 * Math.PI * f * 2 * t) * 0.15;
        const v = harmonic * env * 0.28;
        left[startSample + i] += v;
        right[startSample + i] += v;
      }
    }

    // 3. Multi-Timbral Expressive Lead Melody (Karplus-Strong Guitar / FM Rhodes / Supersaw / Marimba / Brass)
    const melArr = isChorus ? plan.melodyB : plan.melodyA;
    const melOffset = melArr[s % melArr.length];
    if (melOffset >= 0) {
      const melFreq = midiToHz(plan.rootMidi + 12 + melOffset);
      const melDur = Math.min(
        totalSamples - startSample,
        Math.floor(stepSeconds * 1.45 * sampleRate)
      );
      const panL = s % 2 === 0 ? 0.86 : 1.12;
      const panR = s % 2 === 0 ? 1.12 : 0.86;

      if (plan.leadInstrument === 'plucked_guitar') {
        // Real Karplus-Strong physical string pluck synthesis
        const periodSamples = Math.max(4, Math.round(sampleRate / melFreq));
        const ring = new Float32Array(periodSamples);
        for (let k = 0; k < periodSamples; k += 1) {
          ring[k] = nextNoise() * 0.75 + Math.sin((2 * Math.PI * k) / periodSamples) * 0.25;
        }
        let ptr = 0;
        let prevSample = 0;
        for (let i = 0; i < melDur; i += 1) {
          const cur = ring[ptr];
          const next = 0.992 * 0.5 * (cur + prevSample);
          prevSample = cur;
          ring[ptr] = next;
          ptr = (ptr + 1) % periodSamples;
          const fade = Math.min(1, i / 120) * Math.exp(-i / (sampleRate * 0.95));
          const val = cur * fade * 0.24;
          left[startSample + i] += val * panL;
          right[startSample + i] += val * panR;
        }
      } else {
        for (let i = 0; i < melDur; i += 1) {
          const t = i / sampleRate;
          let sample = 0;
          if (plan.leadInstrument === 'bell_mallet') {
            const env = Math.min(1, t / 0.005) * Math.exp(-t * 6.8);
            sample =
              (Math.sin(2 * Math.PI * melFreq * t) * 0.68 +
                Math.sin(2 * Math.PI * melFreq * 2.76 * t) * Math.exp(-t * 14) * 0.24 +
                Math.sin(2 * Math.PI * melFreq * 4 * t) * Math.exp(-t * 20) * 0.12) *
              env;
          } else if (plan.leadInstrument === 'supersaw') {
            const env = Math.min(1, t / 0.018) * Math.exp(-t * 3.1);
            const detune = 0.006;
            const rawSaw =
              (Math.sin(2 * Math.PI * melFreq * t) +
                Math.sin(2 * Math.PI * melFreq * (1 + detune) * t) +
                Math.sin(2 * Math.PI * melFreq * (1 - detune) * t) +
                0.45 * Math.sin(2 * Math.PI * melFreq * 2 * t) +
                0.22 * Math.sin(2 * Math.PI * melFreq * 3 * t)) /
              3.2;
            sample = Math.tanh(rawSaw * 1.45) * env;
          } else if (plan.leadInstrument === 'brass_lead') {
            const env = Math.min(1, t / 0.045) * Math.exp(-t * 2.4);
            const mod = Math.sin(2 * Math.PI * melFreq * t) * (1.2 + Math.exp(-t * 6));
            sample = Math.sin(2 * Math.PI * melFreq * t + 0.5 * mod) * env;
          } else {
            // electric_piano / warm_lead: FM bell-tine + warm body
            const env = Math.min(1, t / 0.008) * Math.exp(-t * 3.8);
            const tine = Math.sin(2 * Math.PI * melFreq * 3.5 * t) * Math.exp(-t * 16) * 0.55;
            sample =
              (Math.sin(2 * Math.PI * melFreq * t + tine) * 0.8 +
                Math.sin(2 * Math.PI * melFreq * 2 * t) * 0.16) *
              env;
          }
          const val = sample * (isChorus ? 0.19 : 0.16);
          left[startSample + i] += val * panL;
          right[startSample + i] += val * panR;
        }
      }
    }

    // 4. Bar Turnaround Crash / Riser at start of Chorus (bar 4, step 0)
    if (barIdx === 4 && stepInBar === 0) {
      const crashLen = Math.min(totalSamples - startSample, Math.floor(0.95 * sampleRate));
      let prevC = 0;
      for (let i = 0; i < crashLen; i += 1) {
        const t = i / sampleRate;
        const n = nextNoise();
        const hp = n - prevC * 0.78;
        prevC = n;
        const cVal = hp * Math.exp(-t * 3.6) * 0.085;
        left[startSample + i] += cVal * 0.9;
        right[startSample + i] += cVal * 1.1;
      }
    }

    // 5. Genre-Specific Drum & Percussion Kit
    if (plan.groove !== 'acoustic' || stepInBar % 4 === 0) {
      const hasKick =
        stepInBar === 0 ||
        ((plan.groove === 'edm' || plan.groove === 'synthwave') && stepInBar % 2 === 0) ||
        ((plan.groove === 'afrobeat' || plan.groove === 'amapiano') &&
          (stepInBar === 3 || stepInBar === 6)) ||
        (plan.groove === 'trap' && (stepInBar === 3 || stepInBar === 5)) ||
        (plan.groove === 'drill' && (stepInBar === 3 || stepInBar === 7)) ||
        (plan.groove === 'reggae' && stepInBar === 4) ||
        ((plan.groove === 'pop' || plan.groove === 'lofi' || plan.groove === 'rock' || plan.groove === 'rnb') &&
          (stepInBar === 4 || (isChorus && stepInBar === 6)));

      if (hasKick) {
        const kickLen = Math.min(totalSamples - startSample, Math.floor(0.2 * sampleRate));
        for (let i = 0; i < kickLen; i += 1) {
          const t = i / sampleRate;
          const freq = 48 + 125 * Math.exp(-t * 38);
          const env = Math.exp(-t * 15);
          const k = Math.sin(2 * Math.PI * freq * t) * env * 0.35;
          left[startSample + i] += k;
          right[startSample + i] += k;
        }
      }

      const hasSnare =
        plan.groove === 'afrobeat' || plan.groove === 'amapiano'
          ? stepInBar === 2 || stepInBar === 5 || stepInBar === 7
          : plan.groove === 'reggae'
            ? stepInBar === 4
            : stepInBar === 2 || stepInBar === 6;

      if (hasSnare) {
        const snareLen = Math.min(totalSamples - startSample, Math.floor(0.15 * sampleRate));
        for (let i = 0; i < snareLen; i += 1) {
          const t = i / sampleRate;
          const env = Math.exp(-t * (plan.groove === 'afrobeat' ? 34 : 22));
          const toneFreq = plan.groove === 'afrobeat' ? 380 : 195;
          const tone = Math.sin(2 * Math.PI * toneFreq * t) * 0.38;
          const noise = nextNoise() * (plan.groove === 'lofi' ? 0.45 : 0.65);
          const sn = (tone + noise) * env * (plan.groove === 'lofi' ? 0.11 : 0.18);
          left[startSample + i] += sn * 0.96;
          right[startSample + i] += sn * 1.04;
        }
      }

      if (plan.groove !== 'cinematic') {
        const hatLen = Math.min(totalSamples - startSample, Math.floor(0.05 * sampleRate));
        const hatAmp =
          plan.groove === 'drill' || plan.groove === 'trap'
            ? 0.085
            : stepInBar % 2 === 1
              ? 0.07
              : 0.035;
        let prevN = 0;
        for (let i = 0; i < hatLen; i += 1) {
          const t = i / sampleRate;
          const n = nextNoise();
          const hp = n - prevN * 0.86;
          prevN = n;
          const env = Math.exp(-t * 92);
          const h = hp * env * hatAmp;
          left[startSample + i] += h * 0.9;
          right[startSample + i] += h * 1.1;
        }
      }
    }
  }

  // Lush Stereo Ping-Pong Delay + Multi-Tap Schroeder Diffusion
  const d1 = Math.floor(stepSeconds * 1.5 * sampleRate);
  const d2 = Math.floor(stepSeconds * 2.25 * sampleRate);
  for (let i = d2; i < totalSamples; i += 1) {
    left[i] += right[i - d1] * 0.22 + left[i - d2] * 0.12;
    right[i] += left[i - d1] * 0.22 + right[i - d2] * 0.12;
  }

  const fadeInSamples = Math.floor(0.06 * sampleRate);
  const fadeOutSamples = Math.floor(0.95 * sampleRate);
  const wav = Buffer.alloc(44 + totalSamples * 4);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + totalSamples * 4, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(totalSamples * 4, 40);

  for (let i = 0; i < totalSamples; i += 1) {
    let gain = 1;
    if (i < fadeInSamples) gain = i / Math.max(1, fadeInSamples);
    else if (i > totalSamples - fadeOutSamples) {
      gain = Math.max(0, (totalSamples - i) / Math.max(1, fadeOutSamples));
    }
    const l = Math.tanh(left[i] * gain * 1.2);
    const r = Math.tanh(right[i] * gain * 1.2);
    wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(l * 30800))), 44 + i * 4);
    wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(r * 30800))), 46 + i * 4);
  }

  return wav;
}

async function generateKeylessAiMusic(prompt: string): Promise<GeneratedMediaResult> {
  const arrangement = await composeArrangementWithAi(prompt);
  const wavBuffer = renderArrangementToStereoWav(arrangement);
  return {
    kind: 'music',
    prompt,
    dataUrl: bufferToDataUrl(wavBuffer, 'audio/wav'),
    mimeType: 'audio/wav',
    modelId: `aicraft::music-${arrangement.groove}-${arrangement.bpm}bpm`,
    gateway: 'pollinations',
  };
}

export async function generateMediaAsset(params: {
  kind: MediaAssetKind;
  prompt: string;
  requestedModel?: string;
}): Promise<GeneratedMediaResult> {
  const cleanPrompt = params.prompt.trim().slice(0, 1200);
  if (!cleanPrompt) {
    throw new Error('A prompt is required to generate media.');
  }

  const parsed = parseGatewayModelIdentifier(params.requestedModel);
  if (isTextToSpeechModel(parsed.upstreamModelId)) {
    throw new Error(
      'Text-to-Speech models are disabled. Use an Image, Music, or Video model.'
    );
  }

  // 1. Prefer Gemini Image / Lyria Music directly if configured & not throttled
  if (params.kind === 'image' && parsed.gateway !== 'huggingface') {
    const geminiImg = await generateGeminiImage(cleanPrompt, params.requestedModel);
    if (geminiImg) return geminiImg;
  }
  if (params.kind === 'music' && parsed.gateway !== 'huggingface') {
    const geminiMusic = await generateGeminiMusic(cleanPrompt);
    if (geminiMusic) return geminiMusic;
  }

  const hfPool = getHuggingFaceApiKeyPool();
  const ngrokPool = getNgrokApiKeyPool();

  const candidates: Array<{
    gateway: 'huggingface' | 'ngrok' | 'pollinations';
    apiKey: string;
    modelId: string;
    cooldownKey: string;
  }> = [];
  const seen = new Set<string>();

  const addCandidate = (
    gateway: 'huggingface' | 'ngrok' | 'pollinations',
    apiKey: string,
    modelId: string
  ) => {
    const cleanId = modelId.trim();
    if (!cleanId || isTextToSpeechModel(cleanId)) return;
    const key = buildCandidateCooldownKey(gateway, apiKey, cleanId);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ gateway, apiKey, modelId: cleanId, cooldownKey: key });
  };

  if (params.kind === 'image') {
    if (parsed.gateway === 'pollinations' && parsed.upstreamModelId) {
      addCandidate('pollinations', '', parsed.upstreamModelId);
    }
    if (parsed.gateway === 'huggingface' && parsed.upstreamModelId) {
      for (const apiKey of hfPool.slice(0, 2)) {
        addCandidate('huggingface', apiKey, parsed.upstreamModelId);
      }
    }
    for (const fb of HUGGING_FACE_IMAGE_FALLBACKS.slice(0, 2)) {
      for (const apiKey of hfPool.slice(0, 2)) {
        addCandidate('huggingface', apiKey, fb.id);
      }
    }
    if (ngrokPool.length > 0) {
      const ngrokImgModel =
        parsed.gateway === 'ngrok' && parsed.upstreamModelId
          ? parsed.upstreamModelId
          : 'gpt-image-1';
      for (const apiKey of ngrokPool.slice(0, 2)) {
        addCandidate('ngrok', apiKey, ngrokImgModel);
      }
    }
    addCandidate('pollinations', '', 'sana');
  } else if (params.kind === 'music') {
    if (parsed.gateway === 'pollinations' || parsed.upstreamModelId === 'music-composer') {
      addCandidate('pollinations', '', 'music-composer');
    }
    if (parsed.gateway === 'huggingface' && parsed.upstreamModelId) {
      for (const apiKey of hfPool.slice(0, 2)) {
        addCandidate('huggingface', apiKey, parsed.upstreamModelId);
      }
    }
    for (const fb of HUGGING_FACE_MUSIC_FALLBACKS.slice(0, 2)) {
      for (const apiKey of hfPool.slice(0, 2)) {
        addCandidate('huggingface', apiKey, fb.id);
      }
    }
    addCandidate('pollinations', '', 'music-composer');
  } else {
    if (hfPool.length === 0) {
      throw new Error(
        'Video generation requires HUGGING_FACE_API_KEY configured in your environment variables.'
      );
    }
    if (parsed.gateway === 'huggingface' && parsed.upstreamModelId) {
      for (const apiKey of hfPool.slice(0, 2)) {
        addCandidate('huggingface', apiKey, parsed.upstreamModelId);
      }
    }
    for (const fb of HUGGING_FACE_VIDEO_FALLBACKS.slice(0, 2)) {
      for (const apiKey of hfPool.slice(0, 2)) {
        addCandidate('huggingface', apiKey, fb.id);
      }
    }
  }

  const ordered = [
    ...candidates.filter((c) => !isGatewayCandidateCoolingDown(c.cooldownKey)),
    ...candidates.filter((c) => isGatewayCandidateCoolingDown(c.cooldownKey)),
  ];

  let lastError: Error | null = null;

  for (const cand of ordered) {
    const timeoutMs =
      params.kind === 'video'
        ? 40000
        : cand.gateway === 'huggingface'
          ? 9000
          : params.kind === 'music'
            ? 14000
            : 14000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (cand.gateway === 'pollinations') {
        if (params.kind === 'music' || cand.modelId === 'music-composer') {
          return await generateKeylessAiMusic(cleanPrompt);
        }
        const seed = crypto.randomInt(1, 10_000_000);
        const polModel = cand.modelId === 'flux' || cand.modelId === 'turbo' ? 'sana' : cand.modelId;
        const url = `${DEFAULT_POLLINATIONS_IMAGE_URL}/prompt/${encodeURIComponent(
          cleanPrompt
        )}?model=${encodeURIComponent(polModel)}&width=1024&height=1024&seed=${seed}&nologo=true`;
        const res = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AICraft/1.0)',
            Accept: 'image/*,*/*;q=0.8',
          },
        });
        if (!res.ok) {
          if (res.status === 429 || res.status === 503 || res.status === 402) {
            markGatewayCandidateCooldown(cand.cooldownKey, 45_000);
          }
          throw new Error(`Image generator unavailable (${res.status})`);
        }
        const contentType =
          (res.headers.get('content-type') || '').split(';')[0]?.trim() ||
          'image/jpeg';
        if (!contentType.startsWith('image/')) {
          throw new Error(`Unexpected response content type: ${contentType}`);
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength < 512) {
          throw new Error('Empty image payload received.');
        }
        return {
          kind: params.kind,
          prompt: cleanPrompt,
          dataUrl: bufferToDataUrl(buf, contentType),
          mimeType: contentType,
          modelId: `pollinations::${polModel}`,
          gateway: 'pollinations',
        };
      } else if (cand.gateway === 'huggingface') {
        const res = await fetch(
          `${DEFAULT_HUGGING_FACE_INFERENCE_URL}/${cand.modelId}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cand.apiKey}`,
              'Content-Type': 'application/json',
              'x-wait-for-model': 'true',
            },
            body: JSON.stringify({
              inputs: cleanPrompt,
            }),
            signal: controller.signal,
          }
        );

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 429 || res.status === 402 || res.status === 503) {
            markGatewayCandidateCooldown(cand.cooldownKey, 90_000);
          }
          throw new Error(
            `Hugging Face ${cand.modelId} failed (${res.status})${
              text ? `: ${text.slice(0, 140)}` : ''
            }`
          );
        }

        const defaultMime =
          params.kind === 'video'
            ? 'video/mp4'
            : params.kind === 'music'
              ? 'audio/flac'
              : 'image/png';
        const contentType =
          (res.headers.get('content-type') || '').split(';')[0]?.trim() ||
          defaultMime;

        if (contentType.includes('application/json')) {
          const json = (await res.json()) as {
            error?: string;
            image?: string;
            audio?: string;
            video?: string;
            url?: string;
          };
          if (json?.error) {
            throw new Error(json.error);
          }
          const embedded = json?.video || json?.audio || json?.image || json?.url;
          if (typeof embedded === 'string' && embedded.trim()) {
            const val = embedded.trim();
            if (val.startsWith('data:') || /^https?:\/\//i.test(val)) {
              return {
                kind: params.kind,
                prompt: cleanPrompt,
                dataUrl: val,
                mimeType: defaultMime,
                modelId: `hf::${cand.modelId}`,
                gateway: 'huggingface',
              };
            }
            return {
              kind: params.kind,
              prompt: cleanPrompt,
              dataUrl: `data:${defaultMime};base64,${val}`,
              mimeType: defaultMime,
              modelId: `hf::${cand.modelId}`,
              gateway: 'huggingface',
            };
          }
          throw new Error(`Unexpected JSON payload returned by ${cand.modelId}`);
        }

        const buf = await res.arrayBuffer();
        if (buf.byteLength < 64) {
          throw new Error(`Empty media payload returned by ${cand.modelId}`);
        }

        return {
          kind: params.kind,
          prompt: cleanPrompt,
          dataUrl: bufferToDataUrl(buf, contentType),
          mimeType: contentType,
          modelId: `hf::${cand.modelId}`,
          gateway: 'huggingface',
        };
      } else {
        const res = await fetch(`${getNgrokGatewayBaseUrl()}/images/generations`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cand.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: cand.modelId,
            prompt: cleanPrompt,
            response_format: 'b64_json',
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 429 || res.status === 402 || res.status === 503) {
            markGatewayCandidateCooldown(cand.cooldownKey, 75_000);
          }
          throw new Error(
            `ngrok image gateway failed (${res.status})${
              text ? `: ${text.slice(0, 140)}` : ''
            }`
          );
        }

        const json = (await res.json()) as {
          data?: Array<{ b64_json?: string; url?: string }>;
        };
        const first = json?.data?.[0];
        if (first?.b64_json) {
          return {
            kind: params.kind,
            prompt: cleanPrompt,
            dataUrl: `data:image/png;base64,${first.b64_json}`,
            mimeType: 'image/png',
            modelId: `ngrok::${cand.modelId}`,
            gateway: 'ngrok',
          };
        }
        if (first?.url) {
          return {
            kind: params.kind,
            prompt: cleanPrompt,
            dataUrl: first.url,
            mimeType: 'image/png',
            modelId: `ngrok::${cand.modelId}`,
            gateway: 'ngrok',
          };
        }
        throw new Error('ngrok gateway returned no image data.');
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  // Guaranteed Google/Bing/Wikimedia image search grounding fallback for images so it NEVER fails
  if (params.kind === 'image') {
    const webImg = await fetchVerifiedWebImageFallback(cleanPrompt);
    if (webImg) return webImg;
  }

  // Final safety net for music so music generation NEVER fails
  if (params.kind === 'music') {
    return generateKeylessAiMusic(cleanPrompt);
  }

  throw (
    lastError ??
    new Error(
      `Unable to generate ${params.kind} right now across configured gateways.`
    )
  );
}
