import crypto from 'node:crypto';
import {
  hasServerFreeAiKey,
  parseGatewayModelIdentifier,
  resolveDynamicGeminiExecutionMatrix,
} from './_aiGateways.js';
import { createGeminiClient } from './_realtimeEngine.js';
import { runLiveBrowserSearch } from './_builderCore.js';
import { isTextToSpeechModel } from './_openrouterModels.js';
import {
  recordGeminiApiError,
  recordGeminiApiUsage,
} from './_geminiUsage.js';

export type MediaAssetKind = 'image' | 'music' | 'video';

export interface GeneratedMediaResult {
  kind: MediaAssetKind;
  prompt: string;
  dataUrl: string;
  mimeType: string;
  modelId: string;
  gateway: 'gemini' | 'web-search' | 'browser';
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
    const cleanQuery = prompt
      .replace(
        /^(?:please\s+)?(?:can you\s+)?(?:generate|create|make|draw|paint|render|design|show(?:\s+me)?|search(?:\s+for)?|find(?:\s+me)?)\s+(?:an?\s+|the\s+|some\s+)?(?:real\s+|realistic\s+|high\s+quality\s+|hd\s+)?(?:image|photo|picture|illustration|artwork|wallpaper|logo|icon)(?:\s+of|\s+for|\s+showing)?\s*/i,
        ''
      )
      .trim() || prompt;
    const searchData = await runLiveBrowserSearch(cleanQuery);
    const candidates = searchData.images.map((i) => i.imageUrl).filter(Boolean);
    for (const url of candidates.slice(0, 8)) {
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

function buildKeylessSvgArtwork(prompt: string, isMotion = false): string {
  const safe = prompt
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 68);
  const hash = Array.from(prompt).reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 360, 42);
  const h1 = hash;
  const h2 = (hash + 65) % 360;
  const h3 = (hash + 140) % 360;
  const animRing = isMotion
    ? `<circle cx="400" cy="400" r="145" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="4" stroke-dasharray="28 18"><animateTransform attributeName="transform" type="rotate" from="0 400 400" to="360 400 400" dur="8s" repeatCount="indefinite"/></circle>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="800" height="800">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${h1},78%,56%)"/>
      <stop offset="50%" stop-color="hsl(${h2},74%,46%)"/>
      <stop offset="100%" stop-color="hsl(${h3},68%,24%)"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="55%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.42)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
  </defs>
  <rect width="800" height="800" fill="url(#bg)"/>
  <circle cx="400" cy="360" r="290" fill="url(#glow)"/>
  ${animRing}
  <rect x="64" y="610" width="672" height="126" rx="24" fill="rgba(11,11,15,0.52)"/>
  <text x="96" y="666" font-family="system-ui,sans-serif" font-size="24" font-weight="700" fill="#ffffff">${isMotion ? 'Motion Studio Preview' : 'AI Craft Studio'}</text>
  <text x="96" y="704" font-family="system-ui,sans-serif" font-size="18" fill="rgba(255,255,255,0.85)">${safe}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
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
  hasVocalLead: boolean;
  richExtended: boolean;
  vocalRegisterOffset: number; // 0 for baritone/tenor, +5/+7 for bright alto/soprano
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

  // Detect emotional guitar/vocal ballads ("shiver", "sing", "voice", "rich", "long")
  const hasVocalLead =
    /\b(sing|singing|voice|vocal|vocals|lyrics|song|shiver|ballad|serenade|choir|hum|chorus|verse|falsetto|tenor|soprano|alto|warm\s*voice)\b/i.test(
      lower
    );
  const richExtended =
    hasVocalLead ||
    /\b(long|rich|full|extended|journey|story|slow\s*build|cinematic|symphon)\b/i.test(lower);
  const vocalRegisterOffset =
    /\b(female|woman|soprano|alto|bright|high\s*voice|angelic|falsetto)\b/i.test(lower)
      ? 5
      : /\b(deep|male|baritone|bass\s*voice)\b/i.test(lower)
        ? -2
        : (seed % 3 === 0 ? 3 : 0);

  let effectiveGroove = groove;
  if (effectiveGroove === 'pop' && /\bshiver\b/.test(lower)) {
    effectiveGroove = 'acoustic';
  }

  let effectiveLead = leadInstrument;
  if (/acoustic|shiver|guitar|unplugged|ed\s*sheeran/.test(lower)) {
    effectiveLead = 'plucked_guitar';
  }

  const swing =
    effectiveGroove === 'jazz' || effectiveGroove === 'lofi'
      ? 0.24
      : effectiveGroove === 'afrobeat' || effectiveGroove === 'amapiano' || effectiveGroove === 'rnb'
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
    groove: effectiveGroove,
    leadInstrument: effectiveLead,
    bassStyle,
    swing,
    seed,
    hasVocalLead,
    richExtended,
    vocalRegisterOffset,
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

  if (hasServerFreeAiKey()) {
    const candidates = await resolveDynamicGeminiExecutionMatrix({ taskKind: 'media' });
    for (const candidate of candidates.slice(0, 5)) {
      try {
        const ai = createGeminiClient(candidate.apiKey);
        const response = await ai.models.generateContent({
          model: candidate.upstreamModelId,
          contents: prompt,
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: 'application/json',
          },
        });
        const outText = response.text || '';
        const usage = response.usageMetadata;
        void recordGeminiApiUsage({
          modelId: candidate.upstreamModelId,
          promptTokens: usage?.promptTokenCount,
          candidatesTokens: usage?.candidatesTokenCount,
          totalTokens: usage?.totalTokenCount ?? Math.max(80, Math.ceil((prompt.length + outText.length) / 4)),
          source: 'media-plan',
        });
        const plan = parseAiPlan(outText);
        if (plan) return plan;
      } catch {
        // silently try next live backend candidate
      }
    }
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
  // Multi-section song structure: Intro -> Verse -> Pre-Chorus -> Chorus Lift -> Outro
  const targetBars = plan.richExtended ? 14 : 10;
  const maxSeconds = plan.richExtended ? 26 : 19;
  const totalSeconds = Math.max(14, Math.min(maxSeconds, barSeconds * targetBars));
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

  // Expressive musical vowel-formant profiles (ah, eh, oh, oo, ih) for vocal lead synthesis (zero TTS)
  const vowelFormants: Array<[number, number, number]> = [
    [730, 1090, 2440], // ah
    [530, 1840, 2480], // eh
    [570, 840, 2410],  // oh
    [340, 920, 2240],  // oo
    [400, 1990, 2550], // ih
  ];

  const renderFormantNote = (
    freq: number,
    durSamples: number,
    startIdx: number,
    vowelIdx: number,
    gainScale: number,
    panL: number,
    panR: number
  ) => {
    const [f1, f2, f3] = vowelFormants[vowelIdx % vowelFormants.length];
    let p1 = 0;
    let p2 = 0;
    const w1 = (2 * Math.PI * f1) / sampleRate;
    const w2 = (2 * Math.PI * f2) / sampleRate;
    const r1 = Math.exp((-Math.PI * 85) / sampleRate);
    const r2 = Math.exp((-Math.PI * 115) / sampleRate);
    const c1_1 = 2 * r1 * Math.cos(w1);
    const c1_2 = r1 * r1;
    const c2_1 = 2 * r2 * Math.cos(w2);
    const c2_2 = r2 * r2;
    let y1a = 0;
    let y1b = 0;
    let y2a = 0;
    let y2b = 0;
    let glottalPhase = 0;
    let airPhase = 0;

    for (let i = 0; i < durSamples; i += 1) {
      const t = i / sampleRate;
      const env =
        Math.min(1, t / 0.045) *
        (i > durSamples - 1600 ? Math.max(0, (durSamples - i) / 1600) : 1) *
        Math.exp(-t * 1.15);
      // Natural singer vibrato blooming after initial 140ms onset + gentle pitch scoop on start
      const vibratoDepth = Math.min(1, Math.max(0, (t - 0.12) / 0.25)) * 0.0085;
      const vib = Math.sin(2 * Math.PI * 5.2 * t) * vibratoDepth;
      const pitchScoop = 1 - 0.035 * Math.exp(-t * 28);
      const instFreq = freq * pitchScoop * (1 + vib);
      glottalPhase += (2 * Math.PI * instFreq) / sampleRate;
      airPhase += (2 * Math.PI * f3) / sampleRate;

      // Soft glottal pulse train (rich odd+even harmonics without harsh buzz)
      const pulse =
        Math.sin(glottalPhase) * 0.56 +
        Math.sin(glottalPhase * 2) * 0.28 +
        Math.sin(glottalPhase * 3) * 0.14 +
        Math.sin(glottalPhase * 4) * 0.07;
      const breath = nextNoise() * 0.032 * Math.exp(-t * 4.5);
      const exc = pulse + breath;

      const out1 = exc + c1_1 * y1a - c1_2 * y1b;
      y1b = y1a;
      y1a = out1;
      const out2 = exc * 0.55 + c2_1 * y2a - c2_2 * y2b;
      y2b = y2a;
      y2a = out2;

      p1 = (out1 * 0.28 + out2 * 0.22 + Math.sin(airPhase) * 0.025) * env;
      p2 = Math.tanh(p1 * 1.35) * gainScale;
      left[startIdx + i] += p2 * panL;
      right[startIdx + i] += p2 * panR;
    }
  };

  for (let s = 0; s < totalSteps; s += 1) {
    const swingOffsetSec = s % 2 === 1 ? stepSeconds * plan.swing : 0;
    const startSample = Math.min(
      totalSamples - 1,
      Math.floor((s * stepSeconds + swingOffsetSec) * sampleRate)
    );
    const absoluteBar = Math.floor(s / 8);
    const barIdx = absoluteBar % plan.chords.length;
    const isIntro = absoluteBar < 2;
    const isPreChorus = absoluteBar >= 4 && absoluteBar < 6;
    const isChorus = absoluteBar >= 6 && absoluteBar < targetBars - 2;
    const isOutro = absoluteBar >= targetBars - 2;
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

    // 3. Multi-Timbral Expressive Lead Melody + Expressive Vocal-Formant Lead & Harmony
    const melArr = isChorus || isPreChorus ? plan.melodyB : plan.melodyA;
    const melOffset = melArr[s % melArr.length];
    if (melOffset >= 0 && (!isIntro || stepInBar % 2 === 0)) {
      const melFreq = midiToHz(plan.rootMidi + 12 + melOffset);
      const melDur = Math.min(
        totalSamples - startSample,
        Math.floor(stepSeconds * (isOutro ? 2.1 : 1.55) * sampleRate)
      );
      const panL = s % 2 === 0 ? 0.86 : 1.12;
      const panR = s % 2 === 0 ? 1.12 : 0.86;

      if (plan.hasVocalLead && !isIntro && !isOutro) {
        const vocalFreq = midiToHz(plan.rootMidi + 12 + plan.vocalRegisterOffset + melOffset);
        const vocalDur = Math.min(
          totalSamples - startSample,
          Math.floor(stepSeconds * (isChorus ? 2.15 : 1.75) * sampleRate)
        );
        const vowelIdx = (plan.seed + s * 3 + barIdx) % 5;
        renderFormantNote(
          vocalFreq,
          vocalDur,
          startSample,
          vowelIdx,
          isChorus ? 0.24 : 0.19,
          0.95,
          1.05
        );
        // Add stereo harmonic vocal third in Chorus
        if (isChorus && stepInBar % 2 === 0) {
          const harmFreq = midiToHz(
            plan.rootMidi + 12 + plan.vocalRegisterOffset + melOffset + 4
          );
          renderFormantNote(
            harmFreq,
            vocalDur,
            startSample,
            (vowelIdx + 2) % 5,
            0.12,
            1.15,
            0.85
          );
        }
      }

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
          const val = cur * fade * (plan.hasVocalLead ? 0.17 : 0.24);
          left[startSample + i] += val * panL;
          right[startSample + i] += val * panR;
        }
      } else if (!plan.hasVocalLead || isIntro || isOutro) {
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

    // 4. Bar Turnaround Crash / Riser entering Chorus
    if (absoluteBar === 6 && stepInBar === 0) {
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

    // 5. Genre-Specific Drum & Percussion Kit (drops cleanly in Intro/Outro)
    if (!isIntro && !isOutro && (plan.groove !== 'acoustic' || stepInBar % 4 === 0)) {
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
    gateway: 'gemini',
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

  if (params.kind === 'music') {
    return generateKeylessAiMusic(cleanPrompt);
  }

  // Real Google / Bing / Wikimedia web image search
  const webImg = await fetchVerifiedWebImageFallback(cleanPrompt);
  if (webImg) {
    return {
      ...webImg,
      kind: params.kind,
    };
  }

  // Guaranteed inline SVG studio fallback so media never crashes offline
  return {
    kind: params.kind,
    prompt: cleanPrompt,
    dataUrl: buildKeylessSvgArtwork(cleanPrompt, params.kind === 'video'),
    mimeType: 'image/svg+xml',
    modelId: params.kind === 'video' ? 'browser::motion-studio' : 'browser::svg-studio',
    gateway: 'browser',
  };
}
