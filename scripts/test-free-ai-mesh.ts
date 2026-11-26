/**
 * Gemini engine test (run against local mock Gemini MLDev server).
 *
 * Asserts:
 *   1. Only Gemini is registered (no Pollinations / AgentRouter / keyless providers).
 *   2. Model options surface Gemini models (`gemini::gemini-4-hydrogen`, etc.).
 *   3. streamFreeAiMesh & completeFreeAiMesh & streamServerFreeAiRealTime stream/return text.
 *   4. generateMediaAsset creates images and forwards user attachments for image editing.
 *   5. Error cooldown classifications (busy, auth 401, rate-limit 429).
 *   6. Bounded cooldown wait self-heals on short cooldowns.
 *   7. Daily quota failover across Gemini models and clean error on exhaustion.
 */
import { scrubAiEnv } from './_testEnv.js';
import { spawn } from 'node:child_process';
import path from 'node:path';

scrubAiEnv();
process.env.GEMINI_API_KEY = 'AIzaSyTestGeminiKey1234567890';
process.env.GEMINI_API_BASE_URL = 'http://127.0.0.1:4592';
process.env.GEMINI_MODELS = 'gemini-4-hydrogen,gemini-3.1-flash-lite';

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
      await fetch(`http://127.0.0.1:${port}/__stats`, { signal: AbortSignal.timeout(500) });
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
const { generateMediaAsset } = await import('../api/_mediaService.js');
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
assert(isFreeAiMeshAvailable(), 'Gemini engine should be available when configured');
const status = getFreeAiMeshStatus();
const configured = status.providers.filter((p) => p.configured).map((p) => p.id);
console.log('configured providers:', configured.join(', '));
assert(
  configured.length === 1 && configured[0] === 'gemini',
  `expected only gemini configured, got ${configured.join(', ')}`
);
assert(!status.hasKeyless && !status.pollinationsConfigured, 'keyless/pollinations must be false');

// --- 2: model options -----------------------------------------------------
const options = getFreeMeshModelOptions();
assert(
  options[0]?.id === 'gemini::gemini-4-hydrogen',
  `first option must be gemini::gemini-4-hydrogen, got ${options[0]?.id}`
);
assert(
  options.every((m) => m.id.startsWith('gemini::')),
  'all model options must belong to gemini'
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
assert(result1.provider === 'gemini', `expected gemini provider, got ${result1.provider}`);
assert(result1.rawOutput.includes('Build success'), `unexpected output: ${result1.rawOutput}`);
assert(chunks.length >= 1, 'expected streamed chunks');
assert(seenModels.some((m) => m.startsWith('gemini::')), 'expected gemini model meta');

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
assert(engineResult.provider === 'gemini', 'engine provider must be gemini');
assert(engineText.includes('Build success'), 'engine should stream chunks via onContentChunk');

// --- 4: Gemini image generation & image-to-image editing ------------------
const textImg = await generateMediaAsset({
  kind: 'image',
  prompt: 'Create an image of a futuristic sunset city',
});
assert(textImg.gateway === 'gemini', `expected gemini media gateway, got ${textImg.gateway}`);
assert(textImg.dataUrl.startsWith('data:image/png;base64,'), 'expected PNG dataUrl from Gemini image model');

const samplePngDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const editImg = await generateMediaAsset({
  kind: 'image',
  prompt: 'Make this photo look like a neon cyberpunk poster',
  attachmentDataUrl: samplePngDataUrl,
});
assert(editImg.gateway === 'gemini', 'image-to-image gateway must be gemini');
assert(editImg.dataUrl.startsWith('data:image/png;base64,'), 'edited image must return PNG dataUrl');
const mockStats = (await (await fetch('http://127.0.0.1:4592/__stats')).json()) as {
  lastImageHasAttachment?: boolean;
};
assert(mockStats.lastImageHasAttachment === true, 'attachment inlineData must reach Gemini image model');

// --- 5: error cooldown classification ------------------------------------
const authCooldown = cooldownForMeshError({ status: 401, message: 'API key not valid' });
assert(authCooldown.ms <= 20_000 && !authCooldown.hard, 'auth cooldown should stay short');

const rateLimitCooldown = cooldownForMeshError({ status: 429, message: 'Quota exceeded.' });
assert(rateLimitCooldown.ms >= 30_000, 'rate limit should set cooldown >= 30s');

// --- 6: bounded cooldown wait & self-heal ---------------------------------
for (const model of ['gemini-4-hydrogen', 'gemini-3.1-flash-lite']) {
  markGatewayCandidateCooldown(
    buildCandidateCooldownKey('gemini', 'AIzaSyTestGeminiKey1234567890', model),
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

// --- 7: daily quota failover ---------------------------------------------
resetMeshDailyUsage();
process.env.MESH_DAILY_LIMIT_PER_MODEL = '1';

const quota1 = await streamFreeAiMesh({
  taskKind: 'build',
  systemPrompt: 'sys',
  historyMessages: [],
  userPrompt: 'Say hello',
});
assert(
  quota1.modelUsed === 'gemini::gemini-4-hydrogen',
  `expected gemini-4-hydrogen, got ${quota1.modelUsed}`
);
const usageAfterFirst = getMeshDailyUsage();
assert(
  (usageAfterFirst['gemini|gemini-4-hydrogen|' + new Date().toISOString().slice(0, 10)] ?? 0) >= 1,
  'quota should record usage'
);

const quota2 = await streamFreeAiMesh({
  taskKind: 'build',
  systemPrompt: 'sys',
  historyMessages: [],
  userPrompt: 'Say hello again',
});
assert(
  quota2.modelUsed === 'gemini::gemini-3.1-flash-lite',
  `expected gemini-3.1-flash-lite, got ${quota2.modelUsed}`
);

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
    (quotaError instanceof Error && /Gemini/i.test(quotaError.message)),
  `expected Gemini error when quota exhausted, got: ${String(quotaError)}`
);

// --- 8: streaming marker & reasoning tag holdback ------------------------
const {
  getSafeStreamingProse,
  hasOpenReasoningTag,
  stripReasoningTags,
} = await import('../api/_builderCore.js');

assert(
  hasOpenReasoningTag('<thinkt Architectural Summary): planning now'),
  'hasOpenReasoningTag must detect open <thinkt tail'
);
assert(
  !hasOpenReasoningTag('<thinkt>done</thinkt>Building now...'),
  'hasOpenReasoningTag must clear once closed'
);
assert(
  stripReasoningTags('<thinkt>hidden</thinkt>Building feed now.') === 'Building feed now.',
  'stripReasoningTags must strip <thinkt> blocks'
);
assert(
  stripReasoningTags('<thinkt Architectural Summary):\nBuilding feed now.\n<<<AICRAFT_APP_HTML>>><html></html>') ===
    'Building feed now.\n<<<AICRAFT_APP_HTML>>><html></html>',
  'stripReasoningTags must strip malformed <thinkt line without dropping HTML'
);
assert(
  getSafeStreamingProse('Building your short-video feed now.\n<<<AIC') ===
    'Building your short-video feed now.',
  'getSafeStreamingProse must hold back partial <<<AIC prefix'
);
assert(
  getSafeStreamingProse('Building your app.\n<thinkt Arch') === 'Building your app.',
  'getSafeStreamingProse must hold back partial <thinkt prefix'
);
assert(
  getSafeStreamingProse(
    'Building your app.\n<<<AICRAFT_APP_HTML>>>\n<!DOCTYPE html><html></html>'
  ) === 'Building your app.',
  'getSafeStreamingProse must keep pre-code prose clean once HTML starts'
);

console.log('ALL GEMINI ENGINE TESTS PASSED');
process.exit(0);
