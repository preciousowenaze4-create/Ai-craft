import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BadgeCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Copy,
  Database,
  Download,
  Eye,
  Film,
  Globe,
  HelpCircle,
  Image as ImageIcon,
  KeyRound,
  Lightbulb,
  Link2,
  Loader2,
  MoreVertical,
  Music,
  Paperclip,
  Rocket,
  ShieldAlert,
  Volume2,
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
import { buildProjectSecretHints } from '../utils/secretHints';
import { FloatingLogoMenu } from './FloatingLogoMenu';
import { LivingBotanicalWallpaper } from './LivingBotanicalWallpaper';
import { ModelSelectorPopover } from './ModelSelectorPopover';
import {
  ProjectDatabaseModal,
  ProjectDeployModal,
  ProjectSecretsModal,
} from './ProjectConfigDrawers';
import { ProviderLogo } from './ProviderLogo';
import { ScreenStudioStrip } from './ScreenStudioStrip';
import { VoiceInputButton } from './VoiceInputButton';

function sanitizeDisplayProse(raw: string, isBuildTurn: boolean): string {
  const cleaned = raw
    .replace(/\[\[\s*INTENT\s*:\s*(?:CHAT|BUILD)\s*\]\]/gi, '')
    .replace(/\[\[\s*MODE\s*:\s*(?:CHAT|GENERATE)\s*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*MEDIA_PROMPT\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*TITLE\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*LOGO\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*PLAN\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*DB_SCHEMA\s*:[^\]]*\]\]\s*\n?/gi, '')
    .replace(/\[\[\s*SUGGESTIONS\s*\]\][\s\S]*?(?:\[\[\s*\/\s*SUGGESTIONS\s*\]\]|$)/gi, '');
  if (!isBuildTurn) return cleaned.trim();
  return cleaned
    .replace(/```[\s\S]*?```/g, '')
    .replace(/```[\s\S]*/g, '')
    .replace(/<<<\s*AICRAFT_APP_HTML\s*>>>[\s\S]*/gi, '')
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
  onDeployProject: (slug: string) => void;
  onBack: () => void;
  onSendFollowUp: (message: string, options: ComposerOptions) => void;
  onContinueTurn: (turn: BuilderTurn) => void;
  onCheckCanUseAi?: () => boolean;
  onPaymentRequired?: (billing?: BillingSummary | null, errorMessage?: string) => void;
  onOpenApps: () => void;
  onOpenSettings: () => void;
  onOpenUpgrade: () => void;
  autoReadEnabled?: boolean;
  isOwner?: boolean;
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
  onDeployProject,
  onBack,
  onSendFollowUp,
  onContinueTurn,
  onCheckCanUseAi,
  onPaymentRequired,
  onOpenApps,
  onOpenSettings,
  onOpenUpgrade,
  autoReadEnabled = true,
  isOwner = false,
}: BuilderWorkspaceProps) {
  const theme = MODE_THEMES[mode];
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);

  const [followUp, setFollowUp] = useState('');
  const [attachment, setAttachment] = useState<ProcessedAttachment | null>(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [activeDrawer, setActiveDrawer] = useState<'secrets' | 'database' | 'deploy' | null>(null);
  const [showHeaderActions, setShowHeaderActions] = useState(false);
  const [autoAllow, setAutoAllow] = useState(true);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLiveUrl, setCopiedLiveUrl] = useState(false);
  const [activeCodeTab, setActiveCodeTab] = useState<'index.html' | 'styles.css' | 'app.js'>('index.html');
  const [nowMs, setNowMs] = useState(() => Date.now());

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

  const codeParts = useMemo(() => {
    if (!latestPreviewHtml) {
      return [{ id: 'index.html' as const, label: 'index.html', content: '' }];
    }
    const parts: Array<{ id: 'index.html' | 'styles.css' | 'app.js'; label: string; content: string }> = [
      { id: 'index.html', label: 'index.html', content: latestPreviewHtml },
    ];
    const styleMatches = Array.from(
      latestPreviewHtml.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)
    )
      .map((m) => m[1]?.trim() ?? '')
      .filter(Boolean);
    if (styleMatches.length > 0) {
      parts.push({
        id: 'styles.css',
        label: 'styles.css',
        content: styleMatches.join('\n\n'),
      });
    }
    const scriptMatches = Array.from(
      latestPreviewHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)
    )
      .map((m) => m[1]?.trim() ?? '')
      .filter(Boolean);
    if (scriptMatches.length > 0) {
      parts.push({
        id: 'app.js',
        label: 'app.js',
        content: scriptMatches.join('\n\n'),
      });
    }
    return parts;
  }, [latestPreviewHtml]);

  const databaseConfigRef = useRef(databaseConfig);
  databaseConfigRef.current = databaseConfig;

  const secretsFingerprint = useMemo(
    () => secrets.map((s) => `${s.key}:${s.updatedAt}`).join('|'),
    [secrets]
  );

  // Inject window.AICraft bridge, per-project secrets, and scoped database runtime into Preview
  const connectedPreviewHtml = useMemo(() => {
    if (!latestPreviewHtml) return '';
    const envMap: Record<string, string> = {};
    for (const s of secrets) {
      if (s.key) envMap[s.key] = s.value;
    }
    const dbPrefix = `aicraft_db_${projectId}_`;
    const initialDbMap: Record<string, unknown[]> = {};
    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (!key || !key.startsWith(dbPrefix)) continue;
        const tblName = key.slice(dbPrefix.length);
        const raw = window.localStorage.getItem(key);
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        initialDbMap[tblName] = Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      // ignore storage read error
    }

    const safeEnvJson = JSON.stringify(envMap).replace(/</g, '\\u003c');
    const safeInitialDbJson = JSON.stringify(initialDbMap).replace(/</g, '\\u003c');
    const safeDbPrefix = JSON.stringify(dbPrefix).replace(/</g, '\\u003c');
    const safeDbMeta = JSON.stringify({
      enabled: databaseConfigRef.current.enabled,
      tables: databaseConfigRef.current.tables.map((t) => t.name),
    }).replace(/</g, '\\u003c');

    const bridgeScript = `<script>
(function(){
  var envMap = ${safeEnvJson};
  var dbCache = ${safeInitialDbJson};
  var dbPrefix = ${safeDbPrefix};
  var dbMeta = ${safeDbMeta};
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
      }, 600);
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
  var dbApi = {
    meta: dbMeta,
    list: function(table) {
      var t = cleanTable(table);
      var cached = readTable(t);
      return sendDbOp('list', { table: t }, cached).then(function(rows) {
        if (Array.isArray(rows)) dbCache[t] = rows;
        return Array.isArray(rows) ? rows : cached;
      });
    },
    insert: function(table, row) {
      var t = cleanTable(table);
      var rows = readTable(t);
      var item = Object.assign({ id: 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), created_at: new Date().toISOString() }, row || {});
      rows.unshift(item);
      writeTable(t, rows);
      notifyDbSubscribers(t);
      return sendDbOp('insert', { table: t, row: item }, item);
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
      return sendDbOp('update', { table: t, rowId: id, patch: patch || {} }, updated);
    },
    remove: function(table, id) {
      var t = cleanTable(table);
      var rows = readTable(t).filter(function(r) { return !r || r.id !== id; });
      writeTable(t, rows);
      notifyDbSubscribers(t);
      return sendDbOp('remove', { table: t, rowId: id }, true);
    },
    clear: function(table) {
      var t = cleanTable(table);
      writeTable(t, []);
      notifyDbSubscribers(t);
      return sendDbOp('clear', { table: t }, true);
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
  window.addEventListener('error', function(errEvent) {
    if (runtimeErrorShown) return;
    setTimeout(function() {
      if (runtimeErrorShown || !document.body) return;
      var visibleText = (document.body.innerText || '').trim();
      if (visibleText.length >= 24) return;
      runtimeErrorShown = true;
      var bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;z-index:99999;background:#111827;color:#F9FAFB;border:1px solid rgba(255,255,255,0.16);border-radius:14px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-family:system-ui,sans-serif;font-size:13px;box-shadow:0 12px 32px rgba(0,0,0,0.45);';
      var msg = document.createElement('span');
      msg.textContent = 'App script hit an error: ' + String((errEvent && errEvent.message) || 'Unknown runtime error').slice(0, 90);
      var btn = document.createElement('button');
      btn.textContent = 'Auto-Fix';
      btn.style.cssText = 'background:#4F46E5;color:#fff;border:0;border-radius:8px;padding:6px 12px;font-weight:600;cursor:pointer;flex-shrink:0;';
      btn.onclick = function() {
        window.parent.postMessage({ type: 'aicraft:edit', instruction: 'Fix this runtime error cleanly while preserving all app screens: ' + String((errEvent && errEvent.message) || 'script error') }, '*');
      };
      bar.appendChild(msg);
      bar.appendChild(btn);
      document.body.appendChild(bar);
    }, 650);
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
        message: 'Open your Live App Link in Safari or Chrome to install with its custom Home Screen icon.'
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
    db: dbApi,
    pwa: pwaBridge,
    browser: browserBridge,
    ask: ask,
    chat: ask,
    search: search,
    generateImage: function(prompt, model) { return generateMedia('image', prompt, model); },
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
  }, [latestPreviewHtml, secrets, projectId]);

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
            op?: 'list' | 'insert' | 'update' | 'remove' | 'clear';
            table?: string;
            row?: Record<string, unknown>;
            rowId?: string;
            patch?: Record<string, unknown>;
            prompt?: string;
            query?: string;
            instruction?: string;
          }
        | undefined;
      if (!data?.type) return;

      if (data.type === 'aicraft:edit' && data.instruction?.trim()) {
        onSetView('chat');
        onSendFollowUp(data.instruction.trim(), {
          reactEnabled: mode === 'web',
          backendEnabled: false,
          webSearchEnabled,
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
        const storageKey = `aicraft_db_${projectId}_${cleanTable}`;

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
          const rows = readRows();
          result = rows;
          if (rows.length > 0) sampleRowForSchema = rows[0];
        } else if (data.op === 'insert') {
          const rows = readRows();
          const item: Record<string, unknown> = {
            id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            created_at: new Date().toISOString(),
            ...(data.row && typeof data.row === 'object' ? data.row : {}),
          };
          const deduped = rows.filter((r) => r.id !== item.id);
          deduped.unshift(item);
          writeRows(deduped);
          result = item;
          sampleRowForSchema = item;
        } else if (data.op === 'update') {
          let updated: Record<string, unknown> | null = null;
          const nextRows = readRows().map((r) => {
            if (r.id === data.rowId) {
              updated = {
                ...r,
                ...(data.patch && typeof data.patch === 'object' ? data.patch : {}),
              };
              return updated;
            }
            return r;
          });
          writeRows(nextRows);
          result = updated;
          if (updated) sampleRowForSchema = updated;
        } else if (data.op === 'remove') {
          const nextRows = readRows().filter((r) => r.id !== data.rowId);
          writeRows(nextRows);
          result = true;
        } else if (data.op === 'clear') {
          writeRows([]);
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
          new CustomEvent('aicraft:db-updated', { detail: { projectId, table: cleanTable } })
        );
        replyTarget?.postMessage(
          { type: 'aicraft:reply', id: data.id, data: result },
          '*'
        );
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
          };
          replyTarget?.postMessage(
            {
              type: 'aicraft:reply',
              id: data.id,
              data: {
                query: json.query ?? data.query.trim(),
                results: Array.isArray(json.results) ? json.results : [],
                images: Array.isArray(json.images) ? json.images : [],
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
    mode,
    onCheckCanUseAi,
    onPaymentRequired,
    onSendFollowUp,
    onSetView,
    onUpdateDatabase,
    projectId,
    secrets,
    selectedModel,
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

  const handleCopyLiveUrl = async () => {
    if (!deployment.liveUrl) return;
    try {
      await navigator.clipboard.writeText(deployment.liveUrl);
      setCopiedLiveUrl(true);
      window.setTimeout(() => setCopiedLiveUrl(false), 2000);
    } catch {
      // ignore clipboard restriction
    }
  };

  const handleCopyCode = async () => {
    if (!latestPreviewHtml) return;
    try {
      await navigator.clipboard.writeText(latestPreviewHtml);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      // ignore clipboard restriction
    }
  };

  // Full-screen Preview Mode: renders built app full-screen (or Living Botanical Wallpaper if not built yet)
  // plus the draggable right-side round blue AI Craft logo button
  if (activeView === 'preview') {
    return (
      <div className="fixed inset-0 w-full h-dvh max-h-dvh overflow-hidden">
        {hasBuiltApp ? (
          <iframe
            ref={previewIframeRef}
            key={`${projectId}-${previewKey}-${secretsFingerprint}`}
            title={`${projectTitle} Preview`}
            srcDoc={connectedPreviewHtml}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
            className="w-full h-full border-0 block bg-white"
          />
        ) : (
          <LivingBotanicalWallpaper isBuilding={isStreaming} />
        )}

        <FloatingLogoMenu
          projectTitle={projectTitle}
          hasBuiltApp={hasBuiltApp}
          isPublished={isPublished}
          onBackToChat={() => onSetView('chat')}
          onViewCode={() => onSetView('code')}
          onShare={handleShare}
          onPublish={onPublish}
          onRefreshPreview={() => setPreviewKey((k) => k + 1)}
          onOpenApps={onOpenApps}
        />
      </div>
    );
  }

  // Code Viewer Mode (accessed from clicking the floating round logo -> View App Code)
  if (activeView === 'code') {
    const selectedCodePart =
      codeParts.find((p) => p.id === activeCodeTab) ?? codeParts[0];

    return (
      <div className="relative h-dvh w-full flex flex-col bg-white overflow-hidden">
        <header className="shrink-0 w-full bg-white border-b border-black/[0.06] pt-safe">
          <div className="w-full max-w-[680px] lg:max-w-[880px] 2xl:max-w-[1060px] mx-auto px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <button
                type="button"
                onClick={() => onSetView('preview')}
                aria-label="Back to Preview"
                className="min-w-[40px] min-h-[40px] rounded-full flex items-center justify-center text-[#0B0B0F] hover:bg-black/[0.04] active:scale-95 transition-all shrink-0"
              >
                <ChevronLeft className="w-6 h-6 stroke-[2]" />
              </button>
              <h1 className="font-display font-bold text-[16px] tracking-[-0.02em] text-[#0B0B0F] truncate">
                {projectTitle} · Code
              </h1>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void handleCopyCode()}
                className="h-9 px-3 rounded-xl border border-black/15 bg-white text-xs font-medium text-[#0B0B0F] hover:bg-black/[0.03] flex items-center gap-1.5 whitespace-nowrap"
              >
                {copiedCode ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#0D6BFF]" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy Code</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => onSetView('chat')}
                className="h-9 px-3 rounded-xl bg-[#0B0B0F] text-white text-xs font-medium whitespace-nowrap"
              >
                Chat
              </button>
            </div>
          </div>

          {codeParts.length > 1 && (
            <div className="w-full max-w-[680px] lg:max-w-[880px] 2xl:max-w-[1060px] mx-auto px-3 pb-2 flex items-center gap-1.5 overflow-x-auto">
              {codeParts.map((part) => {
                const isSelected = selectedCodePart.id === part.id;
                return (
                  <button
                    key={part.id}
                    type="button"
                    onClick={() => setActiveCodeTab(part.id)}
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

        <div className="flex-1 min-h-0 overflow-auto bg-[#0F1117] text-[#E4E4E7] p-4">
          <pre className="w-full max-w-[680px] lg:max-w-[880px] 2xl:max-w-[1060px] mx-auto text-[12.5px] leading-relaxed font-mono whitespace-pre-wrap break-words">
            <code>{selectedCodePart?.content || 'No generated code yet.'}</code>
          </pre>
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
            <span className="text-[#52525B] font-medium">
              Target: {theme.label}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowHeaderActions(false);
                  onOpenApps();
                }}
                className="px-3 py-1.5 rounded-full bg-[#F4F4F6] text-[#0B0B0F] font-medium hover:bg-[#E4E4E7]"
              >
                Apps
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowHeaderActions(false);
                  onBack();
                }}
                className="px-3 py-1.5 rounded-full bg-[#0B0B0F] text-white font-medium"
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
              const stepBuildingDone = turn.phase === 'complete';

              const turnModelName =
                turn.modelName ||
                models.find((m) => m.id === turn.modelId)?.name ||
                activeModel?.name ||
                'AICRAFT';

              return (
                <article key={turn.id} className="flex flex-col gap-3.5">
                  {/* User Message Bubble */}
                  <div className="flex justify-end">
                    <div className="max-w-[88%] rounded-2xl rounded-br-sm bg-[#F4F4F6] px-3.5 py-2.5 text-[14.5px] leading-snug text-[#111118]">
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

                  {/* Active AI Model Brand Row with Real-Time Logo Tracking */}
                  <div className="flex items-center justify-between pt-0.5 gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <ProviderLogo
                        provider={turn.modelProvider || activeModel?.provider}
                        modelId={turn.modelId || selectedModel}
                        size={22}
                        isTracking={isTurnWorking}
                        trackingColor={theme.accentColor}
                      />
                      <div className="min-w-0 flex items-center gap-2">
                        <span className="font-display font-bold text-[14.5px] tracking-[-0.01em] text-[#0B0B0F] truncate">
                          {turnModelName}
                        </span>
                        {isTurnWorking && (
                          <span
                            className="text-[11.5px] font-medium shrink-0"
                            style={{ color: theme.accentColor }}
                          >
                            {turn.phase === 'building'
                              ? isMediaTurn ||
                                activeModel?.category === 'image' ||
                                activeModel?.category === 'music' ||
                                activeModel?.category === 'video'
                                ? 'Creating'
                                : 'Building'
                              : displayAiText.length > 0
                                ? 'Responding'
                                : 'Thinking'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Live Thought Timer Row */}
                  <div className="flex items-center gap-2 text-[13.5px] text-[#71717A]">
                    <Lightbulb className="w-[16px] h-[16px] shrink-0 stroke-[1.8]" />
                    <span className="tabular-nums">
                      {isTurnWorking
                        ? `${turn.phaseLabel} (${
                            turn.startedAt
                              ? Math.max(1, Math.floor((nowMs - turn.startedAt) / 1000))
                              : Math.max(1, turn.thoughtSeconds)
                          }s)`
                        : isPausedTurn
                          ? `Paused at ${Math.max(1, turn.thoughtSeconds)}s`
                          : `Thought for ${Math.max(1, turn.thoughtSeconds)}s`}
                    </span>
                  </div>

                  {/* Calm Replit-Style Step-by-Step Thinking & Blue-Checkmark Plan */}
                  {turn.planSteps && turn.planSteps.length > 0 && (
                    <div className="rounded-2xl border border-black/[0.08] bg-[#F7F7FA] px-4 py-3 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-[#52525B]">
                          Real-Time Build Plan
                        </span>
                        <span className="text-[11.5px] font-medium text-[#0D5BFF] tabular-nums">
                          {turn.phase === 'understanding'
                            ? `Planning · Step ${turn.planSteps.length}`
                            : `${turn.planSteps.length} ${turn.planSteps.length === 1 ? 'step' : 'steps'}`}
                        </span>
                      </div>
                      <ul className="space-y-1.5 text-[13px] leading-snug">
                        {turn.planSteps.map((step, idx) => {
                          const isActivePlanStep =
                            turn.phase === 'understanding' &&
                            idx === turn.planSteps!.length - 1;
                          return (
                            <li
                              key={`${turn.id}-plan-${idx}`}
                              className="flex items-start gap-2"
                            >
                              {isActivePlanStep ? (
                                <Loader2 className="w-3.5 h-3.5 mt-0.5 animate-spin text-[#0D5BFF] shrink-0" />
                              ) : (
                                <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-[#0D5BFF] shrink-0" />
                              )}
                              <span
                                className={
                                  isActivePlanStep
                                    ? 'text-[#111118] font-medium'
                                    : 'text-[#3F3F46]'
                                }
                              >
                                {step}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {/* Live Horizontally Scrollable Multi-Screen Studio Canvas (Real-Time Screen Previews) */}
                  {isBuildTurn &&
                    (turn.phase === 'building' ||
                      turn.phase === 'paused' ||
                      turn.phase === 'complete' ||
                      Boolean(turn.previewHtml) ||
                      turn.files.length > 0) && (
                      <ScreenStudioStrip
                        html={turn.previewHtml}
                        mode={mode}
                        isWorking={isTurnWorking}
                        phaseLabel={turn.phaseLabel}
                        plannedTotalCount={
                          turn.planSteps && turn.planSteps.length >= 4
                            ? turn.planSteps.length
                            : 5
                        }
                        onOpenPreview={() => onSetView('preview')}
                      />
                    )}

                  {/* Live Streaming AI Response Prose (Raw code strictly excluded) */}
                  {turn.errorMessage ? (
                    <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-700 leading-relaxed flex flex-col gap-2.5">
                      <span>{turn.errorMessage}</span>
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
                    <div className="flex items-start justify-between gap-2.5">
                      <div className="flex-1 min-w-0 text-[15.5px] leading-[1.58] tracking-[-0.005em] text-[#111118] whitespace-pre-wrap">
                        {displayAiText || (
                          <span className="text-[#71717A]">
                            {isBuildTurn && turn.phase !== 'understanding'
                              ? isTurnWorking
                                ? `Building your real-time ${
                                    mode === 'mobile'
                                      ? 'iOS & Android'
                                      : 'full-stack web'
                                  } app...`
                                : 'Your real-time app is ready. Tap Preview to open it.'
                              : turn.phase === 'building'
                                ? turn.phaseLabel || 'Creating media...'
                                : turn.phase === 'understanding'
                                  ? 'Thinking...'
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

                  {/* Clean Live App Link Card (Copy URL only — no Enabled AI / Open buttons) */}
                  {isBuildTurn &&
                    stepBuildingDone &&
                    Boolean(turn.previewHtml) &&
                    turn.id === latestBuiltTurnId &&
                    (deployment.liveUrl || deployment.livePublishing) && (
                      <div className="rounded-2xl border border-black/[0.08] bg-[#F7F7FA] px-3.5 py-3 flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#0B0B0F]">
                            <Link2 className="w-3.5 h-3.5 text-[#6D4AFF] shrink-0" />
                            <span>Live App Link</span>
                          </div>
                          {deployment.livePublishing ? (
                            <span className="inline-flex items-center gap-1 text-[11.5px] text-[#71717A]">
                              <Loader2 className="w-3 h-3 animate-spin text-[#6D4AFF]" />
                              <span>Generating link...</span>
                            </span>
                          ) : deployment.version > 0 ? (
                            <span className="text-[11.5px] font-medium text-emerald-700 tabular-nums">
                              Live · v{deployment.version}
                            </span>
                          ) : null}
                        </div>

                        {deployment.liveUrl && (
                          <div className="rounded-xl border border-black/[0.09] bg-white px-3 py-2 flex items-center gap-2.5">
                            {deployment.logoUrl && (
                              <img
                                src={deployment.logoUrl}
                                alt={`${projectTitle} icon`}
                                className="w-8 h-8 rounded-lg object-cover border border-black/10 shrink-0"
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <span className="block font-mono text-[12px] text-[#0B0B0F] truncate select-all">
                                {deployment.liveUrl}
                              </span>
                              {deployment.logoUrl && (
                                <span className="block text-[10.5px] text-[#71717A] truncate">
                                  Custom app icon · Add to Home Screen ready
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleCopyLiveUrl()}
                              aria-label="Copy live app link"
                              className="min-h-[36px] px-3 rounded-lg border border-black/[0.1] bg-[#FAFAFC] hover:bg-black/[0.04] text-[12px] font-medium text-[#0B0B0F] inline-flex items-center gap-1.5 shrink-0 active:scale-95 transition-all"
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

                  {/* Post-Build One-Tap Follow-Up Suggestions (Auto-Send on Tap) */}
                  {turn.phase === 'complete' &&
                    isBuildTurn &&
                    !turn.errorMessage &&
                    turn.suggestions &&
                    turn.suggestions.length > 0 && (
                      <div className="flex flex-col gap-2 pt-0.5">
                        <span className="text-[12px] font-semibold uppercase tracking-[0.04em] text-[#71717A] px-0.5">
                          Tap to add next
                        </span>
                        <div className="flex flex-col gap-1.5">
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
                              className="w-full text-left rounded-xl border border-black/[0.08] bg-white hover:bg-[#F7F7FA] hover:border-black/15 px-3.5 py-2.5 flex items-center justify-between gap-2.5 text-[13.5px] font-medium text-[#111118] transition-all active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <span className="leading-snug">{suggestion}</span>
                              <ArrowUpRight
                                className="w-4 h-4 shrink-0"
                                style={{ color: theme.accentColor }}
                              />
                            </button>
                          ))}
                        </div>
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

      {/* Bottom Follow-Up Chat Composer */}
      <div className="shrink-0 w-full bg-white border-t border-black/[0.05] pb-safe [[data-platform=android]_&]:pb-5">
        <div className="w-full max-w-[520px] md:max-w-[700px] lg:max-w-[860px] 2xl:max-w-[1020px] mx-auto px-4 pt-2 pb-2.5">
          {inlineNotice ? (
            <p
              role="status"
              className="mb-1.5 px-3 py-1.5 rounded-xl bg-red-50 border border-red-200 text-[12px] font-medium text-red-700 text-center"
            >
              {inlineNotice}
            </p>
          ) : null}
          {/* Micro Status Strip above Composer */}
          <div className="px-1 pb-2 flex items-center justify-between text-[13.5px]">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onOpenUpgrade}
                aria-label={
                  isOwner
                    ? 'Owner account: Free unlimited app builds'
                    : `AI Craft credits: ${credits.toLocaleString()}. Tap to upgrade or add credits`
                }
                className="flex items-center gap-1.5 rounded-full px-1.5 py-1 -ml-1.5 hover:bg-black/[0.04] active:scale-95 transition-all"
              >
                <span
                  className="w-[18px] h-[18px] rounded-full flex items-center justify-center shrink-0"
                  style={{
                    background:
                      !isOwner && credits <= 0
                        ? 'linear-gradient(135deg, #FCA5A5 0%, #EF4444 65%, #B91C1C 100%)'
                        : mode === 'mobile'
                          ? 'linear-gradient(135deg, #C4B5FD 0%, #7A68F6 60%, #5B21B6 100%)'
                          : 'linear-gradient(135deg, #F0ABFC 0%, #8B5CF6 60%, #6D28D9 100%)',
                  }}
                  aria-hidden="true"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M14.5 9.5L12 16L9.5 14.5L12 8L14.5 9.5Z"
                      fill="white"
                      fillOpacity="0.95"
                    />
                  </svg>
                </span>
                <span
                  className={`font-display font-semibold tabular-nums ${
                    !isOwner && credits <= 0 ? 'text-red-600' : 'text-[#111118]'
                  }`}
                >
                  {isOwner ? 'Owner · Free' : credits.toLocaleString()}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setAutoAllow((v) => !v)}
                className="flex items-center gap-1 text-[#52525B] hover:text-[#0B0B0F] font-medium"
              >
                <span>{autoAllow ? 'Always allow' : 'Ask first'}</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onOpenSettings}
                className="flex items-center gap-1 text-[#52525B] hover:text-[#0B0B0F] font-medium"
              >
                <HelpCircle className="w-3.5 h-3.5" />
                <span>AI</span>
              </button>

              <button
                type="button"
                onClick={onOpenUpgrade}
                className="font-semibold text-[#0D5BFF] hover:opacity-80"
              >
                Upgrade
              </button>
            </div>
          </div>

          {/* Rounded Input Card */}
          <div
            className={`relative w-full rounded-[22px] bg-white border shadow-[0_4px_20px_rgba(15,15,30,0.04)] px-4 pt-2.5 pb-2.5 flex flex-col gap-1.5 ${
              isRestricted ? 'border-amber-400/70' : 'border-black/[0.09]'
            }`}
          >
            {/* Selected AI Header Bar at the top of the chat box */}
            <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-black/[0.05]">
              <div className="flex items-center gap-2 min-w-0">
                <ProviderLogo
                  provider={activeModel?.provider}
                  modelId={activeModel?.id || selectedModel}
                  size={20}
                  isTracking={isStreaming}
                  trackingColor={theme.accentColor}
                />
                <span className="text-[12.5px] font-medium text-[#18181B] truncate">
                  {activeModel?.name ??
                    (selectedModel === 'auto::free-browser' || selectedModel === 'auto::architect'
                      ? 'AI Craft Auto (Free · No Key)'
                      : modelsLoading
                        ? 'Connecting Free AI...'
                        : selectedModel || 'AI Craft Auto (Free · No Key)')}
                </span>
              </div>

              <div className="flex items-center gap-1.5 -mr-1 shrink-0">
                {isRestricted && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 border border-amber-200 text-amber-800 text-[10.5px] font-semibold">
                    <ShieldAlert className="w-3 h-3" />
                    <span>Restricted</span>
                  </span>
                )}
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
              </div>
            </div>

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
                        : activeModel?.category === 'video'
                          ? 'Describe the video scene to generate...'
                          : activeModel?.category === 'music'
                            ? 'Describe the song, beat, or vibe to compose...'
                            : activeModel?.category === 'image'
                              ? 'Describe the image you want to generate...'
                              : mode === 'mobile'
                                ? 'Ask or describe your mobile app...'
                                : 'Ask or describe your web app...'
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

            <div className="flex items-center justify-between gap-1.5 pt-0.5">
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

              {/* Center: Deploy, Database, Secrets evenly spaced */}
              <div className="flex-1 min-w-0 grid grid-cols-3 items-center gap-0.5 px-0.5">
                <button
                  type="button"
                  onClick={() => setActiveDrawer('deploy')}
                  aria-label="Open project deployment panel"
                  className={`w-full min-h-[38px] px-1 rounded-xl flex flex-col items-center justify-center gap-[3px] hover:bg-black/[0.04] active:scale-95 transition-all ${
                    isPublished ? 'text-[#6D4AFF]' : 'text-[#52525B] hover:text-[#0B0B0F]'
                  }`}
                >
                  <Rocket className="w-[14px] h-[14px] stroke-[1.9] shrink-0" />
                  <span className="text-[10px] leading-none font-medium tracking-[-0.01em] whitespace-nowrap">
                    Deploy
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveDrawer('database')}
                  aria-label="Open project database and schema"
                  className={`w-full min-h-[38px] px-1 rounded-xl flex flex-col items-center justify-center gap-[3px] hover:bg-black/[0.04] active:scale-95 transition-all ${
                    databaseConfig.tables.length > 0
                      ? 'text-[#6D4AFF]'
                      : 'text-[#52525B] hover:text-[#0B0B0F]'
                  }`}
                >
                  <Database className="w-[14px] h-[14px] stroke-[1.9] shrink-0" />
                  <span className="text-[10px] leading-none font-medium tracking-[-0.01em] whitespace-nowrap">
                    Database
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveDrawer('secrets')}
                  aria-label="Open project secrets and environment variables"
                  className={`w-full min-h-[38px] px-1 rounded-xl flex flex-col items-center justify-center gap-[3px] hover:bg-black/[0.04] active:scale-95 transition-all ${
                    secrets.length > 0
                      ? 'text-[#6D4AFF]'
                      : 'text-[#52525B] hover:text-[#0B0B0F]'
                  }`}
                >
                  <KeyRound className="w-[14px] h-[14px] stroke-[1.9] shrink-0" />
                  <span className="text-[10px] leading-none font-medium tracking-[-0.01em] whitespace-nowrap">
                    Secrets
                  </span>
                </button>
              </div>

              {/* Right: Send Button */}
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
                {isStreaming ? (
                  <Loader2 className="w-[17px] h-[17px] animate-spin" />
                ) : (
                  <ArrowUp className="w-[18px] h-[18px] stroke-[2.4]" />
                )}
              </button>
            </div>
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
        onDeploy={(slug) => onDeployProject(slug)}
        onOpenPreview={() => onSetView('preview')}
        onOpenCode={() => onSetView('code')}
        onShare={handleShare}
      />
    </div>
  );
}
