const { verifyToken } = require('../../services/dashboardAuthService');
const { dashboardUserService, ROLES } = require('../../services/dashboardUserService');
const { botAccountService } = require('../../services/botAccountService');
const { teamService } = require('../../services/teamService');
const { normalizePhoneDigits } = require('../../utils/helpers');

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return null;
}

/**
 * The team (and its bots) a request works on:
 *   - owner: the team picked in the dashboard (x-team-id), else the first team
 *   - team admin / user: always their own team
 * `bots` is every bot of the team (used for access checks); `botIds`/`phones`
 * narrow to one number when ?botId= or x-bot-id is given ("All Numbers" otherwise).
 */
function buildScope(req, user) {
  const isOwner = user.role === ROLES.OWNER;
  let team = null;
  if (isOwner) {
    const requested = parseInt(req.get('x-team-id') || req.query.teamId, 10);
    team = (requested && teamService.findById(requested)) || teamService.list()[0] || null;
  } else {
    team = teamService.findById(user.team_id);
  }

  const bots = team ? botAccountService.listByTeam(team.id) : [];
  const requestedBot = parseInt(req.query.botId || req.get('x-bot-id'), 10);
  const selected = requestedBot ? bots.filter((bot) => bot.id === requestedBot) : bots;

  const phoneOf = (bot) => normalizePhoneDigits(botAccountService.getPhone(bot));
  return {
    role: user.role,
    isOwner,
    isAdmin: isOwner || user.role === ROLES.TEAM_ADMIN,
    team,
    teamId: team?.id || null,
    bots,
    botIds: selected.map((bot) => bot.id),
    phones: [...new Set(selected.map(phoneOf).filter(Boolean))],
    allPhones: [...new Set(bots.map(phoneOf).filter(Boolean))],
    // A ?botId= that isn't in this team must not silently widen to "all numbers".
    invalidBot: Boolean(requestedBot) && selected.length === 0,
  };
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let user;
  try {
    const payload = verifyToken(token);
    user = dashboardUserService.findById(payload.sub);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const scope = buildScope(req, user);
  if (!scope.isOwner && (!scope.team || !scope.team.is_active)) {
    return res.status(403).json({ error: 'Your team has been deactivated. Contact the Pulse owner.' });
  }
  if (scope.invalidBot) {
    return res.status(404).json({ error: 'WhatsApp number not found in this team' });
  }

  req.dashboardUser = user;
  req.scope = scope;
  return next();
}

/** requireRole('admin') = owner or team admin; requireRole('owner') = owner only. */
function requireRole(level) {
  return (req, res, next) => {
    const allowed = level === 'owner' ? req.scope?.isOwner : req.scope?.isAdmin;
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have permission to do this' });
    }
    return next();
  };
}

/** Team-scoped work needs a team (an owner with no teams yet has none). */
function requireTeam(req, res, next) {
  if (!req.scope?.teamId) {
    return res.status(409).json({ error: 'Create a team first' });
  }
  return next();
}

function findScopedBot(scope, botId) {
  const id = Number(botId);
  return scope.bots.find((bot) => bot.id === id) || null;
}

/** Bot (number) that owns a chat profile, if it belongs to the caller's team. */
function botForProfile(scope, profile) {
  if (!profile) return null;
  const phone = normalizePhoneDigits(profile.owner_phone);
  return scope.bots.find((bot) => normalizePhoneDigits(botAccountService.getPhone(bot)) === phone) || null;
}

function canAccessProfile(scope, profile) {
  return Boolean(profile) && scope.allPhones.includes(normalizePhoneDigits(profile.owner_phone));
}

module.exports = {
  requireAuth,
  requireRole,
  requireTeam,
  findScopedBot,
  botForProfile,
  canAccessProfile,
};
