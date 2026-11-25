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

type AppTablesMap = Record<string, AppTableRow[]>;

const WORKSPACE_BUCKET = 'aicraft-user-data';
const LOCAL_DATA_DIR = '/tmp/aicraft-app-data';
const memoryAppData = new Map<string, AppTablesMap>();
const appWriteLocks = new Map<string, Promise<unknown>>();

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
    const filePath = path.join(LOCAL_DATA_DIR, `${appId}.json`);
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

function writeLocalAppData(appId: string, tables: AppTablesMap): void {
  try {
    fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(LOCAL_DATA_DIR, `${appId}.json`),
      JSON.stringify(tables),
      'utf8'
    );
  } catch {
    // ignore read-only fs
  }
}

async function loadAppDataMap(rawAppId: string): Promise<AppTablesMap> {
  const appId = sanitizeAppId(rawAppId);
  const cached = memoryAppData.get(appId);
  if (cached) return cached;

  const local = readLocalAppData(appId);
  if (local) {
    memoryAppData.set(appId, local);
    return local;
  }

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
  return withAppLock(appId, async () => {
    const dataMap = await loadAppDataMap(appId);
    const existing = Array.isArray(dataMap[table]) ? dataMap[table].slice() : [];
    const providedId =
      typeof payload.id === 'string' && payload.id.trim()
        ? payload.id.trim().slice(0, 120)
        : `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const nowIso = new Date().toISOString();
    const row: AppTableRow = {
      ...payload,
      id: providedId,
      created_at:
        typeof payload.created_at === 'string' && payload.created_at.trim()
          ? payload.created_at
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
  return withAppLock(appId, async () => {
    const dataMap = await loadAppDataMap(appId);
    const existing = Array.isArray(dataMap[table]) ? dataMap[table] : [];
    let updated: AppTableRow | null = null;
    const nextRows = existing.map((row) => {
      if (row && row.id === rowId) {
        updated = {
          ...row,
          ...patch,
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
