// Missing or unreachable Gemini API key must surface clear Gemini errors,
// never falling back to Pollinations or AgentRouter.
import { scrubAiEnv } from './_testEnv.js';

scrubAiEnv();
const { streamServerFreeAiRealTime } = await import('../api/_realtimeEngine.js');

// 1. Missing Gemini API key
try {
  await streamServerFreeAiRealTime({
    initialRoute: 'chat',
    systemPrompt: 'sys',
    historyMessages: [],
    userPrompt: 'hello',
    onContentChunk: () => {},
  });
  console.log('UNEXPECTED SUCCESS (missing key)');
  process.exit(1);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log('MISSING KEY ERROR:', msg);
  if (!/GEMINI_API_KEY|Gemini/i.test(msg) || /AgentRouter|Pollinations/i.test(msg)) {
    console.log('FAIL: expected clean Gemini configuration error');
    process.exit(1);
  }
}

// 2. Unreachable Gemini upstream
process.env.GEMINI_API_KEY = 'AIzaSyTestGeminiKey1234567890';
process.env.GEMINI_API_BASE_URL = 'http://127.0.0.1:9';
process.env.GEMINI_MODELS = 'gemini-4-hydrogen';

try {
  await streamServerFreeAiRealTime({
    initialRoute: 'chat',
    systemPrompt: 'sys',
    historyMessages: [],
    userPrompt: 'hello',
    onContentChunk: () => {},
  });
  console.log('UNEXPECTED SUCCESS (unreachable upstream)');
  process.exit(1);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log('UPSTREAM ERROR MESSAGE:', msg.slice(0, 300));
  if (/AgentRouter|Pollinations/i.test(msg)) {
    console.log('FAIL: old provider reference still surfaces');
    process.exit(1);
  }
  if (!/Gemini request failed/i.test(msg)) {
    console.log('FAIL: expected Gemini failure error');
    process.exit(1);
  }
  console.log('FRIENDLY ERROR TEST PASSED');
}
