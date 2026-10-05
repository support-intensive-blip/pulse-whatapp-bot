const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, DB_FILENAME } = require('../utils/constants');
const { ensureDir } = require('../utils/helpers');
const logger = require('../utils/logger');

const BACKUP_DIRNAME = 'sqlite-backups';
const DEFAULT_KEEP = 14;

function getConfiguredDeletionPassword() {
  return String(process.env.SQLITE_DELETION_PASSWORD || '').trim();
}

function isDeletionGuardEnabled() {
  return getConfiguredDeletionPassword().length > 0;
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) {
    // Compare anyway to keep timing flatter for wrong lengths.
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/**
 * Throws unless the provided password matches SQLITE_DELETION_PASSWORD.
 * When the env password is unset, destructive ops are blocked (fail closed).
 */
function assertDeletionPassword(password, { action = 'delete SQLite data' } = {}) {
  const expected = getConfiguredDeletionPassword();
  if (!expected) {
    const err = new Error(
      `Refusing to ${action}: SQLITE_DELETION_PASSWORD is not configured. ` +
        'Set it in .env to allow intentional data deletion.'
    );
    err.code = 'SQLITE_GUARD_NOT_CONFIGURED';
    throw err;
  }
  if (!timingSafeEqualString(password, expected)) {
    const err = new Error(`Refusing to ${action}: invalid deletion password`);
    err.code = 'SQLITE_GUARD_INVALID_PASSWORD';
    throw err;
  }
}

function getSqlitePaths() {
  const dataDir = ensureDir(DATA_DIR);
  const dbPath = path.join(dataDir, DB_FILENAME);
  return {
    dataDir,
    dbPath,
    walPath: `${dbPath}-wal`,
    shmPath: `${dbPath}-shm`,
    backupDir: ensureDir(path.join(dataDir, BACKUP_DIRNAME)),
  };
}

function listBackups(backupDir) {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((name) => name.startsWith('assistant-') && name.endsWith('.db'))
    .map((name) => ({
      name,
      path: path.join(backupDir, name),
      mtimeMs: fs.statSync(path.join(backupDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function pruneBackups(backupDir, keep = DEFAULT_KEEP) {
  const keepCount = Math.max(
    1,
    Number(process.env.SQLITE_BACKUP_KEEP || keep) || keep
  );
  const backups = listBackups(backupDir);
  for (const old of backups.slice(keepCount)) {
    try {
      fs.unlinkSync(old.path);
    } catch (error) {
      logger.warn(`Failed to prune SQLite backup ${old.name}: ${error.message}`);
    }
  }
}

/**
 * Copy the live DB (and WAL if present) into data/sqlite-backups/.
 * Safe to call while better-sqlite3 has the DB open (filesystem copy).
 */
function backupSqliteDatabase({ reason = 'manual' } = {}) {
  const { dbPath, walPath, shmPath, backupDir } = getSqlitePaths();
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: 'missing_db', path: dbPath };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `assistant-${stamp}-${reason}.db`);
  fs.copyFileSync(dbPath, target);
  if (fs.existsSync(walPath)) {
    try {
      fs.copyFileSync(walPath, `${target}-wal`);
    } catch (_error) {
      // WAL copy is best-effort
    }
  }
  if (fs.existsSync(shmPath)) {
    try {
      fs.copyFileSync(shmPath, `${target}-shm`);
    } catch (_error) {
      // SHM copy is best-effort
    }
  }

  pruneBackups(backupDir);
  logger.info(`SQLite backup created: ${target} (reason=${reason})`);
  return { ok: true, path: target, reason };
}

/**
 * Delete assistant.db (+ wal/shm) only with the deletion password.
 * Always takes a backup first.
 */
function deleteSqliteDatabaseFiles({ password, reason = 'delete_files' } = {}) {
  assertDeletionPassword(password, { action: 'delete SQLite database files' });
  const backup = backupSqliteDatabase({ reason: `predelete-${reason}` });
  const { dbPath, walPath, shmPath } = getSqlitePaths();

  for (const filePath of [dbPath, walPath, shmPath]) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.warn(`Deleted SQLite file: ${filePath}`);
    }
  }

  return { ok: true, backup };
}

function startSqliteBackupScheduler() {
  if (String(process.env.SQLITE_BACKUP_ENABLED || 'true').toLowerCase() === 'false') {
    return;
  }
  if (!require('./storageMode').isSqlitePersisted()) {
    return;
  }

  const hours = Math.max(1, Number(process.env.SQLITE_BACKUP_INTERVAL_HOURS || 24) || 24);
  const intervalMs = hours * 60 * 60 * 1000;

  try {
    backupSqliteDatabase({ reason: 'startup' });
  } catch (error) {
    logger.warn(`Startup SQLite backup failed: ${error.message}`);
  }

  setInterval(() => {
    try {
      backupSqliteDatabase({ reason: 'scheduled' });
    } catch (error) {
      logger.warn(`Scheduled SQLite backup failed: ${error.message}`);
    }
  }, intervalMs).unref();

  logger.info(
    `SQLite deletion guard ${isDeletionGuardEnabled() ? 'ON' : 'OFF (set SQLITE_DELETION_PASSWORD)'}; ` +
      `backups every ${hours}h → data/${BACKUP_DIRNAME}/`
  );
}

module.exports = {
  assertDeletionPassword,
  backupSqliteDatabase,
  deleteSqliteDatabaseFiles,
  getConfiguredDeletionPassword,
  getSqlitePaths,
  isDeletionGuardEnabled,
  startSqliteBackupScheduler,
};
