# AI Craft

**Build iOS, Android, and full-stack web apps instantly — with no code.**

AI Craft is a prompt-to-app builder: describe the app you want, and a streaming AI
pipeline generates a complete, runnable single-page application (UI, logic, local/
Supabase database, secrets integration) with live preview, revision history, and
one-tap publishing to a shareable URL.

Chat and builds run on the **free AI mesh** — 210+ curated free models across nine
providers with automatic daily quota resets (UTC midnight) and instant failover, so
**no API key is required**. Fresh builds fan out to **three AI agents at once**
(architect + designer + engineer) whose output is merged into the final app, and
chat replies are raced across the top candidates for minimum latency.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19 + TypeScript, Vite 8, Tailwind CSS 4, Motion, Lucide |
| PWA | vite-plugin-pwa (auto-update service worker, install prompts) |
| Backend (self-hosted) | Express (`server.ts`) run via `tsx` |
| Backend (serverless) | Vercel-style handlers under `api/` (see `vercel.json` rewrites) |
| AI | Free AI mesh (`api/_freeAiMesh.ts`): keyless multi-provider failover, daily quotas, top-3 chat race, 3 parallel build agents |
| Auth & data | Supabase (email/password + OAuth, Row-Level Security) |
| Payments | Paystack checkout, webhooks, and credit-based billing |
| 3D hero | three.js + GLB asset served with pre-computed gzip |

## Repository layout

```
├── server.ts               # Express app: all API routes + static/SPA serving
├── api/                    # Vercel serverless handlers (mirror of server routes)
│   ├── craft/stream.ts     # Streaming build endpoint (SSE)
│   ├── _builderCore.ts     # Prompt building, game detection, output validation
│   ├── _realtimeEngine.ts  # Real-time streaming, output finalization/repair
│   ├── _aiGateways.ts      # Model registry + execution plan/fallback matrix
│   ├── _aiBrain.ts         # Stage 1 memory brain + Stage 2 self-hosted adapter
│   ├── _projectMemory.ts   # Per-user/per-project persistent memory (Supabase)
│   ├── _billing.ts         # Credits, plans, generation pricing
│   ├── _paystack.ts        # Checkout, verification, webhooks, FX conversion
│   ├── _moderation.ts      # User moderation & owner admin actions
│   ├── _mediaService.ts    # Generated image/media assets
│   ├── auth.ts, apps.ts, payments.ts, search.ts, transcribe.ts, models.ts, …
├── src/                    # React app (screens, builder workspace, components)
├── supabase/migrations/    # Stage 1 AI memory schema + RLS policies
├── public/                 # Static assets (icons, wallpapers, hero GLB)
├── vercel.json             # Serverless rewrites incl. /app/:id and /p/:id routes
└── vite.config.ts          # Build, PWA manifest, routing scope
```

## Quick start

Requirements: **Node.js ≥ 20** (npm included).

```bash
npm install          # clean install — no --legacy-peer-deps needed
cp .env.example .env # then fill in your secrets (see below)
npm run dev          # dev server with Vite middleware + HMR → http://localhost:3000
```

Production-style run:

```bash
npm run build        # outputs dist/ (static + PWA service worker)
npm start            # serves dist/ through Express on PORT (default 3000)
```

Other scripts:

| Script | Purpose |
| --- | --- |
| `npm test` | Full gate: lint → build → mesh/e2e/friendly-error tests (same as CI) |
| `npm run test:mesh` | Free AI mesh failover/cooldown tests against local mocks |
| `npm run test:e2e` | Boots the server + drives `/api/craft/stream` over SSE (chat + build) |
| `npm run test:friendly` | Asserts the keyless friendly-error contract |
| `npm run lint` | TypeScript type-check (`tsc --noEmit`) |
| `npm run preview` | Vite preview of the built client only |
| `npm run clean` | Remove `dist/` |

### Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci` + `npm test` on every
push and pull request. The test suites scrub all ambient AI-provider
credentials and talk only to local mock lanes (`scripts/mock-free-ai-server.mjs`),
so CI needs no secrets and stays deterministic even though runners have open
network access.

## Environment variables

Copy `.env.example` to `.env` and fill in values. All secrets stay server-side.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | optional | **Not needed for chat/build** — mesh handles both. Only feeds optional extras (incomplete-build repair, media pre-pass, transcription) when present |
| `SUPABASE_URL` | ✅* | Supabase project URL (*needed for auth, cloud save, memory) |
| `SUPABASE_ANON_KEY` | ✅* | Supabase anon (public) key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅* | Supabase service-role key (server-only) |
| `PAYSTACK_SECRET_KEY` / `PAYMENT_SECRET_KEY` | for payments | Live checkout + transaction verification |
| `PAYSTACK_USD_TO_NGN_RATE` | optional | Manual USD→NGN override (defaults to live FX) |
| `APP_URL` | recommended | Public base URL for OAuth callbacks & published apps |
| `PORT` | optional | Server port (default `3000`) |
| `SELF_HOSTED_LLM_URL/MODEL/PROTOCOL/API_KEY` | optional | Self-hosted GPU endpoint — first lane of the free AI mesh |
| `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `HF_TOKEN`, `GITHUB_TOKEN`, `TOGETHER_API_KEY`, `DEEPINFRA_API_KEY` | optional | Any subset of free-tier provider keys — each adds failover lanes |
| `OPENAI_COMPATIBLE_BASE_URL/KEY/MODEL` | optional | Generic OpenAI-compatible endpoint lane |
| `POLLINATIONS_ENABLED` | optional | Keyless text fallback (default `true`) |

### Free AI mesh (the only chat/build engine)

Chat and build requests run through one ordered multi-provider mesh — **no API
key required, ever**:

1. **Self-hosted** GPU (`SELF_HOSTED_LLM_*`)
2. **OpenAI-compatible** endpoint (`OPENAI_COMPATIBLE_*`)
3. Free-tier keys: **Groq → Cerebras → OpenRouter (`:free` models) → Mistral →
   HuggingFace → GitHub Models → Together → DeepInfra**
4. **Pollinations** — keyless, always last (opt out with `POLLINATIONS_ENABLED=false`)

**Honest model counts.** The curated catalog ships **211 free models** (Groq 14,
Cerebras 9, OpenRouter 91, Mistral 9, HuggingFace 11, GitHub Models 42, Together 10,
DeepInfra 12, Pollinations 13) and can merge additional `:free` OpenRouter models
via live discovery — `/api/models` always reports the real active count
(`freeAiMesh.modelPool`), never a fabricated number.

**Resets every day.** Usage is tracked per `(provider, model)` against a daily
quota that resets automatically at **00:00 UTC**. When one model hits its limit or
errors, the mesh cools it down (Pollinations "previous request still running" busy
→ 6s, 429/quota → 90s, auth → 10min, retired model → 6h, 5xx/network → 30-45s)
and the **next free model continues immediately**. When every engine is only
briefly cooling, the walk waits — bounded (`MESH_COOLDOWN_WAIT_MS`, 8s chat /
6s build) — for the earliest one instead of erroring, so cooldowns never surface
a stuck error and are never permanent.

**Fast chat.** Chat requests race the top 3 candidates concurrently — at most one
lane per provider, so same-provider models never queue behind each other. The first
emitter wins and every losing lane is cancelled immediately (including ones still
waiting on the provider single-flight slot), and the chat system prompt enforces
SPEED FIRST (short, answer-first replies). Builds use tighter timeouts with a
sequential failover walk.

**Three AIs build at once.** On fresh builds (no previous HTML), the architect
streams the app live while a designer and an engineer run concurrently with
role-specific directives — every mesh call takes a per-provider single-flight
slot first (Pollinations Classic = 1 request per IP, `MESH_POLLINATIONS_CONCURRENCY`),
so parallel agents queue instead of colliding with "previous request still running"; their CSS/JS output is deterministically merged into the
architect's document and re-validated (`validateBuiltAppHtml`) before the preview
swaps in. Progress arrives as `agents` + `previewReplace` SSE events and renders
as Architect/Designer/Engineer pills in the chat box. Parallel builds are gated
(`MESH_PARALLEL_BUILDS=false` disables) and fall back to the architect's HTML if
the merge would be unsafe.

Repair and the design architect pre-pass also use the same mesh (they keep an
optional Gemini branch that degrades to mesh when no key is set). Media
generation additionally falls back to keyless Pollinations image AI before web
search (`POLLINATIONS_IMAGE_ENABLED`).

Without Supabase/payments the server still boots and reports status:

```bash
curl http://localhost:3000/api/health
# {"ok":true,"geminiConfigured":false,"serverFreeAiReady":true,"freeAiMesh":{"hasAny":true,"hasKeyless":true,"providers":[…],"modelPool":{"activeModels":3,"catalogSize":211,"dailyResetsAt":"…T00:00:00.000Z","dailyLimitPerModel":400}},…}
```

## Database (Supabase)

Run [`supabase/migrations/001_stage1_ai_memory.sql`](supabase/migrations/001_stage1_ai_memory.sql)
in the Supabase SQL Editor. It is **additive and non-destructive** and creates:

- `ai_projects` — per-user project root: title, mode, build status, task lists,
  last stopped checkpoint, DB schema snapshot
- `ai_conversation_messages` — persistent per-project conversation history
- `ai_project_files` — generated files with rolling version/change history
- Strict **Row Level Security** so every user can only touch their own rows

## Published apps

Generated apps are published under two equivalent route prefixes:

- `/p/:id` (default) and `/app/:id`

Each published app gets its own manifest, service worker, and icon set
(`/p/:id/manifest.webmanifest`, `/p/:id/sw.js`, `/p/:id/icon-*.png`, …), served by
`api/apps.ts` / the Express equivalents, so every build is an installable PWA.

## Deploying

**Vercel (serverless):** the `api/` directory plus `vercel.json` rewrites handle
everything; set the environment variables in Vercel project settings.

**Self-hosted (Express):** `npm run build && npm start` behind any reverse proxy.
Set `APP_URL` and `NODE_ENV=production`.

## Roadmap — Stage 2

Stage 1 (this repo) is provider-agnostic: `api/_aiBrain.ts` defines a
`AiBrainProviderAdapter` contract and a ready scaffold
(`createSelfHostedBrainAdapter`) for pointing builds at a self-hosted
open-source coder model (Qwen2.5-Coder / DeepSeek-Coder / Llama via vLLM, TGI,
or Ollama). The free AI mesh (`api/_freeAiMesh.ts`) already routes live chat
and build traffic through `SELF_HOSTED_LLM_*` when set — no UI, memory, auth,
or billing changes required.

## License

Private / all rights reserved unless otherwise stated.
