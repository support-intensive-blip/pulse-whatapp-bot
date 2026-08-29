const chatProfileService = require('../services/chatProfileService');

let helpers = {};
try {
  helpers = require('./helpers');
} catch (_error) {
  helpers = {};
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function canonicalContactPhone(value) {
  if (typeof helpers.canonicalContactPhone === 'function') {
    return helpers.canonicalContactPhone(value);
  }
  const digits = digitsOnly(value);
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function isLidLikePhone(value) {
  if (typeof helpers.isLikelyLidPhone === 'function') {
    return helpers.isLikelyLidPhone(value);
  }
  // Real WhatsApp numbers with country code are typically <= 13 digits; LIDs are longer.
  return digitsOnly(value).length > 13;
}

function resolveOutboundChatId(profile) {
  if (!profile?.chat_id) {
    throw new Error('Chat is not linked to WhatsApp yet. Sync conversations first.');
  }

  const chatId = profile.chat_id;
  if (!chatId.endsWith('@manual.import')) {
    return chatId;
  }

  const phone = canonicalContactPhone(profile.contact_phone);
  if (!phone || phone.length < 12 || isLidLikePhone(phone)) {
    throw new Error(
      'This imported chat has no valid phone number. Re-import with a 10-digit mobile number or sync from WhatsApp.'
    );
  }

  const cUsId = `${phone}@c.us`;
  const linked = chatProfileService.findLinkedContactProfile(profile.owner_phone, {
    contactPhone: phone,
    chatId: cUsId,
  });
  if (linked?.chat_id && !String(linked.chat_id).includes('@manual.import')) {
    return linked.chat_id;
  }

  return cUsId;
}

function resolveOutboundChatIds(profile, inboundChatId = null) {
  if (!profile) {
    return inboundChatId ? [inboundChatId] : [];
  }

  const ids = [];
  const seen = new Set();
  const add = (id) => {
    if (!id || seen.has(id) || String(id).includes('@manual.import')) return;
    seen.add(id);
    ids.push(id);
  };

  // Keep the live inbound thread first so replies stay on the same WhatsApp chat.
  if (inboundChatId) add(inboundChatId);

  try {
    add(resolveOutboundChatId(profile));
  } catch (_error) {
    if (profile.chat_id) add(profile.chat_id);
  }

  const effectivePhone =
    typeof chatProfileService.effectiveContactPhone === 'function'
      ? chatProfileService.effectiveContactPhone(profile)
      : profile.contact_phone;
  const phone = canonicalContactPhone(effectivePhone);

  // Only add @c.us for real phone numbers — never LID digits as a fake @c.us (opens an empty chat).
  if (phone && phone.length >= 12 && !isLidLikePhone(phone)) {
    add(`${phone}@c.us`);
  }

  const linked = chatProfileService.findLinkedContactProfile(profile.owner_phone, {
    contactPhone: phone && !isLidLikePhone(phone) ? phone : null,
    contactName: profile.contact_name,
    chatId: profile.chat_id || inboundChatId,
  });
  if (linked?.chat_id) add(linked.chat_id);

  const sticky =
    inboundChatId ||
    (profile.chat_id && !String(profile.chat_id).includes('@manual.import')
      ? profile.chat_id
      : null);

  // Prefer sticky inbound/profile thread; among remaining candidates prefer @c.us over @lid.
  ids.sort((a, b) => {
    if (sticky) {
      if (a === sticky && b !== sticky) return -1;
      if (b === sticky && a !== sticky) return 1;
    }
    const rank = (id) => (id.endsWith('@c.us') ? 0 : id.endsWith('@lid') ? 1 : 2);
    return rank(a) - rank(b);
  });

  return ids.length ? ids : inboundChatId ? [inboundChatId] : [];
}

module.exports = {
  resolveOutboundChatId,
  resolveOutboundChatIds,
};
