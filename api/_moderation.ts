import fs from 'node:fs';
import path from 'node:path';
import { createClient, type User as SupabaseUser } from '@supabase/supabase-js';
import {
  SB_ACCESS_COOKIE,
  SB_REFRESH_COOKIE,
  getSupabaseConfig,
  parseCookies,
  serializeSupabaseUser,
} from './_supabaseAuth.js';

const OWNER_FALLBACK_EMAILS = [
  'preciousddkid@gmail.com',
  'preciousowenaze4@gmail.com',
];
const MODERATION_BUCKET = 'aicraft-user-data';
const MODERATION_REGISTRY_OBJECT = '__moderation/registry.json';

function getLocalCachePath(): string {
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  return isServerless
    ? '/tmp/.aicraft-moderation-cache.json'
    : path.resolve(process.cwd(), '.aicraft-moderation-cache.json');
}

export type ModerationActionType =
  | 'ban'
  | 'unban'
  | 'verify'
  | 'unverify'
  | 'restrict'
  | 'unrestrict';

export interface UserModerationFlags {
  banned: boolean;
  verified: boolean;
  restricted: boolean;
  banReason?: string;
  updatedAt: string;
}

export interface ManagedUserRecord {
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

interface PersistedRegistryFile {
  version: 1;
  updatedAt: string;
  users: Record<string, ManagedUserRecord>;
}

const memoryRegistry = new Map<string, ManagedUserRecord>();

export function normalizeAuthEmail(email: string | null | undefined): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function getServerOwnerEmails(): string[] {
  const fromEnv =
    typeof process.env.OWNER_ADMIN_EMAIL === 'string'
      ? process.env.OWNER_ADMIN_EMAIL.split(',')
          .map((e) => normalizeAuthEmail(e))
          .filter(Boolean)
      : [];
  return Array.from(new Set([...fromEnv, ...OWNER_FALLBACK_EMAILS]));
}

export function isOwnerEmail(email: string | null | undefined): boolean {
  const normalized = normalizeAuthEmail(email);
  if (!normalized) return false;
  return getServerOwnerEmails().includes(normalized);
}

function createServiceClient() {
  const { url, serviceRoleKey } = getSupabaseConfig();
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function makeRegistryKey(userId?: string | null, email?: string | null): string {
  const cleanEmail = normalizeAuthEmail(email);
  if (cleanEmail) return `email:${cleanEmail}`;
  const cleanId = typeof userId === 'string' ? userId.trim() : '';
  return cleanId ? `id:${cleanId}` : '';
}

function loadDiskCacheOnce() {
  try {
    const filePath = getLocalCachePath();
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw) as PersistedRegistryFile;
    if (parsed && parsed.users && typeof parsed.users === 'object') {
      for (const [k, rec] of Object.entries(parsed.users)) {
        if (rec && typeof rec === 'object' && rec.email) {
          const existing = memoryRegistry.get(k);
          const recTime = Date.parse(rec.updatedAt || '') || 0;
          const memTime = existing ? Date.parse(existing.updatedAt || '') || 0 : -1;
          if (!existing || recTime >= memTime) {
            memoryRegistry.set(k, {
              ...rec,
              isOwner: isOwnerEmail(rec.email),
              banned: isOwnerEmail(rec.email) ? false : Boolean(rec.banned),
              restricted: isOwnerEmail(rec.email) ? false : Boolean(rec.restricted),
              verified: Boolean(rec.verified || isOwnerEmail(rec.email)),
            });
          }
        }
      }
    }
  } catch {
    // ignore cache read failure
  }
}

function writeDiskCacheSnapshot() {
  try {
    const users: Record<string, ManagedUserRecord> = {};
    for (const [k, rec] of memoryRegistry.entries()) {
      users[k] = rec;
    }
    const payload: PersistedRegistryFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      users,
    };
    fs.writeFileSync(getLocalCachePath(), JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // ignore read-only FS error in serverless environments
  }
}

async function ensureModerationBucket(
  adminClient: NonNullable<ReturnType<typeof createServiceClient>>
) {
  try {
    const { data: buckets } = await adminClient.storage.listBuckets();
    if (buckets?.some((b) => b.name === MODERATION_BUCKET)) return;
    await adminClient.storage.createBucket(MODERATION_BUCKET, {
      public: false,
      fileSizeLimit: 10485760,
    });
  } catch {
    // ignore if bucket already exists
  }
}

async function loadCloudRegistry(): Promise<Record<string, ManagedUserRecord>> {
  loadDiskCacheOnce();
  const adminClient = createServiceClient();
  if (!adminClient) {
    const out: Record<string, ManagedUserRecord> = {};
    for (const [k, rec] of memoryRegistry.entries()) out[k] = rec;
    return out;
  }

  try {
    const { data, error } = await adminClient.storage
      .from(MODERATION_BUCKET)
      .download(MODERATION_REGISTRY_OBJECT);
    if (!error && data) {
      const text = await data.text();
      const parsed = JSON.parse(text) as PersistedRegistryFile;
      if (parsed && parsed.users && typeof parsed.users === 'object') {
        for (const [k, rec] of Object.entries(parsed.users)) {
          if (!rec || !rec.email) continue;
          const existing = memoryRegistry.get(k);
          const recTime = Date.parse(rec.updatedAt || '') || 0;
          const memTime = existing ? Date.parse(existing.updatedAt || '') || 0 : -1;
          if (!existing || recTime >= memTime) {
            memoryRegistry.set(k, {
              ...rec,
              isOwner: isOwnerEmail(rec.email),
              banned: isOwnerEmail(rec.email) ? false : Boolean(rec.banned),
              restricted: isOwnerEmail(rec.email) ? false : Boolean(rec.restricted),
              verified: Boolean(rec.verified || isOwnerEmail(rec.email)),
            });
          }
        }
        writeDiskCacheSnapshot();
      }
    }
  } catch {
    // fallback to disk + memory cache cleanly
  }

  const out: Record<string, ManagedUserRecord> = {};
  for (const [k, rec] of memoryRegistry.entries()) out[k] = rec;
  return out;
}

async function saveCloudRegistry(): Promise<void> {
  writeDiskCacheSnapshot();
  const adminClient = createServiceClient();
  if (!adminClient) return;

  try {
    await ensureModerationBucket(adminClient);
    const users: Record<string, ManagedUserRecord> = {};
    for (const [k, rec] of memoryRegistry.entries()) {
      users[k] = rec;
    }
    const payload: PersistedRegistryFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      users,
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    await adminClient.storage.from(MODERATION_BUCKET).upload(MODERATION_REGISTRY_OBJECT, body, {
      upsert: true,
      contentType: 'application/json',
    });
  } catch {
    // disk/memory cache still active cleanly
  }
}

export function extractModerationFlagsFromUser(user: SupabaseUser | null | undefined): UserModerationFlags {
  if (!user) {
    return {
      banned: false,
      verified: false,
      restricted: false,
      updatedAt: new Date(0).toISOString(),
    };
  }
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const raw =
    meta.aicraft_moderation && typeof meta.aicraft_moderation === 'object'
      ? (meta.aicraft_moderation as Record<string, unknown>)
      : {};
  const owner = isOwnerEmail(user.email);
  return {
    banned: owner ? false : Boolean(raw.banned),
    verified: owner ? true : Boolean(raw.verified),
    restricted: owner ? false : Boolean(raw.restricted),
    banReason: typeof raw.banReason === 'string' ? raw.banReason : undefined,
    updatedAt:
      typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt))
        ? raw.updatedAt
        : new Date(0).toISOString(),
  };
}

function buildRecordFromSupabaseUser(
  user: SupabaseUser,
  overrideModeration?: UserModerationFlags
): ManagedUserRecord {
  const base = serializeSupabaseUser(user)!;
  const metaFlags = extractModerationFlagsFromUser(user);
  const metaTs = Date.parse(metaFlags.updatedAt) || 0;
  const overTs = overrideModeration ? Date.parse(overrideModeration.updatedAt) || 0 : -1;
  const effective = overrideModeration && overTs >= metaTs ? overrideModeration : metaFlags;
  const owner = isOwnerEmail(base.email);

  return {
    id: base.id,
    email: base.email,
    name: base.name,
    avatarUrl: base.avatarUrl,
    provider: base.provider,
    isOwner: owner,
    banned: owner ? false : effective.banned,
    verified: owner ? true : effective.verified,
    restricted: owner ? false : effective.restricted,
    banReason: effective.banReason,
    createdAt: user.created_at || new Date().toISOString(),
    lastSignInAt: user.last_sign_in_at || user.updated_at || user.created_at || new Date().toISOString(),
    updatedAt:
      overTs >= metaTs && overrideModeration
        ? overrideModeration.updatedAt
        : metaFlags.updatedAt !== new Date(0).toISOString()
          ? metaFlags.updatedAt
          : user.last_sign_in_at || new Date().toISOString(),
  };
}

export async function recordSignedInUser(user: SupabaseUser | null | undefined): Promise<void> {
  if (!user || !user.email) return;
  const registry = await loadCloudRegistry();
  const key = makeRegistryKey(user.id, user.email);
  if (!key) return;

  const existing = registry[key];
  const existingFlags: UserModerationFlags | undefined = existing
    ? {
        banned: existing.banned,
        verified: existing.verified,
        restricted: existing.restricted,
        banReason: existing.banReason,
        updatedAt: existing.updatedAt,
      }
    : undefined;

  const merged = buildRecordFromSupabaseUser(user, existingFlags);
  merged.lastSignInAt = new Date().toISOString();
  memoryRegistry.set(key, merged);
  await saveCloudRegistry();
}

export async function resolveUserWithModeration(user: SupabaseUser | null | undefined): Promise<{
  serialized: NonNullable<ReturnType<typeof serializeSupabaseUser>> & {
    isOwner: boolean;
    verified: boolean;
    banned: boolean;
    restricted: boolean;
    banReason?: string;
  };
  flags: UserModerationFlags;
} | null> {
  if (!user) return null;
  const registry = await loadCloudRegistry();
  const key = makeRegistryKey(user.id, user.email);
  const existing =
    (key ? registry[key] : undefined) ||
    Object.values(registry).find(
      (r) =>
        (user.id && r.id === user.id) ||
        (user.email && normalizeAuthEmail(r.email) === normalizeAuthEmail(user.email))
    );
  const existingFlags: UserModerationFlags | undefined = existing
    ? {
        banned: existing.banned,
        verified: existing.verified,
        restricted: existing.restricted,
        banReason: existing.banReason,
        updatedAt: existing.updatedAt,
      }
    : undefined;

  const merged = buildRecordFromSupabaseUser(user, existingFlags);
  const serialized = serializeSupabaseUser(user)!;

  return {
    serialized: {
      ...serialized,
      isOwner: merged.isOwner,
      verified: merged.verified,
      banned: merged.banned,
      restricted: merged.restricted,
      ...(merged.banReason ? { banReason: merged.banReason } : {}),
    },
    flags: {
      banned: merged.banned,
      verified: merged.verified,
      restricted: merged.restricted,
      banReason: merged.banReason,
      updatedAt: merged.updatedAt,
    },
  };
}

export async function listAllRealSignedInUsers(): Promise<ManagedUserRecord[]> {
  const registry = await loadCloudRegistry();
  const byEmail = new Map<string, ManagedUserRecord>();

  for (const rec of Object.values(registry)) {
    const cleanEmail = normalizeAuthEmail(rec.email);
    if (!cleanEmail) continue;
    byEmail.set(cleanEmail, {
      ...rec,
      isOwner: isOwnerEmail(cleanEmail),
      banned: isOwnerEmail(cleanEmail) ? false : Boolean(rec.banned),
      restricted: isOwnerEmail(cleanEmail) ? false : Boolean(rec.restricted),
      verified: Boolean(rec.verified || isOwnerEmail(cleanEmail)),
    });
  }

  const adminClient = createServiceClient();
  if (adminClient) {
    try {
      const { data } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 500 });
      const users = data?.users ?? [];
      for (const u of users) {
        if (!u.email) continue;
        // Include only accounts that have actually signed in or confirmed/registered cleanly
        const cleanEmail = normalizeAuthEmail(u.email);
        const existing = byEmail.get(cleanEmail);
        const existingFlags: UserModerationFlags | undefined = existing
          ? {
              banned: existing.banned,
              verified: existing.verified,
              restricted: existing.restricted,
              banReason: existing.banReason,
              updatedAt: existing.updatedAt,
            }
          : undefined;
        const merged = buildRecordFromSupabaseUser(u, existingFlags);
        byEmail.set(cleanEmail, merged);
        const key = makeRegistryKey(u.id, cleanEmail);
        if (key) memoryRegistry.set(key, merged);
      }
    } catch {
      // fall back to registry entries if listUsers is unavailable
    }
  }

  const list = Array.from(byEmail.values());
  list.sort((a, b) => {
    if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
    const ta = Date.parse(a.lastSignInAt || a.createdAt || '') || 0;
    const tb = Date.parse(b.lastSignInAt || b.createdAt || '') || 0;
    return tb - ta;
  });
  return list;
}

export async function applyOwnerModerationAction(params: {
  actorEmail: string;
  targetUserId?: string;
  targetEmail?: string;
  action: ModerationActionType;
  reason?: string;
}): Promise<{ ok: true; user: ManagedUserRecord } | { ok: false; status: number; error: string }> {
  if (!isOwnerEmail(params.actorEmail)) {
    return { ok: false, status: 403, error: 'Only the app owner can manage user moderation.' };
  }

  const cleanTargetEmail = normalizeAuthEmail(params.targetEmail);
  const cleanTargetId = typeof params.targetUserId === 'string' ? params.targetUserId.trim() : '';
  if (!cleanTargetEmail && !cleanTargetId) {
    return { ok: false, status: 400, error: 'Target user email or ID is required.' };
  }

  if (
    cleanTargetEmail &&
    isOwnerEmail(cleanTargetEmail) &&
    (params.action === 'ban' || params.action === 'restrict')
  ) {
    return {
      ok: false,
      status: 400,
      error: 'The app owner account cannot be banned or restricted.',
    };
  }

  const users = await listAllRealSignedInUsers();
  const target = users.find(
    (u) =>
      (cleanTargetId && u.id === cleanTargetId) ||
      (cleanTargetEmail && normalizeAuthEmail(u.email) === cleanTargetEmail)
  );

  if (!target) {
    return {
      ok: false,
      status: 404,
      error: 'User not found among real signed-in accounts.',
    };
  }

  if (target.isOwner && (params.action === 'ban' || params.action === 'restrict')) {
    return {
      ok: false,
      status: 400,
      error: 'The app owner account cannot be banned or restricted.',
    };
  }

  const nowIso = new Date().toISOString();
  const nextFlags: UserModerationFlags = {
    banned: target.banned,
    verified: target.verified,
    restricted: target.restricted,
    banReason: target.banReason,
    updatedAt: nowIso,
  };

  switch (params.action) {
    case 'ban':
      nextFlags.banned = true;
      nextFlags.banReason =
        typeof params.reason === 'string' && params.reason.trim()
          ? params.reason.trim().slice(0, 220)
          : 'Suspended by app owner.';
      break;
    case 'unban':
      nextFlags.banned = false;
      nextFlags.banReason = undefined;
      break;
    case 'verify':
      nextFlags.verified = true;
      break;
    case 'unverify':
      nextFlags.verified = target.isOwner ? true : false;
      break;
    case 'restrict':
      nextFlags.restricted = true;
      break;
    case 'unrestrict':
      nextFlags.restricted = false;
      break;
  }

  const updatedRecord: ManagedUserRecord = {
    ...target,
    banned: nextFlags.banned,
    verified: nextFlags.verified,
    restricted: nextFlags.restricted,
    banReason: nextFlags.banReason,
    updatedAt: nowIso,
  };

  const key = makeRegistryKey(updatedRecord.id, updatedRecord.email);
  if (key) {
    memoryRegistry.set(key, updatedRecord);
  }
  await saveCloudRegistry();

  const adminClient = createServiceClient();
  if (adminClient && updatedRecord.id) {
    try {
      const { data: userRes } = await adminClient.auth.admin.getUserById(updatedRecord.id);
      const existingMeta = (userRes?.user?.user_metadata ?? {}) as Record<string, unknown>;
      await adminClient.auth.admin.updateUserById(updatedRecord.id, {
        user_metadata: {
          ...existingMeta,
          aicraft_moderation: nextFlags,
        },
      });
    } catch {
      // registry persistence still updated immediately
    }
  }

  return { ok: true, user: updatedRecord };
}

export async function authenticateRequestForModeration(request: Request): Promise<{
  user: SupabaseUser | null;
  flags: UserModerationFlags | null;
  isOwner: boolean;
}> {
  const { url, anonKey } = getSupabaseConfig();
  if (!url || !anonKey) {
    return { user: null, flags: null, isOwner: false };
  }

  const cookies = parseCookies(request.headers.get('cookie'));
  const authHeader = request.headers.get('authorization') || '';
  const bearerToken = /^bearer\s+/i.test(authHeader)
    ? authHeader.replace(/^bearer\s+/i, '').trim()
    : '';
  const accessToken = bearerToken || cookies[SB_ACCESS_COOKIE] || '';
  const refreshToken =
    request.headers.get('x-refresh-token')?.trim() || cookies[SB_REFRESH_COOKIE] || '';

  if (!accessToken && !refreshToken) {
    return { user: null, flags: null, isOwner: false };
  }

  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  let user: SupabaseUser | null = null;
  if (accessToken) {
    const { data, error } = await client.auth.getUser(accessToken);
    if (!error && data.user) user = data.user;
  }
  if (!user && refreshToken) {
    const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
    if (!error && data.user) user = data.user;
  }
  if (!user) {
    return { user: null, flags: null, isOwner: false };
  }

  const resolved = await resolveUserWithModeration(user);
  return {
    user,
    flags: resolved?.flags ?? null,
    isOwner: Boolean(resolved?.serialized.isOwner),
  };
}

export async function checkExpressUserModeration(params: {
  cookieHeader?: string;
  authorizationHeader?: string;
  refreshTokenHeader?: string;
}): Promise<{
  user: SupabaseUser | null;
  flags: UserModerationFlags | null;
  isOwner: boolean;
}> {
  const { url, anonKey } = getSupabaseConfig();
  if (!url || !anonKey) {
    return { user: null, flags: null, isOwner: false };
  }

  const cookies = parseCookies(params.cookieHeader || null);
  const authHeader = params.authorizationHeader || '';
  const bearerToken = /^bearer\s+/i.test(authHeader)
    ? authHeader.replace(/^bearer\s+/i, '').trim()
    : '';
  const accessToken = bearerToken || cookies[SB_ACCESS_COOKIE] || '';
  const refreshToken =
    (typeof params.refreshTokenHeader === 'string' ? params.refreshTokenHeader.trim() : '') ||
    cookies[SB_REFRESH_COOKIE] ||
    '';

  if (!accessToken && !refreshToken) {
    return { user: null, flags: null, isOwner: false };
  }

  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  let user: SupabaseUser | null = null;
  if (accessToken) {
    const { data, error } = await client.auth.getUser(accessToken);
    if (!error && data.user) user = data.user;
  }
  if (!user && refreshToken) {
    const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
    if (!error && data.user) user = data.user;
  }
  if (!user) {
    return { user: null, flags: null, isOwner: false };
  }

  const resolved = await resolveUserWithModeration(user);
  return {
    user,
    flags: resolved?.flags ?? null,
    isOwner: Boolean(resolved?.serialized.isOwner),
  };
}
