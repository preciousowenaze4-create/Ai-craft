export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url, 'http://localhost');
  const jobId = (url.searchParams.get('jobId') || '').trim();
  return Response.json(
    {
      ok: false,
      jobId: jobId || null,
      error: 'Build stream is not active on this worker instance.',
    },
    {
      status: 404,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    }
  );
}
