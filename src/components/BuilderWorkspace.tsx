import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  Check,
  CheckCircle2,
  ChevronLeft,
  Code2,
  Copy,
  Database,
  Download,
  Eye,
  Film,
  FlaskConical,
  Globe,
  Image as ImageIcon,
  KeyRound,
  LayoutGrid,
  Loader2,
  MessageSquare,
  Monitor,
  MoreVertical,
  MousePointerClick,
  Music,
  Paperclip,
  Pencil,
  Rocket,
  RotateCcw,
  RotateCw,
  Save,
  Share2,
  ShieldAlert,
  Smartphone,
  Square,
  Tablet,
  Terminal,
  Volume2,
  Wand2,
  X,
} from 'lucide-react';
import { useSpeechNarration } from '../hooks/useSpeechNarration';
import { useVoiceDictation } from '../hooks/useVoiceDictation';
import {
  BillingSummary,
  BuildMode,
  BuilderTurn,
  ComposerOptions,
  MODE_THEMES,
  OpenRouterModel,
  ProjectDatabaseColumn,
  ProjectDatabaseConfig,
  ProjectDeploymentConfig,
  ProjectSecret,
  SecretSaveResult,
  WorkspaceView,
} from '../types/craft';
import { ProcessedAttachment, readAttachmentFile } from '../utils/attachment';
import {
  applyFileEditToHtml,
  extractEditableCodeFiles,
} from '../utils/codeFileEditor';
import { buildProjectSecretHints } from '../utils/secretHints';
import {
  applyVisualPatchToHtml,
  VisualElementSelection,
} from '../utils/visualHtmlEditor';
import { ModelSelectorPopover } from './ModelSelectorPopover';
import {
  DeploySubmitOptions,
  ProjectDatabaseModal,
  ProjectDeployModal,
  ProjectSecretsModal,
} from './ProjectConfigDrawers';
import { ProviderLogo } from './ProviderLogo';
import { VoiceInputButton } from './VoiceInputButton';

type PreviewDevicePreset = 'iphone' | 'android' | 'tablet' | 'desktop';

interface PreviewConsoleEntry {
  id: string;
  level: 'log' | 'warn' | 'error';
  message: string;
  time: string;
}

const PREVIEW_DEVICE_SPECS: Record<
  PreviewDevicePreset,
  { label: string; dimensions: string; maxWidthClass: string; radiusClass: string }
> = {
  iphone: {
    label: 'iPhone',
    dimensions: '390×844',
    maxWidthClass: 'sm:max-w-[390px]',
    radiusClass: 'rounded-none sm:rounded-3xl',
  },
  android: {
    label: 'Android',
    dimensions: '412×915',
    maxWidthClass: 'sm:max-w-[412px]',
    radiusClass: 'rounded-none sm:rounded-[26px]',
  },
  tablet: {
    label: 'Tablet',
    dimensions: '768×1024',
    maxWidthClass: 'sm:max-w-[768px]',
    radiusClass: 'rounded-none sm:rounded-2xl',
  },
  desktop: {
    label: 'Desktop',
    dimensions: 'Responsive',
    maxWidthClass: 'sm:max-w-[1160px]',
    radiusClass: 'rounded-none sm:rounded-2xl',
  },
};

function cssColorToHex(raw: string, fallback = '#0B0B0F'): string {
  const val = (raw || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(val)) return val;
  if (/^#[0-9a-f]{3}$/i.test(val)) {
    return (
      '#' +
      val
        .slice(1)
        .split('')
        .map((c) => c + c)
        .join('')
    );
  }
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(val);
  if (rgbMatch) {
    if (val.includes('rgba') && /,\s*0(?:\.0+)?\s*\)$/.test(val)) {
      return '';
    }
    const r = Math.min(255, Number(rgbMatch[1])).toString(16).padStart(2, '0');
    const g = Math.min(255, Number(rgbMatch[2])).toString(16).padStart(2, '0');
    const b = Math.min(255, Number(rgbMatch[3])).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  return fallback;
}

function sanitizeDisplayProse(raw: string, isBuildTurn: boolean): string {
  const cleaned = raw
    .replace(/<(?:think[a-z0-9_-]*|thought)\b[^>]*>[\s\S]*?<\/(?:think[a-z0-9_-]*|thought)\b[^>]*>\s*/gi, '')
    .replace(/<(?:think[a-z0-9_-]*|thought)\b[^\n]*\n?/gi, '')
    .replace(/\[\[\s*INTENT\s*:\s*(?:CHAT|BUILD)\s*\]\]/gi, '')
    .replace(/\[\[\s*MODE\s*:\s*(?:CHAT|GENERATE)\s*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*MEDIA_PROMPT\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*TITLE\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*LOGO\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*PLAN\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*DB_SCHEMA\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*SUGGESTIONS\s*\]\][\s\S]*?(?:\[\[\s*\/\s*SUGGESTIONS\s*\]\]|$)/gi, '')
    .replace(/\[\[\s*(?:INTENT|MODE|MEDIA_PROMPT|TITLE|LOGO|PLAN|DB_SCHEMA|SUGGESTIONS|\/SUGGESTIONS)[^\]]*$/gi, '')
    .replace(/<<<?[^\n>]*$/gi, '');
  if (!isBuildTurn) return cleaned.trim();
  return cleaned
    .replace(/```[\s\S]*?```/g, '')
    .replace(/```[\s\S]*/g, '')
    .replace(/<<<\s*AICRAFT_APP_HTML\s*>>>[\s\S]*/gi, '')
    .replace(/<<<\s*AICRAFT_PATCH\s*>>>[\s\S]*/gi, '')
    .replace(/<<<\s*(?:SEARCH|REPLACE|APPEND_CSS|APPEND_SCREEN|APPEND_SCRIPT|END_PATCH|END_AICRAFT_PATCH)\s*>>>[\s\S]*/gi, '')
    .replace(/<!doctype\s+html[\s\S]*/gi, '')
    .replace(/<html\b[\s\S]*/gi, '')
    .replace(/<(?:style|script)\b[\s\S]*/gi, '')
    .replace(/^\s*(?:PART\s*[123]\s*[:\-–]?)\s*/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatCountdown(isoDate: string | undefined, nowMs: number): string {
  if (!isoDate) return '';
  const targetMs = Date.parse(isoDate);
  if (Number.isNaN(targetMs)) return '';
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  if (diffSec <= 0) return '0s';
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const secs = diffSec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

interface BuilderWorkspaceProps {
  projectId: string;
  projectTitle: string;
  mode: BuildMode;
  credits: number;
  billing: BillingSummary | null;
  turns: BuilderTurn[];
  isStreaming: boolean;
  activeView: WorkspaceView;
  isPublished: boolean;
  secrets: ProjectSecret[];
  databaseConfig: ProjectDatabaseConfig;
  deployment: ProjectDeploymentConfig;
  models: OpenRouterModel[];
  selectedModel: string;
  modelsLoading: boolean;
  modelsError: string | null;
  authHeaders?: Record<string, string>;
  inlineNotice?: string | null;
  isVerified?: boolean;
  isRestricted?: boolean;
  onSelectModel: (modelId: string) => void;
  onRetryModels: () => void;
  onSetView: (view: WorkspaceView) => void;
  onPublish: () => void;
  onUpdateSecrets: (next: ProjectSecret[]) => Promise<SecretSaveResult> | SecretSaveResult | void;
  onUpdateDatabase: (next: ProjectDatabaseConfig) => void;
  onUpdatePreviewHtml?: (nextHtml: string) => Promise<void> | void;
  onDeployProject: (opts: DeploySubmitOptions) => Promise<boolean> | void;
  onBack: () => void;
  onSendFollowUp: (message: string, options: ComposerOptions) => void;
  onContinueTurn: (turn: BuilderTurn) => void;
  onStopGeneration?: () => void;
  onCheckCanUseAi?: () => boolean;
  onPaymentRequired?: (billing?: BillingSummary | null, errorMessage?: string) => void;
  onOpenApps: () => void;
  onOpenSettings: () => void;
  onOpenUpgrade: () => void;
  autoReadEnabled?: boolean;
  isOwner?: boolean;
  testMode?: boolean;
  onToggleTestMode?: () => void;
}

export function BuilderWorkspace({
  projectId,
  projectTitle,
  mode,
  credits,
  billing,
  turns,
  isStreaming,
  activeView,
  isPublished,
  secrets,
  databaseConfig,
  deployment,
  models,
  selectedModel,
  modelsLoading,
  modelsError,
  authHeaders,
  inlineNotice,
  isVerified = false,
  isRestricted = false,
  onSelectModel,
  onRetryModels,
  onSetView,
  onPublish,
  onUpdateSecrets,
  onUpdateDatabase,
  onUpdatePreviewHtml,
  onDeployProject,
  onBack,
  onSendFollowUp,
  onContinueTurn,
  onStopGeneration,
  onCheckCanUseAi,
  onPaymentRequired,
  onOpenApps,
  onOpenSettings,
  onOpenUpgrade,
  autoReadEnabled = true,
  isOwner = false,
  testMode = false,
  onToggleTestMode,
}: BuilderWorkspaceProps) {
  const theme = MODE_THEMES[mode];
  const effectiveDbAppId = testMode ? `${projectId}__test` : projectId;
  const activeTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const meshAgents = activeTurn?.agents ?? [];
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);

  const [followUp, setFollowUp] = useState('');
  const [attachment, setAttachment] = useState<ProcessedAttachment | null>(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [activeDrawer, setActiveDrawer] = useState<'secrets' | 'database' | 'deploy' | null>(null);
  const [showHeaderActions, setShowHeaderActions] = useState(false);
  const [expandedPlanTurns, setExpandedPlanTurns] = useState<Record<string, boolean>>({});
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [copiedCode, setCopiedCode] = useState(false);
  const [activeCodeTab, setActiveCodeTab] = useState<string>('index.html');
  const [isEditingCode, setIsEditingCode] = useState(false);
  const [codeDraft, setCodeDraft] = useState('');
  const [codeEditError, setCodeEditError] = useState<string | null>(null);
  const [codeSaveNotice, setCodeSaveNotice] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [previewSurfaceBg, setPreviewSurfaceBg] = useState<string>('#ffffff');
  const [previewDevice, setPreviewDevice] = useState<PreviewDevicePreset>(
    mode === 'mobile' ? 'iphone' : 'desktop'
  );
  const [visualInspectMode, setVisualInspectMode] = useState(false);
  const [selectedVisualElement, setSelectedVisualElement] =
    useState<VisualElementSelection | null>(null);
  const [visualTextDraft, setVisualTextDraft] = useState('');
  const [visualColorDraft, setVisualColorDraft] = useState('');
  const [visualBgDraft, setVisualBgDraft] = useState('');
  const [visualFontSizeDraft, setVisualFontSizeDraft] = useState('');
  const [visualRadiusDraft, setVisualRadiusDraft] = useState('');
  const [visualAiPrompt, setVisualAiPrompt] = useState('');
  const [visualEditError, setVisualEditError] = useState<string | null>(null);
  const [previewConsoleOpen, setPreviewConsoleOpen] = useState(false);
  const [previewLogs, setPreviewLogs] = useState<PreviewConsoleEntry[]>([]);

  useEffect(() => {
    setPreviewDevice(mode === 'mobile' ? 'iphone' : 'desktop');
    setVisualInspectMode(false);
    setSelectedVisualElement(null);
    setVisualEditError(null);
    setPreviewLogs([]);
  }, [projectId, mode]);

  useEffect(() => {
    try {
      previewIframeRef.current?.contentWindow?.postMessage(
        { type: 'aicraft:setInspect', enabled: visualInspectMode },
        '*'
      );
    } catch {
      // ignore iframe postMessage error
    }
  }, [visualInspectMode, previewKey]);

  useEffect(() => {
    try {
      previewIframeRef.current?.contentWindow?.postMessage(
        { type: 'aicraft:setTestMode', enabled: testMode },
        '*'
      );
    } catch {
      // ignore iframe postMessage error
    }
  }, [testMode, previewKey]);

  const hasWorkingTurn = useMemo(
    () => turns.some((t) => t.phase === 'understanding' || t.phase === 'building'),
    [turns]
  );
  const hasPausedTurn = useMemo(
    () => turns.some((t) => t.phase === 'paused'),
    [turns]
  );

  useEffect(() => {
    if (!hasWorkingTurn && !hasPausedTurn) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [hasWorkingTurn, hasPausedTurn]);

  const monthlyExhausted =
    !isOwner &&
    (credits <= 0 || (billing !== null && billing.monthlyCreditsRemaining <= 0));
  const dailyExhausted =
    !isOwner &&
    billing?.dailyLimit !== null &&
    billing?.dailyLimit !== undefined &&
    billing.dailyCreditsUsed >= billing.dailyLimit;
  const resetTimePassed =
    (monthlyExhausted &&
      Boolean(billing?.monthlyResetAt) &&
      Date.parse(billing!.monthlyResetAt) <= nowMs) ||
    (dailyExhausted &&
      Boolean(billing?.dailyResetAt) &&
      Date.parse(billing!.dailyResetAt) <= nowMs);
  const canResumeCreditsNow =
    isOwner || (!monthlyExhausted && !dailyExhausted) || resetTimePassed;

  const {
    status: voiceStatus,
    isListening: isVoiceListening,
    isTranscribing: isVoiceTranscribing,
    voiceLevel,
    error: voiceError,
    clearError: clearVoiceError,
    stop: stopVoice,
    toggle: toggleVoice,
  } = useVoiceDictation({
    text: followUp,
    onTextChange: setFollowUp,
  });

  useEffect(() => {
    if (!voiceError) return;
    const t = window.setTimeout(clearVoiceError, 3200);
    return () => window.clearTimeout(t);
  }, [voiceError, clearVoiceError]);

  useEffect(() => {
    stopVoice();
    setFollowUp('');
    setAttachment(null);
    setActiveDrawer(null);
    setShowHeaderActions(false);
    setShowScrollBottom(false);
    setActiveCodeTab('index.html');
    setIsEditingCode(false);
    setCodeEditError(null);
    setCodeSaveNotice(null);
  }, [projectId, stopVoice]);

  const {
    supported: ttsSupported,
    speakingTurnId,
    speakTurn,
    stop: stopSpeech,
  } = useSpeechNarration();
  const narratedTurnIdsRef = useRef<Set<string>>(new Set());
  const prevProjectIdRef = useRef<string | null>(null);

  const latestBuiltTurn = useMemo(
    () => [...turns].reverse().find((t) => Boolean(t.previewHtml)),
    [turns]
  );
  const latestBuiltTurnId = latestBuiltTurn?.id ?? null;
  const latestPreviewHtml = latestBuiltTurn?.previewHtml ?? '';
  const hasBuiltApp = latestPreviewHtml.length > 0;

  useEffect(() => {
    if (!latestPreviewHtml.trim()) {
      setPreviewSurfaceBg('#FFFFFF');
      return;
    }
    const themeMatch = /<meta\b[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i.exec(
      latestPreviewHtml
    );
    if (themeMatch?.[1]?.trim()) {
      setPreviewSurfaceBg(themeMatch[1].trim());
      return;
    }
    const bodyBgMatch = /\bbody\b[^}]*\{[^}]*background(?:-color)?\s*:\s*([^;!}]+)/i.exec(
      latestPreviewHtml
    );
    if (bodyBgMatch?.[1]?.trim() && !/var\(/i.test(bodyBgMatch[1])) {
      setPreviewSurfaceBg(bodyBgMatch[1].trim());
      return;
    }
    setPreviewSurfaceBg('#ffffff');
  }, [latestPreviewHtml]);

  useEffect(() => {
    if (activeView === 'preview') {
      const targetBg = hasBuiltApp ? previewSurfaceBg : '#FFFFFF';
      document.documentElement.style.backgroundColor = targetBg;
      return () => {
        document.documentElement.style.backgroundColor = '#ffffff';
      };
    }
    document.documentElement.style.backgroundColor = '#ffffff';
    return undefined;
  }, [activeView, hasBuiltApp, previewSurfaceBg]);

  const codeParts = useMemo(() => {
    const editableFiles = extractEditableCodeFiles(latestPreviewHtml);
    if (databaseConfig.tables.length > 0 && latestPreviewHtml.trim()) {
      const schemaSql = databaseConfig.tables
        .map((t) => {
          const cols = t.columns.map((c) => {
            const sqlType =
              c.type === 'number'
                ? 'NUMERIC'
                : c.type === 'boolean'
                  ? 'BOOLEAN DEFAULT false'
                  : c.type === 'timestamp'
                    ? 'TIMESTAMPTZ DEFAULT now()'
                    : c.type === 'json'
                      ? "JSONB DEFAULT '{}'::jsonb"
                      : c.name === 'id'
                        ? 'TEXT PRIMARY KEY'
                        : 'TEXT';
            return `  ${c.name} ${sqlType}`;
          });
          return `CREATE TABLE IF NOT EXISTS ${t.name} (\n${cols.join(',\n')}\n);`;
        })
        .join('\n\n');
      editableFiles.push({
        id: 'database/schema.sql',
        label: 'database/schema.sql',
        content: schemaSql,
        kind: 'sql',
        editable: false,
      });
    }
    return editableFiles;
  }, [latestPreviewHtml, databaseConfig.tables]);

  const databaseConfigRef = useRef(databaseConfig);
  databaseConfigRef.current = databaseConfig;

  // Real-time backend file/cloud DB hydration + starter table seed sync.
  // Mirrors server tables under effectiveDbAppId (live vs __test) and extracts any new schema/seed records.
  useEffect(() => {
    if (!effectiveDbAppId) return;
    if (isStreaming) return;
    let cancelled = false;

    const cleanIdent = (raw: string) =>
      raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');

    const tryParseObjectLiteral = (objText: string): Record<string, unknown> | null => {
      try {
        const jsonish = objText
          .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
          .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
          .replace(/'((?:\\.|[^'\\])*)'/g, (_, inner: string) =>
            JSON.stringify(inner.replace(/\\'/g, "'"))
          )
          .replace(/,\s*([}\]])/g, '$1');
        const parsed = JSON.parse(jsonish) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Ignore dynamic JS expressions that require runtime iframe execution
      }
      return null;
    };

    const tableSeeds = new Map<string, Record<string, unknown>[]>();
    const detectedColsByTable = new Map<string, Map<string, ProjectDatabaseColumn>>();

    const recordColumn = (tableName: string, key: string, sampleVal?: unknown) => {
      const col = cleanIdent(key);
      if (!col) return;
      let colMap = detectedColsByTable.get(tableName);
      if (!colMap) {
        colMap = new Map();
        detectedColsByTable.set(tableName, colMap);
      }
      if (colMap.has(col)) return;
      const inferredType: ProjectDatabaseColumn['type'] =
        typeof sampleVal === 'number'
          ? 'number'
          : typeof sampleVal === 'boolean'
            ? 'boolean'
            : sampleVal !== null && typeof sampleVal === 'object'
              ? 'json'
              : col === 'created_at' || col === 'updated_at' || col.endsWith('_at')
                ? 'timestamp'
                : 'text';
      colMap.set(col, { name: col, type: inferredType, required: col === 'id' });
    };

    if (latestPreviewHtml) {
      const insertRegex = /AICraft\.db\.insert\(\s*['"`]([a-zA-Z0-9_-]+)['"`]\s*,\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = insertRegex.exec(latestPreviewHtml)) !== null) {
        const tableName = cleanIdent(m[1] || '');
        if (!tableName) continue;
        const startBrace = m.index + m[0].length - 1;
        let depth = 0;
        let endIdx = -1;
        let inStr: string | null = null;
        for (
          let i = startBrace;
          i < Math.min(latestPreviewHtml.length, startBrace + 2500);
          i += 1
        ) {
          const ch = latestPreviewHtml[i];
          if (inStr) {
            if (ch === '\\') {
              i += 1;
              continue;
            }
            if (ch === inStr) inStr = null;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === '`') {
            inStr = ch;
            continue;
          }
          if (ch === '{') depth += 1;
          else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
              endIdx = i;
              break;
            }
          }
        }
        if (endIdx === -1) continue;
        const rawObj = latestPreviewHtml.slice(startBrace, endIdx + 1);
        const parsedObj = tryParseObjectLiteral(rawObj);
        recordColumn(tableName, 'id', 'text');
        if (parsedObj) {
          for (const [k, v] of Object.entries(parsedObj)) {
            recordColumn(tableName, k, v);
          }
          const list = tableSeeds.get(tableName) ?? [];
          list.push({
            id:
              typeof parsedObj.id === 'string' && parsedObj.id
                ? parsedObj.id
                : `seed_${tableName}_${list.length + 1}`,
            created_at:
              typeof parsedObj.created_at === 'string' && parsedObj.created_at
                ? parsedObj.created_at
                : new Date().toISOString(),
            ...parsedObj,
          });
          tableSeeds.set(tableName, list);
        }
        recordColumn(tableName, 'created_at', 'timestamp');
      }

      const callRegex = /AICraft\.db\.\w+\(\s*['"`]([a-zA-Z0-9_-]+)['"`]/g;
      for (const callMatch of latestPreviewHtml.matchAll(callRegex)) {
        const tableName = cleanIdent(callMatch[1] || '');
        if (!tableName) continue;
        recordColumn(tableName, 'id', 'text');
        recordColumn(tableName, 'created_at', 'timestamp');
      }
    }

    const syncBackendAndSeed = async () => {
      let dbMutated = false;

      // 1) Mirror starter literal seeds locally if empty
      const seedPayload: Record<string, Record<string, unknown>[]> = {};
      try {
        for (const [tableName, rows] of tableSeeds.entries()) {
          if (rows.length === 0) continue;
          seedPayload[tableName] = rows;
          const storageKey = `aicraft_db_${effectiveDbAppId}_${tableName}`;
          const existingRaw = window.localStorage.getItem(storageKey);
          const existingParsed = existingRaw ? (JSON.parse(existingRaw) as unknown) : null;
          if (!Array.isArray(existingParsed) || existingParsed.length === 0) {
            window.localStorage.setItem(storageKey, JSON.stringify(rows));
            dbMutated = true;
          }
        }
      } catch {
        // ignore storage quota errors
      }

      // 2) Seed empty tables in real backend file/cloud store + fetch canonical tables
      try {
        if (Object.keys(seedPayload).length > 0) {
          await fetch(`/api/app-data/${encodeURIComponent(effectiveDbAppId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seedTables: seedPayload }),
          }).catch(() => null);
        }
        const res = await fetch(
          `/api/app-data/${encodeURIComponent(effectiveDbAppId)}`,
          { cache: 'no-store' }
        );
        if (!cancelled && res.ok) {
          const data = (await res.json()) as {
            ok?: boolean;
            tables?: Record<string, Record<string, unknown>[]>;
          };
          if (data.ok && data.tables && typeof data.tables === 'object') {
            for (const [tblName, rows] of Object.entries(data.tables)) {
              const clean = cleanIdent(tblName);
              if (!clean || !Array.isArray(rows)) continue;
              recordColumn(clean, 'id', 'text');
              recordColumn(clean, 'created_at', 'timestamp');
              for (const row of rows.slice(0, 8)) {
                if (row && typeof row === 'object') {
                  for (const [rk, rv] of Object.entries(row)) {
                    recordColumn(clean, rk, rv);
                  }
                }
              }
              const storageKey = `aicraft_db_${effectiveDbAppId}_${clean}`;
              const prevRaw = window.localStorage.getItem(storageKey);
              const nextRaw = JSON.stringify(rows);
              if (prevRaw !== nextRaw) {
                window.localStorage.setItem(storageKey, nextRaw);
                dbMutated = true;
              }
            }
          }
        }
      } catch {
        // offline or fallback to cached rows
      }

      if (cancelled) return;

      if (detectedColsByTable.size > 0) {
        const currentDb = databaseConfigRef.current;
        let changed = false;
        const nextTables = [...currentDb.tables];
        for (const [tableName, colMap] of detectedColsByTable.entries()) {
          const existingIdx = nextTables.findIndex((t) => t.name === tableName);
          if (existingIdx === -1) {
            nextTables.push({
              id: `tbl-${tableName}`,
              name: tableName,
              columns: Array.from(colMap.values()),
            });
            changed = true;
          } else {
            const existing = nextTables[existingIdx];
            const seen = new Set(existing.columns.map((c) => c.name));
            const extra = Array.from(colMap.values()).filter((c) => !seen.has(c.name));
            if (extra.length > 0) {
              nextTables[existingIdx] = {
                ...existing,
                columns: [...existing.columns, ...extra],
              };
              changed = true;
            }
          }
        }
        if (changed) {
          onUpdateDatabase({
            ...currentDb,
            enabled: true,
            tables: nextTables,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      if (dbMutated) {
        window.dispatchEvent(
          new CustomEvent('aicraft:db-updated', {
            detail: { projectId, effectiveDbAppId },
          })
        );
      }
    };

    void syncBackendAndSeed();
    return () => {
      cancelled = true;
    };
  }, [latestPreviewHtml, projectId, effectiveDbAppId, isStreaming, onUpdateDatabase]);

  const secretsFingerprint = useMemo(
    () => secrets.map((s) => `${s.key}:${s.updatedAt}`).join('|'),
    [secrets]
  );

  // Inject window.AICraft bridge, per-project secrets, and scoped real database runtime into Preview
  const connectedPreviewHtml = useMemo(() => {
    if (!latestPreviewHtml) return '';
    const envMap: Record<string, string> = {};
    for (const s of secrets) {
      if (s.key) envMap[s.key] = s.value;
    }
    const dbPrefix = `aicraft_db_${effectiveDbAppId}_`;
    const kvPrefix = `aicraft_kv_${effectiveDbAppId}_`;
    const initialDbMap: Record<string, unknown[]> = {};
    const initialKvMap: Record<string, string> = {};
    try {
      let kvBytes = 0;
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (!key) continue;
        if (key.startsWith(dbPrefix)) {
          const tblName = key.slice(dbPrefix.length);
          const raw = window.localStorage.getItem(key);
          const parsed = raw ? (JSON.parse(raw) as unknown) : [];
          initialDbMap[tblName] = Array.isArray(parsed) ? parsed : [];
        } else if (key.startsWith(kvPrefix) && kvBytes < 350000) {
          const kName = key.slice(kvPrefix.length);
          const rawVal = window.localStorage.getItem(key);
          if (typeof rawVal === 'string') {
            kvBytes += rawVal.length;
            initialKvMap[kName] = rawVal;
          }
        }
      }
    } catch {
      // ignore storage read error
    }

    const safeEnvJson = JSON.stringify(envMap).replace(/</g, '\\u003c');
    const safeInitialDbJson = JSON.stringify(initialDbMap).replace(/</g, '\\u003c');
    const safeInitialKvJson = JSON.stringify(initialKvMap).replace(/</g, '\\u003c');
    const safeDbPrefix = JSON.stringify(dbPrefix).replace(/</g, '\\u003c');
    const safeTestModeJson = JSON.stringify(Boolean(testMode));
    const safeDbMeta = JSON.stringify({
      enabled: databaseConfigRef.current.enabled,
      tables: databaseConfigRef.current.tables.map((t) => t.name),
      testMode: Boolean(testMode),
    }).replace(/</g, '\\u003c');

    const bridgeScript = `<script>
(function(){
  var envMap = ${safeEnvJson};
  var dbCache = ${safeInitialDbJson};
  var kvCache = ${safeInitialKvJson};
  var sessionKvCache = {};
  var dbPrefix = ${safeDbPrefix};
  var dbMeta = ${safeDbMeta};
  var isTestMode = ${safeTestModeJson};

  // Prevent DOMException: SecurityError when generated code accesses localStorage/sessionStorage inside sandboxed srcDoc iframe
  function installSafeStorage(propName, storeObj, syncToParent) {
    var needsShim = false;
    try {
      var probe = window[propName];
      var probeKey = '__aicraft_probe__';
      probe.setItem(probeKey, '1');
      probe.removeItem(probeKey);
    } catch (e) {
      needsShim = true;
    }
    if (!needsShim) return;
    function postKv(op, key, value) {
      if (!syncToParent) return;
      try {
        window.parent.postMessage({ type: 'aicraft:kv', op: op, key: key, value: value }, '*');
      } catch (e) {}
    }
    var shim = {
      getItem: function(k) {
        var sk = String(k);
        return Object.prototype.hasOwnProperty.call(storeObj, sk) ? storeObj[sk] : null;
      },
      setItem: function(k, v) {
        var sk = String(k);
        var sv = String(v);
        storeObj[sk] = sv;
        postKv('set', sk, sv);
      },
      removeItem: function(k) {
        var sk = String(k);
        delete storeObj[sk];
        postKv('remove', sk);
      },
      clear: function() {
        Object.keys(storeObj).forEach(function(k) { delete storeObj[k]; });
        postKv('clear');
      },
      key: function(idx) {
        var keys = Object.keys(storeObj);
        return typeof idx === 'number' && idx >= 0 && idx < keys.length ? keys[idx] : null;
      },
      get length() {
        return Object.keys(storeObj).length;
      }
    };
    try {
      Object.defineProperty(window, propName, {
        configurable: true,
        enumerable: true,
        get: function() { return shim; }
      });
    } catch (e) {}
  }
  installSafeStorage('localStorage', kvCache, true);
  installSafeStorage('sessionStorage', sessionKvCache, false);

  // Forward console output to AI Craft live console drawer
  (function installConsoleBridge() {
    var levels = ['log', 'warn', 'error'];
    for (var i = 0; i < levels.length; i += 1) {
      (function(lvl) {
        var orig = console[lvl];
        console[lvl] = function() {
          try {
            var parts = [];
            for (var a = 0; a < arguments.length; a += 1) {
              var item = arguments[a];
              if (item instanceof Error) parts.push(item.message || String(item));
              else if (typeof item === 'object' && item !== null) {
                try { parts.push(JSON.stringify(item)); } catch (e) { parts.push(String(item)); }
              } else parts.push(String(item));
            }
            window.parent.postMessage({ type: 'aicraft:console', level: lvl, message: parts.join(' ').slice(0, 600) }, '*');
          } catch (e) {}
          if (typeof orig === 'function') return orig.apply(console, arguments);
        };
      })(levels[i]);
    }
  })();

  // Visual element inspector toggleable from parent Preview toolbar
  (function installVisualInspector() {
    var inspectActive = false;
    var overlay = null;
    var badge = null;
    function ensureOverlay() {
      if (overlay || !document.body) return;
      overlay = document.createElement('div');
      overlay.setAttribute('data-aicraft-inspector', '1');
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:99997;border:2px solid #6D4AFF;background:rgba(109,74,255,0.1);border-radius:4px;display:none;transition:all 60ms ease-out;';
      badge = document.createElement('div');
      badge.style.cssText = 'position:absolute;top:-22px;left:-2px;background:#6D4AFF;color:#fff;font-family:ui-monospace,monospace;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;white-space:nowrap;';
      overlay.appendChild(badge);
      document.body.appendChild(overlay);
    }
    function hideOverlay() {
      if (overlay) overlay.style.display = 'none';
    }
    function buildSelector(el) {
      if (!el || el.nodeType !== 1) return '';
      if (el.id && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(el.id)) {
        try {
          if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
            return '#' + CSS.escape(el.id);
          }
        } catch (e) {}
      }
      var parts = [];
      var cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
        var tag = cur.tagName.toLowerCase();
        if (cur.id && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(cur.id)) {
          parts.unshift('#' + cur.id);
          break;
        }
        var sibIndex = 1;
        var sib = cur.previousElementSibling;
        while (sib) {
          if (sib.tagName === cur.tagName) sibIndex += 1;
          sib = sib.previousElementSibling;
        }
        parts.unshift(tag + ':nth-of-type(' + sibIndex + ')');
        if (cur === document.body) break;
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    }
    window.addEventListener('message', function(ev) {
      if (ev.data && ev.data.type === 'aicraft:setInspect') {
        inspectActive = Boolean(ev.data.enabled);
        if (!inspectActive) hideOverlay();
        if (document.documentElement) {
          document.documentElement.style.cursor = inspectActive ? 'crosshair' : '';
        }
      } else if (ev.data && ev.data.type === 'aicraft:setTestMode') {
        isTestMode = Boolean(ev.data.enabled);
        if (window.AICraft) window.AICraft.testMode = isTestMode;
      }
    });
    document.addEventListener('mousemove', function(ev) {
      if (!inspectActive) return;
      var t = ev.target;
      if (!t || t.nodeType !== 1 || (overlay && overlay.contains(t))) return;
      ensureOverlay();
      if (!overlay) return;
      var rect = t.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.top = rect.top + 'px';
      overlay.style.left = rect.left + 'px';
      overlay.style.width = rect.width + 'px';
      overlay.style.height = rect.height + 'px';
      if (badge) badge.textContent = '<' + t.tagName.toLowerCase() + '>';
    }, true);
    document.addEventListener('click', function(ev) {
      if (!inspectActive) return;
      var t = ev.target;
      if (!t || t.nodeType !== 1) return;
      ev.preventDefault();
      ev.stopPropagation();
      var cs = window.getComputedStyle(t);
      var selector = buildSelector(t);
      var canEditText = t.children.length === 0;
      window.parent.postMessage({
        type: 'aicraft:elementSelected',
        selection: {
          selector: selector,
          tagName: t.tagName.toLowerCase(),
          text: canEditText ? String(t.textContent || '').trim() : '',
          canEditText: canEditText,
          color: cs.color || '',
          backgroundColor: cs.backgroundColor || '',
          fontSize: cs.fontSize || '',
          borderRadius: cs.borderRadius || '',
          outerHtmlSnippet: String(t.outerHTML || '').slice(0, 360)
        }
      }, '*');
    }, true);
  })();

  // Guard unprevented internal form submissions inside srcDoc so forms never reload/blank the preview
  window.addEventListener('submit', function(ev) {
    if (ev.defaultPrevented) return;
    var form = ev.target;
    if (!form || !form.getAttribute) return;
    var action = String(form.getAttribute('action') || '').trim();
    if (!action || action === '#' || !/^https?:\\/\\//i.test(action)) {
      ev.preventDefault();
    }
  }, false);

  window.__AICRAFT_ENV__ = envMap;
  window.ENV = Object.assign({}, window.ENV || {}, envMap);
  window.process = window.process || {};
  window.process.env = Object.assign({}, window.process.env || {}, envMap);
  function getSecretFn(key) {
    if (!key) return undefined;
    if (Object.prototype.hasOwnProperty.call(envMap, key)) return envMap[key];
    var lower = String(key).toLowerCase();
    var allKeys = Object.keys(envMap);
    for (var i = 0; i < allKeys.length; i += 1) {
      if (allKeys[i].toLowerCase() === lower) return envMap[allKeys[i]];
    }
    return undefined;
  }
  function findSecretFn() {
    var patterns = Array.prototype.slice.call(arguments).filter(Boolean);
    var allKeys = Object.keys(envMap);
    for (var p = 0; p < patterns.length; p += 1) {
      var exact = getSecretFn(String(patterns[p]));
      if (exact) return exact;
    }
    for (var p2 = 0; p2 < patterns.length; p2 += 1) {
      var pat = String(patterns[p2]).toLowerCase();
      var re = null;
      try { re = new RegExp(pat, 'i'); } catch (e) {}
      for (var i = 0; i < allKeys.length; i += 1) {
        var k = allKeys[i];
        var v = String(envMap[k] || '');
        if (!v) continue;
        if (k.toLowerCase().indexOf(pat) !== -1 || (re && re.test(k))) {
          if (pat.indexOf('url') !== -1 && v.indexOf('http') !== 0 && !re) continue;
          return v;
        }
      }
    }
    for (var p3 = 0; p3 < patterns.length; p3 += 1) {
      var hintPat = String(patterns[p3]).toLowerCase();
      for (var j = 0; j < allKeys.length; j += 1) {
        var v2 = String(envMap[allKeys[j]] || '');
        if (!v2) continue;
        if (hintPat.indexOf('supabase') !== -1 && hintPat.indexOf('url') !== -1 && /^https:\\/\\/[a-z0-9-]+\\.supabase\\.co/i.test(v2)) return v2;
        if (hintPat.indexOf('supabase') !== -1 && hintPat.indexOf('url') === -1 && (/^eyJ[a-zA-Z0-9_-]+\\./.test(v2) || /^sb_(?:publishable|secret)_/i.test(v2))) return v2;
        if (hintPat.indexOf('google') !== -1 && /\\.apps\\.googleusercontent\\.com$/i.test(v2)) return v2;
      }
    }
    return undefined;
  }
  if (window.AICraft) {
    window.AICraft.env = envMap;
    window.AICraft.secretKeys = Object.keys(envMap);
    window.AICraft.getSecret = getSecretFn;
    window.AICraft.hasSecret = function(key) { return Boolean(getSecretFn(key)); };
    window.AICraft.findSecret = findSecretFn;
    window.AICraft.testMode = isTestMode;
    window.AICraft.isTestMode = function() { return Boolean(window.AICraft && window.AICraft.testMode); };
    return;
  }
  function cleanTable(table) {
    return String(table || 'items').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'items';
  }
  function readTable(table) {
    var t = cleanTable(table);
    if (Array.isArray(dbCache[t])) return dbCache[t].slice();
    try {
      var raw = window.localStorage.getItem(dbPrefix + t);
      var parsed = raw ? JSON.parse(raw) : [];
      dbCache[t] = Array.isArray(parsed) ? parsed : [];
      return dbCache[t].slice();
    } catch (e) { return []; }
  }
  function writeTable(table, rows) {
    var t = cleanTable(table);
    dbCache[t] = Array.isArray(rows) ? rows : [];
    try {
      window.localStorage.setItem(dbPrefix + t, JSON.stringify(dbCache[t]));
    } catch (e) {}
    return dbCache[t];
  }
  var dbSubscribers = {};
  function notifyDbSubscribers(table) {
    var t = cleanTable(table);
    var list = dbSubscribers[t] || [];
    var rows = readTable(t);
    for (var i = 0; i < list.length; i += 1) {
      try { list[i](rows.slice()); } catch (e) {}
    }
  }
  window.addEventListener('storage', function(ev) {
    if (!ev.key || ev.key.indexOf(dbPrefix) !== 0) return;
    var t = ev.key.slice(dbPrefix.length);
    delete dbCache[t];
    notifyDbSubscribers(t);
  });
  var pending = {};
  window.addEventListener('message', function(e) {
    var d = e.data;
    if (!d || d.type !== 'aicraft:reply' || !d.id) return;
    var cb = pending[d.id];
    if (!cb) return;
    delete pending[d.id];
    if (cb.timer) clearTimeout(cb.timer);
    if (d.error) cb.reject(new Error(d.error));
    else if (typeof d.data !== 'undefined') cb.resolve(d.data);
    else cb.resolve(d.text || '');
  });
  function sendDbOp(op, payload, fallbackValue) {
    return new Promise(function(resolve) {
      var id = 'db_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      var timer = setTimeout(function() {
        if (pending[id]) {
          delete pending[id];
          resolve(fallbackValue);
        }
      }, 2500);
      pending[id] = {
        timer: timer,
        resolve: function(val) { resolve(val); },
        reject: function() { resolve(fallbackValue); }
      };
      try {
        window.parent.postMessage(Object.assign({ type: 'aicraft:db', id: id, op: op }, payload), '*');
      } catch (e) {
        clearTimeout(timer);
        delete pending[id];
        resolve(fallbackValue);
      }
    });
  }
  function notifyParentDb(op, payload) {
    try {
      window.parent.postMessage(Object.assign({ type: 'aicraft:db', id: 'db_' + Date.now(), op: op }, payload), '*');
    } catch (e) {}
  }
  var dbApi = {
    meta: dbMeta,
    list: function(table) {
      var t = cleanTable(table);
      var cached = readTable(t);
      return sendDbOp('list', { table: t }, cached).then(function(rows) {
        if (Array.isArray(rows)) {
          writeTable(t, rows);
          return rows;
        }
        return cached;
      });
    },
    insert: function(table, row) {
      var t = cleanTable(table);
      var rows = readTable(t);
      var item = Object.assign({ id: 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), created_at: new Date().toISOString() }, row || {});
      rows.unshift(item);
      writeTable(t, rows);
      notifyDbSubscribers(t);
      notifyParentDb('insert', { table: t, row: item });
      return Promise.resolve(item);
    },
    update: function(table, id, patch) {
      var t = cleanTable(table);
      var updated = null;
      var rows = readTable(t).map(function(r) {
        if (r && r.id === id) { updated = Object.assign({}, r, patch || {}); return updated; }
        return r;
      });
      writeTable(t, rows);
      notifyDbSubscribers(t);
      notifyParentDb('update', { table: t, rowId: id, patch: patch || {} });
      return Promise.resolve(updated);
    },
    remove: function(table, id) {
      var t = cleanTable(table);
      var rows = readTable(t).filter(function(r) { return !r || r.id !== id; });
      writeTable(t, rows);
      notifyDbSubscribers(t);
      notifyParentDb('remove', { table: t, rowId: id });
      return Promise.resolve(true);
    },
    clear: function(table) {
      var t = cleanTable(table);
      writeTable(t, []);
      notifyDbSubscribers(t);
      notifyParentDb('clear', { table: t });
      return Promise.resolve(true);
    },
    subscribe: function(table, listener) {
      var t = cleanTable(table);
      if (typeof listener !== 'function') return function() {};
      if (!dbSubscribers[t]) dbSubscribers[t] = [];
      dbSubscribers[t].push(listener);
      try { listener(readTable(t)); } catch (e) {}
      return function unsubscribe() {
        dbSubscribers[t] = (dbSubscribers[t] || []).filter(function(fn) { return fn !== listener; });
      };
    }
  };
  var runtimeErrorShown = false;
  function showRuntimeFixBar(errMsg) {
    if (runtimeErrorShown) return;
    var msgText = String(errMsg || '').trim();
    if (!msgText || /^Script error\.?$/i.test(msgText) || /ResizeObserver loop/i.test(msgText)) return;
    setTimeout(function() {
      if (runtimeErrorShown || !document.body) return;
      runtimeErrorShown = true;
      var bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;z-index:99999;background:#111827;color:#F9FAFB;border:1px solid rgba(255,255,255,0.16);border-radius:14px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-family:system-ui,sans-serif;font-size:12px;box-shadow:0 12px 32px rgba(0,0,0,0.45);';
      var msg = document.createElement('span');
      msg.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      msg.textContent = 'App script error: ' + msgText.slice(0, 90);
      var btn = document.createElement('button');
      btn.textContent = 'Auto-Fix';
      btn.style.cssText = 'background:#4F46E5;color:#fff;border:0;border-radius:8px;padding:6px 11px;font-weight:600;cursor:pointer;flex-shrink:0;';
      btn.onclick = function() {
        window.parent.postMessage({ type: 'aicraft:edit', instruction: 'Fix this runtime error cleanly so every button, tab, form, and screen works without refreshing: ' + msgText }, '*');
      };
      var closeBtn = document.createElement('button');
      closeBtn.textContent = '×';
      closeBtn.setAttribute('aria-label', 'Dismiss');
      closeBtn.style.cssText = 'background:transparent;color:#9CA3AF;border:0;font-size:16px;line-height:1;padding:2px 6px;cursor:pointer;flex-shrink:0;';
      closeBtn.onclick = function() { bar.remove(); };
      bar.appendChild(msg);
      bar.appendChild(btn);
      bar.appendChild(closeBtn);
      document.body.appendChild(bar);
    }, 350);
  }
  window.addEventListener('error', function(errEvent) {
    var m = (errEvent && errEvent.message) || '';
    if (m) {
      window.parent.postMessage({ type: 'aicraft:console', level: 'error', message: m }, '*');
    }
    showRuntimeFixBar(m);
  });
  window.addEventListener('unhandledrejection', function(rejEvent) {
    var r = rejEvent && rejEvent.reason;
    var text = r && r.message ? r.message : (typeof r === 'string' ? r : '');
    if (text) {
      window.parent.postMessage({ type: 'aicraft:console', level: 'error', message: 'Unhandled Promise: ' + text }, '*');
    }
    showRuntimeFixBar(text);
  });
  function ask(prompt) {
    return new Promise(function(resolve, reject) {
      var id = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ type: 'aicraft:ask', id: id, prompt: String(prompt || '') }, '*');
    });
  }
  function search(query) {
    return new Promise(function(resolve, reject) {
      var id = 'srch_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ type: 'aicraft:search', id: id, query: String(query || '') }, '*');
    });
  }
  function generateMedia(kind, prompt, model) {
    if (kind === 'image') {
      return Promise.reject(new Error('Image generation in Preview is disabled. Describe UI changes in Chat instead.'));
    }
    return fetch('/api/media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: kind, prompt: String(prompt || ''), model: model || undefined })
    }).then(function(r) {
      return r.json().then(function(data) {
        if (!r.ok || !data || data.error) {
          throw new Error((data && data.error) || 'Media generation failed.');
        }
        return data;
      });
    });
  }
  function getPreviewThemeColor() {
    var m = document.querySelector('meta[name="theme-color"]');
    return (m && m.getAttribute('content')) || '#0F172A';
  }
  var pwaBridge = {
    isStandalone: function() {
      return Boolean((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true);
    },
    isIOS: function() {
      return /iphone|ipad|ipod/i.test(navigator.userAgent || '');
    },
    canInstall: function() { return false; },
    onInstallReady: function() {},
    promptInstall: function() {
      return Promise.resolve({
        outcome: 'dismissed',
        platform: 'preview',
        message: 'Open your deployed app link in Safari or Chrome if you enabled Home Screen install.'
      });
    },
    get themeColor() { return getPreviewThemeColor(); }
  };
  var browserBridge = {
    setThemeColor: function(hex) {
      if (!hex) return;
      var meta = document.querySelector('meta[name="theme-color"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        document.head && document.head.appendChild(meta);
      }
      meta.setAttribute('content', String(hex));
    },
    setTitle: function(title) {
      if (title) document.title = String(title);
    },
    share: function(data) {
      if (navigator.share) return navigator.share(data || { title: document.title, url: window.location.href });
      if (navigator.clipboard && data && (data.url || data.text)) return navigator.clipboard.writeText(data.url || data.text);
      return Promise.resolve();
    },
    copy: function(text) {
      return navigator.clipboard ? navigator.clipboard.writeText(String(text || '')) : Promise.resolve();
    },
    vibrate: function(pattern) {
      return navigator.vibrate ? navigator.vibrate(pattern || 12) : false;
    },
    requestFullscreen: function(el) {
      var target = el || document.documentElement;
      return target && target.requestFullscreen ? target.requestFullscreen() : Promise.resolve();
    },
    getGeolocation: function(opts) {
      return new Promise(function(resolve, reject) {
        if (!navigator.geolocation) return reject(new Error('Geolocation unavailable'));
        navigator.geolocation.getCurrentPosition(resolve, reject, opts || { enableHighAccuracy: true, timeout: 8000 });
      });
    },
    notify: function(title, opts) {
      if (!('Notification' in window)) return Promise.resolve(null);
      if (Notification.permission === 'granted') return Promise.resolve(new Notification(title, opts));
      return Notification.requestPermission().then(function(p) {
        return p === 'granted' ? new Notification(title, opts) : null;
      });
    }
  };
  window.AICraft = {
    env: envMap,
    secretKeys: Object.keys(envMap),
    getSecret: getSecretFn,
    hasSecret: function(key) { return Boolean(getSecretFn(key)); },
    findSecret: findSecretFn,
    testMode: isTestMode,
    isTestMode: function() { return Boolean(window.AICraft && window.AICraft.testMode); },
    db: dbApi,
    pwa: pwaBridge,
    browser: browserBridge,
    ask: ask,
    chat: ask,
    search: search,
    generateImage: function() {
      return Promise.reject(new Error('Image generation in Preview is disabled. Describe UI changes in Chat instead.'));
    },
    generateMusic: function(prompt, model) { return generateMedia('music', prompt, model); },
    generateVideo: function(prompt, model) { return generateMedia('video', prompt, model); },
    edit: function(instruction) {
      window.parent.postMessage({ type: 'aicraft:edit', instruction: String(instruction || '') }, '*');
    }
  };
})();
</script>`;
    if (/<\/head>/i.test(latestPreviewHtml)) {
      return latestPreviewHtml.replace(/<\/head>/i, `${bridgeScript}</head>`);
    }
    return `${bridgeScript}${latestPreviewHtml}`;
  }, [latestPreviewHtml, secrets, projectId, effectiveDbAppId, testMode]);

  // Live preview rendering: blob-URL iframe instead of srcDoc.
  // Blob documents have an opaque base URL, so we inject a <base href> to keep
  // relative asset resolution identical to the previous srcDoc behavior.
  // While streaming, rebuild the blob at most every 1200ms (throttle with the
  // latest HTML); rebuild immediately on first render, when the stream ends,
  // and for any non-streaming change (secrets, manual refresh).
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);
  const lastPreviewBuildRef = useRef(0);

  useLayoutEffect(() => {
    if (!connectedPreviewHtml) {
      const prev = previewObjectUrlRef.current;
      previewObjectUrlRef.current = null;
      lastPreviewBuildRef.current = 0;
      setPreviewObjectUrl(null);
      if (prev) URL.revokeObjectURL(prev);
      return;
    }
    const buildObjectUrl = () => {
      const html = connectedPreviewHtml;
      if (!html) return;
      let baseHref = '/';
      try {
        baseHref = new URL('.', window.location.href).href;
      } catch {
        // fall back to root
      }
      const baseTag = `<base href="${baseHref}">`;
      let withBase = html;
      if (!/<base\b/i.test(html)) {
        if (/<head[^>]*>/i.test(html)) {
          withBase = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
        } else if (/<html[^>]*>/i.test(html)) {
          withBase = html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
        } else {
          const doctypeMatch = /^<!DOCTYPE[^>]*>/i.exec(html);
          withBase = doctypeMatch
            ? html.slice(0, doctypeMatch[0].length) +
              `<html><head>${baseTag}</head>` +
              html.slice(doctypeMatch[0].length)
            : baseTag + html;
        }
      }
      const url = URL.createObjectURL(new Blob([withBase], { type: 'text/html' }));
      const prev = previewObjectUrlRef.current;
      previewObjectUrlRef.current = url;
      lastPreviewBuildRef.current = Date.now();
      setPreviewObjectUrl(url);
      if (prev && prev !== url) URL.revokeObjectURL(prev);
    };
    const sinceLastBuild = Date.now() - lastPreviewBuildRef.current;
    const minGapMs = isStreaming ? 650 : 0;
    const delayMs = Math.max(0, minGapMs - sinceLastBuild);
    if (delayMs === 0) {
      buildObjectUrl();
      return;
    }
    const timer = window.setTimeout(buildObjectUrl, delayMs);
    return () => window.clearTimeout(timer);
  }, [connectedPreviewHtml, isStreaming]);

  // Revoke the last blob URL on unmount.
  useEffect(
    () => () => {
      const current = previewObjectUrlRef.current;
      previewObjectUrlRef.current = null;
      if (current) URL.revokeObjectURL(current);
    },
    []
  );

  const activeModel = useMemo(
    () => models.find((m) => m.id === selectedModel) ?? null,
    [models, selectedModel]
  );

  const hasContent = followUp.trim().length > 0 || attachment !== null;

  // Connect preview iframe postMessage bridge to live database, OpenRouter/AI stream, and browser search
  useEffect(() => {
    const handleBridgeMessage = async (event: MessageEvent) => {
      const data = event.data as
        | {
            type?: string;
            id?: string;
            op?: 'list' | 'insert' | 'update' | 'remove' | 'clear' | 'set';
            table?: string;
            key?: string;
            value?: string;
            row?: Record<string, unknown>;
            rowId?: string;
            patch?: Record<string, unknown>;
            prompt?: string;
            query?: string;
            instruction?: string;
            level?: 'log' | 'warn' | 'error';
            message?: string;
            selection?: VisualElementSelection;
          }
        | undefined;
      if (!data?.type) return;

      if (data.type === 'aicraft:console' && data.message) {
        const lvl =
          data.level === 'error' || data.level === 'warn' ? data.level : 'log';
        const nowTime = new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        setPreviewLogs((prev) => [
          ...prev.slice(-119),
          {
            id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            level: lvl,
            message: String(data.message).slice(0, 600),
            time: nowTime,
          },
        ]);
        return;
      }

      if (data.type === 'aicraft:elementSelected' && data.selection?.selector) {
        const sel = data.selection;
        setSelectedVisualElement(sel);
        setVisualTextDraft(sel.text || '');
        setVisualColorDraft(cssColorToHex(sel.color, '#0B0B0F'));
        setVisualBgDraft(cssColorToHex(sel.backgroundColor, ''));
        setVisualFontSizeDraft(sel.fontSize || '');
        setVisualRadiusDraft(sel.borderRadius || '');
        setVisualAiPrompt('');
        setVisualEditError(null);
        return;
      }

      if (data.type === 'aicraft:kv' && data.op) {
        const kvPrefix = `aicraft_kv_${effectiveDbAppId}_`;
        try {
          if (data.op === 'set' && typeof data.key === 'string') {
            window.localStorage.setItem(`${kvPrefix}${data.key}`, String(data.value ?? ''));
          } else if (data.op === 'remove' && typeof data.key === 'string') {
            window.localStorage.removeItem(`${kvPrefix}${data.key}`);
          } else if (data.op === 'clear') {
            const keysToDelete: string[] = [];
            for (let i = 0; i < window.localStorage.length; i += 1) {
              const k = window.localStorage.key(i);
              if (k && k.startsWith(kvPrefix)) keysToDelete.push(k);
            }
            keysToDelete.forEach((k) => window.localStorage.removeItem(k));
          }
        } catch {
          // ignore storage quota errors
        }
        return;
      }

      if (data.type === 'aicraft:edit' && data.instruction?.trim()) {
        onSetView('chat');
        onSendFollowUp(data.instruction.trim(), {
          reactEnabled: mode === 'web',
          backendEnabled: false,
          webSearchEnabled,
          testMode,
          attachmentName: null,
          secretKeys: secrets.map((s) => s.key),
          secretHints: buildProjectSecretHints(secrets),
          databaseTables: databaseConfigRef.current.tables.map(
            (t) => `${t.name}(${t.columns.map((c) => `${c.name}:${c.type}`).join(',')})`
          ),
          clientCreditsRemaining: credits,
        });
        return;
      }

      if (data.type === 'aicraft:db' && data.id && data.op) {
        const replyTarget = previewIframeRef.current?.contentWindow;
        const cleanTable =
          String(data.table || 'items')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'items';
        const storageKey = `aicraft_db_${effectiveDbAppId}_${cleanTable}`;
        const tableEndpoint = `/api/app-data/${encodeURIComponent(
          effectiveDbAppId
        )}/${encodeURIComponent(cleanTable)}`;

        const readRows = (): Array<Record<string, unknown>> => {
          try {
            const raw = window.localStorage.getItem(storageKey);
            const parsed = raw ? (JSON.parse(raw) as unknown) : [];
            return Array.isArray(parsed)
              ? (parsed.filter((r) => r && typeof r === 'object') as Array<Record<string, unknown>>)
              : [];
          } catch {
            return [];
          }
        };
        const writeRows = (rows: Array<Record<string, unknown>>) => {
          try {
            window.localStorage.setItem(storageKey, JSON.stringify(rows));
          } catch {
            // ignore quota restriction
          }
        };

        let result: unknown = [];
        let sampleRowForSchema: Record<string, unknown> | null = null;

        if (data.op === 'list') {
          let rows = readRows();
          try {
            const res = await fetch(tableEndpoint, { cache: 'no-store' });
            if (res.ok) {
              const json = (await res.json()) as {
                ok?: boolean;
                rows?: Array<Record<string, unknown>>;
              };
              if (json.ok && Array.isArray(json.rows)) {
                rows = json.rows;
                writeRows(rows);
              }
            }
          } catch {
            // fallback cleanly to local mirror if offline
          }
          result = rows;
          if (rows.length > 0) sampleRowForSchema = rows[0];
        } else if (data.op === 'insert') {
          const rows = readRows();
          const item: Record<string, unknown> = {
            id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            created_at: new Date().toISOString(),
            ...(data.row && typeof data.row === 'object' ? data.row : {}),
          };
          let persistedItem = item;
          try {
            const res = await fetch(tableEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ row: item }),
            });
            if (res.ok) {
              const json = (await res.json()) as {
                ok?: boolean;
                row?: Record<string, unknown>;
              };
              if (json.ok && json.row) persistedItem = json.row;
            }
          } catch {
            // keep local mirror if offline
          }
          const deduped = rows.filter((r) => r.id !== persistedItem.id);
          deduped.unshift(persistedItem);
          writeRows(deduped);
          result = persistedItem;
          sampleRowForSchema = persistedItem;
        } else if (data.op === 'update') {
          const targetId = String(data.rowId || '').trim();
          let updated: Record<string, unknown> | null = null;
          if (targetId) {
            try {
              const res = await fetch(
                `${tableEndpoint}/${encodeURIComponent(targetId)}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    patch: data.patch && typeof data.patch === 'object' ? data.patch : {},
                  }),
                }
              );
              if (res.ok) {
                const json = (await res.json()) as {
                  ok?: boolean;
                  row?: Record<string, unknown> | null;
                };
                if (json.ok && json.row) updated = json.row;
              }
            } catch {
              // keep local mirror if offline
            }
          }
          const nextRows = readRows().map((r) => {
            if (r.id === data.rowId) {
              const mergedRow = updated || {
                ...r,
                ...(data.patch && typeof data.patch === 'object' ? data.patch : {}),
              };
              updated = mergedRow;
              return mergedRow;
            }
            return r;
          });
          writeRows(nextRows);
          result = updated;
          if (updated) sampleRowForSchema = updated;
        } else if (data.op === 'remove') {
          const targetId = String(data.rowId || '').trim();
          const nextRows = readRows().filter((r) => r.id !== data.rowId);
          writeRows(nextRows);
          if (targetId) {
            await fetch(`${tableEndpoint}/${encodeURIComponent(targetId)}`, {
              method: 'DELETE',
            }).catch(() => null);
          }
          result = true;
        } else if (data.op === 'clear') {
          writeRows([]);
          await fetch(tableEndpoint, { method: 'DELETE' }).catch(() => null);
          result = true;
        }

        // Automatically sync any newly created runtime tables/columns into project databaseConfig
        if (sampleRowForSchema || data.op === 'insert') {
          const currentDb = databaseConfigRef.current;
          const existingTable = currentDb.tables.find((t) => t.name === cleanTable);
          const inferredCols: ProjectDatabaseColumn[] = Object.entries(
            sampleRowForSchema || {}
          ).map(([k, v]) => {
            const colName = k.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
            const colType: ProjectDatabaseColumn['type'] =
              typeof v === 'number'
                ? 'number'
                : typeof v === 'boolean'
                  ? 'boolean'
                  : v !== null && typeof v === 'object'
                    ? 'json'
                    : colName === 'created_at' || colName === 'updated_at' || colName.endsWith('_at')
                      ? 'timestamp'
                      : 'text';
            return { name: colName, type: colType, required: colName === 'id' };
          });

          if (!existingTable) {
            onUpdateDatabase({
              ...currentDb,
              enabled: true,
              tables: [
                ...currentDb.tables,
                {
                  id: `tbl-${Date.now()}-${cleanTable}`,
                  name: cleanTable,
                  columns:
                    inferredCols.length > 0
                      ? inferredCols
                      : [
                          { name: 'id', type: 'text', required: true },
                          { name: 'created_at', type: 'timestamp' },
                        ],
                },
              ],
              updatedAt: new Date().toISOString(),
            });
          } else {
            const existingNames = new Set(existingTable.columns.map((c) => c.name));
            const newCols = inferredCols.filter((c) => c.name && !existingNames.has(c.name));
            if (newCols.length > 0) {
              onUpdateDatabase({
                ...currentDb,
                tables: currentDb.tables.map((t) =>
                  t.name === cleanTable
                    ? { ...t, columns: [...t.columns, ...newCols] }
                    : t
                ),
                updatedAt: new Date().toISOString(),
              });
            }
          }
        }

        window.dispatchEvent(
          new CustomEvent('aicraft:db-updated', {
            detail: { projectId, effectiveDbAppId, table: cleanTable },
          })
        );
        replyTarget?.postMessage(
          { type: 'aicraft:reply', id: data.id, data: result },
          '*'
        );
        return;
      }

      if (data.type === 'aicraft:surface') {
        const surfaceColor = (event.data as { color?: string })?.color;
        if (typeof surfaceColor === 'string' && surfaceColor.trim()) {
          setPreviewSurfaceBg(surfaceColor.trim());
        }
        return;
      }

      if (data.type === 'aicraft:search' && data.id && data.query?.trim()) {
        const replyTarget = previewIframeRef.current?.contentWindow;
        try {
          const response = await fetch(
            `/api/search?q=${encodeURIComponent(data.query.trim())}`
          );
          const json = (await response.json()) as {
            query?: string;
            results?: Array<{ title: string; snippet: string; url: string; source: string; imageUrl?: string }>;
            images?: Array<{ title: string; imageUrl: string; source: string }>;
            videos?: Array<{ title: string; videoUrl: string; posterUrl?: string; source: string }>;
          };
          replyTarget?.postMessage(
            {
              type: 'aicraft:reply',
              id: data.id,
              data: {
                query: json.query ?? data.query.trim(),
                results: Array.isArray(json.results) ? json.results : [],
                images: Array.isArray(json.images) ? json.images : [],
                videos: Array.isArray(json.videos) ? json.videos : [],
              },
            },
            '*'
          );
        } catch (err) {
          replyTarget?.postMessage(
            {
              type: 'aicraft:reply',
              id: data.id,
              error: err instanceof Error ? err.message : 'Search failed.',
            },
            '*'
          );
        }
        return;
      }

      if (data.type === 'aicraft:ask' && data.id && data.prompt?.trim()) {
        const replyTarget = previewIframeRef.current?.contentWindow;
        if (onCheckCanUseAi && !onCheckCanUseAi()) {
          replyTarget?.postMessage(
            {
              type: 'aicraft:reply',
              id: data.id,
              error: 'No credit balance remaining. Upgrade to continue chatting with AI.',
            },
            '*'
          );
          return;
        }

        try {
          const response = await fetch('/api/craft/stream', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(authHeaders || {}),
            },
            body: JSON.stringify({
              message: data.prompt.trim(),
              mode,
              model: selectedModel || undefined,
              clientTime: new Date().toLocaleString(),
              clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
              options: {
                webSearchEnabled,
                forceChat: true,
                secretKeys: secrets.map((s) => s.key),
                secretHints: buildProjectSecretHints(secrets),
                databaseTables: databaseConfigRef.current.tables.map(
                  (t) => `${t.name}(${t.columns.map((c) => `${c.name}:${c.type}`).join(',')})`
                ),
                clientCreditsRemaining: credits,
              },
            }),
          });
          if (!response.ok || !response.body) {
            let errMessage = 'Unable to reach AI Craft engine.';
            try {
              const errJson = (await response.json()) as {
                error?: string;
                billing?: BillingSummary;
              };
              if (errJson.error) errMessage = errJson.error;
              if (response.status === 402) {
                onPaymentRequired?.(errJson.billing ?? null, errMessage);
              }
            } catch {
              if (response.status === 402) {
                onPaymentRequired?.(null, errMessage);
              }
            }
            throw new Error(errMessage);
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let fullText = '';
          let streamErr = '';

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() ?? '';
            for (const rawEvent of events) {
              const line = rawEvent.split(/\r?\n/).find((l) => l.trim().startsWith('data:'));
              if (!line) continue;
              try {
                const evt = JSON.parse(line.trim().slice(5).trim()) as {
                  type: string;
                  text?: string;
                  fullText?: string;
                  message?: string;
                };
                if (evt.type === 'reset') fullText = '';
                else if (evt.type === 'delta' && evt.text) fullText += evt.text;
                else if (evt.type === 'done' && evt.fullText) fullText = evt.fullText;
                else if (evt.type === 'error' && evt.message) streamErr = evt.message;
              } catch {
                // ignore malformed chunk
              }
            }
          }

          replyTarget?.postMessage(
            {
              type: 'aicraft:reply',
              id: data.id,
              text: fullText,
              error: streamErr || undefined,
            },
            '*'
          );
        } catch (err) {
          replyTarget?.postMessage(
            {
              type: 'aicraft:reply',
              id: data.id,
              error: err instanceof Error ? err.message : 'AI request failed.',
            },
            '*'
          );
        }
      }
    };

    window.addEventListener('message', handleBridgeMessage);
    return () => window.removeEventListener('message', handleBridgeMessage);
  }, [
    authHeaders,
    credits,
    effectiveDbAppId,
    mode,
    onCheckCanUseAi,
    onPaymentRequired,
    onSendFollowUp,
    onSetView,
    onUpdateDatabase,
    projectId,
    secrets,
    selectedModel,
    testMode,
    webSearchEnabled,
  ]);

  // Zero-lag rAF auto-scroll while streaming
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 180 || isStreaming) {
      const raf = window.requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
      return () => window.cancelAnimationFrame(raf);
    }
  }, [turns, isStreaming]);

  // Automatic browser-native TTS narration when a new AI response completes
  useEffect(() => {
    if (prevProjectIdRef.current !== projectId) {
      prevProjectIdRef.current = projectId;
      stopSpeech();
      // Do not replay pre-existing historical turns when opening an older project
      narratedTurnIdsRef.current = new Set(
        turns
          .filter((t) => t.phase === 'complete' && !t.errorMessage)
          .map((t) => t.id)
      );
      return;
    }

    const newlyCompleted = turns.filter(
      (t) =>
        t.phase === 'complete' &&
        !t.errorMessage &&
        t.aiText.trim().length > 0 &&
        !narratedTurnIdsRef.current.has(t.id)
    );

    if (newlyCompleted.length > 0) {
      newlyCompleted.forEach((t) => narratedTurnIdsRef.current.add(t.id));
      if (autoReadEnabled) {
        const latestTurn = newlyCompleted[newlyCompleted.length - 1];
        const spokenText = sanitizeDisplayProse(
          latestTurn.aiText,
          latestTurn.kind === 'build'
        );
        if (spokenText) {
          speakTurn(latestTurn.id, spokenText);
        }
      }
    }
  }, [projectId, turns, speakTurn, stopSpeech, autoReadEnabled]);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBottom(distanceFromBottom > 120);
  };

  const scrollToBottom = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || isRestricted) return;
    const processed = await readAttachmentFile(file);
    setAttachment(processed);
  };

  const buildFollowUpOptions = (overrides?: Partial<ComposerOptions>): ComposerOptions => ({
    reactEnabled: mode === 'web',
    backendEnabled: databaseConfig.enabled && databaseConfig.tables.length > 0,
    webSearchEnabled,
    testMode,
    attachmentName: overrides?.attachmentName ?? null,
    attachmentDataUrl: overrides?.attachmentDataUrl ?? null,
    attachmentMimeType: overrides?.attachmentMimeType ?? null,
    attachmentText: overrides?.attachmentText ?? null,
    secretKeys: secrets.map((s) => s.key),
    secretHints: buildProjectSecretHints(secrets),
    databaseTables: databaseConfig.enabled
      ? databaseConfig.tables.map(
          (t) => `${t.name}(${t.columns.map((c) => `${c.name}:${c.type}`).join(',')})`
        )
      : [],
    clientCreditsRemaining: credits,
  });

  const handleSubmit = () => {
    if (isRestricted || !hasContent || isStreaming) return;
    stopVoice();
    const text =
      followUp.trim() ||
      (attachment?.dataUrl
        ? `Analyze this screenshot (${attachment.name}) and update the app preview to fix or remove what needs changing while keeping the rest intact.`
        : `Attached reference: ${attachment?.name ?? 'file'}`);
    onSendFollowUp(
      text,
      buildFollowUpOptions({
        attachmentName: attachment?.name ?? null,
        attachmentDataUrl: attachment?.dataUrl ?? null,
        attachmentMimeType: attachment?.mimeType ?? null,
        attachmentText: attachment?.textContent ?? null,
      })
    );
    setFollowUp('');
    setAttachment(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isRestricted) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleShare = async (): Promise<string> => {
    const shareUrl = deployment.liveUrl || window.location.href;
    const shareText = `${projectTitle} — Built with AI Craft`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: projectTitle,
          text: shareText,
          url: shareUrl,
        });
        return 'Shared successfully';
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        return 'Live app link copied';
      }
    } catch {
      // User cancelled share or clipboard blocked
    }
    return 'Ready to share';
  };

  const handleCopyCode = async (textOverride?: string) => {
    const content = textOverride ?? latestPreviewHtml;
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      // ignore clipboard restriction
    }
  };

  // Preview Mode: framed app preview with device presets, click-to-edit visual inspector,
  // live console with 1-click "Fix with AI", and thumb-reachable bottom toolbar.
  if (activeView === 'preview') {
    const deviceSpec = PREVIEW_DEVICE_SPECS[previewDevice];
    const consoleErrorCount = previewLogs.filter((l) => l.level === 'error').length;

    const triggerPreviewAiInstruction = (instruction: string) => {
      if (!instruction.trim() || isRestricted || isStreaming) return;
      onSetView('chat');
      onSendFollowUp(instruction.trim(), buildFollowUpOptions());
    };

    const handleApplyVisualPatch = async () => {
      if (!selectedVisualElement || !onUpdatePreviewHtml) return;
      setVisualEditError(null);
      const res = applyVisualPatchToHtml(
        latestPreviewHtml,
        selectedVisualElement.selector,
        {
          text: selectedVisualElement.canEditText ? visualTextDraft : undefined,
          color: visualColorDraft || undefined,
          backgroundColor: visualBgDraft || undefined,
          fontSize: visualFontSizeDraft || undefined,
          borderRadius: visualRadiusDraft || undefined,
        }
      );
      if (res.ok === false) {
        setVisualEditError(res.error);
        return;
      }
      await onUpdatePreviewHtml(res.html);
      setSelectedVisualElement(null);
    };

    return (
      <div className="relative h-dvh w-full flex flex-col overflow-hidden bg-[#F4F4F5]">
        {/* Top bar — back + title + device frame presets + Inspect/Console/Refresh */}
        <header className="shrink-0 w-full bg-white/95 backdrop-blur border-b border-black/[0.07] pt-safe">
          <div className="w-full max-w-[1180px] mx-auto px-2.5 py-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSetView('chat')}
              aria-label="Back to chat"
              className="min-w-[38px] min-h-[38px] rounded-full flex items-center justify-center text-[#0B0B0F] hover:bg-black/[0.05] active:scale-95 transition-all shrink-0"
            >
              <ChevronLeft className="w-6 h-6 stroke-[2]" />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="font-display font-bold text-[14.5px] tracking-[-0.02em] text-[#0B0B0F] truncate">
                {projectTitle}
              </h1>
              <p className="text-[11px] text-[#71717A] truncate">
                {isStreaming
                  ? 'Building your app…'
                  : visualInspectMode
                    ? 'Inspect active · Tap any element to edit'
                    : hasBuiltApp
                      ? `${deviceSpec.label} · ${deviceSpec.dimensions}`
                      : 'Nothing built yet'}
              </p>
            </div>

            {/* Device Frame Presets */}
            <div
              role="group"
              aria-label="Device frame presets"
              className="hidden sm:inline-flex items-center gap-0.5 p-1 rounded-xl bg-black/[0.04] border border-black/[0.06] shrink-0"
            >
              {(
                [
                  { id: 'iphone', Icon: Smartphone, label: 'iPhone (390×844)' },
                  { id: 'android', Icon: Smartphone, label: 'Android (412×915)' },
                  { id: 'tablet', Icon: Tablet, label: 'Tablet (768×1024)' },
                  { id: 'desktop', Icon: Monitor, label: 'Desktop (Responsive)' },
                ] as const
              ).map(({ id, Icon, label }) => {
                const active = previewDevice === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setPreviewDevice(id)}
                    title={label}
                    aria-label={label}
                    className={`h-7 px-2 rounded-lg text-[11px] font-medium inline-flex items-center gap-1 transition-all ${
                      active
                        ? 'bg-white text-[#0B0B0F] shadow-xs'
                        : 'text-[#52525B] hover:text-[#0B0B0F]'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span className="hidden md:inline capitalize">{id}</span>
                  </button>
                );
              })}
            </div>

            {/* Mobile compact device cycle button */}
            <button
              type="button"
              onClick={() => {
                const order: PreviewDevicePreset[] = ['iphone', 'android', 'tablet', 'desktop'];
                setPreviewDevice((d) => order[(order.indexOf(d) + 1) % order.length]);
              }}
              aria-label="Switch device frame size"
              title={`Device: ${deviceSpec.label} (${deviceSpec.dimensions})`}
              className="sm:hidden min-w-[36px] min-h-[36px] rounded-full flex items-center justify-center text-[#52525B] hover:bg-black/[0.05] shrink-0"
            >
              {previewDevice === 'desktop' ? (
                <Monitor className="w-4 h-4" />
              ) : previewDevice === 'tablet' ? (
                <Tablet className="w-4 h-4" />
              ) : (
                <Smartphone className="w-4 h-4" />
              )}
            </button>

            {/* Test Mode Switch */}
            {onToggleTestMode && (
              <button
                type="button"
                role="switch"
                aria-checked={testMode}
                onClick={onToggleTestMode}
                aria-label="Toggle Gemini Test Mode"
                title={
                  testMode
                    ? 'Test Mode ON — Using isolated test database'
                    : 'Turn on Test Mode'
                }
                className={`h-8 px-2.5 rounded-full border flex items-center justify-center gap-1.5 text-[11.5px] font-semibold transition-all shrink-0 active:scale-95 ${
                  testMode
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                    : 'bg-white border-black/[0.08] text-[#52525B] hover:bg-black/[0.04]'
                }`}
              >
                <FlaskConical
                  className={`w-3.5 h-3.5 ${testMode ? 'text-emerald-600' : 'text-[#71717A]'}`}
                />
                <span className="hidden sm:inline">Test</span>
                <span
                  aria-hidden="true"
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                    testMode ? 'bg-emerald-500' : 'bg-zinc-300'
                  }`}
                >
                  <span
                    className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
                      testMode ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`}
                  />
                </span>
              </button>
            )}

            {/* Visual Inspector Toggle */}
            <button
              type="button"
              disabled={!hasBuiltApp}
              onClick={() => {
                setVisualInspectMode((v) => !v);
                if (visualInspectMode) setSelectedVisualElement(null);
              }}
              aria-label="Toggle click-to-edit visual inspector"
              title="Click-to-Edit Visual Inspector"
              className={`h-9 px-2.5 rounded-full flex items-center justify-center gap-1 text-[11.5px] font-semibold transition-all shrink-0 disabled:opacity-40 ${
                visualInspectMode
                  ? 'bg-[#6D4AFF] text-white shadow-xs'
                  : 'text-[#52525B] hover:bg-black/[0.05]'
              }`}
            >
              <MousePointerClick className="w-4 h-4" />
              <span className="hidden md:inline">Inspect</span>
            </button>

            {/* Live Console Toggle */}
            <button
              type="button"
              onClick={() => setPreviewConsoleOpen((v) => !v)}
              aria-label="Toggle live runtime console"
              title="Live Runtime Console"
              className={`relative h-9 px-2.5 rounded-full flex items-center justify-center gap-1 text-[11.5px] font-semibold transition-all shrink-0 ${
                previewConsoleOpen
                  ? 'bg-[#0B0B0F] text-white'
                  : 'text-[#52525B] hover:bg-black/[0.05]'
              }`}
            >
              <Terminal className="w-4 h-4" />
              <span className="hidden md:inline">Console</span>
              {consoleErrorCount > 0 && (
                <span className="ml-0.5 px-1.5 py-0.2 rounded-full bg-red-500 text-white text-[10px] font-bold tabular-nums">
                  {consoleErrorCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setPreviewKey((k) => k + 1)}
              aria-label="Refresh preview"
              title="Refresh preview"
              className="min-w-[36px] min-h-[36px] rounded-full flex items-center justify-center text-[#52525B] hover:bg-black/[0.05] active:scale-95 transition-all shrink-0"
            >
              <RotateCw className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Framed preview + optional Visual Inspector side/bottom drawer */}
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row items-stretch justify-center overflow-hidden p-0 sm:p-4 gap-3">
          <div className="flex-1 min-h-0 flex items-stretch justify-center overflow-hidden">
            <div
              className={`relative w-full h-full overflow-hidden border-0 sm:border sm:border-black/10 bg-white shadow-none sm:shadow-[0_10px_36px_rgba(0,0,0,0.12)] transition-all duration-200 ${deviceSpec.maxWidthClass} ${deviceSpec.radiusClass}`}
              style={{ backgroundColor: hasBuiltApp ? previewSurfaceBg : '#FFFFFF' }}
            >
              {hasBuiltApp ? (
                <iframe
                  ref={previewIframeRef}
                  key={`${projectId}-${previewKey}-${secretsFingerprint}`}
                  title={`${projectTitle} Preview`}
                  src={previewObjectUrl ?? undefined}
                  onLoad={() => {
                    try {
                      previewIframeRef.current?.contentWindow?.postMessage(
                        { type: 'aicraft:setInspect', enabled: visualInspectMode },
                        '*'
                      );
                    } catch {
                      // ignore iframe message error
                    }
                  }}
                  sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
                  className="w-full h-full border-0 block bg-transparent"
                />
              ) : (
                <div className="h-full w-full flex flex-col items-center justify-center px-6 text-center bg-[#FAFAFC]">
                  {isStreaming ? (
                    <div className="w-full max-w-[300px] flex flex-col items-center gap-4">
                      <div className="w-11 h-11 rounded-2xl bg-white border border-black/[0.08] shadow-xs flex items-center justify-center">
                        <Loader2
                          className="w-5 h-5 animate-spin"
                          style={{ color: theme.accentColor }}
                        />
                      </div>
                      <div>
                        <h2 className="font-display font-semibold text-[16px] text-[#0B0B0F]">
                          Building live preview
                        </h2>
                        <p className="mt-1 text-[13px] text-[#71717A] leading-relaxed">
                          Your interface will render right here as soon as code begins streaming.
                        </p>
                      </div>
                      <div className="w-full space-y-2.5 pt-2">
                        <div className="h-2.5 w-3/4 mx-auto rounded-full bg-black/[0.06] animate-pulse" />
                        <div className="h-20 w-full rounded-2xl bg-black/[0.04] animate-pulse" />
                        <div className="grid grid-cols-2 gap-2.5">
                          <div className="h-14 rounded-xl bg-black/[0.04] animate-pulse" />
                          <div className="h-14 rounded-xl bg-black/[0.04] animate-pulse" />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="max-w-[300px] flex flex-col items-center gap-3">
                      <div className="w-11 h-11 rounded-2xl bg-white border border-black/[0.08] shadow-xs flex items-center justify-center text-[#52525B]">
                        <Eye className="w-5 h-5" />
                      </div>
                      <div>
                        <h2 className="font-display font-semibold text-[16px] text-[#0B0B0F]">
                          Ready for preview
                        </h2>
                        <p className="mt-1 text-[13px] text-[#71717A] leading-relaxed">
                          Describe any app or site in Chat to build and interact with it live here.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => onSetView('chat')}
                        className="mt-1 h-9 px-4 rounded-xl bg-[#0B0B0F] hover:bg-black/85 text-white text-[13px] font-semibold inline-flex items-center gap-1.5 active:scale-95 transition-all"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                        <span>Back to Chat</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Click-to-Edit Visual Inspector Drawer */}
          {selectedVisualElement && hasBuiltApp && (
            <aside
              aria-label="Visual Element Inspector"
              className="shrink-0 w-full lg:w-[320px] max-h-[42dvh] lg:max-h-full overflow-y-auto rounded-2xl border border-black/[0.1] bg-white shadow-[0_10px_30px_rgba(11,11,15,0.12)] p-3.5 flex flex-col gap-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="inline-flex items-center gap-1 text-[11px] font-mono font-bold text-[#6D4AFF]">
                    &lt;{selectedVisualElement.tagName}&gt;
                  </span>
                  <p className="text-[11px] font-mono text-[#71717A] truncate">
                    {selectedVisualElement.selector}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedVisualElement(null)}
                  aria-label="Close element inspector"
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[#52525B] hover:bg-black/[0.05]"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {selectedVisualElement.canEditText && (
                <div>
                  <label className="block text-[11px] font-medium text-[#52525B] mb-1">
                    Element Text
                  </label>
                  <input
                    type="text"
                    value={visualTextDraft}
                    onChange={(e) => setVisualTextDraft(e.target.value)}
                    className="w-full h-8 px-2.5 rounded-lg border border-black/[0.12] bg-[#FAFAFC] text-[12.5px] text-[#0B0B0F] focus:outline-none focus:border-[#6D4AFF]"
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-medium text-[#52525B] mb-1">
                    Text Color
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={visualColorDraft || '#0B0B0F'}
                      onChange={(e) => setVisualColorDraft(e.target.value)}
                      className="w-8 h-8 rounded border border-black/10 p-0.5 cursor-pointer bg-white"
                    />
                    <input
                      type="text"
                      value={visualColorDraft}
                      onChange={(e) => setVisualColorDraft(e.target.value)}
                      className="min-w-0 flex-1 h-8 px-2 rounded-lg border border-black/[0.12] bg-[#FAFAFC] font-mono text-[11px]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-[#52525B] mb-1">
                    Background
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={visualBgDraft || '#FFFFFF'}
                      onChange={(e) => setVisualBgDraft(e.target.value)}
                      className="w-8 h-8 rounded border border-black/10 p-0.5 cursor-pointer bg-white"
                    />
                    <input
                      type="text"
                      value={visualBgDraft}
                      onChange={(e) => setVisualBgDraft(e.target.value)}
                      placeholder="transparent"
                      className="min-w-0 flex-1 h-8 px-2 rounded-lg border border-black/[0.12] bg-[#FAFAFC] font-mono text-[11px]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-[#52525B] mb-1">
                    Font Size
                  </label>
                  <input
                    type="text"
                    value={visualFontSizeDraft}
                    onChange={(e) => setVisualFontSizeDraft(e.target.value)}
                    placeholder="16px"
                    className="w-full h-8 px-2 rounded-lg border border-black/[0.12] bg-[#FAFAFC] font-mono text-[11.5px]"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-[#52525B] mb-1">
                    Border Radius
                  </label>
                  <input
                    type="text"
                    value={visualRadiusDraft}
                    onChange={(e) => setVisualRadiusDraft(e.target.value)}
                    placeholder="12px"
                    className="w-full h-8 px-2 rounded-lg border border-black/[0.12] bg-[#FAFAFC] font-mono text-[11.5px]"
                  />
                </div>
              </div>

              {visualEditError && (
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                  {visualEditError}
                </p>
              )}

              <button
                type="button"
                disabled={isStreaming || !onUpdatePreviewHtml}
                onClick={() => void handleApplyVisualPatch()}
                className="w-full h-9 rounded-xl bg-[#0B0B0F] hover:bg-black/85 disabled:opacity-50 text-white text-[12px] font-semibold inline-flex items-center justify-center gap-1.5"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Apply Direct Edit</span>
              </button>

              <div className="pt-2 border-t border-black/[0.06] flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-[#52525B]">
                  Or describe a smart AI edit for this element
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={visualAiPrompt}
                    onChange={(e) => setVisualAiPrompt(e.target.value)}
                    placeholder="e.g. Make it pop with a gradient pill"
                    className="flex-1 min-w-0 h-8 px-2.5 rounded-lg border border-black/[0.12] bg-[#FAFAFC] text-[12px] focus:outline-none focus:border-[#6D4AFF]"
                  />
                  <button
                    type="button"
                    disabled={!visualAiPrompt.trim() || isStreaming || isRestricted}
                    onClick={() => {
                      const instruction = `Update the <${selectedVisualElement.tagName}> element matching "${selectedVisualElement.selector}" (HTML snippet: ${selectedVisualElement.outerHtmlSnippet.slice(0, 180)}): ${visualAiPrompt.trim()}`;
                      setVisualInspectMode(false);
                      setSelectedVisualElement(null);
                      triggerPreviewAiInstruction(instruction);
                    }}
                    className="h-8 px-2.5 rounded-lg bg-[#6D4AFF] hover:bg-[#5B35F5] disabled:opacity-50 text-white text-[11.5px] font-semibold inline-flex items-center gap-1 shrink-0"
                  >
                    <Wand2 className="w-3 h-3" />
                    <span>AI</span>
                  </button>
                </div>
              </div>
            </aside>
          )}
        </div>

        {/* Collapsible Live Runtime Console Drawer */}
        {previewConsoleOpen && (
          <div className="shrink-0 w-full max-w-[1180px] mx-auto px-3 pb-2">
            <div className="rounded-2xl bg-[#111118] text-[#E4E4E7] border border-white/10 shadow-lg overflow-hidden">
              <div className="px-3.5 py-2 bg-[#1A1A24] border-b border-white/10 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[11.5px] font-mono">
                  <Terminal className="w-3.5 h-3.5 text-[#8B5CF6]" />
                  <span className="font-semibold text-white">Live Console</span>
                  <span className="text-[#A1A1AA]">({previewLogs.length})</span>
                </div>
                <div className="flex items-center gap-2">
                  {previewLogs.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setPreviewLogs([])}
                      className="text-[11px] text-[#A1A1AA] hover:text-white px-2 py-0.5 rounded bg-white/5"
                    >
                      Clear
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPreviewConsoleOpen(false)}
                    aria-label="Close console"
                    className="text-[#A1A1AA] hover:text-white p-0.5"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="max-h-[140px] overflow-y-auto p-2.5 font-mono text-[11.5px] flex flex-col gap-1">
                {previewLogs.length === 0 ? (
                  <p className="text-[#71717A] px-1 py-2">
                    No console messages or errors captured yet.
                  </p>
                ) : (
                  previewLogs.map((entry) => (
                    <div
                      key={entry.id}
                      className={`px-2 py-1 rounded-lg flex items-start justify-between gap-2 ${
                        entry.level === 'error'
                          ? 'bg-red-500/15 text-red-200'
                          : entry.level === 'warn'
                            ? 'bg-amber-500/15 text-amber-200'
                            : 'text-[#D4D4D8]'
                      }`}
                    >
                      <span className="text-[#71717A] shrink-0 text-[10.5px]">
                        {entry.time}
                      </span>
                      <span className="flex-1 break-words">{entry.message}</span>
                      {entry.level === 'error' && (
                        <button
                          type="button"
                          disabled={isStreaming || isRestricted}
                          onClick={() =>
                            triggerPreviewAiInstruction(
                              `Fix this runtime error cleanly so every button, tab, form, and screen works without errors: ${entry.message}`
                            )
                          }
                          className="shrink-0 px-2 py-0.5 rounded bg-[#6D4AFF] hover:bg-[#5B35F5] text-white text-[10.5px] font-sans font-semibold inline-flex items-center gap-1"
                        >
                          <Wand2 className="w-3 h-3" />
                          <span>Fix with AI</span>
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* Bottom toolbar — thumb zone: every key action within easy reach */}
        <footer className="shrink-0 w-full bg-white/95 backdrop-blur border-t border-black/[0.07] pb-safe">
          <div className="w-full max-w-[1100px] mx-auto px-2 pt-1.5 pb-2 grid grid-cols-5 gap-1">
            <button
              type="button"
              onClick={() => onSetView('chat')}
              className="min-h-[52px] rounded-2xl flex flex-col items-center justify-center gap-0.5 text-[#52525B] hover:bg-black/[0.05] active:scale-95 transition-all"
            >
              <MessageSquare className="w-5 h-5" />
              <span className="text-[10.5px] font-medium">Chat</span>
            </button>
            <button
              type="button"
              onClick={() => onSetView('code')}
              className="min-h-[52px] rounded-2xl flex flex-col items-center justify-center gap-0.5 text-[#52525B] hover:bg-black/[0.05] active:scale-95 transition-all"
            >
              <Code2 className="w-5 h-5" />
              <span className="text-[10.5px] font-medium">Code</span>
            </button>
            <button
              type="button"
              onClick={() => setPreviewKey((k) => k + 1)}
              className="min-h-[52px] rounded-2xl flex flex-col items-center justify-center gap-0.5 text-[#52525B] hover:bg-black/[0.05] active:scale-95 transition-all"
            >
              <RotateCw className="w-5 h-5" />
              <span className="text-[10.5px] font-medium">Refresh</span>
            </button>
            <button
              type="button"
              onClick={() => void handleShare()}
              className="min-h-[52px] rounded-2xl flex flex-col items-center justify-center gap-0.5 text-[#52525B] hover:bg-black/[0.05] active:scale-95 transition-all"
            >
              <Share2 className="w-5 h-5" />
              <span className="text-[10.5px] font-medium">Share</span>
            </button>
            <button
              type="button"
              onClick={onOpenApps}
              className="min-h-[52px] rounded-2xl flex flex-col items-center justify-center gap-0.5 text-[#52525B] hover:bg-black/[0.05] active:scale-95 transition-all"
            >
              <LayoutGrid className="w-5 h-5" />
              <span className="text-[10.5px] font-medium">Apps</span>
            </button>
          </div>
        </footer>
      </div>
    );
  }

  // Built-In Code Viewer & Live File Editor
  if (activeView === 'code') {
    const selectedCodePart =
      codeParts.find((p) => p.id === activeCodeTab) ?? codeParts[0];
    const displayedContent = isEditingCode
      ? codeDraft
      : selectedCodePart?.content || '';
    const lineCount = displayedContent ? displayedContent.split('\n').length : 0;
    const kbLabel = `${(displayedContent.length / 1024).toFixed(1)} KB`;

    const handleBeginCodeEdit = () => {
      if (!selectedCodePart || !selectedCodePart.editable || isStreaming) return;
      setCodeEditError(null);
      setCodeSaveNotice(null);
      setCodeDraft(selectedCodePart.content);
      setIsEditingCode(true);
    };

    const handleApplyCodeEdit = async () => {
      if (!selectedCodePart || !latestPreviewHtml || !onUpdatePreviewHtml) return;
      const result = applyFileEditToHtml(
        latestPreviewHtml,
        selectedCodePart.id,
        codeDraft
      );
      if (!result.ok) {
        setCodeEditError(result.error);
        return;
      }
      setCodeEditError(null);
      await onUpdatePreviewHtml(result.html);
      setIsEditingCode(false);
      setPreviewKey((k) => k + 1);
      setCodeSaveNotice(`Saved ${selectedCodePart.label} & refreshed Preview`);
      window.setTimeout(() => setCodeSaveNotice(null), 2600);
    };

    return (
      <div className="relative h-dvh w-full flex flex-col bg-white overflow-hidden">
        <header className="shrink-0 w-full bg-white border-b border-black/[0.06] pt-safe">
          <div className="w-full max-w-[680px] lg:max-w-[960px] 2xl:max-w-[1160px] mx-auto px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <button
                type="button"
                onClick={() => {
                  setIsEditingCode(false);
                  setCodeEditError(null);
                  onSetView('preview');
                }}
                aria-label="Back to Preview"
                className="min-w-[40px] min-h-[40px] rounded-full flex items-center justify-center text-[#0B0B0F] hover:bg-black/[0.04] active:scale-95 transition-all shrink-0"
              >
                <ChevronLeft className="w-6 h-6 stroke-[2]" />
              </button>
              <div className="min-w-0">
                <h1 className="font-display font-bold text-[15.5px] tracking-[-0.02em] text-[#0B0B0F] truncate">
                  {projectTitle} · Code
                </h1>
                <p className="text-[11px] text-[#71717A] font-mono tabular-nums truncate">
                  {selectedCodePart?.label} · {lineCount} lines · {kbLabel}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {selectedCodePart?.editable && hasBuiltApp && onUpdatePreviewHtml && !isStreaming && (
                isEditingCode ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditingCode(false);
                        setCodeEditError(null);
                      }}
                      className="h-9 px-2.5 rounded-xl border border-black/15 bg-white text-xs font-medium text-[#52525B] hover:bg-black/[0.03] inline-flex items-center gap-1"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Cancel</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleApplyCodeEdit()}
                      className="h-9 px-3 rounded-xl bg-[#6D4AFF] hover:bg-[#5B35F5] text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>Save & Preview</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleBeginCodeEdit}
                    className="h-9 px-3 rounded-xl border border-black/15 bg-white text-xs font-medium text-[#0B0B0F] hover:bg-black/[0.03] inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    <span>Edit</span>
                  </button>
                )
              )}

              <button
                type="button"
                onClick={() => void handleCopyCode(displayedContent)}
                className="h-9 px-2.5 sm:px-3 rounded-xl border border-black/15 bg-white text-xs font-medium text-[#0B0B0F] hover:bg-black/[0.03] inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                {copiedCode ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#0D6BFF]" />
                    <span className="hidden sm:inline">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Copy</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsEditingCode(false);
                  setCodeEditError(null);
                  onSetView('chat');
                }}
                className="h-9 px-3 rounded-xl bg-[#0B0B0F] text-white text-xs font-medium whitespace-nowrap"
              >
                Chat
              </button>
            </div>
          </div>

          {codeParts.length > 0 && (
            <div className="w-full max-w-[680px] lg:max-w-[960px] 2xl:max-w-[1160px] mx-auto px-3 pb-2 flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {codeParts.map((part) => {
                const isSelected = selectedCodePart?.id === part.id;
                return (
                  <button
                    key={part.id}
                    type="button"
                    onClick={() => {
                      setActiveCodeTab(part.id);
                      setIsEditingCode(false);
                      setCodeEditError(null);
                    }}
                    className={`px-3 py-1 rounded-lg text-xs font-mono transition-colors shrink-0 ${
                      isSelected
                        ? 'bg-[#0B0B0F] text-white'
                        : 'bg-[#F4F4F6] text-[#52525B] hover:text-[#0B0B0F]'
                    }`}
                  >
                    {part.label}
                  </button>
                );
              })}
            </div>
          )}
        </header>

        {(codeEditError || codeSaveNotice) && (
          <div className="shrink-0 bg-[#181822] border-b border-white/10 px-4 py-2">
            <div className="w-full max-w-[680px] lg:max-w-[960px] 2xl:max-w-[1160px] mx-auto">
              {codeEditError ? (
                <p role="alert" className="text-xs font-medium text-red-400">
                  {codeEditError}
                </p>
              ) : (
                <p role="status" className="text-xs font-medium text-emerald-400">
                  {codeSaveNotice}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 flex flex-col bg-[#0F1117] text-[#E4E4E7]">
          {isEditingCode ? (
            <textarea
              value={codeDraft}
              onChange={(e) => setCodeDraft(e.target.value)}
              spellCheck={false}
              aria-label={`Edit ${selectedCodePart?.label || 'file'}`}
              className="flex-1 min-h-0 w-full max-w-[680px] lg:max-w-[960px] 2xl:max-w-[1160px] mx-auto p-4 bg-[#0F1117] text-[#E4E4E7] text-[12.5px] leading-relaxed font-mono resize-none focus:outline-none"
            />
          ) : (
            <div className="flex-1 min-h-0 overflow-auto p-4">
              <pre className="w-full max-w-[680px] lg:max-w-[960px] 2xl:max-w-[1160px] mx-auto text-[12.5px] leading-relaxed font-mono whitespace-pre-wrap break-words">
                <code>{selectedCodePart?.content || 'No generated code yet.'}</code>
              </pre>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-dvh w-full flex flex-col justify-between bg-white overflow-hidden">
      {/* Top Workspace Header Bar */}
      <header className="shrink-0 w-full bg-white border-b border-black/[0.06] pt-safe">
        <div className="w-full max-w-[540px] md:max-w-[720px] lg:max-w-[880px] 2xl:max-w-[1060px] mx-auto px-3 py-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to Create"
              className="min-w-[40px] min-h-[40px] rounded-full flex items-center justify-center text-[#0B0B0F] hover:bg-black/[0.04] active:scale-95 transition-all shrink-0"
            >
              <ChevronLeft className="w-6 h-6 stroke-[2]" />
            </button>

            <Globe className="w-[18px] h-[18px] text-[#111118] shrink-0 stroke-[1.8]" />

            <h1 className="font-display font-bold text-[17px] tracking-[-0.02em] text-[#0B0B0F] truncate">
              {projectTitle}
            </h1>

            {isVerified && (
              <BadgeCheck
                aria-label="Verified creator"
                className="w-4 h-4 text-[#0D5BFF] shrink-0"
              />
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* Hide Preview button for pure Image/Music/Video media chats with no web app */}
            {(hasBuiltApp || !turns.some((t) => t.kind === 'media' || Boolean(t.media))) && (
              <button
                type="button"
                onClick={() => onSetView('preview')}
                aria-label={`Preview ${projectTitle}`}
                className="h-9 px-2.5 rounded-xl border bg-white text-[#0B0B0F] border-black/15 hover:bg-black/[0.03] flex items-center gap-1.5 text-[13px] font-medium whitespace-nowrap shrink-0 active:scale-95 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7A68F6]"
              >
                <Eye className="w-4 h-4 stroke-[2]" />
                <span>Preview</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowHeaderActions((v) => !v)}
              aria-label="Workspace actions"
              aria-expanded={showHeaderActions}
              className="min-w-[40px] min-h-[40px] rounded-full flex items-center justify-center text-[#111118] hover:bg-black/[0.04] active:scale-95 transition-all"
            >
              <MoreVertical className="w-5 h-5 stroke-[1.9]" />
            </button>
          </div>
        </div>

        {/* Inline non-overlapping action strip when menu toggled */}
        {showHeaderActions && (
          <div className="w-full max-w-[540px] md:max-w-[720px] lg:max-w-[880px] 2xl:max-w-[1060px] mx-auto px-4 pb-2.5 flex items-center justify-between gap-2 border-t border-black/[0.04] pt-2 text-xs">
            <span className="text-[#52525B] font-medium truncate">
              {theme.label}
            </span>
            <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <button
                type="button"
                onClick={() => {
                  setShowHeaderActions(false);
                  onOpenSettings();
                }}
                className="px-3 py-1.5 rounded-lg bg-[#F4F4F6] text-[#0B0B0F] font-medium hover:bg-[#E4E4E7] whitespace-nowrap"
              >
                Settings
              </button>
              {!isOwner && (
                <button
                  type="button"
                  onClick={() => {
                    setShowHeaderActions(false);
                    onOpenUpgrade();
                  }}
                  className="px-3 py-1.5 rounded-lg bg-[#F5F3FF] text-[#6D4AFF] font-medium hover:bg-[#EDE9FE] whitespace-nowrap"
                >
                  Upgrade
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowHeaderActions(false);
                  onOpenApps();
                }}
                className="px-3 py-1.5 rounded-lg bg-[#F4F4F6] text-[#0B0B0F] font-medium hover:bg-[#E4E4E7] whitespace-nowrap"
              >
                Apps
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowHeaderActions(false);
                  onBack();
                }}
                className="px-3 py-1.5 rounded-lg bg-[#0B0B0F] text-white font-medium whitespace-nowrap"
              >
                New Build
              </button>
            </div>
          </div>
        )}
      </header>

      {/* Scrollable AI Understanding & Building Stream */}
      <div className="relative flex-1 min-h-0 w-full">
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="h-full w-full overflow-y-auto px-5 py-4"
        >
          <div className="w-full max-w-[500px] md:max-w-[680px] lg:max-w-[840px] 2xl:max-w-[1000px] mx-auto flex flex-col gap-6 pb-4">
            {turns.map((turn) => {
              const isMediaTurn = turn.kind === 'media' || Boolean(turn.media);
              const isBuildTurn = turn.kind === 'build' && !isMediaTurn;
              const isTurnWorking =
                turn.phase === 'understanding' || turn.phase === 'building';
              const displayAiText = sanitizeDisplayProse(turn.aiText, isBuildTurn);
              const isPausedTurn = turn.phase === 'paused';

              const elapsedSec = isTurnWorking
                ? turn.startedAt
                  ? Math.max(1, Math.floor((nowMs - turn.startedAt) / 1000))
                  : Math.max(1, turn.thoughtSeconds)
                : Math.max(1, turn.thoughtSeconds);

              const activeStageIndex: 0 | 1 | 2 = (() => {
                if (!isTurnWorking) return 2;
                const actionLower = (turn.activeAction || '').toLowerCase();
                if (actionLower.includes('check') || actionLower.includes('verify')) return 2;
                if (
                  turn.phase === 'building' ||
                  actionLower.includes('cod') ||
                  Boolean(turn.activeFile) ||
                  (turn.bytesBuilt ?? 0) > 0
                ) {
                  return 1;
                }
                return 0;
              })();

              const isPlanOpen = Boolean(expandedPlanTurns[turn.id]);
              const togglePlan = () =>
                setExpandedPlanTurns((prev) => ({ ...prev, [turn.id]: !prev[turn.id] }));

              const turnModelName =
                models.length > 0
                  ? turn.modelName ||
                    models.find((m) => m.id === turn.modelId)?.name ||
                    activeModel?.name ||
                    'Gemini'
                  : turn.modelName || 'Gemini';

              const stageSteps = ['Building', 'Coding', 'Checking'] as const;
              const showLivePipelineCard =
                isTurnWorking && (isBuildTurn || turn.phase === 'building' || Boolean(turn.activeFile));
              const previewBytes = turn.bytesBuilt || turn.previewHtml?.length || 0;

              return (
                <article key={turn.id} className="flex flex-col gap-3">
                  {/* User Message Bubble */}
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#F4F4F6] px-3.5 py-2.5 text-[14.5px] leading-snug text-[#111118]">
                      {turn.attachmentDataUrl && (
                        <img
                          src={turn.attachmentDataUrl}
                          alt={turn.attachmentName || 'Screenshot attachment'}
                          className="mb-2 max-h-44 w-auto rounded-xl border border-black/10 object-cover"
                        />
                      )}
                      <p className="whitespace-pre-wrap">{turn.userMessage}</p>
                      {turn.attachmentName && !turn.attachmentDataUrl && (
                        <p className="mt-1 text-xs text-[#71717A]">
                          Attached: {turn.attachmentName}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Clean AI Attribution Row */}
                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <ProviderLogo
                        provider={turn.modelProvider || activeModel?.provider}
                        modelId={turn.modelId || selectedModel}
                        size={20}
                        isTracking={isTurnWorking}
                        trackingColor={theme.accentColor}
                      />
                      <span className="font-display font-semibold text-[14px] tracking-[-0.01em] text-[#0B0B0F] truncate">
                        {turnModelName}
                      </span>
                      <span aria-hidden="true" className="text-[#A1A1AA] text-xs">
                        ·
                      </span>
                      <span className="text-[12.5px] text-[#71717A] tabular-nums truncate">
                        {isTurnWorking
                          ? `${showLivePipelineCard ? stageSteps[activeStageIndex] : turn.activeAction || 'Thinking'} · ${elapsedSec}s`
                          : isPausedTurn
                            ? `Paused · ${elapsedSec}s`
                            : `${elapsedSec}s`}
                      </span>
                    </div>

                    {isTurnWorking && (turn.bytesBuilt ?? 0) > 0 && (
                      <span className="text-[11.5px] font-mono text-[#71717A] shrink-0 tabular-nums">
                        {((turn.bytesBuilt ?? 0) / 1024).toFixed(1)} KB
                      </span>
                    )}
                  </div>

                  {/* Clean Real-Time Building -> Coding -> Checking Tracker (while active) */}
                  {showLivePipelineCard && (
                    <div className="rounded-2xl border border-black/[0.08] bg-[#FAFAFC] px-3.5 py-3 flex flex-col gap-2.5">
                      <div className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {stageSteps.map((stageLabel, idx) => {
                          const isDone = idx < activeStageIndex;
                          const isActive = idx === activeStageIndex;
                          return (
                            <div key={stageLabel} className="flex items-center gap-2 shrink-0">
                              <div
                                className={`inline-flex items-center gap-1.5 text-[12.5px] font-medium ${
                                  isActive
                                    ? 'text-[#0B0B0F]'
                                    : isDone
                                      ? 'text-[#3F3F46]'
                                      : 'text-[#A1A1AA]'
                                }`}
                              >
                                {isActive ? (
                                  <Loader2
                                    className="w-3.5 h-3.5 animate-spin shrink-0"
                                    style={{ color: theme.accentColor }}
                                  />
                                ) : isDone ? (
                                  <CheckCircle2 className="w-3.5 h-3.5 text-[#0D5BFF] shrink-0" />
                                ) : (
                                  <span className="w-2 h-2 rounded-full bg-black/15 shrink-0" />
                                )}
                                <span>{stageLabel}</span>
                              </div>
                              {idx < stageSteps.length - 1 && (
                                <span aria-hidden="true" className="text-[#D4D4D8] text-xs">
                                  /
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      <div className="flex items-center justify-between gap-2 text-[12.5px] text-[#52525B]">
                        <span className="truncate">
                          {activeStageIndex === 1 && turn.activeFile
                            ? `Coding ${turn.activeFile}`
                            : turn.phaseLabel || `${stageSteps[activeStageIndex]}...`}
                        </span>
                        {turn.planSteps && turn.planSteps.length > 0 && (
                          <button
                            type="button"
                            onClick={togglePlan}
                            className="shrink-0 text-[12px] font-medium text-[#0B0B0F] hover:opacity-75 whitespace-nowrap"
                          >
                            {isPlanOpen ? 'Hide steps' : `Steps (${turn.planSteps.length})`}
                          </button>
                        )}
                      </div>

                      {isPlanOpen && turn.planSteps && turn.planSteps.length > 0 && (
                        <ul className="pt-1.5 border-t border-black/[0.06] space-y-1 text-[12.5px] text-[#3F3F46]">
                          {turn.planSteps.map((step, idx) => (
                            <li key={`${turn.id}-live-plan-${idx}`} className="flex items-start gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-[#0D5BFF] shrink-0" />
                              <span>{step}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* AI Response Prose or Error */}
                  {turn.errorMessage ? (
                    <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-700 leading-relaxed flex flex-col gap-2.5">
                      <span className="line-clamp-5 break-words" title={turn.errorMessage}>
                        {turn.errorMessage}
                      </span>
                      <div>
                        <button
                          type="button"
                          disabled={isStreaming}
                          onClick={() => onContinueTurn(turn)}
                          className="px-3.5 py-1.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-[12.5px] font-semibold active:scale-95 transition-all disabled:opacity-50"
                        >
                          Continue / Retry
                        </button>
                      </div>
                    </div>
                  ) : (
                    (displayAiText || !showLivePipelineCard) && (
                      <div className="flex items-start justify-between gap-2.5">
                        <div className="flex-1 min-w-0 text-[15px] leading-[1.6] tracking-[-0.005em] text-[#111118] whitespace-pre-wrap">
                          {displayAiText || (
                            <span className="text-[#71717A]">
                              {isTurnWorking
                                ? turn.phaseLabel || 'Thinking...'
                                : isBuildTurn
                                  ? 'Your app is ready to preview.'
                                  : 'Waiting for response...'}
                            </span>
                          )}
                          {isTurnWorking && displayAiText && (
                            <span
                              aria-hidden="true"
                              className="inline-block w-1.5 h-4 ml-1 align-middle bg-[#7A68F6]/75 rounded-xs"
                            />
                          )}
                        </div>

                        {ttsSupported &&
                          turn.phase === 'complete' &&
                          displayAiText.length > 0 && (
                            <button
                              type="button"
                              onClick={() => speakTurn(turn.id, displayAiText)}
                              aria-label={
                                speakingTurnId === turn.id
                                  ? 'Replay message from beginning'
                                  : 'Read message aloud'
                              }
                              title="Replay audio"
                              className={`mt-0.5 min-w-[36px] min-h-[36px] rounded-full border flex items-center justify-center shrink-0 transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7A68F6] ${
                                speakingTurnId === turn.id
                                  ? 'border-transparent text-white shadow-xs'
                                  : 'border-black/10 bg-[#F7F7FA] text-[#52525B] hover:bg-[#EFEFF5] hover:text-[#111118]'
                              }`}
                              style={
                                speakingTurnId === turn.id
                                  ? { backgroundColor: theme.accentColor }
                                  : undefined
                              }
                            >
                              <Volume2 className="w-4 h-4 stroke-[2]" />
                            </button>
                          )}
                      </div>
                    )
                  )}

                  {/* Sleek Completed Build Action Card (Preview + Code + Optional Steps) */}
                  {turn.phase === 'complete' &&
                    isBuildTurn &&
                    !turn.errorMessage &&
                    Boolean(turn.previewHtml) && (
                      <div className="rounded-2xl border border-black/[0.08] bg-[#FAFAFC] p-3.5 flex flex-col gap-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-display font-semibold text-[14px] text-[#0B0B0F] truncate">
                              {projectTitle}
                            </p>
                            <p className="text-[12px] text-[#71717A] tabular-nums">
                              {Math.max(1, turn.files.length)} files
                              <span aria-hidden="true"> · </span>
                              {(previewBytes / 1024).toFixed(1)} KB
                            </p>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => onSetView('preview')}
                              className="h-10 px-3.5 rounded-xl bg-[#0B0B0F] hover:bg-black/85 text-white text-[13px] font-semibold inline-flex items-center gap-1.5 whitespace-nowrap active:scale-95 transition-all"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              <span>Open Preview</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => onSetView('code')}
                              aria-label="Open built code"
                              className="h-10 px-3 rounded-xl border border-black/12 bg-white hover:bg-black/[0.03] text-[#0B0B0F] text-[13px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap active:scale-95 transition-all"
                            >
                              <Code2 className="w-3.5 h-3.5" />
                              <span>Code</span>
                            </button>
                          </div>
                        </div>

                        {turn.planSteps && turn.planSteps.length > 0 && (
                          <div>
                            <button
                              type="button"
                              onClick={togglePlan}
                              className="text-[12px] font-medium text-[#52525B] hover:text-[#0B0B0F]"
                            >
                              {isPlanOpen
                                ? 'Hide build steps'
                                : `View build steps (${turn.planSteps.length})`}
                            </button>
                            {isPlanOpen && (
                              <ul className="mt-2 pt-2 border-t border-black/[0.06] space-y-1 text-[12.5px] text-[#3F3F46]">
                                {turn.planSteps.map((step, idx) => (
                                  <li key={`${turn.id}-done-plan-${idx}`} className="flex items-start gap-1.5">
                                    <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-[#0D5BFF] shrink-0" />
                                    <span>{step}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                  {/* Generated Media Card (Image / Music / Video) — No web browser link */}
                  {turn.media && turn.media.dataUrl && (
                    <div className="rounded-[20px] border border-black/[0.08] bg-[#FAFAFC] overflow-hidden shadow-[0_2px_12px_rgba(15,15,30,0.04)]">
                      <div className="px-3.5 py-2.5 bg-[#F2F2F6] flex items-center justify-between gap-2 border-b border-black/[0.05]">
                        <div className="flex items-center gap-2 min-w-0">
                          {turn.media.kind === 'video' ? (
                            <Film className="w-4 h-4 text-[#6D4AFF] shrink-0" />
                          ) : turn.media.kind === 'music' ? (
                            <Music className="w-4 h-4 text-[#6D4AFF] shrink-0" />
                          ) : (
                            <ImageIcon className="w-4 h-4 text-[#6D4AFF] shrink-0" />
                          )}
                          <span className="text-[13px] font-semibold text-[#0B0B0F] truncate">
                            {turn.media.kind === 'video'
                              ? 'Generated Video'
                              : turn.media.kind === 'music'
                                ? 'Generated Music'
                                : 'Generated Image'}
                          </span>
                        </div>

                        <a
                          href={turn.media.dataUrl}
                          download={`aicraft-${turn.media.kind}-${turn.id}.${
                            turn.media.kind === 'video'
                              ? 'mp4'
                              : turn.media.kind === 'music'
                                ? turn.media.mimeType.includes('wav')
                                  ? 'wav'
                                  : 'mp3'
                                : turn.media.mimeType.includes('png')
                                  ? 'png'
                                  : turn.media.mimeType.includes('webp')
                                    ? 'webp'
                                    : 'jpg'
                          }`}
                          className="h-8 px-2.5 rounded-lg bg-white border border-black/10 hover:bg-black/[0.03] text-[12px] font-medium text-[#0B0B0F] inline-flex items-center gap-1.5 shrink-0 active:scale-95 transition-all"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Save</span>
                        </a>
                      </div>

                      <div className="p-3 flex flex-col gap-2">
                        {turn.media.kind === 'image' && (
                          <img
                            src={turn.media.dataUrl}
                            alt={turn.media.prompt}
                            className="w-full max-h-[380px] rounded-xl object-contain bg-black/[0.04]"
                          />
                        )}
                        {turn.media.kind === 'music' && (
                          <audio
                            controls
                            src={turn.media.dataUrl}
                            className="w-full"
                          />
                        )}
                        {turn.media.kind === 'video' && (
                          <video
                            controls
                            playsInline
                            loop
                            preload="metadata"
                            src={turn.media.dataUrl}
                            className="w-full max-h-[380px] rounded-xl bg-black"
                          />
                        )}
                        {turn.media.prompt && (
                          <p className="text-[12px] text-[#71717A] leading-snug px-0.5 line-clamp-2">
                            {turn.media.prompt}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Paused Build Card — Stops at 0 Credits OR Near Serverless Limit & Unlocks "Continue" */}
                  {isPausedTurn && (() => {
                    const isStreamInterrupted =
                      turn.pausedReason === 'STREAM_INTERRUPTED';
                    const resetCountdown = monthlyExhausted
                      ? formatCountdown(billing?.monthlyResetAt, nowMs)
                      : dailyExhausted
                        ? formatCountdown(billing?.dailyResetAt, nowMs)
                        : '';
                    const savedBytes = turn.bytesBuilt ?? turn.previewHtml?.length ?? 0;
                    const savedLabel =
                      savedBytes >= 1024
                        ? `${(savedBytes / 1024).toFixed(1)} KB saved`
                        : savedBytes > 0
                          ? `${savedBytes} B saved`
                          : '';
                    const allowResume = canResumeCreditsNow || isStreamInterrupted;

                    return (
                      <div className="rounded-2xl border border-black/[0.08] bg-white p-4 shadow-[0_2px_10px_rgba(15,15,30,0.03)] flex flex-col gap-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="font-display font-bold text-[15px] text-[#0B0B0F] tracking-[-0.01em]">
                              {isStreamInterrupted
                                ? 'Build paused · Ready to continue'
                                : canResumeCreditsNow
                                  ? 'Credits ready · Resume build'
                                  : 'Build paused · 0 tokens remaining'}
                            </h3>
                            <p className="mt-1 text-[13.5px] leading-relaxed text-[#52525B]">
                              {isStreamInterrupted
                                ? turn.pausedMessage ||
                                  'Your progress so far is safely saved. Tap Continue Building to finish the rest.'
                                : canResumeCreditsNow
                                  ? 'Your tokens are available again. Tap Continue Building to finish from your saved progress.'
                                  : turn.pausedMessage ||
                                    'All remaining tokens were used and your progress is saved. Building resumes automatically once tokens reset or you upgrade.'}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-[12px] text-[#71717A] tabular-nums">
                          {isStreamInterrupted ? (
                            <span className="font-medium text-[#6D4AFF]">
                              Progress saved
                            </span>
                          ) : canResumeCreditsNow ? (
                            <span className="font-medium text-[#6D4AFF]">
                              {credits.toLocaleString()} credits available
                            </span>
                          ) : resetCountdown ? (
                            <span>
                              {monthlyExhausted
                                ? `Monthly refresh in ${resetCountdown}`
                                : `Daily reset in ${resetCountdown}`}
                            </span>
                          ) : (
                            <span>Waiting for credit reset or upgrade</span>
                          )}
                          {savedLabel && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{savedLabel}</span>
                            </>
                          )}
                          {Boolean(turn.previewHtml) && (
                            <>
                              <span aria-hidden="true">·</span>
                              <button
                                type="button"
                                onClick={() => onSetView('preview')}
                                className="font-medium text-[#0B0B0F] underline underline-offset-4 hover:opacity-75"
                              >
                                Preview saved progress
                              </button>
                            </>
                          )}
                        </div>

                        <div className="flex items-center gap-2 pt-0.5">
                          {allowResume ? (
                            <button
                              type="button"
                              disabled={isStreaming}
                              onClick={() => onContinueTurn(turn)}
                              className="flex-1 min-h-[44px] px-4 rounded-xl bg-[#6D4AFF] hover:bg-[#5B38F5] active:scale-[0.99] text-white text-[14px] font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Continue Building
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={onOpenUpgrade}
                              className="flex-1 min-h-[44px] px-4 rounded-xl bg-[#0B0B0F] hover:bg-black/85 active:scale-[0.99] text-white text-[14px] font-semibold transition-all"
                            >
                              Upgrade Plan to Continue
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Compact Horizontally Scrollable Follow-Up Suggestions */}
                  {turn.phase === 'complete' &&
                    isBuildTurn &&
                    !turn.errorMessage &&
                    turn.suggestions &&
                    turn.suggestions.length > 0 && (
                      <div className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden touch-pan-x pt-0.5 pb-1 [-webkit-overflow-scrolling:touch]">
                        {turn.suggestions.map((suggestion, idx) => (
                          <button
                            key={`${turn.id}-sug-${idx}`}
                            type="button"
                            disabled={isStreaming || isRestricted}
                            onClick={() => {
                              if (!isRestricted) {
                                onSendFollowUp(suggestion, buildFollowUpOptions());
                              }
                            }}
                            className="shrink-0 h-9 px-3.5 rounded-xl border border-black/[0.09] bg-white hover:bg-[#F7F7FA] hover:border-black/15 text-[12.5px] font-medium text-[#111118] whitespace-nowrap transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    )}
                </article>
              );
            })}
          </div>
        </div>

        {/* Scroll-to-Bottom Button (only when scrolled up) */}
        {showScrollBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Scroll to latest message"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 w-10 h-10 rounded-full bg-white border border-black/10 shadow-md flex items-center justify-center text-[#0B0B0F] hover:bg-neutral-50 active:scale-95 transition-all"
          >
            <ArrowDown className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Clean Bottom Follow-Up Chat Composer */}
      <div className="shrink-0 w-full bg-white border-t border-black/[0.05] pb-safe [[data-platform=android]_&]:pb-5">
        <div className="w-full max-w-[520px] md:max-w-[700px] lg:max-w-[860px] 2xl:max-w-[1020px] mx-auto px-4 pt-2.5 pb-2.5">
          {inlineNotice ? (
            <p
              role="status"
              className="mb-2 px-3 py-1.5 rounded-xl bg-red-50 border border-red-200 text-[12px] font-medium text-red-700 text-center"
            >
              {inlineNotice}
            </p>
          ) : null}

          {!isOwner && (
            <div className="px-1 pb-1.5 flex items-center justify-between text-[12px]">
              <button
                type="button"
                onClick={onOpenUpgrade}
                className={`font-medium tabular-nums ${
                  credits <= 0 ? 'text-red-600' : 'text-[#71717A] hover:text-[#0B0B0F]'
                }`}
              >
                {credits.toLocaleString()} credits left
              </button>
              <button
                type="button"
                onClick={onOpenUpgrade}
                className="font-semibold text-[#0D5BFF] hover:opacity-80"
              >
                Upgrade
              </button>
            </div>
          )}

          {/* Sleek Rounded Input Box */}
          <div
            className={`relative w-full rounded-[22px] bg-white border shadow-[0_2px_16px_rgba(15,15,30,0.05)] px-3.5 pt-2.5 pb-2.5 flex flex-col gap-1.5 ${
              isRestricted ? 'border-amber-400/70' : 'border-black/[0.1]'
            }`}
          >
            {(models.length > 0 || onToggleTestMode) && (
              <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-black/[0.05]">
                <div className="flex items-center gap-2 min-w-0">
                  <ProviderLogo
                    provider={activeModel?.provider}
                    modelId={activeModel?.id || selectedModel}
                    size={18}
                    isTracking={isStreaming}
                    trackingColor={theme.accentColor}
                  />
                  <span className="text-[12px] font-medium text-[#18181B] truncate">
                    {activeModel?.name ??
                      (modelsLoading ? 'Connecting Gemini...' : 'Gemini 4 Hydrogen')}
                  </span>
                  <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-[10.5px] font-semibold text-indigo-700 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                    Gemini
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {onToggleTestMode && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={testMode}
                      aria-label="Toggle Gemini Test Mode"
                      title={
                        testMode
                          ? 'Test Mode ON — Isolated test database & sandboxed app runs'
                          : 'Turn on Test Mode for isolated testing with Gemini'
                      }
                      onClick={onToggleTestMode}
                      className={`h-8 px-2 rounded-full border inline-flex items-center gap-1.5 text-[11.5px] font-medium transition-all active:scale-95 ${
                        testMode
                          ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                          : 'bg-white/85 border-black/[0.08] text-[#52525B] hover:bg-black/[0.03]'
                      }`}
                    >
                      <FlaskConical
                        className={`w-3.5 h-3.5 shrink-0 ${
                          testMode ? 'text-emerald-600' : 'text-[#71717A]'
                        }`}
                      />
                      <span>Test</span>
                      <span
                        aria-hidden="true"
                        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                          testMode ? 'bg-emerald-500' : 'bg-zinc-300'
                        }`}
                      >
                        <span
                          className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
                            testMode ? 'translate-x-3.5' : 'translate-x-0.5'
                          }`}
                        />
                      </span>
                    </button>
                  )}
                  {models.length > 0 && (
                    <ModelSelectorPopover
                      mode={mode}
                      models={models}
                      selectedModel={selectedModel}
                      modelsLoading={modelsLoading}
                      modelsError={modelsError}
                      isStreaming={isStreaming}
                      onSelectModel={onSelectModel}
                      onRetryModels={onRetryModels}
                    />
                  )}
                </div>
              </div>
            )}

            {isRestricted && (
              <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-1.5 flex items-center gap-2 text-[12px] font-medium text-amber-900">
                <ShieldAlert className="w-4 h-4 text-amber-700 shrink-0" />
                <span>Account restricted — messages cannot enter this chat box.</span>
              </div>
            )}

            <div className="flex items-start gap-2">
              <textarea
                value={isRestricted ? '' : followUp}
                disabled={isRestricted}
                readOnly={isRestricted}
                onChange={(e) => {
                  if (!isRestricted) setFollowUp(e.target.value);
                }}
                onKeyDown={handleKeyDown}
                placeholder={
                  isRestricted
                    ? 'Restricted — messaging disabled on this account.'
                    : isVoiceListening
                      ? 'Listening... speak now'
                      : isVoiceTranscribing
                        ? 'Transcribing speech...'
                        : 'Chat naturally or describe the app you want to build...'
                }
                rows={2}
                aria-label={
                  isRestricted
                    ? 'Chat box restricted'
                    : 'Send message or follow-up to AI Craft'
                }
                className="flex-1 min-w-0 resize-none bg-transparent text-[15px] leading-[1.45] text-[#0B0B0F] placeholder:text-[#A1A1AA] focus:outline-none min-h-[44px] disabled:cursor-not-allowed disabled:opacity-65"
              />
              <div className="pt-0.5 shrink-0">
                <VoiceInputButton
                  variant="inline"
                  status={voiceStatus}
                  voiceLevel={voiceLevel}
                  accentColor={theme.accentColor}
                  disabled={isStreaming || isRestricted}
                  onClick={() => {
                    if (!isRestricted) toggleVoice();
                  }}
                />
              </div>
            </div>

            {voiceError && (
              <p className="text-[11.5px] text-red-600">{voiceError}</p>
            )}

            {attachment && (
              <div className="flex items-center gap-2 text-xs text-[#52525B]">
                {attachment.dataUrl ? (
                  <img
                    src={attachment.dataUrl}
                    alt={attachment.name}
                    className="w-9 h-9 rounded-lg object-cover border border-black/10 shrink-0"
                  />
                ) : null}
                <span className="truncate max-w-[220px] font-medium">
                  {attachment.name}
                </span>
                <button
                  type="button"
                  onClick={() => setAttachment(null)}
                  aria-label="Remove attachment"
                  className="p-0.5 rounded-full hover:bg-black/5 text-[#71717A]"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-0.5">
              {/* Left: Attachment + Web Search */}
              <div className="flex items-center gap-1.5 shrink-0">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileChange}
                  accept="image/*,.pdf,.txt,.json"
                />
                <button
                  type="button"
                  disabled={isRestricted}
                  onClick={() => {
                    if (!isRestricted) fileInputRef.current?.click();
                  }}
                  aria-label="Attach screenshot or file"
                  className="w-9 h-9 rounded-full border border-black/[0.09] flex items-center justify-center text-[#3F3F46] hover:bg-black/[0.03] active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Paperclip className="w-[17px] h-[17px] -rotate-45 stroke-[1.8]" />
                </button>
                <button
                  type="button"
                  onClick={() => setWebSearchEnabled((v) => !v)}
                  aria-pressed={webSearchEnabled}
                  aria-label="Toggle live browser web search"
                  title={webSearchEnabled ? 'Browser search connected' : 'Browser search off'}
                  className={`w-9 h-9 rounded-full border flex items-center justify-center active:scale-95 transition-all ${
                    webSearchEnabled
                      ? 'border-[#7A68F6]/45 bg-[#F3F0FF] text-[#6D4AFF]'
                      : 'border-black/[0.09] text-[#52525B] hover:bg-black/[0.03]'
                  }`}
                >
                  <Globe className="w-[17px] h-[17px] stroke-[1.75]" />
                </button>
              </div>

              {/* Right: Send OR Stop Button */}
              {isStreaming && onStopGeneration ? (
                <button
                  type="button"
                  onClick={onStopGeneration}
                  aria-label="Stop building and save progress"
                  title="Stop here & save progress"
                  className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center bg-[#0B0B0F] hover:bg-black/85 text-white transition-all duration-150 active:scale-95"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={isRestricted || !hasContent || isStreaming}
                  aria-label={isRestricted ? 'Chat restricted' : 'Send message to AI Craft'}
                  style={{
                    backgroundColor:
                      !isRestricted && hasContent && !isStreaming
                        ? theme.sendActiveBg
                        : isRestricted
                          ? '#D4D4D8'
                          : '#BEB5F9',
                  }}
                  className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-white transition-all duration-200 active:scale-95 disabled:cursor-not-allowed"
                >
                  <ArrowUp className="w-[18px] h-[18px] stroke-[2.4]" />
                </button>
              )}
            </div>
          </div>

          {/* Scrollable Quick Action Strip Below Chat Box: Deploy, Database, Code, Secrets */}
          <div
            role="toolbar"
            aria-label="Project tools"
            className="mt-2 w-full flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden touch-pan-x px-0.5 py-0.5 [-webkit-overflow-scrolling:touch]"
          >
            <button
              type="button"
              onClick={() => setActiveDrawer('deploy')}
              aria-label="Open project deployment panel"
              className={`shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-[11.5px] font-medium whitespace-nowrap transition-all active:scale-95 ${
                isPublished
                  ? 'border-[#7A68F6]/35 bg-[#F5F3FF] text-[#6D4AFF]'
                  : 'border-black/[0.08] bg-[#FAFAFC] text-[#3F3F46] hover:bg-black/[0.04] hover:text-[#0B0B0F]'
              }`}
            >
              <Rocket className="w-3.5 h-3.5 stroke-[1.9] shrink-0" />
              <span>Deploy</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveDrawer('database')}
              aria-label="Open project database and schema"
              className={`shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-[11.5px] font-medium whitespace-nowrap transition-all active:scale-95 ${
                databaseConfig.tables.length > 0
                  ? 'border-[#7A68F6]/35 bg-[#F5F3FF] text-[#6D4AFF]'
                  : 'border-black/[0.08] bg-[#FAFAFC] text-[#3F3F46] hover:bg-black/[0.04] hover:text-[#0B0B0F]'
              }`}
            >
              <Database className="w-3.5 h-3.5 stroke-[1.9] shrink-0" />
              <span>Database</span>
            </button>

            <button
              type="button"
              onClick={() => onSetView('code')}
              aria-label="Open built-in code viewer and live file editor"
              className={`shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-[11.5px] font-medium whitespace-nowrap transition-all active:scale-95 ${
                hasBuiltApp
                  ? 'border-[#7A68F6]/35 bg-[#F5F3FF] text-[#6D4AFF]'
                  : 'border-black/[0.08] bg-[#FAFAFC] text-[#3F3F46] hover:bg-black/[0.04] hover:text-[#0B0B0F]'
              }`}
            >
              <Code2 className="w-3.5 h-3.5 stroke-[1.9] shrink-0" />
              <span>Code</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveDrawer('secrets')}
              aria-label="Open project secrets and environment variables"
              className={`shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-[11.5px] font-medium whitespace-nowrap transition-all active:scale-95 ${
                secrets.length > 0
                  ? 'border-[#7A68F6]/35 bg-[#F5F3FF] text-[#6D4AFF]'
                  : 'border-black/[0.08] bg-[#FAFAFC] text-[#3F3F46] hover:bg-black/[0.04] hover:text-[#0B0B0F]'
              }`}
            >
              <KeyRound className="w-3.5 h-3.5 stroke-[1.9] shrink-0" />
              <span>Secrets</span>
            </button>
          </div>
        </div>
      </div>

      {/* Per-Project Configuration Drawers */}
      <ProjectSecretsModal
        open={activeDrawer === 'secrets'}
        mode={mode}
        projectTitle={projectTitle}
        secrets={secrets}
        onClose={() => setActiveDrawer(null)}
        onUpdateSecrets={onUpdateSecrets}
      />

      <ProjectDatabaseModal
        open={activeDrawer === 'database'}
        mode={mode}
        projectId={projectId}
        projectTitle={projectTitle}
        hasBuiltApp={hasBuiltApp}
        isStreaming={isStreaming}
        latestPreviewHtml={latestPreviewHtml}
        databaseConfig={databaseConfig}
        secrets={secrets}
        codeParts={codeParts}
        latestBuildFiles={latestBuiltTurn?.files ?? []}
        testMode={testMode}
        onApplyHtmlEdit={onUpdatePreviewHtml}
        onClose={() => setActiveDrawer(null)}
      />

      <ProjectDeployModal
        open={activeDrawer === 'deploy'}
        projectTitle={projectTitle}
        mode={mode}
        hasBuiltApp={hasBuiltApp}
        isPublished={isPublished}
        latestPreviewHtml={latestPreviewHtml}
        secrets={secrets}
        databaseConfig={databaseConfig}
        deployment={deployment}
        onClose={() => setActiveDrawer(null)}
        onDeploy={(opts) => onDeployProject(opts)}
        onOpenPreview={() => onSetView('preview')}
        onOpenCode={() => onSetView('code')}
        onShare={handleShare}
      />
    </div>
  );
}
