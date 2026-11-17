export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      audioBase64?: string;
    };
    const audioBase64 =
      typeof body?.audioBase64 === 'string' ? body.audioBase64.trim() : '';

    if (!audioBase64) {
      return Response.json({ error: 'Audio data is required.' }, { status: 400 });
    }

    // Voice typing runs directly via the browser Web Speech API with zero server API keys.
    return Response.json(
      {
        error:
          'Voice typing runs directly in your browser without API keys. Please allow microphone permission in Chrome, Edge, or Safari.',
      },
      { status: 422 }
    );
  } catch {
    return Response.json({ error: 'Unable to process audio input.' }, { status: 400 });
  }
}
