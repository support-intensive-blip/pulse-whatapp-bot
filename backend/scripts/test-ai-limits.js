const assert = require('node:assert/strict');
process.env.SQLITE_ENABLED = 'false';
process.env.SUPABASE_ENABLED = 'true';
const { initializeDatabase, closeDatabase } = require('../src/database/db');
const db = initializeDatabase();
process.env.SUPABASE_ENABLED = 'false';
const { normalizeLimits, assertInput, reserveCompletion, fitContext, istDayBounds } = require('../src/services/aiLimits');
const { getGroqClient } = require('../src/ai/aiClient');
const { botAccountService } = require('../src/services/botAccountService');

async function main() {
  db.prepare("INSERT INTO dashboard_users (id, email, password_hash, name, role) VALUES (1, 'owner@example.invalid', 'test', 'Owner', 'owner')").run();
  db.prepare("INSERT INTO teams (id, name, owner_user_id) VALUES (1, 'One', 1), (2, 'Two', 1)").run();
  db.prepare("INSERT INTO bot_accounts (id, team_id, name, session_client_id) VALUES (1, 1, 'A', 'a'), (2, 1, 'B', 'b'), (3, 2, 'C', 'c')").run();
  assert.throws(() => normalizeLimits({ dailyTokens: -1 }), /whole number/);
  assert.throws(() => normalizeLimits({ outputTokens: { chat: 2.5 } }), /whole number/);
  const messages = [
    { role: 'system', content: 'Stay professional' },
    { role: 'assistant', content: 'x'.repeat(200) },
    { role: 'user', content: 'Hello' },
  ];
  assert.deepEqual(fitContext(messages, 100), [messages[0], messages[2]]);
  assert.throws(() => fitContext(messages, 40), { code: 'AI_LIMIT' });
  botAccountService.updateSettings(1, { aiLimits: { inputChars: 5, contextTokens: 100, outputTokens: { chat: 50, action_trigger: 10 } } });
  assert.throws(() => assertInput(botAccountService.findById(1), 'Too long'), { code: 'AI_LIMIT' });
  assert.doesNotThrow(() => assertInput(botAccountService.findById(2), 'Too long'));
  assert.equal(istDayBounds(Date.parse('2026-11-04T19:00:00Z'))[0], '2026-11-04T18:30:00.000Z');

  const client = getGroqClient('test-only');
  let request;
  let finish = 'stop';
  client.client.chat.completions.create = async payload => {
    request = payload;
    return { choices: [{ finish_reason: finish, message: { content: 'Reply' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } };
  };
  const scope = { botAccountId: 1, category: 'kb' };
  await client.chat(messages, { usageContext: scope, limitTask: 'chat' });
  assert.equal(request.max_completion_tokens, 50);
  assert.equal(request.messages.length, 2);
  await client.chat(messages, { usageContext: { ...scope, category: 'action_trigger' } });
  assert.equal(request.max_completion_tokens, 10);
  finish = 'length';
  await assert.rejects(client.chat(messages, { usageContext: scope, limitTask: 'chat' }), { code: 'AI_LIMIT' });

  const current = [messages[2]];
  botAccountService.updateSettings(2, { aiLimits: { dailyTokens: 100, outputTokens: { chat: 50 } } });
  const botReservation = reserveCompletion(current, { botAccountId: 2 });
  assert.equal(botReservation.output, 47);
  assert.throws(() => reserveCompletion(current, { botAccountId: 2 }), /bot has insufficient/);
  botReservation.release();
  botAccountService.updateSettings(2, { aiLimits: {} });
  db.prepare('UPDATE teams SET daily_ai_token_budget = 180 WHERE id = 1').run();
  const teamReservation = reserveCompletion(current, { botAccountId: 1 });
  assert.throws(() => reserveCompletion(current, { botAccountId: 2 }), /team has insufficient/);
  reserveCompletion(current, { botAccountId: 3 }).release();
  teamReservation.release();
  reserveCompletion(current, { botAccountId: 2 }).release();
  console.log('PASS: validation, input isolation, context trimming, output caps, truncation, IST reset and shared concurrent budgets');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(closeDatabase);
