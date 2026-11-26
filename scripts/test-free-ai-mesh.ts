/**
 * AgentRouter engine test (run against local mock OpenAI-compatible server).
 *
 * Asserts:
 *   1. Only AgentRouter is registered (no Pollinations / keyless providers).
 *   2. Model options surface AgentRouter models (`agentrouter::auto`, etc.).
 *   3. streamFreeAiMesh & completeFreeAiMesh & streamServerFreeAiRealTime stream/return text.
 *   4. Error cooldown classifications (busy, auth 401, rate-limit 429).
 *   5. Bounded cooldown wait self-heals on short cooldowns.
 *   6. Daily quota failover across AgentRouter models and clean error on exhaustion.
 */
import { scrubAiEnv } from './_testEnv.js';
import { spawn } from 'node:child_process';
import path from 'node:path';

scrubAiEnv();
process.env.AGENTROUTER_API_KEY = 'sk-test-agentrouter-key';
process.env.AGENTROUTER_BASE_URL = 'http://127.0.0.1:4592/v1';
process.env.AGENTROUTER_MODELS = 'gpt-6.2-sol,gpt-6.2-astra';

const mockScript = path.join(import.meta.dirname, 'mock-free-ai-server.mjs');
const mock = spawn('node', [mockScript, 'streaming', '4592'], { stdio: 'inherit' });
const killMocks = () => {
  if (!mock.killed) mock.kill('SIGTERM');
};
process.on('exit', killMocks);

async function waitForPort(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`mock on :${port} did not start`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
await waitForPort(4592);

const {
  streamFreeAiMesh,
  completeFreeAiMesh,
  isFreeAiMeshAvailable,
  getFreeAiMeshStatus,
  getFreeMeshModelOptions,
  cooldownForMeshError,
  getMeshDailyUsage,
  resetMeshDailyUsage,
  FreeAiMeshAllFailedError,
} = await import('../api/_freeAiMesh.js');
const { streamServerFreeAiRealTime } = await import('../api/_realtimeEngine.js');
const { buildCandidateCooldownKey, markGatewayCandidateCooldown } = await import(
  '../api/_aiGateways.js'
);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// --- 1: status ------------------------------------------------------------
assert(isFreeAiMeshAvailable(), 'AgentRouter engine should be available when configured');
const status = getFreeAiMeshStatus();
const configured = status.providers.filter((p) => p.configured).map((p) => p.id);
console.log('configured providers:', configured.join(', '));
assert(
  configured.length === 1 && configured[0] === 'agentrouter',
  `expected only agentrouter configured, got ${configured.join(', ')}`
);
assert(!status.hasKeyless && !status.pollinationsConfigured, 'keyless/pollinations must be false');

// --- 2: model options -----------------------------------------------------
const options = getFreeMeshModelOptions();
assert(options[0]?.id === 'agentrouter::auto', 'first option must be agentrouter::auto');
assert(
  options.every((m) => m.id.startsWith('agentrouter::')),
  'all model options must belong to agentrouter'
);

// --- 3: streaming & non-streaming ----------------------------------------
const seenModels: string[] = [];
const chunks: string[] = [];
const result1 = await streamFreeAiMesh({
  taskKind: 'chat',
  systemPrompt: 'You are a helpful assistant.',
  historyMessages: [],
  userPrompt: 'Say hello',
  onModelMeta: (m) => seenModels.push(m.modelId),
  onContentChunk: (c) => chunks.push(c),
});
assert(result1.provider === 'agentrouter', `expected agentrouter provider, got ${result1.provider}`);
assert(result1.rawOutput.includes('Build success'), `unexpected output: ${result1.rawOutput}`);
assert(chunks.length >= 1, 'expected streamed chunks');
assert(seenModels.some((m) => m.startsWith('agentrouter::')), 'expected agentrouter model meta');

const completed = await completeFreeAiMesh({
  taskKind: 'build',
  systemPrompt: 'Repair engine.',
  userPrompt: 'Fix the html',
  timeoutMs: 8000,
});
assert(typeof completed === 'string' && completed.includes('Build success'), 'completeFreeAiMesh failed');

let engineText = '';
const engineResult = await streamServerFreeAiRealTime({
  initialRoute: 'chat',
  systemPrompt: 'You are a helpful assistant.',
  historyMessages: [],
  userPrompt: 'hello',
  onContentChunk: (c) => {
    engineText += c;
  },
});
assert(engineResult.provider === 'agentrouter', 'engine provider must be agentrouter');
assert(engineText.includes('Build success'), 'engine should stream chunks via onContentChunk');

// --- 4: error cooldown classification ------------------------------------
const authCooldown = cooldownForMeshError({ status: 401, message: 'Invalid API Key!' });
assert(authCooldown.ms <= 20_000 && !authCooldown.hard, 'auth cooldown should stay short');

const rateLimitCooldown = cooldownForMeshError({ status: 429, message: 'Rate limit reached.' });
assert(rateLimitCooldown.ms >= 30_000, 'rate limit should set cooldown >= 30s');

const { FREE_MODEL_CATALOG } = await import('../api/_freeAiCatalog.js');
// --- 5: bounded cooldown wait & self-heal ---------------------------------
for (const model of FREE_MODEL_CATALOG.agentrouter) {
  markGatewayCandidateCooldown(
    buildCandidateCooldownKey('mesh:agentrouter', 'sk-test-agentrouter-key', model),
    2_500,
    false
  );
}
const healStartedAt = Date.now();
const healed = await streamFreeAiMesh({
  taskKind: 'build',
  systemPrompt: 'sys',
  userPrompt: 'Say hello after cooldown',
});
const healElapsed = Date.now() - healStartedAt;
assert(healed.rawOutput.includes('Build success'), 'walk must self-heal after cooldown');
assert(healElapsed >= 2_000, `expected cooldown wait >= 2000ms, got ${healElapsed}ms`);

// --- 6: daily quota failover ---------------------------------------------
resetMeshDailyUsage();
process.env.MESH_DAILY_LIMIT_PER_MODEL = '1';

const quota1 = await streamFreeAiMesh({
  taskKind: 'build',
  systemPrompt: 'sys',
  historyMessages: [],
  userPrompt: 'Say hello',
});
assert(quota1.modelUsed === 'agentrouter::gpt-6.2-sol', `expected gpt-6.2-sol, got ${quota1.modelUsed}`);
const usageAfterFirst = getMeshDailyUsage();
assert(
  (usageAfterFirst['agentrouter|gpt-6.2-sol|' + new Date().toISOString().slice(0, 10)] ?? 0) >= 1,
  'quota should record usage'
);

const quota2 = await streamFreeAiMesh({
  taskKind: 'build',
  systemPrompt: 'sys',
  historyMessages: [],
  userPrompt: 'Say hello again',
});
assert(quota2.modelUsed === 'agentrouter::gpt-6.2-astra', `expected gpt-6.2-astra, got ${quota2.modelUsed}`);

// Drain any remaining candidates then assert quota error
let quotaError: unknown = null;
try {
  for (let i = 0; i < 10; i += 1) {
    await streamFreeAiMesh({
      taskKind: 'build',
      systemPrompt: 'sys',
      historyMessages: [],
      userPrompt: `Drain ${i}`,
    });
  }
} catch (err) {
  quotaError = err;
} finally {
  delete process.env.MESH_DAILY_LIMIT_PER_MODEL;
}
assert(
  quotaError instanceof FreeAiMeshAllFailedError ||
    (quotaError instanceof Error && /AgentRouter/i.test(quotaError.message)),
  `expected AgentRouter error when quota exhausted, got: ${String(quotaError)}`
);

console.log('ALL AGENTROUTER ENGINE TESTS PASSED');
process.exit(0);
