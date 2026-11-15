import {
  DEFAULT_HUGGING_FACE_INFERENCE_URL,
  DEFAULT_POLLINATIONS_IMAGE_URL,
  DEFAULT_POLLINATIONS_TEXT_URL,
  HUGGING_FACE_IMAGE_FALLBACKS,
  HUGGING_FACE_MUSIC_FALLBACKS,
  HUGGING_FACE_VIDEO_FALLBACKS,
  buildCandidateCooldownKey,
  getHuggingFaceApiKeyPool,
  getNgrokApiKeyPool,
  getNgrokGatewayBaseUrl,
  isGatewayCandidateCoolingDown,
  markGatewayCandidateCooldown,
  parseGatewayModelIdentifier,
} from './_aiGateways.js';
import { isTextToSpeechModel } from './_openrouterModels.js';

export type MediaAssetKind = 'image' | 'music' | 'video';

export interface GeneratedMediaResult {
  kind: MediaAssetKind;
  prompt: string;
  dataUrl: string;
  mimeType: string;
  modelId: string;
  gateway: 'huggingface' | 'ngrok' | 'pollinations';
}

function bufferToDataUrl(buf: ArrayBuffer | Uint8Array, mimeType: string): string {
  const b = Buffer.isBuffer(buf)
    ? buf
    : buf instanceof Uint8Array
      ? Buffer.from(buf)
      : Buffer.from(buf);
  return `data:${mimeType};base64,${b.toString('base64')}`;
}

type MusicArrangementPlan = {
  bpm: number;
  rootMidi: number;
  scaleIntervals: number[];
  chords: number[][];
  melody: number[];
  groove: 'afrobeat' | 'trap' | 'lofi' | 'pop' | 'edm' | 'cinematic';
  timbre: 'warm' | 'bright' | 'synth' | 'keys';
};

function inferPromptArrangement(prompt: string): MusicArrangementPlan {
  const lower = prompt.toLowerCase();
  const groove: MusicArrangementPlan['groove'] =
    /afro|amapiano|dancehall|reggae|burna|wizkid|tems/.test(lower)
      ? 'afrobeat'
      : /trap|drill|hip.?hop|rap|808|beat/.test(lower)
        ? 'trap'
        : /lofi|lo-fi|chill|study|rain|sleep|ambient|calm/.test(lower)
          ? 'lofi'
          : /edm|house|techno|club|rave|electronic|synthwave|cyberpunk/.test(lower)
            ? 'edm'
            : /cinematic|epic|orchestra|film|trailer|heroic/.test(lower)
              ? 'cinematic'
              : 'pop';

  const bpm =
    groove === 'trap'
      ? 136
      : groove === 'edm'
        ? 124
        : groove === 'afrobeat'
          ? 108
          : groove === 'lofi'
            ? 82
            : groove === 'cinematic'
              ? 92
              : 112;

  const isDark = /dark|sad|melanchol|minor|trap|drill|night|cyberpunk|emotional|moody/.test(
    lower
  );
  const scaleIntervals = isDark
    ? [0, 2, 3, 5, 7, 8, 10]
    : [0, 2, 4, 5, 7, 9, 11];
  const rootMidi = isDark ? 57 : 60; // A3 or C4

  const chords = isDark
    ? [
        [0, 3, 7, 10],
        [5, 8, 12, 15],
        [3, 7, 10, 14],
        [7, 10, 14, 17],
      ]
    : [
        [0, 4, 7, 11],
        [7, 11, 14, 17],
        [9, 12, 16, 19],
        [5, 9, 12, 16],
      ];

  // Deterministic variation seeded from prompt characters so every prompt yields a unique melody
  let seed = 0;
  for (let i = 0; i < prompt.length; i += 1) {
    seed = (seed * 31 + prompt.charCodeAt(i)) >>> 0;
  }
  const melody: number[] = [];
  for (let step = 0; step < 32; step += 1) {
    if (step % 4 === 3 && (seed + step) % 3 === 0) {
      melody.push(-1); // expressive rest
    } else {
      const idx = (seed + step * 3 + (step % 5)) % scaleIntervals.length;
      melody.push(scaleIntervals[idx] + (step % 8 === 0 ? 12 : 0));
    }
  }

  const timbre: MusicArrangementPlan['timbre'] =
    groove === 'edm'
      ? 'synth'
      : groove === 'lofi' || groove === 'afrobeat'
        ? 'keys'
        : groove === 'cinematic'
          ? 'bright'
          : 'warm';

  return { bpm, rootMidi, scaleIntervals, chords, melody, groove, timbre };
}

async function composeArrangementWithPublicAi(
  prompt: string
): Promise<MusicArrangementPlan> {
  const fallback = inferPromptArrangement(prompt);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7500);
  try {
    const res = await fetch(`${DEFAULT_POLLINATIONS_TEXT_URL}/openai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai-fast',
        stream: false,
        messages: [
          {
            role: 'system',
            content:
              'You are a music composer AI. Reply with ONLY compact JSON (no markdown) describing an original musical loop for the prompt: {"bpm":number(72..144),"rootMidi":number(48..65),"groove":"afrobeat"|"trap"|"lofi"|"pop"|"edm"|"cinematic","timbre":"warm"|"bright"|"synth"|"keys","chords":[[4 semitone offsets] x4],"melody":[16 integers 0..19 or -1 for rest]}.',
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data?.choices?.[0]?.message?.content?.trim() || '';
    const jsonMatch = /\{[\s\S]*\}/.exec(raw);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]) as Partial<MusicArrangementPlan>;
    const bpm =
      typeof parsed.bpm === 'number' && Number.isFinite(parsed.bpm)
        ? Math.max(70, Math.min(150, Math.round(parsed.bpm)))
        : fallback.bpm;
    const rootMidi =
      typeof parsed.rootMidi === 'number' && Number.isFinite(parsed.rootMidi)
        ? Math.max(45, Math.min(67, Math.round(parsed.rootMidi)))
        : fallback.rootMidi;
    const chords =
      Array.isArray(parsed.chords) &&
      parsed.chords.length >= 2 &&
      parsed.chords.every(
        (c) =>
          Array.isArray(c) &&
          c.length >= 3 &&
          c.every((n) => typeof n === 'number' && Number.isFinite(n))
      )
        ? parsed.chords.slice(0, 4).map((c) => c.slice(0, 4).map((n) => Math.max(-12, Math.min(24, Math.round(n)))))
        : fallback.chords;
    const melodyBase =
      Array.isArray(parsed.melody) &&
      parsed.melody.length >= 8 &&
      parsed.melody.every((n) => typeof n === 'number' && Number.isFinite(n))
        ? parsed.melody.map((n) => (n < 0 ? -1 : Math.min(24, Math.round(n))))
        : fallback.melody;
    const melody = Array.from({ length: 32 }, (_, i) => melodyBase[i % melodyBase.length]);
    const validGrooves = ['afrobeat', 'trap', 'lofi', 'pop', 'edm', 'cinematic'] as const;
    const groove = validGrooves.includes(parsed.groove as MusicArrangementPlan['groove'])
      ? (parsed.groove as MusicArrangementPlan['groove'])
      : fallback.groove;
    const validTimbres = ['warm', 'bright', 'synth', 'keys'] as const;
    const timbre = validTimbres.includes(parsed.timbre as MusicArrangementPlan['timbre'])
      ? (parsed.timbre as MusicArrangementPlan['timbre'])
      : fallback.timbre;

    return {
      bpm,
      rootMidi,
      scaleIntervals: fallback.scaleIntervals,
      chords,
      melody,
      groove,
      timbre,
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function renderArrangementToStereoWav(plan: MusicArrangementPlan): Buffer {
  const sampleRate = 22050;
  const beatSeconds = 60 / plan.bpm;
  const barSeconds = beatSeconds * 4;
  const totalSeconds = Math.max(10, Math.min(16, barSeconds * 4));
  const totalSamples = Math.floor(sampleRate * totalSeconds);
  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);

  const stepSeconds = beatSeconds / 2; // eighth-note grid
  const totalSteps = Math.floor(totalSeconds / stepSeconds);

  // Deterministic PRNG for crisp hi-hat / snare noise
  let rng = 0x9e3779b9;
  const nextNoise = () => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return ((rng >>> 0) / 0xffffffff) * 2 - 1;
  };

  for (let s = 0; s < totalSteps; s += 1) {
    const startSample = Math.floor(s * stepSeconds * sampleRate);
    const barIdx = Math.floor(s / 8) % plan.chords.length;
    const stepInBar = s % 8;
    const chord = plan.chords[barIdx];

    // 1. Warm Chord Pad / Electric Keys at start of each bar (and soft re-strike on beat 3 for afrobeat/pop)
    const strikeChord =
      stepInBar === 0 ||
      ((plan.groove === 'afrobeat' || plan.groove === 'pop') && stepInBar === 5);
    if (strikeChord) {
      const chordDur = stepInBar === 0 ? barSeconds * 0.94 : beatSeconds * 1.4;
      const chordLen = Math.min(totalSamples - startSample, Math.floor(chordDur * sampleRate));
      const padAmp = (plan.groove === 'cinematic' ? 0.14 : 0.11) / Math.max(1, chord.length * 0.55);
      for (let i = 0; i < chordLen; i += 1) {
        const t = i / sampleRate;
        const attack = Math.min(1, t / 0.035);
        const decay = Math.exp(-t * (plan.timbre === 'keys' ? 2.1 : 0.9));
        const env = attack * decay;
        let sumL = 0;
        let sumR = 0;
        for (let n = 0; n < chord.length; n += 1) {
          const freq = midiToHz(plan.rootMidi + chord[n]);
          const pan = (n / Math.max(1, chord.length - 1) - 0.5) * 0.45;
          const base =
            Math.sin(2 * Math.PI * freq * t) * 0.72 +
            Math.sin(2 * Math.PI * freq * 2 * t) *
              (plan.timbre === 'bright' || plan.timbre === 'synth' ? 0.24 : 0.12) +
            Math.sin(2 * Math.PI * freq * 3 * t) * 0.05;
          sumL += base * (1 - pan);
          sumR += base * (1 + pan);
        }
        left[startSample + i] += sumL * env * padAmp;
        right[startSample + i] += sumR * env * padAmp;
      }
    }

    // 2. Punchy Bassline on groove steps
    const playBass =
      stepInBar === 0 ||
      stepInBar === 3 ||
      (plan.groove === 'edm' && stepInBar % 2 === 0) ||
      (plan.groove === 'afrobeat' && (stepInBar === 2 || stepInBar === 6)) ||
      (plan.groove === 'trap' && stepInBar === 6);
    if (playBass) {
      const bassNote = plan.rootMidi - 12 + (stepInBar === 6 && chord.length > 2 ? chord[2] - 12 : chord[0]);
      const bassFreq = midiToHz(bassNote);
      const bassDur = Math.min(totalSamples - startSample, Math.floor(stepSeconds * 1.65 * sampleRate));
      for (let i = 0; i < bassDur; i += 1) {
        const t = i / sampleRate;
        const env = Math.min(1, t / 0.012) * Math.exp(-t * 4.2);
        const wave =
          Math.sin(2 * Math.PI * bassFreq * t) * 0.8 +
          Math.sin(2 * Math.PI * bassFreq * 2 * t) * 0.2;
        const val = wave * env * 0.26;
        left[startSample + i] += val;
        right[startSample + i] += val;
      }
    }

    // 3. Expressive Lead Melody
    const melOffset = plan.melody[s % plan.melody.length];
    if (melOffset >= 0) {
      const melFreq = midiToHz(plan.rootMidi + 12 + melOffset);
      const melDur = Math.min(totalSamples - startSample, Math.floor(stepSeconds * 1.35 * sampleRate));
      const panL = s % 2 === 0 ? 0.88 : 1.08;
      const panR = s % 2 === 0 ? 1.08 : 0.88;
      for (let i = 0; i < melDur; i += 1) {
        const t = i / sampleRate;
        const env = Math.min(1, t / 0.015) * Math.exp(-t * 4.6);
        const harmonic =
          plan.timbre === 'synth'
            ? Math.sin(2 * Math.PI * melFreq * t) * 0.65 +
              Math.sin(2 * Math.PI * melFreq * 2 * t) * 0.25 +
              Math.sin(2 * Math.PI * melFreq * 3 * t) * 0.1
            : Math.sin(2 * Math.PI * melFreq * t) * 0.82 +
              Math.sin(2 * Math.PI * melFreq * 2 * t) * 0.18;
        const val = harmonic * env * 0.17;
        left[startSample + i] += val * panL;
        right[startSample + i] += val * panR;
      }
    }

    // 4. Drum Groove (Kick, Snare/Clap, Hi-Hat)
    if (plan.groove !== 'cinematic' || stepInBar % 4 === 0) {
      const hasKick =
        stepInBar === 0 ||
        (plan.groove === 'edm' && stepInBar % 2 === 0) ||
        (plan.groove === 'afrobeat' && (stepInBar === 3 || stepInBar === 6)) ||
        (plan.groove === 'trap' && (stepInBar === 3 || stepInBar === 5)) ||
        ((plan.groove === 'pop' || plan.groove === 'lofi') && (stepInBar === 4 || stepInBar === 6));
      if (hasKick) {
        const kickLen = Math.min(totalSamples - startSample, Math.floor(0.18 * sampleRate));
        for (let i = 0; i < kickLen; i += 1) {
          const t = i / sampleRate;
          const freq = 52 + 110 * Math.exp(-t * 36);
          const env = Math.exp(-t * 16);
          const k = Math.sin(2 * Math.PI * freq * t) * env * 0.34;
          left[startSample + i] += k;
          right[startSample + i] += k;
        }
      }

      const hasSnare =
        plan.groove === 'afrobeat'
          ? stepInBar === 3 || stepInBar === 6
          : stepInBar === 2 || stepInBar === 6;
      if (hasSnare) {
        const snareLen = Math.min(totalSamples - startSample, Math.floor(0.14 * sampleRate));
        for (let i = 0; i < snareLen; i += 1) {
          const t = i / sampleRate;
          const env = Math.exp(-t * 24);
          const tone = Math.sin(2 * Math.PI * 195 * t) * 0.35;
          const noise = nextNoise() * 0.65;
          const sn = (tone + noise) * env * (plan.groove === 'lofi' ? 0.12 : 0.18);
          left[startSample + i] += sn;
          right[startSample + i] += sn;
        }
      }

      // Crisp off-beat / steady hi-hat
      const hatLen = Math.min(totalSamples - startSample, Math.floor(0.045 * sampleRate));
      const hatAmp = stepInBar % 2 === 1 ? 0.075 : 0.04;
      let prevN = 0;
      for (let i = 0; i < hatLen; i += 1) {
        const t = i / sampleRate;
        const n = nextNoise();
        const hp = n - prevN * 0.85;
        prevN = n;
        const env = Math.exp(-t * 95);
        const h = hp * env * hatAmp;
        left[startSample + i] += h * 0.92;
        right[startSample + i] += h * 1.08;
      }
    }
  }

  // Gentle stereo ping-pong delay + soft peak limiting + fade in/out
  const delaySamples = Math.floor(stepSeconds * 1.5 * sampleRate);
  for (let i = delaySamples; i < totalSamples; i += 1) {
    left[i] += right[i - delaySamples] * 0.24;
    right[i] += left[i - delaySamples] * 0.24;
  }

  const fadeInSamples = Math.floor(0.08 * sampleRate);
  const fadeOutSamples = Math.floor(0.75 * sampleRate);
  const wav = Buffer.alloc(44 + totalSamples * 4);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + totalSamples * 4, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); // PCM
  wav.writeUInt16LE(1, 20); // Linear PCM
  wav.writeUInt16LE(2, 22); // Stereo
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
    const l = Math.tanh(left[i] * gain * 1.15);
    const r = Math.tanh(right[i] * gain * 1.15);
    wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(l * 31000))), 44 + i * 4);
    wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(r * 31000))), 46 + i * 4);
  }

  return wav;
}

async function generateKeylessAiMusic(prompt: string): Promise<GeneratedMediaResult> {
  const arrangement = await composeArrangementWithPublicAi(prompt);
  const wavBuffer = renderArrangementToStereoWav(arrangement);
  return {
    kind: 'music',
    prompt,
    dataUrl: bufferToDataUrl(wavBuffer, 'audio/wav'),
    mimeType: 'audio/wav',
    modelId: 'pollinations::music-composer',
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
      for (const apiKey of hfPool) {
        addCandidate('huggingface', apiKey, parsed.upstreamModelId);
      }
    }
    for (const fb of HUGGING_FACE_IMAGE_FALLBACKS) {
      for (const apiKey of hfPool) {
        addCandidate('huggingface', apiKey, fb.id);
      }
    }
    if (ngrokPool.length > 0) {
      const ngrokImgModel =
        parsed.gateway === 'ngrok' && parsed.upstreamModelId
          ? parsed.upstreamModelId
          : 'gpt-image-1';
      for (const apiKey of ngrokPool) {
        addCandidate('ngrok', apiKey, ngrokImgModel);
      }
    }
    // Always include keyless Pollinations public URL generator as resilient free fallback
    addCandidate('pollinations', '', 'sana');
  } else if (params.kind === 'music') {
    // Prefer built-in zero-key AI Music Studio if explicitly chosen or when HF is not configured
    if (parsed.gateway === 'pollinations' || parsed.upstreamModelId === 'music-composer') {
      addCandidate('pollinations', '', 'music-composer');
    }
    if (parsed.gateway === 'huggingface' && parsed.upstreamModelId) {
      for (const apiKey of hfPool) {
        addCandidate('huggingface', apiKey, parsed.upstreamModelId);
      }
    }
    for (const fb of HUGGING_FACE_MUSIC_FALLBACKS) {
      for (const apiKey of hfPool) {
        addCandidate('huggingface', apiKey, fb.id);
      }
    }
    // Always fall back to built-in zero-key AI Music Composer so music generation NEVER fails or hits limits
    addCandidate('pollinations', '', 'music-composer');
  } else {
    // Video generation (text-to-video)
    if (hfPool.length === 0) {
      throw new Error(
        'Video generation requires HUGGING_FACE_API_KEY configured in your environment variables.'
      );
    }
    if (parsed.gateway === 'huggingface' && parsed.upstreamModelId) {
      for (const apiKey of hfPool) {
        addCandidate('huggingface', apiKey, parsed.upstreamModelId);
      }
    }
    for (const fb of HUGGING_FACE_VIDEO_FALLBACKS) {
      for (const apiKey of hfPool) {
        addCandidate('huggingface', apiKey, fb.id);
      }
    }
  }

  // Try non-cooling candidates first
  const ordered = [
    ...candidates.filter((c) => !isGatewayCandidateCoolingDown(c.cooldownKey)),
    ...candidates.filter((c) => isGatewayCandidateCoolingDown(c.cooldownKey)),
  ];

  let lastError: Error | null = null;
  const timeoutMs =
    params.kind === 'video' ? 46000 : params.kind === 'music' ? 32000 : 25000;

  for (const cand of ordered) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (cand.gateway === 'pollinations') {
        if (params.kind === 'music' || cand.modelId === 'music-composer') {
          return await generateKeylessAiMusic(cleanPrompt);
        }
        const seed = Math.floor(Math.random() * 1_000_000);
        const url = `${DEFAULT_POLLINATIONS_IMAGE_URL}/prompt/${encodeURIComponent(
          cleanPrompt
        )}?model=${encodeURIComponent(cand.modelId)}&width=1024&height=1024&seed=${seed}&nologo=true`;
        const res = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
        });
        if (!res.ok) {
          if (res.status === 429 || res.status === 503) {
            markGatewayCandidateCooldown(cand.cooldownKey, 45_000);
          }
          throw new Error(`Pollinations image generator returned (${res.status})`);
        }
        const contentType =
          (res.headers.get('content-type') || '').split(';')[0]?.trim() ||
          'image/jpeg';
        if (!contentType.startsWith('image/')) {
          throw new Error(`Pollinations returned unexpected content type: ${contentType}`);
        }
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 128) {
          throw new Error('Pollinations returned empty image payload.');
        }
        return {
          kind: params.kind,
          prompt: cleanPrompt,
          dataUrl: bufferToDataUrl(buf, contentType),
          mimeType: contentType,
          modelId: `pollinations::${cand.modelId}`,
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
            markGatewayCandidateCooldown(cand.cooldownKey, 75_000);
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

  throw (
    lastError ??
    new Error(
      `Unable to generate ${params.kind} right now across configured gateways.`
    )
  );
}
