const crypto = require('crypto');
const axios = require('axios');
const logger = require('../../utils/logger');

const API_BASE = (process.env.GALLABOX_API_BASE || 'https://server.gallabox.com').replace(/\/+$/, '');
const SEND_TIMEOUT_MS = 20000;
const MEDIA_TIMEOUT_MS = 60000;
const TEST_TIMEOUT_MS = 10000;
// WhatsApp caps inbound media at 16MB (100MB for documents); anything above this
// is not worth pulling into memory for a chat reply.
const MAX_MEDIA_BYTES = parseInt(process.env.GALLABOX_MAX_MEDIA_BYTES, 10) || 25 * 1024 * 1024;

/**
 * GALLABOX_* env config. Since multi-number support each bot keeps its own
 * credentials in bot_accounts; env only seeds the first bot at bootstrap.
 */
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

function missingConfigKeys(config = getConfig(), { env = true } = {}) {
  const names = env
    ? { apiKey: 'GALLABOX_API_KEY', apiSecret: 'GALLABOX_API_SECRET', channelId: 'GALLABOX_CHANNEL_ID', phone: 'GALLABOX_PHONE' }
    : { apiKey: 'API key', apiSecret: 'API secret', channelId: 'Channel ID', phone: 'WhatsApp number' };
  return Object.entries(names)
    .filter(([key]) => !config[key])
    .map(([, label]) => label);
}

function isConfigured(config = getConfig()) {
  return missingConfigKeys(config).length === 0;
}

function authHeaders(config) {
  return { apiKey: config.apiKey, apiSecret: config.apiSecret };
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
async function sendText(config, phone, text, { recipientName = null } = {}) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) throw new Error('No recipient phone number');

  try {
    const { data } = await axios.post(
      `${API_BASE}/devapi/messages/whatsapp`,
      {
        channelId: config.channelId,
        channelType: 'whatsapp',
        recipient: { name: recipientName || digits, phone: digits },
        whatsapp: { type: 'text', text: { body: String(text) } },
      },
      {
        headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
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
async function downloadMedia(config, url, { mimeType = null, filename = null } = {}) {
  if (!url) return null;
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: MEDIA_TIMEOUT_MS,
      maxContentLength: MAX_MEDIA_BYTES,
      headers: isGallaboxHost(url) ? authHeaders(config) : undefined,
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
 * Gallabox signs webhooks with `x-gallabox-signature`: HMAC-SHA256 of the raw
 * request body using the secret set on the webhook in Settings → Webhooks.
 * Docs say base64; hex (optionally "sha256="-prefixed) is accepted too.
 */
function verifySignature(webhookSecret, rawBody, signature) {
  if (!webhookSecret || !rawBody || !signature) return false;

  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest();
  const value = String(signature).trim().replace(/^sha256=/i, '');
  const candidates = [];
  if (/^[0-9a-f]{64}$/i.test(value)) candidates.push(Buffer.from(value, 'hex'));
  candidates.push(Buffer.from(value, 'base64'));

  return candidates.some(
    (provided) => provided.length === expected.length && crypto.timingSafeEqual(provided, expected)
  );
}

/**
 * Checks credentials without sending a WhatsApp message. Gallabox has no documented
 * "whoami" call, so this reads the account's users list (needs the account id).
 * `verified: null` means the check could not be made — not that it failed.
 */
async function testConnection(config) {
  const missing = missingConfigKeys(config, { env: false });
  if (missing.length) {
    return { ok: false, verified: false, message: `Missing ${missing.join(', ')}` };
  }
  if (!config.accountId) {
    return {
      ok: true,
      verified: null,
      message: 'Saved, but not verified — add the Gallabox Account ID to check the API key and secret.',
    };
  }
  try {
    await axios.get(`${API_BASE}/devapi/accounts/${encodeURIComponent(config.accountId)}/users`, {
      headers: authHeaders(config),
      timeout: TEST_TIMEOUT_MS,
    });
    return { ok: true, verified: true, message: 'Gallabox accepted the API key and secret.' };
  } catch (error) {
    const status = error?.response?.status;
    if (status === 401 || status === 403) {
      return { ok: false, verified: false, message: 'Gallabox rejected the API key / secret (or it lacks permission for this account).' };
    }
    return { ok: true, verified: null, message: `Could not verify with Gallabox: ${describeApiError(error)}` };
  }
}

/** A client bound to one bot's credentials. */
function createClient(config) {
  return {
    config,
    sendText: (phone, text, options) => sendText(config, phone, text, options),
    downloadMedia: (url, options) => downloadMedia(config, url, options),
  };
}

function logConfigStatus() {
  const missing = missingConfigKeys();
  if (missing.length === 4) return;
  if (missing.length) {
    logger.warn(`GALLABOX_* env partly set — missing ${missing.join(', ')}. Configure numbers in the dashboard instead.`);
  }
}

module.exports = {
  getConfig,
  isConfigured,
  missingConfigKeys,
  sendText,
  downloadMedia,
  verifySignature,
  testConnection,
  createClient,
  logConfigStatus,
};
