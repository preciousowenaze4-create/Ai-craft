// Default env: no gemini keys, live providers blocked in sandbox → mesh all-fail
// must produce the friendly aggregate error, not the old GEMINI_API_KEY message.
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY_1;
delete process.env.GOOGLE_API_KEY;
delete process.env.SELF_HOSTED_LLM_URL;
delete process.env.POLLINATIONS_BASE_URL;
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
