/**
 * E2E: POST /api/craft/stream against local mock AgentRouter backend.
 * Verifies /api/health, /api/models, normal chat SSE, and app build SSE.
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
  AGENTROUTER_API_KEY: 'sk-test-agentrouter-key',
  AGENTROUTER_BASE_URL: 'http://127.0.0.1:4592/v1',
  AGENTROUTER_MODELS: 'gpt-6.2-sol,gpt-6.2-astra',
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
});

await waitForHealth(`http://127.0.0.1:${PORT}/api/health`, 30000);
const health = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
console.log('HEALTH:', JSON.stringify(health));
if (!health.agentRouterConfigured || !health.serverFreeAiReady) {
  console.error('FAIL: health should report agentRouterConfigured & serverFreeAiReady');
  process.exit(1);
}
if (!health.freeAiMesh?.providers?.includes('agentrouter')) {
  console.error('FAIL: freeAiMesh providers should include agentrouter');
  process.exit(1);
}

const models = await (await fetch(`http://127.0.0.1:${PORT}/api/models`)).json();
console.log('MODELS count:', models.models?.length, 'keyless:', models.keyless);
if (!models.agentRouterConfigured || models.keyless !== false) {
  console.error('FAIL: /api/models should report AgentRouter configured and keyless=false');
  process.exit(1);
}
if (!Array.isArray(models.models) || !models.models.every((m: { id: string }) => m.id.startsWith('agentrouter::'))) {
  console.error('FAIL: /api/models should only expose agentrouter:: models');
  process.exit(1);
}

// SSE chat turn
const res = await fetch(`http://127.0.0.1:${PORT}/api/craft/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    projectId: 'e2e-agentrouter-test',
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
    projectId: 'e2e-agentrouter-test',
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

const buildDone = buildEvents.find((e) => e.type === 'done');
const previewHtml = String(buildDone?.previewHtml ?? '');
if (!previewHtml.includes('<!DOCTYPE html>') || !previewHtml.includes('Mesh Todo')) {
  console.error('FAIL: previewHtml missing expected build HTML');
  process.exit(1);
}

console.log('E2E AGENTROUTER STREAM TEST PASSED');
cleanup();
process.exit(0);
