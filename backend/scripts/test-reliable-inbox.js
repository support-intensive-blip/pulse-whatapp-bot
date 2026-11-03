const assert = require('node:assert/strict');
const crypto = require('crypto');
process.env.SUPABASE_DB_URL = 'mock';
process.env.SUPABASE_ENABLED = 'false';
let row;
const query = async (sql, args) => {
  if (sql.includes('attempts=attempts+1')) {
    if (row.state === 'completed') return { rows: [] };
    row = { ...row, state: 'processing', lease_token: args[0], attempts: row.attempts + 1 };
    return { rows: [{ ...row }] };
  }
  if (sql.includes('SET sent=')) { row.sent = JSON.parse(args[2]); return { rowCount: 1 }; }
  if (sql.includes("SET state='completed'")) { row.state = 'completed'; return { rowCount: 1 }; }
  if (sql.includes("SET state='pending'")) { row.state = 'pending'; return { rowCount: 1 }; }
  throw new Error(`Unexpected query: ${sql}`);
};
const pg = require('pg');
pg.Pool = class { query(...args) { return query(...args); } };
const inbox = require('../src/services/reliableInbox');
const raw = JSON.stringify({ id: 'test', whatsapp: { id: 'test' } });
const secret = 'test-only-secret';
row = { id: 'test', bot_id: 1, event_name: 'Message.Received', raw_body: raw,
  signature: crypto.createHmac('sha256', secret).update(raw).digest('base64'), state: 'processing', attempts: 0, sent: {} };
let sends = 0;
let generations = 0;
let fail = true;
const bot = { isReady: true, webhookSecret: secret, async handleWebhookEvent() {
  assert.equal((await inbox.generate(async () => { generations++; return { reply: 'answer' }; })).reply, 'answer');
  await inbox.checkpointSend(async () => { sends++; return { id: 'sent-1' }; });
  if (fail) throw new Error('Simulated restart after persisted send');
} };
(async () => {
  await inbox.tick({ getBot: () => bot });
  assert.equal(row.state, 'pending');
  fail = false;
  await inbox.tick({ getBot: () => bot });
  assert.equal(row.state, 'completed');
  assert.equal(sends, 1, 'Recovery must skip checkpointed sends');
  assert.equal(generations, 1, 'Recovery must reuse the saved answer');
  await inbox.tick({ getBot: () => bot });
  assert.equal(sends, 1);
  console.log('PASS: expired processing recovery, retry persistence, saved generation, duplicate-send suppression, completed-job exclusion');
})().catch(error => { console.error(error); process.exit(1); });
