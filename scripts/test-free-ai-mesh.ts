/**
 * Free AI mesh failover test (run against local mock servers).
 *
 * Expects:
 *   - mock rate-limited server on 127.0.0.1:4591 (SELF_HOSTED_LLM_URL lane)
 *   - mock streaming server  on 127.0.0.1:4592 (POLLINATIONS_BASE_URL lane)
 *   - NO Gemini keys (the Gemini path no longer exists — mesh is the engine)
 *
 * Asserts:
 *   1. streamFreeAiMesh races/skips the 429 self-hosted lane (cooldown) and
 *      returns the Pollinations lane's streamed text.
 *   2. A second stream call does NOT re-hit the cooled-down lane.
 *   3. completeFreeAiMesh returns non-streaming text from the healthy lane.
 *   4. streamServerFreeAiRealTime (engine entry) works with zero API keys.
 *   5. Model pool status: catalog size, active models, daily reset timestamp.
 *   6. Daily quotas: an exhausted (provider, model) is skipped and the next
 *      model continues; when every model is exhausted → friendly all-failed.
 */
// Scrub ambient provider credentials first (CI runners have open networks —
// a leaked GITHUB_TOKEN or GROQ key could answer for real and break assertions),
// then configure only the two local mock lanes this test drives.
import { scrubAiEnv } from './_testEnv.js';
import { spawn } from 'node:child_process';
import path from 'node:path';

scrubAiEnv();
process.env.SELF_HOSTED_LLM_URL = 'http://127.0.0.1:4591/v1';
process.env.SELF_HOSTED_LLM_MODEL = 'mock-rate-limited';
process.env.POLLINATIONS_BASE_URL = 'http://127.0.0.1:4592/openai';
process.env.POLLINATIONS_MODELS = 'openai,openai-fast';

// Spawn the two mock servers this test expects (rate-limited lane + healthy lane).

const mockScript = path.join(import.meta.dirname, 'mock-free-ai-server.mjs');
const mocks = [
  spawn('node', [mockScript, 'rate-limited', '4591'], { stdio: 'inherit' }),
  spawn('node', [mockScript, 'streaming', '4592'], { stdio: 'inherit' }),
];
const killMocks = () => {
  for (const m of mocks) {
    if (!m.killed) m.kill('SIGTERM');
  }
};
process.on('exit', killMocks);

// Wait until both ports accept connections.
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
await waitForPort(4591);
await waitForPort(4592);

const { streamFreeAiMesh, completeFreeAiMesh, isFreeAiMeshAvailable, getFreeAiMeshStatus } =
  await import('../api/_freeAiMesh.js');
const { streamServerFreeAiRealTime } = await import('../api/_realtimeEngine.js');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// --- status ---------------------------------------------------------------
assert(isFreeAiMeshAvailable(), 'mesh should be available with pollinations lane');
const status = getFreeAiMeshStatus();
const configured = status.providers.filter((p) => p.configured).map((p) => p.id);
console.log('configured providers:', configured.join(', '));
assert(configured.includes('self-hosted'), 'self-hosted lane configured');
assert(configured.includes('pollinations'), 'pollinations lane configured');

// --- 5: model pool status (catalog + daily reset) -------------------------
console.log(
  'model pool:',
  JSON.stringify(status.modelPool),
  'resets in',
  Math.round((Date.parse(status.modelPool.dailyResetsAt) - Date.now()) / 60_000),
  'min'
);
assert(
  status.modelPool.catalogSize >= 100,
  `catalog should list 100+ free models, got ${status.modelPool.catalogSize}`
);
assert(
  status.modelPool.activeModels >= 2,
  `at least pollinations models should be active, got ${status.modelPool.activeModels}`
);
const resetsAt = Date.parse(status.modelPool.dailyResetsAt);
assert(
  Number.isFinite(resetsAt) && resetsAt > Date.now() && resetsAt <= Date.now() + 26 * 3600_000,
  'dailyResetsAt should be the next UTC midnight'
);
assert(
  status.modelPool.dailyLimitPerModel >= 1,
  'daily limit per model should be a positive number'
);

// --- 1+2: streaming failover + cooldown ----------------------------------
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
console.log('stream #1:', result1.provider, '→', JSON.stringify(result1.rawOutput));
assert(result1.provider === 'pollinations', `expected pollinations lane, got ${result1.provider}`);
assert(
  result1.rawOutput.includes('free AI mesh'),
  `unexpected output: ${result1.rawOutput}`
);
assert(chunks.length >= 1, 'expected streamed content chunks');
assert(
  seenModels.some((m) => m.includes('self-hosted')),
  'expected self-hosted attempt (meta) before failover'
);
assert(
  seenModels.some((m) => m.includes('pollinations')),
  'expected pollinations attempt meta'
);

// Second call: self-hosted lane is cooling (429 → 90s) → must be skipped.
const seenModels2: string[] = [];
const result2 = await streamFreeAiMesh({
  taskKind: 'chat',
  systemPrompt: 'You are a helpful assistant.',
  historyMessages: [],
  userPrompt: 'Say hello again',
  onModelMeta: (m) => seenModels2.push(m.modelId),
});
console.log('stream #2:', result2.provider, '→', JSON.stringify(result2.rawOutput));
assert(
  !seenModels2.some((m) => m.includes('self-hosted')),
  'cooled-down self-hosted lane must be skipped on second call'
);
assert(result2.provider === 'pollinations', 'second call must use pollinations lane');

// --- 3: non-streaming (repair/design path) -------------------------------
const completed = await completeFreeAiMesh({
  taskKind: 'build',
  systemPrompt: 'Repair engine.',
  userPrompt: 'Fix the html',
  timeoutMs: 8000,
});
console.log('complete:', JSON.stringify(completed));
assert(
  typeof completed === 'string' && completed.includes('free AI mesh'),
  'completeFreeAiMesh should return mock text'
);

// --- 4: engine entry with zero Gemini keys -------------------------------
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
console.log(
  'engine:',
  engineResult.provider,
  engineResult.modelName,
  '→',
  JSON.stringify(engineResult.rawOutput)
);
assert(
  engineResult.rawOutput.includes('free AI mesh'),
  'engine entry should return mesh output without API keys'
);
assert(engineText.includes('free AI mesh'), 'engine should stream chunks via onContentChunk');

// --- 6: daily quotas — exhausted model steps aside, next one continues ----
// Uses taskKind 'build' (sequential walk) so exactly one model is consumed
// per call — deterministic. Chat would race 2 models and consume both.
const { getMeshDailyUsage, resetMeshDailyUsage, FreeAiMeshAllFailedError } = await import(
  '../api/_freeAiMesh.js'
);
resetMeshDailyUsage();
process.env.MESH_DAILY_LIMIT_PER_MODEL = '1';

// First call: openai model serves (usage 0 → 1) — self-hosted still cooling.
const quota1 = await streamFreeAiMesh({
  taskKind: 'build',
  systemPrompt: 'sys',
  historyMessages: [],
  userPrompt: 'Say hello',
});
console.log('quota #1:', quota1.modelUsed);
assert(
  quota1.modelUsed === 'mesh::pollinations::openai',
  `quota call 1 should use pollinations::openai, got ${quota1.modelUsed}`
);
const usageAfterFirst = getMeshDailyUsage();
assert(
  (usageAfterFirst['pollinations|openai|' + new Date().toISOString().slice(0, 10)] ?? 0) >= 1,
  'quota counters should record the successful response'
);

// Second call: the used model is capped for the day → the next model continues.
const quota2 = await streamFreeAiMesh({
  taskKind: 'build',
  systemPrompt: 'sys',
  historyMessages: [],
  userPrompt: 'Say hello again',
});
console.log('quota #2 (failover):', quota2.modelUsed);
assert(
  quota2.modelUsed === 'mesh::pollinations::openai-fast',
  `exhausted model must be skipped and openai-fast continue, got ${quota2.modelUsed}`
);

// Third call: every pollinations model is now capped + self-hosted cooling →
// friendly aggregate error (the "everything busy" path).
let quotaError: unknown = null;
try {
  await streamFreeAiMesh({
    taskKind: 'build',
    systemPrompt: 'sys',
    historyMessages: [],
    userPrompt: 'One more',
  });
} catch (err) {
  quotaError = err;
} finally {
  delete process.env.MESH_DAILY_LIMIT_PER_MODEL;
}
assert(
  quotaError instanceof FreeAiMeshAllFailedError ||
    (quotaError instanceof Error && /busy or unreachable/i.test(quotaError.message)),
  `expected friendly all-failed error when every model is quota-capped, got: ${String(quotaError)}`
);
console.log('quota failover + daily-cap error OK:', (quotaError as Error).message.slice(0, 120));

console.log('ALL MESH TESTS PASSED');
process.exit(0);
