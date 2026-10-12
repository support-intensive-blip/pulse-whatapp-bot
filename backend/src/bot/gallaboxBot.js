const MessageHandler = require('./messageHandler');
const gallaboxApi = require('./gallabox/gallaboxApi');
const { fromGallaboxPayload } = require('./gallabox/inboundMessage');
const { botAccountService, BOT_STATUS } = require('../services/botAccountService');
const { runWithBot } = require('../utils/botContext');
const logger = require('../utils/logger');
const { MAX_REPLY_DELAY_SECONDS } = require('../utils/constants');
const { sleep, normalizePhone } = require('../utils/helpers');

const SEEN_ID_LIMIT = 5000;
// A Conversation.Update about an old message (e.g. an agent tagging the chat later)
// must not make the bot answer it.
const CONVERSATION_EVENT_MAX_AGE_MS = 10 * 60 * 1000;

function normalizeConversationValue(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'object') {
    const nested = value.id ?? value.phone ?? value.phoneNumber ?? value.value ?? value.number ?? value.contactId ?? value.senderId;
    return nested === undefined ? '' : String(nested);
  }
  return String(value);
}

function parseConversationTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value) >= 1e12 ? value : value * 1000;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        return Math.abs(numeric) >= 1e12 ? numeric : numeric * 1000;
      }
    }

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

/**
 * One WhatsApp Business number connected through Gallabox. Inbound messages
 * arrive as webhooks (see api/gallaboxWebhookRoutes.js); replies go out over
 * the Gallabox REST API. No browser, no session to keep alive. Credentials,
 * number and channel come from the bot's bot_accounts row.
 */
class GallaboxBot {
  constructor({ account }) {
    const credentials = botAccountService.getCredentials(account);
    this.botAccountId = account.id;
    this.ownerPhone = credentials.phone;
    this.channelId = credentials.channelId;
    this.webhookSecret = credentials.webhookSecret;
    this.myWhatsAppId = `${credentials.phone}@c.us`;
    this.client = gallaboxApi.createClient(credentials);
    this.isReady = false;
    this.isInitializing = false;
    this.isReconnecting = false;
    this.messageHandler = new MessageHandler(this);
    this.seenMessageIds = new Set();
    this.lastInboundAt = null;
    this.lastError = null;
  }

  async initialize() {
    this.isReady = true;
    botAccountService.updateStatus(this.botAccountId, BOT_STATUS.READY, {
      whatsappPhone: this.ownerPhone,
      lastError: null,
    });

    const userService = require('../services/userService');
    const account = botAccountService.findById(this.botAccountId);
    if (account) botAccountService.syncToWhatsAppUser(account);
    userService.getOrCreate(this.ownerPhone);

    logger.info(`Gallabox bot ready (bot ${this.botAccountId}, number ${this.ownerPhone})`);
  }

  /** Gallabox retries webhooks, so the same WhatsApp message id can arrive twice. */
  markSeen(messageId) {
    if (!messageId) return true;
    if (this.seenMessageIds.has(messageId)) return false;
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > SEEN_ID_LIMIT) {
      this.seenMessageIds = new Set([...this.seenMessageIds].slice(-SEEN_ID_LIMIT / 2));
    }
    return true;
  }

  /**
   * Conversation.Create / Conversation.Update carry the conversation's latest
   * message. Treat it as an inbound message only when it is a fresh message sent
   * by the contact — these events also fire for assignments, tags, agent replies
   * and read-state changes, which must not trigger a bot reply.
   */
  extractInboundFromConversation(eventName, payload) {
    if (eventName !== 'Conversation.Create' && eventName !== 'Conversation.Update') return null;

    const latest =
      payload?.latestChatMessage ||
      payload?.latestMessage ||
      payload?.latest?.message ||
      payload?.message ||
      payload?.data?.latestMessage ||
      null;
    if (!latest) return null;

    const wa = latest?.whatsapp || payload?.whatsapp;
    if (!wa) return null;

    const status = String(wa.status || '').toLowerCase();
    if (status !== 'received') return null;

    const senderId =
      latest?.sender?.id ??
      latest?.sender?.phone ??
      latest?.sender ??
      latest?.senderId ??
      latest?.from ??
      payload?.sender?.id ??
      payload?.sender?.phone ??
      null;
    const contactId = payload?.contactId ?? payload?.contact?.id ?? payload?.contact?.phone ?? null;
    if (contactId && senderId) {
      const senderDigits = normalizePhone(normalizeConversationValue(senderId)).replace(/\D/g, '');
      const contactDigits = normalizePhone(normalizeConversationValue(contactId)).replace(/\D/g, '');
      if (senderDigits && contactDigits && senderDigits !== contactDigits) return null;
    }

    const fromDigits = String(wa.from || '').replace(/\D/g, '');
    if (fromDigits && fromDigits === String(this.ownerPhone).replace(/\D/g, '')) return null;

    const sentAt = parseConversationTimestamp(wa.time ?? wa.timestamp ?? latest.createdAt ?? latest.created_at ?? latest.timestamp ?? latest.time ?? null);
    if (sentAt === null || Date.now() - sentAt > CONVERSATION_EVENT_MAX_AGE_MS) return null;

    return {
      ...latest,
      channelId: latest.channelId || payload.channelId || wa.channelId || null,
      contact: { id: contactId || payload.contactId || payload.contact?.id || null, name: payload.contact?.name || payload.contactName || null },
    };
  }

  async handleWebhookEvent(eventName, payload) {
    return runWithBot(this.botAccountId, () => this.processWebhookEvent(eventName, payload));
  }

  async processWebhookEvent(eventName, payload) {
    if (eventName === 'Message.WA.Status.Failed') {
      const reason = payload?.errors?.[0]?.title || payload?.errors?.[0]?.message || 'unknown';
      logger.warn(`Gallabox delivery failed to ${payload?.recipient_id || '?'}: ${reason}`);
      return;
    }

    if (eventName !== 'Message.Received') {
      const fromConversation = this.extractInboundFromConversation(eventName, payload);
      if (!fromConversation) {
        logger.info(`Gallabox event ${eventName} has no new inbound message — skipped`);
        return;
      }
      payload = fromConversation;
    }

    const { channelId } = this;
    if (channelId && payload?.channelId && payload.channelId !== channelId) {
      logger.info(`Ignored Gallabox message for another channel (${payload.channelId})`);
      return;
    }

    const inbound = fromGallaboxPayload(payload, this.client);
    if (!inbound) {
      logger.warn(
        `Ignored Gallabox message type=${payload?.whatsapp?.type || 'unknown'} — payload keys: ${Object.keys(payload || {}).join(',')}; whatsapp keys: ${Object.keys(payload?.whatsapp || {}).join(',')}`
      );
      return;
    }

    if (!this.markSeen(inbound.id)) {
      logger.info(`Ignored duplicate Gallabox webhook for message ${inbound.id}`);
      return;
    }

    this.lastInboundAt = new Date().toISOString();
    botAccountService.touchInbound(this.botAccountId);
    logger.info(
      `WA inbound (bot ${this.botAccountId}): id=${inbound.id || 'n/a'} from=${inbound.phone} type=${inbound.type} body="${String(inbound.body || '').slice(0, 60)}"`
    );

    await this.messageHandler.handleMessage(inbound);
  }

  /** Accepts a phone, a `phone@c.us` id, or a list of candidate chat ids. */
  resolveRecipientPhone(phoneOrIds) {
    const candidates = (Array.isArray(phoneOrIds) ? phoneOrIds : [phoneOrIds]).filter(Boolean);
    for (const candidate of candidates) {
      const value = String(candidate);
      if (value.endsWith('@lid') || value.endsWith('@g.us') || value.includes('@manual.import')) continue;
      const digits = normalizePhone(value).replace(/\D/g, '');
      // Real numbers with country code are <= 13 digits; longer values are WhatsApp LIDs.
      if (digits.length >= 10 && digits.length <= 13) return digits;
    }
    return null;
  }

  async sendMessage(phoneOrIds, text, { recipientName = null } = {}) {
    if (!this.isReady) throw new Error('WhatsApp (Gallabox) is not connected');

    const phone = this.resolveRecipientPhone(phoneOrIds);
    if (!phone) {
      throw new Error('This chat has no WhatsApp phone number to send to.');
    }

    try {
      const sent = await this.client.sendText(phone, text, { recipientName });
      this.lastError = null;
      return { id: { _serialized: sent.id } };
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  // Gallabox's API has no typing indicator; kept so callers don't need to branch.
  async sendTypingState() {}

  async waitBeforeReply(_chatIds, delaySeconds) {
    const delaySec = Math.max(0, Math.min(MAX_REPLY_DELAY_SECONDS, Math.floor(Number(delaySeconds) || 0)));
    if (delaySec) await sleep(delaySec * 1000);
  }

  getStatus() {
    return {
      ready: this.isReady,
      provider: 'gallabox',
      botAccountId: this.botAccountId,
      phone: this.ownerPhone,
      lastInboundAt: this.lastInboundAt,
      lastError: this.lastError,
      signatureCheck: Boolean(this.webhookSecret),
    };
  }

  async shutdown() {
    this.isReady = false;
  }
}

module.exports = GallaboxBot;
