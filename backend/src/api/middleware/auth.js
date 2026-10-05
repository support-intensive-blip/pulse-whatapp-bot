const { verifyToken } = require('../../services/dashboardAuthService');
const { dashboardUserService } = require('../../services/dashboardUserService');

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return null;
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = verifyToken(token);
    const user = dashboardUserService.findById(payload.sub);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    req.dashboardUser = user;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = {
  requireAuth,
};
