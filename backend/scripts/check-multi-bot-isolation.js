/**
 * End-to-end isolation check for the multi-team / multi-number platform.
 *
 *   node scripts/check-multi-bot-isolation.js
 *
 * Runs against a throwaway SQLite DB in a temp directory (never backend/data) with
 * a local stub in place of the Gallabox API, so nothing is sent anywhere. Bots stay
 * paused / in testing mode, so no OpenAI call is made either.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const BACKEND = path.resolve(__dirname, '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-isolation-'));
process.chdir(workDir);

for (const key of Object.keys(process.env)) {
  if (key.startsWith('GALLABOX_') || key.startsWith('BQ_') || key === 'SQLITE_ENABLED') delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: 'test',
  JWT_SECRET: 'isolation-test-secret',
  DASHBOARD_ADMIN_EMAIL: 'owner@test.local',
  DASHBOARD_ADMIN_PASSWORD: 'owner-pass-123',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-not-used',
  KB_AUTO_REFRESH: 'false',
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  — ${detail}` : ''}`);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Stub Gallabox: counts outbound sends.
  const sends = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.includes('/messages/whatsapp')) sends.push({ ...JSON.parse(body || '{}'), apiKey: req.headers.apikey });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: `stub-${sends.length}` }));
    });
  });
  process.env.GALLABOX_API_BASE = `http://127.0.0.1:${await listen(stub)}`;

  const express = require(path.join(BACKEND, 'node_modules/express'));
  const { initializeDatabaseAsync } = require(path.join(BACKEND, 'src/database/db'));
  const { dashboardUserService } = require(path.join(BACKEND, 'src/services/dashboardUserService'));
  const { platformBootstrapService } = require(path.join(BACKEND, 'src/services/platformBootstrapService'));
  const botManager = require(path.join(BACKEND, 'src/bot/botManager'));
  const { createDashboardRouter } = require(path.join(BACKEND, 'src/api/dashboardRoutes'));
  const { createGallaboxWebhookRouter } = require(path.join(BACKEND, 'src/api/gallaboxWebhookRoutes'));
  const chatProfileService = require(path.join(BACKEND, 'src/services/chatProfileService'));
  const { userMemoryService } = require(path.join(BACKEND, 'src/services/userMemoryService'));

  await initializeDatabaseAsync();
  dashboardUserService.seedAdminIfNeeded();
  await platformBootstrapService.ensureDefaults();
  await botManager.startAll();

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(createGallaboxWebhookRouter(botManager));
  app.use('/api', createDashboardRouter());
  const server = http.createServer(app);
  const base = `http://127.0.0.1:${await listen(server)}`;

  async function call(method, url, { token, body, headers = {}, raw = false } = {}) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_e) { /* not json */ }
    return { status: res.status, json, text };
  }
  const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).json?.token;

  function signed(secret, payload) {
    const raw = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', secret).update(raw).digest('base64');
    return { raw, sig };
  }
  async function webhook(url, secret, payload, { badSig = false } = {}) {
    const { raw, sig } = signed(secret, payload);
    return call('POST', url, {
      raw: true,
      body: raw,
      headers: { 'Content-Type': 'application/json', 'x-event-name': 'Message.Received', 'x-gallabox-signature': badSig ? 'bad' : sig },
    });
  }
  const inbound = (channelId, from, id, body) => ({
    channelId,
    contact: { name: `Student ${from.slice(-4)}` },
    whatsapp: { from, id, type: 'text', text: { body } },
  });

  // ---- Teams, admins, users ----
  const owner = await login('owner@test.local', 'owner-pass-123');
  check('owner can log in', owner);

  const teamA = await call('POST', '/api/teams', { token: owner, body: { name: 'Team A', admin: { name: 'Admin A', email: 'a@test.local', password: 'admin-a-pass' } } });
  const teamB = await call('POST', '/api/teams', { token: owner, body: { name: 'Team B', admin: { name: 'Admin B', email: 'b@test.local', password: 'admin-b-pass' } } });
  check('owner creates teams with admins', teamA.status === 201 && teamB.status === 201, `${teamA.status}/${teamB.status}`);
  const adminA = await login('a@test.local', 'admin-a-pass');
  const adminB = await login('b@test.local', 'admin-b-pass');

  const userACreate = await call('POST', '/api/users', { token: adminA, body: { name: 'User A', email: 'ua@test.local', password: 'user-a-pass', role: 'team_user' } });
  check('team admin creates a team user', userACreate.status === 201, userACreate.text);
  const userA = await login('ua@test.local', 'user-a-pass');
  check('team user cannot create users', (await call('POST', '/api/users', { token: userA, body: { name: 'X', email: 'x@test.local', password: 'xxxxxxxx', role: 'team_user' } })).status === 403);
  check('team admin cannot create teams', (await call('POST', '/api/teams', { token: adminA, body: { name: 'Nope' } })).status === 403);

  // ---- Bots (numbers) ----
  const mkBot = (token, name, phone, channel, secret) =>
    call('POST', '/api/bots', {
      token,
      body: {
        name,
        phone,
        gallabox: { apiKey: `key-${name}-SECRETKEY`, apiSecret: `secret-${name}-SECRETVAL`, channelId: channel, webhookSecret: secret },
        systemPrompt: `You are ${name}.`,
        activate: true,
        aiStatus: 'paused',
      },
    });
  const a1 = await mkBot(adminA, 'A1', '919000000001', 'chA1', 'whA1');
  const a2 = await mkBot(adminA, 'A2', '919000000002', 'chA2', 'whA2');
  const b1 = await mkBot(adminB, 'B1', '919000000003', 'chB1', 'whB1');
  check('admins connect numbers', [a1, a2, b1].every((r) => r.status === 201), [a1, a2, b1].map((r) => r.text).join(' | '));
  const A1 = a1.json.bot.id;
  const A2 = a2.json.bot.id;
  const B1 = b1.json.bot.id;
  check('secrets are masked in responses', !a1.text.includes('SECRETKEY') && !a1.text.includes('SECRETVAL') && a1.json.bot.gallabox.apiKey.startsWith('••••'));
  check('bots are running', botManager.getBot(A1)?.isReady && botManager.getBot(B1)?.isReady);
  check('a channel id cannot be reused', (await mkBot(adminB, 'B2', '919000000004', 'chA1', 'x')).status === 400);
  check('a number cannot be reused', (await mkBot(adminB, 'B3', '919000000001', 'chB3', 'x')).status === 400);

  const botsList = await call('GET', '/api/bots', { token: adminA });
  check('admin sees only own team bots', botsList.json.bots.map((b) => b.id).sort().join() === [A1, A2].sort().join());
  check('user cannot open bot settings', (await call('GET', '/api/bots', { token: userA })).status === 403);
  check('user cannot read prompts', (await call('GET', `/api/bots/${A1}/prompt`, { token: userA })).status === 403);
  check('admin cannot open other team bot', (await call('GET', `/api/bots/${B1}`, { token: adminA })).status === 404);
  check('admin cannot read other team prompt', (await call('GET', `/api/bots/${B1}/prompt`, { token: adminA })).status === 404);

  // ---- Webhooks ----
  const student = '919111111111';
  check('webhook with bad signature is rejected', (await webhook(`/webhooks/gallabox/${A1}`, 'whA1', inbound('chA1', student, 'w1', 'hi'), { badSig: true })).status === 401);
  check('webhook signed with another bot secret is rejected', (await webhook(`/webhooks/gallabox/${A1}`, 'whB1', inbound('chA1', student, 'w1', 'hi'))).status === 401);
  check('per-bot webhook accepted (A1)', (await webhook(`/webhooks/gallabox/${A1}`, 'whA1', inbound('chA1', student, 'w1', 'hello A1'))).status === 200);
  check('legacy webhook routed by channel (A2)', (await webhook('/webhooks/gallabox', 'whA2', inbound('chA2', student, 'w2', 'hello A2'))).status === 200);
  check('per-bot webhook accepted (B1)', (await webhook(`/webhooks/gallabox/${B1}`, 'whB1', inbound('chB1', student, 'w3', 'hello B1'))).status === 200);
  await sleep(1500);

  // ---- Inbox isolation ----
  const inboxA = await call('GET', '/api/conversations', { token: userA });
  const botIdsA = new Set(inboxA.json.chats.map((c) => c.botId));
  check('team A inbox has chats from both its numbers', botIdsA.has(A1) && botIdsA.has(A2), JSON.stringify(inboxA.json.chats.map((c) => [c.botId, c.lastMessage?.preview])));
  check('team A inbox has no team B chats', !botIdsA.has(B1));
  check('same student on two numbers = two separate chats', inboxA.json.chats.filter((c) => c.contactPhone === student).length === 2);
  const onlyA1 = await call('GET', `/api/conversations?botId=${A1}`, { token: userA });
  check('number filter narrows the inbox', onlyA1.json.chats.every((c) => c.botId === A1) && onlyA1.json.chats.length === 1);
  check('foreign number filter is 404', (await call('GET', `/api/conversations?botId=${B1}`, { token: userA })).status === 404);

  const inboxB = await call('GET', '/api/conversations', { token: adminB });
  const chatB = inboxB.json.chats[0];
  check('team B inbox only has B1', inboxB.json.chats.length === 1 && chatB.botId === B1);
  check('team A cannot read team B messages', (await call('GET', `/api/conversations/${chatB.id}/messages`, { token: userA })).status === 404);
  check('team A cannot toggle AI on team B chat', (await call('PATCH', `/api/conversations/${chatB.id}/assistant`, { token: adminA, body: { active: false } })).status === 404);
  const ownerViewB = await call('GET', '/api/conversations', { token: owner, headers: { 'x-team-id': String(teamB.json.team.id) } });
  check('owner switches team with x-team-id', ownerViewB.json.chats.length === 1 && ownerViewB.json.chats[0].botId === B1);

  // ---- Paused / testing ----
  check('paused bots sent nothing', sends.length === 0, `${sends.length} sends`);
  await call('PATCH', `/api/bots/${A1}`, { token: adminA, body: { aiStatus: 'testing', testNumbers: ['919222222222'] } });
  await webhook(`/webhooks/gallabox/${A1}`, 'whA1', inbound('chA1', student, 'w4', 'are you there?'));
  await sleep(1500);
  check('testing mode ignores non-test numbers', sends.length === 0, `${sends.length} sends`);

  // ---- Outbound uses the chat's own number ----
  const chatA2 = inboxA.json.chats.find((c) => c.botId === A2);
  const reply = await call('POST', `/api/conversations/${chatA2.id}/messages`, { token: userA, body: { content: 'Hi from a coach' } });
  const sent = sends[sends.length - 1];
  check(
    'manual reply goes out on that chat’s number',
    reply.status === 200 && sent?.channelId === 'chA2' && sent?.apiKey === 'key-A2-SECRETKEY' && sent?.recipient?.phone === student,
    `${reply.status} ${JSON.stringify(sent)}`
  );
  sends.length = 0;

  // ---- Memory isolation ----
  const chatA1 = onlyA1.json.chats[0];
  const profileA1 = chatProfileService.findById(chatA1.id);
  const profileB1 = chatProfileService.findById(chatB.id);
  userMemoryService.mergeAndSave(profileA1, { language: 'Telugu' });
  check('student memory is per number', userMemoryService.getPreferences(profileA1).language === 'Telugu' && !userMemoryService.getPreferences(profileB1).language);

  // ---- Action items ----
  const cta = await call('POST', '/api/action-items', { token: userA, body: { chatProfileId: chatA1.id, title: 'Call back', priority: 'high' } });
  check('user creates a CTA on own chat', cta.status === 201, cta.text);
  check('user cannot create CTA on other team chat', (await call('POST', '/api/action-items', { token: userA, body: { chatProfileId: chatB.id, title: 'x' } })).status === 400);
  const ctasB = await call('GET', '/api/action-items', { token: adminB });
  check('other team does not see the CTA', !ctasB.json.items.some((i) => i.id === cta.json.item.id));
  check('other team cannot update the CTA', (await call('PATCH', `/api/action-items/${cta.json.item.id}`, { token: adminB, body: { status: 'resolved' } })).status === 404);
  const resolved = await call('PATCH', `/api/action-items/${cta.json.item.id}`, { token: userA, body: { status: 'resolved', resolution: 'Called' } });
  check('CTA resolves with resolution note', resolved.json?.item?.status === 'resolved' && resolved.json.item.completed_at);

  // ---- Contacts import ----
  const csv = 'name,phone,tags\nNew One,9876543210,batch-1\nBad,12345,\nDup,9876543210,\nExisting,919111111111,vip\n';
  const preview = await call('POST', '/api/contacts/import/preview', { token: userA, body: { botId: A1, csv, filename: 'test.csv' } });
  const s = preview.json?.summary || {};
  check('import preview classifies rows', s.new === 1 && s.invalid === 1 && s.duplicate === 1 && s.existing === 1, JSON.stringify(s));
  const commit = await call('POST', '/api/contacts/import/commit', { token: userA, body: { botId: A1, csv, filename: 'test.csv' } });
  check('import commit creates/updates', commit.json?.created === 1 && commit.json?.updated === 1 && commit.json?.skipped === 2, commit.text);
  check('import into other team number is refused', (await call('POST', '/api/contacts/import/preview', { token: userA, body: { botId: B1, csv } })).status === 400);
  const contactsB = await call('GET', '/api/contacts', { token: adminB });
  check('imported contacts stay in their team', !contactsB.json.contacts.some((c) => c.contactPhone === '919876543210'));

  // ---- Knowledge ----
  const kb = await call('POST', '/api/knowledge', { token: adminA, body: { title: 'FAQ', content: 'QUESTION_ID: q1\nQ: Fee?\nA: 100', botIds: [A1] } });
  check('admin adds a knowledge resource', kb.status === 201, kb.text);
  check('other team cannot see it', !(await call('GET', '/api/knowledge', { token: adminB })).json.resources.some((r) => r.id === kb.json.resource.id));
  const knowledgeBaseService = require(path.join(BACKEND, 'src/services/knowledgeBaseService'));
  const { botAccountService } = require(path.join(BACKEND, 'src/services/botAccountService'));
  await knowledgeBaseService.initializeBot(botAccountService.findById(A1));
  const kbStatus = await call('GET', `/api/bots/${A1}/knowledge/status`, { token: adminA });
  check('linked resource is indexed for the bot', kbStatus.json?.ready && kbStatus.json.chunkCount > 0, JSON.stringify(kbStatus.json));
  check('other team cannot link it', (await call('PUT', `/api/bots/${B1}/knowledge`, { token: adminB, body: { resourceIds: [kb.json.resource.id] } })).status === 400);

  // ---- Analytics ----
  const analytics = await call('GET', '/api/analytics', { token: userA });
  check('analytics covers only own numbers', analytics.json?.perNumber?.map((r) => r.botId).sort().join() === [A1, A2].sort().join());

  // ---- Team deactivation ----
  await call('PATCH', `/api/teams/${teamB.json.team.id}`, { token: owner, body: { isActive: false } });
  check('deactivated team cannot log in', !(await login('b@test.local', 'admin-b-pass')));
  check('deactivated team token is refused', (await call('GET', '/api/conversations', { token: adminB })).status === 403);
  check('deactivated team bots are stopped', !botManager.getBot(B1));

  server.close();
  stub.close();
  await botManager.shutdownAll();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed (temp dir ${workDir})`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('Isolation check crashed:', error);
  process.exit(1);
});
