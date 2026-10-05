const { getDatabase } = require('../database/db');
const memoryService = require('./memoryService');
const knowledgeBaseService = require('./knowledgeBaseService');
const { conversationSlotsService } = require('./conversationSlotsService');
const { userMemoryService } = require('./userMemoryService');
const logger = require('../utils/logger');
const { parseTimestamp, currentISTDateTimeForLLM } = require('../utils/time');
const { MESSAGE_ROLES } = require('../utils/constants');

/** If the bot's last reply goes unanswered this long, treat the conversation as ended —
 *  a fallback for when the LLM doesn't emit conversation_end:true on its own. */
const CONVERSATION_IDLE_TIMEOUT_MS =
  Math.max(1, Number(process.env.CONVERSATION_IDLE_TIMEOUT_MINUTES) || 3) * 60 * 1000;

const CONTEXT_MODES = {
  CASUAL: 'casual',
  INTENSIVE: 'intensive',
  GURU: 'guru',
};

/** How long Intensive topic/mode sticks before expiring back to casual. */
const CONTEXT_MEMORY_TTL_MS =
  Math.max(1, Number(process.env.CONTEXT_MEMORY_TTL_MINUTES) || 15) * 60 * 1000;

/** Hard ceilings on the time-windowed history so a wide admin-set window (e.g. 24h) on a
 *  very active chat can't blow up prompt size/token cost. The window itself (how far back
 *  in time to look) is admin-configurable per team/bot via `context_window_minutes`. */
const CONTEXT_TIME_WINDOW_MAX_MESSAGES = Number(process.env.CONTEXT_TIME_WINDOW_MAX_MESSAGES) || 40;
const CONTEXT_TIME_WINDOW_MAX_CHARS = Number(process.env.CONTEXT_TIME_WINDOW_MAX_CHARS) || 8000;
/** Always include at least this many recent messages regardless of the time window, so a
 *  conversation resuming after a gap longer than the window isn't handed zero context. */
const CONTEXT_TIME_WINDOW_MIN_MESSAGES = Number(process.env.CONTEXT_TIME_WINDOW_MIN_MESSAGES) || 2;

class ContextService {
  getStoredContext(chatProfileId) {
    const db = getDatabase();
    const row = db
      .prepare('SELECT conversation_mode, context_topic, routing_slots FROM chat_profiles WHERE id = ?')
      .get(chatProfileId);

    let mode = row?.conversation_mode || CONTEXT_MODES.CASUAL;
    let topic = row?.context_topic || '';

    let contextSetAt = 0;
    try {
      const slots =
        row?.routing_slots && typeof row.routing_slots === 'string'
          ? JSON.parse(row.routing_slots)
          : row?.routing_slots || {};
      if (slots && typeof slots === 'object' && slots._contextSetAt) {
        contextSetAt = Date.parse(slots._contextSetAt) || 0;
      }
    } catch {
      contextSetAt = 0;
    }

    if (
      contextSetAt > 0 &&
      Date.now() - contextSetAt > CONTEXT_MEMORY_TTL_MS &&
      mode === CONTEXT_MODES.INTENSIVE
    ) {
      logger.info(
        `Context memory expired for profile=${chatProfileId} after ${Math.round(
          (Date.now() - contextSetAt) / 60000
        )}m (TTL=${Math.round(CONTEXT_MEMORY_TTL_MS / 60000)}m) — back to casual`
      );
      mode = CONTEXT_MODES.CASUAL;
      topic = '';
      this.setStoredContext(chatProfileId, CONTEXT_MODES.CASUAL, '');
      conversationSlotsService.updateFromMessage(chatProfileId, '', { clearTopic: true });
    }

    return { mode, topic };
  }

  setStoredContext(chatProfileId, mode, topic = '') {
    const db = getDatabase();
    db.prepare(
      `UPDATE chat_profiles
       SET conversation_mode = ?, context_topic = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(mode, topic || '', chatProfileId);

    // Persist Intensive context timestamp for TTL expiry.
    try {
      const row = db.prepare('SELECT routing_slots FROM chat_profiles WHERE id = ?').get(chatProfileId);
      let slots = {};
      try {
        slots =
          row?.routing_slots && typeof row.routing_slots === 'string'
            ? JSON.parse(row.routing_slots)
            : row?.routing_slots || {};
      } catch {
        slots = {};
      }
      if (!slots || typeof slots !== 'object') slots = {};
      if (mode === CONTEXT_MODES.INTENSIVE) {
        slots._contextSetAt = new Date().toISOString();
      } else {
        delete slots._contextSetAt;
        delete slots.topic;
      }
      db.prepare(
        `UPDATE chat_profiles SET routing_slots = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(JSON.stringify(slots), chatProfileId);
    } catch {
      // non-fatal
    }
  }

  extractTopic(text) {
    const query = knowledgeBaseService.normalizeQuery(text).toLowerCase();
    const words = query
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2);
    return words.slice(0, 6).join(' ') || query.slice(0, 80);
  }

  resolveMode({ chatProfileId, userMessage, guruModeEnabled = false, kbAccess = false }) {
    const question = knowledgeBaseService.normalizeQuery(userMessage);
    const stored = this.getStoredContext(chatProfileId);
    const allHistory = memoryService.buildContextMessages(chatProfileId, 16);
    const previousMode = stored.mode;

    let nextMode = previousMode;
    let switched = false;
    let reason = 'stay';

    if (knowledgeBaseService.isCasualOnly(question)) {
      nextMode = guruModeEnabled ? CONTEXT_MODES.GURU : CONTEXT_MODES.CASUAL;
      if (previousMode !== nextMode) {
        switched = true;
        reason = 'casual_greeting';
      }
    } else if (
      kbAccess &&
      (knowledgeBaseService.shouldUseKnowledgeBase(question, allHistory) ||
        (knowledgeBaseService.isFollowUpMessage(question) &&
          previousMode === CONTEXT_MODES.INTENSIVE))
    ) {
      nextMode = CONTEXT_MODES.INTENSIVE;
      if (previousMode !== CONTEXT_MODES.INTENSIVE) {
        switched = true;
        reason = knowledgeBaseService.isFollowUpMessage(question)
          ? 'intensive_followup'
          : 'intensive_question';
      } else {
        reason = 'intensive_continue';
      }
    } else if (guruModeEnabled) {
      nextMode = CONTEXT_MODES.GURU;
      if (previousMode !== CONTEXT_MODES.GURU) {
        switched = true;
        reason = 'guru_mode';
      }
    } else if (previousMode === CONTEXT_MODES.INTENSIVE) {
      nextMode = CONTEXT_MODES.CASUAL;
      switched = true;
      reason = 'exit_intensive';
    } else {
      nextMode = CONTEXT_MODES.CASUAL;
    }

    const topic =
      nextMode === CONTEXT_MODES.INTENSIVE
        ? this.extractTopic(question) || stored.topic
        : nextMode === CONTEXT_MODES.CASUAL
          ? ''
          : stored.topic;

    if (nextMode !== previousMode || topic !== stored.topic) {
      this.setStoredContext(chatProfileId, nextMode, topic);
    } else if (nextMode === CONTEXT_MODES.INTENSIVE) {
      // Refresh idle TTL while the student stays in Intensive.
      this.setStoredContext(chatProfileId, nextMode, topic);
    }

    conversationSlotsService.updateFromMessage(chatProfileId, question, {
      topic: nextMode === CONTEXT_MODES.INTENSIVE ? topic : null,
      clearTopic: nextMode === CONTEXT_MODES.CASUAL,
    });

    if (switched) {
      logger.info(
        `Context switch profile=${chatProfileId}: ${previousMode} → ${nextMode} (${reason}) topic="${topic || 'none'}"`
      );
    }

    return {
      mode: nextMode,
      topic,
      switched,
      reason,
      previousMode,
    };
  }

  getConversationBoundary(chatProfileId) {
    const db = getDatabase();
    const row = db
      .prepare('SELECT conversation_ended_at FROM chat_profiles WHERE id = ?')
      .get(chatProfileId);
    return row?.conversation_ended_at || null;
  }

  /** Called when the LLM explicitly signals conversation_end:true. */
  markConversationEnded(chatProfileId) {
    const db = getDatabase();
    db.prepare(
      `UPDATE chat_profiles SET conversation_ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(chatProfileId);
  }

  /**
   * Fallback for when the LLM never emits conversation_end:true: if the bot's
   * last reply has gone unanswered for CONVERSATION_IDLE_TIMEOUT_MS, treat the
   * conversation as having ended right at that reply, so the next incoming
   * message starts a fresh conversation boundary instead of being lumped in
   * with a stale thread. Runs lazily whenever context is next built (i.e. when
   * a new message arrives) — no background scheduler needed.
   */
  ensureConversationBoundary(chatProfileId) {
    const lastAssistantMessage = memoryService.getLastMessageByRole(
      chatProfileId,
      MESSAGE_ROLES.ASSISTANT
    );
    if (!lastAssistantMessage) return;

    const lastTs = parseTimestamp(lastAssistantMessage.timestamp);
    if (!lastTs || Date.now() - lastTs.getTime() < CONVERSATION_IDLE_TIMEOUT_MS) return;

    const existingBoundary = this.getConversationBoundary(chatProfileId);
    const existingBoundaryTs = existingBoundary ? parseTimestamp(existingBoundary) : null;
    if (existingBoundaryTs && existingBoundaryTs.getTime() >= lastTs.getTime()) return;

    const db = getDatabase();
    db.prepare('UPDATE chat_profiles SET conversation_ended_at = ? WHERE id = ?').run(
      lastAssistantMessage.timestamp,
      chatProfileId
    );
    logger.info(
      `Conversation idle timeout — profile=${chatProfileId} marked ended at last reply (${Math.round(
        (Date.now() - lastTs.getTime()) / 60000
      )}m unanswered)`
    );
  }

  buildContextWindow(chatProfileId, mode = CONTEXT_MODES.CASUAL, { windowMinutes = 60 } = {}) {
    this.ensureConversationBoundary(chatProfileId);
    const conversationBoundaryTs = this.getConversationBoundary(chatProfileId);
    const allMessages = memoryService.buildTimeWindowedContextMessages(chatProfileId, {
      windowMinutes,
      maxMessages: CONTEXT_TIME_WINDOW_MAX_MESSAGES,
      minMessages: CONTEXT_TIME_WINDOW_MIN_MESSAGES,
      conversationBoundaryTs,
    });
    const window = [];
    let usedChars = 0;

    for (let i = allMessages.length - 1; i >= 0; i -= 1) {
      const msg = allMessages[i];
      const len = msg.content?.length || 0;
      if (usedChars + len > CONTEXT_TIME_WINDOW_MAX_CHARS && window.length > 0) break;
      window.unshift(msg);
      usedChars += len;
    }

    const phoneSummary = userMemoryService.getSummaryContext(chatProfileId);
    const legacySummary = memoryService.getSummaryContext(chatProfileId);
    const summary = phoneSummary || legacySummary;
    const slotsNote = conversationSlotsService.buildContextNote(chatProfileId);
    const userMemoryNote = userMemoryService.buildContextNote(chatProfileId);

    const noteParts = [];
    // Always present, computed fresh at call time — the prompt's greeting/date logic
    // reads this exact value and previously had nothing real to read.
    noteParts.push(`current_date_time: ${currentISTDateTimeForLLM()}`);
    if (userMemoryNote) noteParts.push(userMemoryNote);
    if (slotsNote) noteParts.push(slotsNote);
    // Always inject last conversation-end summary so the next thread can continue usefully.
    if (summary) noteParts.push(summary);
    else if (!slotsNote && !userMemoryNote && mode === CONTEXT_MODES.INTENSIVE) {
      const { topic } = this.getStoredContext(chatProfileId);
      if (topic) {
        noteParts.push(
          `Active topic in this chat: ${topic}. Continue this thread unless the user clearly changes subject.`
        );
      }
    }

    const contextNote = noteParts.join('\n\n');

    return {
      messages: window,
      contextNote,
      messageCount: window.length,
      charCount: usedChars,
    };
  }

  getModeLabel(mode) {
    if (mode === CONTEXT_MODES.INTENSIVE) return 'KB';
    if (mode === CONTEXT_MODES.GURU) return 'Guru';
    return 'Casual chat';
  }
}

module.exports = {
  contextService: new ContextService(),
  CONTEXT_MODES,
};
