const MessageHandler = require('./messageHandler');
const gallaboxApi = require('./gallabox/gallaboxApi');
const { fromGallaboxPayload } = require('./gallabox/inboundMessage');
const { botAccountService, BOT_STATUS } = require('../services/botAccountService');
const logger = require('../utils/logger');
const { MAX_REPLY_DELAY_SECONDS } = require('../utils/constants');
const { sleep, normalizePhone } = require('../utils/helpers');

const SEEN_ID_LIMIT = 5000;

/**
 * One WhatsApp Business number connected through Gallabox. Inbound messages
 * arrive as webhooks (see api/gallaboxWebhookRoutes.js); replies go out over
 * the Gallabox REST API. No browser, no session to keep alive.
 */
class GallaboxBot {
  constructor({ botAccountId }) {
    const { phone } = gallaboxApi.getConfig();
    this.botAccountId = botAccountId;
    this.ownerPhone = phone;
    this.myWhatsAppId = `${phone}@c.us`;
    this.client = gallaboxApi;
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

    const botConfigService = require('../services/botConfigService');
    const userService = require('../services/userService');
    const account = botAccountService.findById(this.botAccountId);
    if (account) {
      botConfigService.applyRuntimeConfig(account);
      botAccountService.syncToWhatsAppUser(account);
    }
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

  async handleWebhookEvent(eventName, payload) {
    if (eventName === 'Message.WA.Status.Failed') {
      const reason = payload?.errors?.[0]?.title || payload?.errors?.[0]?.message || 'unknown';
      logger.warn(`Gallabox delivery failed to ${payload?.recipient_id || '?'}: ${reason}`);
      return;
    }

    if (eventName !== 'Message.Received') return;

    const { channelId } = gallaboxApi.getConfig();
    if (channelId && payload?.channelId && payload.channelId !== channelId) {
      logger.info(`Ignored Gallabox message for another channel (${payload.channelId})`);
      return;
    }

    const inbound = fromGallaboxPayload(payload);
    if (!inbound) {
      logger.info(`Ignored Gallabox message type=${payload?.whatsapp?.type || 'unknown'}`);
      return;
    }

    if (!this.markSeen(inbound.id)) {
      logger.info(`Ignored duplicate Gallabox webhook for message ${inbound.id}`);
      return;
    }

    this.lastInboundAt = new Date().toISOString();
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
      const sent = await gallaboxApi.sendText(phone, text, { recipientName });
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
      signatureCheck: Boolean(gallaboxApi.getConfig().webhookSecret),
    };
  }

  async shutdown() {
    this.isReady = false;
  }
}

module.exports = GallaboxBot;
