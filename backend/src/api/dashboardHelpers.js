const botManager = require('../bot/botManager');
const { botAccountService } = require('../services/botAccountService');
const { normalizePhone, isSameOwnerPhone } = require('../utils/helpers');

function knownOwnerPhoneForBot(bot) {
  if (!bot) return null;
  const phone = bot.whatsapp_phone || bot.last_whatsapp_phone;
  return phone ? normalizePhone(phone) : null;
}

function fastOwnerPhone(bot) {
  if (!bot) return null;

  const liveBot = botManager.getBot(bot.id);
  if (liveBot?.myWhatsAppId) {
    return normalizePhone(liveBot.myWhatsAppId);
  }

  return knownOwnerPhoneForBot(bot);
}

async function resolveOwnerPhone(bot) {
  if (!bot) return null;

  const liveBot = botManager.getBot(bot.id);
  if (liveBot?.myWhatsAppId) {
    const phone = normalizePhone(liveBot.myWhatsAppId);
    if (phone && bot.whatsapp_phone !== phone) {
      botAccountService.updateStatus(bot.id, bot.status, { whatsappPhone: phone });
    }
    return phone;
  }

  return knownOwnerPhoneForBot(bot);
}

function canAccessChatProfile(bot, profile) {
  if (!bot || !profile) return false;
  const ownerPhone = fastOwnerPhone(bot);
  if (!ownerPhone) return false;
  return isSameOwnerPhone(profile.owner_phone, ownerPhone);
}

function getBotConnectionState(bot) {
  if (!bot) {
    return { connected: false, reconnecting: false, hasSession: false, liveStatus: { ready: false } };
  }

  const liveBot = botManager.getBot(bot.id);
  const connected = Boolean(liveBot?.isReady);
  return {
    connected,
    reconnecting: false,
    hasSession: connected,
    liveStatus: liveBot?.getStatus() || { ready: false },
  };
}

/**
 * The WhatsApp Business API has no "list my chats" call — chats appear as
 * people message the number (Gallabox webhook). "Sync" now just reports state.
 */
async function syncChatsIfReady(bot) {
  const { connected, hasSession } = getBotConnectionState(bot);
  return { syncedCount: 0, connected, reconnecting: false, timedOut: false, hasSession };
}

module.exports = {
  resolveOwnerPhone,
  fastOwnerPhone,
  canAccessChatProfile,
  syncChatsIfReady,
  getBotConnectionState,
  isSameOwnerPhone,
};
