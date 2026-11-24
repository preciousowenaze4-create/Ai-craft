// Keyless default env → mesh all-fail must produce the friendly aggregate
// error, not the old GEMINI_API_KEY message.
//
// Scrub ALL ambient provider credentials, then point the one keyless lane
// (Pollinations) at an unreachable local endpoint so every lane fails
// deterministically — CI runners have open networks, unlike sandboxes, so
// leaving the default https://text.pollinations.ai URL would actually
// succeed there and break this test.
import { scrubAiEnv } from './_testEnv.js';

scrubAiEnv();
process.env.POLLINATIONS_BASE_URL = 'http://127.0.0.1:9/openai';
process.env.POLLINATIONS_MODELS = 'openai';

const { streamServerFreeAiRealTime } = await import('../api/_realtimeEngine.js');

try {
  await streamServerFreeAiRealTime({
    initialRoute: 'chat',
    systemPrompt: 'sys',
    historyMessages: [],
    userPrompt: 'hello',
    onContentChunk: () => {},
  });
  console.log('UNEXPECTED SUCCESS');
  process.exit(1);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log('ERROR MESSAGE:', msg.slice(0, 300));
  if (msg.includes('GEMINI_API_KEY is not configured')) {
    console.log('FAIL: old hard-coded Gemini error still surfaces');
    process.exit(1);
  }
  if (!/busy or unreachable|No free AI engine/i.test(msg)) {
    console.log('FAIL: expected friendly mesh error');
    process.exit(1);
  }
  console.log('FRIENDLY ERROR TEST PASSED');
}
