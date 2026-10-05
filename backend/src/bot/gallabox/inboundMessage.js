const gallaboxApi = require('./gallaboxApi');

// Gallabox/WhatsApp type → the media type names the chat service already
// understands (it predates Gallabox and keys voice handling off 'audio'/'ptt').
const MEDIA_TYPES = new Set(['image', 'audio', 'voice', 'video', 'document', 'file', 'sticker']);

function normalizeMediaType(type) {
  if (type === 'voice') return 'ptt';
  if (type === 'file') return 'document';
  return type;
}

/** First http(s) URL found in a media node — Gallabox's exact key is not documented. */
function findMediaUrl(node) {
  if (!node || typeof node !== 'object') return null;
  for (const key of ['link', 'url', 'path', 'fileUrl', 'mediaUrl', 'href']) {
    const value = node[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  }
  for (const value of Object.values(node)) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  }
  return null;
}

function describeLocation(location = {}) {
  const parts = [location.name, location.address].filter(Boolean).join(', ');
  const coords =
    location.latitude != null && location.longitude != null
      ? `${location.latitude}, ${location.longitude}`
      : '';
  return `[Shared a location${parts ? `: ${parts}` : ''}${coords ? ` (${coords})` : ''}]`;
}

function describeContacts(contacts) {
  const list = Array.isArray(contacts) ? contacts : [contacts].filter(Boolean);
  const names = list
    .map((c) => c?.name?.formatted_name || c?.name?.first_name || c?.name || null)
    .filter((n) => typeof n === 'string');
  return `[Shared ${list.length || 1} contact card(s)${names.length ? `: ${names.join(', ')}` : ''}]`;
}

function interactiveText(wa) {
  const interactive = wa.interactive || {};
  return (
    interactive.button_reply?.title ||
    interactive.list_reply?.title ||
    interactive.nfm_reply?.body ||
    wa.button?.text ||
    ''
  );
}

/**
 * Normalize a Gallabox `Message.Received` webhook payload into the shape the
 * message handler works with. Returns null for events with nothing to answer
 * (reactions, orders, unknown types).
 */
function fromGallaboxPayload(payload) {
  const wa = payload?.whatsapp;
  if (!wa || !wa.from) return null;

  const phone = String(wa.from).replace(/\D/g, '');
  if (!phone) return null;

  const rawType = String(wa.type || 'text').toLowerCase();
  const base = {
    id: wa.id || payload.id || null,
    gallaboxMessageId: payload.id || null,
    conversationId: payload.conversationId || null,
    channelId: payload.channelId || null,
    phone,
    chatId: `${phone}@c.us`,
    name: payload.contact?.name || payload.contactName || null,
    timestamp: wa.time || null,
    type: rawType,
    body: '',
    hasMedia: false,
    filename: null,
    mimeType: null,
    mediaUrl: null,
    download: async () => null,
  };

  if (rawType === 'text') {
    return { ...base, body: String(wa.text?.body || '').trim() };
  }

  if (rawType === 'interactive' || rawType === 'button') {
    return { ...base, type: 'text', body: String(interactiveText(wa)).trim() };
  }

  if (rawType === 'location') {
    return { ...base, type: 'text', body: describeLocation(wa.location) };
  }

  if (rawType === 'contacts' || rawType === 'contact') {
    return { ...base, type: 'text', body: describeContacts(wa.contacts || wa.contact) };
  }

  if (MEDIA_TYPES.has(rawType)) {
    const node = wa[rawType] || {};
    const mediaUrl = findMediaUrl(node);
    const mimeType = node.mime_type || node.mimeType || null;
    const filename = node.filename || node.fileName || null;
    return {
      ...base,
      type: normalizeMediaType(rawType),
      body: String(node.caption || '').trim(),
      hasMedia: true,
      filename,
      mimeType,
      mediaUrl,
      download: async () =>
        mediaUrl ? gallaboxApi.downloadMedia(mediaUrl, { mimeType, filename }) : null,
    };
  }

  return null;
}

module.exports = { fromGallaboxPayload };
