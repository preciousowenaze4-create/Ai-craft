import {
  DEFAULT_HUGGING_FACE_INFERENCE_URL,
  DEFAULT_POLLINATIONS_IMAGE_URL,
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

function bufferToDataUrl(buf: ArrayBuffer, mimeType: string): string {
  const base64 = Buffer.from(buf).toString('base64');
  return `data:${mimeType};base64,${base64}`;
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
    if (hfPool.length === 0) {
      throw new Error(
        'Music generation requires HUGGING_FACE_API_KEY configured in your environment variables.'
      );
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
