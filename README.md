# WhatsApp AI Assistant

A production, single-tenant WhatsApp AI assistant built on **whatsapp-web.js** + **OpenAI**, with
a hybrid (dense + BM25) RAG knowledge base, a React operator dashboard, and BigQuery-backed
durable storage. One dashboard login, one WhatsApp number, one hardcoded persona.

The system prompt and knowledge base are fixed in code:
- **System prompt:** `src/config/intensiveConfig.js` (loads `src/config/intensive-system-prompt.txt`)
- **Knowledge base:** `knowledge-base/nxtwave-intensive-knowledge-base.pdf`

> Earlier versions were multi-tenant (owner → team admins → users, per-team configs in
> `team_settings`). That machinery was removed; the `teams` / `team_settings` /
> `api_key_access_requests` tables still exist but are unused.

> This file is the top-level map. For the two most-changed subsystems there are dedicated docs:
> **[docs/RAG-FRAMEWORK.md](docs/RAG-FRAMEWORK.md)** (KB chunking/retrieval/gating rules) and
> **[docs/VERTEX-PIPELINE.md](docs/VERTEX-PIPELINE.md)** (the active vector-search backend,
> step-by-step, with the full debug-logging reference).

---

## Architecture

```
src/
├── app.js                     # Entry point: DB init, config load, Express + WhatsApp bots, cron
├── api/
│   ├── dashboardRoutes.js     # Main API — auth, conversations, bot lifecycle, action items
│   ├── routes.js              # Legacy simple GETs (/health, /users, /stats, ...)
│   └── testApiRoutes.js       # /api/test/chat — used by the Opik eval harness
├── bot/
│   ├── whatsapp.js            # WhatsApp client lifecycle, QR/pairing, reconnection
│   └── messageHandler.js      # Inbound routing: slash commands vs. free-text → chatService
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

dashboard/                     # React + Vite operator UI, built into dashboard/dist and served by Express
Opik/                          # Offline eval harness scoring bot replies against a golden dataset
deploy/{gcp,aws,bigquery}/     # Deployment guides + scripts per target
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
row per WhatsApp number/session, linked to a `dashboard_user_id`), `action_items`,
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
WhatsApp message → messageHandler.js
   ├─ slash command? (/help, /ping, /reset, /summary, /note, /remind, /model, /tokens, /profile, /assistant, ...)
   └─ free text → inboundMessageBatcher.js (debounces rapid multi-fragment messages, ~10s window)
                     → chatService.js
                          ├─ contextService.resolveMode() → CASUAL vs INTENSIVE
                          ├─ INTENSIVE + KB-eligible? → hybrid KB retrieval → inject into prompt
                          ├─ LLM call (OpenAI; tiered by contextState)
                          └─ replyRules.js (firewall/sanitize) → messageSplitter.js → send
```

## Dashboard

React + Vite SPA (`dashboard/`), built via `npm run dashboard:build` into `dashboard/dist` and
served by Express as a static SPA with client-side routing. Talks to the backend through a thin
fetch wrapper (`dashboard/src/api/client.js`) using a bearer token from `localStorage`.

Pages: Login, Dashboard, Connect (WhatsApp QR/pairing), Conversations, ConversationDetail,
BotSettings, ActionItems, Account.

## REST API

All under `/api` (`src/api/dashboardRoutes.js`) unless noted:

| Group | Covers |
|---|---|
| `/auth/*` | Login, current user, password change |
| `/admin/sqlite-*` | SQLite backup / guard / purge |
| `/bot/*` | WhatsApp session lifecycle — start/stop/QR/pairing-code/settings |
| `/notifications/*` | Web-push subscribe + notification inbox |
| `/conversations/*` | List/sync/send, assistant toggle, CSV import/export, escalate |
| `/action-items` | Action item tracking |
| `/stats` | Aggregate counts |

Legacy simple GETs at root (`src/api/routes.js`): `/health`, `/users`, `/notes`, `/reminders`,
`/knowledge-base`, `/chats`, `/stats`. `/api/test/chat` (`testApiRoutes.js`) is a synchronous
chat endpoint used only by the Opik eval harness.

## Requirements

- Node.js 18+
- FFmpeg (voice message transcription)
- OpenAI API key
- A phone with WhatsApp for QR/pairing-code linking
- Optional: a GCP project only if `BQ_ENABLED=true` (BigQuery durable storage) or if you switch
  `VECTOR_BACKEND` back to `vertex`. The default `local` KB needs neither.

## Setup

```bash
npm install
npm run dashboard:install
cp .env.example .env   # then fill in required vars — see below
npm run dashboard:build
npm start
```

`npm run dev` uses `node --watch` for auto-restart during development.

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
| Bot/session | `WHATSAPP_AUTO_START`, `WHATSAPP_AUTO_START_DELAY_MS` |
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

### WhatsApp linking

Start the app, open the dashboard's Connect page (or the terminal QR on first CLI run), and
scan/pair. Sessions persist in `.wwebjs_auth/`.

## Commands (in-chat)

| Command | Description |
|---|---|
| `/help` | Show all commands |
| `/ping` | Health check |
| `/reset` | Clear conversation history |
| `/summary` | AI summary of chat history |
| `/note <text>` / `/notes` | Save / list notes |
| `/remind YYYY-MM-DD HH:MM <msg>` | Set a reminder |
| `/model` | Show/switch model tier |
| `/tokens` | Token usage for the conversation |
| `/profile` / `/me` | Chat profile info |
| `/assistant` | Toggle assistant on/off for this chat |

**Media:** voice messages are transcribed and answered; PDFs are summarized.

## Deployment

Guides per target under `deploy/`:

- **`deploy/gcp/`** — Compute Engine VM + Docker (the primary target). Default `e2-medium`
  (Chromium + WhatsApp needs ≥4GB RAM — do not use `e2-small`). Driven by
  `deploy/gcp/deploy.ps1`. Includes hot-patch scripts for live KB/config updates without a full
  redeploy. See [deploy/gcp/DEPLOY.md](deploy/gcp/DEPLOY.md).
- **`deploy/aws/`** — parallel path for AWS.
- **`deploy/bigquery/`** — BigQuery dataset/table setup.

`Dockerfile` / `docker-compose.yml` at repo root run a single service, `shm_size: 2gb`,
`mem_limit: 3g`, with `data/`, `logs/`, `knowledge-base/`, and `secrets/` (read-only) mounted as
volumes.

```bash
docker-compose up -d --build
docker-compose logs -f          # QR code appears here on first run
```

### PM2 (non-Docker)

```bash
pm2 start src/app.js --name whatsapp-bot
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
| QR code not appearing | Ensure Chromium deps installed (Docker image includes them); delete `.wwebjs_auth/`/`.wwebjs_cache/` and restart |
| Authentication failure | `rm -rf .wwebjs_auth .wwebjs_cache`, restart, re-scan |
| Voice messages fail | Confirm `ffmpeg -version` works; check `logs/error.log` |
| KB / RAG issues | See the Troubleshooting table in [docs/VERTEX-PIPELINE.md](docs/VERTEX-PIPELINE.md) — every KB call now logs a correlation id, timing, and host IP |
| AI errors | Verify `OPENAI_API_KEY`; check provider status/rate limits |
| Database errors | Ensure `data/` is writable (disk mode); check `logs/error.log` |
| WhatsApp disconnects | Auto-reconnects up to 10 attempts; persistent disconnects need a fresh QR scan |

## License

MIT
#   p u l s e - w h a t a p p - b o t  
 #   p u l s e - w h a t a p p - b o t  
 #   p u l s e - w h a t a p p - b o t  
 #   p u l s e - w h a t a p p - b o t  
 #   p u l s e - w h a t a p p - b o t  
 