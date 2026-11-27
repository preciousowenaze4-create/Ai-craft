/**
 * Mock Gemini MLDev + OpenAI-compatible servers for verifying the Gemini engine locally.
 *
 * Usage:
 *   node scripts/mock-free-ai-server.mjs <mode> <port>
 *
 * Modes:
 *   rate-limited   -> always responds 429 (tests cooldown + failover)
 *   streaming      -> streams Gemini SSE (or JSON), including image generation
 *   streaming-html -> streams a complete single-file HTML app (build path)
 */
import http from 'node:http';

const [, , mode = 'streaming', portArg = '4591'] = process.argv;
const port = Number(portArg);

if (!['rate-limited', 'streaming', 'streaming-html'].includes(mode)) {
  console.error(`unknown mode: ${mode}`);
  process.exit(1);
}

const REPLY = 'Hello from the Gemini AI engine! Build success.';
const MOCK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const HTML_APP = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mesh Todo</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b1020; color: #e8ecff; margin: 0; padding: 24px; }
  h1 { font-size: 22px; }
  .card { background: #141b34; border: 1px solid #26304f; border-radius: 12px; padding: 16px; max-width: 420px; }
  button { background: #4f7cff; color: #fff; border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; }
  ul { list-style: none; padding: 0; }
  li { padding: 8px 0; border-bottom: 1px solid #26304f; display: flex; justify-content: space-between; }
</style>
</head>
<body>
  <main>
    <h1>Mesh Todo</h1>
    <section class="card">
      <form id="composer">
        <input id="task" placeholder="Add a task" style="width:70%;padding:10px;border-radius:8px;border:1px solid #26304f;background:#0b1020;color:#e8ecff;">
        <button id="add" type="button">Add</button>
      </form>
      <ul id="list">
        <li><span>Try the Gemini engine</span><button type="button">Done</button></li>
        <li><span>Ship the build</span><button type="button">Done</button></li>
      </ul>
      <a href="#" id="help">Need help?</a>
    </section>
  </main>
<script>
  (function () {
    var tasks = [];
    function render() {
      var list = document.getElementById('list');
      list.innerHTML = '';
      tasks.forEach(function (t, i) {
        var li = document.createElement('li');
        var span = document.createElement('span');
        span.textContent = t;
        var del = document.createElement('button');
        del.textContent = 'Done';
        del.onclick = function () { tasks.splice(i, 1); render(); };
        li.appendChild(span);
        li.appendChild(del);
        list.appendChild(li);
      });
    }
    document.getElementById('add').onclick = function () {
      var input = document.getElementById('task');
      var v = input.value.trim();
      if (!v) return;
      tasks.push(v);
      input.value = '';
      render();
    };
  })();
</script>
</body>
</html>`;

// Concurrency/counters for diagnostics & tests:
//   GET    /__stats        -> { count, active, peak, lastImageHasAttachment }
//   POST   /__stats/reset  -> zero them
const stats = { count: 0, active: 0, peak: 0, lastImageHasAttachment: false };

function extractGeminiPromptText(parsed) {
  const contents = Array.isArray(parsed.contents)
    ? parsed.contents
    : parsed.contents
      ? [parsed.contents]
      : [];
  const lastUser = [...contents].reverse().find((c) => !c?.role || c.role === 'user') ?? contents[contents.length - 1];
  const parts = Array.isArray(lastUser?.parts) ? lastUser.parts : [];
  const text = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  const hasInlineImage = contents.some((c) =>
    Array.isArray(c?.parts) && c.parts.some((p) => Boolean(p?.inlineData?.data))
  );
  return { text, hasInlineImage };
}

const server = http.createServer((req, res) => {
  const reqUrl = req.url || '/';

  if (req.method === 'GET' && reqUrl === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }

  if (req.method === 'POST' && reqUrl === '/__stats/reset') {
    stats.count = 0;
    stats.active = 0;
    stats.peak = 0;
    stats.lastImageHasAttachment = false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }

  if (req.method === 'GET' && /^\/v1(?:beta)?\/models(?:\?|$)/.test(reqUrl)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        models: [
          {
            name: 'models/gemini-4-hydrogen',
            displayName: 'Gemini 4 Hydrogen',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-3.1-flash-lite',
            displayName: 'Gemini 3.1 Flash Lite',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-4-neon',
            displayName: 'Gemini 4 Neon',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-4-argon',
            displayName: 'Gemini 4 Argon',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-4-carbon',
            displayName: 'Gemini 4 Carbon',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      })
    );
    return;
  }

  stats.count += 1;
  stats.active += 1;
  if (stats.active > stats.peak) stats.peak = stats.active;
  let closed = false;
  res.on('close', () => {
    if (closed) return;
    closed = true;
    stats.active -= 1;
  });

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      // ignore malformed bodies
    }

    const isGeminiEndpoint = /^\/v1(?:beta)?\/models\//.test(reqUrl);
    const isGeminiStream = reqUrl.includes(':streamGenerateContent');
    const isImageModel =
      reqUrl.includes('-image:') || reqUrl.includes('nano-banana');

    console.log(
      `[mock:${mode}:${port}] ${req.method} ${reqUrl} stream=${Boolean(parsed.stream || isGeminiStream)}`
    );

    if (mode === 'rate-limited') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 429,
            message: 'Quota exceeded.',
            status: 'RESOURCE_EXHAUSTED',
          },
        })
      );
      return;
    }

    if (isGeminiEndpoint && isImageModel) {
      const { hasInlineImage } = extractGeminiPromptText(parsed);
      stats.lastImageHasAttachment = hasInlineImage;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: hasInlineImage
                      ? 'Edited your attached image with Gemini.'
                      : 'Generated your image with Gemini.',
                  },
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: MOCK_PNG_BASE64,
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 14,
            candidatesTokenCount: 256,
            totalTokenCount: 270,
          },
        })
      );
      return;
    }

    if (isGeminiEndpoint) {
      const apiKeyHdr = String(req.headers['x-goog-api-key'] || '');
      const queryKey = new URL(`http://localhost${reqUrl}`).searchParams.get('key') || '';
      const activeKey = apiKeyHdr || queryKey;
      if (/badkey/i.test(activeKey)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 401,
              message: 'API key not valid.',
              status: 'UNAUTHENTICATED',
            },
          })
        );
        return;
      }
      if (/\/models\/gemini-3\.[56]-flash\b/i.test(reqUrl)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 429,
              message: 'You exceeded your current quota, please check your plan.',
              status: 'RESOURCE_EXHAUSTED',
            },
          })
        );
        return;
      }

      const { text: lastUserText } = extractGeminiPromptText(parsed);
      const hasSearchTool = Array.isArray(parsed.tools) && parsed.tools.some((t) => Boolean(t?.googleSearch));
      if (hasSearchTool && /__REJECT_TOOLS_400__/.test(lastUserText)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 400,
              message: 'Search grounding tool is unsupported for this candidate.',
              status: 'INVALID_ARGUMENT',
            },
          })
        );
        return;
      }
      if (hasSearchTool && /__REJECT_SEARCH_429__/.test(lastUserText)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 429,
              message: 'Search grounding quota exhausted.',
              status: 'RESOURCE_EXHAUSTED',
            },
          })
        );
        return;
      }

      const wantsBuild = /\b(build|todo|app|website|create)\b/i.test(lastUserText);
      const includeThought = /__INCLUDE_THOUGHT__/.test(lastUserText);
      const replyText =
        mode === 'streaming-html' || (mode === 'streaming' && wantsBuild) ? HTML_APP : REPLY;

      if (isGeminiStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const chunks = [];
        for (let i = 0; i < replyText.length; i += 700) {
          chunks.push(replyText.slice(i, i + 700));
        }
        let sentThought = !includeThought;
        let i = 0;
        const send = () => {
          if (!sentThought) {
            sentThought = true;
            const thoughtPayload = {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: '**Planning architecture**\nReviewing requirements.', thought: true }],
                  },
                },
              ],
            };
            res.write(`data: ${JSON.stringify(thoughtPayload)}\n\n`);
            setTimeout(send, 5);
            return;
          }
          if (i < chunks.length) {
            const isLast = i === chunks.length - 1;
            const payload = {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: chunks[i] }],
                  },
                  ...(isLast && hasSearchTool
                    ? {
                        groundingMetadata: {
                          webSearchQueries: ['gemini live search query'],
                          groundingChunks: [
                            { web: { uri: 'https://example.com/live-source', title: 'Live Example Source' } },
                          ],
                        },
                      }
                    : {}),
                  ...(isLast ? { finishReason: 'STOP' } : {}),
                },
              ],
              ...(isLast
                ? {
                    usageMetadata: {
                      promptTokenCount: 12,
                      candidatesTokenCount: 20,
                      totalTokenCount: 32,
                    },
                  }
                : {}),
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
            i += 1;
            setTimeout(send, 5);
          } else {
            res.end();
          }
        };
        send();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: replyText }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 12,
            totalTokenCount: 22,
          },
        })
      );
      return;
    }

    // Legacy OpenAI-compatible fallback
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
    const lastUserText =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content.map((p) => p?.text || '').join(' ')
          : '';
    const wantsBuild = /\b(build|todo|app|website|create)\b/i.test(lastUserText);
    const replyText =
      mode === 'streaming-html' || (mode === 'streaming' && wantsBuild) ? HTML_APP : REPLY;

    if (parsed.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const chunks = [];
      for (let i = 0; i < replyText.length; i += 700) {
        chunks.push(replyText.slice(i, i + 700));
      }
      let i = 0;
      const send = () => {
        if (i < chunks.length) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\n\n`
          );
          i += 1;
          setTimeout(send, 5);
        } else {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      };
      send();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-cmpl-1',
        object: 'chat.completion',
        choices: [
          { index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
      })
    );
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock:${mode}] listening on http://127.0.0.1:${port}`);
});
