#!/usr/bin/env node
/**
 * Generates backend/supabase/schema.sql: the Postgres mirror of the SQLite schema,
 * built by running the real schema + migrations on an in-memory DB and introspecting it.
 *
 * With --apply (and SUPABASE_DB_URL in .env) it also runs the SQL against Supabase.
 * The server does the same on boot when SUPABASE_DB_URL is set.
 *
 * Usage: npm run supabase:schema [-- --apply]
 */
require('dotenv').config();
process.env.SQLITE_ENABLED = 'false';
process.env.SUPABASE_ENABLED = 'true';

const fs = require('fs');
const path = require('path');
const { initializeDatabase } = require('../database/db');
const { buildSupabaseSchemaSql, applySupabaseSchema } = require('../database/supabaseSchema');

const OUT_FILE = path.join(__dirname, '..', '..', 'supabase', 'schema.sql');

async function main() {
  const db = initializeDatabase();
  const { sql, tableCount } = buildSupabaseSchemaSql(db);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, sql);
  console.log(`Wrote ${OUT_FILE} (${tableCount} tables)`);

  if (process.argv.includes('--apply')) {
    if (!process.env.SUPABASE_DB_URL) throw new Error('--apply needs SUPABASE_DB_URL in .env');
    await applySupabaseSchema(db);
    console.log('Applied to Supabase');
  }
}

main().catch((error) => {
  console.error(`Schema generation failed: ${error.message}`);
  process.exit(1);
});
