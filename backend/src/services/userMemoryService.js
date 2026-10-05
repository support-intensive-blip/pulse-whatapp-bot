const { getDatabase } = require('../database/db');
const chatProfileService = require('./chatProfileService');
const { canonicalContactPhone, normalizePhone, normalizePhoneDigits, isLikelyLidPhone } = require('../utils/helpers');
const logger = require('../utils/logger');

const MAX_PREF_NOTE_CHARS = Number(process.env.USER_MEMORY_NOTE_MAX_CHARS) || 1800;
const MAX_PREF_JSON_CHARS = Number(process.env.USER_MEMORY_JSON_MAX_CHARS) || 8000;
const MAX_SUMMARY_CHARS = Number(process.env.USER_MEMORY_SUMMARY_MAX_CHARS) || 8000;

function parseStored(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizePreferenceValue(value, depth = 0) {
  if (depth > 4) return undefined;
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 500) : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => sanitizePreferenceValue(item, depth + 1))
      .filter((item) => item !== undefined)
      .slice(0, 20);
    return items.length ? items : undefined;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, nested] of Object.entries(value).slice(0, 40)) {
      const safeKey = String(key).trim().slice(0, 64);
      if (!safeKey) continue;
      const sanitized = sanitizePreferenceValue(nested, depth + 1);
      if (sanitized !== undefined) out[safeKey] = sanitized;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

function mergePreferences(current, incoming) {
  const base = isPlainObject(current) ? { ...current } : {};
  if (!isPlainObject(incoming)) return base;

  for (const [key, value] of Object.entries(incoming)) {
    if (value == null) continue;
    if (isPlainObject(value) && isPlainObject(base[key])) {
      base[key] = mergePreferences(base[key], value);
    } else {
      const sanitized = sanitizePreferenceValue(value);
      if (sanitized !== undefined) base[key] = sanitized;
    }
  }
  return base;
}

/**
 * Durable student key: normalized phone digits (e.g. 91XXXXXXXXXX).
 * Survives chat_profile id changes, WhatsApp logout, and container redeploys
 * (SQLite lives on the host-mounted /app/data volume).
 */
function resolveStudentPhone(chatProfileOrId) {
  const profile =
    chatProfileOrId && typeof chatProfileOrId === 'object'
      ? chatProfileOrId
      : chatProfileService.findById(chatProfileOrId);

  if (!profile) return null;

  const fromContact = canonicalContactPhone(profile.contact_phone);
  if (
    fromContact &&
    normalizePhoneDigits(fromContact).length >= 10 &&
    !isLikelyLidPhone(fromContact)
  ) {
    return fromContact;
  }

  const fromChat = canonicalContactPhone(normalizePhone(profile.chat_id));
  if (
    fromChat &&
    normalizePhoneDigits(fromChat).length >= 10 &&
    !isLikelyLidPhone(fromChat) &&
    !String(profile.chat_id || '').includes('@lid')
  ) {
    return fromChat;
  }

  return null;
}

function serializePreferences(preferences) {
  const compact = sanitizePreferenceValue(preferences) || {};
  if (!Object.keys(compact).length) return null;
  let serialized = JSON.stringify(compact);
  if (serialized.length > MAX_PREF_JSON_CHARS) {
    serialized = serialized.slice(0, MAX_PREF_JSON_CHARS);
  }
  return { compact, serialized };
}

class UserMemoryService {
  getRowByPhone(phone) {
    if (!phone) return null;
    const db = getDatabase();
    return (
      db.prepare('SELECT phone, preferences, last_conversation_summary, updated_at FROM student_user_memory WHERE phone = ?').get(phone) ||
      null
    );
  }

  ensureRow(phone) {
    if (!phone) return null;
    const db = getDatabase();
    db.prepare(
      `INSERT INTO student_user_memory (phone, preferences, last_conversation_summary)
       VALUES (?, NULL, NULL)
       ON CONFLICT(phone) DO NOTHING`
    ).run(phone);
    return this.getRowByPhone(phone);
  }

  getPreferencesByPhone(phone) {
    return parseStored(this.getRowByPhone(phone)?.preferences);
  }

  getPreferences(chatProfileOrId) {
    const phone = resolveStudentPhone(chatProfileOrId);
    if (phone) return this.getPreferencesByPhone(phone);

    // Legacy fallback while migrating old profile-scoped rows.
    const profileId =
      chatProfileOrId && typeof chatProfileOrId === 'object'
        ? chatProfileOrId.id
        : chatProfileOrId;
    if (!profileId) return {};
    const db = getDatabase();
    const row = db
      .prepare('SELECT user_preferences FROM chat_profiles WHERE id = ?')
      .get(profileId);
    return parseStored(row?.user_preferences);
  }

  savePreferencesByPhone(phone, preferences) {
    if (!phone) return {};
    this.ensureRow(phone);
    const { compact, serialized } = serializePreferences(preferences);
    const db = getDatabase();
    db.prepare(
      `UPDATE student_user_memory
       SET preferences = ?, updated_at = datetime('now')
       WHERE phone = ?`
    ).run(serialized, phone);
    return compact || {};
  }

  mergeAndSave(chatProfileOrId, incoming) {
    const phone = resolveStudentPhone(chatProfileOrId);
    if (!phone) {
      logger.warn(
        `User memory skipped — no resolvable student phone for profile ${
          chatProfileOrId?.id || chatProfileOrId
        }`
      );
      return {};
    }
    if (!isPlainObject(incoming) || !Object.keys(incoming).length) {
      return this.getPreferencesByPhone(phone);
    }

    const merged = mergePreferences(this.getPreferencesByPhone(phone), incoming);
    const saved = this.savePreferencesByPhone(phone, merged);
    logger.info(
      `User memory updated for phone ${phone}: keys=${Object.keys(saved).join(',') || 'none'}`
    );
    return saved;
  }

  saveConversationSummary(chatProfileOrId, summary) {
    const phone = resolveStudentPhone(chatProfileOrId);
    const text = typeof summary === 'string' ? summary.trim().slice(0, MAX_SUMMARY_CHARS) : '';
    if (!phone || !text) return null;

    this.ensureRow(phone);
    const db = getDatabase();
    db.prepare(
      `UPDATE student_user_memory
       SET last_conversation_summary = ?, updated_at = datetime('now')
       WHERE phone = ?`
    ).run(text, phone);
    logger.info(`Stored conversation summary for phone ${phone}`);
    return text;
  }

  getSummaryContext(chatProfileOrId) {
    const phone = resolveStudentPhone(chatProfileOrId);
    const latest = phone ? this.getRowByPhone(phone)?.last_conversation_summary || '' : '';
    if (!latest.trim()) return '';

    const context = `Previous conversation summary (internal — use for continuity, do not dump to student):\n${latest}`;
    if (context.length <= MAX_SUMMARY_CHARS) return context;
    return `${context.slice(0, MAX_SUMMARY_CHARS)}...`;
  }

  buildContextNote(chatProfileOrId) {
    const prefs = this.getPreferences(chatProfileOrId);
    if (!Object.keys(prefs).length) return '';

    let json = JSON.stringify(prefs, null, 0);
    if (json.length > MAX_PREF_NOTE_CHARS) {
      json = `${json.slice(0, MAX_PREF_NOTE_CHARS)}...`;
    }

    return [
      '=== STUDENT USER MEMORY (internal — use silently, do not dump raw JSON to student) ===',
      'Known preferences / durable facts from prior conversations. Prefer these when relevant.',
      json,
      '=== END STUDENT USER MEMORY ===',
    ].join('\n');
  }
}

module.exports = {
  userMemoryService: new UserMemoryService(),
  mergePreferences,
  sanitizePreferenceValue,
  resolveStudentPhone,
};
