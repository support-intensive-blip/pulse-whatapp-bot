# Bot Behavior Reference

How the assistant actually behaves at runtime: message flow, every timing value in the
system (with defaults and the env var that overrides each), conversation modes, when a
conversation is considered "ended," and what each slash command really does under the
hood. This is a behavior reference, not an architecture map — see [../README.md](../README.md)
for the file layout and storage model, and [RAG-FRAMEWORK.md](RAG-FRAMEWORK.md) for the
knowledge-base retrieval internals.

All code references are relative to `src/`.

---

## 1. Life of one inbound WhatsApp message

```
WhatsApp message arrives
  → bot/whatsapp.js: message_create event
  → bot/messageHandler.js: handleMessage()
      - filter: groups/broadcasts/channels/status ignored outright
      - resolve chat_profile (self-chat vs contact chat)
      - is this a bot echo of its own reply? → dropped
      - is this a slash command? → routed to commands/*, answered immediately, skips
        batching/KB/AI entirely
      - is assistant disabled for this chat? → message is stored, nothing is sent back
  → contact chats only: queued in the inbound batcher (see §2)
  → chatService.generateResponse()
      - resolve conversation mode: casual / intensive (KB) / guru (see §4)
      - build time-windowed history + context note (see §5)
      - if intensive mode: run KB retrieval (see RAG-FRAMEWORK.md)
      - build system prompt + call OpenAI (see §7)
      - parse the structured JSON reply (assistant_message / event / conversation_end)
  → reply delay + typing indicator, if configured (see §3)
  → message split into WhatsApp-sized chunks (ai/messageSplitter.js) and sent
  → reply stored in the messages table
```

Self-chat messages (you messaging your own number) skip the batcher and go straight to
`generateResponse()` — batching only applies to **contact** chats, where a student is
typing multiple lines in quick succession.

---

## 2. Message batching — how long the bot waits before reading your message

Contact-chat messages are **debounced**, not answered instantly. Each inbound fragment
resets a timer; when the timer fires, everything queued so far is combined into one turn
(one KB search, one LLM call, one reply) instead of answering each line separately.

- **Default window: 10 seconds** (`INBOUND_BATCH_WINDOW_MS`, `services/inboundMessageBatcher.js`)
- **Per-bot override: `batch_delay_seconds`** — configurable per bot account in the
  dashboard, DB default **10s**, clamped to **0–300s** (`MAX_BATCH_DELAY_SECONDS`,
  `utils/constants.js`). Setting it to 0 answers each message immediately with no
  combining.
- A typing indicator starts as soon as the *first* fragment in a batch is queued
  (`onQueued` callback), so the student sees "typing..." for the whole window, not just
  after it ends.
- If 2+ fragments land in the same window, they're combined into one prompt like:
  `"The student sent 3 messages within a few seconds. Treat them as one turn."` followed
  by each message numbered — the model answers all of them together.

## 3. Reply delay — how long after that before the reply is sent

Once a reply is generated, there's a **second, independent** delay before it's actually
sent — separate from the batching window above:

- **Default: 0 seconds** (`reply_delay_seconds` on `bot_accounts`, DB default `0` — off
  unless configured in the dashboard).
- Configurable **0–120s** (`MAX_REPLY_DELAY_SECONDS`, `utils/constants.js`).
- While waiting, the bot keeps sending WhatsApp's "typing..." indicator
  (`whatsapp.js: waitBeforeReply()`), refreshed roughly every 20s so it doesn't expire
  mid-wait.
- Slash-command replies **skip this delay entirely** — they're always instant.

**So the real end-to-end reply time for a normal contact message is:**
`batch window (default 10s, waits for a pause in typing) + LLM generation time (typically
a few seconds) + reply delay (default 0s)`. Out of the box, that's roughly 10-15 seconds
from the student's last keystroke to the reply landing, almost entirely the batch window.

If a reply comes back empty (e.g. the model returned nothing), a soft fallback line is
sent instead ("Hey! I'm here — what can I help you with today?") rather than silence.

## 4. Conversation modes — Casual / Intensive (KB) / Guru

Every incoming message is classified into one of three modes before a reply is built
(`services/contextService.js: resolveMode()`). This decides whether the knowledge base is
searched at all, and which system-prompt framing is used.

| Mode | When it's picked | What happens |
|---|---|---|
| **Casual** | Greetings, small talk, single-word acknowledgments ("thanks", "ok"), or brief media-only notices | No KB search. Higher temperature (`NO_KB_TEMPERATURE`, default **0.8**) for more natural small talk. |
| **Intensive (KB)** | The message looks like a real question (contains `?`, is 4+ words, or is a short follow-up continuing an existing KB thread) | Full hybrid KB retrieval runs (see RAG-FRAMEWORK.md). Lower temperature (`CHAT_TEMPERATURE`, default **0.2**) for precise, grounded answers. |
| **Guru** | Only reachable if `guru_mode` is enabled on the user record — there is **no chat command that turns this on**; it's a dashboard/DB-level setting, off by default | Same as casual generation settings, but a different context label; effectively unused unless explicitly configured outside the chat interface. |

**Mode stickiness**: once in Intensive mode, a short follow-up ("what about X", "and?",
anything ending in `?`) stays in Intensive mode without needing to look like a full
question again — but only while the topic is still "fresh":

- **Context memory TTL: 15 minutes** (`CONTEXT_MEMORY_TTL_MINUTES`,
  `services/contextService.js`). If more than 15 minutes pass with no Intensive-mode
  message, the stored topic/mode is dropped and the next message starts from Casual
  again.

## 5. What the model actually sees — the history window

- **Context window: 60 minutes by default** (`context_window_minutes` on `bot_accounts`,
  DB default **60**, configurable **1–1440 min / up to 24h** via
  `MAX_CONTEXT_WINDOW_MINUTES`). Only messages from within this rolling window (relative
  to now, bounded by the last detected conversation boundary — see §6) are eligible.
- Even within that window, hard caps apply so one very active chat can't blow up the
  prompt: **max 40 messages** (`CONTEXT_TIME_WINDOW_MAX_MESSAGES`) and **max 8,000
  characters** (`CONTEXT_TIME_WINDOW_MAX_CHARS`) of history, trimmed from the oldest end
  first.
- At least **2 messages** are always included (`CONTEXT_TIME_WINDOW_MIN_MESSAGES`) even
  if the window technically excludes them, so a conversation resuming after a gap isn't
  handed zero context.
- A `contextNote` is injected alongside history: current IST date/time, any saved
  **student preferences** (durable facts learned in past conversations —
  `services/userMemoryService.js`), the current routing "slots" (things like which
  program track/GC the student is in, extracted from their messages —
  `services/conversationSlotsService.js`), and the last conversation-end summary if one
  exists.

## 6. When does a conversation "end"?

Two independent mechanisms mark a conversation as ended. Ending a conversation matters
because it draws the line the *next* time-windowed history lookup won't cross — the next
message starts a fresh thread instead of being lumped in with old context.

1. **Explicit signal from the model.** The system prompt's response contract
   (`ai/systemPrompts.js: CONVERSATION_END_MEMORY_CONTRACT`) tells the model: when the
   conversation is clearly finished (goodbye, issue resolved, no further help needed),
   reply with a control JSON object (`conversation_end: true`, plus an optional
   `conversation_summary` and `user_preferences`) instead of a normal
   `assistant_message`. That control JSON is never sent to the student — it's parsed,
   the summary/preferences are saved, and the turn produces no WhatsApp reply.

2. **Idle fallback — 3 minutes.** If the model never emits that signal (most turns
   don't), there's a lazy fallback: if the bot's last reply has gone **unanswered for 3
   minutes** (`CONVERSATION_IDLE_TIMEOUT_MINUTES`, `services/contextService.js`), the
   next time a message arrives (from *that* point on, checked lazily rather than on a
   background timer) the conversation is retroactively marked as ended right at that last
   reply. This is what keeps a chat resumed after a long gap from being treated as a
   continuation of a stale thread.

**On conversation end** (either path), if a summary was produced it's saved to
`conversation_summaries` (and a durable phone-keyed copy via `userMemoryService`) and
surfaces in the *next* conversation's `contextNote` ("last conversation-end summary").
Any `user_preferences` extracted are merged into the student's durable profile.

## 7. Which OpenAI model answers you

Two tiers exist (`config/modelConfig.js`):

- **Fast** — `OPENAI_MODEL_FAST`, default `gpt-4o-mini`
- **Smart** — `OPENAI_MODEL_SMART` (falls back to `OPENAI_MODEL`), default `gpt-4o`

The `/model fast|smart` command lets a student set a preferred tier — but as currently
wired (`config/tokenBudget.js: getTierForTask()`), **regular chat replies (casual, KB,
guru) always use the Fast tier regardless of this setting.** The Smart tier is currently
only used for the `/summary` command (hardcoded) and is defined-but-unreached for a
`pdf`/`manual_summary` task path that nothing in the current message flow actually
triggers. In practice: `/model smart` has no visible effect on day-to-day replies today.

Temperature: **0.2** for KB-grounded replies (`CHAT_TEMPERATURE`), **0.8** for casual
replies with no KB context (`NO_KB_TEMPERATURE`) — a deliberate split, more precise when
citing facts, more natural for small talk.

## 8. Assistant on/off control

- **Self-chat**: controlled by `assistant_self_enabled` on the user record. Toggle via
  `/assistant self on|off` (sent from your own self-chat).
- **Contacts globally**: `/assistant contacts on|off` (all contact chats at once), or
  `/assistant contacts all off` / per-contact `/assistant contact: Name on|off` for one
  person. A per-contact override always wins over the global contacts toggle.
- **`/pause` (or `/stop`)**: pauses the assistant in *that one contact chat* for
  **5 minutes** (`ASSISTANT_PAUSE_MS`, `utils/constants.js`) — meant for a coach
  stepping in to answer manually without permanently disabling the bot. `/start` (or
  `/resume`) ends the pause early.
- When assistant is disabled for a chat, inbound messages are still stored (so history
  isn't lost) but no AI reply is generated or sent.

## 9. Escalation ("Call to Action") queue and the scope firewall

Two safety/routing layers exist in the code but are **both off by default** in this
single-tenant configuration (`config/intensiveConfig.js`):

- **Scope firewall** (`FIREWALL.enabled = false`) — when enabled, a classifier pass
  checks whether an inbound message is in-scope before the main reply is generated, and
  can block/redirect out-of-scope requests. Currently inert.
- **Escalation trigger prompt** (`ACTION_ITEM_TRIGGER_PROMPT = ''`) — when configured
  with trigger scenarios, an AI (or keyword) classifier flags matching messages into the
  dashboard's "Call to Action" queue. Empty by default, so this classifier never fires.

**What *is* always active regardless of that config**: any contact message that contains
media or a URL automatically creates a "Call to Action" item in the dashboard queue
(`services/escalationService.js: autoMatchMediaOrLink`) — for the coach to follow up on
— **in addition to**, not instead of, the normal AI reply. None of these escalation paths
currently send an automatic reply of their own (`autoReply` is always `null` in the
current implementation) — they only ever create a dashboard queue item.

## 10. Slash commands

Full catalog with syntax/examples: `config/commandCatalog.js` (also rendered by `/help`
and the dashboard). Quick reference:

| Command | Where | What it actually does |
|---|---|---|
| `/help` | any chat | Lists commands + persona |
| `/ping` | any chat | "Pong 🟢" liveness check |
| `/reset` | any chat | **Only clears the routing-slot memory** (tracked topic/program-track/GC), not the stored message history — despite being labeled "Clears stored conversation history." The `messages` table is untouched. |
| `/summary` | any chat | Generates an AI summary of recent messages, always via the **Smart** model tier |
| `/me` | self-chat | Shows assistant name/persona |
| `/tokens` | self-chat | OpenAI token usage breakdown |
| `/contacts` | self-chat | Lists synced personal chats |
| `/profile` | any (view) / self-chat (edit) | Per-contact role/relations metadata used in the prompt |
| `/assistant ...` | self-chat | See §8 |
| `/pause`, `/stop`, `/start`, `/resume` | contact chats | See §8 |
| `/model fast\|smart` | self-chat | Sets a preference that — see §7 — doesn't currently affect live chat replies |
| `/note <text>`, `/notes` | self-chat | Personal notes, unrelated to chat context |
| `/remind YYYY-MM-DD HH:MM <text>` | self-chat | Schedules a WhatsApp reminder; checked every minute (`REMINDER_CHECK_CRON`) |
| voice note | any | Transcribed via Whisper, then answered like text |
| PDF document | any | Text extracted (truncated to 12,000 chars) and answered in context |

## 11. WhatsApp connection lifecycle

- **QR/pairing**: a fresh QR is generated roughly every 20s until scanned (WhatsApp's own
  cadence, not configurable here). If no QR has been produced within **45s**
  (`WHATSAPP_QR_GRACE_MS`) of starting a link attempt, the client restarts the link flow.
- **No pinned WhatsApp Web version** — the client loads whatever WhatsApp Web is actually
  serving live rather than an archived snapshot (see `bot/whatsapp.js:
  resolveWebVersionCache()`), since the underlying library lags WhatsApp's release pace.
  `WHATSAPP_WEB_VERSION_URL` can still force a pinned build if a future WhatsApp release
  regresses this.
- **Auth backfill safety net**: WhatsApp Web's own `loading_screen` (post-authentication)
  event backfills internal auth state if the library's `authenticated` event is late or
  missing — closing a gap that used to let an auth-mode toggle disrupt an already-linked
  session.
- **Auth-sync stuck timeout: 10 minutes** (`WHATSAPP_AUTH_SYNC_STUCK_MS`) — if the client
  authenticates but never reaches fully "ready" within 10 minutes, the session is
  cleared and the QR flow restarts from scratch.
- **Reconnects**: on an unexpected disconnect, the client retries with backoff —
  `RECONNECT_DELAY_MS` (10s) × attempt number, capped at 6× (so up to 60s between
  attempts), up to `MAX_RECONNECT_ATTEMPTS` (15) before giving up and surfacing an error
  status.
- **Error-reply cooldown**: if message handling throws, the generic "Oops, something
  glitched" reply is rate-limited to once per **2 minutes** per chat
  (`ERROR_REPLY_COOLDOWN_MS`) so a repeated failure doesn't spam the student.

## 12. Background jobs

| Job | Interval | Purpose |
|---|---|---|
| Reminder check | every minute (cron `* * * * *`) | Sends any due `/remind` reminders |
| KB auto-refresh | 30 minutes (`KB_REINGEST_INTERVAL_MS`) | Cheaply checks the KB source file's hash; only rebuilds the (expensive) TF-IDF index if it actually changed |
| Deferred chat sync | ~90s after WhatsApp goes ready (`CHAT_SYNC_DELAY_MS`), re-armed if the account is active | Syncs personal chats/contacts in the background, aborts immediately if a real inbound message needs the browser |
| SQLite backup | every 24h (`SQLITE_BACKUP_INTERVAL_HOURS`) | Snapshots `data/assistant.db` to `data/sqlite-backups/` |
| Inbound-hook watchdog | every 15s while ready | Re-confirms WhatsApp's in-page message hook is still attached, re-attaches if WhatsApp reloaded internally |

---

## Quick timing cheat-sheet

| Value | Default | Range | Config |
|---|---|---|---|
| Batch window (contact chats) | 10s | 0–300s | `batch_delay_seconds` per bot, or `INBOUND_BATCH_WINDOW_MS` |
| Reply delay | 0s | 0–120s | `reply_delay_seconds` per bot |
| Context window (history lookback) | 60 min | 1–1440 min | `context_window_minutes` per bot |
| Intensive-mode topic stickiness (TTL) | 15 min | — | `CONTEXT_MEMORY_TTL_MINUTES` |
| Conversation idle → auto-ended | 3 min | — | `CONVERSATION_IDLE_TIMEOUT_MINUTES` |
| `/pause` duration | 5 min | — | fixed (`ASSISTANT_PAUSE_MS`) |
| Error-reply cooldown | 2 min | — | fixed (`ERROR_REPLY_COOLDOWN_MS`) |
| QR restart grace period | 45s | — | `WHATSAPP_QR_GRACE_MS` |
| Auth-sync stuck → forces re-link | 10 min | — | `WHATSAPP_AUTH_SYNC_STUCK_MS` |
| KB auto-refresh check | 30 min | — | `KB_REINGEST_INTERVAL_MS` |
| SQLite backup | 24h | — | `SQLITE_BACKUP_INTERVAL_HOURS` |
