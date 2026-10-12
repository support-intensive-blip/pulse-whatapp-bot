const bcrypt = require('bcryptjs');
const { getDatabase } = require('../database/db');
const logger = require('../utils/logger');

// Roles: one platform 'owner' (no team), and per team 'team_admin' / 'team_user'.
const ROLES = {
  OWNER: 'owner',
  TEAM_ADMIN: 'team_admin',
  TEAM_USER: 'team_user',
};

const MIN_PASSWORD_LENGTH = 8;

const PUBLIC_COLUMNS = `id, email, name, coach_phone, action_alert_phones, role, team_id, is_active, created_at`;

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
    return (
      getDatabase().prepare(`SELECT ${PUBLIC_COLUMNS} FROM dashboard_users WHERE id = ?`).get(id) || null
    );
  }

  findByEmail(email) {
    return getDatabase()
      .prepare('SELECT * FROM dashboard_users WHERE email = ? COLLATE NOCASE')
      .get(normalizeEmail(email));
  }

  listAll() {
    return getDatabase()
      .prepare(`SELECT ${PUBLIC_COLUMNS} FROM dashboard_users ORDER BY created_at ASC`)
      .all();
  }

  listByTeam(teamId) {
    return getDatabase()
      .prepare(`SELECT ${PUBLIC_COLUMNS} FROM dashboard_users WHERE team_id = ? ORDER BY role ASC, name ASC`)
      .all(teamId);
  }

  validatePassword(password) {
    if (String(password || '').length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }

  create({ email, name, password, role, teamId = null, coachPhone = null }) {
    const normalized = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('Enter a valid email address');
    if (!String(name || '').trim()) throw new Error('Name is required');
    if (![ROLES.TEAM_ADMIN, ROLES.TEAM_USER].includes(role)) throw new Error('Role must be team_admin or team_user');
    if (!teamId) throw new Error('teamId is required');
    this.validatePassword(password);
    if (this.findByEmail(normalized)) throw new Error('A login with this email already exists');

    const result = getDatabase()
      .prepare(
        `INSERT INTO dashboard_users (email, password_hash, name, role, team_id, coach_phone)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(normalized, this.hashPassword(password), String(name).trim(), role, teamId, coachPhone || null);
    logger.info(`Dashboard user ${result.lastInsertRowid} created (${role}, team ${teamId})`);
    return this.findById(result.lastInsertRowid);
  }

  update(id, { name, role, isActive, coachPhone } = {}) {
    const fields = [];
    const values = [];
    if (name !== undefined) {
      if (!String(name).trim()) throw new Error('Name cannot be empty');
      fields.push('name = ?');
      values.push(String(name).trim());
    }
    if (role !== undefined) {
      if (![ROLES.TEAM_ADMIN, ROLES.TEAM_USER].includes(role)) throw new Error('Role must be team_admin or team_user');
      fields.push('role = ?');
      values.push(role);
    }
    if (isActive !== undefined) {
      fields.push('is_active = ?');
      values.push(isActive ? 1 : 0);
    }
    if (coachPhone !== undefined) {
      fields.push('coach_phone = ?');
      values.push(coachPhone || null);
    }
    if (!fields.length) return this.findById(id);
    values.push(id);
    getDatabase().prepare(`UPDATE dashboard_users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  resetPassword(id, newPassword) {
    this.validatePassword(newPassword);
    getDatabase()
      .prepare('UPDATE dashboard_users SET password_hash = ? WHERE id = ?')
      .run(this.hashPassword(newPassword), id);
    logger.info(`Password reset for dashboard user ${id}`);
    return this.findById(id);
  }

  verifyCurrentPassword(userId, currentPassword) {
    const row = getDatabase().prepare('SELECT password_hash FROM dashboard_users WHERE id = ?').get(userId);
    if (!row) return { error: 'User not found' };
    if (!this.verifyPassword(currentPassword, row.password_hash)) {
      return { error: 'Current password is incorrect' };
    }
    return { ok: true };
  }

  changePassword(userId, currentPassword, newPassword) {
    const verify = this.verifyCurrentPassword(userId, currentPassword);
    if (verify.error) return verify;

    if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
      return { error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` };
    }
    if (currentPassword === newPassword) {
      return { error: 'New password must be different from current password' };
    }

    getDatabase()
      .prepare('UPDATE dashboard_users SET password_hash = ? WHERE id = ?')
      .run(this.hashPassword(newPassword), userId);
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

    logger.info(`Seeded dashboard owner login: ${email}`);
    return this.findById(result.lastInsertRowid);
  }

  toPublic(user) {
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      teamId: user.team_id,
      coachPhone: user.coach_phone,
      isActive: user.is_active === 1,
      createdAt: user.created_at,
    };
  }
}

module.exports = {
  dashboardUserService: new DashboardUserService(),
  ROLES,
};
