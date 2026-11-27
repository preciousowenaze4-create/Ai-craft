/**
 * E2E: POST /api/craft/stream and /api/media against local mock Gemini backend.
 * Verifies /api/health, /api/models, normal chat SSE, app build SSE, and image generation.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { emptyAiEnv, scrubAiEnv } from './_testEnv.js';

scrubAiEnv();

const children: ChildProcess[] = [];

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', (d) => process.stdout.write(`[${args[1] ?? cmd}] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[${args[1] ?? cmd}:err] ${d}`));
  return child;
}

function cleanup() {
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

run('node', ['scripts/mock-free-ai-server.mjs', 'streaming', '4592']);
await new Promise((r) => setTimeout(r, 600));

const PORT = process.env.E2E_PORT || '4610';
run('npx', ['tsx', 'server.ts'], {
  ...emptyAiEnv(),
  PORT,
  GEMINI_API_KEY: 'AIzaSyTestGeminiKey1234567890',
  GEMINI_API_BASE_URL: 'http://127.0.0.1:4592',
  GEMINI_MODELS: 'gemini-4-hydrogen,gemini-3.1-flash-lite',
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
});

await waitForHealth(`http://127.0.0.1:${PORT}/api/health`, 30000);
const health = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
console.log('HEALTH:', JSON.stringify(health));
if (!health.geminiConfigured || !health.serverFreeAiReady) {
  console.error('FAIL: health should report geminiConfigured & serverFreeAiReady');
  process.exit(1);
}
if (!health.freeAiMesh?.providers?.includes('gemini')) {
  console.error('FAIL: freeAiMesh providers should include gemini');
  process.exit(1);
}

const models = await (await fetch(`http://127.0.0.1:${PORT}/api/models`)).json();
console.log('MODELS count:', models.models?.length, 'keyless:', models.keyless);
if (!models.geminiConfigured || models.keyless !== false) {
  console.error('FAIL: /api/models should report Gemini configured and keyless=false');
  process.exit(1);
}
if (!Array.isArray(models.models) || !models.models.every((m: { id: string }) => m.id.startsWith('gemini::'))) {
  console.error('FAIL: /api/models should only expose gemini:: models');
  process.exit(1);
}

// SSE chat turn
const res = await fetch(`http://127.0.0.1:${PORT}/api/craft/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    projectId: 'e2e-gemini-test',
    turnId: 'turn_e2e_1',
    message: 'hello there',
    mode: 'web',
    options: { forceChat: false, webSearchEnabled: false },
  }),
});
if (!res.ok) {
  console.error('FAIL: stream request failed', await res.text());
  process.exit(1);
}
const text = await res.text();
const events = text
  .split('\n')
  .filter((l) => l.startsWith('data: '))
  .map((l) => {
    try {
      return JSON.parse(l.slice(6));
    } catch {
      return null;
    }
  })
  .filter(Boolean) as Array<Record<string, unknown>>;

const done = events.find((e) => e.type === 'done');
const error = events.find((e) => e.type === 'error');
if (error) {
  console.error('FAIL: SSE error event:', JSON.stringify(error));
  process.exit(1);
}
if (!done || !String(done.fullText ?? '').includes('Build success')) {
  console.error('FAIL: unexpected chat done event:', JSON.stringify(done));
  process.exit(1);
}

// SSE build turn
const buildRes = await fetch(`http://127.0.0.1:${PORT}/api/craft/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    projectId: 'e2e-gemini-test',
    turnId: 'turn_e2e_build',
    message: 'Build me a simple todo app',
    mode: 'web',
    options: { forceChat: false, webSearchEnabled: false },
  }),
});
if (!buildRes.ok) {
  console.error('FAIL: build stream failed', await buildRes.text());
  process.exit(1);
}
const buildText = await buildRes.text();
const buildEvents = buildText
  .split('\n')
  .filter((l) => l.startsWith('data: '))
  .map((l) => {
    try {
      return JSON.parse(l.slice(6));
    } catch {
      return null;
    }
  })
  .filter(Boolean) as Array<Record<string, unknown>>;

const buildMeta = buildEvents.find((e) => e.type === 'meta');
if (buildMeta?.kind !== 'build') {
  console.error('FAIL: build SSE meta event should carry kind=build, got:', JSON.stringify(buildMeta));
  process.exit(1);
}
const buildDone = buildEvents.find((e) => e.type === 'done');
const previewHtml = String(buildDone?.previewHtml ?? '');
if (!previewHtml.includes('<!DOCTYPE html>') || !previewHtml.includes('Mesh Todo')) {
  console.error('FAIL: previewHtml missing expected build HTML');
  process.exit(1);
}

// Local Vue 3 vendor runtime + CORS check for opaque sandboxed blob iframes
const vueRes = await fetch(`http://127.0.0.1:${PORT}/vendor/vue.global.prod.js`);
if (!vueRes.ok || vueRes.headers.get('access-control-allow-origin') !== '*') {
  console.error('FAIL: /vendor/vue.global.prod.js missing 200 or CORS header');
  process.exit(1);
}
const vueJsText = await vueRes.text();
if (!vueJsText.includes('createApp')) {
  console.error('FAIL: /vendor/vue.global.prod.js content unexpected');
  process.exit(1);
}

// Real backend DB POST { row } + PATCH { patch } + GET unwrapping check
const dbAppId = `e2e_db_${Date.now()}`;
const postRowRes = await fetch(`http://127.0.0.1:${PORT}/api/app-data/${dbAppId}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    row: { id: 'msg_1', sender: 'Ada', body: 'Hello live DB', likes: 2 },
  }),
});
const postRowJson = (await postRowRes.json()) as {
  ok?: boolean;
  row?: Record<string, unknown>;
};
if (!postRowJson.ok || postRowJson.row?.sender !== 'Ada' || 'row' in (postRowJson.row || {})) {
  console.error('FAIL: POST /api/app-data did not unwrap { row } cleanly:', JSON.stringify(postRowJson));
  process.exit(1);
}
const patchRowRes = await fetch(
  `http://127.0.0.1:${PORT}/api/app-data/${dbAppId}/messages/msg_1`,
  {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch: { likes: 9 } }),
  }
);
const patchRowJson = (await patchRowRes.json()) as {
  ok?: boolean;
  row?: Record<string, unknown>;
};
if (!patchRowJson.ok || patchRowJson.row?.likes !== 9 || 'patch' in (patchRowJson.row || {})) {
  console.error('FAIL: PATCH /api/app-data did not unwrap { patch } cleanly:', JSON.stringify(patchRowJson));
  process.exit(1);
}
await fetch(`http://127.0.0.1:${PORT}/api/app-data/${dbAppId}/messages`, { method: 'DELETE' });

// /api/media text-to-image & attachment editing
const mediaRes = await fetch(`http://127.0.0.1:${PORT}/api/media`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    kind: 'image',
    prompt: 'Make this a studio portrait',
    attachmentDataUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  }),
});
if (!mediaRes.ok) {
  console.error('FAIL: /api/media failed', await mediaRes.text());
  process.exit(1);
}
const mediaJson = (await mediaRes.json()) as { gateway?: string; dataUrl?: string };
if (mediaJson.gateway !== 'gemini' || !String(mediaJson.dataUrl || '').startsWith('data:image/png;base64,')) {
  console.error('FAIL: unexpected /api/media response:', JSON.stringify(mediaJson));
  process.exit(1);
}

console.log('E2E GEMINI STREAM & MEDIA TEST PASSED');
cleanup();
process.exit(0);
