import { generateMediaAsset } from './_mediaService.js';

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      kind?: string;
      prompt?: string;
      model?: string;
    };

    const kind =
      body?.kind === 'music'
        ? 'music'
        : body?.kind === 'video'
          ? 'video'
          : 'image';
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    const requestedModel =
      typeof body?.model === 'string' ? body.model.trim() : undefined;

    if (!prompt) {
      return Response.json({ error: 'Prompt is required.' }, { status: 400 });
    }

    const result = await generateMediaAsset({
      kind,
      prompt,
      requestedModel,
    });

    return Response.json(result, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unable to generate media.';
    return Response.json({ error: message }, { status: 502 });
  }
}
