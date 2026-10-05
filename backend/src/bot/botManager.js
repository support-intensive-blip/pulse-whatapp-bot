const GallaboxBot = require('./gallaboxBot');
const gallaboxApi = require('./gallabox/gallaboxApi');
const { botAccountService, BOT_STATUS } = require('../services/botAccountService');
const logger = require('../utils/logger');
const { normalizePhone } = require('../utils/helpers');

// Where Gallabox should send webhooks: this backend's own public URL (Render sets
// RENDER_EXTERNAL_URL), not the Netlify dashboard URL the browser is on.
function publicBaseUrl() {
  const url = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';
  return url.replace(/\/+$/, '');
}

/**
 * Runs the single Gallabox-connected WhatsApp number. The number is configured
 * through env (GALLABOX_*), and belongs to one dashboard bot account:
 *   1. GALLABOX_BOT_ACCOUNT_ID, if set
 *   2. else the account that already owns this phone (keeps old chat history)
 *   3. else the first dashboard user's (admin's) account
 */
class BotManager {
  constructor() {
    this.bots = new Map();
  }

  resolveGallaboxAccountId() {
    const explicit = parseInt(process.env.GALLABOX_BOT_ACCOUNT_ID, 10);
    if (explicit && botAccountService.findById(explicit)) return explicit;

    const { phone } = gallaboxApi.getConfig();
    if (phone) {
      const { getDatabase } = require('../database/db');
      const owner = getDatabase()
        .prepare(
          `SELECT id FROM bot_accounts
           WHERE whatsapp_phone = ? OR last_whatsapp_phone = ?
           ORDER BY CASE WHEN whatsapp_phone = ? THEN 0 ELSE 1 END, id DESC
           LIMIT 1`
        )
        .get(phone, phone, phone);
      if (owner) return owner.id;
    }

    const { dashboardUserService } = require('../services/dashboardUserService');
    const admin = dashboardUserService.listAll()[0];
    if (admin) {
      const account =
        botAccountService.findByDashboardUserId(admin.id) ||
        botAccountService.createForUser(admin.id, admin.name);
      if (account) return account.id;
    }

    return botAccountService.findById(1) ? 1 : null;
  }

  getBot(botAccountId) {
    return this.bots.get(botAccountId) || null;
  }

  getBotForUser(dashboardUserId) {
    const account = botAccountService.findByDashboardUserId(dashboardUserId);
    return account ? this.getBot(account.id) : null;
  }

  getAnyReadyBot() {
    for (const bot of this.bots.values()) {
      if (bot.isReady) return bot;
    }
    return null;
  }

  isStarting() {
    return false;
  }

  async startBot(botAccountId) {
    const existing = this.bots.get(botAccountId);
    if (existing?.isReady) return existing;

    const bot = new GallaboxBot({ botAccountId });
    this.bots.set(botAccountId, bot);
    await bot.initialize();
    return bot;
  }

  async startConfiguredBot() {
    gallaboxApi.logConfigStatus();
    const accountId = gallaboxApi.isConfigured() ? this.resolveGallaboxAccountId() : null;

    // Accounts may still carry READY from the old WhatsApp Web sessions; only the
    // Gallabox account is live now. Their phone is kept so old history stays visible.
    const { phone } = gallaboxApi.getConfig();
    for (const account of botAccountService.listReadyBots()) {
      if (account.id === accountId) continue;
      botAccountService.updateStatus(account.id, BOT_STATUS.DISCONNECTED, {
        clearWhatsappPhone: Boolean(phone) && normalizePhone(account.whatsapp_phone) === phone,
      });
    }

    if (!gallaboxApi.isConfigured()) return null;
    if (!accountId) {
      logger.warn('Gallabox configured but no bot account exists yet — create a dashboard user first.');
      return null;
    }

    return this.startBot(accountId);
  }

  async stopBot(botAccountId) {
    const bot = this.bots.get(botAccountId);
    if (bot) {
      await bot.shutdown();
      this.bots.delete(botAccountId);
    }
    botAccountService.updateStatus(botAccountId, BOT_STATUS.DISCONNECTED, { lastError: null });
  }

  getStatus(botAccountId) {
    const bot = this.getBot(botAccountId);
    const account = botAccountService.findById(botAccountId);
    const ready = Boolean(bot?.isReady);
    return {
      ...botAccountService.toPublic(account),
      status: ready ? BOT_STATUS.READY : BOT_STATUS.DISCONNECTED,
      provider: 'gallabox',
      live: bot ? bot.getStatus() : { ready: false, provider: 'gallabox' },
      gallabox: {
        configured: gallaboxApi.isConfigured(),
        missing: gallaboxApi.missingConfigKeys(),
        assignedHere: ready,
        webhookPath: '/webhooks/gallabox',
        webhookUrl: publicBaseUrl() ? `${publicBaseUrl()}/webhooks/gallabox` : null,
      },
    };
  }

  async shutdownAll() {
    for (const bot of this.bots.values()) {
      await bot.shutdown();
    }
    this.bots.clear();
  }
}

module.exports = new BotManager();
