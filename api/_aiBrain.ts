/**
 * AI Craft — Stage 1 Foundation: Independent AI Brain Architecture
 *
 * Provider-agnostic context compiler, task/checkpoint tracker, and Stage 2
 * self-hosted open-source GPU inference adapter contract.
 *
 * ZERO external AI API dependencies (no OpenAI, no Gemini, no third-party SDKs).
 */

export type BrainBuildStatus =
  | 'idle'
  | 'understanding'
  | 'building'
  | 'paused'
  | 'complete'
  | 'error';

export interface AiTaskItem {
  id: string;
  title: string;
  status: 'completed' | 'unfinished';
  turnId?: string;
  updatedAt: string;
}

export interface AiStoppedPoint {
  turnId: string;
  phase: BrainBuildStatus;
  phaseLabel: string;
  pausedReason?: string;
  pausedMessage?: string;
  activeFile?: string;
  activeAction?: string;
  bytesBuilt: number;
  partialHtmlSnapshot?: string;
  stoppedAt: string;
}

export interface AiFileChangeRecord {
  version: number;
  changeSummary: string;
  contentBytes: number;
  updatedAt: string;
}

export interface AiProjectFileRecord {
  filePath: string;
  content: string;
  contentBytes: number;
  version: number;
  changeSummary: string;
  previousChanges: AiFileChangeRecord[];
  updatedAt: string;
}

export interface AiConversationRecord {
  id: string;
  turnId: string;
  role: 'user' | 'assistant' | 'system';
  kind: 'chat' | 'build' | 'media';
  content: string;
  phase: string;
  modelUsed?: string;
  planSteps?: string[];
  createdAt: string;
}

export interface AiProjectMemoryRecord {
  projectId: string;
  userId: string;
  title: string;
  mode: 'mobile' | 'web';
  status: BrainBuildStatus;
  completedTasks: AiTaskItem[];
  unfinishedTasks: AiTaskItem[];
  lastStoppedPoint: AiStoppedPoint | null;
  databaseSchema: unknown[];
  memorySummary: string;
  lastModelUsed?: string;
  messages: AiConversationRecord[];
  files: AiProjectFileRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface AiProjectMemoryListItem {
  projectId: string;
  userId: string;
  title: string;
  mode: 'mobile' | 'web';
  status: BrainBuildStatus;
  completedTaskCount: number;
  unfinishedTaskCount: number;
  fileCount: number;
  messageCount: number;
  lastStoppedPoint: AiStoppedPoint | null;
  memorySummary: string;
  updatedAt: string;
}

export interface SelfHostedGpuAdapterConfig {
  stage: 'stage_1_foundation' | 'stage_2_connected';
  selfHostedConfigured: boolean;
  protocol: 'openai_compatible' | 'ollama' | 'tgi' | 'custom_http';
  modelName: string;
  supportsStreaming: boolean;
  supportsVision: boolean;
  /** Redacted diagnostic label — never exposes URL or credentials to clients. */
  endpointConfigured: boolean;
}

export interface AiBrainInferenceRequest {
  userId: string;
  projectId: string;
  prompt: string;
  systemPrompt: string;
  memoryContext: string;
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface AiBrainProviderAdapter {
  readonly id: string;
  readonly kind: 'self_hosted_gpu';
  isReady(): boolean;
  getStatus(): SelfHostedGpuAdapterConfig;
  buildInferencePayload(request: AiBrainInferenceRequest): Record<string, unknown>;
}

/**
 * Stage 2-ready adapter scaffold for connecting a self-hosted open-source GPU
 * model (e.g. Qwen2.5-Coder / DeepSeek-Coder / Llama 4 via vLLM, TGI, or Ollama)
 * without touching UI, memory, auth, or billing.
 */
export function createSelfHostedBrainAdapter(): AiBrainProviderAdapter {
  const rawUrl = (process.env.SELF_HOSTED_LLM_URL || '').trim();
  const rawModel = (
    process.env.SELF_HOSTED_LLM_MODEL || 'self-hosted/open-source-coder'
  ).trim();
  const rawProtocol = (process.env.SELF_HOSTED_LLM_PROTOCOL || 'openai_compatible').trim();
  const protocol: SelfHostedGpuAdapterConfig['protocol'] =
    rawProtocol === 'ollama' ||
    rawProtocol === 'tgi' ||
    rawProtocol === 'custom_http'
      ? rawProtocol
      : 'openai_compatible';

  const configured = Boolean(rawUrl && /^https?:\/\//i.test(rawUrl));

  return {
    id: 'self-hosted-open-source-brain',
    kind: 'self_hosted_gpu',
    isReady() {
      return configured;
    },
    getStatus(): SelfHostedGpuAdapterConfig {
      return {
        stage: configured ? 'stage_2_connected' : 'stage_1_foundation',
        selfHostedConfigured: configured,
        protocol,
        modelName: rawModel,
        supportsStreaming: true,
        supportsVision: false,
        endpointConfigured: configured,
      };
    },
    buildInferencePayload(request: AiBrainInferenceRequest): Record<string, unknown> {
      const systemBlock = request.memoryContext
        ? `${request.systemPrompt}\n\n${request.memoryContext}`
        : request.systemPrompt;

      return {
        model: rawModel,
        stream: request.stream !== false,
        max_tokens: request.maxTokens ?? 8192,
        temperature: request.temperature ?? 0.35,
        messages: [
          { role: 'system', content: systemBlock },
          ...request.history.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: request.prompt },
        ],
      };
    },
  };
}

/**
 * Derives completed vs unfinished tasks + exact last-stopped checkpoint
 * deterministically from build turns or plan steps (no external AI required).
 */
export function deriveTasksAndStoppedPoint(params: {
  turns?: Array<{
    id: string;
    kind?: string;
    userMessage?: string;
    phase?: string;
    phaseLabel?: string;
    activeAction?: string;
    activeFile?: string;
    files?: string[];
    planSteps?: string[];
    previewHtml?: string;
    bytesBuilt?: number;
    pausedReason?: string;
    pausedMessage?: string;
    pausedAt?: string;
    errorMessage?: string;
  }>;
  existingCompleted?: AiTaskItem[];
  existingUnfinished?: AiTaskItem[];
}): {
  status: BrainBuildStatus;
  completedTasks: AiTaskItem[];
  unfinishedTasks: AiTaskItem[];
  lastStoppedPoint: AiStoppedPoint | null;
} {
  const nowIso = new Date().toISOString();
  const turns = Array.isArray(params.turns) ? params.turns : [];

  if (turns.length === 0) {
    return {
      status: 'idle',
      completedTasks: Array.isArray(params.existingCompleted)
        ? params.existingCompleted
        : [],
      unfinishedTasks: Array.isArray(params.existingUnfinished)
        ? params.existingUnfinished
        : [],
      lastStoppedPoint: null,
    };
  }

  const completedMap = new Map<string, AiTaskItem>();
  const unfinishedMap = new Map<string, AiTaskItem>();

  for (const prev of params.existingCompleted || []) {
    if (prev?.title) {
      completedMap.set(prev.title.toLowerCase(), { ...prev, status: 'completed' });
    }
  }

  let latestStoppedPoint: AiStoppedPoint | null = null;
  let overallStatus: BrainBuildStatus = 'idle';

  for (const turn of turns) {
    const phase = (turn.phase || 'complete') as BrainBuildStatus;
    overallStatus = phase;
    const steps = Array.isArray(turn.planSteps) ? turn.planSteps.filter(Boolean) : [];
    const fallbackTaskTitle = turn.userMessage
      ? turn.userMessage.trim().slice(0, 120)
      : 'App build step';

    if (phase === 'complete') {
      if (steps.length > 0) {
        steps.forEach((step, idx) => {
          const cleanTitle = step.trim();
          const key = cleanTitle.toLowerCase();
          unfinishedMap.delete(key);
          completedMap.set(key, {
            id: `${turn.id}_step_${idx + 1}`,
            title: cleanTitle,
            status: 'completed',
            turnId: turn.id,
            updatedAt: nowIso,
          });
        });
      } else if (fallbackTaskTitle) {
        const key = fallbackTaskTitle.toLowerCase();
        unfinishedMap.delete(key);
        completedMap.set(key, {
          id: `${turn.id}_task`,
          title: fallbackTaskTitle,
          status: 'completed',
          turnId: turn.id,
          updatedAt: nowIso,
        });
      }
      // Build completed cleanly — record final completion checkpoint (not an interrupted pause)
      latestStoppedPoint = {
        turnId: turn.id,
        phase: 'complete',
        phaseLabel: turn.phaseLabel || 'Build complete',
        activeFile: turn.activeFile || turn.files?.[0] || 'index.html',
        activeAction: turn.activeAction || 'Built',
        bytesBuilt:
          typeof turn.bytesBuilt === 'number'
            ? turn.bytesBuilt
            : (turn.previewHtml || '').length,
        stoppedAt: nowIso,
      };
    } else {
      // Paused, error, building, or understanding -> track unfinished steps + exact stop point
      if (steps.length > 0) {
        steps.forEach((step, idx) => {
          const cleanTitle = step.trim();
          const key = cleanTitle.toLowerCase();
          if (!completedMap.has(key)) {
            unfinishedMap.set(key, {
              id: `${turn.id}_step_${idx + 1}`,
              title: cleanTitle,
              status: 'unfinished',
              turnId: turn.id,
              updatedAt: nowIso,
            });
          }
        });
      } else if (fallbackTaskTitle) {
        const key = fallbackTaskTitle.toLowerCase();
        if (!completedMap.has(key)) {
          unfinishedMap.set(key, {
            id: `${turn.id}_pending`,
            title: fallbackTaskTitle,
            status: 'unfinished',
            turnId: turn.id,
            updatedAt: nowIso,
          });
        }
      }

      latestStoppedPoint = {
        turnId: turn.id,
        phase,
        phaseLabel: turn.phaseLabel || (phase === 'paused' ? 'Paused' : 'In progress'),
        pausedReason: turn.pausedReason || (phase === 'error' ? 'ERROR_INTERRUPTED' : undefined),
        pausedMessage: turn.pausedMessage || turn.errorMessage,
        activeFile: turn.activeFile || turn.files?.[0] || 'index.html',
        activeAction: turn.activeAction || 'Building',
        bytesBuilt:
          typeof turn.bytesBuilt === 'number'
            ? turn.bytesBuilt
            : (turn.previewHtml || '').length,
        partialHtmlSnapshot:
          typeof turn.previewHtml === 'string' && turn.previewHtml.trim()
            ? turn.previewHtml.slice(0, 60000)
            : undefined,
        stoppedAt: turn.pausedAt || nowIso,
      };
    }
  }

  return {
    status: overallStatus,
    completedTasks: Array.from(completedMap.values()).slice(-25),
    unfinishedTasks: Array.from(unfinishedMap.values()).slice(-25),
    lastStoppedPoint: latestStoppedPoint,
  };
}

/**
 * Compiles a project's persistent Supabase memory into a structured prompt
 * packet ready for Stage 2's self-hosted GPU model (and current prompt builders).
 */
export function buildMemoryAugmentedContext(
  memory: AiProjectMemoryRecord | null
): string {
  if (!memory) return '';

  const lines: string[] = [
    `PERSISTENT PROJECT MEMORY (User-Isolated Project: "${memory.title}" | ID: ${memory.projectId} | Mode: ${memory.mode} | Status: ${memory.status}):`,
  ];

  if (memory.memorySummary) {
    lines.push(`- Summary: ${memory.memorySummary}`);
  }

  if (memory.completedTasks.length > 0) {
    lines.push(
      `- Completed Tasks (${memory.completedTasks.length}): ${memory.completedTasks
        .slice(-8)
        .map((t) => t.title)
        .join(' | ')}`
    );
  }

  if (memory.unfinishedTasks.length > 0) {
    lines.push(
      `- Unfinished / Pending Tasks (${memory.unfinishedTasks.length}): ${memory.unfinishedTasks
        .slice(0, 8)
        .map((t) => t.title)
        .join(' | ')}`
    );
  }

  if (memory.lastStoppedPoint) {
    const sp = memory.lastStoppedPoint;
    if (sp.phase === 'paused' || sp.phase === 'error' || sp.phase === 'building') {
      lines.push(
        `- LAST STOPPED CHECKPOINT (RESUME FROM HERE): Stopped in phase "${sp.phase}" (${sp.phaseLabel}) on file "${sp.activeFile || 'index.html'}" (${sp.bytesBuilt} bytes built${sp.pausedReason ? `, reason: ${sp.pausedReason}` : ''}). Preserve all progress already generated.`
      );
    } else {
      lines.push(
        `- Last Build Checkpoint: Phase "${sp.phaseLabel}" on "${sp.activeFile || 'index.html'}" (${sp.bytesBuilt} bytes) at ${sp.stoppedAt}.`
      );
    }
  }

  if (memory.files.length > 0) {
    const fileLines = memory.files.slice(0, 8).map((f) => {
      const historyNote =
        f.previousChanges.length > 0
          ? ` (v${f.version}, ${f.previousChanges.length} prior revisions, last change: ${f.changeSummary || 'updated'})`
          : ` (v${f.version})`;
      return `${f.filePath} [${f.contentBytes} bytes]${historyNote}`;
    });
    lines.push(`- Tracked Files & Revision History: ${fileLines.join('; ')}`);
  }

  if (memory.messages.length > 0) {
    const recentMsgs = memory.messages
      .slice(-6)
      .map(
        (m) =>
          `  * [${m.role.toUpperCase()} · ${m.kind}] ${m.content
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180)}`
      );
    lines.push('- Recent Saved Conversation Turns:');
    lines.push(...recentMsgs);
  }

  return lines.join('\n');
}
