const { getDatabase } = require('../database/db');
const logger = require('../utils/logger');
const { normalizePhone, canonicalContactPhone } = require('../utils/helpers');
const {
  MAX_REPLY_DELAY_SECONDS,
  MAX_BATCH_DELAY_SECONDS,
  MAX_CONTEXT_WINDOW_MINUTES,
} = require('../utils/constants');

const DEFAULT_CONTEXT_WINDOW_MINUTES = 60;

const BOT_STATUS = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  QR_PENDING: 'qr_pending',
  READY: 'ready',
  ERROR: 'error',
};

class BotAccountService {
  clampReplyDelaySeconds(value) {
    const seconds = Math.floor(Number(value) || 0);
    return Math.max(0, Math.min(MAX_REPLY_DELAY_SECONDS, seconds));
  }

  resolveReplyDelaySeconds(botAccountId) {
    const bot = this.findById(botAccountId);
    if (!bot) return 0;
    return this.clampReplyDelaySeconds(bot.reply_delay_seconds);
  }

  clampBatchDelaySeconds(value) {
    const seconds = Math.floor(Number(value) || 0);
    return Math.max(0, Math.min(MAX_BATCH_DELAY_SECONDS, seconds));
  }

  resolveBatchDelaySeconds(botAccountId) {
    const bot = this.findById(botAccountId);
    if (!bot) return this.clampBatchDelaySeconds(10);
    return this.clampBatchDelaySeconds(bot.batch_delay_seconds);
  }

  clampContextWindowMinutes(value) {
    const minutes = Math.floor(Number(value) || 0);
    if (minutes <= 0) return DEFAULT_CONTEXT_WINDOW_MINUTES;
    return Math.max(1, Math.min(MAX_CONTEXT_WINDOW_MINUTES, minutes));
  }

  resolveContextWindowMinutes(botAccountId) {
    const bot = this.findById(botAccountId);
    if (!bot) return DEFAULT_CONTEXT_WINDOW_MINUTES;
    return this.clampContextWindowMinutes(bot.context_window_minutes);
  }

  /** Validates and canonicalizes a test-number list; throws on an invalid entry. */
  normalizeTestNumbers(numbers) {
    if (!Array.isArray(numbers)) throw new Error('testNumbers must be a list of phone numbers');
    const result = [];
    for (const raw of numbers) {
      const phone = canonicalContactPhone(raw);
      if (!phone || phone.length < 11 || phone.length > 13) {
        throw new Error(`"${raw}" is not a valid phone number — use 10 digits or include the country code`);
      }
      if (!result.includes(phone)) result.push(phone);
    }
    return result;
  }

  parseTestNumbers(bot) {
    try {
      const list = JSON.parse(bot?.test_numbers || '[]');
      return Array.isArray(list) ? list.map(String) : [];
    } catch (_error) {
      return [];
    }
  }

  /**
   * Testing mode gate: with testing mode on, only listed numbers get AI replies.
   * Returns null when testing mode is off (normal per-chat rules apply).
   */
  resolveTestModeAccess(botAccountId, phone) {
    const bot = this.findById(botAccountId);
    if (!bot || !bot.test_mode_enabled) return null;
    const canonical = canonicalContactPhone(phone);
    return Boolean(canonical) && this.parseTestNumbers(bot).includes(canonical);
  }

  findById(id) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM bot_accounts WHERE id = ?').get(id) || null;
  }

  findByDashboardUserId(dashboardUserId) {
    const db = getDatabase();
    return (
      db
        .prepare(
          `SELECT * FROM bot_accounts
           WHERE dashboard_user_id = ?
           ORDER BY
             CASE status
               WHEN 'ready' THEN 0
               WHEN 'connecting' THEN 1
               WHEN 'qr_pending' THEN 2
               ELSE 3
             END,
             CASE WHEN whatsapp_phone IS NOT NULL AND whatsapp_phone != '' THEN 0 ELSE 1 END,
             CASE WHEN last_whatsapp_phone IS NOT NULL AND last_whatsapp_phone != '' THEN 0 ELSE 1 END,
             datetime(updated_at) DESC,
             id DESC`
        )
        .get(dashboardUserId) ||
      null
    );
  }

  findByWhatsappPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;

    const db = getDatabase();
    const exact = db.prepare('SELECT * FROM bot_accounts WHERE whatsapp_phone = ?').get(normalized);
    if (exact) return exact;

    return null;
  }

  createForUser(dashboardUserId, name = 'My WhatsApp Bot') {
    const existing = this.findByDashboardUserId(dashboardUserId);
    if (existing) return existing;

    const db = getDatabase();
    const sessionClientId = `bot_${dashboardUserId}_${Date.now()}`;
    const result = db
      .prepare(
        `INSERT INTO bot_accounts (dashboard_user_id, name, session_client_id)
         VALUES (?, ?, ?)`
      )
      .run(dashboardUserId, `${name}'s Bot`, sessionClientId);

    return this.findById(result.lastInsertRowid);
  }

  linkLegacySession(dashboardUserId) {
    const bot = this.findByDashboardUserId(dashboardUserId);
    if (!bot) return null;

    const db = getDatabase();
    db.prepare(
      `UPDATE bot_accounts
       SET session_client_id = 'default', name = 'Primary Bot', updated_at = datetime('now')
       WHERE id = ?`
    ).run(bot.id);

    return this.findById(bot.id);
  }

  updateStatus(id, status, { lastQr = null, lastError = null, whatsappPhone = null, lastPairingCode = null, clearWhatsappPhone = false } = {}) {
    const db = getDatabase();
    const fields = ['status = ?', "updated_at = datetime('now')"];
    const values = [status];

    if (clearWhatsappPhone) {
      fields.push('whatsapp_phone = NULL');
    }

    if (lastQr !== null) {
      fields.push('last_qr = ?');
      values.push(lastQr);
    }
    if (lastPairingCode !== null) {
      fields.push('last_pairing_code = ?');
      values.push(lastPairingCode);
    }
    if (lastError !== null) {
      fields.push('last_error = ?');
      values.push(lastError);
    }
    if (whatsappPhone !== null) {
      const phone = normalizePhone(whatsappPhone);
      fields.push('whatsapp_phone = ?');
      values.push(phone);
      fields.push('last_whatsapp_phone = ?');
      values.push(phone);
    }

    values.push(id);
    db.prepare(`UPDATE bot_accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  updateSettings(id, settings) {
    const db = getDatabase();
    const bot = this.findById(id);
    if (!bot) return null;

    const fields = ["updated_at = datetime('now')"];
    const values = [];

    const map = {
      name: 'name',
      assistantName: 'assistant_name',
      assistantSelfEnabled: 'assistant_self_enabled',
      assistantContactsEnabled: 'assistant_contacts_enabled',
      replyDelaySeconds: 'reply_delay_seconds',
      batchDelaySeconds: 'batch_delay_seconds',
      contextWindowMinutes: 'context_window_minutes',
      testModeEnabled: 'test_mode_enabled',
      testNumbers: 'test_numbers',
    };

    for (const [key, column] of Object.entries(map)) {
      if (settings[key] !== undefined) {
        fields.push(`${column} = ?`);
        let val = settings[key];
        if (column === 'reply_delay_seconds') {
          val = this.clampReplyDelaySeconds(val);
        } else if (column === 'batch_delay_seconds') {
          val = this.clampBatchDelaySeconds(val);
        } else if (column === 'context_window_minutes') {
          val = this.clampContextWindowMinutes(val);
        } else if (column === 'test_numbers') {
          val = JSON.stringify(this.normalizeTestNumbers(val));
        } else if (column.includes('_enabled')) {
          val = val ? 1 : 0;
        }
        values.push(val);
      }
    }

    values.push(id);
    db.prepare(`UPDATE bot_accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    const updated = this.findById(id);
    this.syncToWhatsAppUser(updated);
    return updated;
  }

  syncToWhatsAppUser(bot) {
    if (!bot?.whatsapp_phone) return;

    const userService = require('./userService');
    const owner = userService.getOrCreate(bot.whatsapp_phone);
    if (!owner) return;

    const db = getDatabase();
    db.prepare(
      `UPDATE users SET assistant_self_enabled = ?, assistant_contacts_enabled = ?, guru_mode = ? WHERE id = ?`
    ).run(
      bot.assistant_self_enabled,
      bot.assistant_contacts_enabled,
      bot.guru_mode,
      owner.id
    );
    logger.info(`Synced bot_account ${bot.id} settings to WhatsApp user ${owner.id}`);
  }

  syncFromWhatsAppUser(user) {
    if (!user?.phone) return;

    const db = getDatabase();
    const phone = normalizePhone(user.phone);
    const bot = db
      .prepare('SELECT id FROM bot_accounts WHERE whatsapp_phone = ? LIMIT 1')
      .get(phone);
    if (!bot) return;

    db.prepare(
      `UPDATE bot_accounts
       SET assistant_self_enabled = ?, assistant_contacts_enabled = ?, guru_mode = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      user.assistant_self_enabled ?? 1,
      user.assistant_contacts_enabled ?? 1,
      user.guru_mode ?? 0,
      bot.id
    );
    logger.info(`Synced WhatsApp user ${user.id} settings to bot_account ${bot.id}`);
  }

  getOwnerPhone(botAccountId) {
    const bot = this.findById(botAccountId);
    if (!bot) return null;
    return bot.whatsapp_phone || bot.last_whatsapp_phone || null;
  }

  listReadyBots() {
    const db = getDatabase();
    return db
      .prepare(
        `SELECT * FROM bot_accounts
         WHERE whatsapp_phone IS NOT NULL
           AND status IN (?, ?)
         ORDER BY
           CASE status WHEN ? THEN 0 ELSE 1 END,
           id ASC`
      )
      .all(BOT_STATUS.READY, BOT_STATUS.CONNECTING, BOT_STATUS.READY);
  }

  toPublic(bot) {
    if (!bot) return null;
    return {
      id: bot.id,
      name: bot.name,
      whatsappPhone: bot.whatsapp_phone,
      status: bot.status,
      assistantName: bot.assistant_name,
      assistantSelfEnabled: bot.assistant_self_enabled === 1,
      assistantContactsEnabled: bot.assistant_contacts_enabled === 1,
      lastError: bot.last_error,
      testModeEnabled: bot.test_mode_enabled === 1,
      testNumbers: this.parseTestNumbers(bot),
      updatedAt: bot.updated_at,
    };
  }
}

module.exports = {
  botAccountService: new BotAccountService(),
  BOT_STATUS,
};
