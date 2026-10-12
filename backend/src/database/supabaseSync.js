const logger = require('../utils/logger');
const supabaseClient = require('../services/supabaseClient');

/**
 * Supabase (Postgres) as the durable store behind the synchronous SQLite cache.
 *
 * Every table gets AFTER INSERT/UPDATE/DELETE triggers that append (table, pk, op)
 * to _supabase_outbox. A background flusher reads the outbox in order, loads the
 * current row for each touched pk and upserts it to Supabase (or deletes it there
 * when the row is gone). Triggers catch every write path — ON CONFLICT upserts,
 * INSERT OR REPLACE, multi-row UPDATE/DELETE and FK cascades — without touching
 * the hundreds of db.prepare() call sites.
 *
 * The Postgres tables mirror SQLite (see `npm run supabase:schema`); SQLite still
 * enforces NOT NULL / UNIQUE / FK rules, so the mirror only declares primary keys.
 */

const OUTBOX = '_supabase_outbox';
const STATE = '_supabase_state';
const TRIGGER_PREFIX = '_sb_';
const PAGE_SIZE = 1000; // PostgREST's default max-rows
const READ_CHUNK = 500;
const MAX_REQUEST_ROWS = 500;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

let flushTimer = null;
let lockTail = Promise.resolve();
let lastErrorLogAt = 0;

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Serializes flushes and backfill chunks so an older row snapshot never lands after a newer one.
function withLock(fn) {
  const run = lockTail.then(fn, fn);
  lockTail = run.catch(() => {});
  return run;
}

/** Every app table with a single-column primary key, as { table, pk }. */
function listSyncTables(db) {
  const names = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (?, ?)
       ORDER BY name`
    )
    .all(OUTBOX, STATE)
    .map((r) => r.name);

  const tables = [];
  for (const table of names) {
    const pkCols = db
      .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
      .all()
      .filter((c) => c.pk > 0);
    if (pkCols.length !== 1) {
      logger.warn(`Supabase sync: skipping ${table} (needs exactly one primary key column)`);
      continue;
    }
    tables.push({ table, pk: pkCols[0].name });
  }
  return tables;
}

function ensureSyncTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${OUTBOX} (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      tbl TEXT NOT NULL,
      pk,
      op TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${STATE} (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

function getState(db, key) {
  return db.prepare(`SELECT value FROM ${STATE} WHERE key = ?`).get(key)?.value ?? null;
}

function setState(db, key, value) {
  db.prepare(
    `INSERT INTO ${STATE} (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

function dropSyncTriggers(db) {
  const triggers = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ?")
    .all(`${TRIGGER_PREFIX}%`);
  for (const { name } of triggers) {
    db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(name)}`);
  }
}

/**
 * (Re)creates the change-capture triggers. Run after migrations every boot: table
 * rebuilds (DROP + RENAME) take their triggers with them.
 */
function installSyncTriggers(db) {
  ensureSyncTables(db);
  // INSERT OR REPLACE removes the conflicting row; this makes that fire the delete trigger.
  db.pragma('recursive_triggers = ON');

  for (const { table, pk } of listSyncTables(db)) {
    const t = quoteIdent(table);
    const lit = `'${table.replace(/'/g, "''")}'`;
    const col = quoteIdent(pk);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${TRIGGER_PREFIX}${table}_ins`)}
      AFTER INSERT ON ${t} BEGIN
        INSERT INTO ${OUTBOX} (tbl, pk, op) VALUES (${lit}, NEW.${col}, 'upsert');
      END;
      CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${TRIGGER_PREFIX}${table}_upd`)}
      AFTER UPDATE ON ${t} BEGIN
        INSERT INTO ${OUTBOX} (tbl, pk, op) SELECT ${lit}, OLD.${col}, 'delete' WHERE OLD.${col} IS NOT NEW.${col};
        INSERT INTO ${OUTBOX} (tbl, pk, op) VALUES (${lit}, NEW.${col}, 'upsert');
      END;
      CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${TRIGGER_PREFIX}${table}_del`)}
      AFTER DELETE ON ${t} BEGIN
        INSERT INTO ${OUTBOX} (tbl, pk, op) VALUES (${lit}, OLD.${col}, 'delete');
      END;
    `);
  }
}

function toPostgresValue(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'bigint') return Number(value);
  return value;
}

function toPostgresRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) out[key] = toPostgresValue(value);
  return out;
}

/** Splits rows into request-sized batches (row count and JSON size). */
function* requestBatches(rows) {
  let batch = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (batch.length && (batch.length >= MAX_REQUEST_ROWS || bytes + size > MAX_REQUEST_BYTES)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(row);
    bytes += size;
  }
  if (batch.length) yield batch;
}

function describeError(table, error) {
  const hint =
    error.code === 'PGRST204' || error.code === 'PGRST205' || error.code === '42P01'
      ? ' — the Supabase schema is behind SQLite; run `npm run supabase:schema` and re-run backend/supabase/schema.sql'
      : '';
  return new Error(`${table}: ${error.message}${hint}`);
}

async function upsertRows(table, pk, rows) {
  const supabase = supabaseClient.getClient();
  for (const batch of requestBatches(rows.map(toPostgresRow))) {
    const { error } = await supabase.from(table).upsert(batch, { onConflict: pk });
    if (error) throw describeError(table, error);
  }
}

async function deleteRows(table, pk, ids) {
  const supabase = supabaseClient.getClient();
  for (let i = 0; i < ids.length; i += MAX_REQUEST_ROWS) {
    const { error } = await supabase.from(table).delete().in(pk, ids.slice(i, i + MAX_REQUEST_ROWS));
    if (error) throw describeError(table, error);
  }
}

function selectRowsByPk(db, table, pk, ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const chunk = ids.slice(i, i + READ_CHUNK);
    rows.push(
      ...db
        .prepare(
          `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(pk)} IN (${chunk.map(() => '?').join(', ')})`
        )
        .all(...chunk)
    );
  }
  return rows;
}

async function flushBatch(db, limit) {
  const entries = db
    .prepare(`SELECT seq, tbl, pk, op FROM ${OUTBOX} ORDER BY seq LIMIT ?`)
    .all(limit);
  if (!entries.length) return { processed: 0, failed: 0 };

  const maxSeq = entries[entries.length - 1].seq;

  // Last op per row wins; upserts re-read the row, so only the final state matters.
  const byTable = new Map();
  for (const entry of entries) {
    if (!byTable.has(entry.tbl)) byTable.set(entry.tbl, new Map());
    byTable.get(entry.tbl).set(`${typeof entry.pk}:${entry.pk}`, entry);
  }

  const pkByTable = new Map(listSyncTables(db).map((t) => [t.table, t.pk]));
  const done = [];
  const failed = [];

  for (const [table, latest] of byTable) {
    const pk = pkByTable.get(table);
    if (!pk) {
      done.push(table); // table no longer exists locally
      continue;
    }
    const upsertIds = [];
    const deleteIds = [];
    for (const entry of latest.values()) {
      (entry.op === 'delete' ? deleteIds : upsertIds).push(entry.pk);
    }

    try {
      const rows = upsertIds.length ? selectRowsByPk(db, table, pk, upsertIds) : [];
      const found = new Set(rows.map((r) => `${typeof r[pk]}:${r[pk]}`));
      for (const id of upsertIds) {
        if (!found.has(`${typeof id}:${id}`)) deleteIds.push(id);
      }
      if (rows.length) await upsertRows(table, pk, rows);
      if (deleteIds.length) await deleteRows(table, pk, deleteIds);
      done.push(table);
    } catch (error) {
      failed.push(table);
      logSyncError(error);
    }
  }

  if (done.length) {
    db.prepare(
      `DELETE FROM ${OUTBOX} WHERE seq <= ? AND tbl IN (${done.map(() => '?').join(', ')})`
    ).run(maxSeq, ...done);
  }
  return { processed: entries.length, failed: failed.length };
}

function logSyncError(error) {
  const now = Date.now();
  if (now - lastErrorLogAt < 60000) return;
  lastErrorLogAt = now;
  logger.error(`Supabase sync failed (changes stay queued and retry): ${error.message}`);
}

/** Pushes queued changes until the outbox is empty or a table keeps failing. */
function flushSupabaseOutbox(db, { limit = 2000 } = {}) {
  return withLock(async () => {
    let total = 0;
    for (;;) {
      const { processed, failed } = await flushBatch(db, limit);
      total += processed;
      if (!processed || failed) break;
    }
    return total;
  });
}

function pendingCount(db) {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${OUTBOX}`).get()?.c || 0);
  } catch (_error) {
    return 0;
  }
}

function startSupabaseSyncScheduler(db) {
  if (flushTimer) return;
  const intervalMs = Math.max(250, Number(process.env.SUPABASE_SYNC_INTERVAL_MS) || 1000);
  let running = false;
  flushTimer = setInterval(async () => {
    if (running || !pendingCount(db)) return;
    running = true;
    try {
      await flushSupabaseOutbox(db);
    } catch (error) {
      logSyncError(error);
    } finally {
      running = false;
    }
  }, intervalMs);
  flushTimer.unref();
  logger.info(`Supabase write-through sync enabled (every ${intervalMs}ms)`);
}

/** Final flush on shutdown, bounded so a Supabase outage can't hang the exit. */
async function stopSupabaseSync(db, { timeoutMs = 10000 } = {}) {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (!pendingCount(db)) return;
  await Promise.race([
    flushSupabaseOutbox(db),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
  const left = pendingCount(db);
  if (left) logger.warn(`Supabase: ${left} change(s) still queued at shutdown`);
}

async function fetchAllRows(table, pk) {
  const supabase = supabaseClient.getClient();
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order(pk, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw describeError(table, error);
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

function insertHydratedRows(db, table, rows) {
  if (!rows.length) return 0;
  const columns = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
  const statements = new Map();

  function statementFor(cols) {
    const key = cols.join(',');
    if (!statements.has(key)) {
      statements.set(
        key,
        db.prepare(
          `INSERT OR REPLACE INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')})
           VALUES (${cols.map(() => '?').join(', ')})`
        )
      );
    }
    return statements.get(key);
  }

  db.transaction(() => {
    for (const row of rows) {
      // A NULL in a NOT NULL column means the column was added after the row was
      // pushed; leave it out so the SQLite default applies.
      const cols = columns
        .filter((c) => c.name in row && !(row[c.name] === null && c.notnull))
        .map((c) => c.name);
      statementFor(cols).run(...cols.map((c) => row[c]));
    }
  })();
  return rows.length;
}

function updateSqliteSequences(db, tables) {
  const hasSequence = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
    .get();
  if (!hasSequence) return;
  for (const { table, pk } of tables) {
    const max = db.prepare(`SELECT MAX(${quoteIdent(pk)}) AS m FROM ${quoteIdent(table)}`).get()?.m;
    if (typeof max !== 'number') continue;
    db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table);
    db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, max);
  }
}

/** Loads every Supabase table into SQLite. Triggers must be off (see dropSyncTriggers). */
async function hydrateFromSupabase(db) {
  const tables = listSyncTables(db);
  logger.info('Hydrating SQLite from Supabase...');

  const fetched = await Promise.all(
    tables.map(async ({ table, pk }) => ({ table, rows: await fetchAllRows(table, pk) }))
  );

  db.pragma('foreign_keys = OFF');
  let total = 0;
  try {
    for (const { table, rows } of fetched) {
      total += insertHydratedRows(db, table, rows);
      logger.info(`  ${table}: ${rows.length} rows`);
    }
    updateSqliteSequences(db, tables);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  logger.info(`Supabase hydrate complete (${total} rows)`);
  return total;
}

/**
 * Upserts every local row to Supabase (the one-time SQLite → Supabase migration).
 * Idempotent; each chunk is read and sent under the flush lock.
 */
async function pushAllToSupabase(db, { onTable } = {}) {
  let total = 0;
  for (const { table, pk } of listSyncTables(db)) {
    let count = 0;
    let last = null;
    for (;;) {
      const sent = await withLock(async () => {
        const rows = last === null
          ? db.prepare(`SELECT * FROM ${quoteIdent(table)} ORDER BY ${quoteIdent(pk)} LIMIT ?`).all(READ_CHUNK)
          : db
              .prepare(
                `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(pk)} > ? ORDER BY ${quoteIdent(pk)} LIMIT ?`
              )
              .all(last, READ_CHUNK);
        if (rows.length) await upsertRows(table, pk, rows);
        return rows;
      });
      if (!sent.length) break;
      count += sent.length;
      last = sent[sent.length - 1][pk];
      if (sent.length < READ_CHUNK) break;
    }
    total += count;
    if (onTable) onTable(table, count);
  }
  return total;
}

/** Throws a readable error when Supabase is unreachable or the schema is missing. */
async function checkSupabaseSchema(db) {
  const supabase = supabaseClient.getClient();
  const missing = [];
  // A plain GET: HEAD responses carry no body, so a missing table would look like success.
  for (const { table, pk } of listSyncTables(db)) {
    const { error } = await supabase.from(table).select(pk).limit(1);
    if (!error) continue;
    if (error.code === 'PGRST205' || error.code === '42P01') {
      missing.push(table);
    } else {
      throw describeError(table, error);
    }
  }
  if (missing.length) {
    throw new Error(
      `Supabase is missing table(s): ${missing.join(', ')}. ` +
        'Run backend/supabase/schema.sql in the Supabase SQL editor (regenerate it with `npm run supabase:schema`).'
    );
  }
}

module.exports = {
  OUTBOX,
  listSyncTables,
  ensureSyncTables,
  getState,
  setState,
  dropSyncTriggers,
  installSyncTriggers,
  flushSupabaseOutbox,
  startSupabaseSyncScheduler,
  stopSupabaseSync,
  hydrateFromSupabase,
  pushAllToSupabase,
  checkSupabaseSchema,
  pendingCount,
};
