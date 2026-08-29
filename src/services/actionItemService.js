const { getDatabase } = require('../database/db');
const logger = require('../utils/logger');
const { botAccountService } = require('./botAccountService');

const ACTION_STATUS = {
  PENDING: 'pending',
  DONE: 'done',
  CANCELLED: 'cancelled',
};

const ACTION_SOURCES = {
  REMINDER: 'reminder',
  COMMAND: 'command',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
  MANUAL: 'manual',
  ESCALATION: 'escalation',
};

const BASE_SELECT = `SELECT ai.*, cp.contact_name, cp.chat_type, cp.contact_phone, cp.chat_id,
                            du.name AS assigned_user_name, du.coach_phone AS assigned_coach_phone,
                            m.timestamp AS trigger_message_at
                     FROM action_items ai
                     LEFT JOIN chat_profiles cp ON cp.id = ai.chat_profile_id
                     LEFT JOIN dashboard_users du ON du.id = ai.assigned_dashboard_user_id
                     LEFT JOIN messages m ON m.id = ai.trigger_message_id`;

class ActionItemService {
  resolveTriggeredAt(db, triggerMessageId = null) {
    if (triggerMessageId) {
      const row = db.prepare('SELECT timestamp FROM messages WHERE id = ?').get(triggerMessageId);
      if (row?.timestamp) return row.timestamp;
    }
    return new Date().toISOString();
  }

  create({
    botAccountId,
    chatProfileId = null,
    assignedDashboardUserId = null,
    source,
    title,
    description = '',
    status = ACTION_STATUS.PENDING,
    category = null,
    priority = null,
    dedupeKey = null,
    triggerMessageId = null,
  }) {
    const db = getDatabase();
    const bot = botAccountService.findById(botAccountId);
    const assignedUserId = assignedDashboardUserId || bot?.dashboard_user_id || null;
    const triggeredAt = this.resolveTriggeredAt(db, triggerMessageId);

    const result = db
      .prepare(
        `INSERT INTO action_items
         (bot_account_id, chat_profile_id, assigned_dashboard_user_id, source, title, description, status, category, priority, dedupe_key, trigger_message_id, triggered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        botAccountId,
        chatProfileId,
        assignedUserId,
        source,
        title,
        description,
        status,
        category,
        priority,
        dedupeKey,
        triggerMessageId,
        triggeredAt
      );

    const item = this.findById(result.lastInsertRowid);
    logger.info(`Action item created: ${title} (bot=${botAccountId})`);

    setImmediate(() => {
      try {
        const { dashboardAlertService } = require('./dashboardAlertService');
        dashboardAlertService.notifyCtaCreated({
          botAccountId,
          actionItemId: item?.id,
          chatProfileId,
          triggerMessageId: item?.trigger_message_id || triggerMessageId || null,
          title,
          contactName: item?.contact_name,
          assignedDashboardUserId: assignedUserId,
        });
      } catch (error) {
        logger.warn(`CTA dashboard alert skipped: ${error.message}`);
      }
    });

    setImmediate(() => {
      try {
        const { actionNotificationService } = require('./actionNotificationService');
        actionNotificationService.notifyCoach(item);
      } catch (error) {
        logger.warn(`Coach notification skipped: ${error.message}`);
      }
    });

    return { ...item, created: true };
  }

  findRecentPending({ botAccountId, chatProfileId, dedupeKey, hours = 24 }) {
    const db = getDatabase();
    if (dedupeKey) {
      return (
        db
          .prepare(
            `${BASE_SELECT}
             WHERE ai.bot_account_id = ?
               AND ai.dedupe_key = ?
               AND ai.status = 'pending'
               AND datetime(ai.triggered_at) >= datetime('now', ?)
             ORDER BY ai.triggered_at DESC
             LIMIT 1`
          )
          .get(botAccountId, dedupeKey, `-${hours} hours`) || null
      );
    }

    return (
      db
        .prepare(
          `${BASE_SELECT}
           WHERE ai.bot_account_id = ?
             AND ai.chat_profile_id = ?
             AND ai.status = 'pending'
             AND datetime(ai.triggered_at) >= datetime('now', ?)
           ORDER BY ai.triggered_at DESC
           LIMIT 1`
        )
        .get(botAccountId, chatProfileId, `-${hours} hours`) || null
    );
  }

  createEscalation({
    botAccountId,
    chatProfileId,
    source,
    title,
    description = '',
    category,
    priority = 'l2',
    dedupeKey,
    assignedDashboardUserId = null,
    triggerMessageId = null,
  }) {
    const existing = this.findRecentPending({ botAccountId, chatProfileId, dedupeKey });
    if (existing) {
      return { ...existing, created: false };
    }

    return this.create({
      botAccountId,
      chatProfileId,
      source,
      title,
      description,
      category,
      priority,
      dedupeKey,
      assignedDashboardUserId,
      triggerMessageId,
    });
  }

  findById(id) {
    const db = getDatabase();
    return db
      .prepare(
        `${BASE_SELECT}
         WHERE ai.id = ?`
      )
      .get(id) || null;
  }

  listByBot(botAccountId, { status = null, limit = 100 } = {}) {
    const db = getDatabase();
    if (status) {
      return db
        .prepare(
          `${BASE_SELECT}
           WHERE ai.bot_account_id = ? AND ai.status = ?
           ORDER BY
             CASE WHEN ai.priority = 'l2' THEN 0 ELSE 1 END,
             ai.triggered_at DESC
           LIMIT ?`
        )
        .all(botAccountId, status, limit);
    }

    return db
      .prepare(
        `${BASE_SELECT}
         WHERE ai.bot_account_id = ?
         ORDER BY
           CASE WHEN ai.priority = 'l2' THEN 0 ELSE 1 END,
           ai.triggered_at DESC
         LIMIT ?`
      )
      .all(botAccountId, limit);
  }

  listGlobal({ status = null, coachQuery = '', studentQuery = '', category = '', limit = 300 } = {}) {
    const db = getDatabase();
    const where = [];
    const params = [];

    if (status) {
      where.push('ai.status = ?');
      params.push(status);
    }
    if (category) {
      where.push('LOWER(COALESCE(ai.category, "")) = ?');
      params.push(String(category).trim().toLowerCase());
    }
    if (coachQuery) {
      where.push('LOWER(COALESCE(du.name, "")) LIKE ?');
      params.push(`%${String(coachQuery).trim().toLowerCase()}%`);
    }
    if (studentQuery) {
      where.push(
        '(LOWER(COALESCE(cp.contact_name, "")) LIKE ? OR COALESCE(cp.contact_phone, "") LIKE ?)'
      );
      params.push(
        `%${String(studentQuery).trim().toLowerCase()}%`,
        `%${String(studentQuery).replace(/\D/g, '')}%`
      );
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return db
      .prepare(
        `${BASE_SELECT}
         ${whereSql}
         ORDER BY
           CASE WHEN ai.priority = 'l2' THEN 0 ELSE 1 END,
           ai.triggered_at DESC
         LIMIT ?`
      )
      .all(...params, limit);
  }

  listForTeam(teamId, { status = null, coachQuery = '', studentQuery = '', category = '', limit = 300 } = {}) {
    const db = getDatabase();
    if (!teamId) return [];

    const where = [
      `(
        du.team_id = ?
        OR ai.bot_account_id IN (
          SELECT ba.id
          FROM bot_accounts ba
          INNER JOIN dashboard_users du_bot ON du_bot.id = ba.dashboard_user_id
          WHERE du_bot.team_id = ?
        )
      )`,
    ];
    const params = [teamId, teamId];

    if (status) {
      where.push('ai.status = ?');
      params.push(status);
    }
    if (category) {
      where.push('LOWER(COALESCE(ai.category, "")) = ?');
      params.push(String(category).trim().toLowerCase());
    }
    if (coachQuery) {
      where.push('LOWER(COALESCE(du.name, "")) LIKE ?');
      params.push(`%${String(coachQuery).trim().toLowerCase()}%`);
    }
    if (studentQuery) {
      where.push(
        '(LOWER(COALESCE(cp.contact_name, "")) LIKE ? OR COALESCE(cp.contact_phone, "") LIKE ?)'
      );
      params.push(
        `%${String(studentQuery).trim().toLowerCase()}%`,
        `%${String(studentQuery).replace(/\D/g, '')}%`
      );
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    params.push(limit);

    return db
      .prepare(
        `${BASE_SELECT}
         ${whereSql}
         ORDER BY
           CASE WHEN ai.priority = 'l2' THEN 0 ELSE 1 END,
           ai.triggered_at DESC
         LIMIT ?`
      )
      .all(...params);
  }

  getCountsForTeam(teamId) {
    const db = getDatabase();
    if (!teamId) return [];

    return db
      .prepare(
        `SELECT ai.status, COUNT(*) AS count
         FROM action_items ai
         LEFT JOIN dashboard_users du ON du.id = ai.assigned_dashboard_user_id
         WHERE du.team_id = ?
            OR ai.bot_account_id IN (
              SELECT ba.id
              FROM bot_accounts ba
              INNER JOIN dashboard_users du_bot ON du_bot.id = ba.dashboard_user_id
              WHERE du_bot.team_id = ?
            )
         GROUP BY ai.status`
      )
      .all(teamId, teamId);
  }

  updateStatus(id, status) {
    const db = getDatabase();
    const completedAt = status === ACTION_STATUS.DONE ? new Date().toISOString() : null;
    db.prepare(`UPDATE action_items SET status = ?, completed_at = ? WHERE id = ?`).run(
      status,
      completedAt,
      id
    );
    return this.findById(id);
  }

  listByBotAccountIds(botAccountIds, { status = null, limit = 300 } = {}) {
    const ids = [...new Set((botAccountIds || []).filter(Boolean))];
    if (!ids.length) return [];

    const db = getDatabase();
    const placeholders = ids.map(() => '?').join(',');
    const params = [...ids];
    let statusSql = '';
    if (status) {
      statusSql = ' AND ai.status = ?';
      params.push(status);
    }
    params.push(limit);

    return db
      .prepare(
        `${BASE_SELECT}
         WHERE ai.bot_account_id IN (${placeholders})${statusSql}
         ORDER BY
           CASE WHEN ai.priority = 'l2' THEN 0 ELSE 1 END,
           ai.triggered_at DESC
         LIMIT ?`
      )
      .all(...params);
  }

  getCounts(botAccountId) {
    const db = getDatabase();
    return db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM action_items WHERE bot_account_id = ?
         GROUP BY status`
      )
      .all(botAccountId);
  }

  getCountsForBots(botAccountIds) {
    const ids = [...new Set((botAccountIds || []).filter(Boolean))];
    if (!ids.length) return [];
    const db = getDatabase();
    const placeholders = ids.map(() => '?').join(',');
    return db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM action_items
         WHERE bot_account_id IN (${placeholders})
         GROUP BY status`
      )
      .all(...ids);
  }

  suggestFromPrompt(prompt) {
    const text = String(prompt || '').trim();
    if (!text) {
      return { category: 'general', title: 'Manual action follow-up', priority: 'normal' };
    }

    const firstLine = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    return {
      category: 'general',
      title: firstLine ? firstLine.slice(0, 80) : 'Manual action follow-up',
      priority: 'normal',
    };
  }
}

module.exports = {
  actionItemService: new ActionItemService(),
  ACTION_STATUS,
  ACTION_SOURCES,
};
