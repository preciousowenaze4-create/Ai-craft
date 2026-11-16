import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Ban,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const loadUsers = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      setErrorMsg(null);
      try {
        const res = await fetch('/api/admin', {
          method: 'GET',
          headers: { ...authHeaders },
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          users?: ManagedUserItem[];
          error?: string;
        };
        if (!res.ok || !Array.isArray(data.users)) {
          throw new Error(data.error || 'Could not load signed-in users.');
        }
        setUsers(data.users);
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : 'Unable to fetch signed-in users.'
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [authHeaders]
  );

  useEffect(() => {
    void loadUsers(false);
  }, [loadUsers]);

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

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2 overflow-hidden">
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
            onClick={() => void loadUsers(false)}
            disabled={refreshing}
            aria-label="Refresh users list"
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
