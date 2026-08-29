const bcrypt = require('bcryptjs');
const { getDatabase } = require('../database/db');
const { botAccountService } = require('./botAccountService');
const logger = require('../utils/logger');

// Single-tenant: exactly one dashboard login (role is always 'owner').
// Team/role/user-management and email-change flows were removed.

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

class DashboardUserService {
  hashPassword(password) {
    return bcrypt.hashSync(password, 10);
  }

  verifyPassword(password, hash) {
    return bcrypt.compareSync(password, hash);
  }

  findById(id) {
    const db = getDatabase();
    return (
      db
        .prepare(
          `SELECT id, email, name, coach_phone, action_alert_phones, role, is_active, created_at
           FROM dashboard_users WHERE id = ?`
        )
        .get(id) || null
    );
  }

  findByEmail(email) {
    const db = getDatabase();
    return db
      .prepare('SELECT * FROM dashboard_users WHERE email = ? COLLATE NOCASE')
      .get(normalizeEmail(email));
  }

  listAll() {
    const db = getDatabase();
    return db
      .prepare(
        `SELECT du.id, du.email, du.name, du.coach_phone, du.action_alert_phones, du.role,
                du.is_active, du.created_at,
                ba.id AS bot_id, ba.status AS bot_status, ba.whatsapp_phone
         FROM dashboard_users du
         LEFT JOIN bot_accounts ba ON ba.dashboard_user_id = du.id
         ORDER BY du.created_at ASC`
      )
      .all();
  }

  verifyCurrentPassword(userId, currentPassword) {
    const db = getDatabase();
    const row = db.prepare('SELECT password_hash FROM dashboard_users WHERE id = ?').get(userId);
    if (!row) return { error: 'User not found' };
    if (!this.verifyPassword(currentPassword, row.password_hash)) {
      return { error: 'Current password is incorrect' };
    }
    return { ok: true };
  }

  changePassword(userId, currentPassword, newPassword) {
    const verify = this.verifyCurrentPassword(userId, currentPassword);
    if (verify.error) return verify;

    if (String(newPassword).length < 6) {
      return { error: 'New password must be at least 6 characters' };
    }
    if (currentPassword === newPassword) {
      return { error: 'New password must be different from current password' };
    }

    const db = getDatabase();
    db.prepare('UPDATE dashboard_users SET password_hash = ? WHERE id = ?').run(
      this.hashPassword(newPassword),
      userId
    );
    logger.info(`Password changed for dashboard user ${userId}`);
    return { user: this.findById(userId) };
  }

  seedAdminIfNeeded() {
    const db = getDatabase();
    const count = db.prepare('SELECT COUNT(*) AS c FROM dashboard_users').get().c;
    if (count > 0) return null;

    const email = normalizeEmail(process.env.DASHBOARD_ADMIN_EMAIL || 'admin@localhost');
    const password = process.env.DASHBOARD_ADMIN_PASSWORD || 'admin123';
    const result = db
      .prepare(
        `INSERT INTO dashboard_users (email, password_hash, name, role)
         VALUES (?, ?, ?, 'owner')`
      )
      .run(email, this.hashPassword(password), 'Owner');

    const user = this.findById(result.lastInsertRowid);
    if (user) {
      botAccountService.createForUser(user.id, user.name);
      botAccountService.linkLegacySession(user.id);
      logger.info(`Seeded dashboard login: ${email}`);
    }
    return user;
  }
}

module.exports = {
  dashboardUserService: new DashboardUserService(),
};
