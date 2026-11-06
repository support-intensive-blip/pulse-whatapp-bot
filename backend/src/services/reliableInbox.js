const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const logger = require('../utils/logger');
const context = new AsyncLocalStorage();
let pool;
let busy = false;
const db = () => pool || (pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 3 }));
const current = () => context.getStore();

function isGupshupText(event) {
  return event?.type === 'message' && event.payload?.type === 'text' &&
    event.payload.id && event.payload.source && typeof event.payload.payload?.text === 'string';
}

async function groupedText(job, first, verify, windowEnd) {
  if (job.event_name !== 'gupshup' || !isGupshupText(first)) return [];
  let ids = job.sent?._group;
  if (!ids) {
    // Older attempts may already have generated or sent a single-message reply.
    if (job.attempts > 1 || !windowEnd) return [];
    const { rows } = await db().query(`SELECT id, event_name, raw_body, signature, state, attempts
      FROM public.webhook_inbox WHERE bot_id=$1 AND state!='completed'
      AND (created_at,id)>(SELECT created_at,id FROM public.webhook_inbox WHERE id=$2)
      AND created_at<=$3 ORDER BY created_at,id LIMIT 32`, [job.bot_id, job.id, windowEnd]);
    ids = [];
    for (const row of rows) {
      if (row.event_name !== 'gupshup' || row.state !== 'pending' || row.attempts !== 0) break;
      if (!verify(row)) break;
      const event = JSON.parse(row.raw_body);
      if (event.type !== 'message') continue;
      if (event.app !== first.app || event.payload?.source !== first.payload.source) continue;
      if (!isGupshupText(event)) break;
      ids.push(row.id);
      if (ids.length === 7) break;
    }
    job.sent = { ...job.sent, _group: ids };
    const saved = await db().query("UPDATE public.webhook_inbox SET sent=$3::jsonb WHERE id=$1 AND lease_token=$2 AND state='processing'",
      [job.id, job.lease_token, JSON.stringify(job.sent)]);
    if (!saved.rowCount) throw new Error('Inbox lease lost before grouping');
  }
  if (!ids.length) return [];
  const { rows } = await db().query('SELECT id, raw_body, signature FROM public.webhook_inbox WHERE bot_id=$1 AND id=ANY($2::text[])', [job.bot_id, ids]);
  const byId = new Map(rows.map(row => [row.id, row]));
  return ids.map(id => {
    const row = byId.get(id);
    if (!row || !verify(row)) throw new Error('Stored group signature is invalid');
    return JSON.parse(row.raw_body);
  });
}

async function tick(manager) {
  if (busy || !process.env.SUPABASE_DB_URL) return;
  busy = true;
  let job;
  let heartbeat;
  let completed = false;
  try {
    const token = randomUUID();
    const result = await db().query(`UPDATE public.webhook_inbox SET state='processing', lease_token=$1,
      lease_until=now()+interval '10 minutes', attempts=attempts+1
      WHERE id=(SELECT j.id FROM public.webhook_inbox j
        WHERE ((j.state='pending' AND j.next_attempt_at<=now()) OR (j.state='processing' AND j.lease_until<now()))
        AND NOT EXISTS (SELECT 1 FROM public.webhook_inbox older WHERE older.bot_id=j.bot_id
          AND older.state!='completed' AND (older.created_at,older.id)<(j.created_at,j.id))
        ORDER BY j.created_at, j.id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [token]);
    job = result.rows[0];
    if (!job) return;
    const bot = manager.getBot(Number(job.bot_id));
    if (!bot?.isReady) throw new Error('Bot is not ready; retained for retry');
    const { verifySignature } = require('../bot/gallabox/gallaboxApi');
    const verify = row => verifySignature(bot.webhookSecret, Buffer.from(row.raw_body), row.signature);
    if (!verify(job)) {
      throw new Error('Stored webhook signature is invalid');
    }
    const envelope = JSON.parse(job.raw_body);
    let windowEnd = null;
    if (job.event_name === 'gupshup' && job.attempts === 1 && isGupshupText(envelope)) {
      const { botAccountService } = require('./botAccountService');
      const seconds = botAccountService.resolveBatchDelaySeconds(Number(job.bot_id));
      if (seconds > 0) {
        windowEnd = new Date(new Date(job.created_at).getTime() + seconds * 1000);
        const waitMs = windowEnd.getTime() - Date.now();
        if (waitMs > 0) {
          // Release the worker while this bot's oldest message waits for more text.
          await db().query(`UPDATE public.webhook_inbox SET state='pending', lease_token=NULL,
            lease_until=NULL, attempts=attempts-1, next_attempt_at=$3 WHERE id=$1 AND lease_token=$2`,
          [job.id, token, windowEnd]);
          setTimeout(() => tick(manager), waitMs + 25).unref();
          completed = true;
          return;
        }
      }
    }
    heartbeat = setInterval(() => db().query("UPDATE public.webhook_inbox SET lease_until=now()+interval '10 minutes' WHERE id=$1 AND lease_token=$2", [job.id, token]).catch(e => logger.error(`Inbox heartbeat: ${e.message}`)), 30000);
    const following = await groupedText(job, envelope, verify, windowEnd);
    const state = { job, index: 0, sent: job.sent || {} };
    await context.run(state, () => bot.handleWebhookEvent(job.event_name, envelope, following));
    const { isSupabaseEnabled } = require('../database/storageMode');
    if (isSupabaseEnabled()) {
      const sync = require('../database/supabaseSync');
      const cache = require('../database/db').getDatabase();
      await sync.flushSupabaseOutbox(cache);
      if (sync.pendingCount(cache)) throw new Error('Conversation storage sync pending');
    }
    await db().query(`WITH head AS (
      UPDATE public.webhook_inbox SET state='completed', completed_at=now(), raw_body='', signature='', lease_until=NULL
      WHERE id=$1 AND lease_token=$2 RETURNING bot_id
    )
    UPDATE public.webhook_inbox SET state='completed', completed_at=now(), raw_body='', signature='', lease_until=NULL
    WHERE bot_id=(SELECT bot_id FROM head) AND id=ANY($3::text[]) AND state='pending'`,
    [job.id, token, job.sent?._group || []]);
    completed = true;
  } catch (error) {
    logger.error(`Reliable inbox: ${error.message}`);
    if (job) await db().query(`UPDATE public.webhook_inbox SET state='pending', lease_until=NULL,
      next_attempt_at=now()+($3 * interval '1 second'), last_error=$4 WHERE id=$1 AND lease_token=$2`,
    [job.id, job.lease_token, Math.min(300, 10 * 2 ** Math.min(job.attempts, 5)), error.message.slice(0, 500)]).catch(e => logger.error(`Inbox retry storage: ${e.message}`));
  } finally {
    clearInterval(heartbeat);
    busy = false;
    if (completed) setImmediate(() => tick(manager));
  }
}

async function checkpointSend(send) {
  const state = current();
  if (!state) return send();
  const key = String(state.index++);
  if (state.sent[key]) return state.sent[key];
  const sent = await send();
  state.sent[key] = sent;
  const result = await db().query('UPDATE public.webhook_inbox SET sent=$3::jsonb WHERE id=$1 AND lease_token=$2 AND state=\'processing\'', [state.job.id, state.job.lease_token, JSON.stringify(state.sent)]);
  if (!result.rowCount) throw new Error('Inbox lease lost after send');
  return sent;
}

async function generate(generateResponse) {
  const state = current();
  if (!state) return generateResponse();
  if (state.sent._generation) return state.sent._generation;
  const result = await generateResponse();
  state.sent._generation = result;
  await db().query('UPDATE public.webhook_inbox SET sent=$3::jsonb WHERE id=$1 AND lease_token=$2', [state.job.id, state.job.lease_token, JSON.stringify(state.sent)]);
  return result;
}

async function accept(botId, eventName, rawBody, signature) {
  const payload = JSON.parse(rawBody.toString());
  const identity = `${botId}:${eventName}:${payload.whatsapp?.id || payload.id || rawBody.toString()}`;
  const id = require('crypto').createHash('sha256').update(identity).digest('hex');
  await db().query('INSERT INTO public.webhook_inbox(id,bot_id,event_name,raw_body,signature) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [id, botId, eventName, rawBody.toString(), signature]);
}

function start(manager) {
  tick(manager);
  const timer = setInterval(() => tick(manager), 5000);
  timer.unref();
}
module.exports = { current, checkpointSend, generate, accept, start, tick };
