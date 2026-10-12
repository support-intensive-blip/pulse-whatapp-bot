const { getDatabase } = require('../database/db');
const logger = require('../utils/logger');

// Call-to-Action workflow. PENDING / DONE / CANCELLED are the pre-multi-team names,
// kept as aliases so older callers keep working.
const ACTION_STATUS = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
  PENDING: 'open',
  DONE: 'resolved',
  CANCELLED: 'closed',
};

const STATUS_VALUES = ['open', 'in_progress', 'resolved', 'closed'];
const OPEN_STATUSES = ['open', 'in_progress'];
const PRIORITY_VALUES = ['low', 'normal', 'high', 'urgent', 'l2'];

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
                            cu.name AS created_by_name,
                            ba.name AS bot_name, COALESCE(ba.whatsapp_phone, ba.last_whatsapp_phone) AS bot_phone,
                            ba.team_id AS team_id,
                            m.timestamp AS trigger_message_at
                     FROM action_items ai
                     LEFT JOIN chat_profiles cp ON cp.id = ai.chat_profile_id
                     LEFT JOIN dashboard_users du ON du.id = ai.assigned_dashboard_user_id
                     LEFT JOIN dashboard_users cu ON cu.id = ai.created_by_user_id
                     LEFT JOIN bot_accounts ba ON ba.id = ai.bot_account_id
                     LEFT JOIN messages m ON m.id = ai.trigger_message_id`;

const ORDER_BY = `ORDER BY
  CASE ai.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
  CASE WHEN ai.priority IN ('urgent', 'l2') THEN 0 WHEN ai.priority = 'high' THEN 1 ELSE 2 END,
  ai.triggered_at DESC`;

function placeholders(list) {
  return list.map(() => '?').join(',');
}

class ActionItemService {
  resolveTriggeredAt(db, triggerMessageId = null) {
    if (triggerMessageId) {
      const row = db.prepare('SELECT timestamp FROM messages WHERE id = ?').get(triggerMessageId);
      if (row?.timestamp) return row.timestamp;
    }
    return new Date().toISOString();
  }

  normalizeDueDate(value) {
    if (value == null || value === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('dueDate must be a valid date');
    return date.toISOString();
  }

  create({
    botAccountId,
    chatProfileId = null,
    assignedDashboardUserId = null,
    createdByUserId = null,
    source,
    title,
    description = '',
    status = ACTION_STATUS.OPEN,
    category = null,
    priority = null,
    dedupeKey = null,
    triggerMessageId = null,
    dueDate = null,
  }) {
    const db = getDatabase();
    const triggeredAt = this.resolveTriggeredAt(db, triggerMessageId);

    const result = db
      .prepare(
        `INSERT INTO action_items
         (bot_account_id, chat_profile_id, assigned_dashboard_user_id, created_by_user_id, source, title,
          description, status, category, priority, dedupe_key, trigger_message_id, triggered_at, due_date, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        botAccountId,
        chatProfileId,
        assignedDashboardUserId || null,
        createdByUserId,
        source,
        title,
        description,
        status,
        category,
        priority,
        dedupeKey,
        triggerMessageId,
        triggeredAt,
        this.normalizeDueDate(dueDate)
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
          assignedDashboardUserId: item?.assigned_dashboard_user_id,
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
    const openSql = `ai.status IN (${placeholders(OPEN_STATUSES)})`;
    if (dedupeKey) {
      return (
        db
          .prepare(
            `${BASE_SELECT}
             WHERE ai.bot_account_id = ?
               AND ai.dedupe_key = ?
               AND ${openSql}
               AND datetime(ai.triggered_at) >= datetime('now', ?)
             ORDER BY ai.triggered_at DESC
             LIMIT 1`
          )
          .get(botAccountId, dedupeKey, ...OPEN_STATUSES, `-${hours} hours`) || null
      );
    }

    return (
      db
        .prepare(
          `${BASE_SELECT}
           WHERE ai.bot_account_id = ?
             AND ai.chat_profile_id = ?
             AND ${openSql}
             AND datetime(ai.triggered_at) >= datetime('now', ?)
           ORDER BY ai.triggered_at DESC
           LIMIT 1`
        )
        .get(botAccountId, chatProfileId, ...OPEN_STATUSES, `-${hours} hours`) || null
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
    createdByUserId = null,
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
      createdByUserId,
      triggerMessageId,
    });
  }

  findById(id) {
    return getDatabase().prepare(`${BASE_SELECT} WHERE ai.id = ?`).get(id) || null;
  }

  /**
   * Items of the given bots (the caller's team scope) with dashboard filters.
   * `status` may be one value, a comma list, or 'active' (open + in progress).
   */
  listForBots(
    botAccountIds,
    { status = null, assignedUserId = null, priority = null, chatProfileId = null, studentQuery = '', category = '', dueBefore = null, limit = 500 } = {}
  ) {
    const ids = [...new Set((botAccountIds || []).filter(Boolean))];
    if (!ids.length) return [];

    const where = [`ai.bot_account_id IN (${placeholders(ids)})`];
    const params = [...ids];

    const statuses =
      status === 'active'
        ? OPEN_STATUSES
        : String(status || '')
            .split(',')
            .map((s) => ACTION_STATUS[s.trim().toUpperCase()] || s.trim())
            .filter((s) => STATUS_VALUES.includes(s));
    if (statuses.length) {
      where.push(`ai.status IN (${placeholders(statuses)})`);
      params.push(...statuses);
    }
    if (assignedUserId === 'none') {
      where.push('ai.assigned_dashboard_user_id IS NULL');
    } else if (assignedUserId) {
      where.push('ai.assigned_dashboard_user_id = ?');
      params.push(Number(assignedUserId));
    }
    if (priority) {
      where.push('ai.priority = ?');
      params.push(priority);
    }
    if (chatProfileId) {
      where.push('ai.chat_profile_id = ?');
      params.push(Number(chatProfileId));
    }
    if (category) {
      where.push("LOWER(COALESCE(ai.category, '')) = ?");
      params.push(String(category).trim().toLowerCase());
    }
    if (dueBefore) {
      where.push('ai.due_date IS NOT NULL AND datetime(ai.due_date) <= datetime(?)');
      params.push(this.normalizeDueDate(dueBefore));
    }
    if (studentQuery) {
      const digits = String(studentQuery).replace(/\D/g, '');
      where.push(
        `(LOWER(COALESCE(cp.contact_name, '')) LIKE ? OR LOWER(ai.title) LIKE ?${digits ? " OR COALESCE(cp.contact_phone, '') LIKE ?" : ''})`
      );
      const q = `%${String(studentQuery).trim().toLowerCase()}%`;
      params.push(q, q);
      if (digits) params.push(`%${digits}%`);
    }

    params.push(Math.min(Number(limit) || 500, 1000));
    return getDatabase()
      .prepare(`${BASE_SELECT} WHERE ${where.join(' AND ')} ${ORDER_BY} LIMIT ?`)
      .all(...params);
  }

  /** Partial update from the dashboard; `resolved`/`closed` stamp completed_at. */
  update(id, { status, assignedUserId, priority, dueDate, notes, resolution, title, description } = {}) {
    const fields = ["updated_at = datetime('now')"];
    const values = [];

    if (status !== undefined) {
      const normalized = ACTION_STATUS[String(status).toUpperCase()] || status;
      if (!STATUS_VALUES.includes(normalized)) {
        throw new Error(`status must be one of ${STATUS_VALUES.join(', ')}`);
      }
      fields.push('status = ?', 'completed_at = ?');
      values.push(normalized, OPEN_STATUSES.includes(normalized) ? null : new Date().toISOString());
    }
    if (assignedUserId !== undefined) {
      fields.push('assigned_dashboard_user_id = ?');
      values.push(assignedUserId ? Number(assignedUserId) : null);
    }
    if (priority !== undefined) {
      if (priority && !PRIORITY_VALUES.includes(priority)) {
        throw new Error(`priority must be one of ${PRIORITY_VALUES.join(', ')}`);
      }
      fields.push('priority = ?');
      values.push(priority || null);
    }
    if (dueDate !== undefined) {
      fields.push('due_date = ?');
      values.push(this.normalizeDueDate(dueDate));
    }
    const textFields = { notes: [notes, 4000], resolution: [resolution, 4000], title: [title, 160], description: [description, 4000] };
    for (const [column, [value, max]] of Object.entries(textFields)) {
      if (value === undefined) continue;
      if (column === 'title' && !String(value).trim()) throw new Error('Title cannot be empty');
      fields.push(`${column} = ?`);
      values.push(value == null ? null : String(value).slice(0, max));
    }

    values.push(id);
    getDatabase().prepare(`UPDATE action_items SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  updateStatus(id, status) {
    return this.update(id, { status });
  }

  listByBotAccountIds(botAccountIds, { status = null, limit = 300 } = {}) {
    return this.listForBots(botAccountIds, { status, limit });
  }

  getCountsForBots(botAccountIds) {
    const ids = [...new Set((botAccountIds || []).filter(Boolean))];
    if (!ids.length) return [];
    return getDatabase()
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM action_items
         WHERE bot_account_id IN (${placeholders(ids)})
         GROUP BY status`
      )
      .all(...ids);
  }

  getCounts(botAccountId) {
    return this.getCountsForBots([botAccountId]);
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
  STATUS_VALUES,
  OPEN_STATUSES,
  PRIORITY_VALUES,
};
