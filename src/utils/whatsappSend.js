const logger = require('./logger');
const { withTimeout, canonicalContactPhone, sleep } = require('./helpers');
const { isWWebJsBrokenError } = require('./chromiumProfile');
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');

const SEND_TIMEOUT_MS = parseInt(process.env.WHATSAPP_SEND_TIMEOUT_MS, 10) || 25000;
const WWEBJS_READY_TIMEOUT_MS = parseInt(process.env.WHATSAPP_WWEBJS_READY_MS, 10) || 60000;

function isLidMappingError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('no lid') || msg.includes('lid for user');
}

function isBrowserUnavailableError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return (
    msg.includes('execution context was destroyed') ||
    msg.includes('target closed') ||
    msg.includes('session closed') ||
    msg.includes('protocol error')
  );
}

async function isWWebJsReady(page) {
  return page
    .evaluate(() =>
      Boolean(
        window.WWebJS &&
          typeof window.WWebJS.getChat === 'function' &&
          typeof window.WWebJS.sendMessage === 'function' &&
          window.require &&
          window.require('WAWebCollections')?.Chat
      )
    )
    .catch(() => false);
}

async function waitForWWebJsReady(client, timeoutMs = WWEBJS_READY_TIMEOUT_MS) {
  const page = client?.pupPage;
  if (!page || page.isClosed?.()) {
    throw new Error('WhatsApp browser is not available');
  }

  if (await isWWebJsReady(page)) return;

  // Re-inject helpers if WhatsApp reloaded and dropped WWebJS after ready.
  try {
    logger.info('WWebJS missing before send — reinjecting LoadUtils…');
    await page.evaluate(LoadUtils);
  } catch (error) {
    logger.warn(`WWebJS reinject failed: ${error.message}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isWWebJsReady(page)) return;
    await sleep(400);
  }

  throw new Error('WhatsApp Web is still loading. Wait a few seconds and try again.');
}

async function sendTextViaPage(client, chatId, text) {
  const page = client?.pupPage;
  if (!page || page.isClosed?.()) {
    throw new Error('WhatsApp browser is not available');
  }

  const sentMsg = await page.evaluate(
    async (targetChatId, body) => {
      const chat = await window.WWebJS.getChat(targetChatId, { getAsModel: false });
      if (!chat) return null;
      await window.WWebJS.sendSeen(targetChatId);
      const msg = await window.WWebJS.sendMessage(chat, body, { linkPreview: true });
      return msg ? window.WWebJS.getMessageModel(msg) : undefined;
    },
    chatId,
    text
  );

  if (!sentMsg) {
    throw new Error(`Chat not found for ${chatId}`);
  }

  const Message = require('whatsapp-web.js').Message;
  return new Message(client, sentMsg);
}

async function openChat(client, chatId) {
  return withTimeout(client.getChatById(chatId), 8000, `Open chat ${chatId}`);
}

async function sendViaChat(chat, chatId, text, label = 'WhatsApp send') {
  return withTimeout(chat.sendMessage(text), SEND_TIMEOUT_MS, label);
}

async function sendToLidChat(client, chatId, text) {
  const attempts = [
    async () =>
      withTimeout(client.sendMessage(chatId, text), SEND_TIMEOUT_MS, 'LID direct send'),
    async () => sendTextViaPage(client, chatId, text),
    async () => {
      const chat = await openChat(client, chatId);
      if (!chat) throw new Error(`Chat not found for ${chatId}`);
      return sendViaChat(chat, chatId, text, 'LID chat send');
    },
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      if (!isLidMappingError(error)) {
        logger.warn(`LID send attempt failed for ${chatId}: ${error.message}`);
      }
      lastError = error;
      if (isBrowserUnavailableError(error)) {
        throw error;
      }
    }
  }

  throw lastError || new Error(`Could not send to LID chat ${chatId}`);
}

async function sendToCUsChat(client, chatId, text) {
  const attempts = [
    async () => withTimeout(client.sendMessage(chatId, text), SEND_TIMEOUT_MS, 'WhatsApp send'),
    async () => sendTextViaPage(client, chatId, text),
    async () => {
      const chat = await openChat(client, chatId);
      if (!chat) throw new Error(`Chat not found for ${chatId}`);
      return sendViaChat(chat, chatId, text);
    },
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (isBrowserUnavailableError(error)) {
        throw error;
      }
      if (isLidMappingError(error)) {
        logger.warn(`@c.us send hit LID mapping error for ${chatId}: ${error.message}`);
        throw new Error(
          'WhatsApp could not resolve this contact. Open the chat in WhatsApp on your phone first, then sync.'
        );
      }
      if (!isWWebJsBrokenError(error)) {
        logger.warn(`Send attempt failed for ${chatId}: ${error.message}`);
      }
    }
  }

  throw lastError || new Error(`Could not send to ${chatId}`);
}

async function sendWhatsAppText(client, chatId, text, { alternateChatIds = [] } = {}) {
  if (!client || !chatId) {
    throw new Error('WhatsApp client and chat id are required');
  }

  await waitForWWebJsReady(client);

  const targets = [chatId, ...(alternateChatIds || []).filter((id) => id && id !== chatId)];
  let lastError;

  for (const target of targets) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (attempt > 0) {
          await waitForWWebJsReady(client, 8000);
        }
        if (target.endsWith('@lid')) {
          return await sendToLidChat(client, target, text);
        }
        if (target.endsWith('@c.us')) {
          return await sendToCUsChat(client, target, text);
        }
        return await withTimeout(client.sendMessage(target, text), SEND_TIMEOUT_MS, 'WhatsApp send');
      } catch (error) {
        lastError = error;
        if (isBrowserUnavailableError(error)) {
          throw error;
        }
        if (isWWebJsBrokenError(error) && attempt === 0) {
          logger.warn(`WWebJS not ready for ${target}, retrying send…`);
          continue;
        }
        logger.warn(`Send to ${target} failed: ${error.message}`);
        break;
      }
    }
  }

  throw (
    lastError ||
    new Error('Could not send to this contact on WhatsApp. Sync conversations, then try again.')
  );
}

function buildAlternateChatIds(profile, inboundChatId = null) {
  const ids = [];
  const seen = new Set();
  const add = (id) => {
    if (!id || seen.has(id) || String(id).includes('@manual.import')) return;
    seen.add(id);
    ids.push(id);
  };

  if (inboundChatId) add(inboundChatId);
  if (profile?.chat_id) add(profile.chat_id);

  const phone = canonicalContactPhone(profile?.contact_phone);
  if (phone && phone.length >= 12) {
    add(`${phone}@c.us`);
  }

  return ids.slice(1);
}

async function resolveWhatsAppSendTarget(client, chatId) {
  if (!client || !chatId) {
    throw new Error('WhatsApp client and chat id are required');
  }

  try {
    const chat = await openChat(client, chatId);
    if (chat) {
      return { chat, chatId: chat.id?._serialized || chatId };
    }
  } catch (error) {
    logger.warn(`getChatById failed for ${chatId}: ${error.message}`);
  }

  return { chat: null, chatId };
}

module.exports = {
  buildAlternateChatIds,
  resolveWhatsAppSendTarget,
  sendWhatsAppText,
  isLidMappingError,
  isBrowserUnavailableError,
};
