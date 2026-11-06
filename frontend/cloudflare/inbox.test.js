import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { receive } from './inbox.js';

const encryptionKey = 'test-encryption-key';
const token = 'test-webhook-secret';
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(encryptionKey).digest(), iv);
const encrypted = Buffer.concat([cipher.update(token), cipher.final()]);
const storedSecret = [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64')).join(':');
const originalFetch = globalThis.fetch;
let writes = [];
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('/bot_accounts?')) return Response.json([{ id: 7, provider: 'gupshup', gallabox_channel_id: 'TestApp', webhook_secret_enc: storedSecret }]);
  if (options.method === 'POST') { writes.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); }
  return Response.json([]);
};
const env = { SUPABASE_URL: 'https://example.invalid', SUPABASE_SECRET_KEY: 'test', ENCRYPTION_KEY: encryptionKey };
const ctx = { waitUntil(promise) { promise.catch(() => {}); } };
const send = (secret, app = 'TestApp', type = 'message') => receive(new Request(`https://example.invalid/webhooks/gupshup/7?token=${secret}`, {
  method: 'POST', body: JSON.stringify({ app, type, payload: { id: 'message-1', source: '919999999999', type: 'text', payload: { text: 'Hello' } } }),
}), env, ctx);
try {
  assert.equal((await send('wrong')).status, 401);
  assert.equal(writes.length, 0);
  assert.equal((await send(token, 'OtherApp')).status, 400);
  assert.equal((await send(token, 'TestApp', 'message-event')).status, 200);
  assert.equal(writes.length, 0);
  assert.equal((await send(token)).status, 200);
  assert.equal(writes[0].event_name, 'gupshup');
  assert.equal(writes[0].bot_id, 7);
  assert.match(writes[0].signature, /^[a-f0-9]{64}$/);
  await send(token);
  assert.equal(writes[0].id, writes[1].id);
  console.log('PASS: Gupshup callback authentication, app isolation, durable acceptance and stable duplicate identity');
} finally {
  globalThis.fetch = originalFetch;
}
