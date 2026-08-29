const helpCommand = require('../commands/help');
const pingCommand = require('../commands/ping');
const resetCommand = require('../commands/reset');
const summaryCommand = require('../commands/summary');
const noteCommand = require('../commands/note');
const notesCommand = require('../commands/notes');
const remindCommand = require('../commands/remind');
const modelCommand = require('../commands/model');
const tokensCommand = require('../commands/tokens');
const profileCommand = require('../commands/profile');
const meCommand = require('../commands/me');
const contactsCommand = require('../commands/contacts');
const assistantCommand = require('../commands/assistant');
const { executePendingSelection } = require('../commands/assistant');
const contactSelectionService = require('../services/contactSelectionService');
const userService = require('../services/userService');
const chatProfileService = require('../services/chatProfileService');
const chatService = require('../services/chatService');
const knowledgeBaseService = require('../services/knowledgeBaseService');
const logger = require('../utils/logger');
const { isRecoverableBrowserError } = require('../utils/chromiumProfile');
const { actionItemService, ACTION_SOURCES } = require('../services/actionItemService');
const { botAccountService } = require('../services/botAccountService');
const botConfigService = require('../services/botConfigService');
const { dashboardAlertService } = require('../services/dashboardAlertService');
const memoryService = require('../services/memoryService');
const { contextService } = require('../services/contextService');
const { userMemoryService } = require('../services/userMemoryService');
const { inboundMessageBatcher, BATCH_WINDOW_MS } = require('../services/inboundMessageBatcher');
const escalationService = require('../services/escalationService');
const scopeFirewallService = require('../services/scopeFirewallService');
const { tokenUsageService } = require('../services/tokenUsageService');
const { resolveOutboundChatIds } = require('../utils/outboundChat');
const { COMMANDS, ERROR_REPLY_COOLDOWN_MS, MESSAGE_ROLES, MESSAGE_SOURCES } = require('../utils/constants');
const { sanitizeUserReply, applyFirewallPostReply, isConversationEndControlBody, parseStructuredReply } = require('../ai/replyRules');
const { splitReplyIntoChunks } = require('../ai/messageSplitter');
const {
  extractCommand,
  isPrivateChat,
  isBaseIgnorableMessage,
  getReplyChatId,
  normalizeChatId,
  normalizePhone,
  sleep,
} = require('../utils/helpers');

const ERROR_REPLY_TEXT = "Oops, something glitched on my end — try sending that again?";

function unwrapChatResponse(result) {
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'reply')) {
    return {
      text: result.reply,
      kbMeta: result.kbMeta || null,
      conversationEnd: Boolean(result.conversationEnd),
      conversationSummary: result.conversationSummary || null,
      userPreferences: result.userPreferences || null,
    };
  }
  return {
    text: result,
    kbMeta: null,
    conversationEnd: false,
    conversationSummary: null,
    userPreferences: null,
  };
}

function persistConversationEndMemory(chatProfile, { conversationSummary, userPreferences } = {}) {
  if (!chatProfile?.id) return;

  contextService.markConversationEnded(chatProfile.id);

  if (typeof conversationSummary === 'string' && conversationSummary.trim()) {
    try {
      // Keep legacy profile-scoped summaries + durable phone-keyed summary.
      memoryService.addSummary(chatProfile.id, conversationSummary.trim());
      userMemoryService.saveConversationSummary(chatProfile, conversationSummary.trim());
    } catch (error) {
      logger.error(
        `Failed to store conversation summary for profile ${chatProfile.id}: ${error.message}`
      );
    }
  }

  if (userPreferences && typeof userPreferences === 'object' && !Array.isArray(userPreferences)) {
    try {
      userMemoryService.mergeAndSave(chatProfile, userPreferences);
    } catch (error) {
      logger.error(
        `Failed to merge user preferences for profile ${chatProfile.id}: ${error.message}`
      );
    }
  }
}

class MessageHandler {
  constructor(whatsappClient) {
    this.whatsapp = whatsappClient;
    this.errorReplyCooldown = new Map();
  }

  recordAction(context, { source, title, description = '' }) {
    const botAccountId = this.whatsapp?.botAccountId;
    if (!botAccountId) return;
    actionItemService.create({
      botAccountId,
      chatProfileId: context.chatProfile?.id || null,
      source,
      title,
      description,
    });
  }

  canSendErrorReply(chatId) {
    if (!chatId) return false;

    const lastSent = this.errorReplyCooldown.get(chatId) || 0;
    const now = Date.now();

    if (now - lastSent < ERROR_REPLY_COOLDOWN_MS) {
      logger.info(`Error reply suppressed for ${chatId} (cooldown active)`);
      return false;
    }

    this.errorReplyCooldown.set(chatId, now);
    return true;
  }

  isBotGeneratedBody(body) {
    if (!body) return false;
    const text = body.trim();
    if (isConversationEndControlBody(text)) return true;
    return (
      text.startsWith('Sorry, something went wrong') ||
      text === 'Pong 🟢' ||
      text.startsWith('*WhatsApp AI Assistant') ||
      text.startsWith('*Your Notes*') ||
      text.startsWith('*Conversation Summary') ||
      text.startsWith('*Chat Profile*') ||
      text.startsWith('*Assistant*') ||
      text.startsWith('*Personal Chats*') ||
      text.startsWith('Profile updated') ||
      text.startsWith('Assistant paused') ||
      text.startsWith('Assistant is now') ||
      text.startsWith('Assistant enabled') ||
      text.startsWith('Assistant disabled') ||
      text.startsWith('Self-chat assistant OFF') ||
      text.startsWith('*Assistant Status*') ||
      text.startsWith('*Assistant Controls*') ||
      text.startsWith('All contact assistants') ||
      text.startsWith('Global contacts') ||
      text.startsWith('Assistant pinned') ||
      text.startsWith('*Select contact') ||
      text.startsWith('*Token Usage') ||
      text.startsWith('*Token usage') ||
      text.includes('Assistant is always active in self-chat') ||
      text.includes('is for contact chats only') ||
      text.includes('This command is only available in *Message Yourself*') ||
      text.startsWith('No chat found matching') ||
      text.startsWith('Hey! I\'m here') ||
      text.startsWith('Hey, what\'s up?') ||
      text.startsWith('Hey! I\'m good') ||
      text.startsWith('⏰ *Reminder*')
    );
  }

  isRecentBotReply(body) {
    if (!body || !this.whatsapp.recentBotReplyBodies) return false;
    const text = body.trim();
    if (!text) return false;

    if (this.whatsapp.recentBotReplyBodies.has(text)) return true;
    if (this.whatsapp.recentBotReplyBodies.has(text.slice(0, 120))) return true;
    if (this.whatsapp.recentBotReplyBodies.has(text.slice(0, 300))) return true;
    return false;
  }

  isInboundBotEcho(message, body) {
    const messageId = message.id?._serialized || message.id?.id;
    if (messageId && this.whatsapp.botSentMessageIds?.has(messageId)) {
      return true;
    }
    // Exact body match only — avoid dropping real user messages that share words with a bot reply.
    return this.isRecentBotReply(body);
  }

  isSelfChatContext(context) {
    return context.isSelfChat || context.chatProfile?.chat_type === 'self';
  }

  isAllowedWhenDisabled(body, context) {
    if (!this.isSelfChatContext(context)) {
      return false;
    }

    if (extractCommand(body)) return true;

    if (
      contactSelectionService.hasPending(context.owner.id) &&
      contactSelectionService.isNumericSelection(body)
    ) {
      return true;
    }
    return this.isAssistantToggleText(body, context);
  }

  isAssistantToggleText(body, context) {
    if (!this.isSelfChatContext(context) || !body) return false;
    const text = body.trim().toLowerCase();
    return /^(assistant\s+)?(self|me|contacts?)\s+(on|off)$/i.test(text);
  }

  parseAssistantToggleText(body) {
    const match = body.trim().match(/^(?:assistant\s+)?(self|me|contacts?)\s+(on|off)$/i);
    if (!match) return null;
    const target = match[1].toLowerCase();
    const mode = match[2].toLowerCase();
    if (target === 'me') return `self ${mode}`;
    if (target === 'contact') return `contacts ${mode}`;
    return `${target} ${mode}`;
  }

  isAssistantAllowed(context) {
    const freshOwner = userService.findById(context.owner.id) || context.owner;

    if (this.isSelfChatContext(context)) {
      return userService.isAssistantSelfEnabled(freshOwner);
    }

    const freshProfile =
      chatProfileService.findById(context.chatProfile.id) || context.chatProfile;
    return chatProfileService.isAssistantActive(freshProfile, freshOwner);
  }

  maybeAutoEnableContactAssistant(context) {
    let profile = context.chatProfile;
    if (!profile || profile.chat_type !== 'contact') return profile;

    profile = chatProfileService.inheritAssistantFromSiblings(profile);
    if (profile.id !== context.chatProfile.id) {
      context.chatProfile = profile;
    }
    // Respect manual per-contact toggle state. Global contacts ON should not
    // auto-enable a contact that was explicitly turned OFF from the dashboard.
    return profile;
  }

  getMyWhatsAppId() {
    return this.whatsapp.myWhatsAppId || this.whatsapp.client?.info?.wid?._serialized || null;
  }

  async isSelfChatMessage(message, chat) {
    const myWhatsAppId = this.getMyWhatsAppId();
    const chatId = chat?.id?._serialized;

    if (this.whatsapp.selfChatId && chatId === this.whatsapp.selfChatId) {
      return true;
    }

    if (chatId) {
      const ownerPhone = normalizePhone(myWhatsAppId);
      const existing = ownerPhone
        ? chatProfileService.findByChatIdForOwner(chatId, ownerPhone)
        : chatProfileService.findByChatId(chatId);
      if (existing?.chat_type === 'self') {
        this.whatsapp.selfChatId = chatId;
        return true;
      }
    }

    if (myWhatsAppId && chatId === myWhatsAppId) {
      this.whatsapp.selfChatId = chatId;
      return true;
    }

    if (myWhatsAppId && chatId && normalizePhone(chatId) === normalizePhone(myWhatsAppId)) {
      this.whatsapp.selfChatId = chatId;
      return true;
    }

    if (
      message.fromMe &&
      normalizeChatId(message.from) &&
      normalizeChatId(message.from) === normalizeChatId(message.to) &&
      String(normalizeChatId(message.from)).includes('@lid')
    ) {
      if (chatId) this.whatsapp.selfChatId = chatId;
      return true;
    }

    if (
      normalizeChatId(message.from) &&
      normalizeChatId(message.from) === normalizeChatId(message.to) &&
      (String(chat?.name || '').toLowerCase().includes('message yourself') ||
        String(chat?.name || '').toLowerCase() === 'you')
    ) {
      if (chatId) this.whatsapp.selfChatId = chatId;
      return true;
    }

    try {
      const contact = await chat.getContact();
      if (contact?.isMe) {
        if (chatId) this.whatsapp.selfChatId = chatId;
        return true;
      }
    } catch (error) {
      logger.warn(`chat.getContact failed: ${error.message}`);
    }

    return false;
  }

  async resolveChatContext(message, chat, replyChatId, isSelfChat = false) {
    const myWhatsAppId = this.getMyWhatsAppId();
    const ownerPhone = normalizePhone(myWhatsAppId);
    const chatId = chat?.id?._serialized;

    const owner = userService.getOrCreate(myWhatsAppId, null);

    let chatProfile = chatId ? chatProfileService.findByChatIdForOwner(chatId, ownerPhone) : null;

    if (!chatProfile) {
      chatProfile = await chatProfileService.enrichFromWhatsAppChat(
        chat,
        ownerPhone,
        isSelfChat,
        this.whatsapp.client,
        null,
        { skipPuppeteer: true, fastPath: true }
      );
    }

    if (!isSelfChat && chatProfile) {
      chatProfile = await chatProfileService.relinkProfileForMessage(
        chat,
        ownerPhone,
        chatProfile,
        this.whatsapp.client
      );

      const chatDisplayName = (chat?.name || '').trim();
      const linked = chatProfileService.findLinkedContactProfile(ownerPhone, {
        contactPhone: chatProfileService.effectiveContactPhone(chatProfile),
        contactName: chatProfile.contact_name || chatDisplayName || null,
        chatId: chat?.id?._serialized || chatProfile.chat_id,
      });

      if (linked && linked.id !== chatProfile.id) {
        if (chatId && linked.chat_id !== chatId) {
          chatProfile = chatProfileService.updateChatId(linked.id, chatId, ownerPhone) || linked;
        } else {
          chatProfile = linked;
        }
      }

      chatProfile = await chatProfileService.linkImportedContactProfile(
        chatProfile,
        ownerPhone,
        { chat, client: this.whatsapp.client }
      );

      chatProfile = chatProfileService.inheritAssistantFromSiblings(chatProfile);
    }

    const isSelf =
      isSelfChat || chatProfile?.chat_type === 'self';

    if (isSelf && chatProfile && chatProfile.chat_type !== 'self') {
      chatProfile = chatProfileService.promoteToSelfChat(chatProfile.id);
    }

    return {
      owner,
      chatProfile,
      isSelfChat: isSelf,
      whatsappChatId: chatId || replyChatId,
    };
  }

  isSelfChatLidEcho(message, isSelfChat) {
    if (!isSelfChat || !message.fromMe) return false;

    const from = normalizeChatId(message.from);
    const to = normalizeChatId(message.to);
    if (!from || from !== to || !from.includes('@lid')) return false;

    const body = message.body?.trim() || '';
    if (extractCommand(body)) return false;

    // WhatsApp mirrors bot replies in self-chat via @lid; only skip those echoes.
    return this.isRecentBotReply(body) || this.isBotGeneratedBody(body);
  }

  async handleMessage(message) {
    let replyChatId = null;

    try {
      if (isBaseIgnorableMessage(message)) {
        logger.info(
          `Ignored message (filtered): type=${message.type}, from=${message.from}, to=${message.to}`
        );
        return;
      }

      let chat;
      try {
        chat = await message.getChat();
      } catch (error) {
        // WhatsApp Web store sometimes throws opaque page errors (e.g. "r") for @lid chats.
        // Keep processing with a minimal chat stub so contacts still get AI replies.
        const fallbackId =
          (message.fromMe ? message.to || message.from : message.from) || null;
        logger.warn(
          `Could not load chat for inbound message: ${error.message}${
            fallbackId ? ` — using fallback ${fallbackId}` : ''
          }`
        );
        if (!fallbackId) {
          throw error;
        }
        const client = this.whatsapp.client;
        chat = {
          id: { _serialized: fallbackId },
          isGroup: String(fallbackId).endsWith('@g.us'),
          isChannel: String(fallbackId).endsWith('@newsletter'),
          name: null,
          async getContact() {
            if (client?.getContactById) {
              try {
                return await client.getContactById(fallbackId);
              } catch (_err) {
                return null;
              }
            }
            return null;
          },
        };
      }

      replyChatId = getReplyChatId(message, chat);
      const isSelfChat = await this.isSelfChatMessage(message, chat);

      if (!isPrivateChat(chat) || isBaseIgnorableMessage(message)) {
        return;
      }

      if (!isPrivateChat(chat) || isBaseIgnorableMessage(message)) {
        logger.info(
          `Ignored message (not private): chat=${chat?.id?._serialized}, isGroup=${Boolean(chat?.isGroup)}, isChannel=${Boolean(chat?.isChannel)}`
        );
        return;
      }

      const context = await this.resolveChatContext(message, chat, replyChatId, isSelfChat);
      replyChatId = context.whatsappChatId || replyChatId;

      // Do NOT run full-owner duplicate consolidation on every inbound message —
      // with large contact lists it blocks the Node event loop and freezes the UI.
      if (isSelfChat && context.chatProfile && context.chatProfile.chat_type !== 'self') {
        context.chatProfile = chatProfileService.promoteToSelfChat(context.chatProfile.id);
      }

      const body = message.body?.trim();
      const messageId = message.id?._serialized || message.id?.id;
      const isSelf = this.isSelfChatContext(context);
      const parsedCommand = body && isSelf ? extractCommand(body) : null;

      // Control signal from prompt — never store, never reply, never loop in self-chat.
      if (body && isConversationEndControlBody(body)) {
        logger.info(
          `Ignored conversation_end control JSON (profile ${context.chatProfile?.id}, self=${isSelf}, fromMe=${Boolean(message.fromMe)})`
        );
        return;
      }

      if (message.fromMe && !isSelf && body && extractCommand(body)) {
        logger.info('Ignored command mirror in contact chat');
        return;
      }

      if (message.fromMe) {
        const isBotEcho =
          (messageId && this.whatsapp.botSentMessageIds?.has(messageId)) ||
          this.isBotGeneratedBody(message.body) ||
          (!isSelfChat && this.isRecentBotReply(message.body)) ||
          (isSelfChat && this.isSelfChatLidEcho(message, isSelfChat));

        if (isBotEcho) {
          logger.info('Ignored bot echo message');
          return;
        }

        if (!isSelfChat) {
          if (body) {
            memoryService.addMessage(context.chatProfile.id, MESSAGE_ROLES.OWNER, body, {
              source: MESSAGE_SOURCES.WHATSAPP,
              waMessageId: messageId,
            });
          }
          logger.info(`Stored owner WhatsApp message for ${chat?.id?._serialized}`);
          return;
        }

        if (isSelfChat && body && !message.hasMedia && !parsedCommand) {
          memoryService.addMessage(context.chatProfile.id, MESSAGE_ROLES.USER, body, {
            source: MESSAGE_SOURCES.WHATSAPP,
            waMessageId: messageId,
          });
        }
      } else if (!message.fromMe && message.hasMedia && context.chatProfile?.chat_type === 'contact') {
        const rawCaption =
          message.body?.trim() ||
          message._data?.caption?.trim() ||
          message._data?.body?.trim() ||
          '';
        const caption = knowledgeBaseService.sanitizeMediaCaption(rawCaption);
        const mediaContent = chatService.buildGenericMediaUserContent({
          mediaType: message.type || 'media',
          filename: message._data?.filename || null,
          mimetype: null,
          caption,
        });
        const storedInbound = memoryService.addMessage(
          context.chatProfile.id,
          MESSAGE_ROLES.USER,
          mediaContent,
          {
            source: MESSAGE_SOURCES.WHATSAPP,
            waMessageId: messageId,
          }
        );
        this.maybeAutoEnableContactAssistant(context);
        context.lastInboundMessageId = storedInbound?.id || null;
        context.lastInboundEscalationContent = mediaContent;
        context.lastInboundMediaType = message.type || 'media';
        context.mediaAlreadyPersisted = true;
      } else if (body && !message.hasMedia) {
        if (this.isInboundBotEcho(message, body) || this.isBotGeneratedBody(body)) {
          logger.info('Ignored inbound bot reply echo');
          return;
        }
        const storedInbound = memoryService.addMessage(context.chatProfile.id, MESSAGE_ROLES.USER, body, {
          source: MESSAGE_SOURCES.WHATSAPP,
          waMessageId: messageId,
        });
        this.maybeAutoEnableContactAssistant(context);
        context.lastInboundMessageId = storedInbound?.id || null;
        context.lastInboundEscalationContent = body;
      }

      const assistantAllowed = this.isAssistantAllowed(context);

      let escalationResult = null;
      if (
        !message.fromMe &&
        !parsedCommand &&
        context.chatProfile?.chat_type === 'contact' &&
        (body || message.hasMedia)
      ) {
        const escalationContent =
          context.lastInboundEscalationContent ||
          body ||
          escalationService.buildMediaEscalationContent({
            mediaType: message.type || 'media',
            caption: body || '',
          });
        escalationResult = await escalationService.processInbound({
          chatProfileId: context.chatProfile.id,
          content: escalationContent,
          botAccountId: this.whatsapp.botAccountId,
          triggerMessageId: context.lastInboundMessageId || null,
          hasMedia: Boolean(message.hasMedia),
          mediaType: context.lastInboundMediaType || message.type || null,
          forceMediaOrLink: Boolean(message.hasMedia) || escalationService.containsUrl(escalationContent),
        });
      }

      if (
        !assistantAllowed &&
        (body || message.hasMedia) &&
        !escalationResult?.autoReply &&
        !this.isAllowedWhenDisabled(body, context)
      ) {
        logger.info(
          `Assistant disabled for chat profile ${context.chatProfile.id} (active=${context.chatProfile.assistant_active}, pinned=${context.chatProfile.assistant_pinned_on}, global=${userService.isAssistantContactsEnabled(context.owner)}) — ignoring message`
        );
        return;
      }

      logger.info(
        `Chat context: profile=${context.chatProfile.id}, contact=${context.chatProfile.contact_name || 'unknown'}, type=${context.chatProfile.chat_type}, allowed=${assistantAllowed}, replyTo=${replyChatId}, fromMe=${message.fromMe}, body="${(body || '').slice(0, 50)}"`
      );

      if (
        !message.fromMe
        && assistantAllowed
        && context.chatProfile?.chat_type === 'contact'
        && !parsedCommand
      ) {
        const botAccountId = this.getBotAccountId();
        const apiKey = botAccountId
          ? botConfigService.resolveApiKeyForBotAccountId(botAccountId)
          : null;
        if (!apiKey) {
          dashboardAlertService.notifyNoApiKeyInbound({
            botAccountId,
            chatProfileId: context.chatProfile.id,
            contactName: context.chatProfile.contact_name,
            messagePreview: body || (message.hasMedia ? `[${message.type || 'media'}]` : ''),
          });
          logger.info(
            `No API key for bot ${botAccountId} — inbound stored, no WhatsApp reply (profile ${context.chatProfile.id})`
          );
          return;
        }
      }

      let firewallRedirect = null;
      if (
        !message.fromMe
        && assistantAllowed
        && context.chatProfile?.chat_type === 'contact'
        && body
        && !message.hasMedia
        && !parsedCommand
        && !escalationResult?.autoReply
      ) {
        const botAccountId = this.getBotAccountId();
        const apiKey = botAccountId
          ? botConfigService.resolveApiKeyForBotAccountId(botAccountId)
          : null;
        const firewallResult = await scopeFirewallService.evaluate({
          message: body,
          botAccountId,
          chatProfileId: context.chatProfile.id,
          ownerUserId: context.owner.id,
          apiKey,
        });

        if (firewallResult && !firewallResult.allowed) {
          tokenUsageService.recordBlocked({
            chatProfileId: context.chatProfile.id,
            ownerUserId: context.owner.id,
            tier: firewallResult.tier,
            reason: firewallResult.reason,
          });

          if (firewallResult.mode === 'silent') {
            dashboardAlertService.notifyFirewallBlocked({
              botAccountId,
              chatProfileId: context.chatProfile.id,
              contactName: context.chatProfile.contact_name,
              messagePreview: body,
              reason: firewallResult.reason,
            });
            logger.info(
              `Firewall blocked (silent) profile=${context.chatProfile.id} tier=${firewallResult.tier} reason=${firewallResult.reason}`
            );
            return;
          }

          firewallRedirect = firewallResult.redirectMessage;
          logger.info(
            `Firewall blocked (redirect) profile=${context.chatProfile.id} tier=${firewallResult.tier}`
          );
        }
      }

      let response;
      let responseKbMeta = null;
      let responseSource = MESSAGE_SOURCES.ASSISTANT;
      let conversationEndDetected = false;
      let conversationSummary = null;
      let userPreferences = null;

      const shouldBatchAi =
        assistantAllowed &&
        !parsedCommand &&
        !escalationResult?.autoReply &&
        !firewallRedirect &&
        context.chatProfile?.chat_type === 'contact' &&
        !this.isSelfChatContext(context) &&
        (Boolean(body) || Boolean(message.hasMedia));

      if (shouldBatchAi) {
        const fragment = message.hasMedia
          ? await this.resolveMediaFragmentForBatch(message, context)
          : body;

        if (fragment && String(fragment).trim()) {
          this.queueContactAiReply({
            context,
            replyChatId,
            fragment: String(fragment).trim(),
          });
          return;
        }
      }

      if (message.hasMedia) {
        if (!assistantAllowed) return;
        const mediaResult = await this.handleMediaMessage(message, context);
        const unwrapped = unwrapChatResponse(mediaResult);
        response = unwrapped.text;
        responseKbMeta = unwrapped.kbMeta;
      } else {
        if (!body) {
          logger.info(`Skipped empty message body: type=${message.type}`);
          return;
        }

        if (escalationResult?.autoReply) {
          response = escalationResult.autoReply;
          responseSource = MESSAGE_SOURCES.ESCALATION;
        } else if (firewallRedirect) {
          response = firewallRedirect;
          responseSource = MESSAGE_SOURCES.FIREWALL;
        } else {
          const textResult = await this.handleTextMessage(body, context);
          const unwrapped = unwrapChatResponse(textResult);
          response = unwrapped.text;
          responseKbMeta = unwrapped.kbMeta;
          conversationEndDetected = Boolean(unwrapped.conversationEnd);
          conversationSummary = unwrapped.conversationSummary || null;
          userPreferences = unwrapped.userPreferences || null;
          if (parsedCommand) {
            responseSource = MESSAGE_SOURCES.COMMAND;
          }
        }
      }

      if (conversationEndDetected || isConversationEndControlBody(response)) {
        // If end was only detected from raw control body, recover summary/prefs from it.
        if ((!conversationSummary || !userPreferences) && isConversationEndControlBody(response)) {
          const recovered = parseStructuredReply(String(response || ''));
          conversationSummary = conversationSummary || recovered.conversationSummary || null;
          userPreferences = userPreferences || recovered.userPreferences || null;
        }
        persistConversationEndMemory(context.chatProfile, {
          conversationSummary,
          userPreferences,
        });
        logger.info(
          `Conversation end detected for profile ${context.chatProfile.id} — saved memory and suppressing this turn reply`
        );
        return;
      }

      if (
        assistantAllowed &&
        (!response || !String(response).trim()) &&
        responseSource !== MESSAGE_SOURCES.COMMAND &&
        responseKbMeta?.mode !== 'no_api_key'
      ) {
        logger.warn(`Empty AI response for chat profile ${context.chatProfile.id}, sending soft fallback`);
        response = message.hasMedia
          ? "Got it — I've received your file. How can I help with it?"
          : "Hey! I'm here — what can I help you with today?";
        responseKbMeta = null;
      }

      if (response && String(response).trim()) {
        const botAccountId = this.getBotAccountId();
        const firewallConfig = scopeFirewallService.getConfigForBot(botAccountId);
        let outgoing = sanitizeUserReply(String(response).trim(), body || '');
        if (isConversationEndControlBody(outgoing)) {
          logger.info(
            `Blocked conversation_end JSON from being sent (profile ${context.chatProfile.id})`
          );
          return;
        }
        if (firewallConfig.enabled && responseSource === MESSAGE_SOURCES.ASSISTANT) {
          outgoing = applyFirewallPostReply(outgoing, {
            mode: firewallConfig.mode,
            redirectMessage: firewallConfig.redirectMessage,
          });
          if (!outgoing && firewallConfig.mode === 'silent') {
            logger.info(`Post-reply firewall dropped response for profile ${context.chatProfile.id}`);
            return;
          }
        }
        if (!outgoing || !String(outgoing).trim()) {
          logger.warn(`No reply after post-processing for profile ${context.chatProfile.id}`);
          return;
        }
        if (this.whatsapp.recentBotReplyBodies) {
          this.whatsapp.recentBotReplyBodies.add(outgoing.slice(0, 120));
          this.whatsapp.recentBotReplyBodies.add(outgoing.slice(0, 300));
        }
        const outboundChatIds = resolveOutboundChatIds(context.chatProfile, replyChatId);
        const skipReplyDelay = responseSource === MESSAGE_SOURCES.COMMAND;
        if (!skipReplyDelay && this.whatsapp.botAccountId) {
          const delaySec = botAccountService.resolveReplyDelaySeconds(this.whatsapp.botAccountId);
          if (delaySec > 0) {
            await this.whatsapp.waitBeforeReply(outboundChatIds, delaySec);
          }
        }
        const outgoingChunks = splitReplyIntoChunks(outgoing);
        for (let i = 0; i < outgoingChunks.length; i += 1) {
          if (i > 0) {
            const primary = outboundChatIds[0];
            if (primary) this.whatsapp.sendTypingState(primary).catch(() => {});
            await sleep(800 + Math.random() * 1200);
          }
          await this.whatsapp.sendMessage(outboundChatIds, outgoingChunks[i]);
        }
        memoryService.addMessage(context.chatProfile.id, MESSAGE_ROLES.ASSISTANT, outgoing, {
          source: responseSource,
          kbMeta: responseKbMeta,
        });
        logger.info(
          `Outgoing message to chat ${outboundChatIds[0]} (profile ${context.chatProfile.id})`
        );
      } else if (assistantAllowed) {
        logger.warn(`No reply generated for enabled chat profile ${context.chatProfile.id}`);
      }
    } catch (error) {
      logger.error(`Message handling error: ${error.message}`, { stack: error.stack });

      if (isRecoverableBrowserError(error)) {
        return;
      }

      const fallbackChatId = replyChatId || message.from;
      if (!this.canSendErrorReply(fallbackChatId)) {
        return;
      }

      // Media failures should never hit the "glitched" reply — acknowledge via prompt.
      if (message?.hasMedia) {
        try {
          const mediaType = message.type || 'file';
          const caption = message.body?.trim() || '';
          const contextPhone = normalizePhone(
            this.whatsapp.myWhatsAppId || message.to || message.from
          );
          let owner = contextPhone ? userService.findByPhone(contextPhone) : null;
          if (!owner && this.whatsapp.myWhatsAppId) {
            owner = userService.getOrCreate(this.whatsapp.myWhatsAppId, null);
          }
          const chatId =
            fallbackChatId ||
            (message.fromMe ? message.to : message.from) ||
            null;
          const profile =
            chatId && owner
              ? chatProfileService.findByChatIdForOwner(chatId, owner.phone) ||
                chatProfileService.getOrCreate({
                  chatId,
                  ownerPhone: owner.phone,
                  chatType: 'contact',
                })
              : null;

          if (owner && profile) {
            const soft = await chatService.handleGenericMediaMessage(
              owner.id,
              profile.id,
              {
                mediaType,
                filename: message._data?.filename || null,
                mimetype: null,
                caption:
                  caption ||
                  `Student shared a ${mediaType}. Acknowledge briefly and ask how you can help.`,
              },
              this.getBotAccountId()
            );
            const unwrapped = unwrapChatResponse(soft);
            const outgoing = sanitizeUserReply(String(unwrapped.text || '').trim(), caption);
            if (outgoing) {
              await this.whatsapp.sendMessage(fallbackChatId, outgoing);
              memoryService.addMessage(profile.id, MESSAGE_ROLES.ASSISTANT, outgoing, {
                source: MESSAGE_SOURCES.ASSISTANT,
                kbMeta: unwrapped.kbMeta,
              });
              return;
            }
          }
        } catch (mediaFallbackError) {
          logger.warn(`Media prompt fallback failed: ${mediaFallbackError.message}`);
        }
        return;
      }

      try {
        await this.whatsapp.sendMessage(fallbackChatId, ERROR_REPLY_TEXT);
      } catch (sendError) {
        logger.error(`Failed to send error reply: ${sendError.message}`);
      }
    }
  }

  getBotAccountId() {
    return this.whatsapp?.botAccountId || null;
  }

  queueContactAiReply({ context, replyChatId, fragment }) {
    const chatProfileId = context.chatProfile?.id;
    const botAccountId = this.getBotAccountId();
    if (!chatProfileId || !fragment) return;

    const key = `${botAccountId || 'bot'}:${chatProfileId}`;
    const outboundChatIds = resolveOutboundChatIds(context.chatProfile, replyChatId);
    const windowMs = botAccountId
      ? botAccountService.resolveBatchDelaySeconds(botAccountId) * 1000
      : null;

    inboundMessageBatcher.enqueue({
      key,
      fragment,
      windowMs,
      onQueued: () => {
        const primary = outboundChatIds[0];
        if (primary) {
          this.whatsapp.sendTypingState(primary).catch(() => {});
        }
      },
      onFlush: async ({ combined, fragments, partCount }) => {
        logger.info(
          `Flushing inbound batch profile=${chatProfileId} parts=${partCount} windowMs=${windowMs || BATCH_WINDOW_MS}`
        );
        await this.flushContactAiBatch({
          context,
          replyChatId,
          outboundChatIds,
          combined,
          fragments,
          partCount,
        });
      },
    });
  }

  async flushContactAiBatch({
    context,
    replyChatId,
    outboundChatIds,
    combined,
    fragments,
    partCount = 1,
  }) {
    const botAccountId = this.getBotAccountId();
    try {
      const result = await chatService.generateResponse(
        context.owner.id,
        context.chatProfile.id,
        combined,
        false,
        botAccountId,
        {
          historyExcludeTrailingUserCount: Math.max(1, Number(partCount) || 1),
          messageFragments: fragments,
        }
      );
      const unwrapped = unwrapChatResponse(result);
      let response = unwrapped.text;
      let responseKbMeta = unwrapped.kbMeta;
      const conversationEndDetected = Boolean(unwrapped.conversationEnd);

      if (conversationEndDetected || isConversationEndControlBody(response)) {
        const recovered = parseStructuredReply(String(response || ''));
        persistConversationEndMemory(context.chatProfile, {
          conversationSummary:
            unwrapped.conversationSummary || recovered.conversationSummary || null,
          userPreferences: unwrapped.userPreferences || recovered.userPreferences || null,
        });
        logger.info(
          `Conversation end detected for profile ${context.chatProfile.id} — batch suppressed`
        );
        return;
      }

      if (!response || !String(response).trim()) {
        response = "Hey! I'm here — what can I help you with today?";
        responseKbMeta = null;
      }

      let outgoing = sanitizeUserReply(String(response).trim(), combined);
      if (isConversationEndControlBody(outgoing)) return;

      const firewallConfig = scopeFirewallService.getConfigForBot(botAccountId);
      if (firewallConfig.enabled) {
        outgoing = applyFirewallPostReply(outgoing, {
          mode: firewallConfig.mode,
          redirectMessage: firewallConfig.redirectMessage,
        });
        if (!outgoing && firewallConfig.mode === 'silent') return;
      }
      if (!outgoing || !String(outgoing).trim()) return;

      if (this.whatsapp.recentBotReplyBodies) {
        this.whatsapp.recentBotReplyBodies.add(outgoing.slice(0, 120));
        this.whatsapp.recentBotReplyBodies.add(outgoing.slice(0, 300));
      }

      const targets = outboundChatIds?.length
        ? outboundChatIds
        : resolveOutboundChatIds(context.chatProfile, replyChatId);

      if (botAccountId) {
        const delaySec = botAccountService.resolveReplyDelaySeconds(botAccountId);
        if (delaySec > 0) {
          await this.whatsapp.waitBeforeReply(targets, delaySec);
        }
      }

      const outgoingChunks = splitReplyIntoChunks(outgoing);
      for (let i = 0; i < outgoingChunks.length; i += 1) {
        if (i > 0) {
          const primary = targets[0];
          if (primary) this.whatsapp.sendTypingState(primary).catch(() => {});
          await sleep(800 + Math.random() * 1200);
        }
        await this.whatsapp.sendMessage(targets, outgoingChunks[i]);
      }
      memoryService.addMessage(context.chatProfile.id, MESSAGE_ROLES.ASSISTANT, outgoing, {
        source: MESSAGE_SOURCES.ASSISTANT,
        kbMeta: responseKbMeta,
      });
      logger.info(
        `Outgoing batched reply to chat ${targets[0]} (profile ${context.chatProfile.id})`
      );
    } catch (error) {
      logger.error(
        `Batched AI reply failed profile=${context.chatProfile.id}: ${error.message}`,
        { stack: error.stack }
      );
    }
  }

  async resolveMediaFragmentForBatch(message, context) {
    const rawCaption =
      message.body?.trim() ||
      message._data?.caption?.trim() ||
      message._data?.body?.trim() ||
      '';
    const caption = knowledgeBaseService.sanitizeMediaCaption(rawCaption);
    const mediaType = message.type || 'media';
    const filename = message._data?.filename || null;
    const persist = !context.mediaAlreadyPersisted;
    const botAccountId = this.getBotAccountId();

    let media = null;
    try {
      media = await message.downloadMedia();
    } catch (error) {
      logger.warn(
        `Media download failed for batch (type=${mediaType}): ${error.message}`
      );
    }

    try {
      if (media && (mediaType === 'ptt' || mediaType === 'audio')) {
        const prepared = await chatService.processVoiceMessage(
          context.owner.id,
          context.chatProfile.id,
          media.data,
          media.mimetype,
          botAccountId,
          { respond: false, persist: true }
        );
        return prepared?.fragment || '';
      }

      const looksPdf =
        mediaType === 'document' &&
        (media?.mimetype === 'application/pdf' ||
          String(filename || '').toLowerCase().endsWith('.pdf') ||
          String(media?.mimetype || '').includes('pdf'));

      if (media && looksPdf) {
        const prepared = await chatService.processPdfDocument(
          context.owner.id,
          context.chatProfile.id,
          media.data,
          filename || 'document.pdf',
          botAccountId,
          { respond: false, persist: true }
        );
        return prepared?.fragment || '';
      }

      const prepared = await chatService.handleGenericMediaMessage(
        context.owner.id,
        context.chatProfile.id,
        {
          mediaType,
          filename,
          mimetype: media?.mimetype || null,
          caption,
        },
        botAccountId,
        { respond: false, persist }
      );
      return prepared?.fragment || context.lastInboundEscalationContent || '';
    } catch (error) {
      logger.warn(`Media fragment prepare failed (type=${mediaType}): ${error.message}`);
      return (
        context.lastInboundEscalationContent ||
        chatService.buildGenericMediaUserContent({
          mediaType,
          filename,
          mimetype: null,
          caption:
            caption ||
            `The ${mediaType} could not be fully processed. Acknowledge briefly and ask how you can help.`,
        })
      );
    }
  }

  async handleTextMessage(body, context) {
    const botAccountId = this.getBotAccountId();
    if (!this.isSelfChatContext(context)) {
      return chatService.generateResponse(
        context.owner.id,
        context.chatProfile.id,
        body,
        false,
        botAccountId
      );
    }

    if (
      contactSelectionService.isNumericSelection(body) &&
      contactSelectionService.hasPending(context.owner.id)
    ) {
      const index = contactSelectionService.parseSelectionIndex(body);
      return executePendingSelection(context.owner.id, index);
    }

    if (this.isAssistantToggleText(body, context)) {
      const toggleArgs = this.parseAssistantToggleText(body);
      return assistantCommand.execute(context.owner.id, toggleArgs);
    }

    const parsed = extractCommand(body);

    if (parsed) {
      return this.handleCommand(parsed.command, parsed.args, context);
    }

    return chatService.generateResponse(
      context.owner.id,
      context.chatProfile.id,
      body,
      context.isSelfChat,
      botAccountId
    );
  }

  async handleCommand(command, args, context) {
    const { owner, chatProfile } = context;
    const botAccountId = this.getBotAccountId();

    if (!this.isSelfChatContext(context)) {
      return chatService.generateResponse(
        owner.id,
        chatProfile.id,
        `${command} ${args}`.trim(),
        false,
        botAccountId
      );
    }

    switch (command) {
      case COMMANDS.HELP:
        return helpCommand.execute();

      case COMMANDS.PING:
        return pingCommand.execute();

      case COMMANDS.RESET:
        return resetCommand.execute(chatProfile.id);

      case COMMANDS.SUMMARY:
        return summaryCommand.execute(chatProfile.id);

      case COMMANDS.PROFILE:
        return profileCommand.execute(chatProfile.id, owner.id, args, true);

      case COMMANDS.ME:
        return meCommand.execute();

      case COMMANDS.CONTACTS:
        return contactsCommand.execute(owner.id);

      case COMMANDS.ASSISTANT:
        return assistantCommand.execute(owner.id, args);

      case COMMANDS.PAUSE:
      case COMMANDS.STOP:
      case COMMANDS.START:
      case COMMANDS.RESUME:
        return null;

      case COMMANDS.NOTE:
        return noteCommand.execute(owner.id, args);

      case COMMANDS.NOTES:
        return notesCommand.execute(owner.id);

      case COMMANDS.REMIND: {
        const reply = remindCommand.execute(owner.id, args);
        if (!String(reply).toLowerCase().includes('invalid')) {
          this.recordAction(context, {
            source: ACTION_SOURCES.REMINDER,
            title: 'Reminder scheduled',
            description: args || '',
          });
        }
        return reply;
      }

      case COMMANDS.MODEL:
        return modelCommand.execute(owner.id, args);

      case COMMANDS.TOKENS:
        return tokensCommand.execute(owner.id, chatProfile.id, args, true);

      default:
        return chatService.generateResponse(
          owner.id,
          chatProfile.id,
          `${command} ${args}`.trim(),
          true,
          botAccountId
        );
    }
  }

  async handleMediaMessage(message, context, { respond = true, persist = true } = {}) {
    const caption =
      message.body?.trim() ||
      message._data?.caption?.trim() ||
      message._data?.body?.trim() ||
      '';
    const mediaType = message.type || 'media';
    const filename = message._data?.filename || null;

    let media = null;
    try {
      media = await message.downloadMedia();
    } catch (error) {
      logger.warn(
        `Media download failed (type=${mediaType}): ${error.message} — routing to prompt`
      );
    }

    try {
      if (media && (mediaType === 'ptt' || mediaType === 'audio')) {
        return await chatService.processVoiceMessage(
          context.owner.id,
          context.chatProfile.id,
          media.data,
          media.mimetype,
          this.getBotAccountId(),
          { respond, persist }
        );
      }

      const looksPdf =
        mediaType === 'document' &&
        (media?.mimetype === 'application/pdf' ||
          String(filename || '').toLowerCase().endsWith('.pdf') ||
          String(media?.mimetype || '').includes('pdf'));

      if (media && looksPdf) {
        return await chatService.processPdfDocument(
          context.owner.id,
          context.chatProfile.id,
          media.data,
          filename || 'document.pdf',
          this.getBotAccountId(),
          { respond, persist }
        );
      }

      // Images, video, stickers, other documents — always go through the team prompt.
      return await chatService.handleGenericMediaMessage(
        context.owner.id,
        context.chatProfile.id,
        {
          mediaType,
          filename,
          mimetype: media?.mimetype || null,
          caption,
        },
        this.getBotAccountId(),
        { respond, persist }
      );
    } catch (error) {
      logger.warn(`Media processing error (type=${mediaType}): ${error.message} — prompt fallback`);
      return chatService.handleGenericMediaMessage(
        context.owner.id,
        context.chatProfile.id,
        {
          mediaType,
          filename,
          mimetype: media?.mimetype || null,
          caption:
            caption ||
            `The ${mediaType} could not be fully processed. Acknowledge briefly and ask how you can help.`,
        },
        this.getBotAccountId(),
        { respond, persist }
      );
    }
  }
}

module.exports = MessageHandler;
