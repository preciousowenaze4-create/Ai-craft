/**
 * E2E: POST /api/craft/stream (forceChat) against local mock AI lanes.
 * Verifies the full SSE pipeline works keyless: mesh failover → done + fullText.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { emptyAiEnv, scrubAiEnv } from './_testEnv.js';

// Strip ambient provider credentials BEFORE spawning the server (it inherits
// process.env) — CI runners have open networks, so a leaked GITHUB_TOKEN or
// default Pollinations URL could answer for real and break assertions.
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

// 1. mock lanes
run('node', ['scripts/mock-free-ai-server.mjs', 'rate-limited', '4591']);
run('node', ['scripts/mock-free-ai-server.mjs', 'streaming', '4592']);
await new Promise((r) => setTimeout(r, 600));

// 2. dev server with mesh env (no Gemini keys). emptyAiEnv() shields the
// spawn from a local .env file: dotenv skips keys already present (even as
// ''), so real credentials can never leak into the test server process.
const PORT = process.env.E2E_PORT || '4610';
const server = run(
  'npx',
  ['tsx', 'server.ts'],
  {
    ...emptyAiEnv(),
    PORT,
    SELF_HOSTED_LLM_URL: 'http://127.0.0.1:4591/v1',
    SELF_HOSTED_LLM_MODEL: 'mock-rate-limited',
    POLLINATIONS_BASE_URL: 'http://127.0.0.1:4592/openai',
    POLLINATIONS_MODELS: 'openai,openai-fast',
    // keep billing/auth out of the way
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
  }
);

await waitForHealth(`http://127.0.0.1:${PORT}/api/health`, 30000);
const health = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
console.log('HEALTH:', JSON.stringify(health));
if (!health.serverFreeAiReady) {
  console.error('FAIL: serverFreeAiReady should be true with mesh lanes');
  process.exit(1);
}
if (!health.freeAiMesh?.providers?.includes('pollinations')) {
  console.error('FAIL: freeAiMesh should list pollinations');
  process.exit(1);
}

const models = await (await fetch(`http://127.0.0.1:${PORT}/api/models`)).json();
console.log(
  'MODELS flags:',
  JSON.stringify({
    serverFreeAiReady: models.serverFreeAiReady,
    pollinationsConfigured: models.pollinationsConfigured,
    keyless: models.keyless,
    freeAiMesh: models.freeAiMesh,
  })
);
if (!models.serverFreeAiReady || !models.keyless) {
  console.error('FAIL: /api/models should report keyless mesh ready');
  process.exit(1);
}

// 3. SSE chat turn (forceChat, no auth, no client credits hint)
const res = await fetch(`http://127.0.0.1:${PORT}/api/craft/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    projectId: 'e2e-mesh-test',
    turnId: 'turn_e2e_1',
    message: 'hello there',
    mode: 'web',
    options: { forceChat: true, webSearchEnabled: false },
  }),
});
console.log('stream HTTP', res.status);
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

const types = events.map((e) => e.type);
console.log('SSE event types:', types.join(', '));

const meta = events.find((e) => e.type === 'meta');
const done = events.find((e) => e.type === 'done');
const error = events.find((e) => e.type === 'error');

if (error) {
  console.error('FAIL: SSE error event:', JSON.stringify(error));
  process.exit(1);
}
if (!done) {
  console.error('FAIL: no done event. events:', JSON.stringify(events.slice(0, 20)));
  process.exit(1);
}
const fullText = String(done.fullText ?? '');
console.log('done.fullText:', JSON.stringify(fullText.slice(0, 200)));
console.log('meta:', JSON.stringify(meta));
if (!fullText.includes('free AI mesh')) {
  console.error('FAIL: fullText missing mesh reply');
  process.exit(1);
}
if (meta && String(meta.modelName ?? '').length === 0) {
  console.error('FAIL: meta missing modelName');
  process.exit(1);
}

// 4. build turn — mock returns a real single-file HTML app over SSE
const buildRes = await fetch(`http://127.0.0.1:${PORT}/api/craft/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    projectId: 'e2e-mesh-test',
    turnId: 'turn_e2e_build',
    message: 'Build me a simple todo app',
    mode: 'web',
    options: { forceChat: false, webSearchEnabled: false },
  }),
});
console.log('build stream HTTP', buildRes.status);
if (!buildRes.ok) {
  console.error('FAIL: build stream request failed', await buildRes.text());
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
console.log('build SSE types:', buildEvents.map((e) => e.type).join(', '));
const buildError = buildEvents.find((e) => e.type === 'error');
const buildDone = buildEvents.find((e) => e.type === 'done');
if (buildError) {
  console.error('FAIL: build SSE error:', JSON.stringify(buildError));
  process.exit(1);
}
if (!buildDone) {
  console.error('FAIL: build done missing:', JSON.stringify(buildEvents.slice(0, 30)));
  process.exit(1);
}
const previewHtml = String(buildDone.previewHtml ?? '');
console.log('build previewHtml bytes:', previewHtml.length);
if (!previewHtml.includes('<!DOCTYPE html>') || !previewHtml.includes('Mesh Todo')) {
  console.error('FAIL: previewHtml is not the expected app');
  process.exit(1);
}

// 3-agent parallel build: the SSE stream must report all three agents and the
// merged final HTML must contain each agent's stamp (architect document +
// designer CSS + engineer JS) — proof that three AIs built at once.
const agentsEvents = buildEvents.filter((e) => e.type === 'agents');
const lastAgents = agentsEvents[agentsEvents.length - 1] as
  | { agents?: Array<{ role: string; status: string }> }
  | undefined;
const agentList = lastAgents?.agents ?? [];
console.log('agents:', JSON.stringify(agentList));
if (agentList.length !== 3) {
  console.error('FAIL: expected 3 agents in SSE snapshot, got', agentList.length);
  process.exit(1);
}
for (const role of ['architect', 'designer', 'engineer']) {
  const agent = agentList.find((a) => a.role === role);
  if (!agent || agent.status !== 'done') {
    console.error(`FAIL: agent ${role} missing or not done:`, agent);
    process.exit(1);
  }
}
const hasReplace = buildEvents.some((e) => e.type === 'previewReplace');
console.log('previewReplace emitted:', hasReplace);
for (const mark of ['mesh-architect-mark', 'mesh-designer-mark', 'mesh-engineer-mark']) {
  if (!previewHtml.includes(mark)) {
    console.error(`FAIL: merged previewHtml missing ${mark} — parallel merge broken`);
    process.exit(1);
  }
}

console.log('E2E STREAM TEST PASSED');
cleanup();
process.exit(0);
