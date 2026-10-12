const { getDatabase } = require('../database/db');
const { botAccountService } = require('./botAccountService');

const MAX_PROMPT_CHARS = 60000;

/** Every published prompt is kept as a version; bot_accounts.system_prompt is the live one. */
class PromptVersionService {
  list(botAccountId, { limit = 50 } = {}) {
    return getDatabase()
      .prepare(
        `SELECT v.id, v.bot_account_id, v.note, v.created_at, v.created_by, LENGTH(v.content) AS length,
                u.name AS created_by_name
         FROM bot_prompt_versions v
         LEFT JOIN dashboard_users u ON u.id = v.created_by
         WHERE v.bot_account_id = ?
         ORDER BY v.id DESC
         LIMIT ?`
      )
      .all(botAccountId, limit);
  }

  findById(botAccountId, versionId) {
    return (
      getDatabase()
        .prepare('SELECT * FROM bot_prompt_versions WHERE id = ? AND bot_account_id = ?')
        .get(versionId, botAccountId) || null
    );
  }

  latest(botAccountId) {
    return (
      getDatabase()
        .prepare('SELECT * FROM bot_prompt_versions WHERE bot_account_id = ? ORDER BY id DESC LIMIT 1')
        .get(botAccountId) || null
    );
  }

  /** Publishes `content` as the live prompt; a no-op if it equals the current prompt. */
  publish(botAccountId, content, { note = null, userId = null } = {}) {
    const text = String(content || '').trim();
    if (!text) throw new Error('The system prompt cannot be empty');
    if (text.length > MAX_PROMPT_CHARS) {
      throw new Error(`The system prompt is too long (max ${MAX_PROMPT_CHARS} characters)`);
    }

    const bot = botAccountService.findById(botAccountId);
    if (!bot) throw new Error('Bot not found');
    const latest = this.latest(botAccountId);
    if (latest && latest.content === text && String(bot.system_prompt || '').trim() === text) {
      return { bot, version: latest, changed: false };
    }

    const result = getDatabase()
      .prepare('INSERT INTO bot_prompt_versions (bot_account_id, content, note, created_by) VALUES (?, ?, ?, ?)')
      .run(botAccountId, text, note ? String(note).slice(0, 200) : null, userId);
    return {
      bot: botAccountService.setSystemPrompt(botAccountId, text),
      version: this.findById(botAccountId, result.lastInsertRowid),
      changed: true,
    };
  }
}

module.exports = { promptVersionService: new PromptVersionService(), MAX_PROMPT_CHARS };
