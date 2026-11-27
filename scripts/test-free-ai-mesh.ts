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

// --- 9: real server file DB, preview image guard, & test mode prompt ------
const {
  insertAppTableRow,
  listAllAppTables,
  listAppTableRows,
  updateAppTableRow,
  removeAppTableRow,
  seedAppTablesIfEmpty,
  clearAppTableRows,
} = await import('../api/_appDataStore.js');
const { buildCraftSystemPrompt, buildProjectInfraContext } = await import(
  '../api/_builderCore.js'
);
const { detectNaturalMediaRequest, prepareRealtimePrompt } = await import(
  '../api/_realtimeEngine.js'
);

const dbTestAppId = `unit_test_app_${Date.now()}__test`;
const inserted = await insertAppTableRow(dbTestAppId, 'videos', {
  title: 'Morning Run',
  likes: 4,
});
assert(inserted.title === 'Morning Run', 'insertAppTableRow must persist row payload');
const tablesSnapshot = await listAllAppTables(dbTestAppId);
assert(
  Array.isArray(tablesSnapshot.tables.videos) && tablesSnapshot.tables.videos.length === 1,
  'listAllAppTables must read persisted disk table rows'
);
const updatedRow = await updateAppTableRow(dbTestAppId, 'videos', String(inserted.id), {
  likes: 9,
});
assert(updatedRow?.likes === 9, 'updateAppTableRow must update persisted row');
await seedAppTablesIfEmpty(dbTestAppId, {
  videos: [{ title: 'Should not overwrite' }],
  comments: [{ author: 'Ada', body: 'Nice clip' }],
});
const videosAfterSeed = await listAppTableRows(dbTestAppId, 'videos');
const commentsAfterSeed = await listAppTableRows(dbTestAppId, 'comments');
assert(videosAfterSeed.length === 1 && videosAfterSeed[0]?.likes === 9, 'seedAppTablesIfEmpty must preserve existing rows');
assert(commentsAfterSeed.length === 1, 'seedAppTablesIfEmpty must seed empty tables');
await removeAppTableRow(dbTestAppId, 'videos', String(inserted.id));
await clearAppTableRows(dbTestAppId, 'videos');
await clearAppTableRows(dbTestAppId, 'comments');

assert(
  detectNaturalMediaRequest('Generate an image for my TikTok app preview feed', false) === null,
  'detectNaturalMediaRequest must ignore app/preview build prompts'
);
assert(
  detectNaturalMediaRequest('Generate an image of a sunset', true) === null,
  'detectNaturalMediaRequest must return null when an app already exists in Preview'
);
const testInfra = buildProjectInfraContext({
  secretKeys: [],
  secretHints: [],
  databaseTables: ['videos(id:text,title:text)'],
  testMode: true,
});
assert(/TEST MODE ACTIVE/i.test(testInfra), 'buildProjectInfraContext must inject Test Mode status');
assert(/NO IMAGE GENERATION IN PREVIEW/i.test(testInfra), 'buildProjectInfraContext must forbid image generation in Preview');

const testPromptPrep = await prepareRealtimePrompt({
  message: 'Build a clean vertical video feed screen',
  mode: 'mobile',
  testMode: true,
  previousHtml: '<html><body><main>existing</main></body></html>',
});
assert(
  !/\[\[MODE:GENERATE\]\]/.test(testPromptPrep.systemPrompt),
  'buildCraftSystemPrompt must omit [[MODE:GENERATE]] inside existing app/Test Mode builds'
);

// --- 10: mobile Vue architecture, sanitization, validation & restructure ---
const {
  validateBuiltAppHtml,
  sanitizeAndHardenPreviewHtml,
  extractLiveBuildArtifacts,
  finalizePartialPreviewHtml,
} = await import('../api/_builderCore.js');

const mobileStages: Array<{ kind: string; action: string; label: string }> = [];
const mobilePromptPrep = await prepareRealtimePrompt({
  message: 'Build a WhatsApp-style mobile chat app with Chats, Status, and Calls tabs',
  mode: 'mobile',
  onStage: (s) => mobileStages.push({ kind: s.kind, action: s.action, label: s.label }),
});
assert(
  mobilePromptPrep.initialRoute === 'build',
  `mobile app build request must classify initialRoute='build', got '${mobilePromptPrep.initialRoute}'`
);
assert(
  mobilePromptPrep.searchData.query.length > 0,
  'mobile app build must execute live web search and populate searchData.query'
);
assert(
  mobileStages.some((s) => s.kind === 'build' && /searching|searched/i.test(s.action)),
  'prepareRealtimePrompt must emit real web search stage when web search runs'
);
assert(
  /\/vendor\/vue\.global\.prod\.js/.test(mobilePromptPrep.systemPrompt),
  'mobile system prompt must enforce local /vendor/vue.global.prod.js runtime'
);
assert(
  /\.ion-page/.test(mobilePromptPrep.systemPrompt) &&
    /\.ion-tab-bar/.test(mobilePromptPrep.systemPrompt),
  'mobile system prompt must require Ionic/Capacitor safe-area page & tab bar structure'
);
assert(
  /\[\[PLAN:/.test(mobilePromptPrep.systemPrompt),
  'mobile system prompt must require architectural [[PLAN:...]] breakdown before code'
);

// Verify finalizePartialPreviewHtml never emits broken half-written <script> or unmounted Vue #app shell
const partialUnmountedVue = `<<<AICRAFT_APP_HTML>>>\n<!DOCTYPE html><html><head><script src="/vendor/vue.global.prod.js"></script></head><body><div id="app"></div><script>const { createApp } = Vue; const broken = "unterminated`;
assert(
  finalizePartialPreviewHtml(partialUnmountedVue) === '',
  'finalizePartialPreviewHtml must withhold unmounted Vue #app shells until mount script finishes'
);
const partialValidStatic = `<<<AICRAFT_APP_HTML>>>\n<!DOCTYPE html><html><head><style>body{margin:0;}</style></head><body><main><h1>Chat App</h1></main><script>const x = 1; // half written`;
const safePartial = finalizePartialPreviewHtml(partialValidStatic);
assert(
  safePartial.includes('<h1>Chat App</h1>') && !safePartial.includes('const x = 1'),
  'finalizePartialPreviewHtml must strip unclosed trailing <script> instead of running half-written JS'
);

const sampleVueMobileHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>PulseChat Mobile</title>
  <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
  <style>
    :root { --bg: #ffffff; --ink: #0f172a; --accent: #0ea5e9; }
    html, body { margin: 0; padding: 0; height: 100dvh; font-family: system-ui, sans-serif; }
    .ion-page { display: flex; flex-direction: column; height: 100dvh; background: var(--bg); color: var(--ink); }
    .ion-header { padding: 14px 16px; border-bottom: 1px solid #e2e8f0; font-weight: 700; }
    .ion-content { flex: 1; overflow-y: auto; padding: 12px 16px; }
    .ion-tab-bar { display: flex; justify-content: space-around; padding: 10px 8px; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div id="app"></div>
  <template id="tpl-chats-screen">
    <section class="ion-page">
      <header class="ion-header">Chats</header>
      <main class="ion-content">
        <div v-for="c in chats" :key="c.id" class="chat-row">
          <button type="button" @click="$emit('open', c.id)">{{ c.name }}</button>
        </div>
      </main>
      <nav class="ion-tab-bar">
        <button type="button" @click="$emit('tab', 'chats')">Chats</button>
        <button type="button" @click="$emit('tab', 'calls')">Calls</button>
      </nav>
    </section>
  </template>
  <template id="tpl-chat-composer">
    <form class="composer" @submit.prevent="send">
      <input v-model="draft" placeholder="Message" />
      <button type="submit">Send</button>
    </form>
  </template>
  <script>
    const { createApp, ref, computed } = Vue;
    const ChatsScreen = Vue.defineComponent({
      name: 'ChatsScreen',
      template: '#tpl-chats-screen',
      props: ['chats'],
      emits: ['open', 'tab']
    });
    const ChatComposer = Vue.defineComponent({
      name: 'ChatComposer',
      template: '#tpl-chat-composer',
      setup() {
        const draft = ref('');
        const send = () => { draft.value = ''; };
        return { draft, send };
      }
    });
    createApp({
      components: { ChatsScreen, ChatComposer },
      setup() {
        const activeTab = ref('chats');
        const chats = ref([{ id: '1', name: 'Ada' }, { id: '2', name: 'Tunde' }]);
        const openChat = async (id) => {
          if (window.AICraft && window.AICraft.db) {
            await window.AICraft.db.list('messages');
          }
          return id;
        };
        return { activeTab, chats, openChat };
      },
      template: '<chats-screen :chats="chats" @open="openChat" @tab="activeTab = $event" />'
    }).mount('#app');
  </script>
</body>
</html>`;

const vueValidation = validateBuiltAppHtml(sampleVueMobileHtml);
assert(
  vueValidation.valid === true,
  `validateBuiltAppHtml must accept modular Vue 3 mobile app, got: ${vueValidation.reason}`
);

const fakeStubHtml = sampleVueMobileHtml.replace('Chats', 'App Not Ready — Your app is still building');
assert(
  validateBuiltAppHtml(fakeStubHtml).valid === false,
  'validateBuiltAppHtml must reject App Not Ready stub text'
);

const hardenedVueHtml = sanitizeAndHardenPreviewHtml(sampleVueMobileHtml);
assert(
  hardenedVueHtml.includes('/vendor/vue.global.prod.js') &&
    !/https?:\/\/unpkg\.com\/vue/i.test(hardenedVueHtml),
  'sanitizeAndHardenPreviewHtml must rewrite external Vue 3 CDN links to local /vendor/vue.global.prod.js'
);

const vueAutoInjected = sanitizeAndHardenPreviewHtml(
  sampleVueMobileHtml.replace(
    '<script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>',
    ''
  )
);
assert(
  vueAutoInjected.includes('/vendor/vue.global.prod.js'),
  'sanitizeAndHardenPreviewHtml must auto-inject /vendor/vue.global.prod.js when Vue runtime APIs are present'
);

const artifacts = extractLiveBuildArtifacts(sampleVueMobileHtml).map((a) => a.path);
assert(
  artifacts.includes('screens/chats-screen.vue') &&
    artifacts.includes('components/chat-composer.vue'),
  `extractLiveBuildArtifacts must surface modular .vue files, got: ${artifacts.join(', ')}`
);

const restructurePrep = await prepareRealtimePrompt({
  message: 'Restructure the layout into clean Vue screens with bottom navigation tabs and a full-screen thread detail view',
  mode: 'mobile',
  previousHtml: sampleVueMobileHtml,
});
assert(
  restructurePrep.initialRoute === 'build' && !restructurePrep.isPatchMode,
  'Restructure request on existing HTML must unlock full rebuild (initialRoute=build, isPatchMode=false)'
);
assert(
  restructurePrep.userPrompt.includes('CURRENT_PROJECT_FILES:') &&
    restructurePrep.userPrompt.includes('=== FILE: index.html ===') &&
    restructurePrep.userPrompt.includes('screens/chats-screen.vue'),
  'Restructure prompt must feed CURRENT_PROJECT_FILES manifest and actual existing code'
);

// --- 11: live grounding metadata, native thoughts, 400 fallback, progressive steps & patch fallback ---
const { detectArtifactCompletionStates } = await import('../api/_builderCore.js');
const { finalizeRealtimeOutput, repairIncompleteBuildHtml } = await import(
  '../api/_realtimeEngine.js'
);

const groundingEvents: Array<{ queries: string[]; sources: Array<{ title: string; url: string }> }> = [];
const thoughtChunks: string[] = [];
const groundedRes = await streamFreeAiMesh({
  taskKind: 'chat',
  systemPrompt: 'You are a helpful assistant.',
  historyMessages: [],
  userPrompt: 'Search live docs __INCLUDE_THOUGHT__',
  enableWebSearch: true,
  onGrounding: (g) => groundingEvents.push(g),
  onReasoningChunk: (t) => thoughtChunks.push(t),
  onContentChunk: () => {},
});
assert(
  groundedRes.rawOutput.includes('Build success'),
  'grounded stream must complete cleanly'
);
assert(
  groundingEvents.some(
    (g) =>
      g.queries.includes('gemini live search query') &&
      g.sources.some((s) => s.url === 'https://example.com/live-source')
  ),
  'streamFreeAiMesh must forward Gemini groundingMetadata queries and sources via onGrounding'
);
assert(
  thoughtChunks.some((t) => t.includes('Planning architecture')),
  'streamFreeAiMesh must forward native part.thought chunks via onReasoningChunk'
);

const fallbackNoTools = await streamFreeAiMesh({
  taskKind: 'chat',
  systemPrompt: 'sys',
  historyMessages: [],
  userPrompt: 'Say hello __REJECT_TOOLS_400__',
  enableWebSearch: true,
  onContentChunk: () => {},
});
assert(
  fallbackNoTools.rawOutput.includes('Build success'),
  'streamFreeAiMesh must retry cleanly without googleSearch when upstream rejects tool with 400'
);

const partialHtmlInProgress =
  '<!DOCTYPE html><html><head><style>body{margin:0}';
const runningStates = detectArtifactCompletionStates(partialHtmlInProgress);
assert(
  runningStates.find((s) => s.path === 'index.html')?.status === 'running' &&
    runningStates.find((s) => s.path === 'styles.css')?.status === 'running',
  'detectArtifactCompletionStates must mark open styles.css/index.html as running before closing tags'
);

const partialStyleClosed = `${partialHtmlInProgress}</style></head><body><script>console.log(1);</script></body></html>`;
const completeStates = detectArtifactCompletionStates(partialStyleClosed);
assert(
  completeStates.find((s) => s.path === 'styles.css')?.status === 'complete' &&
    completeStates.find((s) => s.path === 'app.js')?.status === 'complete' &&
    completeStates.find((s) => s.path === 'index.html')?.status === 'complete',
  'detectArtifactCompletionStates must flip files to complete once genuine closing tags stream'
);

const missedPatchFinalize = finalizeRealtimeOutput({
  rawOutput:
    '<<<AICRAFT_PATCH>>>\n<<<SEARCH>>>\nNONEXISTENT_ANCHOR_XYZ\n<<<REPLACE>>>\nREPLACED\n<<<END_PATCH>>>',
  message: 'Remove the help button',
  mode: 'web',
  previousHtml: sampleVueMobileHtml,
});
assert(
  missedPatchFinalize.patchFailedCompletely === true && missedPatchFinalize.valid === false,
  'finalizeRealtimeOutput must flag patchFailedCompletely when surgical anchors miss'
);
const patchFallbackHtml = await repairIncompleteBuildHtml({
  brokenHtml: sampleVueMobileHtml,
  validationReason: missedPatchFinalize.validationReason || 'Patch missed anchors',
  userMessage: 'Build a todo app',
  mode: 'web',
  isPatchFallback: true,
});
assert(
  patchFallbackHtml.includes('Mesh Todo'),
  'repairIncompleteBuildHtml with isPatchFallback must produce valid replacement HTML when anchors miss'
);

console.log('ALL GEMINI ENGINE TESTS PASSED');
process.exit(0);
