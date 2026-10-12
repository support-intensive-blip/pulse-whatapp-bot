const { getDatabase } = require('../database/db');
const logger = require('../utils/logger');
const { encryptSecret, decryptSecret } = require('../utils/secretCrypto');
const { normalizePhone, canonicalContactPhone } = require('../utils/helpers');
const {
  MAX_REPLY_DELAY_SECONDS,
  MAX_BATCH_DELAY_SECONDS,
  MAX_CONTEXT_WINDOW_MINUTES,
} = require('../utils/constants');

const DEFAULT_CONTEXT_WINDOW_MINUTES = 60;

// What the bot does with inbound messages: reply, store only, or reply to test numbers only.
const AI_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  TESTING: 'testing',
};

const SECRET_COLUMNS = {
  apiKey: 'gallabox_api_key_enc',
  apiSecret: 'gallabox_api_secret_enc',
  webhookSecret: 'webhook_secret_enc',
};

function maskSecret(value) {
  if (!value) return null;
  return `••••${String(value).slice(-4)}`;
}

function safeDecrypt(payload) {
  if (!payload) return { value: '', ok: true };
  try {
    return { value: decryptSecret(payload) || '', ok: true };
  } catch (_error) {
    // ENCRYPTION_KEY / JWT_SECRET changed since the secret was saved.
    return { value: '', ok: false };
  }
}

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
    if (!bot || !this.isTestingMode(bot)) return null;
    const canonical = canonicalContactPhone(phone);
    return Boolean(canonical) && this.parseTestNumbers(bot).includes(canonical);
  }

  isTestingMode(bot) {
    return Boolean(bot) && (bot.ai_status === AI_STATUS.TESTING || bot.test_mode_enabled === 1);
  }

  isPaused(bot) {
    return Boolean(bot) && bot.ai_status === AI_STATUS.PAUSED;
  }

  findById(id) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM bot_accounts WHERE id = ?').get(id) || null;
  }

  /** The bot's own WhatsApp number — also the owner_phone its chats are stored under. */
  getPhone(bot) {
    return normalizePhone(bot?.whatsapp_phone || bot?.last_whatsapp_phone || '') || null;
  }

  listAll({ teamId = null, includeInactive = true } = {}) {
    const where = [];
    const params = [];
    if (teamId) {
      where.push('team_id = ?');
      params.push(teamId);
    }
    if (!includeInactive) where.push('is_active = 1');
    return getDatabase()
      .prepare(
        `SELECT * FROM bot_accounts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ASC`
      )
      .all(...params);
  }

  listByTeam(teamId) {
    if (!teamId) return [];
    return this.listAll({ teamId });
  }

  findByChannelId(channelId) {
    if (!channelId) return null;
    return (
      getDatabase()
        .prepare('SELECT * FROM bot_accounts WHERE gallabox_channel_id = ?')
        .get(String(channelId)) || null
    );
  }

  /** Decrypted Gallabox config; `readable` is false if a stored secret can't be decrypted. */
  getCredentials(bot) {
    if (!bot) return null;
    const apiKey = safeDecrypt(bot.gallabox_api_key_enc);
    const apiSecret = safeDecrypt(bot.gallabox_api_secret_enc);
    const webhookSecret = safeDecrypt(bot.webhook_secret_enc);
    return {
      apiKey: apiKey.value,
      apiSecret: apiSecret.value,
      webhookSecret: webhookSecret.value,
      channelId: bot.gallabox_channel_id || '',
      accountId: bot.gallabox_account_id || '',
      phone: this.getPhone(bot) || '',
      readable: apiKey.ok && apiSecret.ok && webhookSecret.ok,
    };
  }

  hasCredentials(bot) {
    return Boolean(
      bot?.gallabox_api_key_enc && bot?.gallabox_api_secret_enc && bot?.gallabox_channel_id && this.getPhone(bot)
    );
  }

  /** Only fields passed with a non-empty value are replaced (secrets are write-only in the UI). */
  setCredentials(id, { apiKey, apiSecret, webhookSecret, channelId, accountId } = {}) {
    const fields = ["updated_at = datetime('now')"];
    const values = [];
    const secrets = { apiKey, apiSecret, webhookSecret };
    for (const [key, column] of Object.entries(SECRET_COLUMNS)) {
      const value = String(secrets[key] ?? '').trim();
      if (value) {
        fields.push(`${column} = ?`);
        values.push(encryptSecret(value));
      }
    }
    const channel = String(channelId ?? '').trim();
    if (channel) {
      const other = this.findByChannelId(channel);
      if (other && other.id !== Number(id)) {
        throw new Error(`Channel ${channel} is already connected to bot "${other.name}"`);
      }
      fields.push('gallabox_channel_id = ?');
      values.push(channel);
    }
    if (accountId !== undefined) {
      fields.push('gallabox_account_id = ?');
      values.push(String(accountId || '').trim() || null);
    }
    values.push(id);
    getDatabase().prepare(`UPDATE bot_accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  normalizeBotPhone(raw) {
    const phone = canonicalContactPhone(raw);
    if (!phone || phone.length < 11 || phone.length > 13) {
      throw new Error('Enter the WhatsApp Business number with country code, e.g. 91XXXXXXXXXX');
    }
    return phone;
  }

  assertPhoneAvailable(phone, exceptId = null) {
    const other = getDatabase()
      .prepare(
        `SELECT id, name FROM bot_accounts
         WHERE (whatsapp_phone = ? OR last_whatsapp_phone = ?) AND id != ? AND is_active = 1`
      )
      .get(phone, phone, exceptId || 0);
    if (other) throw new Error(`${phone} is already used by bot "${other.name}"`);
  }

  createBot({ teamId, name, description = null, phone, createdBy = null, systemPrompt = '' }) {
    if (!teamId) throw new Error('teamId is required');
    const botName = String(name || '').trim();
    if (!botName) throw new Error('Bot name is required');
    const normalized = this.normalizeBotPhone(phone);
    this.assertPhoneAvailable(normalized);

    const result = getDatabase()
      .prepare(
        `INSERT INTO bot_accounts
           (team_id, dashboard_user_id, name, description, whatsapp_phone, last_whatsapp_phone,
            session_client_id, system_prompt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        teamId,
        createdBy,
        botName,
        description,
        normalized,
        normalized,
        `gallabox_${normalized}_${Date.now()}`,
        String(systemPrompt || '')
      );
    return this.findById(result.lastInsertRowid);
  }

  parseKnowledgeResourceIds(bot) {
    try {
      const list = JSON.parse(bot?.knowledge_resource_ids || '[]');
      return Array.isArray(list) ? [...new Set(list.map(Number).filter(Boolean))] : [];
    } catch (_error) {
      return [];
    }
  }

  setKnowledgeResourceIds(id, ids) {
    const list = [...new Set((ids || []).map(Number).filter(Boolean))];
    getDatabase()
      .prepare("UPDATE bot_accounts SET knowledge_resource_ids = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(list), id);
    return this.findById(id);
  }

  setSystemPrompt(id, content) {
    getDatabase()
      .prepare("UPDATE bot_accounts SET system_prompt = ?, updated_at = datetime('now') WHERE id = ?")
      .run(String(content || ''), id);
    return this.findById(id);
  }

  touchInbound(id) {
    getDatabase().prepare("UPDATE bot_accounts SET last_inbound_at = datetime('now') WHERE id = ?").run(id);
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

  updateStatus(id, status, { lastQr = null, lastError = undefined, whatsappPhone = null, lastPairingCode = null, clearWhatsappPhone = false } = {}) {
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
    // undefined leaves last_error alone; null clears it.
    if (lastError !== undefined) {
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

    if (settings.aiStatus !== undefined && !Object.values(AI_STATUS).includes(settings.aiStatus)) {
      throw new Error('aiStatus must be active, paused or testing');
    }
    if (settings.name !== undefined && !String(settings.name).trim()) {
      throw new Error('Bot name cannot be empty');
    }
    // ai_status 'testing' and the older test_mode_enabled flag describe the same
    // thing; keep them in step whichever one the caller sets.
    if (settings.aiStatus !== undefined && settings.testModeEnabled === undefined) {
      settings = { ...settings, testModeEnabled: settings.aiStatus === AI_STATUS.TESTING };
    } else if (settings.testModeEnabled !== undefined && settings.aiStatus === undefined && !this.isPaused(bot)) {
      settings = { ...settings, aiStatus: settings.testModeEnabled ? AI_STATUS.TESTING : AI_STATUS.ACTIVE };
    }

    const map = {
      name: 'name',
      description: 'description',
      aiStatus: 'ai_status',
      defaultAiOn: 'default_ai_on',
      isActive: 'is_active',
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
        } else if (column.includes('_enabled') || column === 'default_ai_on' || column === 'is_active') {
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

  /** Safe for any dashboard role: no secrets, no prompt. */
  toSummary(bot) {
    if (!bot) return null;
    return {
      id: bot.id,
      teamId: bot.team_id,
      name: bot.name,
      description: bot.description,
      whatsappPhone: this.getPhone(bot),
      status: bot.status,
      isActive: bot.is_active === 1,
      aiStatus: bot.ai_status,
      lastInboundAt: bot.last_inbound_at,
    };
  }

  /** Full settings for team admins. Secrets are only ever returned masked. */
  toPublic(bot) {
    if (!bot) return null;
    const creds = this.getCredentials(bot);
    return {
      ...this.toSummary(bot),
      assistantName: bot.assistant_name,
      assistantSelfEnabled: bot.assistant_self_enabled === 1,
      assistantContactsEnabled: bot.assistant_contacts_enabled === 1,
      defaultAiOn: bot.default_ai_on === 1,
      lastError: bot.last_error,
      testModeEnabled: this.isTestingMode(bot),
      testNumbers: this.parseTestNumbers(bot),
      replyDelaySeconds: bot.reply_delay_seconds,
      batchDelaySeconds: bot.batch_delay_seconds,
      contextWindowMinutes: bot.context_window_minutes,
      knowledgeResourceIds: this.parseKnowledgeResourceIds(bot),
      hasPrompt: Boolean(String(bot.system_prompt || '').trim()),
      gallabox: {
        configured: this.hasCredentials(bot),
        credentialsReadable: creds.readable,
        channelId: bot.gallabox_channel_id,
        accountId: bot.gallabox_account_id,
        apiKey: maskSecret(creds.apiKey),
        apiSecret: maskSecret(creds.apiSecret),
        webhookSecret: maskSecret(creds.webhookSecret),
      },
      createdAt: bot.created_at,
      updatedAt: bot.updated_at,
    };
  }
}

module.exports = {
  botAccountService: new BotAccountService(),
  BOT_STATUS,
  AI_STATUS,
};
