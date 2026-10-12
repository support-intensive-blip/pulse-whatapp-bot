const GallaboxBot = require('./gallaboxBot');
const gallaboxApi = require('./gallabox/gallaboxApi');
const { botAccountService, BOT_STATUS } = require('../services/botAccountService');
const logger = require('../utils/logger');

// Where Gallabox should send webhooks: this backend's own public URL (Render sets
// RENDER_EXTERNAL_URL), not the Netlify dashboard URL the browser is on.
function publicBaseUrl() {
  const url = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';
  return url.replace(/\/+$/, '');
}

function webhookPathFor(botAccountId) {
  return `/webhooks/gallabox/${botAccountId}`;
}

/**
 * Runs one GallaboxBot per connected WhatsApp number. Each number is a
 * bot_accounts row with its own Gallabox credentials; a bot runs while it is
 * active (not deactivated) and fully configured.
 */
class BotManager {
  constructor() {
    this.bots = new Map();
  }

  getBot(botAccountId) {
    return this.bots.get(Number(botAccountId)) || null;
  }

  /** Legacy webhook path: route by the payload's channel id. */
  getBotForChannel(channelId) {
    if (!channelId) return null;
    for (const bot of this.bots.values()) {
      if (bot.isReady && bot.channelId === String(channelId)) return bot;
    }
    return null;
  }

  getReadyBots() {
    return [...this.bots.values()].filter((bot) => bot.isReady);
  }

  /** Active bot, fully configured, in an active team. */
  canRun(account) {
    if (!account || account.is_active !== 1 || !botAccountService.hasCredentials(account)) return false;
    const { teamService } = require('../services/teamService');
    const team = teamService.findById(account.team_id);
    return !team || team.is_active !== 0;
  }

  /** After a team is (de)activated: start or stop all of its bots. */
  async syncTeam(teamId) {
    for (const account of botAccountService.listByTeam(teamId)) {
      if (this.canRun(account)) {
        await this.startBot(account.id).catch((error) => logger.error(`Bot ${account.id} failed to start: ${error.message}`));
      } else if (this.getBot(account.id)) {
        await this.stopBot(account.id);
      }
    }
  }

  async startBot(botAccountId) {
    const account = botAccountService.findById(botAccountId);
    if (!this.canRun(account)) {
      const configured = botAccountService.hasCredentials(account);
      await this.stopBot(botAccountId, { lastError: !account || account.is_active === 0 || configured ? null : 'Gallabox is not fully configured' });
      return null;
    }
    if (!botAccountService.getCredentials(account).readable) {
      await this.stopBot(botAccountId, {
        lastError: 'Saved Gallabox secrets cannot be decrypted (ENCRYPTION_KEY/JWT_SECRET changed) — re-enter them',
      });
      return null;
    }

    const existing = this.bots.get(account.id);
    if (existing) await existing.shutdown();

    const bot = new GallaboxBot({ account });
    this.bots.set(account.id, bot);
    await bot.initialize();
    return bot;
  }

  /** Re-reads the bot's row (after credential or number changes) and restarts it. */
  async restartBot(botAccountId) {
    return this.startBot(botAccountId);
  }

  async startAll() {
    gallaboxApi.logConfigStatus();
    const accounts = botAccountService.listAll({ includeInactive: false });
    for (const account of accounts) {
      if (!this.canRun(account)) {
        if (account.status === BOT_STATUS.READY) {
          botAccountService.updateStatus(account.id, BOT_STATUS.DISCONNECTED);
        }
        continue;
      }
      try {
        await this.startBot(account.id);
      } catch (error) {
        logger.error(`Bot ${account.id} failed to start: ${error.message}`);
        botAccountService.updateStatus(account.id, BOT_STATUS.ERROR, { lastError: error.message });
      }
    }
    logger.info(`Gallabox bots running: ${this.getReadyBots().length}/${accounts.length}`);
  }

  async stopBot(botAccountId, { lastError = null } = {}) {
    const bot = this.bots.get(Number(botAccountId));
    if (bot) {
      await bot.shutdown();
      this.bots.delete(Number(botAccountId));
    }
    if (botAccountService.findById(botAccountId)) {
      botAccountService.updateStatus(botAccountId, BOT_STATUS.DISCONNECTED, { lastError });
    }
  }

  getConnection(botAccountId) {
    const bot = this.getBot(botAccountId);
    const account = botAccountService.findById(botAccountId);
    const base = publicBaseUrl();
    return {
      connected: Boolean(bot?.isReady),
      configured: botAccountService.hasCredentials(account),
      live: bot ? bot.getStatus() : { ready: false, provider: 'gallabox' },
      webhookPath: webhookPathFor(botAccountId),
      webhookUrl: base ? `${base}${webhookPathFor(botAccountId)}` : null,
    };
  }

  getStatus(botAccountId) {
    const account = botAccountService.findById(botAccountId);
    const connection = this.getConnection(botAccountId);
    return {
      ...botAccountService.toPublic(account),
      status: connection.connected ? BOT_STATUS.READY : BOT_STATUS.DISCONNECTED,
      provider: 'gallabox',
      connection,
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
module.exports.publicBaseUrl = publicBaseUrl;
