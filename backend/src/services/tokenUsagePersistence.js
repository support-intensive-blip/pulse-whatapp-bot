const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../utils/constants');
const { ensureDir } = require('../utils/helpers');
const logger = require('../utils/logger');
const { isSameOwnerPhone } = require('../utils/helpers');

const TOKEN_LOG_PATH = path.join(DATA_DIR, 'token-usage-log.jsonl');

function appendTokenUsageLog(record) {
  try {
    ensureDir(DATA_DIR);
    fs.appendFileSync(TOKEN_LOG_PATH, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    logger.warn(`Token usage disk log failed: ${error.message}`);
  }
}

function readTokenUsageLog() {
  try {
    if (!fs.existsSync(TOKEN_LOG_PATH)) return [];
    const lines = fs.readFileSync(TOKEN_LOG_PATH, 'utf8').split('\n').filter(Boolean);
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // skip corrupt lines
      }
    }
    return records;
  } catch {
    return [];
  }
}

function rowExists(db, record) {
  const match = db
    .prepare(
      `SELECT id FROM token_usage
       WHERE chat_profile_id IS ? AND owner_user_id IS ? AND category = ?
         AND model IS ? AND prompt_tokens = ? AND completion_tokens = ?
         AND total_tokens = ? AND created_at = ?`
    )
    .get(
      record.chatProfileId ?? null,
      record.ownerUserId ?? null,
      record.category,
      record.model || null,
      record.promptTokens,
      record.completionTokens,
      record.totalTokens,
      record.createdAt
    );
  return Boolean(match);
}

function recoverTokenUsageFromDisk(db) {
  const records = readTokenUsageLog();
  if (!records.length) return 0;

  const existingCount = Number(
    db.prepare('SELECT COUNT(*) AS c FROM token_usage').get()?.c || 0
  );
  // Disk log is a crash-recovery aid — skip when DB already holds usage rows.
  if (existingCount >= records.length) {
    logger.info(
      `Skipping token usage disk recovery (${existingCount} row(s) already in DB)`
    );
    return 0;
  }

  // Stale disk-log rows can reference a chat_profile/user that no longer exists
  // after hydrate (profiles get merged/rebuilt). token_usage FKs are ON DELETE
  // SET NULL, so mirror that here to avoid FOREIGN KEY constraint crashes on boot.
  const validChatProfileIds = new Set(
    db.prepare('SELECT id FROM chat_profiles').all().map((row) => row.id)
  );
  const validUserIds = new Set(db.prepare('SELECT id FROM users').all().map((row) => row.id));

  let imported = 0;
  let skipped = 0;
  const insert = db.prepare(
    `INSERT INTO token_usage
     (chat_profile_id, owner_user_id, category, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const { flushSyncToBigQuery } = require('../database/bqSync');
  const { isBigQueryPrimary } = require('../database/storageMode');

  for (const record of records) {
    if (!record?.category || !record.createdAt) continue;
    if (rowExists(db, record)) continue;

    const chatProfileId =
      record.chatProfileId != null && validChatProfileIds.has(record.chatProfileId)
        ? record.chatProfileId
        : null;
    const ownerUserId =
      record.ownerUserId != null && validUserIds.has(record.ownerUserId)
        ? record.ownerUserId
        : null;

    let result;
    try {
      result = insert.run(
        chatProfileId,
        ownerUserId,
        record.category,
        record.model || '',
        record.promptTokens || 0,
        record.completionTokens || 0,
        record.totalTokens || 0,
        record.estimatedCostUsd || 0,
        record.createdAt
      );
    } catch (error) {
      skipped += 1;
      continue;
    }

    if (isBigQueryPrimary() && result.lastInsertRowid) {
      flushSyncToBigQuery(db, 'token_usage', 'id', result.lastInsertRowid);
    }
    imported += 1;
  }

  if (imported > 0) {
    logger.info(`Recovered ${imported} token usage row(s) from disk log`);
  }
  if (skipped > 0) {
    logger.warn(`Skipped ${skipped} unrecoverable token usage disk row(s)`);
  }
  return imported;
}

function repairOwnerUserIds(db) {
  const rows = db
    .prepare(
      `SELECT tu.id, cp.owner_phone
       FROM token_usage tu
       JOIN chat_profiles cp ON cp.id = tu.chat_profile_id
       WHERE tu.owner_user_id IS NULL`
    )
    .all();

  if (!rows.length) return 0;

  const users = db.prepare('SELECT id, phone FROM users').all();
  const update = db.prepare('UPDATE token_usage SET owner_user_id = ? WHERE id = ?');
  let updated = 0;
  const tx = db.transaction((items) => {
    for (const row of items) {
      const owner = users.find((user) => isSameOwnerPhone(user.phone, row.owner_phone));
      if (owner) {
        update.run(owner.id, row.id);
        updated += 1;
      }
    }
  });
  tx(rows);

  if (updated > 0) {
    logger.info(`Backfilled owner_user_id on ${updated} token usage row(s)`);
  }
  return updated;
}

function backfillEstimatedCostUsd(db) {
  const { estimateCostUsd } = require('../config/modelPricing');
  const pending = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM token_usage
         WHERE (estimated_cost_usd IS NULL OR estimated_cost_usd = 0)
           AND (prompt_tokens > 0 OR completion_tokens > 0)`
      )
      .get()?.c || 0
  );
  if (pending === 0) return 0;

  // Cap per boot so startup stays fast; remaining rows backfill on later restarts.
  const BATCH_LIMIT = Math.max(100, Number(process.env.TOKEN_COST_BACKFILL_LIMIT) || 500);
  const rows = db
    .prepare(
      `SELECT id, model, prompt_tokens, completion_tokens
       FROM token_usage
       WHERE (estimated_cost_usd IS NULL OR estimated_cost_usd = 0)
         AND (prompt_tokens > 0 OR completion_tokens > 0)
       LIMIT ?`
    )
    .all(BATCH_LIMIT);

  if (!rows.length) return 0;

  const update = db.prepare('UPDATE token_usage SET estimated_cost_usd = ? WHERE id = ?');
  let updated = 0;
  const tx = db.transaction((items) => {
    for (const row of items) {
      const cost = estimateCostUsd(row.model, row.prompt_tokens, row.completion_tokens);
      if (cost > 0) {
        update.run(cost, row.id);
        updated += 1;
      }
    }
  });
  tx(rows);

  if (updated > 0) {
    logger.info(`Backfilled estimated_cost_usd on ${updated} token usage row(s)`);
  }
  return updated;
}

module.exports = {
  appendTokenUsageLog,
  recoverTokenUsageFromDisk,
  repairOwnerUserIds,
  backfillEstimatedCostUsd,
};
