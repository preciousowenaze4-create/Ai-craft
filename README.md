# AI Craft

**Build iOS, Android, and full-stack web apps instantly — with no code.**

AI Craft is a prompt-to-app builder: describe the app you want, and a streaming AI
pipeline generates a complete, runnable single-page application (UI, logic, local/
Supabase database, secrets integration) with live preview, revision history, and
one-tap publishing to a shareable URL.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19 + TypeScript, Vite 8, Tailwind CSS 4, Motion, Lucide |
| PWA | vite-plugin-pwa (auto-update service worker, install prompts) |
| Backend (self-hosted) | Express (`server.ts`) run via `tsx` |
| Backend (serverless) | Vercel-style handlers under `api/` (see `vercel.json` rewrites) |
| AI | Google Gemini (`@google/genai`) with gateway/model fallback matrix |
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
| `GEMINI_API_KEY` | optional | Server-side Gemini key for the build/stream pipeline (highest priority when set) |
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

### Free AI mesh (automatic failover)

Chat and build requests run through one ordered multi-provider mesh — no Gemini
key required:

1. **Gemini** (when `GEMINI_API_KEY` is set — existing 3-pass failover)
2. **Self-hosted** GPU (`SELF_HOSTED_LLM_*`)
3. **OpenAI-compatible** endpoint (`OPENAI_COMPATIBLE_*`)
4. Free-tier keys: **Groq → Cerebras → OpenRouter (`:free` models) → Mistral →
   HuggingFace → GitHub Models → Together → DeepInfra**
5. **Pollinations** — keyless, always last (opt out with `POLLINATIONS_ENABLED=false`)

Providers that rate-limit or error are cooled down (429/quota → 90s, auth →
10min, retired model → 6h, 5xx/network → 30-45s) in a shared registry, so the
next request skips them instantly with zero added latency. Repair and the design
architect pre-pass use the same mesh. Media generation additionally falls back to
keyless Pollinations image AI before web search (`POLLINATIONS_IMAGE_ENABLED`).

Without Supabase/payments the server still boots and reports status:

```bash
curl http://localhost:3000/api/health
# {"ok":true,"geminiConfigured":…,"serverFreeAiReady":true,"freeAiMesh":{…},"supabaseConfigured":…,"paymentsConfigured":…}
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
