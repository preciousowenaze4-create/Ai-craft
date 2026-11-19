import { useEffect, useMemo, useState } from 'react';
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
  FileCode2,
  FolderTree,
  KeyRound,
  Lightbulb,
  Loader2,
  Plus,
  RefreshCw,
  Rocket,
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
  onClose: () => void;
}

interface RealTimeBuiltFile {
  path: string;
  label: string;
  content: string;
  kind: 'code' | 'database' | 'screen';
  lineCount: number;
  bytes: number;
}

function extractScreenSectionHtml(fullHtml: string, screenId: string): string {
  if (!fullHtml || !screenId) return '';
  const escaped = screenId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionRegex = new RegExp(
    `<(?:section|div|main|article)\\b[^>]*(?:id|data-screen|data-view|data-tab|data-page)=["']${escaped}["'][^>]*>[\\s\\S]*?(?=<\\/(?:section|main|article)>|$)`,
    'i'
  );
  const m = sectionRegex.exec(fullHtml);
  if (!m) return '';
  return m[0].trim();
}

export function ProjectDatabaseModal({
  open,
  mode = 'mobile',
  projectId,
  projectTitle,
  hasBuiltApp,
  isStreaming,
  latestPreviewHtml,
  databaseConfig,
  secrets = [],
  codeParts = [],
  latestBuildFiles = [],
  onClose,
}: ProjectDatabaseModalProps) {
  const [activeTab, setActiveTab] = useState<'database' | 'files'>('database');
  const [copiedSqlId, setCopiedSqlId] = useState<string | null>(null);
  const [copiedFilePath, setCopiedFilePath] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string>('index.html');
  const [collapsedTables, setCollapsedTables] = useState<Record<string, boolean>>({});
  const [addingRowTable, setAddingRowTable] = useState<string | null>(null);
  const [newRowDraft, setNewRowDraft] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<string | null>(null);
  const [dataRefreshTick, setDataRefreshTick] = useState(0);

  useEffect(() => {
    if (!open) return;
    setDataRefreshTick((n) => n + 1);
    const handleDbUpdate = (evt: Event) => {
      const detail = (evt as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === projectId) {
        setDataRefreshTick((n) => n + 1);
      }
    };
    const handleStorage = () => {
      setDataRefreshTick((n) => n + 1);
    };
    window.addEventListener('aicraft:db-updated', handleDbUpdate);
    window.addEventListener('storage', handleStorage);
    const poll = window.setInterval(() => {
      setDataRefreshTick((n) => n + 1);
    }, 1000);
    return () => {
      window.removeEventListener('aicraft:db-updated', handleDbUpdate);
      window.removeEventListener('storage', handleStorage);
      window.clearInterval(poll);
    };
  }, [open, projectId]);

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
    const prefix = `aicraft_db_${projectId}_`;

    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (!key) continue;

        let tableName = '';
        if (key.startsWith(prefix)) {
          tableName = sanitizeTableName(key.slice(prefix.length));
        } else if (detected.storageKeys.includes(key)) {
          tableName = sanitizeTableName(key);
        } else {
          continue;
        }

        if (!tableName) continue;
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
        map.set(tableName, { storageKey: key, rows: normalizedRows });
      }
    } catch {
      // ignore localStorage read failure
    }
    return map;
  }, [open, projectId, detected.storageKeys, dataRefreshTick]);

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
    const pushFile = (path: string, content: string, kind: RealTimeBuiltFile['kind']) => {
      if (!path || seen.has(path)) return;
      seen.add(path);
      const clean = content || '';
      list.push({
        path,
        label: path,
        content: clean,
        kind,
        lineCount: clean ? clean.split('\n').length : 0,
        bytes: clean.length,
      });
    };

    for (const part of codeParts) {
      if (part.content) {
        pushFile(part.id, part.content, 'code');
      }
    }

    if (structuredTables.length > 0) {
      const fullSql = structuredTables.map((t) => buildCreateSql(t)).join('\n\n');
      pushFile('database/schema.sql', fullSql, 'database');

      const snapshotObj: Record<string, Record<string, unknown>[]> = {};
      for (const tbl of structuredTables) {
        snapshotObj[tbl.name] = liveStoredMap.get(tbl.name)?.rows ?? [];
      }
      pushFile('database/records.json', JSON.stringify(snapshotObj, null, 2), 'database');
    }

    if (latestPreviewHtml) {
      for (const rawPath of latestBuildFiles) {
        if (!rawPath || seen.has(rawPath)) continue;
        if (rawPath.startsWith('screens/')) {
          const screenName = rawPath.replace(/^screens\//, '').replace(/\.html$/i, '');
          const sectionCode = extractScreenSectionHtml(latestPreviewHtml, screenName);
          if (sectionCode) {
            pushFile(rawPath, sectionCode, 'screen');
          }
        }
      }
    }

    return list;
  }, [codeParts, structuredTables, liveStoredMap, latestPreviewHtml, latestBuildFiles]);

  const activeFile = useMemo(
    () => builtFiles.find((f) => f.path === selectedFilePath) || builtFiles[0] || null,
    [builtFiles, selectedFilePath]
  );

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

  const handleDeleteRow = (tableName: string, storageKey: string, rowId: unknown, rowIndex: number) => {
    try {
      const store = liveStoredMap.get(tableName);
      if (!store) return;
      const nextRows = store.rows.filter((r, idx) =>
        rowId !== undefined && rowId !== null ? r.id !== rowId : idx !== rowIndex
      );
      window.localStorage.setItem(storageKey, JSON.stringify(nextRows));
      setDataRefreshTick((n) => n + 1);
      window.dispatchEvent(
        new CustomEvent('aicraft:db-updated', { detail: { projectId, table: tableName } })
      );
      setFeedback(`Deleted record from "${tableName}".`);
    } catch {
      // ignore storage error
    }
  };

  const handleInsertRow = (table: ProjectDatabaseTable) => {
    const storageKey =
      liveStoredMap.get(table.name)?.storageKey || `aicraft_db_${projectId}_${table.name}`;
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
      const nextRows = [row, ...existing];
      window.localStorage.setItem(storageKey, JSON.stringify(nextRows));
      setAddingRowTable(null);
      setNewRowDraft({});
      setDataRefreshTick((n) => n + 1);
      window.dispatchEvent(
        new CustomEvent('aicraft:db-updated', { detail: { projectId, table: table.name } })
      );
      setFeedback(`Added record to "${table.name}".`);
    } catch {
      // ignore storage error
    }
  };

  const handleClearTableRows = (tableName: string, storageKey: string) => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([]));
      setDataRefreshTick((n) => n + 1);
      window.dispatchEvent(
        new CustomEvent('aicraft:db-updated', { detail: { projectId, table: tableName } })
      );
      setFeedback(`Cleared records in "${tableName}".`);
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
                        isStreaming ? 'bg-[#6D4AFF] animate-pulse' : 'bg-emerald-500'
                      }`}
                    />
                    <span className="text-[12.5px] font-semibold text-[#0B0B0F] tabular-nums truncate">
                      {structuredTables.length}{' '}
                      {structuredTables.length === 1 ? 'table' : 'tables'} ·{' '}
                      {totalLiveRows} {totalLiveRows === 1 ? 'record' : 'records'}
                    </span>
                  </div>
                  <span className="text-[11px] text-[#71717A] truncate pl-4">
                    {hasSupabaseConfigured
                      ? 'Connected to Supabase Secret + Live App DB'
                      : 'Live App DB synced with Preview'}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setDataRefreshTick((n) => n + 1)}
                  className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-black/[0.08] bg-white hover:bg-black/[0.03] text-[12px] font-medium text-[#3F3F46] active:scale-95 transition-all shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-[#6D4AFF]" />
                  <span>Sync</span>
                </button>
              </div>

              {/* Structured Database Tables */}
              <div className="flex flex-col gap-3">
                {structuredTables.map((table) => {
                  const store = liveStoredMap.get(table.name);
                  const storageKey = store?.storageKey || `aicraft_db_${projectId}_${table.name}`;
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
            <div className="flex items-center justify-between gap-2 px-3.5 py-2 rounded-2xl bg-[#FAFAFC] border border-black/[0.06]">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  aria-hidden="true"
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    isStreaming ? 'bg-[#6D4AFF] animate-pulse' : 'bg-emerald-500'
                  }`}
                />
                <span className="text-[12px] font-semibold text-[#0B0B0F] truncate">
                  {builtFiles.length} {builtFiles.length === 1 ? 'file' : 'files'} ·{' '}
                  {isStreaming ? 'Writing live...' : 'Synced'}
                </span>
              </div>
              {activeFile && (
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
                      <span>Copy file</span>
                    </>
                  )}
                </button>
              )}
            </div>

            {/* File Selector Strip */}
            <div className="flex flex-wrap gap-1.5">
              {builtFiles.map((file) => {
                const isSelected = activeFile?.path === file.path;
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => setSelectedFilePath(file.path)}
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

            {/* Live File Content Viewer */}
            {activeFile && (
              <div className="rounded-2xl border border-black/[0.08] bg-[#111118] text-[#E4E4E7] overflow-hidden">
                <div className="px-3.5 py-2 bg-[#1A1A24] border-b border-white/10 flex items-center justify-between text-[11px] font-mono text-[#A1A1AA]">
                  <span className="truncate">{activeFile.path}</span>
                  <span className="tabular-nums shrink-0">
                    {activeFile.lineCount} lines · {(activeFile.bytes / 1024).toFixed(1)} KB
                  </span>
                </div>
                <pre className="p-3.5 text-[11.5px] leading-relaxed font-mono overflow-auto max-h-[300px] whitespace-pre">
                  {activeFile.content}
                </pre>
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
  onDeploy: (slug: string) => void;
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
  const [includeSecretsInExport, setIncludeSecretsInExport] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [copiedLiveUrl, setCopiedLiveUrl] = useState(false);

  useEffect(() => {
    setSlugInput(deployment.slug || slugifyProjectTitle(projectTitle));
  }, [deployment.slug, projectTitle, open]);

  useEffect(() => {
    if (!statusNote) return;
    const t = window.setTimeout(() => setStatusNote(null), 2800);
    return () => window.clearTimeout(t);
  }, [statusNote]);

  const cleanedSlug = slugifyProjectTitle(slugInput);
  const codeKb = latestPreviewHtml
    ? `${(latestPreviewHtml.length / 1024).toFixed(1)} KB`
    : '0 KB';

  const handleDeployClick = () => {
    if (!hasBuiltApp) {
      setStatusNote('Build your app in chat first before deploying.');
      return;
    }
    onDeploy(cleanedSlug);
    setStatusNote(`Deployed ${projectTitle} (v${deployment.version + 1})`);
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
      title="Deploy"
      subtitle={`Launch & Export · ${projectTitle}`}
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
              <span className="text-[#71717A] block">Database Tables</span>
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
              <div className="rounded-xl border border-black/[0.09] bg-[#FAFAFC] px-3 py-2 flex items-center gap-2.5">
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
                  className="min-h-[36px] px-2.5 rounded-lg border border-black/[0.1] bg-white hover:bg-black/[0.03] text-[12px] font-medium text-[#0B0B0F] inline-flex items-center gap-1 shrink-0"
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
              </div>
            )}
          </div>
        )}

        {/* App Slug Input */}
        <div>
          <label className="block text-[12px] font-medium text-[#52525B] mb-1.5">
            App Slug
          </label>
          <input
            type="text"
            value={slugInput}
            onChange={(e) => setSlugInput(e.target.value)}
            placeholder="my-app-slug"
            className="w-full h-11 px-3.5 rounded-xl border border-black/[0.12] bg-[#FAFAFC] font-mono text-[13px] text-[#0B0B0F] focus:outline-none focus:border-[#6D4AFF] focus:bg-white"
          />
          {deployment.deployedAt && (
            <p className="text-[11.5px] text-[#71717A] mt-1.5">
              Last deployed {new Date(deployment.deployedAt).toLocaleString()}
            </p>
          )}
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
          onClick={handleDeployClick}
          disabled={!hasBuiltApp}
          className="w-full h-11 rounded-xl bg-[#6D4AFF] hover:bg-[#5B35F5] disabled:bg-[#BEB5F9] text-white text-[14px] font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition-all"
        >
          <Rocket className="w-4 h-4" />
          <span>{isPublished ? 'Update Live Deployment' : 'Deploy App'}</span>
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
            className="h-11 px-3 rounded-xl border border-black/[0.1] bg-white hover:bg-black/[0.03] disabled:opacity-45 text-[13px] font-medium text-[#0B0B0F] flex items-center justify-center gap-1.5"
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
            className="h-11 px-3 rounded-xl border border-black/[0.1] bg-white hover:bg-black/[0.03] disabled:opacity-45 text-[13px] font-medium text-[#0B0B0F] flex items-center justify-center gap-1.5"
          >
            <Code2 className="w-4 h-4" />
            <span>View Code</span>
          </button>

          <button
            type="button"
            disabled={!hasBuiltApp}
            onClick={handleDownloadHtml}
            className="h-11 px-3 rounded-xl border border-black/[0.1] bg-white hover:bg-black/[0.03] disabled:opacity-45 text-[13px] font-medium text-[#0B0B0F] flex items-center justify-center gap-1.5"
          >
            <Download className="w-4 h-4" />
            <span>Export HTML</span>
          </button>

          <button
            type="button"
            onClick={() => void handleShareClick()}
            className="h-11 px-3 rounded-xl border border-black/[0.1] bg-white hover:bg-black/[0.03] text-[13px] font-medium text-[#0B0B0F] flex items-center justify-center gap-1.5"
          >
            <Share2 className="w-4 h-4" />
            <span>Share App</span>
          </button>
        </div>

        {hasBuiltApp && secrets.length > 0 && (
          <label className="flex items-center gap-2.5 text-[12px] text-[#52525B] cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={includeSecretsInExport}
              onChange={(e) => setIncludeSecretsInExport(e.target.checked)}
              className="w-4 h-4 rounded accent-[#6D4AFF]"
            />
            <span>Include saved project secrets inside exported HTML bundle</span>
          </label>
        )}
      </div>
    </DrawerShell>
  );
}
