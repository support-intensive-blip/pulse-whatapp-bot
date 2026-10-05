/**
 * Purge conversation data from assistant.db.
 * Requires SQLITE_DELETION_PASSWORD (env or --password=...).
 * Keeps bot accounts / WhatsApp session files intact unless --also-users.
 *
 * Usage:
 *   SQLITE_DELETION_PASSWORD=... node scripts/purge-conversations.js --password=...
 *   node scripts/purge-conversations.js --password=YOUR_PASSWORD
 */
const Database = require('better-sqlite3');
const path = require('path');

const {
  assertDeletionPassword,
  backupSqliteDatabase,
} = require('../src/database/sqliteGuard');

const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'assistant.db');
const passwordArg = process.argv.find((a) => a.startsWith('--password='));
const password = passwordArg
  ? passwordArg.slice('--password='.length)
  : process.env.SQLITE_DELETION_PASSWORD_CONFIRM || '';

assertDeletionPassword(password, { action: 'purge conversation data' });
backupSqliteDatabase({ reason: 'pre-purge' });

const db = new Database(dbPath);

function count(table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  } catch (_error) {
    return 0;
  }
}

const alsoUsers = process.argv.includes('--also-users');

const before = {
  messages: count('messages'),
  conversation_summaries: count('conversation_summaries'),
  chat_profiles: count('chat_profiles'),
  action_items: count('action_items'),
  token_usage: count('token_usage'),
  notes: count('notes'),
  reminders: count('reminders'),
  users: count('users'),
};

const purge = db.transaction(() => {
  db.exec('DELETE FROM messages');
  db.exec('DELETE FROM conversation_summaries');
  db.exec('DELETE FROM action_items');
  db.exec('DELETE FROM token_usage');
  db.exec('DELETE FROM chat_profiles');
  db.exec('DELETE FROM notes');
  db.exec('DELETE FROM reminders');
  if (alsoUsers) {
    db.exec('DELETE FROM users');
  }
});

purge();
db.exec('VACUUM');

const after = {
  messages: count('messages'),
  conversation_summaries: count('conversation_summaries'),
  chat_profiles: count('chat_profiles'),
  action_items: count('action_items'),
  token_usage: count('token_usage'),
  notes: count('notes'),
  reminders: count('reminders'),
  users: count('users'),
};

console.log(
  JSON.stringify(
    {
      dbPath,
      before,
      after,
      ok: after.messages === 0 && after.chat_profiles === 0,
    },
    null,
    2
  )
);
