const express = require('express');
const { actionItemService, ACTION_SOURCES, STATUS_VALUES, PRIORITY_VALUES } = require('../services/actionItemService');
const { dashboardUserService } = require('../services/dashboardUserService');
const chatProfileService = require('../services/chatProfileService');
const memoryService = require('../services/memoryService');
const { requireAuth, requireTeam, findScopedBot, botForProfile, canAccessProfile } = require('./middleware/auth');

/** Call-to-Action items of the caller's team (all its numbers, or one via ?botId=). */
function createActionItemRouter() {
  const router = express.Router();

  function loadItem(req, res) {
    const item = actionItemService.findById(parseInt(req.params.id, 10));
    if (!item || !req.scope.bots.some((bot) => bot.id === item.bot_account_id)) {
      res.status(404).json({ error: 'Action item not found' });
      return null;
    }
    return item;
  }

  function assertAssignee(req, userId) {
    if (!userId) return;
    const user = dashboardUserService.findById(userId);
    const inTeam = user && user.is_active && (user.team_id === req.scope.teamId || user.role === 'owner');
    if (!inTeam) throw new Error('Assignee must be an active member of this team');
  }

  router.get('/action-items', requireAuth, requireTeam, (req, res) => {
    const assigned = req.query.assigned === 'me' ? req.dashboardUser.id : req.query.assigned || null;
    const items = actionItemService.listForBots(req.scope.botIds, {
      status: req.query.status || null,
      assignedUserId: assigned,
      priority: req.query.priority || null,
      chatProfileId: req.query.chatProfileId || null,
      category: req.query.category || '',
      studentQuery: req.query.student || req.query.search || '',
      dueBefore: req.query.dueBefore || null,
      limit: req.query.limit,
    });
    res.json({
      items,
      counts: actionItemService.getCountsForBots(req.scope.botIds),
      statuses: STATUS_VALUES,
      priorities: PRIORITY_VALUES,
    });
  });

  router.get('/action-items/:id', requireAuth, requireTeam, (req, res) => {
    const item = loadItem(req, res);
    if (!item) return undefined;
    const context = item.chat_profile_id ? memoryService.getMessages(item.chat_profile_id, 20) : [];
    return res.json({ item, conversation: context });
  });

  // Manual CTA: { title, description, chatProfileId? | botId, assignedUserId, priority, dueDate }
  router.post('/action-items', requireAuth, requireTeam, (req, res) => {
    const body = req.body || {};
    try {
      let bot = null;
      let chatProfileId = null;
      if (body.chatProfileId) {
        const profile = chatProfileService.findById(parseInt(body.chatProfileId, 10));
        if (!profile || !canAccessProfile(req.scope, profile)) throw new Error('Conversation not found');
        bot = botForProfile(req.scope, profile);
        chatProfileId = profile.id;
      } else {
        bot = findScopedBot(req.scope, body.botId) || (req.scope.botIds.length === 1 ? findScopedBot(req.scope, req.scope.botIds[0]) : null);
      }
      if (!bot) throw new Error('Choose the WhatsApp number this action belongs to');
      if (!String(body.title || '').trim()) throw new Error('Title is required');
      if (body.priority && !PRIORITY_VALUES.includes(body.priority)) throw new Error('Invalid priority');
      assertAssignee(req, body.assignedUserId);

      const item = actionItemService.create({
        botAccountId: bot.id,
        chatProfileId,
        source: ACTION_SOURCES.MANUAL,
        title: String(body.title).trim().slice(0, 160),
        description: String(body.description || '').slice(0, 4000),
        category: 'manual',
        priority: body.priority || 'normal',
        assignedDashboardUserId: body.assignedUserId || null,
        createdByUserId: req.dashboardUser.id,
        dueDate: body.dueDate || null,
      });
      return res.status(201).json({ item });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.patch('/action-items/:id', requireAuth, requireTeam, (req, res) => {
    const item = loadItem(req, res);
    if (!item) return undefined;
    const { status, assignedUserId, priority, dueDate, notes, resolution, title, description } = req.body || {};
    try {
      if (assignedUserId !== undefined) assertAssignee(req, assignedUserId);
      const updated = actionItemService.update(item.id, {
        status,
        assignedUserId,
        priority,
        dueDate,
        notes,
        resolution,
        title,
        description,
      });
      return res.json({ item: updated });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createActionItemRouter };
