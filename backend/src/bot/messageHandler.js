const userService = require('../services/userService');
const chatProfileService = require('../services/chatProfileService');
const chatService = require('../services/chatService');
const knowledgeBaseService = require('../services/knowledgeBaseService');
const logger = require('../utils/logger');
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
const { ERROR_REPLY_COOLDOWN_MS, MESSAGE_ROLES, MESSAGE_SOURCES } = require('../utils/constants');
const { sanitizeUserReply, applyFirewallPostReply, isConversationEndControlBody, parseStructuredReply } = require('../ai/replyRules');
const { splitReplyIntoChunks } = require('../ai/messageSplitter');
const { normalizePhone, sleep } = require('../utils/helpers');

const ERROR_REPLY_TEXT = "Oops, something glitched on my end — try sending that again?";
const MEDIA_ACK_TEXT = "Got it — I've received your file. How can I help with it?";
const EMPTY_REPLY_FALLBACK = "Hey! I'm here — what can I help you with today?";

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

/**
 * Handles one normalized inbound WhatsApp message (see bot/gallabox/inboundMessage.js).
 * Every message comes from a contact writing to the business number — there is
 * no self-chat on the WhatsApp Business API, so owner commands live in the dashboard.
 */
class MessageHandler {
  constructor(bot) {
    this.whatsapp = bot;
    this.errorReplyCooldown = new Map();
  }

  getBotAccountId() {
    return this.whatsapp?.botAccountId || null;
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

  isAssistantAllowed(context, phone) {
    // Testing mode overrides the per-chat/global AI switches: only listed numbers get replies.
    const testAccess = botAccountService.resolveTestModeAccess(this.getBotAccountId(), phone);
    if (testAccess !== null) return testAccess;

    const freshOwner = userService.findById(context.owner.id) || context.owner;
    const freshProfile =
      chatProfileService.findById(context.chatProfile.id) || context.chatProfile;
    return chatProfileService.isAssistantActive(freshProfile, freshOwner);
  }

  async resolveChatContext(inbound) {
    const ownerPhone = normalizePhone(this.whatsapp.myWhatsAppId);
    const owner = userService.getOrCreate(ownerPhone, null);
    const { chatId, phone, name } = inbound;

    // Re-attach history from an older profile for the same person (e.g. one created
    // under a WhatsApp Web @lid chat id) before creating a fresh one.
    let chatProfile = chatProfileService.findByChatIdForOwner(chatId, ownerPhone);
    if (!chatProfile) {
      const linked = chatProfileService.findLinkedContactProfile(ownerPhone, {
        contactPhone: phone,
        contactName: name,
        chatId,
      });
      if (linked) {
        chatProfile = chatProfileService.updateChatId(linked.id, chatId, ownerPhone) || linked;
      }
    }

    chatProfile = chatProfileService.getOrCreate({
      chatId,
      ownerPhone,
      contactName: name,
      contactPhone: phone,
      chatType: 'contact',
    });

    chatProfile = await chatProfileService.linkImportedContactProfile(chatProfile, ownerPhone, {
      realPhone: phone,
      chatId,
    });
    chatProfile = chatProfileService.inheritAssistantFromSiblings(chatProfile);

    return { owner, chatProfile };
  }

  async handleMessage(inbound) {
    const replyChatId = inbound.chatId;

    try {
      const context = await this.resolveChatContext(inbound);
      const body = String(inbound.body || '').trim();

      // Control signal from prompt — never store, never reply.
      if (body && isConversationEndControlBody(body)) {
        logger.info(`Ignored conversation_end control JSON (profile ${context.chatProfile?.id})`);
        return;
      }

      if (inbound.hasMedia) {
        const caption = knowledgeBaseService.sanitizeMediaCaption(body);
        const mediaContent = chatService.buildGenericMediaUserContent({
          mediaType: inbound.type || 'media',
          filename: inbound.filename,
          mimetype: inbound.mimeType,
          caption,
        });
        const stored = memoryService.addMessage(context.chatProfile.id, MESSAGE_ROLES.USER, mediaContent, {
          source: MESSAGE_SOURCES.WHATSAPP,
          waMessageId: inbound.id,
        });
        context.lastInboundMessageId = stored?.id || null;
        context.lastInboundEscalationContent = mediaContent;
        context.mediaAlreadyPersisted = true;
      } else if (body) {
        const stored = memoryService.addMessage(context.chatProfile.id, MESSAGE_ROLES.USER, body, {
          source: MESSAGE_SOURCES.WHATSAPP,
          waMessageId: inbound.id,
        });
        context.lastInboundMessageId = stored?.id || null;
        context.lastInboundEscalationContent = body;
      } else {
        logger.info(`Skipped empty message: type=${inbound.type}`);
        return;
      }

      const botAccountId = this.getBotAccountId();
      const assistantAllowed = this.isAssistantAllowed(context, inbound.phone);

      const escalationContent = context.lastInboundEscalationContent;
      const escalationResult = await escalationService.processInbound({
        chatProfileId: context.chatProfile.id,
        content: escalationContent,
        botAccountId,
        triggerMessageId: context.lastInboundMessageId || null,
        hasMedia: Boolean(inbound.hasMedia),
        mediaType: inbound.hasMedia ? inbound.type : null,
        forceMediaOrLink: Boolean(inbound.hasMedia) || escalationService.containsUrl(escalationContent),
      });

      if (!assistantAllowed && !escalationResult?.autoReply) {
        if (botAccountService.resolveTestModeAccess(botAccountId, inbound.phone) === false) {
          logger.info(`Testing mode: ${inbound.phone} is not a test number — message stored, no reply`);
          return;
        }
        logger.info(
          `Assistant disabled for chat profile ${context.chatProfile.id} (active=${context.chatProfile.assistant_active}, pinned=${context.chatProfile.assistant_pinned_on}, global=${userService.isAssistantContactsEnabled(context.owner)}) — message stored, no reply`
        );
        return;
      }

      logger.info(
        `Chat context: profile=${context.chatProfile.id}, contact=${context.chatProfile.contact_name || 'unknown'}, replyTo=${replyChatId}, body="${body.slice(0, 50)}"`
      );

      const apiKey = botAccountId ? botConfigService.resolveApiKeyForBotAccountId(botAccountId) : null;
      if (!apiKey) {
        dashboardAlertService.notifyNoApiKeyInbound({
          botAccountId,
          chatProfileId: context.chatProfile.id,
          contactName: context.chatProfile.contact_name,
          messagePreview: body || `[${inbound.type || 'media'}]`,
        });
        logger.info(
          `No API key for bot ${botAccountId} — inbound stored, no WhatsApp reply (profile ${context.chatProfile.id})`
        );
        return;
      }

      if (escalationResult?.autoReply) {
        await this.deliverReply({
          context,
          targets: resolveOutboundChatIds(context.chatProfile, replyChatId),
          outgoing: escalationResult.autoReply,
          source: MESSAGE_SOURCES.ESCALATION,
        });
        return;
      }

      if (body && !inbound.hasMedia) {
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

          logger.info(`Firewall blocked (redirect) profile=${context.chatProfile.id} tier=${firewallResult.tier}`);
          await this.deliverReply({
            context,
            targets: resolveOutboundChatIds(context.chatProfile, replyChatId),
            outgoing: firewallResult.redirectMessage,
            source: MESSAGE_SOURCES.FIREWALL,
          });
          return;
        }
      }

      const fragment = inbound.hasMedia
        ? await this.resolveMediaFragmentForBatch(inbound, context)
        : body;

      if (!fragment || !String(fragment).trim()) {
        logger.warn(`Nothing to answer for profile ${context.chatProfile.id} (type=${inbound.type})`);
        return;
      }

      this.queueContactAiReply({ context, replyChatId, fragment: String(fragment).trim() });
    } catch (error) {
      logger.error(`Message handling error: ${error.message}`, { stack: error.stack });

      if (!this.canSendErrorReply(replyChatId)) return;
      try {
        // Media failures get a soft acknowledgement rather than the "glitched" line.
        await this.whatsapp.sendMessage(replyChatId, inbound.hasMedia ? MEDIA_ACK_TEXT : ERROR_REPLY_TEXT);
      } catch (sendError) {
        logger.error(`Failed to send error reply: ${sendError.message}`);
      }
    }
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
      onFlush: async ({ combined, fragments, partCount }) => {
        logger.info(
          `Flushing inbound batch profile=${chatProfileId} parts=${partCount} windowMs=${windowMs || BATCH_WINDOW_MS}`
        );
        await this.flushContactAiBatch({
          context,
          outboundChatIds,
          combined,
          fragments,
          partCount,
        });
      },
    });
  }

  async flushContactAiBatch({ context, outboundChatIds, combined, fragments, partCount = 1 }) {
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

      if (unwrapped.conversationEnd || isConversationEndControlBody(response)) {
        const recovered = parseStructuredReply(String(response || ''));
        persistConversationEndMemory(context.chatProfile, {
          conversationSummary:
            unwrapped.conversationSummary || recovered.conversationSummary || null,
          userPreferences: unwrapped.userPreferences || recovered.userPreferences || null,
        });
        logger.info(`Conversation end detected for profile ${context.chatProfile.id} — batch suppressed`);
        return;
      }

      if (!response || !String(response).trim()) {
        response = EMPTY_REPLY_FALLBACK;
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

      await this.deliverReply({
        context,
        targets: outboundChatIds,
        outgoing,
        source: MESSAGE_SOURCES.ASSISTANT,
        kbMeta: responseKbMeta,
      });
    } catch (error) {
      logger.error(
        `Batched AI reply failed profile=${context.chatProfile.id}: ${error.message}`,
        { stack: error.stack }
      );
    }
  }

  /** Reply delay → chunked send → store the reply in conversation history. */
  async deliverReply({ context, targets, outgoing, source, kbMeta = null }) {
    const text = String(outgoing || '').trim();
    if (!text) {
      logger.warn(`No reply after post-processing for profile ${context.chatProfile.id}`);
      return;
    }

    const botAccountId = this.getBotAccountId();
    if (botAccountId) {
      const delaySec = botAccountService.resolveReplyDelaySeconds(botAccountId);
      if (delaySec > 0) await this.whatsapp.waitBeforeReply(targets, delaySec);
    }

    const recipientName = context.chatProfile.contact_name || null;
    const chunks = splitReplyIntoChunks(text);
    for (let i = 0; i < chunks.length; i += 1) {
      if (i > 0) await sleep(800 + Math.random() * 1200);
      await this.whatsapp.sendMessage(targets, chunks[i], { recipientName });
    }

    memoryService.addMessage(context.chatProfile.id, MESSAGE_ROLES.ASSISTANT, text, {
      source,
      kbMeta,
    });
    logger.info(`Outgoing reply to ${targets[0]} (profile ${context.chatProfile.id}, source=${source})`);
  }

  async resolveMediaFragmentForBatch(inbound, context) {
    const caption = knowledgeBaseService.sanitizeMediaCaption(inbound.body || '');
    const mediaType = inbound.type || 'media';
    const filename = inbound.filename || null;
    const botAccountId = this.getBotAccountId();

    let media = null;
    try {
      media = await inbound.download();
      if (!media) {
        logger.warn(`No downloadable media URL in Gallabox payload (type=${mediaType})`);
      }
    } catch (error) {
      logger.warn(`Media download failed (type=${mediaType}): ${error.message}`);
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
        (String(media?.mimetype || '').includes('pdf') ||
          String(filename || '').toLowerCase().endsWith('.pdf'));

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
          mimetype: media?.mimetype || inbound.mimeType || null,
          caption,
        },
        botAccountId,
        { respond: false, persist: !context.mediaAlreadyPersisted }
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
}

module.exports = MessageHandler;
