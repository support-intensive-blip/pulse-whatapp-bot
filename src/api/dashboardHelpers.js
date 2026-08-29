const botManager = require('../bot/botManager');
const { botAccountService, BOT_STATUS } = require('../services/botAccountService');
const chatProfileService = require('../services/chatProfileService');
const { normalizePhone, isSameOwnerPhone, sleep } = require('../utils/helpers');

function botHasSavedSession(bot) {
  if (!bot) return false;
  if (bot.status === BOT_STATUS.DISCONNECTED) return false;
  return Boolean(bot.whatsapp_phone || bot.last_whatsapp_phone);
}

async function waitForLiveBot(bot, { timeoutMs = 90000, startIfNeeded = true } = {}) {
  if (!bot?.id) {
    return { liveBot: null, connected: false, reconnecting: false, timedOut: false, hasSession: false };
  }

  const hasSession = botHasSavedSession(bot);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const liveBot = botManager.getBot(bot.id);
    if (liveBot?.isReady) {
      return { liveBot, connected: true, reconnecting: false, timedOut: false, hasSession };
    }

    if (startIfNeeded && hasSession) {
      if (!liveBot && !botManager.isStarting(bot.id)) {
        botManager.startBot(bot.id).catch(() => {});
      }
    }

    const reconnecting = Boolean(
      hasSession &&
      (botManager.isStarting(bot.id) ||
        liveBot?.isInitializing ||
        liveBot?.isReconnecting ||
        (!liveBot && bot.status !== BOT_STATUS.DISCONNECTED))
    );

    if (reconnecting) {
      await sleep(2000);
      continue;
    }

    if (!hasSession) {
      return { liveBot: null, connected: false, reconnecting: false, timedOut: false, hasSession };
    }

    await sleep(2000);
  }

  const liveBot = botManager.getBot(bot.id);
  return {
    liveBot: liveBot?.isReady ? liveBot : liveBot || null,
    connected: Boolean(liveBot?.isReady),
    reconnecting: Boolean(hasSession && !liveBot?.isReady),
    timedOut: true,
    hasSession,
  };
}

function knownOwnerPhoneForBot(bot) {
  if (!bot) return null;
  const phone = bot.whatsapp_phone || bot.last_whatsapp_phone;
  return phone ? normalizePhone(phone) : null;
}

async function resolveOwnerPhone(bot) {
  if (!bot) return null;

  const liveBot = botManager.getBot(bot.id);
  if (liveBot?.myWhatsAppId) {
    const phone = normalizePhone(liveBot.myWhatsAppId);
    botAccountService.updateStatus(bot.id, bot.status, { whatsappPhone: phone });
    return phone;
  }

  if (bot.whatsapp_phone) {
    return normalizePhone(bot.whatsapp_phone);
  }

  return knownOwnerPhoneForBot(bot);
}

function fastOwnerPhone(bot) {
  if (!bot) return null;

  const liveBot = botManager.getBot(bot.id);
  if (liveBot?.myWhatsAppId) {
    return normalizePhone(liveBot.myWhatsAppId);
  }

  return knownOwnerPhoneForBot(bot);
}

function canAccessChatProfile(bot, profile) {
  if (!bot || !profile) return false;
  const ownerPhone = fastOwnerPhone(bot);
  if (!ownerPhone) return false;
  return isSameOwnerPhone(profile.owner_phone, ownerPhone);
}

async function syncChatsIfReady(bot, { waitMs = 90000 } = {}) {
  const wait = await waitForLiveBot(bot, { timeoutMs: waitMs, startIfNeeded: true });
  const liveBot = wait.liveBot;

  if (!liveBot?.client || !liveBot.isReady) {
    return {
      syncedCount: 0,
      connected: wait.connected,
      reconnecting: wait.reconnecting,
      timedOut: wait.timedOut,
      hasSession: wait.hasSession,
    };
  }

  const ownerPhone = await resolveOwnerPhone(bot);
  if (!ownerPhone) {
    return {
      syncedCount: 0,
      connected: wait.connected,
      reconnecting: false,
      timedOut: false,
      hasSession: wait.hasSession,
    };
  }

  try {
    if (typeof liveBot.ensureWWebJsInjected === 'function') {
      await liveBot.ensureWWebJsInjected();
    }

    const synced = await liveBot.runBrowserTask('dashboard_sync', () =>
      chatProfileService.syncPersonalChats(liveBot.client, ownerPhone, {
        lightweight: true,
        batchSize: 30,
        batchDelayMs: 80,
        timeoutMs: 180000,
        getChatsTimeoutMs: 120000,
        maxChats: 100,
      })
    );
    return {
      syncedCount: Number(synced) || 0,
      connected: true,
      reconnecting: false,
      timedOut: false,
      hasSession: true,
    };
  } catch (error) {
    if (error?.message?.includes('already in progress')) {
      return {
        syncedCount: 0,
        connected: true,
        reconnecting: false,
        timedOut: false,
        hasSession: true,
      };
    }
    throw error;
  }
}

async function getWhatsAppContacts(bot) {
  const liveBot = botManager.getBot(bot?.id);
  if (!liveBot?.client || !liveBot.isReady) return [];
  return chatProfileService.fetchWhatsAppContacts(liveBot.client);
}

function getBotConnectionState(bot) {
  if (!bot) {
    return { connected: false, reconnecting: false, hasSession: false, liveStatus: { ready: false } };
  }

  const liveBot = botManager.getBot(bot.id);
  const hasSession = botHasSavedSession(bot);
  const connected = Boolean(liveBot?.isReady);
  const reconnecting = Boolean(
    !connected &&
    hasSession &&
    (botManager.isStarting(bot.id) ||
      liveBot?.isInitializing ||
      liveBot?.isReconnecting ||
      !liveBot)
  );

  return {
    connected,
    reconnecting,
    hasSession,
    liveStatus: liveBot?.getStatus() || { ready: false },
  };
}

module.exports = {
  resolveOwnerPhone,
  fastOwnerPhone,
  canAccessChatProfile,
  syncChatsIfReady,
  waitForLiveBot,
  botHasSavedSession,
  getWhatsAppContacts,
  getBotConnectionState,
  isSameOwnerPhone,
};
