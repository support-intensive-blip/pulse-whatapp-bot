const GallaboxBot = require('./gallaboxBot');
const { botAccountService } = require('../services/botAccountService');
const api = require('./gupshupApi');

const { readMenu, findOption, POSTBACK_PREFIX } = require('../services/whatsappMenu');

class GupshupBot extends GallaboxBot {
  constructor(options) {
    super(options);
    const config = botAccountService.getCredentials(options.account);
    this.appName = config.channelId;
    this.supportsWhatsAppLists = true;
    this.singleReplyBubble = true;
    this.client.sendText = async (phone, text, { menu } = {}) => {
      if (menu) {
        try {
          return await api.send(config, phone, menu);
        } catch (error) {
          if (![400, 422].includes(error.response?.status)) throw error;
        }
      }
      return api.sendText(config, phone, text);
    };
  }

  async processWebhookEvent(eventName, envelope, following = []) {
    if (envelope.type !== 'message' || envelope.app !== this.appName) return;
    const message = envelope.payload;
    if (!message?.id || !message.source) return;
    const content = message.payload || {};
    const type = message.type;
    const whatsapp = { id: message.id, from: message.source, type,
      time: envelope.timestamp, text: { body: content.text || '' } };
    if (['audio', 'image', 'video', 'file', 'sticker'].includes(type)) {
      whatsapp.type = type === 'file' ? 'document' : type;
      whatsapp[whatsapp.type] = { link: content.url, caption: content.caption,
        filename: content.name, mime_type: content.contentType };
    } else if (type === 'list_reply') {
      const postback = String(content.postbackText || '');
      if (!postback.startsWith(POSTBACK_PREFIX)) return;
      const menu = readMenu(botAccountService.findById(this.botAccountId));
      const option = findOption(menu, '', postback);
      if (!option) return;
      whatsapp.type = 'text';
      whatsapp.text.body = option.label;
    } else if (type !== 'text') return;
    return super.processWebhookEvent('Message.Received', {
      channelId: this.channelId, contact: { name: message.sender?.name }, whatsapp,
      groupedText: following.length ? [envelope, ...following].map(({ payload }) => ({
        id: payload.id, text: payload.payload.text.trim(),
      })).filter(part => part.text) : undefined,
    });
  }

  getStatus() { return { ...super.getStatus(), provider: 'gupshup' }; }
}

module.exports = GupshupBot;
