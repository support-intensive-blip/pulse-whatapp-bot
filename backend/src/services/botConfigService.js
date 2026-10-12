const { botAccountService } = require('./botAccountService');
const userService = require('./userService');
const logger = require('../utils/logger');

// Per-bot prompt, identity and KB are read through the bot context (utils/botContext.js)
// — nothing is written into process.env any more, so bots can't overwrite each
// other's settings. This only carries the bot's chat model tier onto the WhatsApp
// owner user row that chatService reads it from.

class BotConfigService {
  applyRuntimeConfig(bot) {
    const phone = botAccountService.getPhone(bot);
    if (!phone || !bot.chat_model_tier) return;
    const owner = userService.findByPhone(phone);
    if (owner) userService.setChatModelTier(owner.id, bot.chat_model_tier);
  }

  loadConfigForBotAccount(botAccountId) {
    const bot = botAccountService.findById(botAccountId);
    if (bot) this.applyRuntimeConfig(bot);
  }

  loadAllBotConfigs() {
    const bots = botAccountService.listAll();
    for (const bot of bots) {
      this.applyRuntimeConfig(bot);
    }
    if (bots.length) {
      logger.info(`Loaded saved config for ${bots.length} bot account(s)`);
    }
    return bots.length;
  }

  // The OpenAI key is host-level.
  resolveApiKeyForBotAccountId() {
    return process.env.OPENAI_API_KEY || null;
  }

  resolveApiKeyForOwnerPhone() {
    return process.env.OPENAI_API_KEY || null;
  }
}

module.exports = new BotConfigService();
