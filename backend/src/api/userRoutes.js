const express = require('express');
const { dashboardUserService, ROLES } = require('../services/dashboardUserService');
const { auditLogService } = require('../services/auditLogService');
const { requireAuth, requireRole, requireTeam } = require('./middleware/auth');

/** Team member management (team admins and the owner, within the selected team). */
function createUserRouter() {
  const router = express.Router();
  const adminOnly = [requireAuth, requireRole('admin'), requireTeam];

  router.get('/team/ai-budget', ...adminOnly, (req, res) => {
    const { teamService } = require('../services/teamService');
    const team = teamService.findById(req.scope.teamId);
    res.json({ dailyTokens: team.daily_ai_token_budget || 0 });
  });

  router.put('/team/ai-budget', ...adminOnly, (req, res) => {
    try {
      const dailyTokens = require('../services/aiLimits').validateLimit(req.body?.dailyTokens, 100000000, 'Daily team budget');
      const db = require('../database/db').getDatabase();
      db.transaction(() => {
        db.prepare("UPDATE teams SET daily_ai_token_budget = ?, updated_at = datetime('now') WHERE id = ?").run(dailyTokens, req.scope.teamId);
        auditLogService.record({ actorUserId: req.dashboardUser.id, teamId: req.scope.teamId,
          action: 'team.ai_budget', targetType: 'team', targetId: req.scope.teamId, meta: { dailyTokens } });
      })();
      return res.json({ dailyTokens });
    } catch (error) { return res.status(400).json({ error: error.message }); }
  });

  function loadTeamMember(req, res) {
    const user = dashboardUserService.findById(parseInt(req.params.userId, 10));
    if (!user || user.team_id !== req.scope.teamId) {
      res.status(404).json({ error: 'User not found in this team' });
      return null;
    }
    return user;
  }

  // Minimal roster for assignee pickers — available to every team member.
  router.get('/team/members', requireAuth, requireTeam, (req, res) => {
    const members = dashboardUserService
      .listByTeam(req.scope.teamId)
      .filter((user) => user.is_active)
      .map((user) => ({ id: user.id, name: user.name, role: user.role }));
    res.json({ members });
  });

  router.get('/users', ...adminOnly, (req, res) => {
    res.json({ users: dashboardUserService.listByTeam(req.scope.teamId).map((u) => dashboardUserService.toPublic(u)) });
  });

  router.post('/users', ...adminOnly, (req, res) => {
    const { name, email, password, role = ROLES.TEAM_USER, coachPhone } = req.body || {};
    try {
      const user = dashboardUserService.create({ name, email, password, role, coachPhone, teamId: req.scope.teamId });
      auditLogService.record({
        actorUserId: req.dashboardUser.id,
        teamId: req.scope.teamId,
        action: 'user.create',
        targetType: 'user',
        targetId: user.id,
        meta: { email: user.email, role: user.role },
      });
      return res.status(201).json({ user: dashboardUserService.toPublic(user) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.patch('/users/:userId', ...adminOnly, (req, res) => {
    const user = loadTeamMember(req, res);
    if (!user) return undefined;
    const { name, role, isActive, coachPhone } = req.body || {};
    if (user.id === req.dashboardUser.id && (role !== undefined || isActive === false)) {
      return res.status(400).json({ error: 'You cannot change your own role or deactivate yourself' });
    }
    try {
      const updated = dashboardUserService.update(user.id, { name, role, isActive, coachPhone });
      auditLogService.record({
        actorUserId: req.dashboardUser.id,
        teamId: req.scope.teamId,
        action: 'user.update',
        targetType: 'user',
        targetId: user.id,
        meta: { role, isActive },
      });
      return res.json({ user: dashboardUserService.toPublic(updated) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.post('/users/:userId/reset-password', ...adminOnly, (req, res) => {
    const user = loadTeamMember(req, res);
    if (!user) return undefined;
    try {
      dashboardUserService.resetPassword(user.id, req.body?.password);
      auditLogService.record({
        actorUserId: req.dashboardUser.id,
        teamId: req.scope.teamId,
        action: 'user.reset_password',
        targetType: 'user',
        targetId: user.id,
      });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createUserRouter };
