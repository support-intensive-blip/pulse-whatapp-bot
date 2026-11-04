const { getDatabase } = require('../database/db');

function ensureTestingBot(teamId) {
  const db = getDatabase();
  db.prepare(`INSERT OR IGNORE INTO bot_accounts
    (team_id, testing_team_id, name, provider, session_client_id, ai_status, system_prompt)
    VALUES (?, ?, 'Testing bot', 'testing', ?, 'paused', '')`).run(teamId, teamId, `team_testing_${teamId}`);
  return db.prepare('SELECT * FROM bot_accounts WHERE testing_team_id = ?').get(teamId);
}

function sharedUsers(bot) {
  try { return JSON.parse(bot.testing_shared_users || '[]'); } catch { return []; }
}

function canUseTestingBot(scope, user, team, bot) {
  if (!team || !bot || bot.team_id !== team.id || bot.testing_team_id !== team.id) return false;
  if (scope.isOwner) return true;
  return team.is_active === 1 && team.testing_bot_enabled === 1 && user.team_id === team.id &&
    (scope.isAdmin || sharedUsers(bot).includes(user.id));
}

module.exports = { ensureTestingBot, sharedUsers, canUseTestingBot };
