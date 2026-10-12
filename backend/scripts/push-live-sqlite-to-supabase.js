#!/usr/bin/env node
/**
 * Rescue copy: pushes every row of a live SQLite DB into Supabase using only
 * better-sqlite3 + built-in fetch (no @supabase/supabase-js), so it runs inside an
 * older deployed container from Render → Shell. Upserts by primary key; safe to re-run.
 * The Supabase tables must already exist (backend/supabase/schema.sql).
 *
 * Usage (Render Shell):
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=sb_secret_... \
 *     node scripts/push-live-sqlite-to-supabase.js [/app/data/assistant.db] [--dry-run]
 */
const path = require('path');

const Database = require(require.resolve('better-sqlite3', { paths: [process.cwd(), '/app'] }));

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DB_PATH = args.find((a) => !a.startsWith('--')) || path.join(process.cwd(), 'data', 'assistant.db');
const URL_BASE = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const CHUNK = 300;

function q(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function upsert(table, pk, rows) {
  const res = await fetch(`${URL_BASE}/rest/v1/${encodeURIComponent(table)}?on_conflict=${encodeURIComponent(pk)}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
}

async function main() {
  if (!DRY_RUN && (!URL_BASE || !KEY)) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY');
  const db = new Database(DB_PATH, { readonly: true });
  console.log(`Source: ${DB_PATH}${DRY_RUN ? ' (dry run)' : ''}`);

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_supabase%' ESCAPE '\\' ORDER BY name"
    )
    .all()
    .map((r) => r.name);

  let total = 0;
  for (const table of tables) {
    const pkCols = db.prepare(`PRAGMA table_info(${q(table)})`).all().filter((c) => c.pk > 0);
    if (pkCols.length !== 1) {
      console.log(`  ${table}: skipped (no single primary key)`);
      continue;
    }
    const pk = pkCols[0].name;
    const rows = db.prepare(`SELECT * FROM ${q(table)} ORDER BY ${q(pk)}`).all();
    if (!DRY_RUN) {
      for (let i = 0; i < rows.length; i += CHUNK) await upsert(table, pk, rows.slice(i, i + CHUNK));
    }
    total += rows.length;
    console.log(`  ${table}: ${rows.length} rows`);
  }
  db.close();
  console.log(`Done: ${total} rows ${DRY_RUN ? 'found' : 'upserted to Supabase'}`);
}

main().catch((error) => {
  console.error(`Push failed: ${error.message}`);
  process.exit(1);
});
