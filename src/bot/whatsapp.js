const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');

const qrcodeTerminal = require('qrcode-terminal');

const QRCode = require('qrcode');

const MessageHandler = require('./messageHandler');

const logger = require('../utils/logger');
const { MAX_REPLY_DELAY_SECONDS } = require('../utils/constants');

const { RECONNECT_DELAY_MS, MAX_RECONNECT_ATTEMPTS } = require('../utils/constants');

const { sleep, normalizePhone } = require('../utils/helpers');

const { sendWhatsAppText } = require('../utils/whatsappSend');

const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');

const {

  clearStaleChromiumLocks,

  isRecoverableBrowserError,

  isBrowserTargetClosedError,

} = require('../utils/chromiumProfile');

const chatProfileService = require('../services/chatProfileService');

const { botAccountService, BOT_STATUS } = require('../services/botAccountService');

function resolveWebVersionCache() {
  const localPath =
    process.env.WHATSAPP_WEB_VERSION_LOCAL_PATH ||
    path.join(__dirname, 'wa-web-version.html');
  const preferLocal = process.env.WHATSAPP_WEB_VERSION_LOCAL === 'true';
  if (preferLocal && fs.existsSync(localPath)) {
    return { type: 'local', path: localPath };
  }

  if (process.env.WHATSAPP_WEB_VERSION_URL) {
    return { type: 'remote', remotePath: process.env.WHATSAPP_WEB_VERSION_URL };
  }

  // No pin by default. whatsapp-web.js's injected page hooks (Store/module
  // lookups) haven't shipped an update in months, while WhatsApp Web's live
  // build changes almost daily — pinning to a manually-picked archived
  // snapshot is a guess at compatibility, not an improvement over it. Loading
  // whatever WhatsApp is actually serving live also can't expire. Set
  // WHATSAPP_WEB_VERSION_URL only if login regresses after a WhatsApp Web
  // release and an older pinned build is confirmed to work better.
  return { type: 'none' };
}



class WhatsAppBot {

  constructor({ botAccountId, sessionClientId = 'default' } = {}) {

    this.botAccountId = botAccountId;

    this.sessionClientId = sessionClientId;

    this.client = null;

    this.messageHandler = null;

    this.isReady = false;

    this.reconnectAttempts = 0;

    this.isInitializing = false;

    this.isReconnecting = false;

    this.isShuttingDown = false;

    this.myWhatsAppId = null;

    this.selfChatId = null;

    this.processedMessageIds = new Set();

    this.botSentMessageIds = new Set();

    this.recentBotReplyBodies = new Set();

    this.deferredSyncTimer = null;

    this.pairingCode = null;

    /** @type {'qr' | 'code'} */
    this.authMode = 'qr';

    this._browserQueue = Promise.resolve();
    this._browserTaskActive = false;
    this._currentBrowserTaskLabel = null;
    this._syncAbortRequested = false;
    this._lastInboundMessageAt = 0;
    this._browserHighQueue = [];
    this._browserNormalQueue = [];
    this._linkStartedAt = null;
    this.linkTiming = { launch_ms: null, qr_ms: null, ready_ms: null };
    this._qrRestartInFlight = false;
    this._authenticatedAt = null;
    this._readyWatchdog = null;
    this._promotingReady = false;
    this._wwebjsInjecting = null;
    this._waListenersAttached = false;
    this._waListenersAttaching = null;
    this._inboundHookWatchdog = null;
  }

  getQrGraceMs() {
    return parseInt(process.env.WHATSAPP_QR_GRACE_MS, 10) || 45000;
  }

  getLinkWaitedMs() {
    return this._linkStartedAt ? Date.now() - this._linkStartedAt : 0;
  }

  hasAuthenticatedSession() {
    return Boolean(this._authenticatedAt);
  }

  getAuthSyncMs() {
    return this._authenticatedAt ? Date.now() - this._authenticatedAt : 0;
  }

  isAuthSyncStuck() {
    const stuckMs = parseInt(process.env.WHATSAPP_AUTH_SYNC_STUCK_MS, 10) || 600000;
    return Boolean(this._authenticatedAt) && !this.isReady && this.getAuthSyncMs() >= stuckMs;
  }

  async patchResilientGetChats() {
    if (!this.client?.pupPage || this.isShuttingDown) return false;

    try {
      const applied = await this.client.pupPage.evaluate(() => {
        if (!window.WWebJS || typeof window.WWebJS.getChats !== 'function') return false;
        if (window.__pulseGetChatsPatched) return true;

        // Default WWebJS.getChats uses Promise.all(getChatModel) — one broken
        // group/channel/LID chat rejects the whole sync with a cryptic error ("r").
        window.WWebJS.getChats = async () => {
          const chats =
            window.require('WAWebCollections').Chat.getModelsArray() || [];
          const Contact = window.require('WAWebCollections').Contact;
          let toPn = null;
          try {
            toPn = window.require('WAWebLidMigrationUtils').toPn;
          } catch (_) {
            toPn = null;
          }

          const enrichLite = (chat, model) => {
            const id = chat?.id?._serialized || model?.id?._serialized || '';
            let contact = null;
            try {
              contact = chat.contact || Contact.get(chat.id) || null;
            } catch (_) {
              contact = null;
            }

            const title =
              chat.formattedTitle ||
              chat.name ||
              contact?.name ||
              contact?.pushname ||
              contact?.shortName ||
              model.formattedTitle ||
              model.name ||
              '';
            model.formattedTitle = title;
            model.name = title;
            model.pushname = contact?.pushname || model.pushname || '';

            let phone = '';
            try {
              if (typeof toPn === 'function' && chat.id) {
                const pn = toPn(chat.id);
                phone = pn?.user || String(pn?._serialized || '').split('@')[0] || '';
              }
            } catch (_) {
              phone = '';
            }
            if (!phone && id.endsWith('@c.us')) {
              phone = chat?.id?.user || '';
            }
            if (!phone) {
              phone = contact?.userid || contact?.number || contact?.phoneNumber || '';
            }
            if (phone) {
              model.contactPhone = String(phone).replace(/\D/g, '');
              model.number = model.contactPhone;
            }
            return model;
          };

          const results = [];

          for (const chat of chats) {
            try {
              const id = chat?.id?._serialized || '';
              const isGroup =
                Boolean(chat?.groupMetadata) || String(id).endsWith('@g.us');
              const isChannel =
                Boolean(chat?.newsletterMetadata) ||
                String(id).includes('@newsletter');

              if (isGroup || isChannel) {
                const model =
                  typeof chat.serialize === 'function' ? chat.serialize() : {};
                model.id = model.id || chat.id;
                model.isGroup = isGroup;
                model.isChannel = isChannel;
                model.formattedTitle =
                  chat.formattedTitle || chat.name || model.formattedTitle || '';
                model.name = model.formattedTitle || model.name || '';
                results.push(model);
                continue;
              }

              try {
                const model = await window.WWebJS.getChatModel(chat);
                results.push(enrichLite(chat, model || {}));
              } catch (_) {
                const model =
                  typeof chat.serialize === 'function' ? chat.serialize() : {};
                model.id = model.id || chat.id;
                model.isGroup = false;
                model.isChannel = false;
                if (model.id) results.push(enrichLite(chat, model));
              }
            } catch (_) {
              // skip unreadable chat rows
            }
          }

          return results;
        };

        window.__pulseGetChatsPatched = true;
        return true;
      });
      return Boolean(applied);
    } catch (error) {
      logger.warn(
        `Resilient getChats patch failed (bot ${this.botAccountId}): ${error.message}`
      );
      return false;
    }
  }

  async ensureWWebJsInjected() {
    if (!this.client?.pupPage || this.isShuttingDown) return false;

    const already = await this.client.pupPage
      .evaluate(() => typeof window.WWebJS !== 'undefined' && typeof window.WWebJS.getChat === 'function')
      .catch(() => false);
    if (already) {
      await this.patchResilientGetChats();
      return true;
    }

    if (this._wwebjsInjecting) {
      return this._wwebjsInjecting;
    }

    this._wwebjsInjecting = (async () => {
      try {
        logger.info(`Injecting WWebJS for bot ${this.botAccountId}…`);
        await this.client.pupPage.evaluate(LoadUtils);

        const deadline = Date.now() + (parseInt(process.env.WHATSAPP_WWEBJS_READY_MS, 10) || 90000);
        while (Date.now() < deadline) {
          const ok = await this.client.pupPage
            .evaluate(() => typeof window.WWebJS !== 'undefined' && typeof window.WWebJS.getChat === 'function')
            .catch(() => false);
          if (ok) {
            await this.patchResilientGetChats();
            logger.info(`WWebJS ready for bot ${this.botAccountId}`);
            return true;
          }
          await sleep(300);
        }
        logger.warn(`WWebJS injection timed out for bot ${this.botAccountId}`);
        return false;
      } catch (error) {
        logger.warn(`WWebJS injection failed (bot ${this.botAccountId}): ${error.message}`);
        return false;
      } finally {
        this._wwebjsInjecting = null;
      }
    })();

    return this._wwebjsInjecting;
  }

  /**
   * whatsapp-web.js only calls attachEventListeners() when WWebJS was NOT already
   * present at hasSynced. Our early inject can skip that path. Even when we call
   * attachEventListeners(), WhatsApp often reloads afterward and drops the in-page
   * Msg.on('add') hook while Node still thinks listeners are attached.
   */
  async ensureWhatsAppListenersAttached() {
    if (!this.client?.pupPage || this.isShuttingDown) return false;

    const pageHooked = await this.client.pupPage
      .evaluate(
        () =>
          Boolean(
            window.__pulseWaMsgHooked &&
              typeof window.onAddMessageEvent === 'function' &&
              window.WWebJS &&
              typeof window.WWebJS.getMessageModel === 'function'
          )
      )
      .catch(() => false);

    if (pageHooked) {
      this._waListenersAttached = true;
      return true;
    }

    this._waListenersAttached = false;
    if (this._waListenersAttaching) return this._waListenersAttaching;

    this._waListenersAttaching = (async () => {
      const maxAttempts = 6;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          if (!this.client?.pupPage || this.client.pupPage.isClosed?.()) {
            await sleep(1000);
            continue;
          }

          await this.ensureWWebJsInjected();

          const hasBridge = await this.client.pupPage
            .evaluate(() => typeof window.onAddMessageEvent === 'function')
            .catch(() => false);

          if (!hasBridge && typeof this.client.attachEventListeners === 'function') {
            if (attempt === 1) {
              logger.info(`Attaching WhatsApp event listeners for bot ${this.botAccountId}…`);
            }
            await this.client.attachEventListeners();
          }

          // Ensure client.info is populated for send/getChat paths.
          if (!this.client.info?.wid?._serialized && this.client.pupPage) {
            const info = await this.client.pupPage
              .evaluate(() => {
                try {
                  return {
                    ...window.require('WAWebConnModel').Conn.serialize(),
                    wid:
                      window.require('WAWebUserPrefsMeUser').getMaybeMePnUser() ||
                      window.require('WAWebUserPrefsMeUser').getMaybeMeLidUser(),
                  };
                } catch {
                  return null;
                }
              })
              .catch(() => null);

            if (info?.wid) {
              try {
                const ClientInfo = require('whatsapp-web.js/src/structures/ClientInfo');
                this.client.info = new ClientInfo(this.client, info);
              } catch {
                this.client.info = { wid: info.wid, pushname: info.pushname };
              }
            }
          }

          if (!this.client.interface) {
            try {
              const InterfaceController = require('whatsapp-web.js/src/util/InterfaceController');
              this.client.interface = new InterfaceController(this.client);
            } catch (_) {
              // optional helper
            }
          }

          const hooked = await this.installInboundMessageHook();
          if (!hooked) {
            if (attempt < maxAttempts) {
              await sleep(1000 * attempt);
              continue;
            }
            logger.warn(`WhatsApp Msg.add hook not confirmed (bot ${this.botAccountId})`);
            return false;
          }

          this._waListenersAttached = true;
          this.startInboundHookWatchdog();
          logger.info(`WhatsApp event listeners ready for bot ${this.botAccountId}`);
          return true;
        } catch (error) {
          const msg = String(error?.message || error || '');
          const transient =
            msg.includes('Target closed') ||
            msg.includes('Session closed') ||
            msg.includes('Execution context was destroyed') ||
            msg.includes('Protocol error');
          if (transient && attempt < maxAttempts) {
            logger.warn(
              `Listener attach attempt ${attempt}/${maxAttempts} failed (bot ${this.botAccountId}): ${msg}`
            );
            await sleep(1000 * attempt);
            continue;
          }
          logger.warn(`Failed to attach WhatsApp listeners (bot ${this.botAccountId}): ${msg}`);
          return false;
        }
      }
      return false;
    })().finally(() => {
      this._waListenersAttaching = null;
    });

    return this._waListenersAttaching;
  }

  /**
   * Idempotent in-page hook: WhatsApp Msg collection → onAddMessageEvent.
   * Survives library attach races; must be re-run after WhatsApp Web reloads.
   */
  async installInboundMessageHook() {
    if (!this.client?.pupPage) return false;

    return this.client.pupPage
      .evaluate(() => {
        if (
          window.__pulseWaMsgHooked &&
          typeof window.onAddMessageEvent === 'function' &&
          window.WWebJS &&
          typeof window.WWebJS.getMessageModel === 'function'
        ) {
          return true;
        }

        try {
          const Msg = window.require('WAWebCollections').Msg;
          if (!Msg || typeof Msg.on !== 'function') return false;
          if (typeof window.onAddMessageEvent !== 'function') return false;
          if (!window.WWebJS || typeof window.WWebJS.getMessageModel !== 'function') return false;

          Msg.on('add', (msg) => {
            if (!msg || !msg.isNewMsg) return;
            try {
              if (msg.type === 'ciphertext') {
                if (typeof window.onAddMessageCiphertextEvent === 'function') {
                  window.onAddMessageCiphertextEvent(window.WWebJS.getMessageModel(msg));
                }
                return;
              }
              window.onAddMessageEvent(window.WWebJS.getMessageModel(msg));
            } catch (err) {
              console.error('pulse inbound hook error', err);
            }
          });

          window.__pulseWaMsgHooked = true;
          return true;
        } catch (err) {
          console.error('pulse install inbound hook failed', err);
          return false;
        }
      })
      .catch((error) => {
        logger.warn(`installInboundMessageHook failed (bot ${this.botAccountId}): ${error.message}`);
        return false;
      });
  }

  startInboundHookWatchdog() {
    if (this._inboundHookWatchdog) return;

    this._inboundHookWatchdog = setInterval(() => {
      if (this.isShuttingDown || !this.client?.pupPage) {
        this.clearInboundHookWatchdog();
        return;
      }
      if (!this.isReady) return;

      this.ensureWhatsAppListenersAttached().catch((error) => {
        logger.warn(`Inbound hook watchdog (bot ${this.botAccountId}): ${error.message}`);
      });
    }, 15000);
  }

  clearInboundHookWatchdog() {
    if (this._inboundHookWatchdog) {
      clearInterval(this._inboundHookWatchdog);
      this._inboundHookWatchdog = null;
    }
  }

  isIntentionalDisconnect(reason) {
    const r = String(reason || '').toUpperCase();
    return (
      r.includes('LOGOUT') ||
      r.includes('UNPAIR') ||
      r.includes('NAVIGATION') ||
      r.includes('CONFLICT') ||
      (r.includes('MAX') && r.includes('QR'))
    );
  }

  clearReadyWatchdog() {
    if (this._readyWatchdog) {
      clearInterval(this._readyWatchdog);
      this._readyWatchdog = null;
    }
  }

  startReadyWatchdog() {
    this.clearReadyWatchdog();
    let attempts = 0;
    const maxAttempts = parseInt(process.env.WHATSAPP_READY_WATCHDOG_ATTEMPTS, 10) || 200;

    this._readyWatchdog = setInterval(() => {
      attempts += 1;
      if (this.isReady || this.isShuttingDown) {
        this.clearReadyWatchdog();
        return;
      }
      if (attempts > maxAttempts) {
        this.clearReadyWatchdog();
        if (this._authenticatedAt && !this.isReady) {
          logger.warn(
            `Auth sync timed out for bot ${this.botAccountId} after ${Math.round((maxAttempts * 3) / 60)} min — restarting QR`
          );
          this._authenticatedAt = null;
          this.restartForQrLink({ clearSession: true }).catch((error) => {
            logger.error(`Auth sync QR restart failed (bot ${this.botAccountId}): ${error.message}`);
          });
        }
        return;
      }
      this.promoteToReadyIfPossible('watchdog').catch(() => {});
    }, 3000);
  }

  async promoteToReadyIfPossible(source = 'unknown') {
    if (this.isReady || this.isShuttingDown || this._promotingReady || !this.client) {
      return false;
    }

    try {
      let wid = this.client.info?.wid?._serialized;
      if (!wid && this.client.pupPage) {
        wid = await this.client.pupPage.evaluate(() => {
          try {
            const user =
              window.require('WAWebUserPrefsMeUser').getMaybeMePnUser() ||
              window.require('WAWebUserPrefsMeUser').getMaybeMeLidUser();
            return user?._serialized || user?.user || null;
          } catch {
            return null;
          }
        });
      }

      if (wid) {
        let injected = this.client.pupPage
          ? await this.client.pupPage
              .evaluate(() =>
                Boolean(
                  window.WWebJS &&
                    typeof window.WWebJS.getChat === 'function' &&
                    typeof window.WWebJS.sendMessage === 'function' &&
                    window.require &&
                    window.require('WAWebCollections')?.Chat
                )
              )
              .catch(() => false)
          : false;

        if (!injected) {
          injected = await this.ensureWWebJsInjected();
        }

        if (!injected) {
          if (this._authenticatedAt) {
            logger.info(
              `Ready promotion waiting (bot ${this.botAccountId}, ${source}): wid resolved but WWebJS not yet injected`
            );
          }
          return false;
        }

        const listenersOk = await this.ensureWhatsAppListenersAttached();
        if (!listenersOk) {
          logger.info(
            `Ready promotion waiting (bot ${this.botAccountId}, ${source}): event listeners not attached yet`
          );
          return false;
        }

        if (!this.client.info?.wid?._serialized) {
          this.client.info = this.client.info || {};
          this.client.info.wid = { _serialized: wid };
        }
        await this.onClientReady(source);
        return true;
      }

      if (this._authenticatedAt) {
        const state = await this.client.getState().catch(() => 'unknown');
        logger.info(`Ready promotion waiting (bot ${this.botAccountId}, ${source}): state=${state}`);
      }
      return false;
    } catch (error) {
      logger.warn(`Ready promotion failed (bot ${this.botAccountId}, ${source}): ${error.message}`);
      return false;
    }
  }

  async onClientReady(source = 'ready') {
    if (this.isReady || this._promotingReady || !this.client) return;

    this._promotingReady = true;
    try {
      // Library may skip attachEventListeners when WWebJS was injected early.
      await this.ensureWhatsAppListenersAttached();

      this.isReady = true;
      this.reconnectAttempts = 0;
      this.clearReadyWatchdog();

      if (this._linkStartedAt && this.linkTiming.ready_ms == null) {
        this.linkTiming.ready_ms = Date.now() - this._linkStartedAt;
      }

      this.myWhatsAppId = this.client.info?.wid?._serialized || null;
      const ownerPhone = normalizePhone(this.myWhatsAppId);

      logger.info(
        `WhatsApp ready (bot ${this.botAccountId}, source=${source}, id: ${this.myWhatsAppId || 'unknown'})`
      );

      if (this.botAccountId) {
        botAccountService.updateStatus(this.botAccountId, BOT_STATUS.READY, {
          whatsappPhone: ownerPhone,
          lastQr: null,
          lastError: null,
          lastPairingCode: null,
        });

        const botConfigService = require('../services/botConfigService');
        const bot = botAccountService.findById(this.botAccountId);
        if (bot) {
          botConfigService.applyRuntimeConfig(bot);
          botAccountService.syncToWhatsAppUser(bot);
        }

        if (ownerPhone) {
          const userService = require('../services/userService');
          const chatProfileService = require('../services/chatProfileService');
          userService.getOrCreate(ownerPhone);
          chatProfileService
            .ensureSelfChatProfile(this.client, ownerPhone)
            .catch((error) =>
              logger.warn(`Self-chat profile setup failed (bot ${this.botAccountId}): ${error.message}`)
            );
        }
      }

      if (this.myWhatsAppId && process.env.CHAT_SYNC_ON_READY !== 'false') {
        this.scheduleDeferredChatSync(ownerPhone);
      }
    } finally {
      this._promotingReady = false;
    }
  }

  noteInboundActivity() {
    this._lastInboundMessageAt = Date.now();
    this.clearDeferredChatSync();
    this.requestSyncAbort();
  }

  requestSyncAbort() {
    this._syncAbortRequested = true;
  }

  shouldAbortSync() {
    return this._syncAbortRequested || this._browserHighQueue.length > 0;
  }



  getPuppeteerConfig() {
    const chromiumJsHeapMb = parseInt(process.env.CHROMIUM_JS_HEAP_MB, 10) || 768;
    return {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      protocolTimeout: parseInt(process.env.PUPPETEER_PROTOCOL_TIMEOUT, 10) || 600000,
      timeout: parseInt(process.env.PUPPETEER_LAUNCH_TIMEOUT, 10) || 300000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-breakpad',
        '--disable-crash-reporter',
        '--disable-crashpad',
        '--noerrdialogs',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-extensions',
        '--disable-features=IsolateOrigins,site-per-process',
        `--js-flags=--max-old-space-size=${chromiumJsHeapMb}`,
        '--renderer-process-limit=2',
        '--window-size=1280,720',
      ],
    };
  }



  runBrowserTask(label, fn, { priority = 'normal' } = {}) {
    // Re-entrant: inbound_message already holds the browser lock and then calls
    // sendMessage / typing. Queuing those would deadlock forever.
    if (this._browserTaskActive) {
      logger.info(`Browser task nested: ${label} (inside ${this._currentBrowserTaskLabel})`);
      return Promise.resolve().then(() => fn());
    }

    return new Promise((resolve, reject) => {
      const job = { label, fn, resolve, reject };
      if (priority === 'high') {
        this._browserHighQueue.push(job);
        if (
          this._browserTaskActive &&
          (this._currentBrowserTaskLabel === 'deferred_sync' ||
            this._currentBrowserTaskLabel === 'dashboard_sync')
        ) {
          this.requestSyncAbort();
        }
      } else {
        this._browserNormalQueue.push(job);
      }
      this._pumpBrowserQueue();
    });
  }

  _pumpBrowserQueue() {
    if (this._browserTaskActive) return;

    const job = this._browserHighQueue.shift() || this._browserNormalQueue.shift();
    if (!job) return;

    this._browserTaskActive = true;
    this._currentBrowserTaskLabel = job.label;
    (async () => {
      if (this.isShuttingDown) {
        job.reject(new Error(`Browser task "${job.label}" skipped — bot shutting down`));
        return;
      }

      logger.info(`Browser task start: ${job.label}`);
      try {
        const result = await job.fn();
        job.resolve(result);
      } catch (error) {
        job.reject(error);
      } finally {
        logger.info(`Browser task end: ${job.label}`);
        this._browserTaskActive = false;
        this._currentBrowserTaskLabel = null;
        this._pumpBrowserQueue();
      }
    })();
  }



  createClient() {

    return new Client({

      authStrategy: new LocalAuth({

        clientId: this.sessionClientId,

        dataPath: '.wwebjs_auth',

      }),

      authTimeoutMs: parseInt(process.env.WHATSAPP_AUTH_TIMEOUT_MS, 10) || 300000,

      takeoverOnConflict: process.env.WHATSAPP_TAKEOVER_ON_CONFLICT === 'true',

      takeoverTimeoutMs: 15000,

      webVersionCache: resolveWebVersionCache(),

      puppeteer: this.getPuppeteerConfig(),

    });

  }



  async restartForQrLink({ clearSession = false } = {}) {
    if (this.isReady || this.isShuttingDown || this._qrRestartInFlight) return;

    this._qrRestartInFlight = true;
    logger.info(
      `Restarting QR link flow for bot ${this.botAccountId} (clearSession=${clearSession})`
    );

    try {
      for (let i = 0; i < 120 && this.isInitializing; i += 1) {
        await sleep(500);
      }

      this.authMode = 'qr';
      this.pairingCode = null;
      this._authenticatedAt = null;
      this.clearReadyWatchdog();
      this._linkStartedAt = Date.now();
      this.linkTiming = { launch_ms: null, qr_ms: null, ready_ms: null };

      if (this.botAccountId) {
        botAccountService.updateStatus(this.botAccountId, BOT_STATUS.CONNECTING, {
          lastQr: null,
          lastPairingCode: null,
          lastError: null,
        });
      }

      await this.teardownClient();
      if (clearSession) {
        this.clearLocalSession();
      }
      clearStaleChromiumLocks('.wwebjs_auth');
      await this.initialize();
    } finally {
      this._qrRestartInFlight = false;
    }
  }

  async prepareAuthMode(mode) {
    const next = mode === 'code' ? 'code' : 'qr';

    if (this.isReady) {
      this.authMode = next;
      return;
    }

    const account = this.botAccountId ? botAccountService.findById(this.botAccountId) : null;
    const missingQr = next === 'qr' && !account?.last_qr;

    if (this.authMode === next) {
      const waitedLongEnough = this.getLinkWaitedMs() >= this.getQrGraceMs();
      if (
        missingQr &&
        this.client &&
        !this.isInitializing &&
        !this.isReady &&
        !this._qrRestartInFlight &&
        !this._authenticatedAt &&
        waitedLongEnough
      ) {
        logger.info(`QR mode active but no QR stored — refreshing link (bot ${this.botAccountId})`);
        await this.restartForQrLink();
      }
      return;
    }

    this.authMode = next;

    if (!this.botAccountId) return;

    if (next === 'qr') {
      this.pairingCode = null;
      botAccountService.updateStatus(this.botAccountId, BOT_STATUS.QR_PENDING, {
        lastPairingCode: null,
        lastError: null,
      });
    } else {
      botAccountService.updateStatus(this.botAccountId, BOT_STATUS.QR_PENDING, {
        lastQr: null,
        lastError: null,
      });
    }

    if (!this.client || this.isShuttingDown) return;

    if (this._authenticatedAt) {
      logger.info(`Skipping cancelPairingCode during auth sync (bot ${this.botAccountId})`);
      return;
    }

    try {
      await this.runBrowserTask(`prepare_auth_${next}`, () => this.client.cancelPairingCode());
    } catch (error) {
      logger.warn(`prepareAuthMode(${next}): ${error.message}`);
    }
  }

  async storePairingCode(code) {
    if (!this.botAccountId || !code || this.authMode !== 'code') return;

    this.pairingCode = String(code).trim().toUpperCase();
    botAccountService.updateStatus(this.botAccountId, BOT_STATUS.QR_PENDING, {
      lastQr: null,
      lastError: null,
      lastPairingCode: this.pairingCode,
    });
  }

  async storeQr(qr) {
    if (!this.botAccountId || this.authMode !== 'qr') return;



    try {

      const dataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });

      botAccountService.updateStatus(this.botAccountId, BOT_STATUS.QR_PENDING, {

        lastQr: dataUrl,

        lastError: null,

        lastPairingCode: null,

      });

    } catch (error) {

      logger.error(`Failed to generate QR data URL: ${error.message}`);

      botAccountService.updateStatus(this.botAccountId, BOT_STATUS.QR_PENDING, {

        lastQr: qr,

      });

    }

  }



  setupEventHandlers() {

    this.client.on('qr', async (qr) => {
      if (this.authMode !== 'qr') return;

      if (this._linkStartedAt && this.linkTiming.qr_ms == null) {
        this.linkTiming.qr_ms = Date.now() - this._linkStartedAt;
      }

      logger.info(`QR code received for bot ${this.botAccountId} — scan with WhatsApp`);

      this.pairingCode = null;

      qrcodeTerminal.generate(qr, { small: true });

      await this.storeQr(qr);
    });

    this.client.on('code', async (code) => {
      if (this.authMode !== 'code') return;

      logger.info(`Pairing code received for bot ${this.botAccountId}`);

      await this.storePairingCode(code);
    });



    this.client.on('authenticated', () => {
      if (this._authenticatedAt && this.getAuthSyncMs() < 3000) {
        return;
      }

      logger.info(`WhatsApp authenticated (bot ${this.botAccountId})`);

      this._authenticatedAt = Date.now();
      this.reconnectAttempts = 0;

      if (this.botAccountId) {
        botAccountService.updateStatus(this.botAccountId, BOT_STATUS.CONNECTING, {
          lastQr: null,
        });
      }

      this.startReadyWatchdog();
      this.promoteToReadyIfPossible('authenticated').catch(() => {});
    });



    this.client.on('auth_failure', (message) => {
      logger.error(`WhatsApp auth failure (bot ${this.botAccountId}): ${message}`);

      this.isReady = false;
      this._authenticatedAt = null;
      this.clearLocalSession();

      if (this.botAccountId) {
        botAccountService.updateStatus(this.botAccountId, BOT_STATUS.DISCONNECTED, {
          lastError: String(message),
          lastQr: null,
          lastPairingCode: null,
          clearWhatsappPhone: true,
        });
      }
    });



    this.client.on('ready', async () => {
      await this.onClientReady('ready');
    });



    const handleIncomingMessage = async (message) => {
      const messageId = message.id?._serialized || message.id?.id;
      const preview = String(message.body || message.type || '').slice(0, 60);
      const from = String(message.from || '');

      // Drop noisy streams before they hit the browser-task queue / event loop.
      if (
        from === 'status@broadcast' ||
        from.endsWith('@broadcast') ||
        from.endsWith('@g.us') ||
        from.endsWith('@newsletter')
      ) {
        return;
      }

      if (messageId && this.botSentMessageIds.has(messageId)) {
        return;
      }

      if (messageId && this.processedMessageIds.has(messageId)) {
        return;
      }

      if (messageId) {
        this.processedMessageIds.add(messageId);

        if (this.processedMessageIds.size > 2000) {
          const keep = Array.from(this.processedMessageIds).slice(-1000);
          this.processedMessageIds = new Set(keep);
        }
      }

      logger.info(
        `WA inbound (bot ${this.botAccountId}): id=${messageId || 'n/a'} fromMe=${Boolean(message.fromMe)} from=${message.from || 'n/a'} type=${message.type || 'chat'} body="${preview}"`
      );

      this.noteInboundActivity();

      if (this.messageHandler) {

        try {

          await this.runBrowserTask('inbound_message', () =>
            this.messageHandler.handleMessage(message)
          );

        } catch (error) {

          if (isBrowserTargetClosedError(error)) {

            logger.warn(`Browser error while handling message (bot ${this.botAccountId}): ${error.message}`);

            this.markBrowserUnhealthy(error.message);

            return;

          }

          logger.warn(
            `Inbound message handling failed (bot ${this.botAccountId}): ${error.message}`
          );

        }

      }

    };



    this.client.on('message_create', handleIncomingMessage);



    this.client.on('disconnected', async (reason) => {
      const authSyncMs = this.getAuthSyncMs();
      this.isReady = false;
      this._authenticatedAt = null;

      const reasonStr = String(reason);
      logger.warn(`WhatsApp disconnected (bot ${this.botAccountId}): ${reasonStr}`);

      const intentional = this.isIntentionalDisconnect(reasonStr);
      const recentAuthLogout =
        intentional &&
        reasonStr.toUpperCase().includes('LOGOUT') &&
        authSyncMs > 0 &&
        authSyncMs < 120000;

      if (this.botAccountId) {
        botAccountService.updateStatus(this.botAccountId, BOT_STATUS.DISCONNECTED, {
          lastError: reasonStr,
          lastQr: null,
          lastPairingCode: null,
          clearWhatsappPhone: intentional && !recentAuthLogout,
        });
      }

      if (recentAuthLogout) {
        logger.warn(
          `LOGOUT ${Math.round(authSyncMs / 1000)}s after auth (bot ${this.botAccountId}) — keeping session, reconnecting`
        );
        this.scheduleReconnect(reasonStr);
        return;
      }

      if (intentional) {
        this.isShuttingDown = true;
        await this.teardownClient();
        this.clearLocalSession();
        this.isShuttingDown = false;
        return;
      }

      this.scheduleReconnect(reasonStr);
    });



    this.client.on('loading_screen', (percent, message) => {
      logger.info(`WhatsApp loading ${percent}% (bot ${this.botAccountId}): ${message || ''}`);

      // loading_screen only fires post-authentication, but the 'authenticated'
      // event has been observed not to fire on the Node side even though the
      // page itself is already past QR/pairing. Without this, prepareAuthMode()
      // thinks it's safe to call cancelPairingCode() on an already-linked
      // session (auth-mode toggles from the Connect page), which logs it out.
      if (!this._authenticatedAt) {
        logger.warn(
          `loading_screen fired without an 'authenticated' event (bot ${this.botAccountId}) — backfilling auth state`
        );
        this._authenticatedAt = Date.now();
        this.startReadyWatchdog();
      }

      // After load completes, WhatsApp often remounts collections — re-hook inbound.
      if (percent >= 99) {
        this._waListenersAttached = false;
        this.ensureWhatsAppListenersAttached()
          .then(() => this.promoteToReadyIfPossible('loading_screen'))
          .catch(() => {});
      }
    });

    this.client.on('change_state', (state) => {
      logger.info(`WhatsApp state (bot ${this.botAccountId}): ${state}`);
      if (state === 'CONNECTED') {
        this.promoteToReadyIfPossible('change_state').catch(() => {});
      }
    });

  }



  clearDeferredChatSync() {

    if (this.deferredSyncTimer) {

      clearTimeout(this.deferredSyncTimer);

      this.deferredSyncTimer = null;

    }

  }



  scheduleDeferredChatSync(ownerPhone) {

    this.clearDeferredChatSync();

    const delayMs = parseInt(process.env.CHAT_SYNC_DELAY_MS, 10) || 90000;

    this.deferredSyncTimer = setTimeout(() => {

      this.deferredSyncTimer = null;

      const idleMs = Date.now() - (this._lastInboundMessageAt || 0);
      if (idleMs < 120000) {
        this.scheduleDeferredChatSync(ownerPhone);
        return;
      }

      if (this._browserHighQueue.length > 0) {
        this.scheduleDeferredChatSync(ownerPhone);
        return;
      }

      this.runDeferredChatSync(ownerPhone).catch((error) => {

        logger.warn(`Deferred chat sync failed (bot ${this.botAccountId}): ${error.message}`);

      });

    }, delayMs);

  }



  async runDeferredChatSync(ownerPhone) {

    if (!this.isReady || !this.client || this.isShuttingDown) return;

    if (this._browserHighQueue.length > 0) return;

    if (Date.now() - (this._lastInboundMessageAt || 0) < 120000) return;

    this._syncAbortRequested = false;

    try {

      await this.runBrowserTask('deferred_sync', () =>
        chatProfileService.syncPersonalChats(this.client, ownerPhone, {
          lightweight: true,
          maxChats: 50,
          getChatsTimeoutMs: 20000,
          timeoutMs: 90000,
          batchDelayMs: 0,
          shouldAbort: () => this.shouldAbortSync(),
        })
      );

    } catch (error) {

      logger.warn(`Deferred sync skipped (bot ${this.botAccountId}): ${error.message}`);

    }

  }



  markBrowserUnhealthy(reason = 'Browser disconnected') {
    if (this.isShuttingDown) return;

    const message = String(reason);
    logger.warn(`Browser unhealthy (bot ${this.botAccountId}): ${message}`);
    this.isReady = false;

    if (this.botAccountId) {
      botAccountService.updateStatus(this.botAccountId, BOT_STATUS.CONNECTING, {
        lastError: null,
      });
    }

    this.scheduleReconnect('browser_unhealthy');
  }



  scheduleReconnect(reason = 'unknown') {

    if (this.isShuttingDown) {

      return;

    }

    // initialize() often fails while handleReconnect() is still active.
    // Queue the retry so it runs after isReconnecting flips back to false.
    if (this.isReconnecting) {
      this._pendingReconnectReason = reason || 'unknown';
      return;
    }

    setImmediate(() => {

      this.handleReconnect(reason).catch((error) => {

        logger.error(`Reconnect scheduling failed (bot ${this.botAccountId}): ${error.message}`);

      });

    });

  }



  clearLocalSession() {
    const sessionDir = path.join(
      process.cwd(),
      '.wwebjs_auth',
      `session-${this.sessionClientId || 'default'}`
    );
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      logger.info(`Cleared WhatsApp session files for bot ${this.botAccountId} (${sessionDir})`);
    } catch (error) {
      logger.warn(`Could not clear session dir (bot ${this.botAccountId}): ${error.message}`);
    }
  }



  async teardownClient() {

    this.clearDeferredChatSync();
    this.clearReadyWatchdog();
    this.clearInboundHookWatchdog();
    this._waListenersAttached = false;
    this._waListenersAttaching = null;
    this._wwebjsInjecting = null;

    const client = this.client;
    const hadClient = Boolean(client);

    this.client = null;

    this.isReady = false;



    if (client) {

      try {

        await client.destroy();

      } catch (error) {

        logger.warn(`Client destroy warning (bot ${this.botAccountId}): ${error.message}`);

      }

    }



    clearStaleChromiumLocks('.wwebjs_auth');

    if (hadClient) {
      await sleep(1500);
    }

  }



  async initialize() {

    if (this.isInitializing || this.isShuttingDown) return;

    this.isInitializing = true;
    let reconnectReason = null;
    this._linkStartedAt = Date.now();
    this.linkTiming = { launch_ms: null, qr_ms: null, ready_ms: null };

    try {

      await this.teardownClient();

      clearStaleChromiumLocks('.wwebjs_auth');

      this.client = this.createClient();

      this.messageHandler = new MessageHandler(this);

      this.setupEventHandlers();

      logger.info(`Initializing WhatsApp client (bot ${this.botAccountId})...`);

      await this.client.initialize();

      if (this._linkStartedAt && this.linkTiming.launch_ms == null) {
        this.linkTiming.launch_ms = Date.now() - this._linkStartedAt;
      }

    } catch (error) {

      logger.error(`WhatsApp startup error (bot ${this.botAccountId}): ${error.message}`);

      if (isRecoverableBrowserError(error)) {

        clearStaleChromiumLocks('.wwebjs_auth');

      }

      if (this.botAccountId) {

        botAccountService.updateStatus(this.botAccountId, BOT_STATUS.CONNECTING, {

          lastError: null,

        });

      }

      await this.teardownClient();

      reconnectReason = 'initialize_failed';

    } finally {

      this.isInitializing = false;

      if (reconnectReason) {

        this.scheduleReconnect(reconnectReason);

      }

    }

  }



  async handleReconnect(reason = 'unknown') {

    if (this.isShuttingDown || this.isReconnecting || this.isInitializing) {

      return;

    }



    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {

      logger.error(`Max reconnect attempts for bot ${this.botAccountId}`);

      if (this.botAccountId) {

        botAccountService.updateStatus(this.botAccountId, BOT_STATUS.ERROR, {

          lastError: `Max reconnect attempts reached (${reason})`,

        });

      }

      return;

    }



    this.isReconnecting = true;

    this.reconnectAttempts += 1;

    const delay = RECONNECT_DELAY_MS * Math.min(this.reconnectAttempts, 6);

    logger.info(

      `Reconnecting bot ${this.botAccountId} in ${delay}ms (attempt ${this.reconnectAttempts}, reason: ${reason})`

    );

    if (this.botAccountId) {
      botAccountService.updateStatus(this.botAccountId, BOT_STATUS.CONNECTING, {
        lastError: null,
        lastQr: null,
      });
    }

    try {

      await sleep(delay);

      await this.teardownClient();

      await this.initialize();

    } catch (error) {

      logger.error(`Reconnect failed (bot ${this.botAccountId}): ${error.message}`);

      this._pendingReconnectReason = this._pendingReconnectReason || 'reconnect_failed';

    } finally {

      this.isReconnecting = false;
      const pending = this._pendingReconnectReason;
      this._pendingReconnectReason = null;
      if (pending && !this.isReady && !this.isShuttingDown) {
        this.scheduleReconnect(pending);
      }

    }

  }



  async sendTypingState(chatId) {
    if (!this.client || !this.isReady || !chatId) return;

    return this.runBrowserTask('typing_indicator', async () => {
      const chat = await this.client.getChatById(chatId);
      if (chat?.sendStateTyping) {
        await chat.sendStateTyping();
      }
    });
  }

  async waitBeforeReply(chatIds, delaySeconds) {
    const delaySec = Math.max(0, Math.min(MAX_REPLY_DELAY_SECONDS, Math.floor(Number(delaySeconds) || 0)));
    if (!delaySec || !this.client || !this.isReady) return;

    const primaryChatId = (Array.isArray(chatIds) ? chatIds : [chatIds]).filter(Boolean)[0];
    if (!primaryChatId) return;

    const deadline = Date.now() + delaySec * 1000;
    logger.info(`Reply delay: waiting ${delaySec}s with typing indicator`);

    while (Date.now() < deadline) {
      try {
        await Promise.race([
          this.sendTypingState(primaryChatId),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('typing indicator timeout')), 8000)
          ),
        ]);
      } catch (error) {
        logger.warn(`Typing indicator failed: ${error.message}`);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 20000)));
    }
  }

  async sendMessage(phoneOrIds, text) {

    if (!this.client || !this.isReady) {

      throw new Error('WhatsApp client is not ready');

    }

    if (this.isReconnecting) {
      throw new Error('WhatsApp is reconnecting. Try again in a few seconds.');
    }

    this.clearDeferredChatSync();
    this.requestSyncAbort();

    const chatIds = Array.isArray(phoneOrIds)
      ? phoneOrIds.filter(Boolean)
      : [phoneOrIds.includes('@') ? phoneOrIds : `${phoneOrIds}@c.us`];

    if (!chatIds.length) {
      throw new Error('No WhatsApp chat id to send to');
    }

    return this.runBrowserTask(
      'send_message',
      async () => {
      await this.ensureWWebJsInjected();
      await this.ensureWhatsAppListenersAttached();

      const [primaryChatId, ...alternateChatIds] = chatIds;

      try {

        const sentMessage = await sendWhatsAppText(this.client, primaryChatId, text, {
          alternateChatIds,
        });

        const messageId = sentMessage?.id?._serialized || sentMessage?.id?.id;

        if (messageId) {

          this.botSentMessageIds.add(messageId);

          if (this.botSentMessageIds.size > 500) {

            this.botSentMessageIds.clear();

          }

        }



        if (text) {
          const trimmed = String(text).trim();
          this.recentBotReplyBodies.add(trimmed.slice(0, 120));
          this.recentBotReplyBodies.add(trimmed.slice(0, 300));

          if (this.recentBotReplyBodies.size > 400) {
            this.recentBotReplyBodies.clear();
          }
        }



        return sentMessage;

      } catch (error) {

        // A single failed send must not tear down the WhatsApp session — only a real
        // browser disconnect (target closed / protocol error) should trigger reconnect.
        if (isBrowserTargetClosedError(error)) {
          this.markBrowserUnhealthy(error.message);
        }

        throw error;

      }
    },
      { priority: 'high' }
    );

  }



  async requestPairingCode(phoneNumber) {
    if (!this.client || this.isShuttingDown) {
      throw new Error('WhatsApp is still starting. Wait a moment and try again.');
    }

    await this.prepareAuthMode('code');

    const normalized = normalizePhone(phoneNumber);
    if (!normalized || normalized.length < 12) {
      throw new Error('Enter a valid 10-digit Indian mobile number');
    }

    const code = await this.runBrowserTask('request_pairing_code', () =>
      this.client.requestPairingCode(normalized, true)
    );

    await this.storePairingCode(code);
    return this.pairingCode;
  }



  getStatus() {

    return {

      ready: this.isReady,

      reconnectAttempts: this.reconnectAttempts,

      botAccountId: this.botAccountId,

      pairingCode: this.pairingCode,

      authMode: this.authMode,

      linkTiming: this.linkTiming,

      authenticated: Boolean(this._authenticatedAt),

      authPhase: this.isReady ? 'ready' : this._authenticatedAt ? 'syncing' : 'linking',

      authSyncMs: this.getAuthSyncMs(),

    };

  }



  async shutdown({ logout = false } = {}) {

    this.isShuttingDown = true;
    this.clearReadyWatchdog();
    if (logout) {
      this._authenticatedAt = null;
    }

    logger.info(
      `Shutting down WhatsApp client (bot ${this.botAccountId}, logout=${logout})...`
    );

    const client = this.client;

    if (logout) {
      if (client) {
        try {
          if (this.isReady) {
            await client.logout();
          } else if (client.authStrategy?.logout) {
            await client.authStrategy.logout();
          }
        } catch (error) {
          logger.warn(`WhatsApp logout failed (bot ${this.botAccountId}): ${error.message}`);
        }
      }
      this.clearLocalSession();
    }

    await this.teardownClient();

  }
}

module.exports = WhatsAppBot;
