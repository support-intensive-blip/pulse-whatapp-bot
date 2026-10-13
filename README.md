# WhatsApp AI Assistant

**Pulse** — a multi-team WhatsApp AI platform built on the **WhatsApp Business API via
Gallabox** + **OpenAI**, with a hybrid (dense + BM25) RAG knowledge base, a React operator
dashboard, and optional BigQuery-backed durable storage. One owner runs many teams; each team
connects any number of Gallabox numbers, and every number is an independent AI bot with its own
credentials, prompt, knowledge and behavior.

The repo has two deployable halves:

| Folder | What | Deployed to |
|---|---|---|
| [backend/](backend/) | Node/Express API, Gallabox webhook, AI + KB, SQLite | **Render** (Docker, persistent disk) — [render.yaml](render.yaml) |
| [frontend/](frontend/) | React + Vite dashboard | **Netlify** — [frontend/netlify.toml](frontend/netlify.toml) |

Code paths in this README (`src/...`, `knowledge-base/...`) are relative to `backend/`.

Prompts and knowledge are edited per bot in the dashboard. The original single-number setup is
imported automatically on first boot (`src/services/platformBootstrapService.js`):
- `GALLABOX_*` env → the first bot's encrypted credentials (seed only — afterwards the dashboard owns them)
- `src/config/intensive-system-prompt.txt` → that bot's prompt, version 1
- `knowledge-base/nxtwave-intensive-brain-memory-kb.txt` → a team knowledge document linked to it
  (it keeps following the file on redeploys until someone edits it in the dashboard)

> `team_settings` / `api_key_access_requests` are leftovers from an older multi-tenant design and
> are unused.

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
│   ├── middleware/auth.js     # JWT auth, roles, team/number scope (req.scope)
│   ├── dashboardRoutes.js     # Auth, unified inbox, conversations, stats; mounts the routers below
│   ├── teamRoutes.js          # Owner: teams, platform overview, audit log
│   ├── userRoutes.js          # Team admin: members, roles, password resets
│   ├── botRoutes.js           # Team admin: numbers/bots, credentials, prompt versions, playground
│   ├── knowledgeRoutes.js     # Team admin: knowledge documents
│   ├── contactRoutes.js       # Contacts list, CSV import (preview → commit), export
│   ├── actionItemRoutes.js    # Call-to-Actions
│   ├── analyticsRoutes.js     # Metrics derived from messages / action items
│   ├── gallaboxWebhookRoutes.js  # POST /webhooks/gallabox/:botId (+ legacy /webhooks/gallabox)
│   ├── routes.js              # Public /health and /knowledge-base status (no contact data)
│   └── testApiRoutes.js       # /api/test/chat — used by the Opik eval harness
├── bot/
│   ├── gallabox/              # Gallabox REST client (send, media download, HMAC) + payload normalizer
│   ├── gallaboxBot.js         # One connected number: webhook events in, replies out (own credentials)
│   ├── botManager.js          # Runs one GallaboxBot per active, configured number
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

Schema (`src/database/schema.js`, platform migrations in `src/database/platformMigrations.js`):
`teams`, `dashboard_users` (web logins with `role` + `team_id`), `bot_accounts` (one row per
WhatsApp number: team, encrypted Gallabox credentials, live prompt, linked knowledge, behavior),
`bot_prompt_versions`, `knowledge_resources`, `audit_log`, `users`, `chat_profiles`
(per-conversation state, scoped to the bot's number in `owner_phone`, plus tags / assignee / notes),
`messages`, `conversation_summaries`, `student_user_memory` (keyed by bot number + student phone),
`token_usage`, `action_items`, `push_subscriptions`, `notes`, `reminders`.

## Multi-team model

```
Owner (seeded from DASHBOARD_ADMIN_EMAIL/PASSWORD; no team, switches between teams)
   └── team
         ├── dashboard_users: team_admin(s), team_user(s)
         ├── knowledge_resources (shared by the team's bots)
         └── bot_account (one per Gallabox WhatsApp number — an independent AI bot)
                ├── credentials, prompt (+ versions), linked knowledge, AI status, behavior
                └── chat_profile (per contact chatting with that number)
```

- **Owner**: creates/deactivates teams, assigns admins, sees every team (audit-logged).
- **Team admin**: numbers, credentials, prompts, knowledge, behavior, testing, users — plus everything a user does.
- **Team user**: inbox, manual replies, AI on/off per chat, contacts + CSV import, Call-to-Actions.
  Never sees secrets, prompts or other teams.

Every API request is scoped by `api/middleware/auth.js`: the team (owner picks it with
`x-team-id`), and optionally one number (`x-bot-id` / `?botId=`; absent = "All numbers").
Chats of different numbers are never merged, even for the same student. Deactivating a team
signs its users out and stops its numbers. Run `npm run check:isolation` (backend) for an
end-to-end check of these rules against a throwaway database.

## Knowledge base / RAG

Knowledge documents belong to a team (`knowledge_resources`, text stored in the DB); each bot links
the documents it answers from. Every bot has its **own index**, built from its linked documents:

- **Vector store:** `VECTOR_BACKEND=supabase` (production) — OpenAI embeddings
  (`KB_EMBED_MODEL`, default `text-embedding-3-small`, 1536d) in **Supabase pgvector**
  (`kb_vector_chunks` + `kb_vector_indexes`, one namespace per bot, created on first use over
  `SUPABASE_DB_URL`). Dense hits are fused with an in-process BM25 index, which is rebuilt from
  Supabase whenever the local copy is missing — so no persistent disk is needed for the KB.
  A re-index writes a new generation and swaps it in atomically; a failed embed keeps the old one.
  Without `SUPABASE_DB_URL` it falls back to `local`: the in-server TF-IDF + BM25 index persisted
  to `data/kb_vectors_team_bot_<id>.json` (no external calls).
- Team admins manage documents on **Knowledge Base**: upload one or many files (drag and drop),
  paste text, edit, or **Replace file** to upload a new version. Replacing a file-backed document
  detaches it from the repo file.
- A bot re-indexes when its linked documents change (fingerprint of ids + content hashes), on the
  dashboard's "Re-index" button, and on the periodic refresh, which also re-reads file-backed
  documents.

Retrieval is gated to `INTENSIVE` conversation mode only. `npm run ingest-kb` /
`force-reindex-kb.js` still rebuild the old global index used outside a bot context.

Moving to Supabase: set `SUPABASE_DB_URL`, run `npm run kb:migrate-supabase` once (re-embeds every
bot's linked documents), then deploy with `VECTOR_BACKEND=supabase`. Without the script, each bot
re-embeds on its first message after the switch (~20–30 s for a large KB).

`VECTOR_BACKEND=vertex|pinecone` opts into those hosted stores instead (requires the matching env vars and
`vectorStoreService.js` / the Vertex + Pinecone modules, which are retained but dormant). KB
authoring format, chunking rules and the topic guard are in
**[docs/RAG-FRAMEWORK.md](docs/RAG-FRAMEWORK.md)**.

## Message pipeline

```
Contact messages the business number
   → Gallabox → POST /webhooks/gallabox/:botId (HMAC-verified with that bot's secret, acked immediately)
   → that number's gallaboxBot.js (dedupe by WhatsApp message id), inside its bot context
     (utils/botContext.js: prompt, assistant name and KB index come from this bot)
   → messageHandler.js
        ├─ store message (text, or media description) in `messages`
        ├─ bot paused? → store only · testing? → test numbers only · per-chat AI on/off
        ├─ escalation / scope firewall
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

The top bar carries the team selector (owner) and the WhatsApp number selector ("All numbers" or
one); every page follows it. Navigation adapts to the role.

Pages: Overview, Inbox (three columns: chats with number badges, chat with AI Active / "AI Paused
— Human Handling" banner, contact details + related Call-to-Actions), Contacts (CSV import wizard),
Call to Actions (table + Kanban + detail drawer), Analytics, AI Bots, Connect-number wizard, Bot
workspace (Overview · AI Prompt with versions · Knowledge · Behavior · Testing playground ·
Integration · Activity), Knowledge Base, Team & Users, Integrations, Teams (owner), Settings.

## REST API

All under `/api` (`src/api/dashboardRoutes.js`) unless noted:

| Group | Covers |
|---|---|
| `/auth/*` | Login, current user + team/numbers/permissions, password change |
| `/owner/overview`, `/teams`, `/audit-log` | Owner only |
| `/team/members`, `/users/*` | Roster (all roles) · member management (admins) |
| `/bots/*` | Numbers, credentials (write-only), test connection, prompt + versions, knowledge links, playground, activity (admins) |
| `/knowledge/*` | Team knowledge documents (admins) |
| `/conversations/*` | Unified inbox, messages, send, AI toggle, contact details, import/export, summarize, escalate |
| `/contacts/*` | Contact list, CSV template, import preview/commit, export |
| `/action-items/*` | Call-to-Actions: list/filter, detail, create, update/assign/resolve |
| `/analytics` | Volume, AI vs human, CTA trends, per-number comparison |
| `/stats` | Aggregate counts for the selected scope |
| `/notifications/*` | Web-push subscribe + notification inbox |
| `/admin/sqlite-*` | SQLite backup / guard / purge (owner) |

`POST /webhooks/gallabox/:botId` receives one number's webhooks; the legacy `POST /webhooks/gallabox`
still works and routes by the payload's `channelId`. Public root GETs (`src/api/routes.js`):
`/health` and `/knowledge-base` only. `/api/test/chat` (`testApiRoutes.js`) is a synchronous chat
endpoint used only by the Opik eval harness (`TEST_API_BOT_ID` picks the number it talks to).

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
| Vector backend | `VECTOR_BACKEND` — `supabase` (pgvector over `SUPABASE_DB_URL`; `KB_EMBED_MODEL`, `KB_EMBED_DIMENSIONS`, `KB_PG_POOL_MAX`), or `local` (default, in-server, no external calls); `vertex`\|`pinecone` for those hosted stores |
| Pinecone (only if `VECTOR_BACKEND=pinecone`) | `PINECONE_API_KEY`, `PINECONE_INDEX`, `PINECONE_INTEGRATED` |
| Vertex AI / GCP (only if `VECTOR_BACKEND=vertex`) | `GCP_PROJECT_ID`, `VERTEX_REGION`, `VERTEX_INDEX_ID`, `VERTEX_INDEX_ENDPOINT_ID`, `VERTEX_DEPLOYED_INDEX_ID`, `VERTEX_INDEX_ENDPOINT_DOMAIN`, `GOOGLE_APPLICATION_CREDENTIALS` |
| KB source override | `KNOWLEDGE_BASE_PATH` (defaults to `knowledge-base/nxtwave-intensive-brain-memory-kb.txt`) |
| Secrets at rest | `ENCRYPTION_KEY` (falls back to `JWT_SECRET`) encrypts Gallabox keys — **changing it makes saved credentials unreadable** (the dashboard asks to re-enter them) |
| WhatsApp (Gallabox) | Configured per number in the dashboard. `GALLABOX_API_KEY`, `GALLABOX_API_SECRET`, `GALLABOX_CHANNEL_ID`, `GALLABOX_PHONE`, `GALLABOX_WEBHOOK_SECRET`, `GALLABOX_ACCOUNT_ID`, `GALLABOX_BOT_ACCOUNT_ID` only seed the first number at bootstrap |
| Dashboard | `DASHBOARD_CORS_ORIGIN`, `TRUST_PROXY`, `PUBLIC_BASE_URL` (webhook URLs shown in the UI) |

### Knowledge base setup

The `supabase` backend creates its tables on first use (`npm run kb:migrate-supabase` warms every
bot's index). The `local` backend needs no provisioning. It indexes on first start and re-indexes
automatically whenever the KB file changes; to force it:

```bash
npm run ingest-kb                       # or: node src/scripts/force-reindex-kb.js
```

For a hosted backend, first `npm run vertex:setup` (or `npm run pinecone:setup`) and set
`VECTOR_BACKEND`. KB file authoring format (QA-delimited `.txt` or pre-chunked `.json`) is
documented in [docs/RAG-FRAMEWORK.md](docs/RAG-FRAMEWORK.md).

### WhatsApp (Gallabox) setup

Per number, as a team admin: **AI Bots → Connect WhatsApp number**.

1. Gallabox → Settings → Developer → API Keys: create a key; paste key + secret in the wizard.
2. Gallabox → Settings → Connect → WhatsApp Channel: copy the channel id (and the account id, which
   lets "Test connection" verify the key).
3. Choose a webhook secret in the wizard. Then Gallabox → Settings → Webhooks → Add Webhook: the URL
   the wizard shows (`https://<backend>/webhooks/gallabox/<botId>`), event `Message.Received`
   (optionally `Conversation.Create/Update`, `Message.WA.Status.Failed`), and the same secret
   (required when `NODE_ENV=production`).
4. Turn off any Gallabox bot / auto-reply on that number, or two bots will answer.

New numbers start paused or in testing mode; the bot workspace's Testing tab runs the real
pipeline without sending anything. Existing deployments keep working unchanged: the env-configured
number is imported on first boot and the legacy webhook URL still routes to it.

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
the Gallabox webhook URLs in the dashboard; set `PUBLIC_BASE_URL` to override it (custom domain).

### Frontend → Netlify

New site from this repo with **Base directory = `frontend`**; `frontend/netlify.toml` supplies the
build command (`npm ci && npm run build`), publish dir (`dist`), the SPA fallback, and the
`/api/*` proxy to `https://pulse-whatapp-bot.onrender.com` — edit that host if your Render
service URL differs. Netlify cuts proxied requests off after ~26s, so very long dashboard
operations (big imports/exports) should be kept under that.

Gallabox webhooks go straight to Render (`https://<render-service>/webhooks/gallabox/<botId>`),
not via Netlify.

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
| No replies, nothing in logs | Check the Gallabox webhook URL/event; bot workspace → Integration → "Last webhook received" should update |
| No replies, messages stored | The bot is Paused, or in Testing and the sender isn't a test number, or AI is off for that chat |
| `Rejected Gallabox webhook` in logs | The secret on the Gallabox webhook doesn't match the one saved for that number |
| "Saved secrets can't be decrypted" | `ENCRYPTION_KEY` / `JWT_SECRET` changed — re-enter the credentials on the Integration tab |
| Reply fails with a Gallabox API error | Usually the 24h window has closed — the contact must message first, or use a template |
| Voice messages fail | Confirm `ffmpeg -version` works; check `logs/error.log` |
| KB / RAG issues | See the Troubleshooting table in [docs/VERTEX-PIPELINE.md](docs/VERTEX-PIPELINE.md) — every KB call now logs a correlation id, timing, and host IP |
| AI errors | Verify `OPENAI_API_KEY`; check provider status/rate limits |
| Database errors | Ensure `data/` is writable (disk mode); check `logs/error.log` |

## License

MIT
