const fs = require('fs');
const path = require('path');
const { TMP_DIR, UPLOADS_DIR, DATA_DIR } = require('./constants');

function ensureDir(dirPath) {
  const fullPath = path.isAbsolute(dirPath) ? dirPath : path.join(process.cwd(), dirPath);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
  return fullPath;
}

function ensureAppDirs() {
  ensureDir(DATA_DIR);
  ensureDir(TMP_DIR);
  ensureDir(UPLOADS_DIR);
}

function normalizePhone(contactId) {
  if (!contactId) return '';
  return String(contactId).replace(/@(c\.us|lid|s\.whatsapp\.net|manual\.import)$/, '');
}

function canonicalContactPhone(phone) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function normalizePhoneDigits(contactId) {
  if (!contactId) return '';
  return String(contactId).replace(/\D/g, '');
}

function isSameOwnerPhone(a, b) {
  const left = normalizePhoneDigits(a);
  const right = normalizePhoneDigits(b);
  return Boolean(left && right && left === right);
}

function formatUserFacingError(error, fallback = 'Something went wrong. Please try again.') {
  const msg = String(error?.message || error || '').trim();
  if (!msg || msg.length <= 2) {
    return fallback;
  }
  if (msg.includes('NOT NULL constraint failed: messages.user_id')) {
    return 'Account setup is incomplete. Refresh the page and try again.';
  }
  if (/no lid/i.test(msg)) {
    return 'WhatsApp could not resolve this contact. Open the chat on your phone, sync, then try again.';
  }
  return msg;
}

function normalizeChatId(chatId) {
  return normalizePhone(chatId);
}

function formatTimestamp(date = new Date()) {
  return date.toISOString();
}

function parseReminderDateTime(dateStr, timeStr) {
  const dateTime = new Date(`${dateStr}T${timeStr}:00`);
  if (Number.isNaN(dateTime.getTime())) {
    return null;
  }
  return dateTime;
}

function formatReminderTime(date) {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function limitWords(text, minWords = 5, maxWords = 8) {
  if (!text) return text;
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return trimmed;

  const capped = words.slice(0, maxWords).join(' ');
  const sentenceEnd = Math.max(
    capped.lastIndexOf('.'),
    capped.lastIndexOf('!'),
    capped.lastIndexOf('?'),
    capped.lastIndexOf('…')
  );

  if (sentenceEnd >= Math.floor(capped.length * 0.45)) {
    return capped.slice(0, sentenceEnd + 1).trim();
  }

  return `${capped}…`;
}

function truncateText(text, maxLength = 500) {
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries a transient async operation (network/upstream connection blips) with
// exponential backoff. Only retries when shouldRetry(error) is true; otherwise
// rethrows immediately. Rethrows the last error after exhausting attempts.
async function withRetry(fn, { attempts = 3, baseDelayMs = 400, shouldRetry, label } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = typeof shouldRetry === 'function' ? shouldRetry(error) : true;
      if (!retryable || attempt >= attempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      // eslint-disable-next-line no-console
      if (label) {
        require('./logger').warn(
          `${label} attempt ${attempt}/${attempts} failed: ${error.message} — retrying in ${delay}ms`
        );
      }
      await sleep(delay);
    }
  }
  throw lastError;
}

// Heuristic: transient upstream failures worth retrying (connection resets,
// timeouts, gateway/rate-limit responses from Pinecone or the LLM provider).
function isTransientUpstreamError(error) {
  const message = String(error?.message || '').toLowerCase();
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  if (status && [408, 425, 429, 500, 502, 503, 504].includes(Number(status))) return true;
  return (
    message.includes('connection error') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('esockettimedout') ||
    message.includes('econnrefused') ||
    message.includes('socket hang up') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('failed to reach pinecone') ||
    message.includes('temporarily unavailable') ||
    message.includes('rate limit')
  );
}

async function withTimeout(promise, ms, label = 'Operation') {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function awaitWithAbort(promise, shouldAbort, pollMs = 200) {
  if (!shouldAbort) return promise;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      fn(value);
    };

    const timer = setInterval(() => {
      try {
        if (shouldAbort()) {
          finish(reject, new Error('Operation aborted for priority work'));
        }
      } catch (error) {
        finish(reject, error);
      }
    }, pollMs);

    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function isPrivateChat(chat) {
  return chat && !chat.isGroup && !chat.isChannel;
}

function isSystemMessageType(type) {
  const { IGNORED_MESSAGE_TYPES } = require('./constants');
  return IGNORED_MESSAGE_TYPES.includes(type);
}

function isIgnorableChatId(chatId) {
  if (!chatId) return false;
  const id = String(chatId);
  return (
    id === 'status@broadcast' ||
    id.endsWith('@g.us') ||
    id.endsWith('@broadcast') ||
    id.endsWith('@newsletter')
  );
}

function isBaseIgnorableMessage(message) {
  if (!message) return true;
  if (message.isStatus) return true;
  if (message.broadcast) return true;
  if (isIgnorableChatId(message.from)) return true;
  if (isIgnorableChatId(message.to)) return true;
  if (isSystemMessageType(message.type)) return true;
  return false;
}

function getReplyChatId(message, chat) {
  const chatId = chat?.id?._serialized;
  if (chatId) return chatId;

  if (message.fromMe) {
    return message.to || message.from;
  }

  return message.from;
}

function extractChatUserId(chatId) {
  if (!chatId) return '';
  return String(chatId).split('@')[0].replace(/\D/g, '');
}

function extractCommand(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();
  return { command, args };
}

function safeDeleteFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore cleanup errors
  }
}

function generateTempFilePath(extension) {
  const tmpDir = ensureDir(TMP_DIR);
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
  return path.join(tmpDir, filename);
}

function isPhoneLikeString(value) {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const compact = trimmed.replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(compact)) return false;
  return compact.replace(/\D/g, '').length >= 8;
}

function phoneTailDigits(value, digits = 10) {
  const normalized = String(value || '').replace(/\D/g, '');
  if (!normalized) return '';
  return normalized.length >= digits ? normalized.slice(-digits) : normalized;
}

function extractPhoneTailFromText(text) {
  const digits = normalizePhoneDigits(text);
  if (!digits) return '';
  if (digits.length >= 10) return digits.slice(-10);
  return '';
}

function isLikelyLidPhone(phone) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return false;
  if (digits.length === 10) return false;
  if (digits.length === 12 && digits.startsWith('91')) return false;
  return digits.length >= 13;
}

function isSkippableWhatsAppChatId(chatId) {
  if (!chatId) return true;
  if (chatId === '0@c.us' || chatId === 'status@broadcast') return true;
  if (chatId.endsWith('@broadcast')) return true;
  return false;
}

function pickContactDisplayName(candidates, phone = null) {
  const seen = new Set();
  const ordered = [];

  for (const candidate of candidates) {
    const value = (candidate || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }

  const human = ordered.filter((v) => !isPhoneLikeString(v));
  if (human.length) return human[0];

  return ordered[0] || phone || 'Unknown';
}

function shouldPreferContactName(current, next, phone = null) {
  if (!next || isPhoneLikeString(next)) return false;
  if (!current || isPhoneLikeString(current)) return true;
  if (phone && current.replace(/\D/g, '') === String(phone).replace(/\D/g, '')) return true;
  return false;
}

function resolveOwnerScopeIds(db, ownerPhones = []) {
  const phones = [...new Set((ownerPhones || []).map((p) => normalizePhone(p)).filter(Boolean))];
  if (!phones.length) {
    return { ownerUserIds: [], profileIds: [] };
  }

  const ownerUserIds = new Set();
  for (const row of db.prepare('SELECT id, phone FROM users').all()) {
    if (phones.some((p) => isSameOwnerPhone(row.phone, p))) {
      ownerUserIds.add(row.id);
    }
  }

  const profileIds = new Set();
  for (const row of db.prepare('SELECT id, owner_phone FROM chat_profiles').all()) {
    if (phones.some((p) => isSameOwnerPhone(row.owner_phone, p))) {
      profileIds.add(row.id);
    }
  }

  return { ownerUserIds: [...ownerUserIds], profileIds: [...profileIds] };
}

function buildScopedIdWhereClause(column, ids = []) {
  if (!ids.length) return { where: '', params: [] };
  return {
    where: `WHERE ${column} IN (${ids.map(() => '?').join(',')})`,
    params: ids,
  };
}

module.exports = {
  ensureDir,
  ensureAppDirs,
  normalizePhone,
  canonicalContactPhone,
  normalizePhoneDigits,
  isSameOwnerPhone,
  resolveOwnerScopeIds,
  buildScopedIdWhereClause,
  formatUserFacingError,
  normalizeChatId,
  formatTimestamp,
  parseReminderDateTime,
  formatReminderTime,
  limitWords,
  truncateText,
  sleep,
  withRetry,
  isTransientUpstreamError,
  withTimeout,
  awaitWithAbort,
  isPrivateChat,
  isSystemMessageType,
  isBaseIgnorableMessage,
  getReplyChatId,
  extractChatUserId,
  extractCommand,
  safeDeleteFile,
  generateTempFilePath,
  isPhoneLikeString,
  isLikelyLidPhone,
  phoneTailDigits,
  extractPhoneTailFromText,
  isSkippableWhatsAppChatId,
  pickContactDisplayName,
  shouldPreferContactName,
};
