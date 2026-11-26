// Missing or unreachable AgentRouter must surface clear AgentRouter errors,
// never falling back to Pollinations or mentioning GEMINI_API_KEY.
import { scrubAiEnv } from './_testEnv.js';

scrubAiEnv();
const { streamServerFreeAiRealTime } = await import('../api/_realtimeEngine.js');

// 1. Missing AgentRouter key
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
  if (!/AGENTROUTER_API_KEY|AgentRouter/i.test(msg)) {
    console.log('FAIL: expected AgentRouter configuration error');
    process.exit(1);
  }
}

// 2. Unreachable AgentRouter upstream
process.env.AGENTROUTER_API_KEY = 'sk-test-agentrouter-key';
process.env.AGENTROUTER_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.AGENTROUTER_MODELS = 'gpt-6.2-sol';

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
  if (msg.includes('GEMINI_API_KEY')) {
    console.log('FAIL: old hard-coded Gemini error still surfaces');
    process.exit(1);
  }
  if (!/AgentRouter request failed/i.test(msg)) {
    console.log('FAIL: expected AgentRouter failure error');
    process.exit(1);
  }
  console.log('FRIENDLY ERROR TEST PASSED');
}
