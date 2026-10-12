const jwt = require('jsonwebtoken');
const { dashboardUserService } = require('./dashboardUserService');

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

  if (user.role !== 'owner') {
    const { teamService } = require('./teamService');
    const team = teamService.findById(user.team_id);
    if (!team || !team.is_active) {
      return { error: 'Your team has been deactivated. Contact the Pulse owner.' };
    }
  }

  const safeUser = dashboardUserService.findById(user.id);
  return {
    token: signToken(safeUser),
    user: dashboardUserService.toPublic(safeUser),
  };
}

module.exports = {
  signToken,
  verifyToken,
  login,
};
