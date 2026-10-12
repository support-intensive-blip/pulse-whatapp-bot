const logger = require('../utils/logger');
const { PLATFORM_TABLES_SQL, botAccountsTableSql, studentMemoryTableSql } = require('./schema');

/**
 * Schema changes for the multi-team / multi-number platform. Idempotent: every
 * step checks the current shape first. Data defaults that need env or services
 * (default team, Gallabox credentials from env, prompt v1, KB resource #1) live in
 * services/platformBootstrapService.js and run after the DB is up.
 */

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all();
}

/** Rebuilds `table` from `createSql` (which creates `tempName`), copying shared columns. */
function rebuildTable(database, { table, tempName, createSql, selectOverrides = {} }) {
  const oldColumns = tableColumns(database, table).map((c) => c.name);

  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.exec(`DROP TABLE IF EXISTS ${tempName}`);
      database.exec(createSql);
      const newColumns = tableColumns(database, tempName).map((c) => c.name);
      const targets = newColumns.filter((c) => oldColumns.includes(c) || selectOverrides[c]);
      const selects = targets.map((c) => selectOverrides[c] || c);
      database.exec(
        `INSERT INTO ${tempName} (${targets.join(', ')}) SELECT ${selects.join(', ')} FROM ${table} AS src`
      );
      database.exec(`DROP TABLE ${table}`);
      database.exec(`ALTER TABLE ${tempName} RENAME TO ${table}`);
    })();
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

function migrateBotAccountsMultiBot(database) {
  const ownerColumn = tableColumns(database, 'bot_accounts').find((c) => c.name === 'dashboard_user_id');
  if (ownerColumn && ownerColumn.notnull === 0) return;

  logger.info('Migration: rebuilding bot_accounts for multiple bots per team');
  rebuildTable(database, {
    table: 'bot_accounts',
    tempName: 'bot_accounts_multi',
    createSql: botAccountsTableSql('bot_accounts_multi'),
  });
}

function migrateStudentMemoryPerBot(database, { columnExists }) {
  if (columnExists(database, 'student_user_memory', 'owner_phone')) return;

  logger.info('Migration: scoping student_user_memory to the bot number');
  // Attribute each row to the number the student most recently wrote to; rows
  // with no match get '' and are claimed by the default bot at bootstrap.
  rebuildTable(database, {
    table: 'student_user_memory',
    tempName: 'student_user_memory_scoped',
    createSql: studentMemoryTableSql('student_user_memory_scoped'),
    selectOverrides: {
      owner_phone: `COALESCE((
        SELECT cp.owner_phone FROM chat_profiles cp
        WHERE cp.contact_phone = src.phone OR cp.contact_phone = substr(src.phone, 3)
        ORDER BY datetime(cp.updated_at) DESC LIMIT 1
      ), '')`,
    },
  });
}

function addColumns(database, table, columns, { columnExists }) {
  for (const [column, type] of columns) {
    if (!columnExists(database, table, column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      logger.info(`Migration: added ${table}.${column}`);
    }
  }
}

// Old CTA statuses → the open / in_progress / resolved / closed workflow.
function migrateActionItemStatuses(database) {
  const renames = [
    ['pending', 'open'],
    ['done', 'resolved'],
    ['cancelled', 'closed'],
  ];
  for (const [from, to] of renames) {
    const result = database.prepare('UPDATE action_items SET status = ? WHERE status = ?').run(to, from);
    if (result.changes) logger.info(`Migration: action_items status ${from} → ${to} (${result.changes})`);
  }
}

function runPlatformMigrations(database, helpers) {
  addColumns(
    database,
    'teams',
    [
      ['description', 'TEXT'],
      ['is_active', 'INTEGER NOT NULL DEFAULT 1'],
      ['updated_at', 'TEXT'],
    ],
    helpers
  );

  migrateBotAccountsMultiBot(database);
  database.exec('CREATE INDEX IF NOT EXISTS idx_bot_accounts_user ON bot_accounts(dashboard_user_id)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_bot_accounts_team ON bot_accounts(team_id)');
  database.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_accounts_channel ON bot_accounts(gallabox_channel_id) WHERE gallabox_channel_id IS NOT NULL'
  );

  migrateStudentMemoryPerBot(database, helpers);

  addColumns(
    database,
    'chat_profiles',
    [
      ['tags', 'TEXT'],
      ['assigned_user_id', 'INTEGER'],
      ['contact_notes', 'TEXT'],
      ['import_source', 'TEXT'],
    ],
    helpers
  );
  database.exec('CREATE INDEX IF NOT EXISTS idx_chat_profiles_assigned ON chat_profiles(assigned_user_id)');

  addColumns(
    database,
    'action_items',
    [
      ['due_date', 'TEXT'],
      ['notes', 'TEXT'],
      ['resolution', 'TEXT'],
      ['created_by_user_id', 'INTEGER'],
      ['updated_at', 'TEXT'],
    ],
    helpers
  );
  migrateActionItemStatuses(database);

  // Token usage attributed to the bot and the team it belonged to at the time of the call.
  addColumns(
    database,
    'token_usage',
    [
      ['bot_account_id', 'INTEGER'],
      ['team_id', 'INTEGER'],
    ],
    helpers
  );
  database.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_bot ON token_usage(bot_account_id, created_at)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_team ON token_usage(team_id, created_at)');

  // 'test' (playground / test numbers) or 'live'; NULL until backfilled (trafficEnvironment.js).
  addColumns(database, 'messages', [['environment', 'TEXT']], helpers);
  addColumns(database, 'token_usage', [['environment', 'TEXT']], helpers);

  database.exec(PLATFORM_TABLES_SQL);
}

module.exports = { runPlatformMigrations };
