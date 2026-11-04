const assert = require('node:assert/strict');
process.env.SQLITE_ENABLED = 'false';
process.env.SUPABASE_ENABLED = 'true';
process.env.JWT_SECRET = 'test-only-secret';
const { initializeDatabase, closeDatabase } = require('../src/database/db');
const db = initializeDatabase();
process.env.SUPABASE_ENABLED = 'false';
const { teamService } = require('../src/services/teamService');
const { ensureTestingBot } = require('../src/services/teamTestingService');
const { botAccountService } = require('../src/services/botAccountService');
const { signToken } = require('../src/services/dashboardAuthService');
const chatService = require('../src/services/chatService');
const usage = require('../src/services/tokenUsageService').tokenUsageService;
const { createTeamTestingRouter } = require('../src/api/teamTestingRoutes');
const express = require('express');

async function main() {
  const insert = db.prepare('INSERT INTO dashboard_users(id,email,password_hash,name,role,team_id) VALUES(?,?,?,?,?,?)');
  insert.run(1, 'owner@example.invalid', 'hash', 'Owner', 'owner', null);
  const team = teamService.create({ name: 'Alpha', ownerUserId: 1 });
  const other = teamService.create({ name: 'Beta', ownerUserId: 1 });
  insert.run(2, 'admin@example.invalid', 'hash', 'Admin', 'team_admin', team.id);
  insert.run(3, 'user@example.invalid', 'hash', 'User', 'team_user', team.id);
  insert.run(4, 'other@example.invalid', 'hash', 'Other', 'team_admin', other.id);
  const bot = ensureTestingBot(team.id);
  assert.equal(ensureTestingBot(team.id).id, bot.id);
  assert.equal(bot.whatsapp_phone, null);
  assert.equal(botAccountService.listByTeam(team.id).length, 0);
  assert.throws(() => db.prepare('INSERT INTO bot_accounts(team_id,testing_team_id,name,session_client_id) VALUES(?,?,?,?)').run(team.id, team.id, 'Duplicate', 'duplicate'));
  const app = express();
  app.use(express.json());
  app.use('/api', createTeamTestingRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const call = async (userId, path, method = 'GET', body) => {
    const user = db.prepare('SELECT * FROM dashboard_users WHERE id = ?').get(userId);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method, headers: { Authorization: `Bearer ${signToken(user)}`, 'Content-Type': 'application/json', 'x-team-id': String(team.id) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  const oldGenerate = chatService.generateResponse;
  chatService.generateResponse = async (_owner, profileId, _text, _group, botId) => {
    assert.equal(botId, bot.id);
    usage.record({ chatProfileId: profileId, category: 'chat', promptTokens: 12, completionTokens: 3 });
    return { reply: 'Test response' };
  };
  try {
    assert.equal((await call(2, '/team-testing')).status, 403);
    assert.equal((await call(2, `/teams/${team.id}/testing-access`, 'PUT', { enabled: true })).status, 403);
    assert.equal((await call(1, `/teams/${team.id}/testing-access`, 'PUT', { enabled: true })).status, 200);
    assert.equal((await call(2, '/team-testing')).status, 200);
    assert.equal((await call(3, '/team-testing')).status, 403);
    assert.equal((await call(2, '/team-testing', 'PUT', { name: 'Alpha lab', prompt: 'Use only the supplied knowledge.', sharedUserIds: [4] })).status, 400);
    assert.equal((await call(2, '/team-testing', 'PUT', { name: 'Alpha lab', prompt: 'Use only the supplied knowledge.', sharedUserIds: [3] })).status, 200);
    const viewer = await call(3, '/team-testing');
    assert.equal(viewer.status, 200);
    assert.equal(viewer.data.prompt, undefined);
    assert.equal(viewer.data.members, undefined);
    assert.equal((await call(3, '/team-testing', 'PUT', { name: 'Forbidden' })).status, 403);
    assert.equal((await call(3, '/team-testing/knowledge', 'POST', { title: 'Forbidden', content: 'text' })).status, 403);
    assert.equal((await call(2, '/team-testing/knowledge', 'POST', { title: 'Alpha knowledge', content: 'Course lasts twelve weeks.' })).status, 201);
    const foreign = require('../src/services/knowledgeResourceService').knowledgeResourceService.create({ teamId: other.id, title: 'Private', content: 'Do not share' });
    assert.equal((await call(2, '/team-testing', 'PUT', { resourceIds: [foreign.id] })).status, 400);
    const reply = await call(3, '/team-testing/playground', 'POST', { sessionId: 'one', message: 'Hello', draftPrompt: 'Forbidden override' });
    assert.equal(reply.status, 200);
    assert.equal(reply.data.reply, 'Test response');
    assert.equal(reply.data.trace, undefined);
    assert.equal(reply.data.usedDraft, false);
    assert.equal((await call(2, '/team-testing/playground', 'POST', { sessionId: 'one', message: 'Hello' })).status, 200);
    assert.equal(db.prepare("SELECT count(*) count FROM chat_profiles WHERE owner_phone = ?").get(`team-test-${bot.id}`).count, 2);
    const recorded = db.prepare('SELECT * FROM token_usage ORDER BY id DESC LIMIT 1').get();
    assert.equal(recorded.bot_account_id, bot.id);
    assert.equal(recorded.team_id, team.id);
    assert.equal(recorded.environment, 'test');
    assert.equal((await call(4, '/team-testing')).status, 403);
    assert.equal((await call(1, `/teams/${team.id}/testing-access`, 'PUT', { enabled: false })).status, 200);
    assert.equal((await call(3, '/team-testing/playground', 'POST', { message: 'Denied' })).status, 403);
    assert.equal(db.prepare('SELECT name FROM bot_accounts WHERE id = ?').get(bot.id).name, 'Alpha lab');
    console.log('PASS: one number-free bot, owner entitlement, private admin settings, selected-user sharing, revocation, team isolation, knowledge uploads, private conversations and test token attribution');
  } finally {
    chatService.generateResponse = oldGenerate;
    await new Promise(resolve => server.close(resolve));
    closeDatabase();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
