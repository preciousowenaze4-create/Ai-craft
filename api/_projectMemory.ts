import { createClient } from '@supabase/supabase-js';
import {
  type AiConversationRecord,
  type AiFileChangeRecord,
  type AiProjectFileRecord,
  type AiProjectMemoryListItem,
  type AiProjectMemoryRecord,
  type AiStoppedPoint,
  type AiTaskItem,
  type BrainBuildStatus,
  buildMemoryAugmentedContext,
  deriveTasksAndStoppedPoint,
} from './_aiBrain.js';
import {
  createUserScopedSupabaseClient,
  getSupabaseConfig,
} from './_supabaseAuth.js';

const WORKSPACE_BUCKET = 'aicraft-user-data';

export interface MemoryAuthContext {
  userId: string;
  email?: string;
  accessToken?: string;
}

export interface SaveProjectMemoryInput {
  projectId: string;
  title?: string;
  mode?: 'mobile' | 'web';
  status?: BrainBuildStatus;
  databaseSchema?: unknown[];
  lastModelUsed?: string;
  memorySummary?: string;
  completedTasks?: AiTaskItem[];
  unfinishedTasks?: AiTaskItem[];
  lastStoppedPoint?: AiStoppedPoint | null;
  /** Optional raw turns from workspace so server derives tasks/messages/files/stop-point cleanly. */
  turns?: Array<{
    id: string;
    kind?: 'chat' | 'build' | 'media';
    userMessage?: string;
    aiText?: string;
    phase?: string;
    phaseLabel?: string;
    activeAction?: string;
    activeFile?: string;
    files?: string[];
    planSteps?: string[];
    previewHtml?: string;
    bytesBuilt?: number;
    modelId?: string;
    pausedReason?: string;
    pausedMessage?: string;
    pausedAt?: string;
    errorMessage?: string;
  }>;
  /** Optional explicit file snapshots & change note. */
  files?: Array<{
    filePath: string;
    content: string;
    changeSummary?: string;
  }>;
  /** Optional single new message pair to append without sending full turn array. */
  appendMessage?: {
    turnId: string;
    role: 'user' | 'assistant' | 'system';
    kind?: 'chat' | 'build' | 'media';
    content: string;
    phase?: string;
    modelUsed?: string;
    planSteps?: string[];
  };
}

// In-process isolated map used ONLY as emergency fallback if neither Supabase RLS tables
// nor Supabase Storage bucket is writable in offline local runs. Keyed strictly by `${userId}::${projectId}`.
const processMemoryStore = new Map<string, AiProjectMemoryRecord>();
let memoryBucketEnsured = false;

export function sanitizeMemoryProjectId(raw: string): string {
  const clean = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return clean;
}

function createServiceClient() {
  const { url, serviceRoleKey } = getSupabaseConfig();
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function getDbClientForUser(auth: MemoryAuthContext) {
  // Prefer user-JWT client so Supabase PostgreSQL Row Level Security (auth.uid() = user_id) enforces isolation.
  if (auth.accessToken) {
    const rlsClient = createUserScopedSupabaseClient(auth.accessToken);
    if (rlsClient) return { client: rlsClient, mode: 'rls_jwt' as const };
  }
  const svcClient = createServiceClient();
  if (svcClient) return { client: svcClient, mode: 'service_scoped' as const };
  return null;
}

function isMissingRelationError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  const code = String(err.code || '').toUpperCase();
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    msg.includes('does not exist') ||
    msg.includes('could not find the table') ||
    msg.includes('schema cache')
  );
}

async function ensureMemoryBucket(): Promise<boolean> {
  const svc = createServiceClient();
  if (!svc) return false;
  if (memoryBucketEnsured) return true;

  const { error: getErr } = await svc.storage.getBucket(WORKSPACE_BUCKET);
  if (!getErr) {
    memoryBucketEnsured = true;
    return true;
  }
  const { error: createErr } = await svc.storage.createBucket(WORKSPACE_BUCKET, {
    public: false,
  });
  if (!createErr || /already exists/i.test(createErr.message)) {
    memoryBucketEnsured = true;
    return true;
  }
  return false;
}

function storageProjectPath(userId: string, projectId: string): string {
  return `ai-memory/${userId}/projects/${projectId}.json`;
}

function storageIndexPath(userId: string): string {
  return `ai-memory/${userId}/index.json`;
}

async function saveToSupabaseStorageFallback(
  record: AiProjectMemoryRecord
): Promise<'supabase_storage' | 'memory_cache'> {
  const key = `${record.userId}::${record.projectId}`;
  processMemoryStore.set(key, record);

  const svc = createServiceClient();
  if (!svc) return 'memory_cache';
  const ready = await ensureMemoryBucket();
  if (!ready) return 'memory_cache';

  const jsonBody = JSON.stringify(record);
  const { error } = await svc.storage
    .from(WORKSPACE_BUCKET)
    .upload(storageProjectPath(record.userId, record.projectId), Buffer.from(jsonBody, 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    });
  if (error) return 'memory_cache';

  // Update per-user project index inside Supabase Storage
  try {
    const existingList = await listFromSupabaseStorageFallback(record.userId);
    const summaryItem: AiProjectMemoryListItem = {
      projectId: record.projectId,
      userId: record.userId,
      title: record.title,
      mode: record.mode,
      status: record.status,
      completedTaskCount: record.completedTasks.length,
      unfinishedTaskCount: record.unfinishedTasks.length,
      fileCount: record.files.length,
      messageCount: record.messages.length,
      lastStoppedPoint: record.lastStoppedPoint,
      memorySummary: record.memorySummary,
      updatedAt: record.updatedAt,
    };
    const merged = [
      summaryItem,
      ...existingList.filter((item) => item.projectId !== record.projectId),
    ]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 100);

    await svc.storage
      .from(WORKSPACE_BUCKET)
      .upload(storageIndexPath(record.userId), Buffer.from(JSON.stringify(merged), 'utf8'), {
        contentType: 'application/json',
        upsert: true,
      });
  } catch {
    // non-fatal index update
  }

  return 'supabase_storage';
}

async function loadFromSupabaseStorageFallback(
  userId: string,
  projectId: string
): Promise<AiProjectMemoryRecord | null> {
  const svc = createServiceClient();
  if (svc && (await ensureMemoryBucket())) {
    const { data, error } = await svc.storage
      .from(WORKSPACE_BUCKET)
      .download(storageProjectPath(userId, projectId));
    if (!error && data) {
      try {
        const text = await data.text();
        const parsed = text ? (JSON.parse(text) as AiProjectMemoryRecord) : null;
        if (parsed && parsed.userId === userId && parsed.projectId === projectId) {
          processMemoryStore.set(`${userId}::${projectId}`, parsed);
          return parsed;
        }
      } catch {
        // ignore corrupted JSON
      }
    }
  }
  const cached = processMemoryStore.get(`${userId}::${projectId}`);
  return cached && cached.userId === userId ? cached : null;
}

async function listFromSupabaseStorageFallback(
  userId: string
): Promise<AiProjectMemoryListItem[]> {
  const svc = createServiceClient();
  if (svc && (await ensureMemoryBucket())) {
    const { data, error } = await svc.storage
      .from(WORKSPACE_BUCKET)
      .download(storageIndexPath(userId));
    if (!error && data) {
      try {
        const text = await data.text();
        const parsed = text ? (JSON.parse(text) as AiProjectMemoryListItem[]) : [];
        if (Array.isArray(parsed)) {
          return parsed.filter((item) => item && item.userId === userId);
        }
      } catch {
        // ignore malformed index
      }
    }
  }

  const out: AiProjectMemoryListItem[] = [];
  for (const record of processMemoryStore.values()) {
    if (record.userId !== userId) continue;
    out.push({
      projectId: record.projectId,
      userId: record.userId,
      title: record.title,
      mode: record.mode,
      status: record.status,
      completedTaskCount: record.completedTasks.length,
      unfinishedTaskCount: record.unfinishedTasks.length,
      fileCount: record.files.length,
      messageCount: record.messages.length,
      lastStoppedPoint: record.lastStoppedPoint,
      memorySummary: record.memorySummary,
      updatedAt: record.updatedAt,
    });
  }
  return out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function buildFilesWithChangeHistory(params: {
  existingFiles: AiProjectFileRecord[];
  incomingFiles?: Array<{ filePath: string; content: string; changeSummary?: string }>;
  turns?: SaveProjectMemoryInput['turns'];
  nowIso: string;
}): AiProjectFileRecord[] {
  const fileMap = new Map<string, AiProjectFileRecord>();
  for (const existing of params.existingFiles) {
    if (existing?.filePath) {
      fileMap.set(existing.filePath, existing);
    }
  }

  const incomingList: Array<{
    filePath: string;
    content: string;
    changeSummary?: string;
  }> = [];

  if (Array.isArray(params.incomingFiles)) {
    for (const f of params.incomingFiles) {
      if (f?.filePath && typeof f.content === 'string') {
        incomingList.push(f);
      }
    }
  }

  // Also extract generated HTML & virtual sections from the latest built turn if explicit files weren't passed
  if (incomingList.length === 0 && Array.isArray(params.turns) && params.turns.length > 0) {
    const latestBuildTurn = [...params.turns]
      .reverse()
      .find((t) => typeof t.previewHtml === 'string' && t.previewHtml.trim().length > 0);
    if (latestBuildTurn?.previewHtml) {
      const html = latestBuildTurn.previewHtml;
      incomingList.push({
        filePath: 'index.html',
        content: html,
        changeSummary:
          latestBuildTurn.userMessage?.trim().slice(0, 120) ||
          latestBuildTurn.phaseLabel ||
          'Updated full app HTML',
      });
      const styleMatch = /<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(html);
      if (styleMatch?.[1]?.trim()) {
        incomingList.push({
          filePath: 'styles.css',
          content: styleMatch[1].trim(),
          changeSummary: `Extracted CSS styles (${latestBuildTurn.phaseLabel || 'build'})`,
        });
      }
      const scriptMatch = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html);
      if (scriptMatch?.[1]?.trim()) {
        incomingList.push({
          filePath: 'app.js',
          content: scriptMatch[1].trim(),
          changeSummary: `Extracted app logic (${latestBuildTurn.phaseLabel || 'build'})`,
        });
      }
    }
  }

  for (const nextFile of incomingList) {
    const prev = fileMap.get(nextFile.filePath);
    const nextBytes = Buffer.byteLength(nextFile.content, 'utf8');
    if (prev && prev.content === nextFile.content) {
      continue;
    }

    const previousChanges: AiFileChangeRecord[] = prev
      ? [
          {
            version: prev.version,
            changeSummary: prev.changeSummary || 'Previous revision',
            contentBytes: prev.contentBytes,
            updatedAt: prev.updatedAt,
          },
          ...(Array.isArray(prev.previousChanges) ? prev.previousChanges : []),
        ].slice(0, 10)
      : [];

    const nextVersion = prev ? prev.version + 1 : 1;
    const summary =
      nextFile.changeSummary?.trim() ||
      (prev
        ? `Updated ${nextFile.filePath} (${prev.contentBytes} -> ${nextBytes} bytes)`
        : `Created ${nextFile.filePath}`);

    fileMap.set(nextFile.filePath, {
      filePath: nextFile.filePath,
      content: nextFile.content,
      contentBytes: nextBytes,
      version: nextVersion,
      changeSummary: summary,
      previousChanges,
      updatedAt: params.nowIso,
    });
  }

  return Array.from(fileMap.values());
}

function buildConversationRecordsFromTurns(params: {
  existingMessages: AiConversationRecord[];
  turns?: SaveProjectMemoryInput['turns'];
  appendMessage?: SaveProjectMemoryInput['appendMessage'];
  nowIso: string;
}): AiConversationRecord[] {
  const msgMap = new Map<string, AiConversationRecord>();
  for (const m of params.existingMessages) {
    if (m?.id) msgMap.set(m.id, m);
  }

  if (Array.isArray(params.turns)) {
    for (const turn of params.turns) {
      if (!turn?.id) continue;
      if (turn.userMessage?.trim()) {
        const userMsgId = `${turn.id}__user`;
        msgMap.set(userMsgId, {
          id: userMsgId,
          turnId: turn.id,
          role: 'user',
          kind: turn.kind || 'chat',
          content: turn.userMessage.trim(),
          phase: turn.phase || 'complete',
          createdAt: msgMap.get(userMsgId)?.createdAt || params.nowIso,
        });
      }
      if (turn.aiText?.trim() || turn.phase === 'paused' || turn.phase === 'error') {
        const aiMsgId = `${turn.id}__assistant`;
        const assistantBody =
          turn.aiText?.trim() ||
          turn.pausedMessage ||
          turn.errorMessage ||
          `Build phase: ${turn.phaseLabel || turn.phase}`;
        msgMap.set(aiMsgId, {
          id: aiMsgId,
          turnId: turn.id,
          role: 'assistant',
          kind: turn.kind || 'chat',
          content: assistantBody,
          phase: turn.phase || 'complete',
          modelUsed: turn.modelId,
          planSteps: Array.isArray(turn.planSteps) ? turn.planSteps : undefined,
          createdAt: msgMap.get(aiMsgId)?.createdAt || params.nowIso,
        });
      }
    }
  }

  if (params.appendMessage && params.appendMessage.content?.trim()) {
    const am = params.appendMessage;
    const id = `${am.turnId}__${am.role}`;
    msgMap.set(id, {
      id,
      turnId: am.turnId,
      role: am.role,
      kind: am.kind || 'chat',
      content: am.content.trim(),
      phase: am.phase || 'complete',
      modelUsed: am.modelUsed,
      planSteps: am.planSteps,
      createdAt: msgMap.get(id)?.createdAt || params.nowIso,
    });
  }

  return Array.from(msgMap.values()).slice(-120);
}

/**
 * Checks whether the Stage 1 SQL tables with RLS have been migrated in Supabase.
 */
export async function checkSupabaseMemoryTablesReady(
  auth: MemoryAuthContext
): Promise<boolean> {
  const db = getDbClientForUser(auth);
  if (!db) return false;
  const { error } = await db.client
    .from('ai_projects')
    .select('id', { head: true, count: 'exact' })
    .eq('user_id', auth.userId)
    .limit(1);
  return !error;
}

export async function listUserProjectMemories(
  auth: MemoryAuthContext
): Promise<{
  backend: 'supabase_rls_tables' | 'supabase_storage' | 'memory_cache';
  projects: AiProjectMemoryListItem[];
}> {
  const db = getDbClientForUser(auth);
  if (db) {
    const { data, error } = await db.client
      .from('ai_projects')
      .select(
        'id, user_id, title, mode, status, completed_tasks, unfinished_tasks, last_stopped_point, memory_summary, updated_at'
      )
      .eq('user_id', auth.userId)
      .order('updated_at', { ascending: false })
      .limit(100);

    if (!error && Array.isArray(data)) {
      return {
        backend: 'supabase_rls_tables',
        projects: data.map((row) => ({
          projectId: String(row.id),
          userId: String(row.user_id),
          title: String(row.title || 'Untitled Project'),
          mode: row.mode === 'web' ? 'web' : 'mobile',
          status: (row.status || 'idle') as BrainBuildStatus,
          completedTaskCount: Array.isArray(row.completed_tasks)
            ? row.completed_tasks.length
            : 0,
          unfinishedTaskCount: Array.isArray(row.unfinished_tasks)
            ? row.unfinished_tasks.length
            : 0,
          fileCount: 0,
          messageCount: 0,
          lastStoppedPoint: (row.last_stopped_point || null) as AiStoppedPoint | null,
          memorySummary: String(row.memory_summary || ''),
          updatedAt: String(row.updated_at || new Date().toISOString()),
        })),
      };
    }

    if (!isMissingRelationError(error)) {
      // Fall through cleanly on transient error without leaking
    }
  }

  const fallbackProjects = await listFromSupabaseStorageFallback(auth.userId);
  const hasSvc = Boolean(createServiceClient());
  return {
    backend: hasSvc ? 'supabase_storage' : 'memory_cache',
    projects: fallbackProjects,
  };
}

export async function getProjectMemory(
  auth: MemoryAuthContext,
  rawProjectId: string
): Promise<{
  backend: 'supabase_rls_tables' | 'supabase_storage' | 'memory_cache';
  memory: AiProjectMemoryRecord | null;
  brainContext: string;
}> {
  const projectId = sanitizeMemoryProjectId(rawProjectId);
  if (!projectId || !auth.userId) {
    return { backend: 'memory_cache', memory: null, brainContext: '' };
  }

  const db = getDbClientForUser(auth);
  if (db) {
    const { data: projRow, error: projErr } = await db.client
      .from('ai_projects')
      .select('*')
      .eq('id', projectId)
      .eq('user_id', auth.userId)
      .maybeSingle();

    if (!projErr && projRow) {
      const [{ data: msgRows }, { data: fileRows }] = await Promise.all([
        db.client
          .from('ai_conversation_messages')
          .select('*')
          .eq('project_id', projectId)
          .eq('user_id', auth.userId)
          .order('created_at', { ascending: true })
          .limit(120),
        db.client
          .from('ai_project_files')
          .select('*')
          .eq('project_id', projectId)
          .eq('user_id', auth.userId)
          .order('updated_at', { ascending: false })
          .limit(50),
      ]);

      const memory: AiProjectMemoryRecord = {
        projectId: String(projRow.id),
        userId: String(projRow.user_id),
        title: String(projRow.title || 'Untitled Project'),
        mode: projRow.mode === 'web' ? 'web' : 'mobile',
        status: (projRow.status || 'idle') as BrainBuildStatus,
        completedTasks: Array.isArray(projRow.completed_tasks)
          ? (projRow.completed_tasks as AiTaskItem[])
          : [],
        unfinishedTasks: Array.isArray(projRow.unfinished_tasks)
          ? (projRow.unfinished_tasks as AiTaskItem[])
          : [],
        lastStoppedPoint: (projRow.last_stopped_point || null) as AiStoppedPoint | null,
        databaseSchema: Array.isArray(projRow.database_schema)
          ? projRow.database_schema
          : [],
        memorySummary: String(projRow.memory_summary || ''),
        lastModelUsed:
          typeof projRow.last_model_used === 'string' ? projRow.last_model_used : undefined,
        messages: (Array.isArray(msgRows) ? msgRows : []).map((m) => ({
          id: String(m.id),
          turnId: String(m.turn_id),
          role: (m.role || 'user') as AiConversationRecord['role'],
          kind: (m.kind || 'chat') as AiConversationRecord['kind'],
          content: String(m.content || ''),
          phase: String(m.phase || 'complete'),
          modelUsed: typeof m.model_used === 'string' ? m.model_used : undefined,
          planSteps: Array.isArray(m.plan_steps) ? (m.plan_steps as string[]) : undefined,
          createdAt: String(m.created_at || new Date().toISOString()),
        })),
        files: (Array.isArray(fileRows) ? fileRows : []).map((f) => ({
          filePath: String(f.file_path),
          content: String(f.content || ''),
          contentBytes: Number(f.content_bytes || 0),
          version: Number(f.version || 1),
          changeSummary: String(f.change_summary || ''),
          previousChanges: Array.isArray(f.previous_changes)
            ? (f.previous_changes as AiFileChangeRecord[])
            : [],
          updatedAt: String(f.updated_at || new Date().toISOString()),
        })),
        createdAt: String(projRow.created_at || new Date().toISOString()),
        updatedAt: String(projRow.updated_at || new Date().toISOString()),
      };

      return {
        backend: 'supabase_rls_tables',
        memory,
        brainContext: buildMemoryAugmentedContext(memory),
      };
    }

    if (!projErr && !projRow) {
      // Check fallback bucket too in case project was saved before SQL migration ran
      const fallbackExisting = await loadFromSupabaseStorageFallback(auth.userId, projectId);
      return {
        backend: 'supabase_rls_tables',
        memory: fallbackExisting,
        brainContext: buildMemoryAugmentedContext(fallbackExisting),
      };
    }
  }

  const fallback = await loadFromSupabaseStorageFallback(auth.userId, projectId);
  const hasSvc = Boolean(createServiceClient());
  return {
    backend: hasSvc ? 'supabase_storage' : 'memory_cache',
    memory: fallback,
    brainContext: buildMemoryAugmentedContext(fallback),
  };
}

export async function saveProjectMemorySnapshot(
  auth: MemoryAuthContext,
  input: SaveProjectMemoryInput
): Promise<{
  ok: boolean;
  backend: 'supabase_rls_tables' | 'supabase_storage' | 'memory_cache';
  memory: AiProjectMemoryRecord;
}> {
  const projectId = sanitizeMemoryProjectId(input.projectId);
  if (!projectId) {
    throw new Error('Valid projectId is required to save project memory.');
  }
  const nowIso = new Date().toISOString();

  const existingRes = await getProjectMemory(auth, projectId);
  const existing = existingRes.memory;

  const derived = deriveTasksAndStoppedPoint({
    turns: input.turns,
    existingCompleted: input.completedTasks ?? existing?.completedTasks,
    existingUnfinished: input.unfinishedTasks ?? existing?.unfinishedTasks,
  });

  const resolvedStatus = input.status ?? derived.status ?? existing?.status ?? 'idle';
  const resolvedCompleted = input.completedTasks ?? derived.completedTasks;
  const resolvedUnfinished = input.unfinishedTasks ?? derived.unfinishedTasks;
  const resolvedStoppedPoint =
    input.lastStoppedPoint !== undefined
      ? input.lastStoppedPoint
      : (derived.lastStoppedPoint ?? existing?.lastStoppedPoint ?? null);

  const nextMessages = buildConversationRecordsFromTurns({
    existingMessages: existing?.messages || [],
    turns: input.turns,
    appendMessage: input.appendMessage,
    nowIso,
  });

  const nextFiles = buildFilesWithChangeHistory({
    existingFiles: existing?.files || [],
    incomingFiles: input.files,
    turns: input.turns,
    nowIso,
  });

  const resolvedTitle =
    input.title?.trim() || existing?.title || 'Untitled Project';
  const resolvedSummary =
    input.memorySummary?.trim() ||
    existing?.memorySummary ||
    `${resolvedTitle} (${input.mode || existing?.mode || 'mobile'}) · ${resolvedCompleted.length} done, ${resolvedUnfinished.length} pending, ${nextFiles.length} tracked files`;

  const nextRecord: AiProjectMemoryRecord = {
    projectId,
    userId: auth.userId,
    title: resolvedTitle,
    mode: input.mode || existing?.mode || 'mobile',
    status: resolvedStatus,
    completedTasks: resolvedCompleted,
    unfinishedTasks: resolvedUnfinished,
    lastStoppedPoint: resolvedStoppedPoint,
    databaseSchema:
      input.databaseSchema ?? existing?.databaseSchema ?? [],
    memorySummary: resolvedSummary,
    lastModelUsed: input.lastModelUsed ?? existing?.lastModelUsed,
    messages: nextMessages,
    files: nextFiles,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  // Attempt write to RLS-protected Supabase relational tables first
  const db = getDbClientForUser(auth);
  if (db) {
    const { error: projErr } = await db.client.from('ai_projects').upsert(
      {
        id: nextRecord.projectId,
        user_id: auth.userId,
        title: nextRecord.title,
        mode: nextRecord.mode,
        status: nextRecord.status,
        completed_tasks: nextRecord.completedTasks,
        unfinished_tasks: nextRecord.unfinishedTasks,
        last_stopped_point: nextRecord.lastStoppedPoint,
        database_schema: nextRecord.databaseSchema,
        memory_summary: nextRecord.memorySummary,
        last_model_used: nextRecord.lastModelUsed || null,
        created_at: nextRecord.createdAt,
        updated_at: nextRecord.updatedAt,
      },
      { onConflict: 'id' }
    );

    if (!projErr) {
      if (nextRecord.messages.length > 0) {
        await db.client.from('ai_conversation_messages').upsert(
          nextRecord.messages.map((m) => ({
            id: m.id,
            project_id: nextRecord.projectId,
            user_id: auth.userId,
            turn_id: m.turnId,
            role: m.role,
            kind: m.kind,
            content: m.content,
            phase: m.phase,
            model_used: m.modelUsed || null,
            plan_steps: m.planSteps || [],
            created_at: m.createdAt,
          })),
          { onConflict: 'id' }
        );
      }

      if (nextRecord.files.length > 0) {
        await db.client.from('ai_project_files').upsert(
          nextRecord.files.map((f) => ({
            id: `${nextRecord.projectId}::${f.filePath}`,
            project_id: nextRecord.projectId,
            user_id: auth.userId,
            file_path: f.filePath,
            content: f.content,
            content_bytes: f.contentBytes,
            version: f.version,
            change_summary: f.changeSummary,
            previous_changes: f.previousChanges,
            updated_at: f.updatedAt,
          })),
          { onConflict: 'project_id,user_id,file_path' }
        );
      }

      // Mirror in process cache as well
      processMemoryStore.set(`${auth.userId}::${nextRecord.projectId}`, nextRecord);
      return {
        ok: true,
        backend: 'supabase_rls_tables',
        memory: nextRecord,
      };
    }

    if (!isMissingRelationError(projErr)) {
      // Fallback cleanly to storage without breaking the app
    }
  }

  const storageBackend = await saveToSupabaseStorageFallback(nextRecord);
  return {
    ok: true,
    backend: storageBackend,
    memory: nextRecord,
  };
}

export async function recordBuildCheckpoint(
  auth: MemoryAuthContext,
  params: {
    projectId: string;
    title?: string;
    mode?: 'mobile' | 'web';
    turnId: string;
    phase: BrainBuildStatus;
    phaseLabel: string;
    pausedReason?: string;
    pausedMessage?: string;
    activeFile?: string;
    activeAction?: string;
    partialHtml?: string;
    bytesBuilt?: number;
    unfinishedTaskTitle?: string;
    completedTaskTitle?: string;
  }
): Promise<{
  ok: boolean;
  backend: 'supabase_rls_tables' | 'supabase_storage' | 'memory_cache';
  lastStoppedPoint: AiStoppedPoint;
}> {
  const nowIso = new Date().toISOString();
  const projectId = sanitizeMemoryProjectId(params.projectId);
  const existing = (await getProjectMemory(auth, projectId)).memory;

  const completedTasks = [...(existing?.completedTasks || [])];
  let unfinishedTasks = [...(existing?.unfinishedTasks || [])];

  if (params.completedTaskTitle?.trim()) {
    const clean = params.completedTaskTitle.trim();
    unfinishedTasks = unfinishedTasks.filter(
      (t) => t.title.toLowerCase() !== clean.toLowerCase()
    );
    if (!completedTasks.some((t) => t.title.toLowerCase() === clean.toLowerCase())) {
      completedTasks.push({
        id: `${params.turnId}_done_${Date.now()}`,
        title: clean,
        status: 'completed',
        turnId: params.turnId,
        updatedAt: nowIso,
      });
    }
  }

  if (params.unfinishedTaskTitle?.trim()) {
    const clean = params.unfinishedTaskTitle.trim();
    if (
      !completedTasks.some((t) => t.title.toLowerCase() === clean.toLowerCase()) &&
      !unfinishedTasks.some((t) => t.title.toLowerCase() === clean.toLowerCase())
    ) {
      unfinishedTasks.push({
        id: `${params.turnId}_todo_${Date.now()}`,
        title: clean,
        status: 'unfinished',
        turnId: params.turnId,
        updatedAt: nowIso,
      });
    }
  }

  const lastStoppedPoint: AiStoppedPoint = {
    turnId: params.turnId,
    phase: params.phase,
    phaseLabel: params.phaseLabel,
    pausedReason: params.pausedReason,
    pausedMessage: params.pausedMessage,
    activeFile: params.activeFile || 'index.html',
    activeAction: params.activeAction || 'Building',
    bytesBuilt:
      typeof params.bytesBuilt === 'number'
        ? params.bytesBuilt
        : (params.partialHtml || '').length,
    partialHtmlSnapshot: params.partialHtml
      ? params.partialHtml.slice(0, 60000)
      : existing?.lastStoppedPoint?.partialHtmlSnapshot,
    stoppedAt: nowIso,
  };

  const saved = await saveProjectMemorySnapshot(auth, {
    projectId,
    title: params.title,
    mode: params.mode,
    status: params.phase,
    completedTasks,
    unfinishedTasks,
    lastStoppedPoint,
    files: params.partialHtml
      ? [
          {
            filePath: params.activeFile || 'index.html',
            content: params.partialHtml,
            changeSummary: `Checkpoint saved at ${params.phaseLabel} (${lastStoppedPoint.bytesBuilt} bytes)`,
          },
        ]
      : undefined,
  });

  return {
    ok: saved.ok,
    backend: saved.backend,
    lastStoppedPoint,
  };
}

export async function deleteProjectMemory(
  auth: MemoryAuthContext,
  rawProjectId: string
): Promise<{ ok: boolean }> {
  const projectId = sanitizeMemoryProjectId(rawProjectId);
  if (!projectId || !auth.userId) return { ok: false };

  processMemoryStore.delete(`${auth.userId}::${projectId}`);

  const db = getDbClientForUser(auth);
  if (db) {
    await db.client
      .from('ai_projects')
      .delete()
      .eq('id', projectId)
      .eq('user_id', auth.userId);
  }

  const svc = createServiceClient();
  if (svc && (await ensureMemoryBucket())) {
    await svc.storage
      .from(WORKSPACE_BUCKET)
      .remove([storageProjectPath(auth.userId, projectId)]);
    const remaining = (await listFromSupabaseStorageFallback(auth.userId)).filter(
      (item) => item.projectId !== projectId
    );
    await svc.storage
      .from(WORKSPACE_BUCKET)
      .upload(storageIndexPath(auth.userId), Buffer.from(JSON.stringify(remaining), 'utf8'), {
        contentType: 'application/json',
        upsert: true,
      });
  }

  return { ok: true };
}
