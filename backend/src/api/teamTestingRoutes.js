const express = require('express');
const { getDatabase } = require('../database/db');
const { requireAuth, requireRole } = require('./middleware/auth');
const { teamService } = require('../services/teamService');
const { ensureTestingBot, sharedUsers, canUseTestingBot } = require('../services/teamTestingService');
const { botAccountService } = require('../services/botAccountService');
const { knowledgeResourceService } = require('../services/knowledgeResourceService');
const { playgroundService } = require('../services/playgroundService');
const { auditLogService } = require('../services/auditLogService');
const { promptVersionService } = require('../services/promptVersionService');

function createTeamTestingRouter() {
  const router = express.Router();
  router.put('/teams/:teamId/testing-access', requireAuth, requireRole('owner'), (req, res) => {
    const team = teamService.findById(Number(req.params.teamId));
    if (!team) return res.sendStatus(404);
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    ensureTestingBot(team.id);
    getDatabase().prepare('UPDATE teams SET testing_bot_enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, team.id);
    auditLogService.record({ actorUserId: req.dashboardUser.id, teamId: team.id, action: 'testing.access', meta: { enabled: req.body.enabled } });
    return res.json({ team: teamService.toPublic(teamService.findById(team.id)) });
  });

  router.use('/team-testing', requireAuth, (req, res, next) => {
    const team = teamService.findById(req.scope.teamId);
    if (!team) return res.status(409).json({ error: 'Select a team first' });
    const bot = ensureTestingBot(team.id);
    if (!canUseTestingBot(req.scope, req.dashboardUser, team, bot)) return res.status(403).json({ error: 'Testing bot access is disabled or has not been shared with you. Contact your team admin or platform owner.' });
    req.testingBot = bot;
    return next();
  });

  router.get('/team-testing', (req, res) => {
    const bot = req.testingBot;
    const canManage = req.scope.isAdmin;
    const resources = knowledgeResourceService.list(bot.team_id);
    return res.json({ bot: { id: bot.id, name: bot.name, knowledgeResourceIds: botAccountService.parseKnowledgeResourceIds(bot) }, canManage,
      ...(canManage ? { prompt: bot.system_prompt || '', contextWindowMinutes: bot.context_window_minutes,
        assistantName: bot.assistant_name || '', sharedUserIds: sharedUsers(bot),
        resources: resources.map(resource => ({ id: resource.id, title: resource.title })),
        members: getDatabase().prepare("SELECT id, name FROM dashboard_users WHERE team_id = ? AND is_active = 1 AND role = 'team_user'").all(bot.team_id) } : {}) });
  });

  router.put('/team-testing', requireRole('admin'), (req, res) => {
    const bot = req.testingBot;
    const body = req.body || {};
    try {
      const ids = body.resourceIds;
      if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => !knowledgeResourceService.findById(id) || knowledgeResourceService.findById(id).team_id !== bot.team_id))) throw new Error('Choose knowledge from this team only');
      const users = body.sharedUserIds;
      if (users !== undefined && (!Array.isArray(users) || users.some(id => !getDatabase().prepare("SELECT id FROM dashboard_users WHERE id = ? AND team_id = ? AND role = 'team_user' AND is_active = 1").get(id, bot.team_id)))) throw new Error('Share only with active users in this team');
      if (body.prompt !== undefined && (typeof body.prompt !== 'string' || body.prompt.length > 100000)) throw new Error('Prompt must be text under 100,000 characters');
      getDatabase().transaction(() => {
        botAccountService.updateSettings(bot.id, { name: body.name, assistantName: body.assistantName, contextWindowMinutes: body.contextWindowMinutes });
        if (body.prompt !== undefined) promptVersionService.publish(bot.id, body.prompt, { userId: req.dashboardUser.id, note: 'Testing bot prompt' });
        if (ids !== undefined) botAccountService.setKnowledgeResourceIds(bot.id, ids);
        if (users !== undefined) getDatabase().prepare('UPDATE bot_accounts SET testing_shared_users = ? WHERE id = ?').run(JSON.stringify([...new Set(users)]), bot.id);
        auditLogService.record({ actorUserId: req.dashboardUser.id, teamId: bot.team_id, action: 'testing.configure', targetType: 'bot', targetId: bot.id });
      })();
      return res.json({ ok: true });
    } catch (error) { return res.status(400).json({ error: error.message }); }
  });

  router.post('/team-testing/knowledge', requireRole('admin'), (req, res) => {
    try {
      const bot = req.testingBot;
      const resource = getDatabase().transaction(() => {
        const created = knowledgeResourceService.create({ teamId: bot.team_id, title: req.body.title, content: req.body.content,
          filename: req.body.filename, kind: req.body.kind === 'pdf' ? 'pdf' : 'text', createdBy: req.dashboardUser.id });
        botAccountService.setKnowledgeResourceIds(bot.id, [...botAccountService.parseKnowledgeResourceIds(bot), created.id]);
        return created;
      })();
      return res.status(201).json({ id: resource.id });
    } catch (error) { return res.status(400).json({ error: error.message }); }
  });

  router.post('/team-testing/playground', async (req, res) => {
    try {
      if (!String(req.testingBot.system_prompt || '').trim()) return res.status(400).json({ error: 'Your team admin must save a system prompt before testing.' });
      const result = await playgroundService.send(req.testingBot, req.dashboardUser.id, {
        sessionId: req.body?.sessionId, message: req.body?.message,
        draftPrompt: req.scope.isAdmin ? req.body?.draftPrompt : null,
      });
      if (!req.scope.isAdmin) { delete result.trace; delete result.knowledge; }
      return res.json(result);
    } catch (error) { return res.status(400).json({ error: error.message }); }
  });
  return router;
}

module.exports = { createTeamTestingRouter };
