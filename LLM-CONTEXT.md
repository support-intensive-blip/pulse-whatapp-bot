
# Project context: "Pulse" WhatsApp AI assistant (NxtWave Intensive)

You are picking up work on an existing codebase. Sections 2–10 describe the pipeline as of 2026-10-07; **§11 describes the multi-team platform
added on 2026-10-12, which supersedes anything single-tenant below** (one login, one number,
hardcoded prompt/KB, `getAnyReadyBot`, `GALLABOX_*` as the live config).

## 1. What it is

"Pulse": a multi-team WhatsApp AI platform, first used for students of the NxtWave "Intensive"
program. An owner creates teams; each team connects many Gallabox WhatsApp Business numbers,
and each number is an independent AI bot (own credentials, prompt, knowledge, behavior). The bot
answers with OpenAI, grounded in that bot's knowledge (hybrid RAG). Team users work from one
unified inbox: watch chats, take over from the AI, import contacts, handle Call-to-Actions.

- Repo: GitHub `support-intensive-blip/pulse-whatapp-bot`, branch `main`.
- Local path: `F:\My Works\whatsapp bot` (Windows 11, PowerShell / Git Bash).
- Languages: Node.js (CommonJS, Express) backend; React + Vite + Tailwind frontend.
- Students often write in Telugu, Tenglish, Hindi or Hinglish. Non-English questions are
  translated to English before KB search.

## 2. Repo layout

```
backend/                      Node/Express API (deployed to Render with Docker)
  src/app.js                  entry: env check, DB init, Express, Gallabox bot, cron jobs
  src/api/
    gallaboxWebhookRoutes.js  POST /webhooks/gallabox (HMAC check, ack 200, process async)
    dashboardRoutes.js        /api/* for the dashboard (auth, conversations, bot settings, action items)
    routes.js                 legacy GETs: /health, /users, /stats ...
    testApiRoutes.js          /api/test/chat, a synchronous chat endpoint for the Opik eval harness
  src/bot/
    gallaboxBot.js            one WhatsApp number: webhook events in, replies out  <-- being edited now
    gallabox/gallaboxApi.js   Gallabox REST client: sendText, downloadMedia, verifySignature
    gallabox/inboundMessage.js normalizes a Gallabox payload into the handler's message shape
    botManager.js             picks which dashboard bot_account owns the number
    messageHandler.js         store → escalation → AI on/off / test mode → firewall → batcher → chatService
  src/services/               business logic (chatService, contextService, knowledgeBaseService,
                              kbHybridSearch, chatProfileService, escalationService, inboundMessageBatcher ...)
  src/ai/                     systemPrompts.js, replyRules.js (output sanitizing), messageSplitter.js
  src/config/intensiveConfig.js  hardcoded system prompt (intensive-system-prompt.txt), KB path, firewall config
  src/database/               better-sqlite3 + optional BigQuery write-through / hydration
  knowledge-base/nxtwave-intensive-brain-memory-kb.txt   the KB (QUESTION_ID: blocks)
  Dockerfile, deploy/docker-entrypoint.sh, docker-compose.yml
frontend/                     React dashboard (deployed to Netlify)
docs/BOT-BEHAVIOR.md          runtime behavior + every timing value (read this first)
docs/RAG-FRAMEWORK.md         KB authoring format, chunking, retrieval gating
docs/VERTEX-PIPELINE.md       the dormant Vertex vector backend
render.yaml                   Render Blueprint for backend/
```

## 3. Message pipeline

```
Student → WhatsApp → Gallabox → POST /webhooks/gallabox
  - verify x-gallabox-signature (HMAC-SHA256 of the raw body with GALLABOX_WEBHOOK_SECRET; base64 or hex accepted)
  - in production, refuse with 503 if no secret is configured
  - respond 200 immediately; handle in the background
→ GallaboxBot.handleWebhookEvent(eventName, payload)
  - eventName comes from the x-event-name header (falls back to body.event / 'Message.Received')
  - drop messages for another channelId; dedupe by WhatsApp message id (in-memory, last 5000)
→ fromGallaboxPayload(): text / interactive / location / contacts → text; image/audio/voice/video/document/sticker → media
→ MessageHandler.handleMessage(): store, escalation, AI on/off, test mode, firewall
→ inboundMessageBatcher (default 10s debounce; fragments combined into one turn)
→ chatService.generateResponse()
  - contextService.resolveMode(): CASUAL (no KB, temp 0.8) | INTENSIVE (KB retrieval, temp 0.2) | GURU (unused)
  - time-windowed history (60 min default, max 40 msgs / 8000 chars) + contextNote (IST time, saved prefs, slots, last summary)
  - OpenAI call; the model returns structured JSON (assistant_message / conversation_end / summary / user_preferences)
→ replyRules sanitize → messageSplitter → gallaboxApi.sendText() → stored in messages
```

Facts about the pipeline:
- Chat replies currently always use the fast tier (`OPENAI_MODEL_FAST`, gpt-4o-mini). Smart
  (gpt-4o) is used only for `/summary`, and `/model smart` has no visible effect.
- No typing indicator: the Gallabox API has none.
- WhatsApp's 24-hour rule applies: free-form sends only work within 24h of the contact's last
  message, so reminders and coach messages to quiet chats fail.
- There are no slash commands (the old `src/commands/*` were removed — the Business API has no
  self-chat to type them in). A message starting with `/` is answered like any other.
- Voice notes are transcribed with Whisper (needs ffmpeg). PDFs are text-extracted (12k chars).
  Images, videos and links are acknowledged and also create a "Call to Action" item.
- Scope firewall and the AI escalation classifier exist but are off (`intensiveConfig.js`).
- **Testing mode** (`bot_accounts.test_mode_enabled` + `test_numbers`, added in the last commits
  "v2-testmode"): while on, the bot replies only to the listed numbers. Everyone else's messages
  are stored without a reply.

## 4. WhatsApp provider: Gallabox

On 2026-10-05 the project moved from whatsapp-web.js (headless Chromium + QR session) to
**Gallabox** (WhatsApp Business API). Gupshup was considered and rejected.

- Outbound: `POST https://server.gallabox.com/devapi/messages/whatsapp` with `apiKey` /
  `apiSecret` headers and body `{ channelId, channelType:'whatsapp', recipient:{name,phone}, whatsapp:{type:'text',text:{body}} }`.
- Inbound: Gallabox webhook (Settings → Webhooks) → `https://<render-service>/webhooks/gallabox`.
  This goes straight to Render, not through Netlify.
- Env vars: `GALLABOX_API_KEY`, `GALLABOX_API_SECRET`, `GALLABOX_CHANNEL_ID`, `GALLABOX_PHONE`
  (digits with country code, e.g. 91XXXXXXXXXX), `GALLABOX_WEBHOOK_SECRET` (required in
  production), `GALLABOX_ACCOUNT_ID`, and optionally `GALLABOX_BOT_ACCOUNT_ID`.
- Gallabox's own bot / auto-reply must be off on that number, or two bots will answer.
- The Gallabox payload shapes are only partly documented. Media URL keys are guessed
  (`findMediaUrl` scans for any http URL).

## 5. Current uncommitted change (work in progress)

File: `backend/src/bot/gallaboxBot.js`. It is the only modified file.

Before: only `Message.Received` was processed; every other event was logged and skipped.

Now: `Conversation.Create` and `Conversation.Update` events are also accepted, through a new
`extractInboundFromConversation(eventName, payload)` method. It turns the event into an
inbound message only when all of these hold:
- `payload.latestChatMessage || payload.latestMessage` exists and has a `whatsapp` node
- `whatsapp.status === 'received'` (an inbound message, not an agent or bot reply)
- `latest.sender` matches `payload.contactId` (when both are present)
- `whatsapp.from` is not the bot's own number
- the message is less than 10 minutes old (`CONVERSATION_EVENT_MAX_AGE_MS`), judged from
  `whatsapp.time` or `latest.createdAt`. This keeps later events about old messages (tags,
  assignments, read state) from triggering a reply.

It returns `{ ...latest, channelId, contact: { id, name } }`, which then flows through the
normal `fromGallaboxPayload` → dedupe → handler path.

Open risks and things to verify for this change:
1. **Timestamp format.** WhatsApp/Meta `time`/`timestamp` values are often Unix epoch seconds
   as a string (e.g. `"1759650000"`). `Date.parse()` on such a string returns NaN or a wrong
   date, which would silently drop every conversation event. Check a real payload and handle
   numeric epoch values (seconds vs milliseconds).
2. **Field names are assumptions.** `latestChatMessage`, `latestMessage`, `sender`,
   `contactId` and `whatsapp.status` need to be confirmed against real Gallabox
   `Conversation.*` payloads. The warning log in `handleWebhookEvent` prints payload keys and can help.
3. **Double-answer risk.** If both `Message.Received` and `Conversation.Update` fire for the
   same message, dedupe works only if both carry the same WhatsApp message id
   (`wa.id || payload.id`). The seen-id set is in memory and resets on restart.
4. **Docs are now stale.** `docs/BOT-BEHAVIOR.md` §1 ("only Message.Received is processed"),
   the README webhook setup steps, `render.yaml` comments and the JSDoc in
   `gallaboxWebhookRoutes.js` all still say only `Message.Received` is handled.
5. There are no automated tests in the repo. Verify by replaying captured webhook payloads
   against `POST /webhooks/gallabox` locally, with the secret unset and `NODE_ENV` not set to production.

## 6. Storage

- Default: SQLite at `backend/data/assistant.db` (better-sqlite3) on Render's persistent disk.
  The disk is mounted at `/app/persist`, and `docker-entrypoint.sh` symlinks `/app/data` to
  `/app/persist/data`.
- Optional: BigQuery write-through (`BQ_ENABLED=true`), or BigQuery-primary
  (`BQ_ENABLED=true` + `SQLITE_ENABLED=false`, which runs SQLite in memory and hydrates from BigQuery on boot).
- Main tables: `users`, `chat_profiles` (per-contact state; several chat ids merged into one
  canonical profile), `messages`, `conversation_summaries`, `student_user_memory`,
  `token_usage`, `dashboard_users`, `bot_accounts` (one WhatsApp number, holding settings
  such as batch/reply delay, context window, test mode), `action_items`, `push_subscriptions`.
  `teams` / `team_settings` are leftovers from the removed multi-tenant design.
- Migrations are ad-hoc `ALTER TABLE ... ADD COLUMN` checks in `database/db.js`.

## 7. Knowledge base / RAG

- Source: `backend/knowledge-base/nxtwave-intensive-brain-memory-kb.txt`, in QA blocks keyed
  by `QUESTION_ID:`.
- Production `VECTOR_BACKEND=supabase`: OpenAI embeddings stored in Supabase pgvector
  (`services/supabaseVectorStore.js`, tables `kb_vector_chunks` / `kb_vector_indexes`, one
  namespace per bot, generation swap on re-index). Dense hits fuse with a BM25 sparse index via
  RRF (weights 0.85 / 0.15); BM25 is rebuilt from Supabase when its local file is missing.
- Fallback / default `VECTOR_BACKEND=local`: an in-server TF-IDF dense index plus BM25,
  persisted to `data/kb_vectors*.json` and `data/kb_bm25_*.json`. No external embedding API.
- Team admins upload / replace KB documents on the Knowledge Base page
  (`POST /api/knowledge`, `PUT /api/knowledge/:id/file`).
- The index re-indexes automatically when the KB file hash changes (checked every 30 min) or
  on `npm run ingest-kb`.
- Retrieval runs only in INTENSIVE mode. Vertex AI and Pinecone backends exist but are dormant.

## 8. Deployment

- Backend → **Render**, Docker runtime (`render.yaml`, service `pulse-whatapp-bot`, region
  oregon, plan standard, health check `/health`, one 1 GB disk). Secrets are `sync: false`
  and set in the Render dashboard.
- Frontend → **Netlify**, base dir `frontend`. `netlify.toml` proxies `/api/*` to
  `https://pulse-whatapp-bot.onrender.com`, so there is no CORS. Netlify cuts proxied requests at about 26s.
- Required env: `OPENAI_API_KEY`, `JWT_SECRET`, `DASHBOARD_ADMIN_EMAIL` /
  `DASHBOARD_ADMIN_PASSWORD`, the `GALLABOX_*` vars, and `NODE_ENV=production`.
- Undecided: the user once wanted the backend on Vercel. That conflicts with local SQLite,
  because Vercel has no persistent disk. Render is the current answer.

## 9. Security notes (important)

- **Do not read, print or commit** `whatsapp-bot-big query.json` in the repo root. It is
  gitignored and is very likely a GCP service-account key. The same applies to `backend/.env`,
  `backend/secrets/` and `backend/data/`.
- Git history was reset on 2026-08-29 to purge committed dashboard password hashes and an
  old WhatsApp Web session. Rotating the dashboard admin passwords is still outstanding.
- The README notes that `Opik/runtest.py` hardcodes an OpenRouter key and an Academy API
  token. The `Opik/` folder is not in this repo.

## 10. Conventions

- CommonJS (`require`), 2-space indent, single quotes, winston `logger`. Comments are sparse
  and explain *why*, not *what*.
- Services are mostly singletons exported from their module.
- The user commits directly to `main` with short messages such as "v2-testmode".
- Line endings: the repo has `.gitattributes`. Expect LF→CRLF warnings on Windows.
- Run locally: `cd backend && npm install && npm run dev` (port 3000), then
  `cd frontend && npm run dev` (port 5173, proxies /api).

## 11. Multi-team platform (added 2026-10-12)

Roles: `owner` (no team; picks a team with the `x-team-id` header) → `team_admin` / `team_user`
(`dashboard_users.team_id`). `api/middleware/auth.js` builds `req.scope` for every request:
team, its bots, and the optional number filter (`x-bot-id` / `?botId=`). Users never get
secrets, prompts or other teams; secrets are write-only and returned masked.

Data model (`database/schema.js`, `database/platformMigrations.js`, idempotent):
- `bot_accounts` = one Gallabox number: `team_id`, encrypted `gallabox_api_key_enc` /
  `gallabox_api_secret_enc` / `webhook_secret_enc` (utils/secretCrypto.js, key `ENCRYPTION_KEY`
  or `JWT_SECRET`), `gallabox_channel_id` (unique), `ai_status` active|paused|testing,
  `default_ai_on`, `is_active`, `system_prompt` (live), `knowledge_resource_ids` (JSON),
  `last_inbound_at`. The old one-bot-per-user UNIQUE constraint was dropped (table rebuilt).
- `bot_prompt_versions`, `knowledge_resources` (team docs, text in DB, soft delete,
  `source_path` = mirrors a repo file), `audit_log`.
- `student_user_memory` is keyed by `(owner_phone, phone)` — memory never crosses numbers.
- `chat_profiles` + `tags`, `assigned_user_id`, `contact_notes`, `import_source`.
- `action_items` statuses are now open / in_progress / resolved / closed (old values migrated;
  `ACTION_STATUS.PENDING/DONE/CANCELLED` remain as aliases) + `due_date`, `notes`, `resolution`.
- Nothing is hard-deleted where BigQuery sync matters (it is append-only); new columns are added to
  existing BigQuery tables by `bigqueryService.ensureAllTables()`.

Bootstrap (`services/platformBootstrapService.js`, every boot, fills gaps only): default team,
orphan bots/users into it, `GALLABOX_*` env → the env number's bot (seed only, or repair if its
secrets can't be decrypted), hardcoded Intensive prompt → prompt v1, the repo KB file →
knowledge resource #1 linked to that bot, unscoped student memory → that bot's number.

Runtime:
- `bot/botManager.js` runs one `GallaboxBot` per active, configured bot in an active team.
- Webhooks: `POST /webhooks/gallabox/:botId` (HMAC with that bot's secret). Legacy
  `POST /webhooks/gallabox` routes by `channelId` (or the only running bot).
- `utils/botContext.js` (AsyncLocalStorage) carries the current bot through a message; prompt
  (`promptConfigService`), assistant identity and the KB index read it instead of `process.env`.
  Batch flushes re-enter the context. `runWithBot(id, fn, { overrides })` lets the playground
  answer with an unpublished draft prompt.
- KB: each bot has its own local index keyed `bot_<id>` (`knowledgeBaseService.initializeBot`),
  rebuilt when the fingerprint of its linked resources changes. Resources are combined with
  `kbSemanticChunker.RESOURCE_SEPARATOR` so each keeps its own chunking format.
- Paused → store only (no escalation auto-replies either). Testing → test numbers only.
- Playground (`services/playgroundService.js`) and eval chats use `@pulse.test` profiles: hidden
  from the inbox, never raise Call-to-Actions.

APIs: see README "REST API". Unauthenticated `/users`, `/chats`, `/notes`, `/reminders`, `/stats`
were removed (they leaked student data). Alerts and push notifications go to the bot's team
admins (owner if none), not every login.

Frontend: data router (`main.jsx`), `AuthContext` holds team/teams/bots/currentBotId and pushes
them into `api/client.js` headers; pages reload on `scopeVersion`. New pages: Teams, Bots,
BotWizard, BotWorkspace, Knowledge, Contacts, TeamUsers, Integrations, Analytics; the Inbox has a
contact panel and the AI Active / "AI Paused — Human Handling" banner.

Verification: `cd backend && npm run check:isolation` — 50 end-to-end checks (roles, team and
number isolation, webhook routing/signatures, paused/testing, per-number memory, CTAs, CSV import,
knowledge, analytics, team deactivation) against a throwaway DB with a stubbed Gallabox API.

Known gaps: no unread/read tracking (the inbox uses "awaiting reply" = last message from the
contact); AI on/off changes are not logged (analytics marks pause/handoff frequency as
unsupported); the scope firewall and escalation trigger prompt are still global config; the
old global KB index (`npm run ingest-kb`) is only used outside a bot context.
