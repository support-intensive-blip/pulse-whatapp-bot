const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { SCHEMA_SQL, MIGRATION_SQL } = require('./schema');
const { DATA_DIR, DB_FILENAME } = require('../utils/constants');
const { ensureDir } = require('../utils/helpers');
const logger = require('../utils/logger');
const { isBigQueryPrimary, isSqlitePersisted } = require('./storageMode');
const { hydrateFromBigQuery } = require('./bqHydrate');
const { wrapDatabaseForBqSync } = require('./bqSync');
const { recoverAfterHydrate } = require('../services/configPersistenceService');

let db = null;
let bqReady = false;

function getDbPath() {
  if (!isSqlitePersisted()) {
    if (!isBigQueryPrimary()) {
      throw new Error(
        'Invalid storage config: SQLITE_ENABLED=false requires BQ_ENABLED=true (BigQuery-primary mode). ' +
          'Set BQ_ENABLED=true or SQLITE_ENABLED=true in .env.'
      );
    }
    return ':memory:';
  }
  const dataDir = ensureDir(DATA_DIR);
  return path.join(dataDir, DB_FILENAME);
}

function columnExists(database, table, column) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  return columns.some((col) => col.name === column);
}

function indexExists(database, indexName) {
  const row = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName);
  return Boolean(row);
}

function migrateChatProfilesOwnerScoped(database) {
  if (indexExists(database, 'idx_chat_profiles_owner_chat')) return;

  logger.info('Migration: rebuilding chat_profiles with owner-scoped chat_id uniqueness');

  database.pragma('foreign_keys = OFF');
  try {
    database.exec('DROP TABLE IF EXISTS chat_profiles_owner_scoped');
    database.exec(`
      CREATE TABLE chat_profiles_owner_scoped (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        owner_phone TEXT NOT NULL,
        contact_name TEXT,
        contact_phone TEXT,
        contact_role TEXT,
        contact_responsibilities TEXT,
        contact_relations TEXT,
        chat_type TEXT NOT NULL DEFAULT 'contact',
        assistant_active INTEGER NOT NULL DEFAULT 1,
        assistant_pinned_on INTEGER NOT NULL DEFAULT 0,
        paused_until TEXT,
        conversation_mode TEXT NOT NULL DEFAULT 'casual',
        context_topic TEXT,
        routing_slots TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO chat_profiles_owner_scoped (
        id, chat_id, owner_phone, contact_name, contact_phone, contact_role,
        contact_responsibilities, contact_relations, chat_type, assistant_active,
        assistant_pinned_on, paused_until, conversation_mode, context_topic, routing_slots,
        created_at, updated_at
      )
      SELECT
        id, chat_id, owner_phone, contact_name, contact_phone, contact_role,
        contact_responsibilities, contact_relations, chat_type, assistant_active,
        assistant_pinned_on, paused_until, conversation_mode, context_topic,
        ${columnExists(database, 'chat_profiles', 'routing_slots') ? 'routing_slots' : 'NULL'},
        created_at, updated_at
      FROM chat_profiles;

      DROP TABLE chat_profiles;
      ALTER TABLE chat_profiles_owner_scoped RENAME TO chat_profiles;

      CREATE UNIQUE INDEX idx_chat_profiles_owner_chat ON chat_profiles(owner_phone, chat_id);
      CREATE INDEX IF NOT EXISTS idx_chat_profiles_owner ON chat_profiles(owner_phone);
    `);
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

function runMigrations(database) {
  database.exec(MIGRATION_SQL);

  if (!columnExists(database, 'messages', 'chat_profile_id')) {
    database.exec('ALTER TABLE messages ADD COLUMN chat_profile_id INTEGER REFERENCES chat_profiles(id)');
    logger.info('Migration: added messages.chat_profile_id');
  }

  if (!columnExists(database, 'conversation_summaries', 'chat_profile_id')) {
    database.exec(
      'ALTER TABLE conversation_summaries ADD COLUMN chat_profile_id INTEGER REFERENCES chat_profiles(id)'
    );
    logger.info('Migration: added conversation_summaries.chat_profile_id');
  }

  if (!columnExists(database, 'users', 'display_name')) {
    database.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
    logger.info('Migration: added users.display_name');
  }

  if (!columnExists(database, 'users', 'persona')) {
    database.exec('ALTER TABLE users ADD COLUMN persona TEXT');
    logger.info('Migration: added users.persona');
  }

  if (!columnExists(database, 'chat_profiles', 'contact_phone')) {
    database.exec('ALTER TABLE chat_profiles ADD COLUMN contact_phone TEXT');
    logger.info('Migration: added chat_profiles.contact_phone');
  }

  if (!columnExists(database, 'chat_profiles', 'assistant_active')) {
    database.exec('ALTER TABLE chat_profiles ADD COLUMN assistant_active INTEGER NOT NULL DEFAULT 1');
    logger.info('Migration: added chat_profiles.assistant_active');
  }

  if (!columnExists(database, 'chat_profiles', 'paused_until')) {
    database.exec('ALTER TABLE chat_profiles ADD COLUMN paused_until TEXT');
    logger.info('Migration: added chat_profiles.paused_until');
  }

  if (!columnExists(database, 'chat_profiles', 'assistant_pinned_on')) {
    database.exec(
      'ALTER TABLE chat_profiles ADD COLUMN assistant_pinned_on INTEGER NOT NULL DEFAULT 0'
    );
    logger.info('Migration: added chat_profiles.assistant_pinned_on');
  }

  if (!columnExists(database, 'users', 'assistant_self_enabled')) {
    database.exec('ALTER TABLE users ADD COLUMN assistant_self_enabled INTEGER NOT NULL DEFAULT 1');
    logger.info('Migration: added users.assistant_self_enabled');
  }

  if (!columnExists(database, 'users', 'assistant_contacts_enabled')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN assistant_contacts_enabled INTEGER NOT NULL DEFAULT 1'
    );
    logger.info('Migration: added users.assistant_contacts_enabled');
  }

  if (!columnExists(database, 'users', 'chat_model_tier')) {
    database.exec("ALTER TABLE users ADD COLUMN chat_model_tier TEXT NOT NULL DEFAULT 'fast'");
    logger.info('Migration: added users.chat_model_tier');
  }

  if (!columnExists(database, 'chat_profiles', 'conversation_mode')) {
    database.exec(
      "ALTER TABLE chat_profiles ADD COLUMN conversation_mode TEXT NOT NULL DEFAULT 'casual'"
    );
    logger.info('Migration: added chat_profiles.conversation_mode');
  }

  if (!columnExists(database, 'chat_profiles', 'context_topic')) {
    database.exec('ALTER TABLE chat_profiles ADD COLUMN context_topic TEXT');
    logger.info('Migration: added chat_profiles.context_topic');
  }

  if (!columnExists(database, 'messages', 'source')) {
    database.exec('ALTER TABLE messages ADD COLUMN source TEXT');
    logger.info('Migration: added messages.source');
  }

  if (!columnExists(database, 'messages', 'wa_message_id')) {
    database.exec('ALTER TABLE messages ADD COLUMN wa_message_id TEXT');
    logger.info('Migration: added messages.wa_message_id');
  }

  if (!columnExists(database, 'messages', 'kb_meta')) {
    database.exec('ALTER TABLE messages ADD COLUMN kb_meta TEXT');
    logger.info('Migration: added messages.kb_meta');
  }

  database.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_dedupe ON messages(chat_profile_id, wa_message_id) WHERE wa_message_id IS NOT NULL'
  );

  if (columnExists(database, 'messages', 'chat_profile_id')) {
    database.exec(
      'CREATE INDEX IF NOT EXISTS idx_messages_chat_profile ON messages(chat_profile_id)'
    );
    database.exec(
      'CREATE INDEX IF NOT EXISTS idx_messages_profile_id ON messages(chat_profile_id, id)'
    );
  }

  if (columnExists(database, 'conversation_summaries', 'chat_profile_id')) {
    database.exec(
      'CREATE INDEX IF NOT EXISTS idx_summaries_chat_profile ON conversation_summaries(chat_profile_id)'
    );
  }

  database.exec('CREATE INDEX IF NOT EXISTS idx_chat_profiles_owner ON chat_profiles(owner_phone)');

  const botConfigColumns = [
    ['assistant_persona', 'TEXT'],
    ['assistant_role_when_asked', 'TEXT'],
    ['openai_model_fast', 'TEXT'],
    ['openai_model_smart', 'TEXT'],
    ['knowledge_base_path', 'TEXT'],
    ['chat_model_tier', "TEXT DEFAULT 'fast'"],
    ['prompt_config', 'TEXT'],
  ];

  for (const [column, type] of botConfigColumns) {
    if (!columnExists(database, 'bot_accounts', column)) {
      database.exec(`ALTER TABLE bot_accounts ADD COLUMN ${column} ${type}`);
      logger.info(`Migration: added bot_accounts.${column}`);
    }
  }

  if (!columnExists(database, 'bot_accounts', 'last_pairing_code')) {
    database.exec('ALTER TABLE bot_accounts ADD COLUMN last_pairing_code TEXT');
    logger.info('Migration: added bot_accounts.last_pairing_code');
  }

  if (!columnExists(database, 'bot_accounts', 'reply_delay_seconds')) {
    database.exec(
      'ALTER TABLE bot_accounts ADD COLUMN reply_delay_seconds INTEGER NOT NULL DEFAULT 0'
    );
    logger.info('Migration: added bot_accounts.reply_delay_seconds');
  }

  const actionItemColumns = [
    ['category', 'TEXT'],
    ['priority', 'TEXT'],
    ['dedupe_key', 'TEXT'],
    ['trigger_message_id', 'INTEGER'],
  ];

  for (const [column, type] of actionItemColumns) {
    if (!columnExists(database, 'action_items', column)) {
      database.exec(`ALTER TABLE action_items ADD COLUMN ${column} ${type}`);
      logger.info(`Migration: added action_items.${column}`);
    }
  }

  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_action_items_dedupe ON action_items(bot_account_id, dedupe_key, status)'
  );

  database.exec(`
    CREATE TABLE IF NOT EXISTS email_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      current_email TEXT NOT NULL,
      new_email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER,
      review_note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES dashboard_users(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewed_by) REFERENCES dashboard_users(id) ON DELETE SET NULL
    )
  `);
  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_email_change_requests_status ON email_change_requests(status)'
  );
  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_email_change_requests_user ON email_change_requests(user_id)'
  );

  if (!columnExists(database, 'dashboard_users', 'coach_phone')) {
    database.exec('ALTER TABLE dashboard_users ADD COLUMN coach_phone TEXT');
    logger.info('Migration: added dashboard_users.coach_phone');
  }

  if (!columnExists(database, 'dashboard_users', 'action_alert_phones')) {
    database.exec('ALTER TABLE dashboard_users ADD COLUMN action_alert_phones TEXT');
    logger.info('Migration: added dashboard_users.action_alert_phones');
  }

  if (!columnExists(database, 'action_items', 'assigned_dashboard_user_id')) {
    database.exec('ALTER TABLE action_items ADD COLUMN assigned_dashboard_user_id INTEGER');
    logger.info('Migration: added action_items.assigned_dashboard_user_id');
  }

  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_action_items_assigned_user ON action_items(assigned_dashboard_user_id)'
  );

  database.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dashboard_user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (dashboard_user_id) REFERENCES dashboard_users(id) ON DELETE CASCADE
    )
  `);
  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(dashboard_user_id)'
  );

  migrateChatProfilesOwnerScoped(database);

  if (!columnExists(database, 'chat_profiles', 'routing_slots')) {
    database.exec('ALTER TABLE chat_profiles ADD COLUMN routing_slots TEXT');
    logger.info('Migration: added chat_profiles.routing_slots');
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (owner_user_id) REFERENCES dashboard_users(id) ON DELETE CASCADE
    )
  `);
  database.exec('CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_user_id)');

  if (!columnExists(database, 'dashboard_users', 'team_id')) {
    database.exec('ALTER TABLE dashboard_users ADD COLUMN team_id INTEGER REFERENCES teams(id)');
    logger.info('Migration: added dashboard_users.team_id');
  }
  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_dashboard_users_team ON dashboard_users(team_id)'
  );

  database.exec(
    "UPDATE dashboard_users SET role = 'owner' WHERE role = 'admin'"
  );

  database.exec(`
    CREATE TABLE IF NOT EXISTS team_settings (
      team_id INTEGER PRIMARY KEY,
      openai_api_key_encrypted TEXT,
      assistant_persona TEXT,
      openai_model_fast TEXT,
      openai_model_smart TEXT,
      chat_model_tier TEXT DEFAULT 'fast',
      knowledge_base_path TEXT,
      prompt_config TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
    )
  `);

  if (!columnExists(database, 'team_settings', 'use_owner_api_key')) {
    database.exec(
      'ALTER TABLE team_settings ADD COLUMN use_owner_api_key INTEGER NOT NULL DEFAULT 0'
    );
    logger.info('Migration: added team_settings.use_owner_api_key');
  }

  if (!columnExists(database, 'team_settings', 'reply_delay_seconds')) {
    database.exec(
      'ALTER TABLE team_settings ADD COLUMN reply_delay_seconds INTEGER NOT NULL DEFAULT 0'
    );
    logger.info('Migration: added team_settings.reply_delay_seconds');
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS api_key_access_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      requested_by_user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      reviewed_by_user_id INTEGER,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY (requested_by_user_id) REFERENCES dashboard_users(id) ON DELETE CASCADE
    )
  `);
  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_api_key_requests_team ON api_key_access_requests(team_id)'
  );
  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_api_key_requests_status ON api_key_access_requests(status)'
  );

  if (!columnExists(database, 'bot_accounts', 'last_whatsapp_phone')) {
    database.exec('ALTER TABLE bot_accounts ADD COLUMN last_whatsapp_phone TEXT');
    database.exec(
      'UPDATE bot_accounts SET last_whatsapp_phone = whatsapp_phone WHERE whatsapp_phone IS NOT NULL'
    );
    logger.info('Migration: added bot_accounts.last_whatsapp_phone');
  }

  if (!columnExists(database, 'token_usage', 'estimated_cost_usd')) {
    database.exec(
      'ALTER TABLE token_usage ADD COLUMN estimated_cost_usd REAL NOT NULL DEFAULT 0'
    );
    logger.info('Migration: added token_usage.estimated_cost_usd');
  }
}

function initializeDatabase() {
  if (db) return db;

  try {
    const dbPath = getDbPath();

    if (dbPath !== ':memory:') {
      const dbDir = path.dirname(dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
    }

    db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      db.pragma('journal_mode = WAL');
    }
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    runMigrations(db);

    if (isBigQueryPrimary()) {
      logger.info('Database initialized in-memory (BigQuery-primary mode)');
    } else {
      logger.info(`Database initialized at ${dbPath}`);
    }
    return db;
  } catch (error) {
    logger.error(`Database initialization failed: ${error.message}`, { stack: error.stack });
    throw error;
  }
}

async function initializeDatabaseAsync() {
  const database = initializeDatabase();
  if (!isBigQueryPrimary() || bqReady) {
    return database;
  }

  await hydrateFromBigQuery(database);
  wrapDatabaseForBqSync(database);
  recoverAfterHydrate(database);
  database.exec(
    `UPDATE bot_accounts
     SET last_whatsapp_phone = whatsapp_phone
     WHERE last_whatsapp_phone IS NULL AND whatsapp_phone IS NOT NULL`
  );
  const { recoverTokenUsageFromDisk, repairOwnerUserIds, backfillEstimatedCostUsd } = require('../services/tokenUsagePersistence');
  repairOwnerUserIds(database);
  backfillEstimatedCostUsd(database);
  recoverTokenUsageFromDisk(database);
  bqReady = true;
  return database;
}

function isBigQueryReady() {
  return !isBigQueryPrimary() || bqReady;
}

function getDatabase() {
  if (!db) {
    initializeDatabase();
  }
  if (isBigQueryPrimary() && !bqReady) {
    throw new Error('BigQuery hydrate not complete — call initializeDatabaseAsync() at startup');
  }
  return db;
}

function closeDatabase() {
  if (db) {
    try {
      db.close();
      logger.info('Database connection closed');
    } catch (error) {
      logger.error(`Error closing database: ${error.message}`);
    } finally {
      db = null;
    }
  }
}

module.exports = {
  initializeDatabase,
  initializeDatabaseAsync,
  isBigQueryReady,
  getDatabase,
  closeDatabase,
};
