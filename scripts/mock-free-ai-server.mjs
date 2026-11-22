/**
 * Mock OpenAI-compatible servers for verifying the free AI mesh locally.
 *
 * Usage:
 *   node scripts/mock-free-ai-server.mjs <mode> <port>
 *
 * Modes:
 *   rate-limited   → always responds 429 (tests cooldown + failover)
 *   streaming      → streams an SSE chat completion, or JSON when stream:false
 *   streaming-html → streams a complete single-file HTML app (build path)
 *
 * The sandbox blocks live AI providers, so failover is verified against these
 * local endpoints via SELF_HOSTED_LLM_URL / POLLINATIONS_BASE_URL overrides.
 */
import http from 'node:http';

const [, , mode = 'streaming', portArg = '4591'] = process.env.NODE_ARGV && false
  ? []
  : process.argv;
const port = Number(portArg);

if (!['rate-limited', 'streaming', 'streaming-html'].includes(mode)) {
  console.error(`unknown mode: ${mode}`);
  process.exit(1);
}

const REPLY = 'Hello from the free AI mesh! Build success.';

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
        <li><span>Try the mesh failover</span><button type="button">Done</button></li>
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

const server = http.createServer((req, res) => {
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
    console.log(
      `[mock:${mode}:${port}] ${req.method} ${req.url} stream=${Boolean(parsed.stream)}`
    );

    if (mode === 'rate-limited') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'Rate limit reached for this model.', code: 'rate_limit_exceeded' },
        })
      );
      return;
    }

    // streaming mode — reply with an HTML app when the prompt asks to build
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
      // Split into ~700-char chunks so the pipeline sees realistic partials.
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
