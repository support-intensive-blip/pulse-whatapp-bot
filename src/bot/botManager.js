const fs = require('fs');
const path = require('path');
const WhatsAppBot = require('./whatsapp');
const { botAccountService, BOT_STATUS } = require('../services/botAccountService');
const logger = require('../utils/logger');
const { sleep } = require('../utils/helpers');

function accountPhone(account) {
  return account?.whatsapp_phone || account?.last_whatsapp_phone || null;
}

function qrGraceMs() {
  return parseInt(process.env.WHATSAPP_QR_GRACE_MS, 10) || 45000;
}

function linkRecoveryCooldownMs() {
  return parseInt(process.env.WHATSAPP_LINK_RECOVERY_COOLDOWN_MS, 10) || 30000;
}

class BotManager {
  constructor() {
    this.bots = new Map();
    this.starting = new Set();
    this._lastLinkRecoveryAt = new Map();
  }

  findBotForPhone(phone, excludeId = null) {
    if (!phone) return null;
    for (const id of this.bots.keys()) {
      if (excludeId && id === excludeId) continue;
      const acc = botAccountService.findById(id);
      if (accountPhone(acc) === phone) return id;
    }
    return null;
  }

  pickPreferredBotId(a, b) {
    const botA = this.bots.get(a);
    const botB = this.bots.get(b);
    const readyA = botA?.getStatus().ready;
    const readyB = botB?.getStatus().ready;
    if (readyA && !readyB) return a;
    if (readyB && !readyA) return b;
    if (a === 1) return b;
    if (b === 1) return a;
    return Math.max(a, b);
  }

  async stopDuplicatePhoneBots() {
    const byPhone = new Map();
    for (const id of [...this.bots.keys()]) {
      const phone = accountPhone(botAccountService.findById(id));
      if (!phone) continue;

      const existing = byPhone.get(phone);
      if (!existing) {
        byPhone.set(phone, id);
        continue;
      }

      const keep = this.pickPreferredBotId(existing, id);
      const drop = keep === existing ? id : existing;
      byPhone.set(phone, keep);
      logger.warn(`Stopping duplicate bot ${drop} on phone ${phone} (keeping bot ${keep})`);
      await this.stopBot(drop);
    }
  }

  getBot(botAccountId) {
    return this.bots.get(botAccountId) || null;
  }

  getBotForUser(dashboardUserId) {
    const account = botAccountService.findByDashboardUserId(dashboardUserId);
    if (!account) return null;
    return this.getBot(account.id);
  }

  isStarting(botAccountId) {
    return this.starting.has(botAccountId);
  }

  async startBot(botAccountId) {
    if (this.starting.has(botAccountId)) {
      return this.getBot(botAccountId);
    }

    const account = botAccountService.findById(botAccountId);
    if (!account) {
      throw new Error('Bot account not found');
    }

    const phone = accountPhone(account);
    const conflictingId = this.findBotForPhone(phone, botAccountId);
    if (phone && conflictingId) {
      const conflict = this.bots.get(conflictingId);
      if (conflict?.getStatus().ready) {
        logger.warn(
          `Refusing to start bot ${botAccountId} — bot ${conflictingId} already active for ${phone}`
        );
        return conflict;
      }
    }

    const existing = this.bots.get(botAccountId);
    if (existing) {
      const live = existing.getStatus();
      if (live.ready) {
        return existing;
      }
      if (existing.isInitializing || existing.isReconnecting) {
        return existing;
      }
      const stuckWithoutQr =
        existing &&
        !existing.hasAuthenticatedSession?.() &&
        [BOT_STATUS.CONNECTING, BOT_STATUS.QR_PENDING].includes(account.status) &&
        !account.last_qr &&
        !account.last_pairing_code &&
        existing.getLinkWaitedMs() >= existing.getQrGraceMs();
      if ([BOT_STATUS.CONNECTING, BOT_STATUS.QR_PENDING].includes(account.status) && !stuckWithoutQr) {
        return existing;
      }
      if (stuckWithoutQr) {
        logger.warn(`Bot ${botAccountId} stuck without QR — recycling client`);
      }
      await this.stopBot(botAccountId, { logout: false });
    }

    this.starting.add(botAccountId);
    botAccountService.updateStatus(botAccountId, BOT_STATUS.CONNECTING);

    try {
      const bot = new WhatsAppBot({
        botAccountId,
        sessionClientId: account.session_client_id,
      });

      this.bots.set(botAccountId, bot);
      await bot.initialize();
      return bot;
    } catch (error) {
      botAccountService.updateStatus(botAccountId, BOT_STATUS.ERROR, {
        lastError: error.message,
      });
      this.bots.delete(botAccountId);
      throw error;
    } finally {
      this.starting.delete(botAccountId);
    }
  }

  async stopBot(botAccountId, { logout = true } = {}) {
    const bot = this.bots.get(botAccountId);
    const account = botAccountService.findById(botAccountId);
    if (bot) {
      logger.info(`Stopping bot account ${botAccountId} (requested disconnect, logout=${logout})`);
      await bot.shutdown({ logout });
      this.bots.delete(botAccountId);
    } else if (logout && account) {
      const sessionDir = path.join(
        process.cwd(),
        '.wwebjs_auth',
        `session-${account.session_client_id || 'default'}`
      );
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        logger.info(`Cleared WhatsApp session files for bot ${botAccountId}`);
      } catch (error) {
        logger.warn(`Could not clear session for bot ${botAccountId}: ${error.message}`);
      }
    }
    botAccountService.updateStatus(botAccountId, BOT_STATUS.DISCONNECTED, {
      lastQr: null,
      lastPairingCode: null,
      lastError: null,
      clearWhatsappPhone: logout,
    });
  }

  async startReadyBots() {
    const { getDatabase } = require('../database/db');
    const db = getDatabase();
    const accounts = botAccountService.listReadyBots();
    const startedPhones = new Set();

    const staggerMs = Math.max(
      0,
      Number(process.env.WHATSAPP_BOT_START_STAGGER_MS) || 25000
    );

    for (const account of accounts) {
      const phone = accountPhone(account);
      if (phone && startedPhones.has(phone)) {
        logger.info(`Skipping bot ${account.id} — phone ${phone} already auto-started`);
        continue;
      }
      try {
        if (startedPhones.size > 0 && staggerMs > 0) {
          logger.info(
            `Staggering WhatsApp start for bot ${account.id} by ${staggerMs}ms`
          );
          await sleep(staggerMs);
        }
        await this.startBot(account.id);
        if (phone) startedPhones.add(phone);
        logger.info(`Auto-started bot account ${account.id}`);
      } catch (error) {
        logger.warn(`Failed to auto-start bot ${account.id}: ${error.message}`);
      }
    }

    const legacy = botAccountService.findById(1);
    const legacyPhone = accountPhone(legacy);
    if (legacy && legacyPhone) {
      const otherOwner = db
        .prepare(
          `SELECT id FROM bot_accounts
           WHERE id != 1 AND (whatsapp_phone = ? OR last_whatsapp_phone = ?)
           ORDER BY id DESC
           LIMIT 1`
        )
        .get(legacyPhone, legacyPhone);

      if (otherOwner) {
        logger.info(
          `Skipping legacy bot 1 auto-start — bot ${otherOwner.id} registered for ${legacyPhone}`
        );
        if (this.bots.has(1)) {
          await this.stopBot(1);
        }
        if (!this.bots.has(otherOwner.id) && !startedPhones.has(legacyPhone)) {
          try {
            await this.startBot(otherOwner.id);
            startedPhones.add(legacyPhone);
            logger.info(`Auto-started owning bot account ${otherOwner.id}`);
          } catch (error) {
            logger.warn(`Failed to auto-start owning bot ${otherOwner.id}: ${error.message}`);
          }
        }
        await this.stopDuplicatePhoneBots();
        return;
      }
    }

    if (
      legacy &&
      !this.bots.has(legacy.id) &&
      !(legacyPhone && (startedPhones.has(legacyPhone) || this.findBotForPhone(legacyPhone)))
    ) {
      try {
        await this.startBot(legacy.id);
      } catch (error) {
        logger.warn(`Failed to start primary bot: ${error.message}`);
      }
    } else if (legacy && legacyPhone && (startedPhones.has(legacyPhone) || this.findBotForPhone(legacyPhone))) {
      logger.info(`Skipping legacy bot 1 auto-start — phone ${legacyPhone} already managed`);
    }

    await this.stopDuplicatePhoneBots();
  }

  async requestPairingCode(botAccountId, phoneNumber) {
    await this.prepareLinkMode(botAccountId, 'code');
    const bot = this.getBot(botAccountId);

    if (!bot) {
      throw new Error('Could not start WhatsApp client');
    }

    return bot.requestPairingCode(phoneNumber);
  }

  isLinkStuck(botAccountId) {
    const account = botAccountService.findById(botAccountId);
    const bot = this.getBot(botAccountId);
    if (!account || !bot) return false;
    if (bot.getStatus().ready || bot.isInitializing || bot.isReconnecting || bot._qrRestartInFlight) {
      return false;
    }
    if (bot.hasAuthenticatedSession?.()) {
      return bot.isAuthSyncStuck?.() ?? false;
    }
    if (account.status === BOT_STATUS.DISCONNECTED) return false;

    const startedAt = bot._linkStartedAt;
    if (startedAt && Date.now() - startedAt < qrGraceMs()) {
      return false;
    }

    return (
      (account.status === BOT_STATUS.QR_PENDING || account.status === BOT_STATUS.CONNECTING) &&
      !account.last_qr &&
      !account.last_pairing_code
    );
  }

  async prepareLinkMode(botAccountId, mode, { force = false } = {}) {
    const linkMode = mode === 'code' ? 'code' : 'qr';
    const wantsRecovery = force || (linkMode === 'qr' && this.isLinkStuck(botAccountId));

    if (wantsRecovery) {
      const existing = this.getBot(botAccountId);
      if (existing?.isInitializing || existing?._qrRestartInFlight) {
        return existing.getStatus();
      }

      // Never interrupt post-QR sync — recovery would tear down a valid in-progress login.
      if (existing?.hasAuthenticatedSession?.() && !existing.getStatus().ready) {
        if (!force) {
          logger.info(`Skipping link recovery — bot ${botAccountId} is syncing after QR scan`);
          return existing.getStatus();
        }
        const syncMs = existing.getAuthSyncMs?.() ?? 0;
        const minForceMs = parseInt(process.env.WHATSAPP_AUTH_SYNC_STUCK_MS, 10) || 600000;
        if (syncMs < minForceMs) {
          logger.info(
            `Skipping forced link recovery — bot ${botAccountId} still syncing (${Math.round(syncMs / 1000)}s)`
          );
          return existing.getStatus();
        }
      }

      const now = Date.now();
      const lastRecovery = this._lastLinkRecoveryAt.get(botAccountId) || 0;
      const cooldown = force ? 15000 : linkRecoveryCooldownMs();
      if (now - lastRecovery < cooldown) {
        if (existing) return existing.getStatus();
      }

      this._lastLinkRecoveryAt.set(botAccountId, now);
      logger.info(`Recovering stuck link for bot ${botAccountId} (force=${force})`);
      let bot = this.getBot(botAccountId);
      const account = botAccountService.findById(botAccountId);
      const clearSession = force || account?.status === BOT_STATUS.DISCONNECTED;
      if (bot) {
        await bot.restartForQrLink({ clearSession });
        return bot.getStatus();
      }
      await this.startBot(botAccountId);
      bot = this.getBot(botAccountId);
      if (bot) return bot.getStatus();
      throw new Error('Could not start WhatsApp client');
    }

    let bot = this.getBot(botAccountId);
    if (!bot) {
      await this.startBot(botAccountId);
      bot = this.getBot(botAccountId);
    }

    if (!bot) {
      throw new Error('Could not start WhatsApp client');
    }

    for (let i = 0; i < 90 && bot.isInitializing; i += 1) {
      await sleep(1000);
    }

    if (bot.isInitializing) {
      throw new Error('WhatsApp is still starting. Wait a few seconds and try again.');
    }

    await bot.prepareAuthMode(linkMode);
    return bot.getStatus();
  }

  getPairingCode(botAccountId) {
    const bot = this.getBot(botAccountId);
    if (bot && bot.authMode !== 'code') return null;
    if (bot?.pairingCode) return bot.pairingCode;
    const account = botAccountService.findById(botAccountId);
    if (bot?.authMode === 'code') {
      return account?.last_pairing_code || null;
    }
    return null;
  }

  getStatus(botAccountId) {
    const bot = this.getBot(botAccountId);
    const account = botAccountService.findById(botAccountId);
    const pairingCode = this.getPairingCode(botAccountId);
    const qrAllowed = !bot || bot.authMode === 'qr';
    const accountDisconnected = account?.status === BOT_STATUS.DISCONNECTED;
    const liveFromBot = bot
      ? {
          ...bot.getStatus(),
          linkTiming: bot.linkTiming,
          linkWaitedMs: bot.getLinkWaitedMs?.() ?? null,
        }
      : { ready: false, reconnectAttempts: 0, authenticated: false, authPhase: 'linking' };
    const live = accountDisconnected
      ? {
          ...liveFromBot,
          ready: false,
          authenticated: false,
          authPhase: 'linking',
          authSyncMs: 0,
        }
      : liveFromBot;
    return {
      ...botAccountService.toPublic(account),
      status: accountDisconnected ? BOT_STATUS.DISCONNECTED : account?.status,
      live,
      hasQr: qrAllowed && Boolean(account?.last_qr && account?.status === BOT_STATUS.QR_PENDING),
      pairingCode,
      authMode: bot?.authMode || 'qr',
    };
  }

  getQrDataUrl(botAccountId) {
    const bot = this.getBot(botAccountId);
    if (bot && bot.authMode !== 'qr') return null;
    const account = botAccountService.findById(botAccountId);
    if (!account?.last_qr) return null;
    return account.last_qr;
  }

  getAnyReadyBot() {
    for (const bot of this.bots.values()) {
      if (bot.getStatus().ready) return bot;
    }
    return null;
  }

  async shutdownAll() {
    const ids = [...this.bots.keys()];
    for (const id of ids) {
      await this.stopBot(id, { logout: false });
    }
  }
}

module.exports = new BotManager();
