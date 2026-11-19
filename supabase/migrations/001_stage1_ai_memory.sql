-- ============================================================================
-- AI CRAFT — STAGE 1: INDEPENDENT AI BRAIN & PERSISTENT PROJECT MEMORY
-- Non-destructive additive migration. Does NOT alter or drop existing tables,
-- auth.users metadata, or existing Storage buckets.
--
-- Review & run in Supabase Dashboard -> SQL Editor when ready.
-- ============================================================================

-- 1. Per-user, per-project AI memory root
CREATE TABLE IF NOT EXISTS public.ai_projects (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New App Project',
  mode TEXT NOT NULL DEFAULT 'mobile' CHECK (mode IN ('mobile', 'web')),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (
    status IN ('idle', 'understanding', 'building', 'paused', 'complete', 'error')
  ),
  completed_tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
  unfinished_tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_stopped_point JSONB,
  database_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
  memory_summary TEXT NOT NULL DEFAULT '',
  last_model_used TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_projects_user_updated
  ON public.ai_projects (user_id, updated_at DESC);

-- 2. Per-user, per-project persistent conversation history
CREATE TABLE IF NOT EXISTS public.ai_conversation_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES public.ai_projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'build', 'media')),
  content TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT 'complete',
  model_used TEXT,
  plan_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_project_user_created
  ON public.ai_conversation_messages (project_id, user_id, created_at ASC);

-- 3. Per-project generated files & rolling previous change history
CREATE TABLE IF NOT EXISTS public.ai_project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES public.ai_projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  content_bytes INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  change_summary TEXT NOT NULL DEFAULT '',
  previous_changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, user_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_ai_files_project_user
  ON public.ai_project_files (project_id, user_id, updated_at DESC);

-- ============================================================================
-- STRICT ROW LEVEL SECURITY (Multi-User Isolation)
-- Every user can ONLY read, insert, update, or delete their own rows.
-- ============================================================================

ALTER TABLE public.ai_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_project_files ENABLE ROW LEVEL SECURITY;

-- ai_projects policies
DROP POLICY IF EXISTS "ai_projects_select_own" ON public.ai_projects;
CREATE POLICY "ai_projects_select_own"
  ON public.ai_projects FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ai_projects_insert_own" ON public.ai_projects;
CREATE POLICY "ai_projects_insert_own"
  ON public.ai_projects FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ai_projects_update_own" ON public.ai_projects;
CREATE POLICY "ai_projects_update_own"
  ON public.ai_projects FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ai_projects_delete_own" ON public.ai_projects;
CREATE POLICY "ai_projects_delete_own"
  ON public.ai_projects FOR DELETE
  USING (auth.uid() = user_id);

-- ai_conversation_messages policies
DROP POLICY IF EXISTS "ai_messages_select_own" ON public.ai_conversation_messages;
CREATE POLICY "ai_messages_select_own"
  ON public.ai_conversation_messages FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ai_messages_insert_own" ON public.ai_conversation_messages;
CREATE POLICY "ai_messages_insert_own"
  ON public.ai_conversation_messages FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ai_messages_update_own" ON public.ai_conversation_messages;
CREATE POLICY "ai_messages_update_own"
  ON public.ai_conversation_messages FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ai_messages_delete_own" ON public.ai_conversation_messages;
CREATE POLICY "ai_messages_delete_own"
  ON public.ai_conversation_messages FOR DELETE
  USING (auth.uid() = user_id);

-- ai_project_files policies
DROP POLICY IF EXISTS "ai_files_select_own" ON public.ai_project_files;
CREATE POLICY "ai_files_select_own"
  ON public.ai_project_files FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ai_files_insert_own" ON public.ai_project_files;
CREATE POLICY "ai_files_insert_own"
  ON public.ai_project_files FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ai_files_update_own" ON public.ai_project_files;
CREATE POLICY "ai_files_update_own"
  ON public.ai_project_files FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ai_files_delete_own" ON public.ai_project_files;
CREATE POLICY "ai_files_delete_own"
  ON public.ai_project_files FOR DELETE
  USING (auth.uid() = user_id);
