const express = require('express');
const { teamService } = require('../services/teamService');
const { dashboardUserService, ROLES } = require('../services/dashboardUserService');
const { botAccountService } = require('../services/botAccountService');
const { auditLogService } = require('../services/auditLogService');
const conversationService = require('../services/conversationService');
const { actionItemService, OPEN_STATUSES } = require('../services/actionItemService');
const { botTransferService } = require('../services/botTransferService');
const knowledgeBaseService = require('../services/knowledgeBaseService');
const botManager = require('../bot/botManager');
const logger = require('../utils/logger');
const { requireAuth, requireRole } = require('./middleware/auth');

/** Owner-only: teams, their admins, and the platform overview. */
function createTeamRouter() {
  const router = express.Router();
  const ownerOnly = [requireAuth, requireRole('owner')];

  router.get('/owner/overview', ...ownerOnly, (req, res) => {
    const teams = teamService.listWithStats();
    const bots = botAccountService.listAll();
    const activeBots = bots.filter((bot) => bot.is_active === 1);
    const phones = activeBots.map((bot) => botAccountService.getPhone(bot)).filter(Boolean);
    const conversationStats = conversationService.getStatsForOwnerPhones(phones);
    const ctaCounts = actionItemService.getCountsForBots(bots.map((bot) => bot.id));
    const openCtas = ctaCounts
      .filter((row) => OPEN_STATUSES.includes(row.status))
      .reduce((sum, row) => sum + row.count, 0);

    // Health alerts: active bots that are unconfigured or not running.
    const alerts = activeBots
      .filter((bot) => !botAccountService.hasCredentials(bot) || !botManager.getBot(bot.id)?.isReady)
      .map((bot) => ({
        botId: bot.id,
        botName: bot.name,
        teamId: bot.team_id,
        teamName: teams.find((team) => team.id === bot.team_id)?.name || null,
        problem: !botAccountService.hasCredentials(bot)
          ? 'Gallabox not configured'
          : bot.last_error || 'Not running',
      }));

    res.json({
      totals: {
        teams: teams.length,
        activeTeams: teams.filter((team) => team.is_active).length,
        numbers: activeBots.length,
        activeBots: activeBots.filter((bot) => botManager.getBot(bot.id)?.isReady && bot.ai_status === 'active').length,
        testingBots: activeBots.filter((bot) => botManager.getBot(bot.id)?.isReady && bot.ai_status === 'testing').length,
        conversations: conversationStats.totalChats,
        messagesToday: conversationStats.messagesToday,
        openActionItems: openCtas,
      },
      teams: teams.map((team) => teamService.toPublic(team)),
      alerts,
    });
  });

  router.get('/teams', ...ownerOnly, (req, res) => {
    res.json({ teams: teamService.listWithStats().map((team) => teamService.toPublic(team)) });
  });

  /**
   * Creates a team and (optionally) its first admin in one step:
   * { name, description, admin: { name, email, password } }
   */
  router.post('/teams', ...ownerOnly, (req, res) => {
    const { name, description, admin } = req.body || {};
    try {
      if (admin) {
        // Validate the admin before creating anything, so a bad email doesn't leave an orphan team.
        if (!admin.email || !admin.name || !admin.password) {
          throw new Error('Admin name, email and a temporary password are required');
        }
        if (dashboardUserService.findByEmail(admin.email)) throw new Error('A login with this email already exists');
        dashboardUserService.validatePassword(admin.password);
      }
      const team = teamService.create({ name, description, ownerUserId: req.dashboardUser.id });
      let adminUser = null;
      if (admin) {
        adminUser = dashboardUserService.create({ ...admin, role: ROLES.TEAM_ADMIN, teamId: team.id });
      }
      auditLogService.record({
        actorUserId: req.dashboardUser.id,
        teamId: team.id,
        action: 'team.create',
        targetType: 'team',
        targetId: team.id,
        meta: { name: team.name, adminId: adminUser?.id || null },
      });
      return res.status(201).json({
        team: teamService.toPublic(team),
        admin: dashboardUserService.toPublic(adminUser),
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.patch('/teams/:teamId', ...ownerOnly, async (req, res) => {
    const team = teamService.findById(parseInt(req.params.teamId, 10));
    if (!team) return res.status(404).json({ error: 'Team not found' });
    try {
      const { name, description, isActive } = req.body || {};
      const updated = teamService.update(team.id, { name, description, isActive });
      if (isActive !== undefined) await botManager.syncTeam(team.id);
      auditLogService.record({
        actorUserId: req.dashboardUser.id,
        teamId: team.id,
        action: isActive === false ? 'team.deactivate' : isActive === true ? 'team.activate' : 'team.update',
        targetType: 'team',
        targetId: team.id,
        meta: { name, description, isActive },
      });
      return res.json({ team: teamService.toPublic(updated) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  /** Moves a WhatsApp number (bot) to another team, e.g. out of the default team: { teamId } */
  router.post('/bots/:botId/move', ...ownerOnly, async (req, res) => {
    let moved;
    try {
      moved = botTransferService.moveBot(parseInt(req.params.botId, 10), parseInt(req.body?.teamId, 10), {
        userId: req.dashboardUser.id,
      });
    } catch (error) {
      return res.status(error.message === 'Bot not found' ? 404 : 400).json({ error: error.message });
    }

    const meta = {
      name: moved.bot.name,
      fromTeamId: moved.fromTeam?.id || null,
      fromTeamName: moved.fromTeam?.name || null,
      toTeamId: moved.toTeam.id,
      toTeamName: moved.toTeam.name,
      copiedResources: moved.copiedResources,
      clearedChatAssignments: moved.clearedChatAssignments,
      clearedCtaAssignments: moved.clearedCtaAssignments,
    };
    // Logged on both sides so each team's audit trail shows the number leaving / arriving.
    for (const teamId of new Set([moved.fromTeam?.id, moved.toTeam.id].filter(Boolean))) {
      auditLogService.record({
        actorUserId: req.dashboardUser.id,
        teamId,
        action: 'bot.move',
        targetType: 'bot',
        targetId: moved.bot.id,
        meta,
      });
    }

    // The new team may be inactive (bot stops) and the KB resources may have new ids.
    try {
      await botManager.restartBot(moved.bot.id);
    } catch (error) {
      logger.error(`Bot ${moved.bot.id} restart after move failed: ${error.message}`);
    }
    knowledgeBaseService.initializeBot(botAccountService.findById(moved.bot.id)).catch((error) => {
      logger.warn(`KB reindex for moved bot ${moved.bot.id} failed: ${error.message}`);
    });

    return res.json({
      bot: botAccountService.toPublic(botAccountService.findById(moved.bot.id)),
      fromTeam: teamService.toPublic(moved.fromTeam),
      toTeam: teamService.toPublic(moved.toTeam),
      copiedResources: moved.copiedResources,
      clearedChatAssignments: moved.clearedChatAssignments,
      clearedCtaAssignments: moved.clearedCtaAssignments,
    });
  });

  router.get('/audit-log', ...ownerOnly, (req, res) => {
    const teamId = parseInt(req.query.teamId, 10) || null;
    res.json({ entries: auditLogService.list({ teamId, limit: req.query.limit }) });
  });

  return router;
}

module.exports = { createTeamRouter };
