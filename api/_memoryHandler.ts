import { createSelfHostedBrainAdapter } from './_aiBrain.js';
import {
  extractAuthTokensFromRequest,
  getAuthenticatedSupabaseUser,
} from './_billing.js';
import {
  checkSupabaseMemoryTablesReady,
  deleteProjectMemory,
  getProjectMemory,
  listUserProjectMemories,
  recordBuildCheckpoint,
  saveProjectMemorySnapshot,
  type SaveProjectMemoryInput,
} from './_projectMemory.js';

export async function handleMemoryRequest(request: Request): Promise<Response> {
  const { accessToken, refreshToken } = extractAuthTokensFromRequest(request);
  const auth = await getAuthenticatedSupabaseUser(accessToken, refreshToken);

  if (!auth.user) {
    return Response.json(
      {
        ok: false,
        error: 'Authentication required to access isolated AI project memory.',
        code: 'AUTH_REQUIRED',
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const memAuth = {
    userId: auth.user.id,
    email: auth.user.email || '',
    accessToken: auth.accessToken || accessToken,
  };

  const brainAdapter = createSelfHostedBrainAdapter();
  const brainStatus = brainAdapter.getStatus();
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const action = (url.searchParams.get('action') || '').trim().toLowerCase();
    const projectId = (url.searchParams.get('projectId') || '').trim();
    const sqlTablesReady = await checkSupabaseMemoryTablesReady(memAuth).catch(
      () => false
    );

    if (action === 'brain_status') {
      return Response.json(
        {
          ok: true,
          userId: memAuth.userId,
          sqlTablesReady,
          brainStatus,
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (projectId) {
      const result = await getProjectMemory(memAuth, projectId);
      return Response.json(
        {
          ok: true,
          found: Boolean(result.memory),
          userId: memAuth.userId,
          backend: result.backend,
          sqlTablesReady,
          brainStatus,
          memory: result.memory,
          brainContext: result.brainContext,
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const listed = await listUserProjectMemories(memAuth);
    return Response.json(
      {
        ok: true,
        userId: memAuth.userId,
        backend: listed.backend,
        sqlTablesReady,
        brainStatus,
        projects: listed.projects,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as
      | (Partial<SaveProjectMemoryInput> & {
          action?: 'save' | 'checkpoint' | 'retrieve';
          turnId?: string;
          phase?: 'idle' | 'understanding' | 'building' | 'paused' | 'complete' | 'error';
          phaseLabel?: string;
          pausedReason?: string;
          pausedMessage?: string;
          activeFile?: string;
          activeAction?: string;
          partialHtml?: string;
          bytesBuilt?: number;
          unfinishedTaskTitle?: string;
          completedTaskTitle?: string;
        })
      | null;

    if (!body || !body.projectId || typeof body.projectId !== 'string') {
      return Response.json(
        { ok: false, error: 'projectId is required.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (body.action === 'retrieve') {
      const result = await getProjectMemory(memAuth, body.projectId);
      return Response.json(
        {
          ok: true,
          found: Boolean(result.memory),
          userId: memAuth.userId,
          backend: result.backend,
          brainStatus,
          memory: result.memory,
          brainContext: result.brainContext,
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (body.action === 'checkpoint') {
      const cp = await recordBuildCheckpoint(memAuth, {
        projectId: body.projectId,
        title: body.title,
        mode: body.mode,
        turnId: body.turnId || `turn_${Date.now()}`,
        phase: body.phase || 'paused',
        phaseLabel: body.phaseLabel || 'Paused',
        pausedReason: body.pausedReason,
        pausedMessage: body.pausedMessage,
        activeFile: body.activeFile,
        activeAction: body.activeAction,
        partialHtml: body.partialHtml,
        bytesBuilt: body.bytesBuilt,
        unfinishedTaskTitle: body.unfinishedTaskTitle,
        completedTaskTitle: body.completedTaskTitle,
      });

      return Response.json(
        {
          ok: cp.ok,
          userId: memAuth.userId,
          backend: cp.backend,
          lastStoppedPoint: cp.lastStoppedPoint,
          brainStatus,
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const saved = await saveProjectMemorySnapshot(memAuth, {
      projectId: body.projectId,
      title: body.title,
      mode: body.mode,
      status: body.status,
      databaseSchema: body.databaseSchema,
      lastModelUsed: body.lastModelUsed,
      memorySummary: body.memorySummary,
      completedTasks: body.completedTasks,
      unfinishedTasks: body.unfinishedTasks,
      lastStoppedPoint: body.lastStoppedPoint,
      turns: body.turns,
      files: body.files,
      appendMessage: body.appendMessage,
    });

    return Response.json(
      {
        ok: saved.ok,
        userId: memAuth.userId,
        backend: saved.backend,
        memory: saved.memory,
        brainStatus,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (request.method === 'DELETE') {
    const projectId = (url.searchParams.get('projectId') || '').trim();
    if (!projectId) {
      return Response.json(
        { ok: false, error: 'projectId query parameter is required.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    const del = await deleteProjectMemory(memAuth, projectId);
    return Response.json(
      { ok: del.ok, userId: memAuth.userId, projectId },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return Response.json(
    { ok: false, error: 'Method not allowed.' },
    { status: 405, headers: { 'Cache-Control': 'no-store' } }
  );
}
