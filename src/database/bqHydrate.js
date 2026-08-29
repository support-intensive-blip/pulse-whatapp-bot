const logger = require('../utils/logger');
const bigqueryService = require('../services/bigqueryService');
const { HYDRATE_ORDER, getTableConfig } = require('./bqTableConfig');

function toSqliteValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value.value !== undefined) {
    return toSqliteValue(value.value);
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

function rowToSqlite(row, config) {
  const out = {};
  for (const field of config.fields) {
    if (field in row) out[field] = toSqliteValue(row[field]);
  }
  return out;
}

function buildDedupeQuery(projectId, datasetId, table, idField) {
  return `
    SELECT * EXCEPT(rn)
    FROM (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY ${idField}
          ORDER BY migrated_at DESC NULLS LAST
        ) AS rn
      FROM \`${projectId}.${datasetId}.${table}\`
    )
    WHERE rn = 1
  `;
}

async function fetchTableRows(table) {
  const config = getTableConfig(table);
  if (!config) return [];

  const projectId = bigqueryService.getProjectId();
  const datasetId = bigqueryService.getDatasetId();
  const bq = bigqueryService.getClient();
  if (!bq) throw new Error('BigQuery client is not configured');

  const [rows] = await bq.query({
    query: buildDedupeQuery(projectId, datasetId, table, config.idField),
  });
  return rows;
}

function insertRows(db, table, rows) {
  if (!rows.length) return 0;

  const config = getTableConfig(table);
  const columns = config.fields;
  const placeholders = columns.map(() => '?').join(', ');
  const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
  const stmt = db.prepare(sql);

  let count = 0;
  const tx = db.transaction((items) => {
    for (const raw of items) {
      const row = rowToSqlite(raw, config);
      stmt.run(...columns.map((col) => row[col] ?? null));
      count += 1;
    }
  });
  tx(rows);
  return count;
}

function updateSqliteSequences(db) {
  for (const table of HYDRATE_ORDER) {
    const config = getTableConfig(table);
    if (!config.idField || config.idField !== 'id') continue;
    const row = db.prepare(`SELECT MAX(id) AS max_id FROM ${table}`).get();
    if (!row?.max_id) continue;
    db.prepare('INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(
      table,
      row.max_id
    );
  }
}

async function hydrateFromBigQuery(db) {
  if (!bigqueryService.isEnabled()) {
    throw new Error('BQ_ENABLED=true is required for BigQuery-primary mode');
  }

  await bigqueryService.ensureAllTables();

  logger.info('Hydrating in-memory database from BigQuery...');
  db.pragma('foreign_keys = OFF');

  let total = 0;
  const fetched = await Promise.all(
    HYDRATE_ORDER.map(async (table) => {
      const rows = await fetchTableRows(table);
      return { table, rows };
    })
  );

  for (const { table, rows } of fetched) {
    try {
      const inserted = insertRows(db, table, rows);
      total += inserted;
      logger.info(`  ${table}: ${inserted} rows`);
    } catch (error) {
      logger.error(`  ${table}: hydrate failed — ${error.message}`);
      throw error;
    }
  }

  updateSqliteSequences(db);
  db.pragma('foreign_keys = ON');
  logger.info(`BigQuery hydrate complete (${total} rows)`);
  return total;
}

module.exports = {
  hydrateFromBigQuery,
};
