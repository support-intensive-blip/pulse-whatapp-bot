#!/usr/bin/env node
/**
 * Export all SQLite data to GCP BigQuery, then optionally purge local rows.
 *
 * Usage:
 *   node src/scripts/migrate-sqlite-to-bigquery.js
 *   node src/scripts/migrate-sqlite-to-bigquery.js --purge
 *   node src/scripts/migrate-sqlite-to-bigquery.js --server-source aws
 */
require('dotenv').config();
const { initializeDatabase, getDatabase } = require('../database/db');
const bigqueryService = require('../services/bigqueryService');

const PURGE = process.argv.includes('--purge');
const SERVER_SOURCE =
  process.argv.find((a) => a.startsWith('--server-source='))?.split('=')[1] ||
  process.env.SERVER_SOURCE ||
  process.env.HOSTNAME ||
  'local';

const TABLE_FIELDS = {
  users: [
    'id', 'phone', 'name', 'display_name', 'persona', 'assistant_self_enabled',
    'assistant_contacts_enabled', 'guru_mode', 'created_at',
  ],
  dashboard_users: [
    'id', 'email', 'password_hash', 'name', 'coach_phone', 'action_alert_phones',
    'role', 'is_active', 'team_id', 'created_at',
  ],
  teams: ['id', 'name', 'owner_user_id', 'created_at'],
  team_settings: [
    'team_id', 'openai_api_key_encrypted', 'assistant_persona', 'openai_model_fast',
    'openai_model_smart', 'chat_model_tier', 'knowledge_base_path', 'prompt_config', 'updated_at',
  ],
  bot_accounts: [
    'id', 'dashboard_user_id', 'name', 'whatsapp_phone', 'status', 'session_client_id',
    'assistant_name', 'assistant_self_enabled', 'assistant_contacts_enabled', 'guru_mode',
    'last_error', 'created_at', 'updated_at',
  ],
  chat_profiles: [
    'id', 'chat_id', 'owner_phone', 'contact_name', 'contact_phone', 'contact_role',
    'contact_responsibilities', 'contact_relations', 'chat_type', 'assistant_active',
    'assistant_pinned_on', 'paused_until', 'conversation_mode', 'created_at', 'updated_at',
  ],
  messages: [
    'id', 'user_id', 'chat_profile_id', 'role', 'content', 'source', 'wa_message_id', 'timestamp',
  ],
  conversation_summaries: ['id', 'user_id', 'chat_profile_id', 'summary', 'created_at'],
  action_items: [
    'id', 'bot_account_id', 'chat_profile_id', 'assigned_dashboard_user_id', 'source', 'title',
    'description', 'status', 'category', 'priority', 'triggered_at', 'completed_at', 'created_at',
  ],
  token_usage: [
    'id', 'chat_profile_id', 'owner_user_id', 'category', 'model', 'prompt_tokens',
    'completion_tokens', 'total_tokens', 'created_at',
  ],
  notes: ['id', 'user_id', 'content', 'created_at'],
  reminders: ['id', 'user_id', 'message', 'scheduled_time', 'sent', 'created_at'],
};

const TABLE_MAP = [
  { sqlite: 'users', bq: 'users', ts: ['created_at'] },
  { sqlite: 'dashboard_users', bq: 'dashboard_users', ts: ['created_at'] },
  { sqlite: 'teams', bq: 'teams', ts: ['created_at'] },
  { sqlite: 'team_settings', bq: 'team_settings', ts: ['updated_at'] },
  { sqlite: 'bot_accounts', bq: 'bot_accounts', ts: ['created_at', 'updated_at'] },
  { sqlite: 'chat_profiles', bq: 'chat_profiles', ts: ['created_at', 'updated_at'] },
  { sqlite: 'messages', bq: 'messages', ts: ['timestamp'] },
  { sqlite: 'conversation_summaries', bq: 'conversation_summaries', ts: ['created_at'] },
  { sqlite: 'action_items', bq: 'action_items', ts: ['triggered_at', 'completed_at', 'created_at'] },
  { sqlite: 'token_usage', bq: 'token_usage', ts: ['created_at'] },
  { sqlite: 'notes', bq: 'notes', ts: ['created_at'] },
  { sqlite: 'reminders', bq: 'reminders', ts: ['scheduled_time', 'created_at'] },
];

const PURGE_TABLES = [
  'messages',
  'conversation_summaries',
  'token_usage',
  'notes',
  'reminders',
  'action_items',
];

function tableExists(db, name) {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

function toTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeRow(row, tsFields, bqTable) {
  const fields = TABLE_FIELDS[bqTable] || Object.keys(row);
  const out = {};
  for (const field of fields) {
    if (field in row) out[field] = row[field];
  }
  for (const field of tsFields) {
    if (field in out) out[field] = toTimestamp(out[field]);
  }
  out.server_source = SERVER_SOURCE;
  out.migrated_at = new Date().toISOString();
  return out;
}

async function insertBatch(tableId, rows) {
  if (!rows.length) return 0;
  const ok = await bigqueryService.insertWarehouseRows(tableId, rows, { useLoadJob: true });
  if (!ok) throw new Error(`Failed to load rows into ${tableId}`);
  return rows.length;
}

async function migrateTable(db, { sqlite, bq, ts }) {
  if (!tableExists(db, sqlite)) {
    console.log(`  skip ${sqlite} (table missing)`);
    return 0;
  }

  const rows = db.prepare(`SELECT * FROM ${sqlite}`).all();
  if (!rows.length) {
    console.log(`  skip ${sqlite} (0 rows)`);
    return 0;
  }

  const batchSize = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize).map((r) => normalizeRow(r, ts, bq));
    inserted += await insertBatch(bq, chunk);
  }
  console.log(`  ${sqlite} -> ${bq}: ${inserted} rows`);
  return inserted;
}

function purgeLocalData(db) {
  const tx = db.transaction(() => {
    for (const table of PURGE_TABLES) {
      if (!tableExists(db, table)) continue;
      const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
      db.prepare(`DELETE FROM ${table}`).run();
      console.log(`  purged ${table}: ${count} rows`);
    }
    try {
      db.prepare('VACUUM').run();
    } catch {
      // ignore vacuum errors in WAL mode
    }
  });
  tx();
}

async function main() {
  if (!bigqueryService.isEnabled()) {
    console.error('Set BQ_ENABLED=true and GCP_PROJECT_ID in .env');
    process.exit(1);
  }

  initializeDatabase();
  const db = getDatabase();

  console.log(`Ensuring BigQuery tables (${SERVER_SOURCE})...`);
  await bigqueryService.ensureAllTables();

  console.log('Migrating SQLite -> BigQuery...');
  let total = 0;
  for (const spec of TABLE_MAP) {
    total += await migrateTable(db, spec);
  }
  console.log(`Migration complete: ${total} rows inserted.`);

  if (PURGE) {
    console.log('Purging migrated conversation data from local SQLite...');
    purgeLocalData(db);
    console.log(
      'Local purge done. Auth/teams/chat profiles kept in SQLite so the bot keeps running.'
    );
  } else {
    console.log('Run with --purge to delete messages/summaries/token_usage from this server.');
  }
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  if (error.errors) console.error(JSON.stringify(error.errors, null, 2));
  process.exit(1);
});
