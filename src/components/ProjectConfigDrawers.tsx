import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileArchive,
  FileCode2,
  FolderTree,
  GitFork,
  Github,
  Globe,
  KeyRound,
  Lightbulb,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  Save,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import {
  BuildMode,
  MODE_THEMES,
  ProjectDatabaseColumn,
  ProjectDatabaseConfig,
  ProjectDatabaseTable,
  ProjectDeploymentConfig,
  ProjectSecret,
  SecretSaveResult,
} from '../types/craft';
import {
  applyFileEditToHtml,
  extractEditableCodeFiles,
} from '../utils/codeFileEditor';
import {
  buildProjectExportFiles,
  downloadProjectZip,
} from '../utils/projectExporter';

function slugifyProjectTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'aicraft-app'
  );
}

function normalizeSecretKey(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sanitizeTableName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeColumnType(
  rawType: string | undefined,
  colName: string
): ProjectDatabaseColumn['type'] {
  const t = (rawType || '').trim().toLowerCase();
  if (
    t === 'number' ||
    t === 'numeric' ||
    t === 'int' ||
    t === 'integer' ||
    t === 'float' ||
    t === 'decimal' ||
    t === 'bigint'
  ) {
    return 'number';
  }
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (
    t === 'timestamp' ||
    t === 'timestamptz' ||
    t === 'datetime' ||
    t === 'date'
  ) {
    return 'timestamp';
  }
  if (t === 'json' || t === 'jsonb' || t === 'array' || t === 'object') {
    return 'json';
  }
  if (t === 'text' || t === 'string' || t === 'varchar' || t === 'uuid') {
    return 'text';
  }
  if (
    colName === 'created_at' ||
    colName === 'updated_at' ||
    colName.endsWith('_at')
  ) {
    return 'timestamp';
  }
  if (
    colName === 'count' ||
    colName === 'amount' ||
    colName === 'price' ||
    colName === 'likes' ||
    colName === 'views' ||
    colName.endsWith('_count')
  ) {
    return 'number';
  }
  if (colName.startsWith('is_') || colName.startsWith('has_')) {
    return 'boolean';
  }
  return 'text';
}

function inferColumnTypeFromValue(
  val: unknown,
  colName: string
): ProjectDatabaseColumn['type'] {
  if (typeof val === 'number') return 'number';
  if (typeof val === 'boolean') return 'boolean';
  if (val !== null && typeof val === 'object') return 'json';
  return normalizeColumnType(undefined, colName);
}

function detectSchemaFromHtml(html: string): {
  tables: ProjectDatabaseTable[];
  storageKeys: string[];
} {
  if (!html) return { tables: [], storageKeys: [] };

  const tableMap = new Map<string, Map<string, ProjectDatabaseColumn>>();
  const ensureTable = (rawName: string) => {
    const clean = sanitizeTableName(rawName);
    if (!clean) return null;
    let colMap = tableMap.get(clean);
    if (!colMap) {
      colMap = new Map<string, ProjectDatabaseColumn>();
      tableMap.set(clean, colMap);
    }
    return colMap;
  };
  const addColumn = (
    colMap: Map<string, ProjectDatabaseColumn>,
    rawCol: string,
    rawType?: string
  ) => {
    const cleanCol = sanitizeTableName(rawCol);
    if (!cleanCol) return;
    if (!colMap.has(cleanCol)) {
      colMap.set(cleanCol, {
        name: cleanCol,
        type: normalizeColumnType(rawType, cleanCol),
        required: cleanCol === 'id',
      });
    }
  };

  // 1. Detect window.AICraft.db.<op>('table', { field1: ..., field2: ... })
  const dbCallRegex =
    /AICraft\.db\.\w+\(\s*['"`]([a-zA-Z0-9_-]+)['"`](?:\s*,\s*(?:['"`][^'"`]*['"`]\s*,\s*)?\{([\s\S]{0,400}?)\})?/g;
  for (const m of html.matchAll(dbCallRegex)) {
    const colMap = ensureTable(m[1] || '');
    if (!colMap) continue;
    addColumn(colMap, 'id', 'text');
    const objBody = m[2];
    if (objBody) {
      const propRegex = /(?:^|[,{])\s*['"]?([a-zA-Z_][a-zA-Z0-9_]*)['"]?\s*:/g;
      for (const p of objBody.matchAll(propRegex)) {
        if (p[1]) addColumn(colMap, p[1]);
      }
    }
    addColumn(colMap, 'created_at', 'timestamp');
  }

  // 2. Detect SQL CREATE TABLE definitions
  const sqlRegex =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]{1,800}?)\)/gi;
  for (const m of html.matchAll(sqlRegex)) {
    const colMap = ensureTable(m[1] || '');
    if (!colMap) continue;
    const colLines = (m[2] || '').split(',');
    for (const line of colLines) {
      const trimmed = line.trim();
      if (!trimmed || /^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(trimmed)) {
        continue;
      }
      const parts = trimmed.split(/\s+/);
      if (parts[0]) {
        addColumn(colMap, parts[0].replace(/["`]/g, ''), parts[1]);
      }
    }
  }

  // 3. Detect app-specific localStorage keys
  const storageKeys = new Set<string>();
  const lsRegex =
    /localStorage\.(?:getItem|setItem)\(\s*['"`]([a-zA-Z0-9_.:-]+)['"`]/g;
  for (const m of html.matchAll(lsRegex)) {
    if (m[1]) storageKeys.add(m[1]);
  }

  const tables: ProjectDatabaseTable[] = Array.from(tableMap.entries())
    .slice(0, 12)
    .map(([name, colMap]) => ({
      id: `detected-${name}`,
      name,
      columns: Array.from(colMap.values()),
    }));

  return {
    tables,
    storageKeys: Array.from(storageKeys).slice(0, 12),
  };
}

interface DrawerShellProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  mode?: BuildMode;
  variant?: 'sheet' | 'sleek';
  disableClose?: boolean;
  bodyScrollable?: boolean;
  children: React.ReactNode;
}

function DrawerShell({
  open,
  onClose,
  title,
  subtitle,
  icon,
  mode = 'mobile',
  variant = 'sheet',
  disableClose = false,
  bodyScrollable = true,
  children,
}: DrawerShellProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !disableClose) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose, disableClose]);

  if (!open) return null;

  const theme = MODE_THEMES[mode];
  const isMobileTheme = mode === 'mobile';
  const isSleek = variant === 'sleek';

  return (
    <div
      className={`fixed inset-0 z-[70] flex justify-center overflow-hidden ${
        isSleek
          ? 'items-end sm:items-center pt-20 pb-4 sm:py-8 px-4'
          : 'items-end sm:items-center'
      }`}
      onClick={() => {
        if (!disableClose) onClose();
      }}
    >
      {/* Luminous Home-style background with classical marble humans visible */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 bg-white/95 backdrop-blur-md"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-[62dvh]"
        style={{
          background: isMobileTheme
            ? 'radial-gradient(ellipse 90% 78% at 60% 18%, rgba(254, 240, 138, 0.72) 0%, rgba(254, 249, 195, 0.36) 46%, rgba(255, 255, 255, 0) 82%)'
            : 'radial-gradient(ellipse 90% 78% at 40% 18%, rgba(245, 208, 254, 0.72) 0%, rgba(250, 232, 255, 0.36) 46%, rgba(255, 255, 255, 0) 82%)',
        }}
      />

      {/* Home Background Human Sculptures Stage (clearly visible above & subtly framing the card) */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 flex justify-center overflow-hidden select-none"
      >
        <div className="relative w-full max-w-[440px] aspect-[750/488]">
          {[140, 215, 295].map((size, idx) => (
            <div
              key={size}
              className="animate-ring-breath absolute rounded-full border"
              style={{
                width: `${size}px`,
                height: `${size}px`,
                left: isMobileTheme ? '64%' : '36%',
                top: '40%',
                marginLeft: `-${size / 2}px`,
                marginTop: `-${size / 2}px`,
                borderColor: theme.ringColor,
                animationDelay: `${idx * 0.55}s`,
              }}
            />
          ))}
          <div
            className="w-full h-full overflow-hidden"
            style={{
              maskImage:
                'linear-gradient(to bottom, transparent 0%, black 10%, black 80%, transparent 100%)',
              WebkitMaskImage:
                'linear-gradient(to bottom, transparent 0%, black 10%, black 80%, transparent 100%)',
            }}
          >
            <img
              src={theme.artworkSrc}
              alt=""
              draggable={false}
              className="w-full h-auto max-w-none block opacity-95"
              style={{
                transform: 'translateY(-10%)',
              }}
            />
          </div>
        </div>
      </div>

      {/* Foreground Dialog Card / Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={
          isSleek
            ? 'relative z-10 w-full max-w-[348px] h-[72dvh] min-h-[450px] max-h-[680px] bg-white/92 backdrop-blur-xl rounded-[26px] border border-black/[0.12] shadow-[0_24px_64px_rgba(15,15,30,0.18)] flex flex-col overflow-hidden pb-safe'
            : 'relative z-10 w-full sm:max-w-[480px] max-h-[84dvh] bg-white/95 backdrop-blur-xl rounded-t-3xl sm:rounded-3xl border-t sm:border border-black/[0.1] shadow-[0_-10px_40px_rgba(15,15,30,0.14)] sm:shadow-[0_24px_64px_rgba(15,15,30,0.2)] flex flex-col overflow-hidden pb-safe'
        }
      >
        {!isSleek && (
          <div
            aria-hidden="true"
            className="w-10 h-1 rounded-full bg-black/15 mx-auto mt-2.5 sm:hidden shrink-0"
          />
        )}

        <div className="shrink-0 px-4 pt-3.5 pb-3 border-b border-black/[0.1] flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[#F4F4F6] text-[#0B0B0F] flex items-center justify-center shrink-0 border border-black/[0.06]">
              {icon}
            </div>
            <div className="min-w-0">
              <h2 className="font-display font-bold text-[16px] tracking-[-0.02em] text-[#0B0B0F] leading-tight">
                {title}
              </h2>
              <p className="text-[12px] text-[#52525B] truncate mt-0.5">
                {subtitle}
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={disableClose}
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="min-w-[44px] min-h-[44px] -mr-2 rounded-full flex items-center justify-center text-[#52525B] hover:bg-black/[0.05] disabled:opacity-40 active:scale-95 transition-all shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div
          className={`flex-1 min-h-0 ${
            bodyScrollable ? 'overflow-y-auto px-5 py-4' : 'flex flex-col overflow-hidden px-4 py-3.5'
          }`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Per-Project Secrets / Environment Variables Modal                       */
/* -------------------------------------------------------------------------- */

interface SecretDraftRow {
  id: string;
  key: string;
  value: string;
  updatedAt: string;
}

interface ProjectSecretsModalProps {
  open: boolean;
  mode?: BuildMode;
  projectTitle: string;
  secrets: ProjectSecret[];
  onClose: () => void;
  onUpdateSecrets: (next: ProjectSecret[]) => Promise<SecretSaveResult> | SecretSaveResult | void;
}

function makeBlankSecretRow(): SecretDraftRow {
  return {
    id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    key: '',
    value: '',
    updatedAt: new Date().toISOString(),
  };
}

export function ProjectSecretsModal({
  open,
  mode = 'mobile',
  projectTitle,
  secrets,
  onClose,
  onUpdateSecrets,
}: ProjectSecretsModalProps) {
  const [rows, setRows] = useState<SecretDraftRow[]>([]);
  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showShareInfo, setShowShareInfo] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const supportsTextSecurity = useMemo(() => {
    if (typeof window === 'undefined' || typeof CSS === 'undefined' || !CSS.supports) {
      return true;
    }
    return CSS.supports('-webkit-text-security', 'disc') || CSS.supports('text-security', 'disc');
  }, []);

  useEffect(() => {
    if (!open) {
      setShowShareInfo(false);
      setFeedback(null);
      setErrorMsg(null);
      setCopiedId(null);
      setIsSaving(false);
      setJustSaved(false);
      return;
    }
    setRows(
      secrets.length > 0
        ? secrets.map((s) => ({
            id: s.id,
            key: s.key,
            value: s.value,
            updatedAt: s.updatedAt,
          }))
        : [makeBlankSecretRow()]
    );
    setRevealedIds({});
    setFeedback(null);
    setErrorMsg(null);
    setJustSaved(false);
  }, [open, secrets]);

  useEffect(() => {
    if (!feedback) return;
    const t = window.setTimeout(() => setFeedback(null), 3200);
    return () => window.clearTimeout(t);
  }, [feedback]);

  useEffect(() => {
    if (!justSaved) return;
    const t = window.setTimeout(() => setJustSaved(false), 2000);
    return () => window.clearTimeout(t);
  }, [justSaved]);

  const handleRowChange = (id: string, field: 'key' | 'value', nextVal: string) => {
    setErrorMsg(null);
    setJustSaved(false);
    setRows((prev) =>
      prev.map((row) =>
        row.id === id
          ? {
              ...row,
              [field]: nextVal,
              updatedAt: new Date().toISOString(),
            }
          : row
      )
    );
  };

  const handleAddBlankRow = () => {
    if (isSaving) return;
    setErrorMsg(null);
    setJustSaved(false);
    setRows((prev) => [...prev, makeBlankSecretRow()]);
  };

  const handleDeleteRow = (id: string) => {
    if (isSaving) return;
    setErrorMsg(null);
    setJustSaved(false);
    setRows((prev) => {
      const remaining = prev.filter((r) => r.id !== id);
      return remaining.length > 0 ? remaining : [makeBlankSecretRow()];
    });
  };

  const handleCopyValue = async (row: SecretDraftRow) => {
    if (!row.value) return;
    try {
      await navigator.clipboard.writeText(row.value);
      setCopiedId(row.id);
      window.setTimeout(() => setCopiedId((curr) => (curr === row.id ? null : curr)), 1600);
    } catch {
      // ignore clipboard restriction
    }
  };

  const handleApplyChanges = async () => {
    if (isSaving) return;
    setErrorMsg(null);
    setFeedback(null);
    setJustSaved(false);

    const cleanedRows: ProjectSecret[] = [];
    const seenKeys = new Set<string>();

    for (const row of rows) {
      const rawKey = row.key.trim();
      const rawValue = row.value.trim();
      if (!rawKey && !rawValue) {
        continue;
      }
      const normalizedKey = normalizeSecretKey(rawKey);
      if (!normalizedKey) {
        setErrorMsg('Enter a valid secret name (e.g. OPENAI_API_KEY) for every filled row.');
        return;
      }
      if (!rawValue) {
        setErrorMsg(`Enter a secret value for ${normalizedKey}.`);
        return;
      }
      const nextSecret: ProjectSecret = {
        id: row.id,
        key: normalizedKey,
        value: rawValue,
        updatedAt: new Date().toISOString(),
      };
      if (seenKeys.has(normalizedKey)) {
        const idx = cleanedRows.findIndex((s) => s.key === normalizedKey);
        if (idx !== -1) cleanedRows[idx] = nextSecret;
      } else {
        seenKeys.add(normalizedKey);
        cleanedRows.push(nextSecret);
      }
    }

    setIsSaving(true);
    try {
      const [saveResult] = await Promise.all([
        Promise.resolve(onUpdateSecrets(cleanedRows)),
        new Promise<void>((resolve) => window.setTimeout(resolve, 350)),
      ]);

      if (saveResult && saveResult.ok === false) {
        setErrorMsg(saveResult.message || 'Unable to save secrets right now.');
        return;
      }

      setRows(cleanedRows.length > 0 ? cleanedRows : [makeBlankSecretRow()]);
      setJustSaved(true);

      if (saveResult?.message) {
        setFeedback(saveResult.message);
      } else {
        setFeedback(
          cleanedRows.length === 0
            ? `Cleared and saved all secrets for ${projectTitle}.`
            : `Saved ${cleanedRows.length} ${cleanedRows.length === 1 ? 'secret' : 'secrets'} to ${projectTitle}.`
        );
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to save changes. Please try again.'
      );
    } finally {
      setIsSaving(false);
    }
  };

  const configuredCount = rows.filter((r) => r.key.trim() || r.value.trim()).length;

  return (
    <DrawerShell
      open={open}
      onClose={onClose}
      mode={mode}
      variant="sleek"
      disableClose={isSaving}
      bodyScrollable={false}
      title="Secrets"
      subtitle={`Scoped to ${projectTitle}`}
      icon={<KeyRound className="w-[18px] h-[18px] text-[#6D4AFF]" />}
    >
      <div className="flex-1 min-h-0 flex flex-col gap-3">
        {/* Scrollable Sleek Vertical Keys Viewport */}
        <div className="flex-1 min-h-[160px] overflow-y-auto overscroll-y-contain pr-1 flex flex-col gap-3">
          {rows.map((row, idx) => {
            const isRevealed = Boolean(revealedIds[row.id]);
            const isCopied = copiedId === row.id;
            return (
              <div
                key={row.id}
                className="rounded-2xl border border-black/[0.12] bg-white px-3 pt-2.5 pb-3 flex flex-col gap-2 shadow-[0_2px_10px_rgba(11,11,15,0.04)]"
              >
                {/* Row Header: Secret Name + Action Controls */}
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={row.key}
                    disabled={isSaving}
                    onChange={(e) => handleRowChange(row.id, 'key', e.target.value)}
                    placeholder={`SECRET_${idx + 1}_KEY`}
                    aria-label="Secret name"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    className="flex-1 min-w-0 h-10 px-2.5 rounded-xl border border-black/[0.12] bg-[#FAFAFC] font-mono text-[12px] font-semibold tracking-wide text-[#0B0B0F] placeholder:text-[#71717A] focus:outline-none focus:border-[#0B0B0F] focus:bg-white disabled:opacity-60"
                  />

                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() =>
                      setRevealedIds((prev) => ({
                        ...prev,
                        [row.id]: !prev[row.id],
                      }))
                    }
                    aria-label={isRevealed ? 'Hide secret value' : 'Reveal secret value'}
                    className="min-w-[40px] min-h-[40px] rounded-xl flex items-center justify-center text-[#3F3F46] hover:bg-black/[0.05] hover:text-[#0B0B0F] disabled:opacity-40 shrink-0 transition-colors"
                  >
                    {isRevealed ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>

                  <button
                    type="button"
                    disabled={!row.value || isSaving}
                    onClick={() => void handleCopyValue(row)}
                    aria-label="Copy secret value"
                    className="min-w-[40px] min-h-[40px] rounded-xl flex items-center justify-center text-[#3F3F46] hover:bg-black/[0.05] hover:text-[#0B0B0F] disabled:opacity-35 shrink-0 transition-colors"
                  >
                    {isCopied ? (
                      <Check className="w-4 h-4 text-[#6D4AFF]" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </button>

                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() => handleDeleteRow(row.id)}
                    aria-label="Delete secret row"
                    className="min-w-[40px] min-h-[40px] rounded-xl flex items-center justify-center text-[#52525B] hover:bg-red-50 hover:text-red-600 disabled:opacity-40 shrink-0 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Tall, Sleek Scrollable Key Paste Area + Bold Visible Black Line */}
                <div className="flex flex-col">
                  {supportsTextSecurity || isRevealed ? (
                    <textarea
                      rows={3}
                      value={row.value}
                      disabled={isSaving}
                      onChange={(e) => handleRowChange(row.id, 'value', e.target.value)}
                      placeholder="Paste API key or secret value..."
                      aria-label="Secret value"
                      autoCorrect="off"
                      autoComplete="off"
                      spellCheck={false}
                      className={`w-full min-h-[84px] max-h-[126px] px-3 py-2.5 rounded-t-xl rounded-b-none border border-b-0 border-black/[0.12] bg-[#FAFAFC] font-mono text-[12px] leading-relaxed text-[#0B0B0F] placeholder:text-[#71717A] resize-none overflow-y-auto focus:outline-none focus:bg-white disabled:opacity-60 ${
                        !isRevealed && row.value ? 'secret-masked' : ''
                      }`}
                    />
                  ) : (
                    <input
                      type="password"
                      value={row.value}
                      disabled={isSaving}
                      onChange={(e) => handleRowChange(row.id, 'value', e.target.value)}
                      placeholder="Paste API key or secret value..."
                      aria-label="Secret value"
                      autoCorrect="off"
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full h-14 px-3 rounded-t-xl rounded-b-none border border-b-0 border-black/[0.12] bg-[#FAFAFC] font-mono text-[12.5px] text-[#0B0B0F] placeholder:text-[#71717A] focus:outline-none focus:bg-white disabled:opacity-60"
                    />
                  )}
                  {/* Crisp high-contrast black line following the key box */}
                  <div aria-hidden="true" className="h-[2.5px] w-full bg-[#0B0B0F] rounded-b-sm" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Crisp Black Divider Rule Separating Keys Viewport & Actions */}
        <div aria-hidden="true" className="shrink-0 h-[1.5px] w-full bg-[#0B0B0F]/85 rounded-full" />

        {/* Controls Footer (Always visible while scrolling keys above) */}
        <div className="shrink-0 flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={isSaving}
              onClick={handleAddBlankRow}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-3.5 rounded-xl border border-black/[0.14] bg-white hover:bg-[#F7F7FA] text-[13px] font-medium text-[#0B0B0F] disabled:opacity-50 active:scale-[0.98] transition-all"
            >
              <Plus className="w-4 h-4 text-[#6D4AFF]" />
              <span>Add secret</span>
            </button>

            <span className="text-[12px] font-medium text-[#52525B] tabular-nums">
              {configuredCount} configured
            </span>
          </div>

          {errorMsg && (
            <p
              role="alert"
              className="px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700 text-[12px] font-medium"
            >
              {errorMsg}
            </p>
          )}

          {feedback && (
            <p
              role="status"
              className="px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-[12px] font-medium flex items-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5 shrink-0" />
              <span>{feedback}</span>
            </p>
          )}

          <div className="rounded-xl border border-black/[0.09] bg-[#FAFAFC] px-3 py-2 flex flex-col gap-1.5">
            <div className="flex items-start gap-2">
              <Lightbulb className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-[11.5px] leading-snug text-[#18181B]">
                How are secrets handled when sharing?{' '}
                <button
                  type="button"
                  onClick={() => setShowShareInfo((v) => !v)}
                  className="font-semibold text-[#6D4AFF] hover:underline"
                >
                  {showShareInfo ? 'Hide details' : 'Learn more'}
                </button>
              </p>
            </div>
            {showShareInfo && (
              <p className="pl-5 text-[11px] leading-relaxed text-[#52525B]">
                Secrets stay isolated to <span className="font-medium text-[#0B0B0F]">{projectTitle}</span> and
                inject automatically via{' '}
                <code className="font-mono text-[#3F3F46]">window.AICraft.getSecret(&quot;KEY&quot;)</code>{' '}
                without exposing private credentials on public links.
              </p>
            )}
          </div>

          <button
            type="button"
            disabled={isSaving}
            onClick={() => void handleApplyChanges()}
            className={`w-full min-h-[46px] rounded-xl text-white text-[13.5px] font-semibold flex items-center justify-center gap-2 transition-all active:scale-[0.99] disabled:cursor-wait ${
              justSaved
                ? 'bg-emerald-600 hover:bg-emerald-700 shadow-[0_4px_14px_rgba(5,150,105,0.28)]'
                : 'bg-[#6D4AFF] hover:bg-[#5B35F5] disabled:bg-[#8B71FF] shadow-[0_4px_14px_rgba(109,74,255,0.28)]'
            }`}
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Saving changes...</span>
              </>
            ) : justSaved ? (
              <>
                <Check className="w-4 h-4" />
                <span>Changes saved</span>
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                <span>Apply changes</span>
              </>
            )}
          </button>
        </div>
      </div>
    </DrawerShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Per-Project Automatic Real-Time Structured Database Explorer            */
/* -------------------------------------------------------------------------- */

interface ProjectDatabaseModalProps {
  open: boolean;
  initialTab?: 'database' | 'files';
  mode?: BuildMode;
  projectId: string;
  projectTitle: string;
  hasBuiltApp: boolean;
  isStreaming: boolean;
  latestPreviewHtml: string;
  databaseConfig: ProjectDatabaseConfig;
  secrets?: ProjectSecret[];
  codeParts?: Array<{ id: string; label: string; content: string }>;
  latestBuildFiles?: string[];
  testMode?: boolean;
  onApplyHtmlEdit?: (nextHtml: string) => void | Promise<void>;
  onClose: () => void;
}

interface RealTimeBuiltFile {
  path: string;
  label: string;
  content: string;
  kind: 'code' | 'database' | 'screen';
  editable: boolean;
  lineCount: number;
  bytes: number;
}

export function ProjectDatabaseModal({
  open,
  initialTab,
  mode = 'mobile',
  projectId,
  projectTitle,
  hasBuiltApp,
  isStreaming,
  latestPreviewHtml,
  databaseConfig,
  secrets = [],
  codeParts = [],
  testMode = false,
  onApplyHtmlEdit,
  onClose,
}: ProjectDatabaseModalProps) {
  const [activeTab, setActiveTab] = useState<'database' | 'files'>(initialTab || 'database');
  const [copiedSqlId, setCopiedSqlId] = useState<string | null>(null);
  const [copiedFilePath, setCopiedFilePath] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string>('index.html');
  const [editingFilePath, setEditingFilePath] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<string>('');
  const [editError, setEditError] = useState<string | null>(null);
  const [collapsedTables, setCollapsedTables] = useState<Record<string, boolean>>({});
  const [addingRowTable, setAddingRowTable] = useState<string | null>(null);
  const [newRowDraft, setNewRowDraft] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<string | null>(null);
  const [dataRefreshTick, setDataRefreshTick] = useState(0);
  const [serverTablesMap, setServerTablesMap] = useState<
    Record<string, Record<string, unknown>[]>
  >({});
  const [serverStorageMode, setServerStorageMode] = useState<'supabase' | 'disk' | 'tmp' | null>(
    null
  );
  const [syncingDb, setSyncingDb] = useState(false);

  const effectiveDbAppId = testMode ? `${projectId}__test` : projectId;

  const syncServerDb = useCallback(async () => {
    if (!effectiveDbAppId) return;
    setSyncingDb(true);
    try {
      const res = await fetch(
        `/api/app-data/${encodeURIComponent(effectiveDbAppId)}`,
        { cache: 'no-store' }
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        ok?: boolean;
        tables?: Record<string, Record<string, unknown>[]>;
        storageMode?: 'supabase' | 'disk' | 'tmp';
      };
      if (data.ok && data.tables && typeof data.tables === 'object') {
        setServerTablesMap(data.tables);
        if (data.storageMode) setServerStorageMode(data.storageMode);
        try {
          for (const [tblName, rows] of Object.entries(data.tables)) {
            const clean = sanitizeTableName(tblName);
            if (!clean || !Array.isArray(rows)) continue;
            window.localStorage.setItem(
              `aicraft_db_${effectiveDbAppId}_${clean}`,
              JSON.stringify(rows)
            );
          }
        } catch {
          // ignore localStorage mirror errors
        }
      }
    } catch {
      // keep existing snapshot if temporarily offline
    } finally {
      setSyncingDb(false);
    }
  }, [effectiveDbAppId]);

  useEffect(() => {
    if (open && initialTab) {
      setActiveTab(initialTab);
    }
    if (!open) {
      setEditingFilePath(null);
      setEditError(null);
    }
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    void syncServerDb();
    setDataRefreshTick((n) => n + 1);
    const handleDbUpdate = (evt: Event) => {
      const detail = (evt as CustomEvent<{ projectId?: string; effectiveDbAppId?: string }>)
        .detail;
      if (
        !detail?.projectId ||
        detail.projectId === projectId ||
        detail.effectiveDbAppId === effectiveDbAppId
      ) {
        setDataRefreshTick((n) => n + 1);
        void syncServerDb();
      }
    };
    const handleStorage = () => {
      setDataRefreshTick((n) => n + 1);
    };
    window.addEventListener('aicraft:db-updated', handleDbUpdate);
    window.addEventListener('storage', handleStorage);
    const poll = window.setInterval(() => {
      setDataRefreshTick((n) => n + 1);
    }, 1500);
    return () => {
      window.removeEventListener('aicraft:db-updated', handleDbUpdate);
      window.removeEventListener('storage', handleStorage);
      window.clearInterval(poll);
    };
  }, [open, projectId, effectiveDbAppId, syncServerDb]);

  useEffect(() => {
    if (!feedback) return;
    const t = window.setTimeout(() => setFeedback(null), 2400);
    return () => window.clearTimeout(t);
  }, [feedback]);

  const detected = useMemo(
    () => detectSchemaFromHtml(latestPreviewHtml),
    [latestPreviewHtml]
  );

  const hasSupabaseConfigured = useMemo(
    () =>
      secrets.some(
        (s) =>
          s.value.trim().length > 0 &&
          (/supabase/i.test(s.key) || /^https:\/\/[a-z0-9-]+\.supabase\.co/i.test(s.value))
      ),
    [secrets]
  );

  const liveStoredMap = useMemo(() => {
    const map = new Map<string, { storageKey: string; rows: Record<string, unknown>[] }>();
    if (!open) return map;
    const prefix = `aicraft_db_${effectiveDbAppId}_`;

    // Real backend file/cloud rows first
    for (const [tblName, rows] of Object.entries(serverTablesMap)) {
      const cleanName = sanitizeTableName(tblName);
      if (!cleanName || !Array.isArray(rows)) continue;
      map.set(cleanName, {
        storageKey: `${prefix}${cleanName}`,
        rows: rows.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item && typeof item === 'object' && !Array.isArray(item))
        ),
      });
    }

    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (!key) continue;

        let tableName = '';
        if (key.startsWith(prefix)) {
          tableName = sanitizeTableName(key.slice(prefix.length));
        } else if (!testMode && detected.storageKeys.includes(key)) {
          tableName = sanitizeTableName(key);
        } else {
          continue;
        }

        if (!tableName) continue;
        // Prefer live server table snapshot when already fetched unless server table is empty while local has rows
        const existingServer = map.get(tableName);
        if (existingServer && existingServer.rows.length > 0) continue;

        const raw = window.localStorage.getItem(key);
        let parsed: unknown = [];
        try {
          parsed = raw ? JSON.parse(raw) : [];
        } catch {
          parsed = raw ? [{ value: raw }] : [];
        }
        const rawArray = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object'
            ? [parsed]
            : [];
        const normalizedRows = rawArray.map((item, idx) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? (item as Record<string, unknown>)
            : { id: `row_${idx + 1}`, value: item }
        );
        if (!existingServer || normalizedRows.length > 0) {
          map.set(tableName, { storageKey: key, rows: normalizedRows });
        }
      }
    } catch {
      // ignore localStorage read failure
    }
    return map;
  }, [open, effectiveDbAppId, testMode, detected.storageKeys, serverTablesMap, dataRefreshTick]);

  const structuredTables = useMemo(() => {
    const merged = new Map<string, ProjectDatabaseTable>();

    const upsertTable = (table: ProjectDatabaseTable) => {
      const cleanName = sanitizeTableName(table.name);
      if (!cleanName) return;
      const existing = merged.get(cleanName);
      if (!existing) {
        merged.set(cleanName, {
          ...table,
          name: cleanName,
          columns: [...table.columns],
        });
        return;
      }
      const colNames = new Set(existing.columns.map((c) => c.name));
      for (const col of table.columns) {
        if (!colNames.has(col.name)) {
          colNames.add(col.name);
          existing.columns.push(col);
        }
      }
    };

    for (const tbl of databaseConfig.tables) {
      upsertTable(tbl);
    }
    for (const tbl of detected.tables) {
      upsertTable(tbl);
    }
    for (const [tableName, store] of liveStoredMap.entries()) {
      const inferredCols: ProjectDatabaseColumn[] = [];
      const seenCols = new Set<string>();
      for (const row of store.rows.slice(0, 12)) {
        for (const [k, v] of Object.entries(row)) {
          const cleanCol = sanitizeTableName(k);
          if (!cleanCol || seenCols.has(cleanCol)) continue;
          seenCols.add(cleanCol);
          inferredCols.push({
            name: cleanCol,
            type: inferColumnTypeFromValue(v, cleanCol),
            required: cleanCol === 'id',
          });
        }
      }
      upsertTable({
        id: `live-${tableName}`,
        name: tableName,
        columns:
          inferredCols.length > 0
            ? inferredCols
            : [
                { name: 'id', type: 'text', required: true },
                { name: 'created_at', type: 'timestamp' },
              ],
      });
    }

    return Array.from(merged.values());
  }, [databaseConfig.tables, detected.tables, liveStoredMap]);

  const totalLiveRows = useMemo(() => {
    let count = 0;
    for (const store of liveStoredMap.values()) {
      count += store.rows.length;
    }
    return count;
  }, [liveStoredMap]);

  const buildCreateSql = (table: ProjectDatabaseTable): string => {
    const colLines = table.columns.map((c) => {
      const sqlType =
        c.type === 'number'
          ? 'NUMERIC'
          : c.type === 'boolean'
            ? 'BOOLEAN DEFAULT false'
            : c.type === 'timestamp'
              ? 'TIMESTAMPTZ DEFAULT now()'
              : c.type === 'json'
                ? 'JSONB DEFAULT \'{}\'::jsonb'
                : c.name === 'id'
                  ? 'TEXT PRIMARY KEY'
                  : 'TEXT';
      return `  ${c.name} ${sqlType}`;
    });
    return `CREATE TABLE IF NOT EXISTS ${table.name} (\n${colLines.join(',\n')}\n);`;
  };

  const builtFiles = useMemo<RealTimeBuiltFile[]>(() => {
    const list: RealTimeBuiltFile[] = [];
    const seen = new Set<string>();
    const pushFile = (
      path: string,
      content: string,
      kind: RealTimeBuiltFile['kind'],
      editable: boolean
    ) => {
      if (!path || seen.has(path)) return;
      seen.add(path);
      const clean = content || '';
      list.push({
        path,
        label: path,
        content: clean,
        kind,
        editable,
        lineCount: clean ? clean.split('\n').length : 0,
        bytes: clean.length,
      });
    };

    if (latestPreviewHtml.trim()) {
      for (const ef of extractEditableCodeFiles(latestPreviewHtml)) {
        if (ef.content.trim()) {
          pushFile(
            ef.id,
            ef.content,
            ef.kind === 'screen' ? 'screen' : 'code',
            ef.editable
          );
        }
      }
    } else {
      for (const part of codeParts) {
        if (part.content) {
          pushFile(part.id, part.content, 'code', true);
        }
      }
    }

    if (structuredTables.length > 0) {
      const fullSql = structuredTables.map((t) => buildCreateSql(t)).join('\n\n');
      pushFile('database/schema.sql', fullSql, 'database', false);

      const snapshotObj: Record<string, Record<string, unknown>[]> = {};
      for (const tbl of structuredTables) {
        snapshotObj[tbl.name] = liveStoredMap.get(tbl.name)?.rows ?? [];
      }
      pushFile('database/records.json', JSON.stringify(snapshotObj, null, 2), 'database', false);
    }

    return list;
  }, [codeParts, structuredTables, liveStoredMap, latestPreviewHtml]);

  const activeFile = useMemo(
    () => builtFiles.find((f) => f.path === selectedFilePath) || builtFiles[0] || null,
    [builtFiles, selectedFilePath]
  );

  const isEditingActiveFile =
    Boolean(activeFile && editingFilePath === activeFile.path && activeFile.editable);

  const handleStartEditFile = (file: RealTimeBuiltFile) => {
    if (!file.editable || isStreaming) return;
    setEditError(null);
    setEditDraft(file.content);
    setEditingFilePath(file.path);
  };

  const handleApplyFileEdit = async () => {
    if (!activeFile || !latestPreviewHtml || !onApplyHtmlEdit) return;
    const result = applyFileEditToHtml(latestPreviewHtml, activeFile.path, editDraft);
    if (!result.ok) {
      setEditError(result.error);
      return;
    }
    setEditError(null);
    await onApplyHtmlEdit(result.html);
    setEditingFilePath(null);
    setFeedback(`Saved ${activeFile.label} and updated live Preview.`);
  };

  const handleCopySql = async (table: ProjectDatabaseTable) => {
    try {
      await navigator.clipboard.writeText(buildCreateSql(table));
      setCopiedSqlId(table.id);
      window.setTimeout(() => setCopiedSqlId(null), 1800);
    } catch {
      // ignore clipboard restriction
    }
  };

  const handleCopyFile = async (file: RealTimeBuiltFile) => {
    try {
      await navigator.clipboard.writeText(file.content);
      setCopiedFilePath(file.path);
      window.setTimeout(() => setCopiedFilePath(null), 1800);
    } catch {
      // ignore clipboard restriction
    }
  };

  const handleDeleteRow = async (
    tableName: string,
    storageKey: string,
    rowId: unknown,
    rowIndex: number
  ) => {
    try {
      const store = liveStoredMap.get(tableName);
      if (!store) return;
      const targetId =
        rowId !== undefined && rowId !== null ? String(rowId) : '';
      const nextRows = store.rows.filter((r, idx) =>
        targetId ? String(r.id ?? '') !== targetId : idx !== rowIndex
      );
      window.localStorage.setItem(storageKey, JSON.stringify(nextRows));
      setServerTablesMap((prev) => ({ ...prev, [tableName]: nextRows }));
      setDataRefreshTick((n) => n + 1);

      if (targetId) {
        await fetch(
          `/api/app-data/${encodeURIComponent(effectiveDbAppId)}/${encodeURIComponent(
            tableName
          )}/${encodeURIComponent(targetId)}`,
          { method: 'DELETE' }
        ).catch(() => null);
      }

      window.dispatchEvent(
        new CustomEvent('aicraft:db-updated', {
          detail: { projectId, effectiveDbAppId, table: tableName },
        })
      );
      setFeedback(`Deleted record from "${tableName}" on server DB.`);
    } catch {
      // ignore storage error
    }
  };

  const handleInsertRow = async (table: ProjectDatabaseTable) => {
    const storageKey =
      liveStoredMap.get(table.name)?.storageKey ||
      `aicraft_db_${effectiveDbAppId}_${table.name}`;
    try {
      const existing = liveStoredMap.get(table.name)?.rows ?? [];
      const row: Record<string, unknown> = {
        id: `row_${Date.now().toString(36)}`,
        created_at: new Date().toISOString(),
      };
      for (const col of table.columns) {
        if (col.name === 'id' || col.name === 'created_at') continue;
        const rawVal = (newRowDraft[col.name] ?? '').trim();
        if (!rawVal) continue;
        if (col.type === 'number') {
          const num = Number(rawVal);
          row[col.name] = Number.isFinite(num) ? num : 0;
        } else if (col.type === 'boolean') {
          row[col.name] = rawVal.toLowerCase() === 'true' || rawVal === '1';
        } else {
          row[col.name] = rawVal;
        }
      }

      let savedRow = row;
      try {
        const res = await fetch(
          `/api/app-data/${encodeURIComponent(effectiveDbAppId)}/${encodeURIComponent(
            table.name
          )}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ row }),
          }
        );
        if (res.ok) {
          const json = (await res.json()) as {
            ok?: boolean;
            row?: Record<string, unknown>;
          };
          if (json.ok && json.row) savedRow = json.row;
        }
      } catch {
        // keep optimistic local copy if offline
      }

      const nextRows = [
        savedRow,
        ...existing.filter((r) => String(r.id ?? '') !== String(savedRow.id ?? '')),
      ];
      window.localStorage.setItem(storageKey, JSON.stringify(nextRows));
      setServerTablesMap((prev) => ({ ...prev, [table.name]: nextRows }));
      setAddingRowTable(null);
      setNewRowDraft({});
      setDataRefreshTick((n) => n + 1);
      window.dispatchEvent(
        new CustomEvent('aicraft:db-updated', {
          detail: { projectId, effectiveDbAppId, table: table.name },
        })
      );
      setFeedback(`Saved record to "${table.name}" on real backend DB.`);
    } catch {
      // ignore storage error
    }
  };

  const handleClearTableRows = async (tableName: string, storageKey: string) => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([]));
      setServerTablesMap((prev) => ({ ...prev, [tableName]: [] }));
      setDataRefreshTick((n) => n + 1);
      await fetch(
        `/api/app-data/${encodeURIComponent(effectiveDbAppId)}/${encodeURIComponent(
          tableName
        )}`,
        { method: 'DELETE' }
      ).catch(() => null);
      window.dispatchEvent(
        new CustomEvent('aicraft:db-updated', {
          detail: { projectId, effectiveDbAppId, table: tableName },
        })
      );
      setFeedback(`Cleared records in "${tableName}" on server DB.`);
    } catch {
      // ignore storage error
    }
  };

  return (
    <DrawerShell
      open={open}
      onClose={onClose}
      mode={mode}
      title="Database & Files"
      subtitle={`Real-time app data & source files · ${projectTitle}`}
      icon={<Database className="w-[18px] h-[18px] text-[#6D4AFF]" />}
    >
      <div className="flex flex-col gap-3.5">
        {/* Real-Time Database vs Files Option Tabs */}
        <div
          role="tablist"
          aria-label="Inspector sections"
          className="grid grid-cols-2 gap-1.5 p-1 rounded-2xl bg-[#F4F4F6] border border-black/[0.06]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'database'}
            onClick={() => setActiveTab('database')}
            className={`min-h-[38px] px-3 rounded-xl text-[12.5px] font-semibold flex items-center justify-center gap-1.5 transition-all ${
              activeTab === 'database'
                ? 'bg-white text-[#0B0B0F] shadow-[0_1px_4px_rgba(11,11,15,0.08)]'
                : 'text-[#52525B] hover:text-[#0B0B0F]'
            }`}
          >
            <Database className="w-3.5 h-3.5 text-[#6D4AFF] shrink-0" />
            <span>Database</span>
            <span className="text-[11px] font-mono text-[#71717A] tabular-nums">
              ({structuredTables.length})
            </span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'files'}
            onClick={() => setActiveTab('files')}
            className={`min-h-[38px] px-3 rounded-xl text-[12.5px] font-semibold flex items-center justify-center gap-1.5 transition-all ${
              activeTab === 'files'
                ? 'bg-white text-[#0B0B0F] shadow-[0_1px_4px_rgba(11,11,15,0.08)]'
                : 'text-[#52525B] hover:text-[#0B0B0F]'
            }`}
          >
            <FolderTree className="w-3.5 h-3.5 text-[#6D4AFF] shrink-0" />
            <span>Files</span>
            <span className="text-[11px] font-mono text-[#71717A] tabular-nums">
              ({builtFiles.length})
            </span>
          </button>
        </div>

        {feedback && (
          <p
            role="status"
            className="px-3 py-2 rounded-xl bg-[#F3F0FF] text-[#5B21B6] text-[12.5px] font-medium"
          >
            {feedback}
          </p>
        )}

        {activeTab === 'database' ? (
          structuredTables.length === 0 ? (
            <div className="py-8 px-5 rounded-2xl bg-[#FAFAFC] border border-black/[0.06] text-center flex flex-col items-center gap-2.5">
              <div className="w-11 h-11 rounded-2xl bg-[#F3F0FF] text-[#6D4AFF] flex items-center justify-center">
                <Database className="w-5 h-5" />
              </div>
              <p className="text-[14px] font-semibold text-[#0B0B0F]">
                {isStreaming
                  ? 'Designing database tables...'
                  : 'No database built yet'}
              </p>
              <p className="text-[12.5px] text-[#71717A] leading-relaxed max-w-[320px]">
                {isStreaming
                  ? 'As AI Craft engineers your app, structured tables, columns, and starter records appear here in real time.'
                  : hasBuiltApp
                    ? 'This app does not define structured tables yet. Ask the AI to store real data (users, items, bookings, messages) and tables appear here live.'
                    : 'Ask AI Craft to build an app first. Every table and record the AI builds streams here in real time.'}
              </p>
            </div>
          ) : (
            <>
              {/* Live Database Connection & Summary Bar */}
              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-2xl bg-[#FAFAFC] border border-black/[0.06]">
                <div className="min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      aria-hidden="true"
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        isStreaming || syncingDb
                          ? 'bg-[#6D4AFF] animate-pulse'
                          : 'bg-emerald-500'
                      }`}
                    />
                    <span className="text-[12.5px] font-semibold text-[#0B0B0F] tabular-nums truncate">
                      {structuredTables.length}{' '}
                      {structuredTables.length === 1 ? 'table' : 'tables'} ·{' '}
                      {totalLiveRows} {totalLiveRows === 1 ? 'record' : 'records'}
                      {testMode ? ' · Test Mode DB' : ''}
                    </span>
                  </div>
                  <span className="text-[11px] text-[#71717A] truncate pl-4">
                    {serverStorageMode === 'supabase' || hasSupabaseConfigured
                      ? `Connected to Real Supabase + Server File DB${testMode ? ' (Test Sandbox)' : ''}`
                      : serverStorageMode === 'disk'
                        ? `Real Server File DB (.aicraft-data)${testMode ? ' · Isolated Test Store' : ' · Persistent'}`
                        : `Real Server Backend DB (/api/app-data)${testMode ? ' · Isolated Test Store' : ''}`}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    void syncServerDb();
                    setDataRefreshTick((n) => n + 1);
                  }}
                  className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-black/[0.08] bg-white hover:bg-black/[0.03] text-[12px] font-medium text-[#3F3F46] active:scale-95 transition-all shrink-0"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 text-[#6D4AFF] ${syncingDb ? 'animate-spin' : ''}`}
                  />
                  <span>Sync</span>
                </button>
              </div>

              {/* Structured Database Tables */}
              <div className="flex flex-col gap-3">
                {structuredTables.map((table) => {
                  const store = liveStoredMap.get(table.name);
                  const storageKey =
                    store?.storageKey || `aicraft_db_${effectiveDbAppId}_${table.name}`;
                  const rows = store?.rows ?? [];
                  const isCollapsed = Boolean(collapsedTables[table.name]);
                  const isAdding = addingRowTable === table.name;
                  const editableCols = table.columns.filter(
                    (c) => c.name !== 'id' && c.name !== 'created_at'
                  );

                  return (
                    <div
                      key={table.id}
                      className="rounded-2xl border border-black/[0.08] bg-white overflow-hidden"
                    >
                      <div className="px-3.5 py-2.5 bg-[#FAFAFC] border-b border-black/[0.06] flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsedTables((prev) => ({
                              ...prev,
                              [table.name]: !prev[table.name],
                            }))
                          }
                          className="flex items-center gap-2 min-w-0 text-left flex-1"
                        >
                          {isCollapsed ? (
                            <ChevronRight className="w-4 h-4 text-[#71717A] shrink-0" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-[#71717A] shrink-0" />
                          )}
                          <span className="font-mono text-[13px] font-semibold text-[#0B0B0F] truncate">
                            {table.name}
                          </span>
                          <span className="text-[11.5px] text-[#71717A] tabular-nums whitespace-nowrap">
                            {table.columns.length} cols · {rows.length}{' '}
                            {rows.length === 1 ? 'row' : 'rows'}
                          </span>
                        </button>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setAddingRowTable(isAdding ? null : table.name);
                              setNewRowDraft({});
                            }}
                            className="h-7 px-2 rounded-lg border border-black/[0.08] bg-white text-[11px] font-medium text-[#6D4AFF] hover:bg-[#F3F0FF] flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" />
                            <span>Row</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => void handleCopySql(table)}
                            className="h-7 px-2 rounded-lg border border-black/[0.08] bg-white text-[11px] font-medium text-[#3F3F46] hover:bg-black/[0.03] flex items-center gap-1"
                          >
                            {copiedSqlId === table.id ? (
                              <>
                                <Check className="w-3 h-3 text-[#6D4AFF]" />
                                <span>SQL</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                <span>SQL</span>
                              </>
                            )}
                          </button>

                          {rows.length > 0 && store && (
                            <button
                              type="button"
                              onClick={() =>
                                handleClearTableRows(table.name, storageKey)
                              }
                              aria-label={`Clear ${table.name} records`}
                              className="h-7 px-2 rounded-lg text-[11px] font-medium text-red-600 hover:bg-red-50"
                            >
                              Clear
                            </button>
                          )}
                        </div>
                      </div>

                      {!isCollapsed && (
                        <div className="flex flex-col divide-y divide-black/[0.06]">
                          {/* Columns Structure */}
                          <div className="p-3 bg-white">
                            <div className="flex flex-wrap gap-1.5">
                              {table.columns.map((col) => (
                                <div
                                  key={`${table.name}-${col.name}`}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#F7F7FA] border border-black/[0.06]"
                                >
                                  <span className="font-mono text-[11.5px] font-medium text-[#0B0B0F]">
                                    {col.name}
                                  </span>
                                  <span className="text-[10.5px] font-mono text-[#6D4AFF]">
                                    {col.type}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Inline Quick Insert Form */}
                          {isAdding && (
                            <div className="p-3 bg-[#FAFAFC] flex flex-col gap-2">
                              <span className="text-[11.5px] font-semibold text-[#0B0B0F]">
                                Add record to {table.name}
                              </span>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {(editableCols.length > 0
                                  ? editableCols.slice(0, 6)
                                  : [{ name: 'title', type: 'text' as const }]
                                ).map((col) => (
                                  <input
                                    key={col.name}
                                    type="text"
                                    value={newRowDraft[col.name] ?? ''}
                                    onChange={(e) =>
                                      setNewRowDraft((prev) => ({
                                        ...prev,
                                        [col.name]: e.target.value,
                                      }))
                                    }
                                    placeholder={`${col.name} (${col.type})`}
                                    className="h-8 px-2.5 rounded-lg border border-black/[0.1] bg-white text-[12px] font-mono text-[#0B0B0F] focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]/30"
                                  />
                                ))}
                              </div>
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setAddingRowTable(null)}
                                  className="h-7 px-2.5 rounded-lg text-[11.5px] font-medium text-[#52525B] hover:bg-black/[0.04]"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleInsertRow(table)}
                                  className="h-7 px-3 rounded-lg bg-[#6D4AFF] text-white text-[11.5px] font-semibold hover:bg-[#5B35F0]"
                                >
                                  Save Row
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Live Records Table */}
                          {rows.length > 0 ? (
                            <div className="max-h-48 overflow-auto bg-white">
                              <table className="w-full text-left border-collapse text-[11.5px] font-mono">
                                <thead className="bg-[#FAFAFC] text-[#52525B] sticky top-0 border-b border-black/[0.06]">
                                  <tr>
                                    {table.columns.slice(0, 5).map((col) => (
                                      <th
                                        key={col.name}
                                        className="px-3 py-1.5 font-semibold whitespace-nowrap"
                                      >
                                        {col.name}
                                      </th>
                                    ))}
                                    <th className="px-2 py-1.5 w-8" />
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-black/[0.05] text-[#18181B]">
                                  {rows.slice(0, 20).map((row, idx) => (
                                    <tr key={String(row.id ?? idx)} className="hover:bg-[#FAFAFC]">
                                      {table.columns.slice(0, 5).map((col) => {
                                        const rawCell = row[col.name];
                                        const cellStr =
                                          rawCell === null || rawCell === undefined
                                            ? '—'
                                            : typeof rawCell === 'object'
                                              ? JSON.stringify(rawCell)
                                              : String(rawCell);
                                        return (
                                          <td
                                            key={col.name}
                                            className="px-3 py-1.5 max-w-[140px] truncate"
                                            title={cellStr}
                                          >
                                            {cellStr}
                                          </td>
                                        );
                                      })}
                                      <td className="px-2 py-1 text-right">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            handleDeleteRow(table.name, storageKey, row.id, idx)
                                          }
                                          aria-label={`Delete row ${idx + 1}`}
                                          className="p-1 rounded text-[#71717A] hover:text-red-600 hover:bg-red-50"
                                        >
                                          <Trash2 className="w-3 h-3" />
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <p className="px-3.5 py-2.5 text-[11.5px] text-[#71717A]">
                              Schema ready — tap + Row above or interact in Preview to store live records.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )
        ) : builtFiles.length === 0 ? (
          <div className="py-8 px-5 rounded-2xl bg-[#FAFAFC] border border-black/[0.06] text-center flex flex-col items-center gap-2.5">
            <div className="w-11 h-11 rounded-2xl bg-[#F3F0FF] text-[#6D4AFF] flex items-center justify-center">
              <FileCode2 className="w-5 h-5" />
            </div>
            <p className="text-[14px] font-semibold text-[#0B0B0F]">
              {isStreaming ? 'Writing files in real time...' : 'No built files yet'}
            </p>
            <p className="text-[12.5px] text-[#71717A] leading-relaxed max-w-[320px]">
              {isStreaming
                ? 'Source files (index.html, styles.css, app.js, database/schema.sql) stream here live as AI Craft builds.'
                : 'Ask AI Craft to build an app first. All generated HTML, CSS, JavaScript, screen modules, and SQL schemas appear here.'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Live File Status Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 rounded-2xl bg-[#FAFAFC] border border-black/[0.06]">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  aria-hidden="true"
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    isStreaming ? 'bg-[#6D4AFF] animate-pulse' : 'bg-emerald-500'
                  }`}
                />
                <span className="text-[12px] font-semibold text-[#0B0B0F] truncate">
                  {builtFiles.length} {builtFiles.length === 1 ? 'file' : 'files'} ·{' '}
                  {isStreaming ? 'Writing live...' : isEditingActiveFile ? 'Editing' : 'Synced'}
                </span>
              </div>
              {activeFile && (
                <div className="flex items-center gap-1.5">
                  {activeFile.editable && onApplyHtmlEdit && !isStreaming && (
                    isEditingActiveFile ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingFilePath(null);
                            setEditError(null);
                          }}
                          className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-black/[0.08] bg-white hover:bg-black/[0.03] text-[11.5px] font-medium text-[#52525B]"
                        >
                          <RotateCcw className="w-3 h-3" />
                          <span>Cancel</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleApplyFileEdit()}
                          className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg bg-[#6D4AFF] hover:bg-[#5B35F5] text-white text-[11.5px] font-semibold"
                        >
                          <Save className="w-3 h-3" />
                          <span>Save & Apply</span>
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleStartEditFile(activeFile)}
                        className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-black/[0.08] bg-white hover:bg-black/[0.03] text-[11.5px] font-medium text-[#0B0B0F]"
                      >
                        <Pencil className="w-3 h-3" />
                        <span>Edit</span>
                      </button>
                    )
                  )}
                  <button
                    type="button"
                    onClick={() => void handleCopyFile(activeFile)}
                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-black/[0.08] bg-white hover:bg-black/[0.03] text-[11.5px] font-medium text-[#0B0B0F]"
                  >
                    {copiedFilePath === activeFile.path ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-600" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>

            {editError && (
              <p
                role="alert"
                className="px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700 text-[12px] font-medium"
              >
                {editError}
              </p>
            )}

            {/* File Selector Strip */}
            <div className="flex flex-wrap gap-1.5">
              {builtFiles.map((file) => {
                const isSelected = activeFile?.path === file.path;
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => {
                      setSelectedFilePath(file.path);
                      setEditingFilePath(null);
                      setEditError(null);
                    }}
                    className={`px-2.5 py-1.5 rounded-xl border text-[11.5px] font-mono font-medium inline-flex items-center gap-1.5 transition-all ${
                      isSelected
                        ? 'bg-[#0B0B0F] text-white border-[#0B0B0F]'
                        : 'bg-white text-[#3F3F46] border-black/[0.08] hover:bg-[#FAFAFC]'
                    }`}
                  >
                    {file.kind === 'database' ? (
                      <Database className="w-3 h-3 shrink-0 text-[#8B5CF6]" />
                    ) : (
                      <Code2 className="w-3 h-3 shrink-0 text-[#8B5CF6]" />
                    )}
                    <span>{file.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Live File Content Viewer / Editor */}
            {activeFile && (
              <div className="rounded-2xl border border-black/[0.08] bg-[#111118] text-[#E4E4E7] overflow-hidden">
                <div className="px-3.5 py-2 bg-[#1A1A24] border-b border-white/10 flex items-center justify-between text-[11px] font-mono text-[#A1A1AA]">
                  <span className="truncate">{activeFile.path}</span>
                  <span className="tabular-nums shrink-0">
                    {isEditingActiveFile
                      ? `${editDraft.split('\n').length} lines · ${(editDraft.length / 1024).toFixed(1)} KB`
                      : `${activeFile.lineCount} lines · ${(activeFile.bytes / 1024).toFixed(1)} KB`}
                  </span>
                </div>
                {isEditingActiveFile ? (
                  <textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    spellCheck={false}
                    aria-label={`Edit ${activeFile.label}`}
                    className="w-full h-[300px] p-3.5 bg-[#111118] text-[#E4E4E7] text-[12px] leading-relaxed font-mono resize-none focus:outline-none"
                  />
                ) : (
                  <pre className="p-3.5 text-[11.5px] leading-relaxed font-mono overflow-auto max-h-[300px] whitespace-pre">
                    {activeFile.content}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </DrawerShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Per-Project Deployment Panel                                            */
/* -------------------------------------------------------------------------- */

export interface DeploySubmitOptions {
  slug: string;
  seoTitle?: string;
  seoDescription?: string;
  allowRemix?: boolean;
}

interface ProjectDeployModalProps {
  open: boolean;
  projectTitle: string;
  mode: BuildMode;
  hasBuiltApp: boolean;
  isPublished: boolean;
  latestPreviewHtml: string;
  secrets: ProjectSecret[];
  databaseConfig: ProjectDatabaseConfig;
  deployment: ProjectDeploymentConfig;
  onClose: () => void;
  onDeploy: (opts: DeploySubmitOptions) => Promise<boolean> | void;
  onOpenPreview: () => void;
  onOpenCode: () => void;
  onShare: () => Promise<string>;
}

export function ProjectDeployModal({
  open,
  projectTitle,
  mode,
  hasBuiltApp,
  isPublished,
  latestPreviewHtml,
  secrets,
  databaseConfig,
  deployment,
  onClose,
  onDeploy,
  onOpenPreview,
  onOpenCode,
  onShare,
}: ProjectDeployModalProps) {
  const [slugInput, setSlugInput] = useState(
    deployment.slug || slugifyProjectTitle(projectTitle)
  );
  const [seoTitleInput, setSeoTitleInput] = useState(
    deployment.seoTitle || projectTitle
  );
  const [seoDescriptionInput, setSeoDescriptionInput] = useState(
    deployment.seoDescription || `${projectTitle} — Built with AI Craft`
  );
  const [allowRemix, setAllowRemix] = useState(Boolean(deployment.allowRemix));
  const [includeSecretsInExport, setIncludeSecretsInExport] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [copiedLiveUrl, setCopiedLiveUrl] = useState(false);

  const [githubOpen, setGithubOpen] = useState(false);
  const [githubToken, setGithubToken] = useState('');
  const [githubRepoName, setGithubRepoName] = useState(
    deployment.slug || slugifyProjectTitle(projectTitle)
  );
  const [githubPrivate, setGithubPrivate] = useState(false);
  const [githubPushing, setGithubPushing] = useState(false);
  const [githubResultUrl, setGithubResultUrl] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const baseSlug = deployment.slug || slugifyProjectTitle(projectTitle);
    setSlugInput(baseSlug);
    setSeoTitleInput(deployment.seoTitle || projectTitle);
    setSeoDescriptionInput(
      deployment.seoDescription || `${projectTitle} — Built with AI Craft`
    );
    setAllowRemix(Boolean(deployment.allowRemix));
    setGithubRepoName(baseSlug);
    setGithubError(null);
    const savedGhSecret = secrets.find(
      (s) =>
        s.key.toUpperCase() === 'GITHUB_TOKEN' ||
        s.key.toUpperCase() === 'GH_TOKEN'
    );
    if (savedGhSecret?.value) {
      setGithubToken((prev) => prev || savedGhSecret.value);
    }
  }, [
    deployment.slug,
    deployment.seoTitle,
    deployment.seoDescription,
    deployment.allowRemix,
    projectTitle,
    secrets,
    open,
  ]);

  useEffect(() => {
    if (!statusNote) return;
    const t = window.setTimeout(() => setStatusNote(null), 3200);
    return () => window.clearTimeout(t);
  }, [statusNote]);

  const cleanedSlug = slugifyProjectTitle(slugInput);
  const resolvedSeoTitle = seoTitleInput.trim() || projectTitle;
  const resolvedSeoDesc =
    seoDescriptionInput.trim() || `${projectTitle} — Built with AI Craft`;
  const codeKb = latestPreviewHtml
    ? `${(latestPreviewHtml.length / 1024).toFixed(1)} KB`
    : '0 KB';

  const handleDeployClick = async () => {
    if (!hasBuiltApp) {
      setStatusNote('Build your app in chat first before deploying.');
      return;
    }
    const result = await onDeploy({
      slug: cleanedSlug,
      seoTitle: resolvedSeoTitle,
      seoDescription: resolvedSeoDesc,
      allowRemix,
    });
    if (result === false) {
      setStatusNote('Unable to publish live link right now. Please try again.');
      return;
    }
    setStatusNote(`Published live at /p/${cleanedSlug} (v${deployment.version + 1})`);
  };

  const handleDownloadHtml = () => {
    if (!latestPreviewHtml) return;
    let exportHtml = latestPreviewHtml;
    if (includeSecretsInExport && secrets.length > 0) {
      const envObj: Record<string, string> = {};
      for (const s of secrets) envObj[s.key] = s.value;
      const safeJson = JSON.stringify(envObj).replace(/</g, '\\u003c');
      const envScript = `<script>window.__AICRAFT_ENV__=${safeJson};window.ENV=Object.assign({},window.ENV||{},window.__AICRAFT_ENV__);</script>`;
      exportHtml = /<\/head>/i.test(exportHtml)
        ? exportHtml.replace(/<\/head>/i, `${envScript}</head>`)
        : `${envScript}${exportHtml}`;
    }
    const blob = new Blob([exportHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${cleanedSlug}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatusNote(`Downloaded ${cleanedSlug}.html`);
  };

  const handleDownloadZip = () => {
    if (!latestPreviewHtml) return;
    const { fileCount, filename } = downloadProjectZip({
      projectTitle: resolvedSeoTitle,
      slug: cleanedSlug,
      mode,
      html: latestPreviewHtml,
      databaseConfig,
      secrets,
      includeSecrets: includeSecretsInExport,
    });
    setStatusNote(`Downloaded ${filename} (${fileCount} project files)`);
  };

  const handlePushToGithub = async () => {
    if (!latestPreviewHtml) return;
    const cleanToken = githubToken.trim();
    const cleanRepo = githubRepoName.trim() || cleanedSlug;
    if (!cleanToken) {
      setGithubError('Enter a GitHub Personal Access Token (repo scope).');
      return;
    }
    setGithubPushing(true);
    setGithubError(null);
    setGithubResultUrl(null);
    try {
      const files = buildProjectExportFiles({
        projectTitle: resolvedSeoTitle,
        slug: cleanedSlug,
        mode,
        html: latestPreviewHtml,
        databaseConfig,
        secrets,
        includeSecrets: includeSecretsInExport,
      });
      const res = await fetch('/api/export/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: cleanToken,
          repoName: cleanRepo,
          description: resolvedSeoDesc,
          isPrivate: githubPrivate,
          files,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        repoUrl?: string;
        filesPushed?: number;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setGithubError(data.error || 'GitHub export failed.');
        return;
      }
      setGithubResultUrl(data.repoUrl || null);
      setStatusNote(`Pushed ${data.filesPushed ?? files.length} files to GitHub`);
    } catch {
      setGithubError('Network error while connecting to GitHub.');
    } finally {
      setGithubPushing(false);
    }
  };

  const handleShareClick = async () => {
    const msg = await onShare();
    setStatusNote(msg);
  };

  const handleCopyLiveUrl = async () => {
    if (!deployment.liveUrl) return;
    try {
      await navigator.clipboard.writeText(deployment.liveUrl);
      setCopiedLiveUrl(true);
      setStatusNote('Live app link copied');
      window.setTimeout(() => setCopiedLiveUrl(false), 2000);
    } catch {
      // ignore clipboard restriction
    }
  };

  return (
    <DrawerShell
      open={open}
      onClose={onClose}
      mode={mode}
      title="Deploy & Export"
      subtitle={`Publish, OG Metadata & Code Export · ${projectTitle}`}
      icon={<Rocket className="w-[18px] h-[18px] text-[#6D4AFF]" />}
    >
      <div className="flex flex-col gap-4">
        {/* Deployment Status Overview */}
        <div className="p-4 rounded-2xl bg-[#FAFAFC] border border-black/[0.07] flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[14px] font-semibold text-[#0B0B0F]">
                {isPublished ? 'Live Deployment Active' : hasBuiltApp ? 'Ready to Deploy' : 'Build Pending'}
              </p>
              <p className="text-[12px] text-[#71717A] mt-0.5 tabular-nums">
                {MODE_THEMES[mode].label} · {codeKb}
                {deployment.version > 0 ? ` · v${deployment.version}` : ''}
              </p>
            </div>
            <span
              className={`text-[12px] font-semibold ${
                isPublished ? 'text-emerald-700' : 'text-[#52525B]'
              }`}
            >
              {isPublished ? 'Published' : 'Draft'}
            </span>
          </div>

          <div className="pt-2.5 border-t border-black/[0.06] grid grid-cols-2 gap-3 text-[12px]">
            <div>
              <span className="text-[#71717A] block">Project Secrets</span>
              <span className="font-semibold text-[#0B0B0F] tabular-nums">
                {secrets.length} configured
              </span>
            </div>
            <div>
              <span className="text-[#71717A] block">Hosted App Database</span>
              <span className="font-semibold text-[#0B0B0F] tabular-nums">
                {databaseConfig.tables.length} schema{' '}
                {databaseConfig.tables.length === 1 ? 'table' : 'tables'}
              </span>
            </div>
          </div>
        </div>

        {(deployment.liveUrl || deployment.livePublishing) && (
          <div className="p-3.5 rounded-2xl border border-black/[0.08] bg-white flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-semibold text-[#0B0B0F]">
                Live App URL
              </span>
              {deployment.livePublishing ? (
                <span className="text-[11.5px] text-[#6D4AFF] font-medium">
                  Generating link...
                </span>
              ) : (
                <span className="text-[11.5px] text-emerald-700 font-medium">
                  Ready in browser
                </span>
              )}
            </div>
            {deployment.liveUrl && (
              <div className="rounded-xl border border-black/[0.09] bg-[#FAFAFC] px-3 py-2 flex items-center gap-2">
                {deployment.logoUrl && (
                  <img
                    src={deployment.logoUrl}
                    alt={`${projectTitle} icon`}
                    className="w-9 h-9 rounded-xl object-cover border border-black/10 shrink-0"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <span className="block font-mono text-[12px] text-[#0B0B0F] truncate select-all">
                    {deployment.liveUrl}
                  </span>
                  {deployment.logoUrl && (
                    <span className="block text-[10.5px] text-[#71717A] truncate">
                      Add to Home Screen uses this app icon
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopyLiveUrl()}
                  aria-label="Copy live URL"
                  className="min-h-[34px] px-2.5 rounded-lg border border-black/[0.1] bg-white hover:bg-black/[0.03] text-[12px] font-medium text-[#0B0B0F] inline-flex items-center gap-1 shrink-0"
                >
                  {copiedLiveUrl ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
                <a
                  href={deployment.liveUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open live hosted app"
                  className="min-h-[34px] px-2.5 rounded-lg bg-[#0B0B0F] hover:bg-[#27272A] text-white text-[12px] font-medium inline-flex items-center gap-1 shrink-0"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Open</span>
                </a>
              </div>
            )}
          </div>
        )}

        {/* App Slug & SEO Share Card Metadata */}
        <div className="flex flex-col gap-3 p-3.5 rounded-2xl border border-black/[0.08] bg-white">
          <div>
            <label className="block text-[12px] font-medium text-[#52525B] mb-1">
              Public App Slug
            </label>
            <input
              type="text"
              value={slugInput}
              onChange={(e) => setSlugInput(e.target.value)}
              placeholder="my-app-slug"
              className="w-full h-10 px-3 rounded-xl border border-black/[0.12] bg-[#FAFAFC] font-mono text-[12.5px] text-[#0B0B0F] focus:outline-none focus:border-[#6D4AFF] focus:bg-white"
            />
            <p className="text-[11px] text-[#71717A] mt-1 font-mono truncate">
              Route: /p/{cleanedSlug}
              {deployment.deployedAt
                ? ` · Last deployed ${new Date(deployment.deployedAt).toLocaleDateString()}`
                : ''}
            </p>
          </div>

          <div>
            <label className="block text-[12px] font-medium text-[#52525B] mb-1">
              Social Share / OG Title
            </label>
            <input
              type="text"
              value={seoTitleInput}
              onChange={(e) => setSeoTitleInput(e.target.value)}
              placeholder={projectTitle}
              maxLength={80}
              className="w-full h-10 px-3 rounded-xl border border-black/[0.12] bg-[#FAFAFC] text-[13px] text-[#0B0B0F] focus:outline-none focus:border-[#6D4AFF] focus:bg-white"
            />
          </div>

          <div>
            <label className="block text-[12px] font-medium text-[#52525B] mb-1">
              Social Share Description
            </label>
            <textarea
              rows={2}
              value={seoDescriptionInput}
              onChange={(e) => setSeoDescriptionInput(e.target.value)}
              placeholder="Describe what your app does for link previews..."
              maxLength={180}
              className="w-full px-3 py-2 rounded-xl border border-black/[0.12] bg-[#FAFAFC] text-[12.5px] text-[#0B0B0F] resize-none focus:outline-none focus:border-[#6D4AFF] focus:bg-white"
            />
          </div>

          {/* Live Social Share Card Preview */}
          <div className="rounded-xl border border-black/[0.08] bg-[#FAFAFC] p-3 flex items-center gap-3">
            {deployment.logoUrl ? (
              <img
                src={deployment.logoUrl}
                alt="Share icon"
                className="w-11 h-11 rounded-xl object-cover border border-black/10 shrink-0"
              />
            ) : (
              <div className="w-11 h-11 rounded-xl bg-[#0B0B0F] text-white flex items-center justify-center shrink-0">
                <Globe className="w-5 h-5" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-mono uppercase tracking-wider text-[#71717A] truncate">
                OG Preview · /p/{cleanedSlug}
              </p>
              <p className="text-[13px] font-semibold text-[#0B0B0F] truncate">
                {resolvedSeoTitle}
              </p>
              <p className="text-[11.5px] text-[#52525B] line-clamp-2">
                {resolvedSeoDesc}
              </p>
            </div>
          </div>

          {/* Community Remix Toggle */}
          <label className="flex items-start gap-2.5 pt-1 cursor-pointer">
            <input
              type="checkbox"
              checked={allowRemix}
              onChange={(e) => setAllowRemix(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded accent-[#6D4AFF]"
            />
            <span className="text-[12px] text-[#3F3F46] leading-snug">
              <span className="font-semibold text-[#0B0B0F] inline-flex items-center gap-1">
                <GitFork className="w-3.5 h-3.5 text-[#6D4AFF]" />
                Allow Community Remix
              </span>
              <span className="block text-[11px] text-[#71717A] mt-0.5">
                Lists this build in the Remix Gallery and adds a fork badge on /p/{cleanedSlug}.
              </span>
            </span>
          </label>
        </div>

        {statusNote && (
          <p
            role="status"
            className="px-3 py-2 rounded-xl bg-[#F3F0FF] text-[#5B21B6] text-[12.5px] font-medium"
          >
            {statusNote}
          </p>
        )}

        {/* Primary Deploy CTA */}
        <button
          type="button"
          onClick={() => void handleDeployClick()}
          disabled={!hasBuiltApp || Boolean(deployment.livePublishing)}
          className="w-full h-11 rounded-xl bg-[#6D4AFF] hover:bg-[#5B35F5] disabled:bg-[#BEB5F9] text-white text-[14px] font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition-all"
        >
          {deployment.livePublishing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Rocket className="w-4 h-4" />
          )}
          <span>
            {deployment.livePublishing
              ? 'Publishing Live...'
              : isPublished
                ? 'Update Live Link'
                : 'Publish Live App'}
          </span>
        </button>

        {/* Secondary Actions */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!hasBuiltApp}
            onClick={() => {
              onClose();
              onOpenPreview();
            }}
            className="h-10 px-3 rounded-xl border border-black/[0.1] bg-white hover:bg-black/[0.03] disabled:opacity-45 text-[12.5px] font-medium text-[#0B0B0F] flex items-center justify-center gap-1.5"
          >
            <ExternalLink className="w-4 h-4" />
            <span>Open Preview</span>
          </button>

          <button
            type="button"
            disabled={!hasBuiltApp}
            onClick={() => {
              onClose();
              onOpenCode();
            }}
            className="h-10 px-3 rounded-xl border border-black/[0.1] bg-white hover:bg-black/[0.03] disabled:opacity-45 text-[12.5px] font-medium text-[#0B0B0F] flex items-center justify-center gap-1.5"
          >
            <Code2 className="w-4 h-4" />
            <span>View Code</span>
          </button>

          <button
            type="button"
            disabled={!hasBuiltApp}
            onClick={handleDownloadZip}
            className="h-10 px-3 rounded-xl border border-black/[0.1] bg-white hover:bg-black/[0.03] disabled:opacity-45 text-[12.5px] font-medium text-[#0B0B0F] flex items-center justify-center gap-1.5"
          >
            <FileArchive className="w-4 h-4 text-[#6D4AFF]" />
            <span>Export ZIP</span>
          </button>

          <button
            type="button"
            disabled={!hasBuiltApp}
            onClick={() => setGithubOpen((v) => !v)}
            className={`h-10 px-3 rounded-xl border text-[12.5px] font-medium flex items-center justify-center gap-1.5 disabled:opacity-45 ${
              githubOpen
                ? 'border-[#0B0B0F] bg-[#0B0B0F] text-white'
                : 'border-black/[0.1] bg-white hover:bg-black/[0.03] text-[#0B0B0F]'
            }`}
          >
            <Github className="w-4 h-4" />
            <span>Push to GitHub</span>
          </button>

          <button
            type="button"
            disabled={!hasBuiltApp}
            onClick={handleDownloadHtml}
            className="h-10 px-3 rounded-xl border border-black/[0.1] bg-white hover:bg-black/[0.03] disabled:opacity-45 text-[12.5px] font-medium text-[#0B0B0F] flex items-center justify-center gap-1.5"
          >
            <Download className="w-4 h-4" />
            <span>Export HTML</span>
          </button>

          <button
            type="button"
            onClick={() => void handleShareClick()}
            className="h-10 px-3 rounded-xl border border-black/[0.1] bg-white hover:bg-black/[0.03] text-[12.5px] font-medium text-[#0B0B0F] flex items-center justify-center gap-1.5"
          >
            <Share2 className="w-4 h-4" />
            <span>Share App</span>
          </button>
        </div>

        {/* Expandable Push to GitHub Panel */}
        {githubOpen && hasBuiltApp && (
          <div className="p-3.5 rounded-2xl border border-black/[0.1] bg-[#FAFAFC] flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] font-semibold text-[#0B0B0F] inline-flex items-center gap-1.5">
                <Github className="w-4 h-4" />
                Push Multi-File Repo to GitHub
              </span>
              <span className="text-[11px] text-[#71717A]">
                index.html + CSS + JS + SQL
              </span>
            </div>

            <input
              type="text"
              value={githubRepoName}
              onChange={(e) => setGithubRepoName(e.target.value)}
              placeholder="my-app-repo or owner/repo"
              className="w-full h-9 px-3 rounded-xl border border-black/[0.12] bg-white font-mono text-[12px] text-[#0B0B0F] focus:outline-none focus:border-[#6D4AFF]"
            />

            <input
              type="password"
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
              placeholder="GitHub Personal Access Token (repo scope)"
              autoComplete="off"
              className="w-full h-9 px-3 rounded-xl border border-black/[0.12] bg-white font-mono text-[12px] text-[#0B0B0F] focus:outline-none focus:border-[#6D4AFF]"
            />

            <label className="flex items-center gap-2 text-[12px] text-[#3F3F46] cursor-pointer">
              <input
                type="checkbox"
                checked={githubPrivate}
                onChange={(e) => setGithubPrivate(e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-[#6D4AFF]"
              />
              <span>Create private repository</span>
            </label>

            {githubError && (
              <p className="text-[11.5px] text-red-600 font-medium">{githubError}</p>
            )}

            {githubResultUrl && (
              <a
                href={githubResultUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-[12px] font-medium flex items-center justify-between gap-2"
              >
                <span className="truncate">Open pushed repository</span>
                <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              </a>
            )}

            <button
              type="button"
              disabled={githubPushing}
              onClick={() => void handlePushToGithub()}
              className="w-full h-9 rounded-xl bg-[#0B0B0F] hover:bg-black/85 disabled:opacity-60 text-white text-[12.5px] font-semibold inline-flex items-center justify-center gap-1.5"
            >
              {githubPushing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Github className="w-3.5 h-3.5" />
              )}
              <span>{githubPushing ? 'Pushing files...' : 'Push Repository Now'}</span>
            </button>
          </div>
        )}

        {hasBuiltApp && secrets.length > 0 && (
          <label className="flex items-center gap-2.5 text-[12px] text-[#52525B] cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={includeSecretsInExport}
              onChange={(e) => setIncludeSecretsInExport(e.target.checked)}
              className="w-4 h-4 rounded accent-[#6D4AFF]"
            />
            <span>Include saved project secrets inside exported bundle</span>
          </label>
        )}
      </div>
    </DrawerShell>
  );
}
