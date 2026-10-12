#!/usr/bin/env node
/**
 * One-time copy of every SQLite row into Supabase (upsert by primary key, so it's
 * safe to re-run). The server also does this automatically on its first boot with
 * SUPABASE_ENABLED=true; use this script to migrate a DB file by hand.
 *
 * Usage:
 *   npm run supabase:migrate                       # data/assistant.db
 *   npm run supabase:migrate -- path/to/assistant.db
 *
 * Needs SUPABASE_URL + SUPABASE_SECRET_KEY, and backend/supabase/schema.sql applied.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR, DB_FILENAME } = require('../utils/constants');
const supabaseClient = require('../services/supabaseClient');
const {
  checkSupabaseSchema,
  pushAllToSupabase,
  ensureSyncTables,
  setState,
} = require('../database/supabaseSync');

async function main() {
  const dbPath = path.resolve(process.argv[2] || path.join(DATA_DIR, DB_FILENAME));
  if (!fs.existsSync(dbPath)) {
    throw new Error(`SQLite file not found: ${dbPath}`);
  }
  if (!supabaseClient.isConfigured()) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env');
  }

  const db = new Database(dbPath);
  try {
    console.log(`Source: ${dbPath}`);
    await checkSupabaseSchema(db);

    const total = await pushAllToSupabase(db, {
      onTable: (table, count) => console.log(`  ${table}: ${count} rows`),
    });

    // The server won't redo the automatic backfill for this file.
    ensureSyncTables(db);
    setState(db, 'backfilled_at', new Date().toISOString());
    console.log(`Done: ${total} rows upserted to Supabase`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`Migration failed: ${error.message}`);
  process.exit(1);
});
