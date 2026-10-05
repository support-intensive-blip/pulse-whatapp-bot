const { getDatabase } = require('../database/db');
const { getGroqClient } = require('../ai/groqClient');
const userService = require('./userService');
const chatProfileService = require('./chatProfileService');
const logger = require('../utils/logger');
const { MAX_MESSAGES_PER_USER, MESSAGE_ROLES } = require('../utils/constants');
const { TOKEN_BUDGET } = require('../config/tokenBudget');
const { TOKEN_CATEGORIES } = require('../config/tokenCategories');
const { parseTimestamp } = require('../utils/time');

const MAX_SUMMARY_CONTEXT_CHARS = Number(process.env.CHAT_SUMMARY_CONTEXT_CHARS) || 8000;

const NOISE_MESSAGE_PATTERNS = [
  /^hey!?\s*i'?m\s+/i,
  /^sorry, something went wrong/i,
  /^pong\s/i,
];

class MemoryService {
  serializeKbMeta(kbMeta) {
    if (!kbMeta) return null;
    try {
      return JSON.stringify(kbMeta);
    } catch {
      return null;
    }
  }

  parseKbMeta(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  mapMessageRow(row) {
    if (!row) return row;
    const { kb_meta, ...rest } = row;
    const kbMeta = this.parseKbMeta(kb_meta);
    return kbMeta ? { ...rest, kbMeta } : rest;
  }

  resolveOwnerUserId(chatProfileId) {
    const profile = chatProfileService.findById(chatProfileId);
    if (!profile?.owner_phone) return null;
    const owner = userService.getOrCreate(profile.owner_phone);
    return owner?.id || null;
  }

  addMessage(chatProfileId, role, content, { source = null, waMessageId = null, kbMeta = null } = {}) {
    const db = getDatabase();
    const profile = chatProfileService.findById(chatProfileId);

    // Validate FK parents right before insert. Under concurrent load the parent
    // row can be momentarily unresolvable; since both columns are nullable, null
    // out a missing reference instead of letting a FOREIGN KEY constraint failure
    // bubble up as a 500. In the real WhatsApp path parents always exist (no-op).
    const safeChatProfileId = profile ? chatProfileId : null;
    let ownerUserId = this.resolveOwnerUserId(chatProfileId);
    if (ownerUserId != null && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(ownerUserId)) {
      ownerUserId = null;
    }

    const targetIds = profile
      ? [...new Set([chatProfileId, ...chatProfileService.getSiblingProfiles(profile).map((p) => p.id)])]
      : [chatProfileId];

    if (waMessageId) {
      for (const targetId of targetIds) {
        const existing = db
          .prepare(
            `SELECT id FROM messages
             WHERE chat_profile_id = ? AND wa_message_id = ?`
          )
          .get(targetId, waMessageId);
        if (existing) {
          return this.getMessageById(existing.id);
        }
      }
    }

    try {
      const result = db
        .prepare(
          `INSERT INTO messages (user_id, chat_profile_id, role, content, source, wa_message_id, kb_meta)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ownerUserId,
          safeChatProfileId,
          role,
          content,
          source,
          waMessageId,
          this.serializeKbMeta(kbMeta)
        );

      logger.info(`Stored message for chat profile ${chatProfileId}, role=${role}, source=${source || 'n/a'}`);

      for (const targetId of targetIds) {
        db.prepare(`UPDATE chat_profiles SET updated_at = datetime('now') WHERE id = ?`).run(targetId);
      }

      return this.getMessageById(result.lastInsertRowid);
    } catch (error) {
      if (waMessageId && String(error.message).includes('UNIQUE constraint failed')) {
        for (const targetId of targetIds) {
          const dup = db
            .prepare(
              `SELECT id FROM messages
               WHERE chat_profile_id = ? AND wa_message_id = ?`
            )
            .get(targetId, waMessageId);
          if (dup) {
            logger.info(`Skipped duplicate message ${waMessageId} for chat profile ${targetId}`);
            return this.getMessageById(dup.id);
          }
        }
      }
      throw error;
    }
  }

  getMessageById(id) {
    const db = getDatabase();
    const row =
      db
        .prepare(
          `SELECT id, role, content, timestamp, source, wa_message_id, kb_meta FROM messages WHERE id = ?`
        )
        .get(id) || null;
    return this.mapMessageRow(row);
  }

  getMessages(chatProfileId, limit = MAX_MESSAGES_PER_USER, { sinceId = null } = {}) {
    const db = getDatabase();

    if (sinceId) {
      const rows = db
        .prepare(
          `SELECT id, role, content, timestamp, source, kb_meta FROM messages
           WHERE chat_profile_id = ? AND id > ?
           ORDER BY id ASC
           LIMIT ?`
        )
        .all(chatProfileId, sinceId, limit);
      return rows.map((row) => this.mapMessageRow(row));
    }

    const rows = db
      .prepare(
        `SELECT id, role, content, timestamp, source, kb_meta FROM messages
         WHERE chat_profile_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(chatProfileId, limit);

    return rows.reverse().map((row) => this.mapMessageRow(row));
  }

  getMessagesForProfiles(chatProfileIds, limit = MAX_MESSAGES_PER_USER, { sinceId = null } = {}) {
    const ids = [...new Set((chatProfileIds || []).filter(Boolean))];
    if (!ids.length) return [];

    if (ids.length === 1) {
      return this.getMessages(ids[0], limit, { sinceId });
    }

    const db = getDatabase();
    const placeholders = ids.map(() => '?').join(', ');

    if (sinceId) {
      const rows = db
        .prepare(
          `SELECT id, role, content, timestamp, source, chat_profile_id, kb_meta
           FROM messages
           WHERE chat_profile_id IN (${placeholders}) AND id > ?
           ORDER BY id ASC
           LIMIT ?`
        )
        .all(...ids, sinceId, limit);
      return rows.map((row) => this.mapMessageRow(row));
    }

    const rows = db
      .prepare(
        `SELECT id, role, content, timestamp, source, chat_profile_id, kb_meta
         FROM messages
         WHERE chat_profile_id IN (${placeholders})
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(...ids, limit);

    return rows.reverse().map((row) => this.mapMessageRow(row));
  }

  getBatchChatMeta(profileIds) {
    if (!profileIds?.length) return new Map();

    const db = getDatabase();
    const ids = [...new Set(profileIds.map(Number).filter(Boolean))];
    if (!ids.length) return new Map();

    const placeholders = ids.map(() => '?').join(',');
    const aggregates = db
      .prepare(
        `SELECT chat_profile_id, COUNT(*) AS message_count, MAX(id) AS last_id
         FROM messages
         WHERE chat_profile_id IN (${placeholders})
         GROUP BY chat_profile_id`
      )
      .all(...ids);

    const lastIds = aggregates.map((row) => row.last_id).filter(Boolean);
    const lastByProfile = new Map();

    if (lastIds.length) {
      const lastPlaceholders = lastIds.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT id, chat_profile_id, role, content, timestamp, source
           FROM messages WHERE id IN (${lastPlaceholders})`
        )
        .all(...lastIds);
      for (const row of rows) {
        lastByProfile.set(row.chat_profile_id, row);
      }
    }

    const result = new Map();
    for (const row of aggregates) {
      result.set(row.chat_profile_id, {
        messageCount: row.message_count,
        lastMessage: lastByProfile.get(row.chat_profile_id) || null,
      });
    }
    return result;
  }

  getLastMessage(chatProfileId) {
    const db = getDatabase();
    return (
      db
        .prepare(
          `SELECT id, role, content, timestamp, source FROM messages
           WHERE chat_profile_id = ?
           ORDER BY timestamp DESC
           LIMIT 1`
        )
        .get(chatProfileId) || null
    );
  }

  getLastMessageByRole(chatProfileId, role) {
    const db = getDatabase();
    return (
      db
        .prepare(
          `SELECT id, role, content, timestamp, source FROM messages
           WHERE chat_profile_id = ? AND role = ?
           ORDER BY id DESC
           LIMIT 1`
        )
        .get(chatProfileId, role) || null
    );
  }

  getMessageCount(chatProfileId) {
    const db = getDatabase();
    const result = db
      .prepare('SELECT COUNT(*) as count FROM messages WHERE chat_profile_id = ?')
      .get(chatProfileId);
    return result.count;
  }

  getTotalMessageCount() {
    const db = getDatabase();
    const result = db.prepare('SELECT COUNT(*) as count FROM messages').get();
    return result.count;
  }

  deleteAllMessages(chatProfileId, { password, purpose } = {}) {
    const { assertDeletionPassword, backupSqliteDatabase } = require('../database/sqliteGuard');
    // Test-session resets are scoped to ephemeral test profiles; everything else needs the password.
    const isTestSessionReset = purpose === 'test_session_reset';
    if (!isTestSessionReset) {
      assertDeletionPassword(password, {
        action: `delete messages for chat profile ${chatProfileId}`,
      });
      backupSqliteDatabase({ reason: `predelete-chat-${chatProfileId}` });
    }

    const db = getDatabase();
    const msgResult = db
      .prepare('DELETE FROM messages WHERE chat_profile_id = ?')
      .run(chatProfileId);
    const summaryResult = db
      .prepare('DELETE FROM conversation_summaries WHERE chat_profile_id = ?')
      .run(chatProfileId);
    logger.info(
      `Deleted ${msgResult.changes} messages and ${summaryResult.changes} summaries for chat profile ${chatProfileId}`
    );
    return msgResult.changes;
  }

  getSummaries(chatProfileId) {
    const db = getDatabase();
    return db
      .prepare(
        `SELECT summary, created_at FROM conversation_summaries
         WHERE chat_profile_id = ? ORDER BY created_at ASC`
      )
      .all(chatProfileId);
  }

  addSummary(chatProfileId, summary) {
    const db = getDatabase();
    const ownerUserId = this.resolveOwnerUserId(chatProfileId);
    db.prepare(
      'INSERT INTO conversation_summaries (user_id, chat_profile_id, summary) VALUES (?, ?, ?)'
    ).run(ownerUserId, chatProfileId, summary);
    logger.info(`Stored conversation summary for chat profile ${chatProfileId}`);
  }

  async enforceMessageLimit(chatProfileId) {
    const db = getDatabase();
    const count = this.getMessageCount(chatProfileId);

    if (count <= MAX_MESSAGES_PER_USER) return;

    const excess = count - MAX_MESSAGES_PER_USER;
    const oldestMessages = db
      .prepare(
        `SELECT id, role, content FROM messages
         WHERE chat_profile_id = ?
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(chatProfileId, excess);

    if (oldestMessages.length === 0) return;

    const ids = oldestMessages.map((m) => m.id);
    const placeholders = ids.map(() => '?').join(',');

    if (!TOKEN_BUDGET.memorySummarize) {
      db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
      logger.info(`Pruned ${excess} old messages (no AI summary) for chat profile ${chatProfileId}`);
      return;
    }

    try {
      const groq = getGroqClient();
      const ownerUserId = this.resolveOwnerUserId(chatProfileId);
      const summary = await groq.summarizeConversation(
        oldestMessages.map((m) => ({ role: m.role, content: m.content })),
        {
          usageContext: {
            chatProfileId,
            ownerUserId,
            category: TOKEN_CATEGORIES.CONTEXT,
          },
        }
      );

      this.addSummary(chatProfileId, summary);
      db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
      logger.info(`Pruned ${excess} old messages for chat profile ${chatProfileId}`);
    } catch (error) {
      logger.error(`Failed to summarize old messages: ${error.message}`);
      db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
    }
  }

  isNoiseMessage(content) {
    const text = (content || '').trim();
    if (!text || text.length <= 1) return true;
    return NOISE_MESSAGE_PATTERNS.some((pattern) => pattern.test(text));
  }

  getSummaryContext(chatProfileId) {
    const summaries = this.getSummaries(chatProfileId);
    if (summaries.length === 0) return '';

    const latest = summaries[summaries.length - 1]?.summary || '';
    if (!latest.trim()) return '';

    const context = `Previous conversation summary (internal — use for continuity, do not dump to student):\n${latest}`;
    if (context.length <= MAX_SUMMARY_CONTEXT_CHARS) return context;
    return context.slice(0, MAX_SUMMARY_CONTEXT_CHARS) + '...';
  }

  /**
   * Like buildContextMessages, but windows by time instead of a flat message
   * count: keeps messages from the last `windowMinutes`, always including at
   * least the last `minMessages` regardless of age (so a conversation that
   * resumes after a gap isn't handed zero context), capped at `maxMessages`
   * as a hard safety ceiling on prompt size/cost.
   *
   * `conversationBoundaryTs` (ISO string, optional) marks where the current,
   * still-open conversation began (set when a previous conversation was
   * detected as ended — see contextService#markConversationEnded /
   * #ensureConversationBoundary). Messages after that boundary are always
   * included in full regardless of `windowMinutes`, so an ongoing back-and-forth
   * is never truncated mid-conversation; older, already-ended conversations
   * still fall under the normal time-window rule.
   */
  buildTimeWindowedContextMessages(
    chatProfileId,
    { windowMinutes = 60, maxMessages = 40, minMessages = 2, conversationBoundaryTs = null } = {}
  ) {
    const profile = chatProfileService.findById(chatProfileId);
    const profileIds = profile
      ? [
          ...new Set([
            chatProfileId,
            ...chatProfileService.getSiblingProfiles(profile).map((p) => p.id),
          ]),
        ]
      : [chatProfileId];

    const rawMessages =
      profileIds.length > 1
        ? this.getMessagesForProfiles(profileIds, maxMessages)
        : this.getMessages(chatProfileId, maxMessages);

    const sinceMs = Date.now() - Math.max(1, windowMinutes) * 60000;
    const floorStartIndex = Math.max(0, rawMessages.length - minMessages);
    const boundaryMs = conversationBoundaryTs ? parseTimestamp(conversationBoundaryTs)?.getTime() : null;

    const context = [];
    for (let i = 0; i < rawMessages.length; i += 1) {
      const msg = rawMessages[i];
      if (!msg.content?.trim() || this.isNoiseMessage(msg.content)) continue;
      const withinFloor = i >= floorStartIndex;
      const parsedTs = parseTimestamp(msg.timestamp);
      const msgMs = parsedTs ? parsedTs.getTime() : null;
      const withinCurrentConversation = boundaryMs != null && msgMs != null && msgMs > boundaryMs;
      const withinWindow = msgMs == null || msgMs >= sinceMs;
      if (!withinFloor && !withinCurrentConversation && !withinWindow) continue;
      context.push({
        role: msg.role === MESSAGE_ROLES.ASSISTANT ? 'assistant' : 'user',
        content: msg.content,
      });
    }

    return context;
  }

  buildContextMessages(chatProfileId, limit = MAX_MESSAGES_PER_USER) {
    const profile = chatProfileService.findById(chatProfileId);
    const profileIds = profile
      ? [
          ...new Set([
            chatProfileId,
            ...chatProfileService.getSiblingProfiles(profile).map((p) => p.id),
          ]),
        ]
      : [chatProfileId];

    const messages =
      profileIds.length > 1
        ? this.getMessagesForProfiles(profileIds, limit)
        : this.getMessages(chatProfileId, limit);
    const context = [];

    for (const msg of messages) {
      if (!msg.content?.trim() || this.isNoiseMessage(msg.content)) continue;
      context.push({
        role: msg.role === MESSAGE_ROLES.ASSISTANT ? 'assistant' : 'user',
        content: msg.content,
      });
    }

    return context;
  }
}

module.exports = new MemoryService();
