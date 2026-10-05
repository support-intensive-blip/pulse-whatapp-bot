# WhatsApp AI Assistant

A production, single-tenant WhatsApp AI assistant built on the **WhatsApp Business API via
Gallabox** + **OpenAI**, with
a hybrid (dense + BM25) RAG knowledge base, a React operator dashboard, and BigQuery-backed
durable storage. One dashboard login, one WhatsApp number, one hardcoded persona.

The repo has two deployable halves:

| Folder | What | Deployed to |
|---|---|---|
| [backend/](backend/) | Node/Express API, Gallabox webhook, AI + KB, SQLite | **Render** (Docker, persistent disk) — [render.yaml](render.yaml) |
| [frontend/](frontend/) | React + Vite dashboard | **Netlify** — [frontend/netlify.toml](frontend/netlify.toml) |

Code paths in this README (`src/...`, `knowledge-base/...`) are relative to `backend/`.

The system prompt and knowledge base are fixed in code:
- **System prompt:** `src/config/intensiveConfig.js` (loads `src/config/intensive-system-prompt.txt`)
- **Knowledge base:** `knowledge-base/nxtwave-intensive-knowledge-base.pdf`

> Earlier versions were multi-tenant (owner → team admins → users, per-team configs in
> `team_settings`). That machinery was removed; the `teams` / `team_settings` /
> `api_key_access_requests` tables still exist but are unused.

> This file is the top-level map. For the two most-changed subsystems there are dedicated docs:
> **[docs/RAG-FRAMEWORK.md](docs/RAG-FRAMEWORK.md)** (KB chunking/retrieval/gating rules) and
> **[docs/VERTEX-PIPELINE.md](docs/VERTEX-PIPELINE.md)** (the active vector-search backend,
> step-by-step, with the full debug-logging reference). For runtime behavior — message
> timing, conversation modes, when a chat is considered "ended," what every slash command
> actually does — see **[docs/BOT-BEHAVIOR.md](docs/BOT-BEHAVIOR.md)**.

---

## Architecture

```
src/
├── app.js                     # Entry point: DB init, config load, Express + Gallabox bot, cron
├── api/
│   ├── dashboardRoutes.js     # Main API — auth, conversations, bot status, action items
│   ├── gallaboxWebhookRoutes.js  # POST /webhooks/gallabox — inbound WhatsApp messages
│   ├── routes.js              # Legacy simple GETs (/health, /users, /stats, ...)
│   └── testApiRoutes.js       # /api/test/chat — used by the Opik eval harness
├── bot/
│   ├── gallabox/              # Gallabox REST client (send, media download, HMAC) + payload normalizer
│   ├── gallaboxBot.js         # The connected WhatsApp Business number: webhook events in, replies out
│   ├── botManager.js          # Picks which dashboard account owns the Gallabox number
│   └── messageHandler.js      # Inbound pipeline: store → escalation/firewall → batch → chatService
├── ai/
│   ├── systemPrompts.js       # Persona/system prompt assembly
│   ├── replyRules.js          # Firewall / sanitization on outbound replies
│   └── messageSplitter.js     # Splits long replies into WhatsApp-sized chunks
├── database/
│   ├── db.js / schema.js      # SQLite (disk or in-memory cache — see Storage below)
│   ├── bqSync.js / bqHydrate.js / bqTableConfig.js   # BigQuery write-through / boot hydration
│   └── storageMode.js         # isBigQueryPrimary() — which storage mode is active
├── services/                  # Business logic — KB/RAG, chat profiles, notifications...
├── scripts/                   # One-off / setup scripts (KB ingest, Vertex/Pinecone provisioning)
└── utils/                     # logger, networkInfo (public/private IP), helpers

(repo root)
├── backend/                   # everything above, plus Dockerfile, package.json, knowledge-base/, scripts/
├── frontend/                  # React + Vite operator UI (Netlify), netlify.toml
├── render.yaml                # Render Blueprint for backend/
└── docs/
```

## Storage: SQLite + BigQuery

Two modes, selected by `BQ_ENABLED` / `SQLITE_ENABLED` (`src/database/storageMode.js`):

- **Default** — SQLite persists to disk (`data/assistant.db`), optionally write-through synced to
  BigQuery if `BQ_ENABLED=true`.
- **BigQuery-primary** (`BQ_ENABLED=true`, `SQLITE_ENABLED=false`) — logged at startup as
  `"Storage: BigQuery-primary (in-memory cache, no disk SQLite)"`. SQLite runs as an **in-memory**
  (`:memory:`) query cache, hydrated from BigQuery on boot (`bqHydrate.js`) and synced back on
  every write (`bqSync.js`). Nothing persists to local disk in this mode — BigQuery is the
  durable store.

Schema (`src/database/schema.js`): `users`, `chat_profiles` (per-conversation state, scoped to an
`owner_phone`), `messages`, `notes`, `reminders`, `conversation_summaries`, `student_user_memory`,
`token_usage` (per-message LLM cost tracking), `dashboard_users` (web logins), `bot_accounts` (one
row per WhatsApp number, linked to a `dashboard_user_id`), `action_items`,
`push_subscriptions`.

## Single-tenant model

```
dashboard_user (the one web login, seeded from DASHBOARD_ADMIN_EMAIL/PASSWORD)
   └── bot_account (the one WhatsApp number/session)
          └── chat_profile (per contact chatting with that number)
```

Persona, model tier and the KB path used to be per-team; they are now fixed
(`src/config/intensiveConfig.js`). `chatProfileService.js` owns `chat_profiles`, including
consolidating multiple WhatsApp chat IDs into one canonical profile per contact.

## Knowledge base / RAG

One KB, one vector store — both hardcoded (`src/config/intensiveConfig.js`):

- **Source:** `knowledge-base/nxtwave-intensive-brain-memory-kb.txt` (QA `QUESTION_ID:` blocks).
- **Vector store:** `local` — an **in-server** hybrid index (TF-IDF dense + BM25 sparse, fused by
  reciprocal-rank fusion), persisted to `data/kb_vectors.json` + `data/kb_bm25_global.json`.
  **No third-party vector service or hosted embedding API is called.**

Retrieval is gated to `INTENSIVE` conversation mode only. It re-indexes automatically on the next
start whenever the KB file changes; or run `node src/scripts/force-reindex-kb.js` / `npm run ingest-kb`.

`VECTOR_BACKEND=vertex|pinecone` opts back into a hosted store (requires the matching env vars and
`vectorStoreService.js` / the Vertex + Pinecone modules, which are retained but dormant). KB
authoring format, chunking rules and the topic guard are in
**[docs/RAG-FRAMEWORK.md](docs/RAG-FRAMEWORK.md)**.

## Message pipeline

```
Contact messages the business number
   → Gallabox → POST /webhooks/gallabox (HMAC-verified, acked immediately)
   → gallaboxBot.js (dedupe by WhatsApp message id) → messageHandler.js
        ├─ store message (text, or media description) in `messages`
        ├─ escalation / scope firewall / assistant on-off checks
        └─ inboundMessageBatcher.js (debounces rapid multi-fragment messages, ~10s window)
              → chatService.js
                   ├─ contextService.resolveMode() → CASUAL vs INTENSIVE
                   ├─ INTENSIVE + KB-eligible? → hybrid KB retrieval → inject into prompt
                   ├─ LLM call (OpenAI; tiered by contextState)
                   └─ replyRules.js (firewall/sanitize) → messageSplitter.js
              → Gallabox REST API (send) → reply stored in `messages`
```

There is no self-chat on the Business API, so the owner-only slash commands (`/assistant`,
`/note`, `/tokens`, ...) are no longer reachable from WhatsApp — use the dashboard instead.

## Dashboard

React + Vite SPA in `frontend/`, built and hosted by Netlify. It calls the backend only through
relative `/api/...` URLs (`frontend/src/api/client.js`, bearer token from `localStorage`):
Netlify forwards `/api/*` to the Render backend server-side (`frontend/netlify.toml`), and in
local dev the Vite server does the same to `localhost:3000`. The browser therefore never makes a
cross-origin request — no CORS setup needed.

Pages: Login, Dashboard, Connect (Gallabox status + webhook URL), Conversations, ConversationDetail,
BotSettings, ActionItems, Account.

## REST API

All under `/api` (`src/api/dashboardRoutes.js`) unless noted:

| Group | Covers |
|---|---|
| `/auth/*` | Login, current user, password change |
| `/admin/sqlite-*` | SQLite backup / guard / purge |
| `/bot/*` | Gallabox connection status, reconnect/stop, bot settings |
| `/notifications/*` | Web-push subscribe + notification inbox |
| `/conversations/*` | List/sync/send, assistant toggle, CSV import/export, escalate |
| `/action-items` | Action item tracking |
| `/stats` | Aggregate counts |

`POST /webhooks/gallabox` (`gallaboxWebhookRoutes.js`) receives inbound WhatsApp messages.
Legacy simple GETs at root (`src/api/routes.js`): `/health`, `/users`, `/notes`, `/reminders`,
`/knowledge-base`, `/chats`, `/stats`. `/api/test/chat` (`testApiRoutes.js`) is a synchronous
chat endpoint used only by the Opik eval harness.

## Requirements

- Node.js 18+
- FFmpeg (voice message transcription)
- OpenAI API key
- A Gallabox account (Essential or Advanced plan — webhooks are not on Basic) with a connected
  WhatsApp Business number
- Optional: a GCP project only if `BQ_ENABLED=true` (BigQuery durable storage) or if you switch
  `VECTOR_BACKEND` back to `vertex`. The default `local` KB needs neither.

## Setup

```bash
# backend (http://localhost:3000)
cd backend
npm install
cp .env.example .env   # then fill in required vars — see below
npm run dev            # node --watch; `npm start` for a plain run

# frontend (http://localhost:5173, proxies /api to the backend)
cd frontend
npm install
npm run dev
```

Runtime data (`data/`, `logs/`, `uploads/`, `secrets/`, `.env`) lives inside `backend/`.

### Env vars (groups — see `.env.example` for the tunable subset; several required vars below aren't in that file)

| Group | Examples |
|---|---|
| Core (required) | `OPENAI_API_KEY`, `PORT` |
| Chat/context | `OPENAI_MODEL_SMART`, `CHAT_TEMPERATURE`, `CONTEXT_MEMORY_TTL_MINUTES`, `INBOUND_BATCH_WINDOW_MS` |
| KB translation | `KB_TRANSLATE_MODEL`, `KB_TRANSLATE_TEMPERATURE` |
| Hybrid retrieval | `KB_HYBRID_DENSE_WEIGHT`, `KB_HYBRID_SPARSE_WEIGHT`, `KB_MIN_SEARCH_SCORE`, `KB_TOP_K` |
| Storage | `BQ_ENABLED`, `SQLITE_ENABLED`, `SQLITE_BACKUP_ENABLED`, `SQLITE_DELETION_PASSWORD` |
| Vector backend | `VECTOR_BACKEND` — defaults to `local` (in-server, no external calls); set `vertex`\|`pinecone` to use a hosted store |
| Pinecone (only if `VECTOR_BACKEND=pinecone`) | `PINECONE_API_KEY`, `PINECONE_INDEX`, `PINECONE_INTEGRATED` |
| Vertex AI / GCP (only if `VECTOR_BACKEND=vertex`) | `GCP_PROJECT_ID`, `VERTEX_REGION`, `VERTEX_INDEX_ID`, `VERTEX_INDEX_ENDPOINT_ID`, `VERTEX_DEPLOYED_INDEX_ID`, `VERTEX_INDEX_ENDPOINT_DOMAIN`, `GOOGLE_APPLICATION_CREDENTIALS` |
| KB source override | `KNOWLEDGE_BASE_PATH` (defaults to `knowledge-base/nxtwave-intensive-brain-memory-kb.txt`) |
| WhatsApp (Gallabox) | `GALLABOX_API_KEY`, `GALLABOX_API_SECRET`, `GALLABOX_CHANNEL_ID`, `GALLABOX_PHONE`, `GALLABOX_WEBHOOK_SECRET`, `GALLABOX_BOT_ACCOUNT_ID` (optional) |
| Dashboard | `DASHBOARD_CORS_ORIGIN`, `TRUST_PROXY` |

### Knowledge base setup

The default `local` backend needs no provisioning. It indexes on first start and re-indexes
automatically whenever the KB file changes; to force it:

```bash
npm run ingest-kb                       # or: node src/scripts/force-reindex-kb.js
```

For a hosted backend, first `npm run vertex:setup` (or `npm run pinecone:setup`) and set
`VECTOR_BACKEND`. KB file authoring format (QA-delimited `.txt` or pre-chunked `.json`) is
documented in [docs/RAG-FRAMEWORK.md](docs/RAG-FRAMEWORK.md).

### WhatsApp (Gallabox) setup

1. Gallabox → Settings → Developer → API Keys: create a key; set `GALLABOX_API_KEY` / `GALLABOX_API_SECRET`.
2. Gallabox → Settings → Connect → WhatsApp Channel: copy the channel id into `GALLABOX_CHANNEL_ID`,
   and set `GALLABOX_PHONE` to that number with country code (e.g. `919876543210`).
3. Gallabox → Settings → Webhooks → Add Webhook: URL `https://<backend>/webhooks/gallabox`, event
   `Message.Received` (optionally `Message.WA.Status.Failed`), and a secret — set the same value as
   `GALLABOX_WEBHOOK_SECRET` (required when `NODE_ENV=production`).
4. Turn off any Gallabox bot / auto-reply on that number, or two bots will answer.

The dashboard's Connect page shows the status and the exact webhook URL to paste.

Free-form replies only work within 24 hours of the contact's last message (a WhatsApp rule);
outside that window WhatsApp requires an approved template. That affects `/remind` reminders and
coach messages sent from the dashboard to quiet chats.

## Media

Voice notes are transcribed (Whisper) and answered; PDFs are text-extracted and answered in
context. Images, video and other files are stored and acknowledged, and also raise a
"Call to Action" item for a coach.

## Deployment

### Backend → Render

[render.yaml](render.yaml) builds `backend/Dockerfile` with `backend/` as the Docker context and
only redeploys on changes under `backend/`. `data/` (SQLite — every conversation — plus the KB
index) lives on Render's persistent disk, so it survives redeploys. Set the secrets marked
`sync: false` in the Render dashboard. Render's own URL (`RENDER_EXTERNAL_URL`) is used to show
the Gallabox webhook URL on the Connect page; set `PUBLIC_BASE_URL` to override it (custom domain).

### Frontend → Netlify

New site from this repo with **Base directory = `frontend`**; `frontend/netlify.toml` supplies the
build command (`npm ci && npm run build`), publish dir (`dist`), the SPA fallback, and the
`/api/*` proxy to `https://pulse-whatapp-bot.onrender.com` — edit that host if your Render
service URL differs. Netlify cuts proxied requests off after ~26s, so very long dashboard
operations (big imports/exports) should be kept under that.

Gallabox webhooks go straight to Render (`https://<render-service>/webhooks/gallabox`), not via
Netlify.

### Local Docker

`backend/docker-compose.yml` runs the backend (`mem_limit: 1g`) with `data/`, `logs/`,
`knowledge-base/`, and `secrets/` (read-only) mounted as volumes:

```bash
cd backend
docker-compose up -d --build
docker-compose logs -f
```

### PM2 (non-Docker)

```bash
cd backend && pm2 start src/app.js --name whatsapp-bot
pm2 save && pm2 startup
```

## Evaluation (Opik)

`Opik/` runs the deployed `/api/test/chat` endpoint against a golden dataset ("Academy Intensive
Eval v1") and scores replies with an LLM-judge rubric (`runtest.py`). `eval_averaging_harness.py`
repeats each case N times and re-scores each generation J times to separate real regressions from
generation/judge noise.

> ⚠️ `Opik/runtest.py` currently hardcodes an OpenRouter API key and an Academy chat API token
> directly in source rather than loading them from `Opik/.env`. Rotate and move these before
> sharing or publishing this repo.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No replies, nothing in logs | Check the Gallabox webhook URL/event; Connect page → "Last message" should update |
| `Rejected Gallabox webhook` in logs | `GALLABOX_WEBHOOK_SECRET` doesn't match the secret on the Gallabox webhook |
| `Gallabox not configured` at startup | One of the `GALLABOX_*` env vars is missing (listed in the log line) |
| Reply fails with a Gallabox API error | Usually the 24h window has closed — the contact must message first, or use a template |
| Voice messages fail | Confirm `ffmpeg -version` works; check `logs/error.log` |
| KB / RAG issues | See the Troubleshooting table in [docs/VERTEX-PIPELINE.md](docs/VERTEX-PIPELINE.md) — every KB call now logs a correlation id, timing, and host IP |
| AI errors | Verify `OPENAI_API_KEY`; check provider status/rate limits |
| Database errors | Ensure `data/` is writable (disk mode); check `logs/error.log` |

## License

MIT
