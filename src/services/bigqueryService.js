const logger = require('../utils/logger');
const { HYDRATE_ORDER, getTableConfig } = require('../database/bqTableConfig');

let BigQuery = null;
let client = null;

function isEnabled() {
  return process.env.BQ_ENABLED === 'true' && Boolean(process.env.GCP_PROJECT_ID);
}

function getProjectId() {
  return process.env.GCP_PROJECT_ID || null;
}

function getDatasetId() {
  return process.env.BQ_DATASET || 'whatsapp_bot';
}

function getClient() {
  if (!isEnabled()) return null;
  if (!client) {
    // Lazy-require: keeps @google-cloud/bigquery off the require path entirely when BQ is disabled.
    BigQuery = BigQuery || require('@google-cloud/bigquery').BigQuery;
    client = new BigQuery({ projectId: getProjectId() });
  }
  return client;
}

// Booleans/flags are stored as SQLite INTEGER (0/1); BigQuery INTEGER round-trips them fine.
const INTEGER_FIELD_HINTS = [
  'is_active', 'sent', 'assistant_active', 'assistant_pinned_on', 'assistant_self_enabled',
  'assistant_contacts_enabled', 'guru_mode', 'use_owner_api_key', 'reply_delay_seconds',
  'prompt_tokens', 'completion_tokens', 'total_tokens',
];

function bqTypeForField(table, field, timestamps) {
  if (timestamps.includes(field)) return 'TIMESTAMP';
  if (field === 'id' || field.endsWith('_id')) return 'INTEGER';
  if (field.includes('cost') || field.endsWith('_usd')) return 'FLOAT64';
  if (INTEGER_FIELD_HINTS.includes(field)) return 'INTEGER';
  return 'STRING';
}

function buildBigQuerySchema(table) {
  const config = getTableConfig(table);
  if (!config) return null;
  const schema = config.fields.map((field) => ({
    name: field,
    type: bqTypeForField(table, field, config.timestamps),
    mode: field === config.idField ? 'REQUIRED' : 'NULLABLE',
  }));
  schema.push({ name: 'server_source', type: 'STRING', mode: 'NULLABLE' });
  schema.push({ name: 'migrated_at', type: 'TIMESTAMP', mode: 'NULLABLE' });
  return schema;
}

async function ensureDataset(bq) {
  const dataset = bq.dataset(getDatasetId());
  const [exists] = await dataset.exists();
  if (!exists) {
    await bq.createDataset(getDatasetId(), { location: process.env.BQ_LOCATION || 'US' });
    logger.info(`BigQuery dataset created: ${getDatasetId()}`);
  }
  return dataset;
}

async function ensureAllTables() {
  if (!isEnabled()) return { enabled: false, tables: [] };

  const bq = getClient();
  const dataset = await ensureDataset(bq);
  const ensured = [];

  for (const table of HYDRATE_ORDER) {
    const schema = buildBigQuerySchema(table);
    if (!schema) continue;

    const bqTable = dataset.table(table);
    const [exists] = await bqTable.exists();
    if (!exists) {
      await dataset.createTable(table, { schema });
      logger.info(`BigQuery table created: ${table}`);
    }
    ensured.push(table);
  }

  return { enabled: true, tables: ensured };
}

async function insertWarehouseRows(table, rows, { useLoadJob = false } = {}) {
  if (!isEnabled()) {
    logger.warn(`BigQuery insert skipped for ${table} (BigQuery not enabled)`);
    return false;
  }
  if (!Array.isArray(rows) || rows.length === 0) return true;

  const bq = getClient();
  const dataset = bq.dataset(getDatasetId());
  const bqTable = dataset.table(table);

  if (useLoadJob) {
    const [job] = await bqTable.load(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')), {
      sourceFormat: 'NEWLINE_DELIMITED_JSON',
      writeDisposition: 'WRITE_APPEND',
    });
    const [metadata] = await job.getMetadata();
    if (metadata.status?.errors?.length) {
      throw new Error(`BigQuery load job failed for ${table}: ${JSON.stringify(metadata.status.errors)}`);
    }
    return true;
  }

  await bqTable.insert(rows, { ignoreUnknownValues: true, skipInvalidRows: false });
  return true;
}

module.exports = {
  isEnabled,
  getProjectId,
  getDatasetId,
  getClient,
  ensureAllTables,
  insertWarehouseRows,
};
