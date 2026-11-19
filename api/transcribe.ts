import { getServerGeminiApiKey } from './_aiGateways.js';
import { createGeminiClient } from './_realtimeEngine.js';

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

    const geminiKey = getServerGeminiApiKey();
    if (!geminiKey) {
      return Response.json(
        {
          error:
            'GEMINI_API_KEY is required for server-side voice transcription, or allow microphone permission in Chrome, Edge, or Safari.',
        },
        { status: 422 }
      );
    }

    const ai = createGeminiClient(geminiKey);
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-transcribe',
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
    if (!text) {
      return Response.json(
        { error: 'No speech detected in audio recording.' },
        { status: 422 }
      );
    }

    return Response.json({ text });
  } catch (err) {
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
