const logger = require('../utils/logger');
const bigqueryService = require('../services/bigqueryService');
const { getTableConfig } = require('./bqTableConfig');
const { getServerSource } = require('./storageMode');

const SYNCABLE_TABLES = new Set(
  require('./bqTableConfig').BQ_SYNC_TABLES.map((t) => t.table)
);

const SYNC_DEBOUNCE_MS = {
  bot_accounts: 60000,
  chat_profiles: 20000,
  token_usage: 0,
  messages: 3000,
};

const pendingSyncs = new Map();

function parseMutation(sql) {
  const trimmed = sql.trim();
  const insert = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`]?(\w+)/i.exec(trimmed);
  if (insert) return { op: 'insert', table: insert[1] };
  const update = /^UPDATE\s+["`]?(\w+)/i.exec(trimmed);
  if (update) return { op: 'update', table: update[1] };
  const del = /^DELETE\s+FROM\s+["`]?(\w+)/i.exec(trimmed);
  if (del) return { op: 'delete', table: del[1] };
  return null;
}

function toTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function rowForBigQuery(table, row) {
  const config = getTableConfig(table);
  if (!config) return null;

  const out = {};
  for (const field of config.fields) {
    if (field in row) {
      out[field] = config.timestamps.includes(field) ? toTimestamp(row[field]) : row[field];
    }
  }
  out.server_source = getServerSource();
  out.migrated_at = new Date().toISOString();
  return out;
}

function syncRowToBigQuery(db, table, idField, idValue) {
  if (String(process.env.TEST_API_SKIP_BQ_SYNC || '').toLowerCase() === 'true') {
    return;
  }
  if (!SYNCABLE_TABLES.has(table)) return;

  const config = getTableConfig(table);
  const row = db.prepare(`SELECT * FROM ${table} WHERE ${idField} = ?`).get(idValue);
  if (!row) return;

  const payload = rowForBigQuery(table, row);
  if (!payload) return;

  return bigqueryService.insertWarehouseRows(table, [payload]).catch((error) => {
    logger.error(`BigQuery sync failed for ${table}#${idValue}: ${error.message}`);
  });
}

function flushSyncToBigQuery(db, table, idField, idValue) {
  if (String(process.env.TEST_API_SKIP_BQ_SYNC || '').toLowerCase() === 'true') {
    return;
  }
  if (pendingSyncs.has(`${table}:${idValue}`)) {
    clearTimeout(pendingSyncs.get(`${table}:${idValue}`));
    pendingSyncs.delete(`${table}:${idValue}`);
  }
  return syncRowToBigQuery(db, table, idField, idValue);
}

function scheduleSync(db, table, idField, idValue) {
  if (String(process.env.TEST_API_SKIP_BQ_SYNC || '').toLowerCase() === 'true') {
    return;
  }
  const key = `${table}:${idValue}`;
  const delayMs = SYNC_DEBOUNCE_MS[table] ?? 5000;

  if (delayMs <= 0) {
    if (pendingSyncs.has(key)) {
      clearTimeout(pendingSyncs.get(key));
      pendingSyncs.delete(key);
    }
    return syncRowToBigQuery(db, table, idField, idValue);
  }

  if (pendingSyncs.has(key)) return;

  const timer = setTimeout(() => {
    pendingSyncs.delete(key);
    syncRowToBigQuery(db, table, idField, idValue);
  }, delayMs);

  pendingSyncs.set(key, timer);
}

function flushAllPendingSyncs(db) {
  const timers = [...pendingSyncs.entries()];
  for (const [key, timer] of timers) {
    clearTimeout(timer);
    pendingSyncs.delete(key);
    const [table, idValue] = key.split(':');
    const config = getTableConfig(table);
    if (config) {
      syncRowToBigQuery(db, table, config.idField, idValue);
    }
  }
}

function extractIdFromWhere(sql, args) {
  const match = /WHERE\s+id\s*=\s*\?/i.exec(sql);
  if (match) {
    return { field: 'id', value: args[args.length - 1] };
  }
  const teamMatch = /WHERE\s+team_id\s*=\s*\?/i.exec(sql);
  if (teamMatch) {
    return { field: 'team_id', value: args[args.length - 1] };
  }
  return null;
}

function queueSync(db, sql, args, result) {
  const mutation = parseMutation(sql);
  if (!mutation || !SYNCABLE_TABLES.has(mutation.table)) return;

  const config = getTableConfig(mutation.table);

  if (mutation.op === 'insert') {
    const id = result?.lastInsertRowid;
    if (id) {
      scheduleSync(db, mutation.table, config.idField, id);
    }
    return;
  }

  if (mutation.op === 'update') {
    const idInfo = extractIdFromWhere(sql, args);
    if (idInfo) {
      scheduleSync(db, mutation.table, idInfo.field, idInfo.value);
    }
  }
}

function wrapDatabaseForBqSync(db) {
  const originalPrepare = db.prepare.bind(db);

  db.prepare = function prepareWithSync(sql) {
    const stmt = originalPrepare(sql);
    const originalRun = stmt.run.bind(stmt);

    stmt.run = function runWithSync(...args) {
      const result = originalRun(...args);
      queueSync(db, sql, args, result);
      return result;
    };

    return stmt;
  };

  logger.info('BigQuery write-through sync enabled (debounced streaming inserts)');
  return db;
}

module.exports = {
  wrapDatabaseForBqSync,
  flushSyncToBigQuery,
  flushAllPendingSyncs,
};
