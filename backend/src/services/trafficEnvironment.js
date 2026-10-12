const logger = require('../utils/logger');
const { canonicalContactPhone, normalizePhone, normalizePhoneDigits } = require('../utils/helpers');

/**
 * Splits traffic into 'test' and 'live' so analytics and token usage can be read
 * separately. A chat is test traffic when it is:
 *   - a dashboard playground session (chat_id ends with @pulse.test), or
 *   - with one of the bot's test numbers (bot_accounts.test_numbers)
 * Messages and token usage are stamped when written, so history doesn't change when
 * a test-number list is edited later. NULL = written before stamping existed.
 */
const ENV = { TEST: 'test', LIVE: 'live' };
const PLAYGROUND_SUFFIX = '@pulse.test';

function parseList(json) {
  try {
    const list = JSON.parse(json || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Map of bot phone digits → Set of canonical test numbers. */
function testNumbersByBotPhone(db) {
  const map = new Map();
  for (const bot of db.prepare('SELECT whatsapp_phone, last_whatsapp_phone, test_numbers FROM bot_accounts').all()) {
    const numbers = new Set(parseList(bot.test_numbers).map(canonicalContactPhone).filter(Boolean));
    for (const phone of [bot.last_whatsapp_phone, bot.whatsapp_phone]) {
      const digits = normalizePhoneDigits(phone);
      if (digits) map.set(digits, numbers);
    }
  }
  return map;
}

function classifyProfile(profile, testNumbers) {
  if (!profile) return ENV.LIVE;
  if (String(profile.chat_id || '').endsWith(PLAYGROUND_SUFFIX)) return ENV.TEST;
  const numbers = testNumbers.get(normalizePhoneDigits(profile.owner_phone));
  if (!numbers?.size) return ENV.LIVE;
  const contact =
    canonicalContactPhone(profile.contact_phone) || canonicalContactPhone(normalizePhone(profile.chat_id));
  return contact && numbers.has(contact) ? ENV.TEST : ENV.LIVE;
}

/** 'test' | 'live' for one chat profile, as of now. */
function environmentForProfile(db, chatProfileId) {
  if (chatProfileId == null) return ENV.LIVE;
  try {
    const profile = db
      .prepare('SELECT id, chat_id, owner_phone, contact_phone FROM chat_profiles WHERE id = ?')
      .get(chatProfileId);
    return classifyProfile(profile, testNumbersByBotPhone(db));
  } catch {
    return ENV.LIVE;
  }
}

/** Ids of every chat profile that is currently test traffic. */
function testProfileIds(db) {
  const testNumbers = testNumbersByBotPhone(db);
  return db
    .prepare('SELECT id, chat_id, owner_phone, contact_phone FROM chat_profiles')
    .all()
    .filter((profile) => classifyProfile(profile, testNumbers) === ENV.TEST)
    .map((profile) => profile.id);
}

/** Stamps rows written before environment tracking (environment IS NULL). */
function backfillEnvironment(db) {
  const pending = ['messages', 'token_usage'].filter(
    (table) => db.prepare(`SELECT 1 FROM ${table} WHERE environment IS NULL LIMIT 1`).get()
  );
  if (!pending.length) return 0;

  const ids = testProfileIds(db);
  let updated = 0;
  db.transaction(() => {
    for (const table of pending) {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        updated += db
          .prepare(
            `UPDATE ${table} SET environment = 'test'
             WHERE environment IS NULL AND chat_profile_id IN (${chunk.map(() => '?').join(',')})`
          )
          .run(...chunk).changes;
      }
      updated += db.prepare(`UPDATE ${table} SET environment = 'live' WHERE environment IS NULL`).run().changes;
    }
  })();
  logger.info(`Backfilled test/live environment on ${updated} row(s)`);
  return updated;
}

function normalizeEnv(value) {
  return value === ENV.TEST ? ENV.TEST : ENV.LIVE;
}

module.exports = {
  ENV,
  environmentForProfile,
  testProfileIds,
  backfillEnvironment,
  normalizeEnv,
};
