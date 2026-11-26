import {
  clearAppTableRows,
  getAppDataStorageMode,
  insertAppTableRow,
  listAllAppTables,
  listAppTableRows,
  removeAppTableRow,
  seedAppTablesIfEmpty,
  updateAppTableRow,
} from './_appDataStore.js';

function parseAppDataRoute(request: Request): {
  appId: string;
  table: string | null;
  rowId: string | null;
} {
  const reqUrl = new URL(request.url, 'http://localhost');
  const routeParam = (reqUrl.searchParams.get('__route') || '').trim();
  const pathFromUrl = reqUrl.pathname.replace(/^\/api\/app-data\/?/i, '');
  const rawSegments = (routeParam || pathFromUrl)
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg).trim();
      } catch {
        return seg.trim();
      }
    })
    .filter(Boolean);

  return {
    appId: rawSegments[0] || '',
    table: rawSegments[1] ?? null,
    rowId: rawSegments[2] ?? null,
  };
}

export async function GET(request: Request): Promise<Response> {
  const { appId, table } = parseAppDataRoute(request);
  if (!appId) {
    return Response.json(
      { ok: false, error: 'Missing project or app id.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (!table) {
    const result = await listAllAppTables(appId);
    return Response.json(
      {
        ok: true,
        appId: result.appId,
        storageMode: result.storageMode,
        tables: result.tables,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const rows = await listAppTableRows(appId, table);
  return Response.json(
    { ok: true, rows, storageMode: getAppDataStorageMode() },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request: Request): Promise<Response> {
  const { appId, table } = parseAppDataRoute(request);
  if (!appId) {
    return Response.json(
      { ok: false, error: 'Missing project or app id.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (!table) {
    const seedTables =
      body.seedTables && typeof body.seedTables === 'object' && !Array.isArray(body.seedTables)
        ? (body.seedTables as Record<string, Record<string, unknown>[]>)
        : {};
    const tables = await seedAppTablesIfEmpty(appId, seedTables);
    return Response.json(
      { ok: true, tables, storageMode: getAppDataStorageMode() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const payload =
    body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const row = await insertAppTableRow(appId, table, payload);
  return Response.json(
    { ok: true, row, storageMode: getAppDataStorageMode() },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function PATCH(request: Request): Promise<Response> {
  const { appId, table, rowId } = parseAppDataRoute(request);
  if (!appId || !table || !rowId) {
    return Response.json(
      { ok: false, error: 'Missing appId, table, or rowId.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const patch = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const row = await updateAppTableRow(appId, table, rowId, patch);
  if (!row) {
    return Response.json(
      { ok: false, error: 'Record not found.' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  return Response.json(
    { ok: true, row, storageMode: getAppDataStorageMode() },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function DELETE(request: Request): Promise<Response> {
  const { appId, table, rowId } = parseAppDataRoute(request);
  if (!appId || !table) {
    return Response.json(
      { ok: false, error: 'Missing appId or table.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (rowId) {
    await removeAppTableRow(appId, table, rowId);
  } else {
    await clearAppTableRows(appId, table);
  }

  return Response.json(
    { ok: true, storageMode: getAppDataStorageMode() },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
