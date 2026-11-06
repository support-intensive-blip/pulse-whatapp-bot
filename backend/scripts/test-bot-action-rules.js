const assert = require('node:assert/strict');
process.env.SQLITE_ENABLED = 'false';
process.env.SUPABASE_ENABLED = 'true';
process.env.OPENAI_API_KEY = 'test-only';
const { initializeDatabase, closeDatabase } = require('../src/database/db');
const db = initializeDatabase();
process.env.SUPABASE_ENABLED = 'false';

const profiles = require('../src/services/chatProfileService');
const { botAccountService } = require('../src/services/botAccountService');
const { actionItemService } = require('../src/services/actionItemService');
const aiClient = require('../src/ai/groqClient');
const { dashboardUserService } = require('../src/services/dashboardUserService');
const prompts = [];
aiClient.getGroqClient = () => ({
  async chat(messages) {
    prompts.push(messages[0].content);
    const match = messages[1].content === 'Refund please';
    const category = messages[0].content.includes('matching numbered rule') ? '1' : 'refund';
    return JSON.stringify({ match, title: 'Refund request', category, confidence: 0.95 });
  },
});
const { processInbound } = require('../src/services/escalationService');
const created = [];
actionItemService.createEscalation = item => { created.push(item); return { ...item, created: true }; };
profiles.findById = id => ({ id, chat_type: 'contact', chat_id: id === 3 ? 'session@pulse.test' : '919999999999@c.us' });

async function main() {
  const insert = db.prepare('INSERT INTO bot_accounts (id, name, session_client_id) VALUES (?, ?, ?)');
  insert.run(1, 'Custom', 'custom');
  insert.run(2, 'Default', 'default');
  botAccountService.updateSettings(1, { actionItemTriggerPrompt: '  The student asks for a refund.  ' });
  assert.equal(botAccountService.toPublic(botAccountService.findById(1)).actionItemTriggerPrompt, 'The student asks for a refund.');
  assert.throws(() => botAccountService.updateSettings(1, { actionItemTriggerPrompt: [] }), /must be text/);
  assert.throws(() => botAccountService.updateSettings(1, { actionItemTriggerPrompt: 'x'.repeat(6001) }), /6,000/);
  await processInbound({ botAccountId: 1, chatProfileId: 1, content: 'Refund please', triggerMessageId: 42 });
  assert.match(prompts[0], /The student asks for a refund/);
  assert.equal(created[0].botAccountId, 1);
  assert.equal(created[0].triggerMessageId, 42);
  assert.equal(await processInbound({ botAccountId: 1, chatProfileId: 1, content: 'https://example.invalid' }), null);
  await processInbound({ botAccountId: 2, chatProfileId: 2, content: 'https://example.invalid' });
  assert.equal(created[1].title, 'Student sent a link');
  assert.equal(created[1].botAccountId, 2);
  assert.equal(prompts.length, 2);
  assert.equal(await processInbound({ botAccountId: 2, chatProfileId: 3, content: 'https://example.invalid' }), null);
  botAccountService.updateSettings(1, { actionItemTriggerPrompt: '' });
  await processInbound({ botAccountId: 1, chatProfileId: 1, content: 'https://example.invalid' });
  assert.equal(created[2].title, 'Student sent a link');
  const teamId = botAccountService.findById(1).team_id;
  let active = true;
  dashboardUserService.findById = id => ({ id, team_id: id === 9 ? teamId : 9999, is_active: active ? 1 : 0 });
  const rule = { category: 'Refund requests', trigger: 'The student asks for a refund.', assigneeId: 9 };
  assert.throws(() => botAccountService.updateSettings(1, { actionCategoryRules: [{ ...rule, assigneeId: 10 }] }), /active member/);
  botAccountService.updateSettings(1, { actionCategoryRules: [rule] });
  await processInbound({ botAccountId: 1, chatProfileId: 1, content: 'Refund please', triggerMessageId: 43 });
  assert.equal(created[3].category, 'Refund requests');
  assert.equal(created[3].assignedDashboardUserId, 9);
  active = false;
  await processInbound({ botAccountId: 1, chatProfileId: 1, content: 'Refund please', triggerMessageId: 44 });
  assert.equal(created[4].assignedDashboardUserId, null);
  console.log('PASS: per-bot triggers, category routing, team validation, inactive assignees and playground isolation');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(closeDatabase);
