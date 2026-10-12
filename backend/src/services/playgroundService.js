const chatService = require('./chatService');
const chatProfileService = require('./chatProfileService');
const memoryService = require('./memoryService');
const userService = require('./userService');
const { botAccountService } = require('./botAccountService');
const { sanitizeUserReply, isConversationEndControlBody } = require('../ai/replyRules');
const { runWithBot } = require('../utils/botContext');
const { MESSAGE_ROLES, MESSAGE_SOURCES } = require('../utils/constants');

const MAX_MESSAGE_CHARS = 2000;

/**
 * Bot testing playground: runs the same reply pipeline as a WhatsApp message
 * (prompt, KB retrieval, memory) but never sends anything. Sessions live in
 * `@pulse.test` chat profiles, which the inbox and CTA creation ignore.
 */
class PlaygroundService {
  sessionChatId(bot, userId, sessionId) {
    const safe = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'default';
    return `playground-${bot.id}-${userId}-${safe}@pulse.test`;
  }

  getProfile(bot, userId, sessionId) {
    const ownerPhone = botAccountService.getPhone(bot);
    const chatId = this.sessionChatId(bot, userId, sessionId);
    return (
      chatProfileService.findByChatIdForOwner(chatId, ownerPhone) ||
      chatProfileService.getOrCreate({
        chatId,
        ownerPhone,
        contactName: `Playground ${String(sessionId || 'default').slice(0, 40)}`,
        contactPhone: null,
        chatType: 'contact',
      })
    );
  }

  history(bot, userId, sessionId) {
    const profile = this.getProfile(bot, userId, sessionId);
    return memoryService.getMessages(profile.id, 100);
  }

  /** `draftPrompt` answers with an unpublished prompt instead of the live one. */
  async send(bot, userId, { sessionId, message, draftPrompt = null }) {
    const text = String(message || '').trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text) throw new Error('Type a message to test');
    if (!botAccountService.getPhone(bot)) throw new Error('This bot has no WhatsApp number yet');

    const profile = this.getProfile(bot, userId, sessionId);
    const owner = userService.getOrCreate(botAccountService.getPhone(bot), null);
    memoryService.addMessage(profile.id, MESSAGE_ROLES.USER, text, { source: 'playground' });

    const overrides = draftPrompt && String(draftPrompt).trim() ? { system_prompt: String(draftPrompt) } : null;
    const result = await runWithBot(
      bot.id,
      () =>
        chatService.generateResponse(owner.id, profile.id, text, false, bot.id, {
          historyExcludeTrailingUserCount: 1,
        }),
      { overrides }
    );

    const raw = typeof result === 'object' && result ? result.reply : result;
    const kbMeta = typeof result === 'object' && result ? result.kbMeta || null : null;
    const ended = Boolean(result?.conversationEnd) || isConversationEndControlBody(raw);
    const reply = ended ? '' : sanitizeUserReply(String(raw || '').trim(), text);

    if (reply) {
      memoryService.addMessage(profile.id, MESSAGE_ROLES.ASSISTANT, reply, {
        source: MESSAGE_SOURCES.ASSISTANT,
        kbMeta,
      });
    }

    return {
      reply,
      conversationEnded: ended,
      usedDraft: Boolean(overrides),
      knowledge: {
        mode: kbMeta?.mode || null,
        hitCount: kbMeta?.hitCount || 0,
        chunks: (kbMeta?.chunks || []).slice(0, 5).map((chunk) => ({
          questionId: chunk.questionId || null,
          text: String(chunk.preview || chunk.text || '').slice(0, 300),
          score: chunk.score ?? null,
        })),
      },
    };
  }
}

module.exports = { playgroundService: new PlaygroundService() };
