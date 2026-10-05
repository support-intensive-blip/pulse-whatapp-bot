const { getDatabase } = require('../database/db');
const { botAccountService } = require('./botAccountService');
const knowledgeBaseService = require('./knowledgeBaseService');
const userService = require('./userService');
const intensiveConfig = require('../config/intensiveConfig');
const logger = require('../utils/logger');

// Single-tenant: the system prompt + KB are hardcoded (src/config/intensiveConfig.js).
// This service only carries the per-bot cosmetic settings that still live on the
// bot_accounts row (assistant name, model overrides) into process.env at runtime.

class BotConfigService {
  applyRuntimeConfig(bot) {
    if (!bot) return;

    if (bot.assistant_name) process.env.ASSISTANT_NAME = bot.assistant_name;
    if (bot.assistant_persona) process.env.ASSISTANT_PERSONA = bot.assistant_persona;
    if (bot.assistant_role_when_asked) {
      process.env.ASSISTANT_ROLE_WHEN_ASKED = bot.assistant_role_when_asked;
    }
    if (bot.openai_model_fast) process.env.OPENAI_MODEL_FAST = bot.openai_model_fast;
    if (bot.openai_model_smart) process.env.OPENAI_MODEL_SMART = bot.openai_model_smart;

    knowledgeBaseService.setSourcePath(intensiveConfig.KNOWLEDGE_BASE_PATH);

    if (bot.whatsapp_phone && bot.chat_model_tier) {
      const owner = userService.findByPhone(bot.whatsapp_phone);
      if (owner) {
        userService.setChatModelTier(owner.id, bot.chat_model_tier);
      }
    }
  }

  loadConfigForBotAccount(botAccountId) {
    const bot = botAccountService.findById(botAccountId);
    if (bot) this.applyRuntimeConfig(bot);
  }

  loadConfigForOwnerPhone(ownerPhone) {
    const db = getDatabase();
    const bot = db
      .prepare('SELECT * FROM bot_accounts WHERE whatsapp_phone = ? ORDER BY id DESC LIMIT 1')
      .get(ownerPhone);
    if (bot) this.applyRuntimeConfig(bot);
  }

  loadAllBotConfigs() {
    const db = getDatabase();
    const bots = db.prepare('SELECT * FROM bot_accounts ORDER BY id ASC').all();
    for (const bot of bots) {
      this.applyRuntimeConfig(bot);
    }
    if (bots.length) {
      logger.info(`Loaded saved config for ${bots.length} bot account(s)`);
    }
    return bots.length;
  }

  // The OpenAI key is host-level in single-tenant mode.
  resolveApiKeyForBotAccountId() {
    return process.env.OPENAI_API_KEY || null;
  }

  resolveApiKeyForOwnerPhone() {
    return process.env.OPENAI_API_KEY || null;
  }
}

module.exports = new BotConfigService();
