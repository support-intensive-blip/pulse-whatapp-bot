const botManager = require('../bot/botManager');
const chatProfileService = require('./chatProfileService');
const logger = require('../utils/logger');
const { canonicalContactPhone, sleep } = require('../utils/helpers');

function formatAddressbookPhone(contactPhone) {
  const phone = canonicalContactPhone(contactPhone);
  if (!phone || phone.length < 12) return null;
  return phone;
}

function splitContactName(contactName) {
  const trimmed = String(contactName || '').trim();
  if (!trimmed) return { firstName: 'Contact', lastName: '' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

async function addContactToWhatsAppAddressbook(liveBot, { contactName, contactPhone, syncToPhone = true }) {
  const phone = formatAddressbookPhone(contactPhone);
  if (!phone) {
    return { ok: false, error: 'Valid 10-digit mobile number required to add to WhatsApp' };
  }
  if (!liveBot?.client || !liveBot.isReady) {
    return { ok: false, error: 'WhatsApp not connected' };
  }

  const { firstName, lastName } = splitContactName(contactName || phone);

  try {
    await liveBot.runBrowserTask('save_contact', async () => {
      await liveBot.client.saveOrEditAddressbookContact(phone, firstName, lastName, syncToPhone);
    });
    logger.info(`Added contact to WhatsApp addressbook: ${contactName || phone} (${phone})`);
    return { ok: true, phone, chatId: `${phone}@c.us` };
  } catch (error) {
    logger.warn(`Failed to add contact to WhatsApp: ${error.message}`);
    return { ok: false, error: error.message, phone };
  }
}

async function linkImportedProfileAfterWhatsAppAdd(liveBot, profile, ownerPhone, chatId) {
  if (!profile || !chatId || !liveBot?.client) return profile;

  let linked = chatProfileService.findByChatIdForOwner(chatId, ownerPhone);

  if (!linked) {
    try {
      await liveBot.runBrowserTask('open_imported_contact_chat', async () => {
        const chat = await liveBot.client.getChatById(chatId);
        if (chat) {
          linked = await chatProfileService.enrichFromWhatsAppChat(
            chat,
            ownerPhone,
            false,
            liveBot.client,
            null,
            { skipPuppeteer: true, fastPath: true }
          );
        }
      });
    } catch (error) {
      logger.warn(`Could not open WhatsApp chat for imported contact: ${error.message}`);
    }
  }

  if (linked && linked.id !== profile.id) {
    const preferred = chatProfileService.pickPreferredContactProfile(linked, profile);
    const drop = preferred.id === linked.id ? profile : linked;
    return chatProfileService.mergeProfiles(preferred.id, drop.id);
  }

  if (linked) return linked;

  return chatProfileService.updateChatId(profile.id, chatId, ownerPhone) || profile;
}

async function registerImportedContactOnWhatsApp(botAccountId, profile, { contactName, contactPhone } = {}) {
  const liveBot = botManager.getBot(botAccountId);
  const addResult = await addContactToWhatsAppAddressbook(liveBot, {
    contactName: contactName || profile?.contact_name,
    contactPhone: contactPhone || profile?.contact_phone,
    syncToPhone: true,
  });

  if (!addResult.ok) {
    return { profile, whatsapp: addResult };
  }

  const updated = await linkImportedProfileAfterWhatsAppAdd(
    liveBot,
    profile,
    profile.owner_phone,
    addResult.chatId
  );

  return { profile: updated, whatsapp: addResult };
}

async function registerImportedContactsBatch(botAccountId, items) {
  const liveBot = botManager.getBot(botAccountId);
  if (!liveBot?.client || !liveBot.isReady) {
    return items.map((item) => ({
      profile: item.profile,
      whatsapp: { ok: false, error: 'WhatsApp not connected' },
    }));
  }

  const withPhone = items.filter((item) => formatAddressbookPhone(item.contactPhone || item.profile?.contact_phone));
  if (!withPhone.length) {
    return items.map((item) => ({
      profile: item.profile,
      whatsapp: { ok: false, error: 'No valid phone numbers' },
    }));
  }

  const addResults = await liveBot.runBrowserTask('save_contacts_batch', async () => {
    const results = [];
    for (const item of withPhone) {
      const phone = formatAddressbookPhone(item.contactPhone || item.profile?.contact_phone);
      const { firstName, lastName } = splitContactName(item.contactName || item.profile?.contact_name || phone);
      try {
        await liveBot.client.saveOrEditAddressbookContact(phone, firstName, lastName, true);
        results.push({ item, ok: true, phone, chatId: `${phone}@c.us` });
        logger.info(`Added contact to WhatsApp addressbook: ${item.contactName || phone} (${phone})`);
        await sleep(250);
      } catch (error) {
        logger.warn(`Failed to add ${item.contactName || phone} to WhatsApp: ${error.message}`);
        results.push({ item, ok: false, error: error.message, phone });
      }
    }
    return results;
  });

  const resultByProfileId = new Map();
  for (const result of addResults) {
    let profile = result.item.profile;
    if (result.ok) {
      profile = await linkImportedProfileAfterWhatsAppAdd(
        liveBot,
        profile,
        profile.owner_phone,
        result.chatId
      );
    }
    resultByProfileId.set(result.item.profile.id, {
      profile,
      enableAi: result.item.enableAi,
      whatsapp: result.ok
        ? { ok: true, phone: result.phone, chatId: result.chatId }
        : { ok: false, error: result.error, phone: result.phone },
    });
  }

  return items.map((item) => {
    if (resultByProfileId.has(item.profile.id)) {
      return resultByProfileId.get(item.profile.id);
    }
    return {
      profile: item.profile,
      enableAi: item.enableAi,
      whatsapp: { ok: false, error: 'Valid 10-digit mobile number required' },
    };
  });
}

module.exports = {
  formatAddressbookPhone,
  splitContactName,
  addContactToWhatsAppAddressbook,
  linkImportedProfileAfterWhatsAppAdd,
  registerImportedContactOnWhatsApp,
  registerImportedContactsBatch,
};
