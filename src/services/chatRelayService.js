const botManager = require('../bot/botManager');
const chatProfileService = require('./chatProfileService');
const memoryService = require('./memoryService');
const { MESSAGE_ROLES, MESSAGE_SOURCES } = require('../utils/constants');
const { formatUserFacingError } = require('../utils/helpers');
const {
  resolveOutboundChatId,
  resolveOutboundChatIds,
} = require('../utils/outboundChat');
const logger = require('../utils/logger');

class ChatRelayService {
  resolveOutboundChatId(profile) {
    return resolveOutboundChatId(profile);
  }

  resolveOutboundChatIds(profile, inboundChatId = null) {
    return resolveOutboundChatIds(profile, inboundChatId);
  }

  async sendOwnerMessage(botAccountId, chatProfileId, content) {
    const text = (content || '').trim();
    if (!text) {
      throw new Error('Message cannot be empty');
    }
    if (text.length > 4000) {
      throw new Error('Message is too long (max 4000 characters)');
    }

    let profile = chatProfileService.findById(chatProfileId);
    if (!profile) {
      throw new Error('Conversation not found');
    }

    profile =
      chatProfileService.consolidateProfileGroup(profile, profile.owner_phone) ||
      chatProfileService.resolveStorageProfile(profile) ||
      profile;

    const liveBot = botManager.getBot(botAccountId);
    if (!liveBot?.client || !liveBot.isReady) {
      throw new Error('WhatsApp is not connected. Open Connect and link your account.');
    }

    const chatIds = this.resolveOutboundChatIds(profile);
    if (!chatIds.length) {
      throw new Error('Chat is not linked to WhatsApp yet. Sync conversations first.');
    }

    let sent;
    try {
      sent = await liveBot.sendMessage(chatIds, text);
    } catch (error) {
      logger.error(`Dashboard send failed for chat profile ${chatProfileId}: ${error.message}`);
      throw new Error(
        formatUserFacingError(
          error,
          'Could not send on WhatsApp. Check that the chat is synced and your phone is online.'
        )
      );
    }

    const waMessageId = sent?.id?._serialized || sent?.id?.id || null;

    // Link imported pseudo-chats without merging (avoids slow DB consolidation on send).
    if (String(profile.chat_id || '').endsWith('@manual.import') && profile.contact_phone) {
      const linked = chatProfileService.findLinkedContactProfile(profile.owner_phone, {
        contactPhone: profile.contact_phone,
        chatId: chatIds[0],
      });
      if (linked && linked.id !== profile.id) {
        profile = linked;
      }
    }

    const message = memoryService.addMessage(profile.id, MESSAGE_ROLES.OWNER, text, {
      source: MESSAGE_SOURCES.WEB,
      waMessageId,
    });

    logger.info(`Dashboard sent message to chat profile ${profile.id}`);
    return { message, chat: profile };
  }
}

module.exports = new ChatRelayService();
