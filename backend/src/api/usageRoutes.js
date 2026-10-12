const express = require('express');
const { tokenUsageService } = require('../services/tokenUsageService');
const { teamService } = require('../services/teamService');
const { normalizeEnv } = require('../services/trafficEnvironment');
const { requireAuth, requireRole } = require('./middleware/auth');

const ALLOWED_DAYS = new Set([1, 7, 30, 90, 365]);

/**
 * Token usage (input / output / cost) per team and per bot.
 *   owner:      every team by default (?teamId=all), or one team (?teamId=<id>)
 *   team admin: always their own team
 * Rows keep the team the bot belonged to when the tokens were spent.
 */
function createUsageRouter() {
  const router = express.Router();

  router.get('/usage/tokens', requireAuth, requireRole('admin'), (req, res) => {
    const days = ALLOWED_DAYS.has(Number(req.query.days)) ? Number(req.query.days) : null;
    const botId = parseInt(req.query.botId, 10) || null;
    // live (default) | test | all
    const env = String(req.query.env || 'live');
    const environment = env === 'all' ? null : normalizeEnv(env);

    let teamIds;
    if (req.scope.isOwner) {
      const requested = String(req.query.teamId || 'all');
      if (requested === 'all') {
        teamIds = null;
      } else {
        const team = teamService.findById(parseInt(requested, 10));
        if (!team) return res.status(404).json({ error: 'Team not found' });
        teamIds = [team.id];
      }
    } else {
      teamIds = req.scope.teamId ? [req.scope.teamId] : [];
    }

    const report = tokenUsageService.getUsageReport({ teamIds, botId, days, environment });
    return res.json({
      scope: teamIds === null ? 'all' : 'team',
      teamId: teamIds?.length === 1 ? teamIds[0] : null,
      ...report,
    });
  });

  return router;
}

module.exports = { createUsageRouter };
