const crypto = require('crypto');
const axios = require('axios');
const logger = require('../../utils/logger');

const API_BASE = (process.env.GALLABOX_API_BASE || 'https://server.gallabox.com').replace(/\/+$/, '');
const SEND_TIMEOUT_MS = 20000;
const MEDIA_TIMEOUT_MS = 60000;
// WhatsApp caps inbound media at 16MB (100MB for documents); anything above this
// is not worth pulling into memory for a chat reply.
const MAX_MEDIA_BYTES = parseInt(process.env.GALLABOX_MAX_MEDIA_BYTES, 10) || 25 * 1024 * 1024;

function getConfig() {
  return {
    apiKey: process.env.GALLABOX_API_KEY || '',
    apiSecret: process.env.GALLABOX_API_SECRET || '',
    channelId: process.env.GALLABOX_CHANNEL_ID || '',
    accountId: process.env.GALLABOX_ACCOUNT_ID || '',
    phone: String(process.env.GALLABOX_PHONE || '').replace(/\D/g, ''),
    webhookSecret: process.env.GALLABOX_WEBHOOK_SECRET || '',
  };
}

function missingConfigKeys() {
  const config = getConfig();
  const missing = [];
  if (!config.apiKey) missing.push('GALLABOX_API_KEY');
  if (!config.apiSecret) missing.push('GALLABOX_API_SECRET');
  if (!config.channelId) missing.push('GALLABOX_CHANNEL_ID');
  if (!config.phone) missing.push('GALLABOX_PHONE');
  return missing;
}

function isConfigured() {
  return missingConfigKeys().length === 0;
}

function authHeaders() {
  const { apiKey, apiSecret } = getConfig();
  return { apiKey, apiSecret };
}

function describeApiError(error) {
  const status = error?.response?.status;
  const data = error?.response?.data;
  const detail =
    (data && (data.message || data.error || (typeof data === 'string' ? data : JSON.stringify(data)))) ||
    error?.message ||
    'unknown error';
  return status ? `Gallabox API ${status}: ${String(detail).slice(0, 300)}` : String(detail);
}

/**
 * Send a free-form WhatsApp text. Only works inside the 24h customer-service
 * window (since the contact's last inbound message) — outside it WhatsApp
 * requires an approved template and Gallabox returns an error.
 */
async function sendText(phone, text, { recipientName = null } = {}) {
  const { channelId } = getConfig();
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) throw new Error('No recipient phone number');

  try {
    const { data } = await axios.post(
      `${API_BASE}/devapi/messages/whatsapp`,
      {
        channelId,
        channelType: 'whatsapp',
        recipient: { name: recipientName || digits, phone: digits },
        whatsapp: { type: 'text', text: { body: String(text) } },
      },
      {
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        timeout: SEND_TIMEOUT_MS,
      }
    );
    return {
      id: data?.id || data?.messageId || data?._id || null,
      raw: data,
    };
  } catch (error) {
    throw new Error(describeApiError(error));
  }
}

function isGallaboxHost(url) {
  try {
    const host = new URL(url).hostname;
    return host.endsWith('gallabox.com') || host.endsWith('gallabox.dev');
  } catch (_error) {
    return false;
  }
}

/**
 * Download inbound media into the { data: base64, mimetype, filename } shape the
 * chat service already consumes for voice notes and PDFs.
 */
async function downloadMedia(url, { mimeType = null, filename = null } = {}) {
  if (!url) return null;
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: MEDIA_TIMEOUT_MS,
      maxContentLength: MAX_MEDIA_BYTES,
      headers: isGallaboxHost(url) ? authHeaders() : undefined,
    });
    const buffer = Buffer.from(response.data);
    const headerType = String(response.headers?.['content-type'] || '').split(';')[0].trim();
    return {
      data: buffer.toString('base64'),
      mimetype: mimeType || headerType || 'application/octet-stream',
      filename,
    };
  } catch (error) {
    throw new Error(`Media download failed: ${describeApiError(error)}`);
  }
}

/**
 * Gallabox signs webhooks with `x-gallabox-signature`: base64 HMAC-SHA256 of the
 * raw request body using the secret set on the webhook in Settings → Webhooks.
 */
function verifySignature(rawBody, signature) {
  const { webhookSecret } = getConfig();
  if (!webhookSecret || !rawBody || !signature) return false;

  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest();
  let provided;
  try {
    provided = Buffer.from(String(signature).trim(), 'base64');
  } catch (_error) {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

function logConfigStatus() {
  const missing = missingConfigKeys();
  if (missing.length) {
    logger.warn(`Gallabox not configured — missing ${missing.join(', ')}. Inbound WhatsApp is disabled.`);
    return;
  }
  if (!getConfig().webhookSecret) {
    logger.warn(
      'GALLABOX_WEBHOOK_SECRET is not set — webhook signatures are NOT verified. Set a secret on the Gallabox webhook and here before going live.'
    );
  }
}

module.exports = {
  getConfig,
  isConfigured,
  missingConfigKeys,
  sendText,
  downloadMedia,
  verifySignature,
  logConfigStatus,
};
