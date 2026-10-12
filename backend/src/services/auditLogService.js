const { getDatabase } = require('../database/db');
const logger = require('../utils/logger');

class AuditLogService {
  /** Never throws — an audit write must not fail the action it records. */
  record({ actorUserId = null, teamId = null, action, targetType = null, targetId = null, meta = null }) {
    try {
      getDatabase()
        .prepare(
          `INSERT INTO audit_log (actor_user_id, team_id, action, target_type, target_id, meta)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          actorUserId,
          teamId,
          action,
          targetType,
          targetId == null ? null : String(targetId),
          meta ? JSON.stringify(meta) : null
        );
    } catch (error) {
      logger.warn(`Audit log write failed (${action}): ${error.message}`);
    }
  }

  list({ teamId = null, targetType = null, targetId = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (teamId) {
      where.push('a.team_id = ?');
      params.push(teamId);
    }
    if (targetType) {
      where.push('a.target_type = ?');
      params.push(targetType);
    }
    if (targetId != null) {
      where.push('a.target_id = ?');
      params.push(String(targetId));
    }
    params.push(Math.min(Number(limit) || 100, 500));
    return getDatabase()
      .prepare(
        `SELECT a.*, u.name AS actor_name
         FROM audit_log a
         LEFT JOIN dashboard_users u ON u.id = a.actor_user_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY a.id DESC
         LIMIT ?`
      )
      .all(...params)
      .map((row) => ({ ...row, meta: row.meta ? safeParse(row.meta) : null }));
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

module.exports = { auditLogService: new AuditLogService() };
