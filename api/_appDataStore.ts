import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from './_supabaseAuth.js';
import { sanitizeAppId } from './_appsStore.js';

export type AppTableRow = Record<string, unknown> & {
  id: string;
  created_at: string;
  updated_at?: string;
};

export type AppTablesMap = Record<string, AppTableRow[]>;

const WORKSPACE_BUCKET = 'aicraft-user-data';
const FALLBACK_TMP_DIR = '/tmp/aicraft-app-data';
const memoryAppData = new Map<string, AppTablesMap>();
const appWriteLocks = new Map<string, Promise<unknown>>();
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function resolveLocalDataDir(): string {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return FALLBACK_TMP_DIR;
  }
  const preferred = path.resolve(process.cwd(), '.aicraft-data', 'app-data');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    return FALLBACK_TMP_DIR;
  }
}

const LOCAL_DATA_DIR = resolveLocalDataDir();

function resolveConfinedAppFilePath(appId: string): string {
  const baseDir = path.resolve(LOCAL_DATA_DIR);
  const safeId = sanitizeAppId(appId);
  const targetPath = path.resolve(baseDir, `${safeId}.json`);
  if (!targetPath.startsWith(baseDir + path.sep)) {
    throw new Error('Invalid app database path.');
  }
  return targetPath;
}

function sanitizeRowPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (!key || FORBIDDEN_KEYS.has(key)) continue;
    if (typeof value === 'function' || typeof value === 'symbol') continue;
    out[key] = value;
  }
  return out;
}

function createSupabaseServiceClient() {
  const { url, serviceRoleKey } = getSupabaseConfig();
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export function sanitizeTableName(raw: string): string {
  const cleaned = String(raw || 'items')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || 'items';
}

function withAppLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
  const prev = appWriteLocks.get(appId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  appWriteLocks.set(
    appId,
    next.catch(() => {})
  );
  return next;
}

function readLocalAppData(appId: string): AppTablesMap | null {
  try {
    const filePath = resolveConfinedAppFilePath(appId);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AppTablesMap;
    }
    return null;
  } catch {
    return null;
  }
}

function writeLocalAppData(appId: string, tables: AppTablesMap): boolean {
  try {
    fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
    const filePath = resolveConfinedAppFilePath(appId);
    fs.writeFileSync(filePath, JSON.stringify(tables, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function loadAppDataMap(rawAppId: string): Promise<AppTablesMap> {
  const appId = sanitizeAppId(rawAppId);
  const local = readLocalAppData(appId);
  if (local) {
    memoryAppData.set(appId, local);
    return local;
  }

  const cached = memoryAppData.get(appId);
  if (cached) return cached;

  try {
    const adminClient = createSupabaseServiceClient();
    if (adminClient) {
      const { data, error } = await adminClient.storage
        .from(WORKSPACE_BUCKET)
        .download(`app-data/${appId}.json`);
      if (!error && data) {
        const text = await data.text();
        const parsed = text ? (JSON.parse(text) as unknown) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const map = parsed as AppTablesMap;
          memoryAppData.set(appId, map);
          writeLocalAppData(appId, map);
          return map;
        }
      }
    }
  } catch {
    // fallback to empty store
  }

  const empty: AppTablesMap = {};
  memoryAppData.set(appId, empty);
  return empty;
}

async function saveAppDataMap(rawAppId: string, tables: AppTablesMap): Promise<void> {
  const appId = sanitizeAppId(rawAppId);
  memoryAppData.set(appId, tables);
  writeLocalAppData(appId, tables);

  try {
    const adminClient = createSupabaseServiceClient();
    if (adminClient) {
      await adminClient.storage
        .from(WORKSPACE_BUCKET)
        .upload(
          `app-data/${appId}.json`,
          Buffer.from(JSON.stringify(tables), 'utf8'),
          {
            contentType: 'application/json',
            upsert: true,
          }
        );
    }
  } catch {
    // local/memory cache remains active
  }
}

export function getAppDataStorageMode(): string {
  const hasCloud = Boolean(createSupabaseServiceClient());
  const isEphemeral = LOCAL_DATA_DIR === FALLBACK_TMP_DIR;
  if (hasCloud) {
    return isEphemeral ? 'cloud+tmp-file' : 'file+cloud';
  }
  return isEphemeral ? 'tmp-file' : 'file';
}

export async function listAllAppTables(rawAppId: string): Promise<{
  appId: string;
  tables: AppTablesMap;
  storageMode: string;
}> {
  const appId = sanitizeAppId(rawAppId);
  const dataMap = await loadAppDataMap(appId);
  const normalized: AppTablesMap = {};
  for (const [tbl, rows] of Object.entries(dataMap)) {
    const cleanTbl = sanitizeTableName(tbl);
    normalized[cleanTbl] = Array.isArray(rows) ? rows.slice() : [];
  }
  return {
    appId,
    tables: normalized,
    storageMode: getAppDataStorageMode(),
  };
}

export async function seedAppTablesIfEmpty(
  rawAppId: string,
  seedTables: Record<string, Record<string, unknown>[]>
): Promise<AppTablesMap> {
  const appId = sanitizeAppId(rawAppId);
  return withAppLock(appId, async () => {
    const dataMap = await loadAppDataMap(appId);
    let mutated = false;
    const nowIso = new Date().toISOString();

    for (const [rawTbl, rawRows] of Object.entries(seedTables || {})) {
      if (!Array.isArray(rawRows) || rawRows.length === 0) continue;
      const table = sanitizeTableName(rawTbl);
      const existing = Array.isArray(dataMap[table]) ? dataMap[table] : [];
      if (existing.length > 0) continue;

      const normalizedRows: AppTableRow[] = [];
      for (let i = 0; i < Math.min(rawRows.length, 200); i += 1) {
        const rawRow = rawRows[i];
        if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) continue;
        const cleanPayload = sanitizeRowPayload(rawRow as Record<string, unknown>);
        const id =
          typeof cleanPayload.id === 'string' && cleanPayload.id.trim()
            ? cleanPayload.id.trim().slice(0, 120)
            : `seed_${table}_${i + 1}`;
        normalizedRows.push({
          ...cleanPayload,
          id,
          created_at:
            typeof cleanPayload.created_at === 'string' && cleanPayload.created_at.trim()
              ? cleanPayload.created_at
              : nowIso,
        });
      }
      if (normalizedRows.length > 0) {
        dataMap[table] = normalizedRows;
        mutated = true;
      }
    }

    if (mutated) {
      await saveAppDataMap(appId, dataMap);
    }
    return dataMap;
  });
}

export async function listAppTableRows(
  rawAppId: string,
  rawTable: string
): Promise<AppTableRow[]> {
  const appId = sanitizeAppId(rawAppId);
  const table = sanitizeTableName(rawTable);
  const dataMap = await loadAppDataMap(appId);
  const rows = dataMap[table];
  return Array.isArray(rows) ? rows.slice() : [];
}

export async function insertAppTableRow(
  rawAppId: string,
  rawTable: string,
  payload: Record<string, unknown>
): Promise<AppTableRow> {
  const appId = sanitizeAppId(rawAppId);
  const table = sanitizeTableName(rawTable);
  const cleanPayload = sanitizeRowPayload(payload);
  return withAppLock(appId, async () => {
    const dataMap = await loadAppDataMap(appId);
    const existing = Array.isArray(dataMap[table]) ? dataMap[table].slice() : [];
    const providedId =
      typeof cleanPayload.id === 'string' && cleanPayload.id.trim()
        ? cleanPayload.id.trim().slice(0, 120)
        : `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const nowIso = new Date().toISOString();
    const row: AppTableRow = {
      ...cleanPayload,
      id: providedId,
      created_at:
        typeof cleanPayload.created_at === 'string' && cleanPayload.created_at.trim()
          ? cleanPayload.created_at
          : nowIso,
    };
    const nextRows = [row, ...existing.filter((r) => r && r.id !== row.id)].slice(0, 1000);
    dataMap[table] = nextRows;
    await saveAppDataMap(appId, dataMap);
    return row;
  });
}

export async function updateAppTableRow(
  rawAppId: string,
  rawTable: string,
  rowId: string,
  patch: Record<string, unknown>
): Promise<AppTableRow | null> {
  const appId = sanitizeAppId(rawAppId);
  const table = sanitizeTableName(rawTable);
  const cleanPatch = sanitizeRowPayload(patch);
  return withAppLock(appId, async () => {
    const dataMap = await loadAppDataMap(appId);
    const existing = Array.isArray(dataMap[table]) ? dataMap[table] : [];
    let updated: AppTableRow | null = null;
    const nextRows = existing.map((row) => {
      if (row && row.id === rowId) {
        updated = {
          ...row,
          ...cleanPatch,
          id: row.id,
          created_at: row.created_at,
          updated_at: new Date().toISOString(),
        };
        return updated;
      }
      return row;
    });
    if (updated) {
      dataMap[table] = nextRows;
      await saveAppDataMap(appId, dataMap);
    }
    return updated;
  });
}

export async function removeAppTableRow(
  rawAppId: string,
  rawTable: string,
  rowId: string
): Promise<boolean> {
  const appId = sanitizeAppId(rawAppId);
  const table = sanitizeTableName(rawTable);
  return withAppLock(appId, async () => {
    const dataMap = await loadAppDataMap(appId);
    const existing = Array.isArray(dataMap[table]) ? dataMap[table] : [];
    const nextRows = existing.filter((row) => !row || row.id !== rowId);
    if (nextRows.length !== existing.length) {
      dataMap[table] = nextRows;
      await saveAppDataMap(appId, dataMap);
    }
    return true;
  });
}

export async function clearAppTableRows(
  rawAppId: string,
  rawTable: string
): Promise<boolean> {
  const appId = sanitizeAppId(rawAppId);
  const table = sanitizeTableName(rawTable);
  return withAppLock(appId, async () => {
    const dataMap = await loadAppDataMap(appId);
    dataMap[table] = [];
    await saveAppDataMap(appId, dataMap);
    return true;
  });
}
