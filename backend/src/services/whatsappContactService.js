const chatProfileService = require('./chatProfileService');
const { canonicalContactPhone } = require('../utils/helpers');

// The WhatsApp Business API (Gallabox) has no address book to save contacts
// into — any valid number can be messaged directly. "Registering" an imported
// contact now only validates the number and merges it with an existing chat.

function formatAddressbookPhone(contactPhone) {
  const phone = canonicalContactPhone(contactPhone);
  if (!phone || phone.length < 12) return null;
  return phone;
}

function linkImportedProfileToExistingChat(profile, chatId) {
  if (!profile || !chatId) return profile;

  const linked = chatProfileService.findByChatIdForOwner(chatId, profile.owner_phone);
  if (!linked || linked.id === profile.id) return profile;

  const preferred = chatProfileService.pickPreferredContactProfile(linked, profile);
  const drop = preferred.id === linked.id ? profile : linked;
  return chatProfileService.mergeProfiles(preferred.id, drop.id);
}

function registerOne(profile, contactPhone) {
  const phone = formatAddressbookPhone(contactPhone || profile?.contact_phone);
  if (!phone) {
    return { profile, whatsapp: { ok: false, error: 'Valid 10-digit mobile number required' } };
  }
  const chatId = `${phone}@c.us`;
  return {
    profile: linkImportedProfileToExistingChat(profile, chatId),
    whatsapp: { ok: true, phone, chatId },
  };
}

async function registerImportedContactOnWhatsApp(_botAccountId, profile, { contactPhone } = {}) {
  return registerOne(profile, contactPhone);
}

async function registerImportedContactsBatch(_botAccountId, items) {
  return items.map((item) => ({
    ...registerOne(item.profile, item.contactPhone),
    enableAi: item.enableAi,
  }));
}

module.exports = {
  formatAddressbookPhone,
  registerImportedContactOnWhatsApp,
  registerImportedContactsBatch,
};
