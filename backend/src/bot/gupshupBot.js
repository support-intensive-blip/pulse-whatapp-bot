const GallaboxBot = require('./gallaboxBot');
const { botAccountService } = require('../services/botAccountService');
const api = require('./gupshupApi');

class GupshupBot extends GallaboxBot {
  constructor(options) {
    super(options);
    const config = botAccountService.getCredentials(options.account);
    this.appName = config.channelId;
    this.client.sendText = (phone, text) => api.sendText(config, phone, text);
  }

  async processWebhookEvent(eventName, envelope) {
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
    } else if (type !== 'text') return;
    return super.processWebhookEvent('Message.Received', {
      channelId: this.channelId, contact: { name: message.sender?.name }, whatsapp,
    });
  }

  getStatus() { return { ...super.getStatus(), provider: 'gupshup' }; }
}

module.exports = GupshupBot;
