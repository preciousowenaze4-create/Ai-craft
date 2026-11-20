import {
  hasServerFreeAiKey,
  resolveDynamicGeminiExecutionMatrix,
} from './_aiGateways.js';
import { createGeminiClient } from './_realtimeEngine.js';
import {
  recordGeminiApiError,
  recordGeminiApiUsage,
} from './_geminiUsage.js';

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      audioBase64?: string;
      mimeType?: string;
      language?: string;
    };
    const audioBase64 =
      typeof body?.audioBase64 === 'string' ? body.audioBase64.trim() : '';
    const mimeType =
      typeof body?.mimeType === 'string' && body.mimeType.startsWith('audio/')
        ? body.mimeType.split(';')[0].trim()
        : 'audio/webm';

    if (!audioBase64) {
      return Response.json({ error: 'Audio data is required.' }, { status: 400 });
    }

    if (!hasServerFreeAiKey()) {
      return Response.json(
        {
          error:
            'GEMINI_API_KEY is required for server-side voice transcription, or allow microphone permission in Chrome, Edge, or Safari.',
        },
        { status: 422 }
      );
    }

    const candidates = await resolveDynamicGeminiExecutionMatrix({ taskKind: 'transcribe' });
    let lastTranscribeErr: unknown = null;
    for (const candidate of candidates.slice(0, 6)) {
      try {
        const ai = createGeminiClient(candidate.apiKey);
        const response = await ai.models.generateContent({
          model: candidate.upstreamModelId,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: audioBase64,
                },
              },
              {
                text: `Transcribe this audio cleanly into plain text${
                  body.language ? ` (spoken language hint: ${body.language})` : ''
                }. Return only the spoken words.`,
              },
            ],
          },
        });

        const text = (response.text || '').trim();
        const usage = response.usageMetadata;
        void recordGeminiApiUsage({
          modelId: candidate.upstreamModelId,
          promptTokens: usage?.promptTokenCount,
          candidatesTokens: usage?.candidatesTokenCount,
          totalTokens: usage?.totalTokenCount ?? Math.max(50, Math.ceil(text.length / 4)),
          source: 'transcribe',
        });
        if (!text) {
          return Response.json(
            { error: 'No speech detected in audio recording.' },
            { status: 422 }
          );
        }

        return Response.json({ text });
      } catch (err) {
        lastTranscribeErr = err;
      }
    }

    throw lastTranscribeErr instanceof Error
      ? lastTranscribeErr
      : new Error('Unable to transcribe audio input.');
  } catch (err) {
    void recordGeminiApiError({
      modelId: 'gemini-3.8-flash',
      error: err,
      source: 'transcribe',
    });
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : 'Unable to transcribe audio input.',
      },
      { status: 500 }
    );
  }
}
