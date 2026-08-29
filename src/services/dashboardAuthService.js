const jwt = require('jsonwebtoken');
const { dashboardUserService } = require('./dashboardUserService');
const { botAccountService } = require('./botAccountService');

function getJwtSecret() {
  return process.env.JWT_SECRET || 'change-me-in-production';
}

function getJwtExpiry() {
  return process.env.JWT_EXPIRY || '7d';
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      teamId: user.team_id || null,
    },
    getJwtSecret(),
    { expiresIn: getJwtExpiry() }
  );
}

function verifyToken(token) {
  return jwt.verify(token, getJwtSecret());
}

function login(email, password) {
  const user = dashboardUserService.findByEmail(email);
  if (!user || !user.is_active) {
    return { error: 'Invalid email or password' };
  }

  if (!dashboardUserService.verifyPassword(password, user.password_hash)) {
    return { error: 'Invalid email or password' };
  }

  let bot = botAccountService.findByDashboardUserId(user.id);
  if (!bot) {
    bot = botAccountService.createForUser(user.id, user.name);
    if (user.role === 'admin' || user.role === 'owner') {
      botAccountService.linkLegacySession(user.id);
      bot = botAccountService.findByDashboardUserId(user.id);
    }
  }
  const safeUser = dashboardUserService.findById(user.id);

  return {
    token: signToken(safeUser),
    user: safeUser,
    bot: botAccountService.toPublic(bot),
  };
}

module.exports = {
  signToken,
  verifyToken,
  login,
};
