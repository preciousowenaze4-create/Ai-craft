import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Ban,
  CheckCircle2,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  UserCheck,
  Users,
} from 'lucide-react';

export interface ManagedUserItem {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  provider: string;
  isOwner: boolean;
  banned: boolean;
  verified: boolean;
  restricted: boolean;
  banReason?: string;
  createdAt: string;
  lastSignInAt: string;
  updatedAt: string;
}

export interface GeminiApiUsageSnapshot {
  keyConfigured: boolean;
  keyMask: string;
  dailyDate: string;
  dailyRequestsUsed: number;
  dailyRequestsLimit: number;
  dailyRequestsRemaining: number;
  dailyTokensUsed: number;
  dailyTokensLimit: number;
  dailyTokensRemaining: number;
  cycleRequestsUsed: number;
  cycleTokensUsed: number;
  overallTokensLimit: number;
  overallTokensRemaining: number;
  lifetimeRequestsUsed: number;
  lifetimeTokensUsed: number;
  dailyRemainingPercent: number;
  overallRemainingPercent: number;
  remainingPercent: number;
  quotaExhausted: boolean;
  exhaustedReason?: string;
  lastErrorAt?: string;
  lastUsageAt?: string;
  lastModelId?: string;
  status: 'healthy' | 'warning' | 'critical' | 'exhausted' | 'unconfigured';
  updatedAt: string;
}

type AdminAction =
  | 'ban'
  | 'unban'
  | 'verify'
  | 'unverify'
  | 'restrict'
  | 'unrestrict';

type StatusFilter = 'all' | 'active' | 'verified' | 'restricted' | 'banned';

interface OwnerAdminPanelProps {
  authHeaders: Record<string, string>;
  currentUserId?: string;
}

function formatCompactCount(num: number): string {
  const safe = Math.max(0, Math.round(Number.isFinite(num) ? num : 0));
  if (safe >= 1_000_000) {
    const m = safe / 1_000_000;
    return `${m >= 10 ? m.toFixed(1) : m.toFixed(2).replace(/\.00$/, '')}M`;
  }
  if (safe >= 10_000) {
    return `${(safe / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return safe.toLocaleString();
}

function formatRelativeTime(iso: string): string {
  if (!iso) return 'Just now';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'Recent';
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return 'Active just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatProviderLabel(provider: string): string {
  const clean = (provider || 'email').trim().toLowerCase();
  if (clean === 'google') return 'Google';
  if (clean === 'github') return 'GitHub';
  if (clean === 'apple') return 'Apple';
  return 'Email';
}

export function OwnerAdminPanel({ authHeaders, currentUserId }: OwnerAdminPanelProps) {
  const [users, setUsers] = useState<ManagedUserItem[]>([]);
  const [geminiUsage, setGeminiUsage] = useState<GeminiApiUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const [showLimitEditor, setShowLimitEditor] = useState(false);
  const [quotaBusy, setQuotaBusy] = useState(false);
  const [draftDailyLimit, setDraftDailyLimit] = useState('1500');
  const [draftPoolLimit, setDraftPoolLimit] = useState('2000000');

  const loadAdminData = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const res = await fetch('/api/admin', {
          method: 'GET',
          headers: { ...authHeaders },
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          users?: ManagedUserItem[];
          geminiUsage?: GeminiApiUsageSnapshot;
          error?: string;
        };
        if (!res.ok || !Array.isArray(data.users)) {
          throw new Error(data.error || 'Could not load admin dashboard.');
        }
        setUsers(data.users);
        if (data.geminiUsage) {
          setGeminiUsage(data.geminiUsage);
        }
        if (!silent) setErrorMsg(null);
      } catch (err) {
        if (!silent) {
          setErrorMsg(
            err instanceof Error ? err.message : 'Unable to fetch admin dashboard.'
          );
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [authHeaders]
  );

  useEffect(() => {
    void loadAdminData(false);
  }, [loadAdminData]);

  // Live background sync so remaining Gemini API quota bar draws back in real time as users build
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadAdminData(true);
      }
    }, 3500);
    const onFocus = () => void loadAdminData(true);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadAdminData]);

  useEffect(() => {
    if (geminiUsage && !showLimitEditor) {
      setDraftDailyLimit(String(geminiUsage.dailyRequestsLimit));
      setDraftPoolLimit(String(geminiUsage.overallTokensLimit));
    }
  }, [geminiUsage, showLimitEditor]);

  const handleQuotaAction = async (
    action: 'reset_quota' | 'set_quota_limit',
    overrides?: { dailyRequestsLimit?: number; overallTokensLimit?: number }
  ) => {
    if (quotaBusy) return;
    setQuotaBusy(true);
    setErrorMsg(null);
    try {
      const dailyNum = Number(overrides?.dailyRequestsLimit ?? draftDailyLimit);
      const poolNum = Number(overrides?.overallTokensLimit ?? draftPoolLimit);
      const payload =
        action === 'reset_quota'
          ? { action: 'reset_quota' }
          : {
              action: 'set_quota_limit',
              dailyRequestsLimit:
                Number.isFinite(dailyNum) && dailyNum >= 10 ? Math.round(dailyNum) : undefined,
              overallTokensLimit:
                Number.isFinite(poolNum) && poolNum >= 1000 ? Math.round(poolNum) : undefined,
            };

      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        geminiUsage?: GeminiApiUsageSnapshot;
        error?: string;
      };
      if (!res.ok || !data.geminiUsage) {
        throw new Error(data.error || 'Unable to update Gemini API quota.');
      }
      setGeminiUsage(data.geminiUsage);
      if (action === 'set_quota_limit') {
        setShowLimitEditor(false);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Quota update failed.');
    } finally {
      setQuotaBusy(false);
    }
  };

  const handleAction = async (user: ManagedUserItem, action: AdminAction) => {
    const busyId = `${user.id}:${action}`;
    if (pendingKey) return;
    setPendingKey(busyId);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          userId: user.id,
          email: user.email,
          action,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        user?: ManagedUserItem;
        error?: string;
      };
      if (!res.ok || !data.user) {
        throw new Error(data.error || 'Action could not be completed.');
      }
      setUsers((prev) =>
        prev.map((u) =>
          u.id === data.user!.id || u.email.toLowerCase() === data.user!.email.toLowerCase()
            ? data.user!
            : u
        )
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Moderation update failed.');
    } finally {
      setPendingKey(null);
    }
  };

  const counts = useMemo(() => {
    let verified = 0;
    let banned = 0;
    let restricted = 0;
    for (const u of users) {
      if (u.verified) verified += 1;
      if (u.banned) banned += 1;
      if (u.restricted) restricted += 1;
    }
    return { total: users.length, verified, banned, restricted };
  }, [users]);

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return users.filter((u) => {
      if (filter === 'active' && (u.banned || u.restricted)) return false;
      if (filter === 'verified' && !u.verified) return false;
      if (filter === 'restricted' && !u.restricted) return false;
      if (filter === 'banned' && !u.banned) return false;
      if (!q) return true;
      return (
        u.email.toLowerCase().includes(q) ||
        u.name.toLowerCase().includes(q) ||
        u.provider.toLowerCase().includes(q)
      );
    });
  }, [users, filter, searchQuery]);

  const quotaPct = geminiUsage ? Math.max(0, Math.min(100, geminiUsage.remainingPercent)) : 0;
  const barColorClass = !geminiUsage?.keyConfigured
    ? 'bg-zinc-400'
    : geminiUsage.status === 'exhausted'
      ? 'bg-red-600'
      : geminiUsage.status === 'critical'
        ? 'bg-gradient-to-r from-red-600 to-orange-500'
        : geminiUsage.status === 'warning'
          ? 'bg-gradient-to-r from-amber-500 to-amber-400'
          : 'bg-gradient-to-r from-[#0D5BFF] to-[#2563EB]';

  const statusBadge = !geminiUsage
    ? { label: 'Loading', cls: 'bg-zinc-100 text-zinc-600', dot: 'bg-zinc-400' }
    : !geminiUsage.keyConfigured
      ? { label: 'Key Missing', cls: 'bg-zinc-100 text-zinc-700', dot: 'bg-zinc-400' }
      : geminiUsage.status === 'exhausted'
        ? { label: 'Exhausted', cls: 'bg-red-100 text-red-700', dot: 'bg-red-600' }
        : geminiUsage.status === 'critical'
          ? { label: 'Almost Out', cls: 'bg-orange-100 text-orange-800', dot: 'bg-orange-600 animate-pulse' }
          : geminiUsage.status === 'warning'
            ? { label: 'Running Low', cls: 'bg-amber-100 text-amber-800', dot: 'bg-amber-500' }
            : { label: 'Live', cls: 'bg-emerald-100 text-emerald-800', dot: 'bg-emerald-500 animate-pulse' };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2 overflow-hidden">
      {/* Permanent Shared Gemini API Key Live Quota Bar ("Long Line") */}
      <div className="rounded-[15px] border border-black/[0.08] bg-white px-3 py-2.5 shadow-[0_4px_16px_rgba(15,15,30,0.03)] shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-7 h-7 rounded-lg bg-[#EEF4FF] text-[#0D5BFF] flex items-center justify-center shrink-0">
              <KeyRound className="w-3.5 h-3.5" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="font-display font-bold text-[12.5px] text-[#0B0B0F] truncate">
                  Gemini API Key Pool
                </p>
                <span
                  className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full text-[9.5px] font-semibold shrink-0 ${statusBadge.cls}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${statusBadge.dot}`} />
                  {statusBadge.label}
                </span>
              </div>
              <p className="text-[10px] text-[#71717A] tabular-nums truncate">
                Key {geminiUsage?.keyMask ?? '••••'} · Shared across all users
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setShowLimitEditor((v) => !v)}
              className="h-6 px-2 rounded-full border border-black/10 text-[10px] font-semibold text-[#52525B] hover:text-[#0B0B0F] hover:bg-black/[0.03] inline-flex items-center gap-1 transition-colors"
            >
              <SlidersHorizontal className="w-2.5 h-2.5" />
              <span>Limit</span>
            </button>
            <button
              type="button"
              disabled={quotaBusy}
              onClick={() => void handleQuotaAction('reset_quota')}
              title="Reset quota after recharging or upgrading your Gemini API key"
              className="h-6 px-2 rounded-full bg-[#0B0B0F] text-white text-[10px] font-semibold hover:bg-black/85 active:scale-95 transition-all inline-flex items-center gap-1 disabled:opacity-50"
            >
              {quotaBusy ? (
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
              ) : (
                <RotateCcw className="w-2.5 h-2.5" />
              )}
              <span>Recharged</span>
            </button>
          </div>
        </div>

        {/* Live Remaining Number + Full-Width Long Line */}
        <div className="mt-2">
          <div className="flex items-baseline justify-between gap-2 mb-1">
            <div className="flex items-baseline gap-1.5 min-w-0">
              <span className="font-display font-bold text-[15px] text-[#0B0B0F] tabular-nums leading-none">
                {geminiUsage
                  ? geminiUsage.dailyRequestsRemaining.toLocaleString()
                  : '—'}
              </span>
              <span className="text-[10.5px] font-medium text-[#71717A] tabular-nums truncate">
                / {geminiUsage ? geminiUsage.dailyRequestsLimit.toLocaleString() : '1,500'} daily reqs left
              </span>
            </div>

            <div className="text-right shrink-0">
              <span
                className={`font-display font-bold text-[12.5px] tabular-nums ${
                  geminiUsage?.status === 'exhausted' || quotaPct <= 15
                    ? 'text-red-600'
                    : geminiUsage?.status === 'warning'
                      ? 'text-amber-600'
                      : 'text-[#0D5BFF]'
                }`}
              >
                {geminiUsage ? `${quotaPct.toFixed(1)}%` : '—'}
              </span>
              <span className="text-[10px] text-[#71717A] ml-1 tabular-nums">
                ({geminiUsage ? formatCompactCount(geminiUsage.overallTokensRemaining) : '—'} pool left)
              </span>
            </div>
          </div>

          {/* Permanent Full-Width Long Line Drawing Back With Usage */}
          <div
            role="progressbar"
            aria-label="Shared Gemini API key remaining quota"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(quotaPct)}
            className="w-full h-3 rounded-full bg-[#ECEEF2] border border-black/[0.06] overflow-hidden"
          >
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${barColorClass}`}
              style={{ width: `${quotaPct}%` }}
            />
          </div>

          <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-[#71717A] tabular-nums">
            <span className="truncate">
              Today: {geminiUsage ? geminiUsage.dailyRequestsUsed.toLocaleString() : 0} calls ·{' '}
              {geminiUsage ? formatCompactCount(geminiUsage.dailyTokensUsed) : '0'} tokens
            </span>
            <span className="shrink-0">
              Pool: {geminiUsage ? formatCompactCount(geminiUsage.cycleTokensUsed) : '0'} /{' '}
              {geminiUsage ? formatCompactCount(geminiUsage.overallTokensLimit) : '2M'} · All-time{' '}
              {geminiUsage ? formatCompactCount(geminiUsage.lifetimeTokensUsed) : '0'}
            </span>
          </div>
        </div>

        {(geminiUsage?.quotaExhausted ||
          (geminiUsage?.keyConfigured && quotaPct <= 15)) && (
          <div
            className={`mt-2 rounded-xl px-2.5 py-1.5 text-[10.5px] font-medium flex items-start gap-1.5 ${
              geminiUsage.quotaExhausted
                ? 'bg-red-50 border border-red-200 text-red-700'
                : 'bg-amber-50 border border-amber-200 text-amber-800'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-[1px]" />
            <span>
              {geminiUsage.quotaExhausted
                ? geminiUsage.exhaustedReason ||
                  'Gemini API limit finished — AI builds will stop for everyone until you recharge or upgrade GEMINI_API_KEY and tap Recharged.'
                : 'Gemini free daily limit / token pool is almost finished. Recharge or upgrade GEMINI_API_KEY soon so users are not interrupted.'}
            </span>
          </div>
        )}

        {showLimitEditor && (
          <div className="mt-2 pt-2 border-t border-black/[0.07] flex flex-col gap-1.5">
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
              {[
                { label: 'Free (1.5k/day · 2M)', daily: '1500', pool: '2000000' },
                { label: 'Tier 1 (10k/day · 20M)', daily: '10000', pool: '20000000' },
                { label: 'Scale (50k/day · 100M)', daily: '50000', pool: '100000000' },
              ].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setDraftDailyLimit(preset.daily);
                    setDraftPoolLimit(preset.pool);
                    void handleQuotaAction('set_quota_limit', {
                      dailyRequestsLimit: Number(preset.daily),
                      overallTokensLimit: Number(preset.pool),
                    });
                  }}
                  className="h-6 px-2 rounded-full bg-[#F3F4F6] hover:bg-[#E5E7EB] text-[10px] font-semibold text-[#0B0B0F] whitespace-nowrap shrink-0"
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5 items-center">
              <input
                type="number"
                min={10}
                value={draftDailyLimit}
                onChange={(e) => setDraftDailyLimit(e.target.value)}
                aria-label="Daily request limit"
                placeholder="Daily reqs"
                className="h-7 px-2 rounded-lg bg-[#F5F5F7] border border-black/[0.07] text-[11px] text-[#0B0B0F] tabular-nums focus:outline-none focus:border-[#0D5BFF]"
              />
              <input
                type="number"
                min={1000}
                value={draftPoolLimit}
                onChange={(e) => setDraftPoolLimit(e.target.value)}
                aria-label="Key token pool limit"
                placeholder="Token pool"
                className="h-7 px-2 rounded-lg bg-[#F5F5F7] border border-black/[0.07] text-[11px] text-[#0B0B0F] tabular-nums focus:outline-none focus:border-[#0D5BFF]"
              />
              <button
                type="button"
                disabled={quotaBusy}
                onClick={() => void handleQuotaAction('set_quota_limit')}
                className="h-7 px-2.5 rounded-lg bg-[#0D5BFF] text-white text-[10.5px] font-semibold hover:bg-[#094EE0] disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Owner Header Summary Card */}
      <div className="rounded-[15px] border border-black/[0.08] bg-white px-3 py-2.5 shadow-[0_4px_16px_rgba(15,15,30,0.03)] shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-8 h-8 rounded-xl bg-[#0B0B0F] text-white flex items-center justify-center shrink-0">
              <ShieldCheck className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <p className="font-display font-bold text-[13px] text-[#0B0B0F] leading-tight">
                Owner Admin Console
              </p>
              <p className="text-[10.5px] text-[#71717A] tabular-nums mt-0.5 truncate">
                {counts.total} signed-in · {counts.verified} verified · {counts.restricted} restricted · {counts.banned} banned
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void loadAdminData(false)}
            disabled={refreshing}
            aria-label="Refresh admin dashboard"
            className="w-8 h-8 rounded-full border border-black/12 text-[#52525B] hover:text-[#0B0B0F] hover:bg-black/[0.03] active:scale-95 transition-all flex items-center justify-center shrink-0 disabled:opacity-60"
          >
            {refreshing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        {/* Search & Filter Row */}
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#9CA3AF] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search signed-in user email or name…"
              aria-label="Search signed-in users"
              className="w-full h-8 pl-8 pr-3 rounded-[10px] bg-[#F5F5F7] border border-black/[0.06] text-[12px] text-[#0B0B0F] placeholder:text-[#9CA3AF] focus:outline-none focus:border-[#0D5BFF] focus:bg-white transition-colors"
            />
          </div>

          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
            {(
              [
                { id: 'all', label: `All (${counts.total})` },
                { id: 'verified', label: `Verified (${counts.verified})` },
                { id: 'restricted', label: `Restricted (${counts.restricted})` },
                { id: 'banned', label: `Banned (${counts.banned})` },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={`h-6 px-2.5 rounded-full text-[10.5px] font-semibold whitespace-nowrap transition-colors shrink-0 ${
                  filter === item.id
                    ? 'bg-[#0B0B0F] text-white'
                    : 'bg-[#F3F4F6] text-[#52525B] hover:text-[#0B0B0F]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-[11.5px] font-medium text-red-700 flex items-center gap-2 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{errorMsg}</span>
        </div>
      )}

      {/* Real Signed-In Users Directory */}
      <div className="flex-1 min-h-0 rounded-[15px] border border-black/[0.08] bg-white shadow-[0_4px_16px_rgba(15,15,30,0.03)] flex flex-col overflow-hidden">
        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[#71717A]">
            <Loader2 className="w-5 h-5 animate-spin text-[#0D5BFF]" />
            <p className="text-[12px] font-medium">Loading real signed-in users…</p>
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center px-5 text-center">
            <span className="w-10 h-10 rounded-full bg-[#F4F4F6] text-[#71717A] flex items-center justify-center mb-2.5">
              <Users className="w-5 h-5" />
            </span>
            <p className="font-display font-semibold text-[13.5px] text-[#0B0B0F]">
              {users.length === 0 ? 'No users have signed in yet' : 'No matching users'}
            </p>
            <p className="text-[11.5px] text-[#71717A] mt-1 max-w-[250px]">
              {users.length === 0
                ? 'Only people who sign into AI Craft with Google, GitHub, Apple, or Email will appear here in real time.'
                : 'Try clearing the search box or switching status filter.'}
            </p>
          </div>
        ) : (
          <ul className="flex-1 min-h-0 overflow-y-auto divide-y divide-black/[0.07]">
            {filteredUsers.map((user) => {
              const isSelfOwner = user.isOwner || user.id === currentUserId;
              const banBusy = pendingKey === `${user.id}:ban` || pendingKey === `${user.id}:unban`;
              const verifyBusy =
                pendingKey === `${user.id}:verify` || pendingKey === `${user.id}:unverify`;
              const restrictBusy =
                pendingKey === `${user.id}:restrict` ||
                pendingKey === `${user.id}:unrestrict`;

              return (
                <li key={user.id || user.email} className="flex flex-col bg-white">
                  {/* Action Band Directly On Top Of Each User's Email */}
                  <div className="px-3 py-1.5 bg-[#FAFAFC] border-b border-black/[0.05] flex items-center justify-between gap-1.5 flex-wrap">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button
                        type="button"
                        disabled={Boolean(pendingKey) || isSelfOwner}
                        onClick={() =>
                          void handleAction(user, user.banned ? 'unban' : 'ban')
                        }
                        className={`h-6 px-2.5 rounded-full text-[10.5px] font-semibold inline-flex items-center gap-1 transition-all active:scale-95 disabled:opacity-45 ${
                          user.banned
                            ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                            : 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100'
                        }`}
                      >
                        {banBusy ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : user.banned ? (
                          <UserCheck className="w-3 h-3" />
                        ) : (
                          <Ban className="w-3 h-3" />
                        )}
                        <span>{user.banned ? 'Unban' : 'Ban'}</span>
                      </button>

                      <button
                        type="button"
                        disabled={Boolean(pendingKey)}
                        onClick={() =>
                          void handleAction(user, user.verified ? 'unverify' : 'verify')
                        }
                        className={`h-6 px-2.5 rounded-full text-[10.5px] font-semibold inline-flex items-center gap-1 transition-all active:scale-95 disabled:opacity-45 ${
                          user.verified
                            ? 'bg-[#0D5BFF] text-white hover:bg-[#094EE0]'
                            : 'bg-[#EEF4FF] text-[#0D5BFF] border border-[#0D5BFF]/20 hover:bg-[#E0ECFF]'
                        }`}
                      >
                        {verifyBusy ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <BadgeCheck className="w-3 h-3" />
                        )}
                        <span>{user.verified ? 'Verified' : 'Verify'}</span>
                      </button>

                      <button
                        type="button"
                        disabled={Boolean(pendingKey) || isSelfOwner}
                        onClick={() =>
                          void handleAction(
                            user,
                            user.restricted ? 'unrestrict' : 'restrict'
                          )
                        }
                        className={`h-6 px-2.5 rounded-full text-[10.5px] font-semibold inline-flex items-center gap-1 transition-all active:scale-95 disabled:opacity-45 ${
                          user.restricted
                            ? 'bg-amber-600 text-white hover:bg-amber-700'
                            : 'bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100'
                        }`}
                      >
                        {restrictBusy ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <ShieldAlert className="w-3 h-3" />
                        )}
                        <span>{user.restricted ? 'Unrestrict' : 'Restrict'}</span>
                      </button>
                    </div>

                    <span className="text-[10px] font-medium text-[#71717A] shrink-0">
                      {formatProviderLabel(user.provider)} · {formatRelativeTime(user.lastSignInAt)}
                    </span>
                  </div>

                  {/* User Email & Status Details Directly Under the Band */}
                  <div className="px-3 py-2 flex items-center justify-between gap-2 min-w-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <p className="font-display font-semibold text-[12.5px] text-[#0B0B0F] truncate">
                          {user.email}
                        </p>
                        {user.verified && (
                          <BadgeCheck
                            aria-label="Verified account"
                            className="w-3.5 h-3.5 text-[#0D5BFF] shrink-0"
                          />
                        )}
                        {user.isOwner && (
                          <span className="px-1.5 py-[0.5px] rounded-full bg-[#0B0B0F] text-white text-[9.5px] font-semibold shrink-0">
                            Owner
                          </span>
                        )}
                        {user.banned && (
                          <span className="px-1.5 py-[0.5px] rounded-full bg-red-100 text-red-700 text-[9.5px] font-semibold shrink-0">
                            Banned
                          </span>
                        )}
                        {user.restricted && !user.banned && (
                          <span className="px-1.5 py-[0.5px] rounded-full bg-amber-100 text-amber-800 text-[9.5px] font-semibold shrink-0">
                            Restricted
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-[#71717A] truncate mt-0.5 flex items-center gap-1">
                        <span>{user.name || 'Signed-in User'}</span>
                        {!user.banned && !user.restricted && (
                          <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" />
                        )}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
