const { getDatabase } = require('../database/db');
const logger = require('../utils/logger');
const { estimateCostUsd } = require('../config/modelPricing');
const { TOKEN_CATEGORIES, CATEGORY_LABELS } = require('../config/tokenCategories');
const { resolveOwnerScopeIds, normalizePhoneDigits } = require('../utils/helpers');
const { environmentForProfile } = require('./trafficEnvironment');

function emptyStats() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0,
    request_count: 0,
    byCategory: [],
    efficiency: {
      blockedCount: 0,
      firewallCount: 0,
      chatCount: 0,
      estimatedSavingsUsd: 0,
      avgChatCostUsd: 0,
    },
  };
}

class TokenUsageService {
  rowExistsById(db, table, id) {
    try {
      return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));
    } catch {
      return true;
    }
  }

  /**
   * The bot (and its current team) a usage row belongs to: explicit botAccountId,
   * else the bot whose number owns the chat profile.
   */
  resolveBot(db, { botAccountId = null, chatProfileId = null } = {}) {
    try {
      if (botAccountId) {
        const bot = db.prepare('SELECT id, team_id FROM bot_accounts WHERE id = ?').get(botAccountId);
        if (bot) return bot;
      }
      if (chatProfileId == null) return null;
      const profile = db.prepare('SELECT owner_phone FROM chat_profiles WHERE id = ?').get(chatProfileId);
      const phone = normalizePhoneDigits(profile?.owner_phone);
      if (!phone) return null;
      const bots = db
        .prepare('SELECT id, team_id, whatsapp_phone, last_whatsapp_phone FROM bot_accounts ORDER BY id')
        .all();
      return (
        bots.find((bot) => normalizePhoneDigits(bot.whatsapp_phone) === phone) ||
        bots.find((bot) => normalizePhoneDigits(bot.last_whatsapp_phone) === phone) ||
        null
      );
    } catch {
      return null;
    }
  }

  record({
    chatProfileId = null,
    ownerUserId = null,
    botAccountId = null,
    category,
    model = null,
    promptTokens = 0,
    completionTokens = 0,
    totalTokens = 0,
  } = {}) {
    if (!category) return null;

    const db = getDatabase();
    const prompt = Number(promptTokens) || 0;
    const completion = Number(completionTokens) || 0;
    const total = Number(totalTokens) || prompt + completion;
    const cost = estimateCostUsd(model, prompt, completion);
    const createdAt = new Date().toISOString();
    const resolvedOwnerUserId = ownerUserId ?? null;

    // Telemetry must never break a chat. Drop FK references whose parent row is
    // missing (profiles get merged/rebuilt) to mirror the table's ON DELETE SET NULL,
    // and never let a DB error propagate out of record().
    let safeChatProfileId = chatProfileId ?? null;
    if (safeChatProfileId != null && !this.rowExistsById(db, 'chat_profiles', safeChatProfileId)) {
      safeChatProfileId = null;
    }
    let safeOwnerUserId = resolvedOwnerUserId ?? null;
    if (safeOwnerUserId != null && !this.rowExistsById(db, 'users', safeOwnerUserId)) {
      safeOwnerUserId = null;
    }

    const bot = this.resolveBot(db, { botAccountId, chatProfileId: safeChatProfileId });
    const resolvedBotId = bot?.id ?? null;
    const resolvedTeamId = bot?.team_id ?? null;
    const environment = environmentForProfile(db, safeChatProfileId);

    let insertId = null;
    try {
      const result = db
        .prepare(
          `INSERT INTO token_usage
           (chat_profile_id, owner_user_id, bot_account_id, team_id, environment, category, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          safeChatProfileId,
          safeOwnerUserId,
          resolvedBotId,
          resolvedTeamId,
          environment,
          category,
          model,
          prompt,
          completion,
          total,
          cost,
          createdAt
        );
      insertId = result.lastInsertRowid;
    } catch (error) {
      logger.warn(`Token usage insert skipped (non-fatal): ${error.message}`);
    }

    const record = {
      id: insertId,
      chatProfileId: safeChatProfileId,
      ownerUserId: safeOwnerUserId,
      botAccountId: resolvedBotId,
      teamId: resolvedTeamId,
      environment,
      category,
      model,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total,
      estimatedCostUsd: cost,
      createdAt,
    };

    try {
      const { appendTokenUsageLog } = require('./tokenUsagePersistence');
      appendTokenUsageLog(record);
    } catch (error) {
      logger.warn(`Token usage disk log skipped (non-fatal): ${error.message}`);
    }

    return record;
  }

  recordBlocked({ chatProfileId = null, ownerUserId = null, tier = null, reason = null } = {}) {
    logger.info(
      `Firewall blocked message (chatProfile=${chatProfileId ?? 'n/a'} tier=${tier || 'n/a'} reason=${reason || 'n/a'})`
    );
    return this.record({
      chatProfileId,
      ownerUserId,
      category: TOKEN_CATEGORIES.BLOCKED,
    });
  }

  getBotStats({ ownerPhones = [] } = {}) {
    const db = getDatabase();
    const { ownerUserIds, profileIds } = resolveOwnerScopeIds(db, ownerPhones);

    if (!ownerUserIds.length && !profileIds.length) {
      return emptyStats();
    }

    const conditions = [];
    const params = [];
    if (ownerUserIds.length) {
      conditions.push(`owner_user_id IN (${ownerUserIds.map(() => '?').join(',')})`);
      params.push(...ownerUserIds);
    }
    if (profileIds.length) {
      conditions.push(`chat_profile_id IN (${profileIds.map(() => '?').join(',')})`);
      params.push(...profileIds);
    }
    const where = `WHERE ${conditions.join(' OR ')}`;

    const totals = db
      .prepare(
        `SELECT
           COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd,
           COUNT(*) AS request_count
         FROM token_usage ${where}`
      )
      .get(...params);

    const byCategory = db
      .prepare(
        `SELECT
           category,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd,
           COUNT(*) AS request_count
         FROM token_usage ${where}
         GROUP BY category`
      )
      .all(...params);

    const findCategory = (cat) => byCategory.find((row) => row.category === cat) || null;
    const blockedCount = findCategory(TOKEN_CATEGORIES.BLOCKED)?.request_count || 0;
    const firewallCount = findCategory(TOKEN_CATEGORIES.FIREWALL)?.request_count || 0;
    const chatRow = findCategory(TOKEN_CATEGORIES.CHAT);
    const chatCount = chatRow?.request_count || 0;
    const avgChatCostUsd = chatCount > 0 ? Number(chatRow.estimated_cost_usd) / chatCount : 0;
    const estimatedSavingsUsd = blockedCount * avgChatCostUsd;

    return {
      prompt_tokens: totals.prompt_tokens,
      completion_tokens: totals.completion_tokens,
      total_tokens: totals.total_tokens,
      estimated_cost_usd: totals.estimated_cost_usd,
      request_count: totals.request_count,
      byCategory,
      efficiency: {
        blockedCount,
        firewallCount,
        chatCount,
        estimatedSavingsUsd,
        avgChatCostUsd,
      },
    };
  }

  /**
   * Input/output token usage report.
   *   teamIds: null = every team (owner), else only rows recorded for those teams
   *   botId:   narrow to one bot; days: rolling window (null = all time)
   *   environment: 'live' | 'test' | null (both); byEnvironment always splits the two
   * Dates are grouped in IST, the timezone the dashboard shows.
   */
  getUsageReport({ teamIds = null, botId = null, days = null, environment = null } = {}) {
    const db = getDatabase();
    const conditions = [];
    const params = [];
    if (Array.isArray(teamIds)) {
      if (!teamIds.length) conditions.push('0');
      else {
        conditions.push(`tu.team_id IN (${teamIds.map(() => '?').join(',')})`);
        params.push(...teamIds);
      }
    }
    if (botId) {
      conditions.push('tu.bot_account_id = ?');
      params.push(botId);
    }
    if (days) {
      conditions.push("datetime(tu.created_at) >= datetime('now', ?)");
      params.push(`-${Number(days)} days`);
    }
    const scopeConditions = [...conditions];
    const scopeParams = [...params];
    if (environment) {
      conditions.push("COALESCE(tu.environment, 'live') = ?");
      params.push(environment);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sums = `
      COALESCE(SUM(tu.prompt_tokens), 0) AS input_tokens,
      COALESCE(SUM(tu.completion_tokens), 0) AS output_tokens,
      COALESCE(SUM(tu.total_tokens), 0) AS total_tokens,
      COALESCE(SUM(tu.estimated_cost_usd), 0) AS estimated_cost_usd,
      COUNT(*) AS request_count`;
    const from = `FROM token_usage tu
      LEFT JOIN bot_accounts b ON b.id = tu.bot_account_id
      LEFT JOIN teams t ON t.id = tu.team_id`;
    const run = (select, groupBy, orderBy = 'total_tokens DESC') =>
      db.prepare(`SELECT ${select}${sums} ${from} ${where} ${groupBy ? `GROUP BY ${groupBy}` : ''} ORDER BY ${orderBy}`).all(...params);

    const totals = db.prepare(`SELECT${sums} ${from} ${where}`).get(...params);
    // Live vs test for the same scope, regardless of the environment filter.
    const scopeWhere = scopeConditions.length ? `WHERE ${scopeConditions.join(' AND ')}` : '';
    const split = db
      .prepare(
        `SELECT COALESCE(tu.environment, 'live') AS environment,${sums} ${from} ${scopeWhere}
         GROUP BY COALESCE(tu.environment, 'live')`
      )
      .all(...scopeParams);
    const emptyTotals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost_usd: 0, request_count: 0 };
    const byEnvironment = {
      live: split.find((row) => row.environment === 'live') || { environment: 'live', ...emptyTotals },
      test: split.find((row) => row.environment === 'test') || { environment: 'test', ...emptyTotals },
    };
    return {
      days: days ? Number(days) : null,
      environment: environment || 'all',
      totals,
      byEnvironment,
      byTeam: run('tu.team_id AS team_id, t.name AS team_name,', 'tu.team_id'),
      byBot: run(
        `tu.bot_account_id AS bot_id, b.name AS bot_name,
         COALESCE(b.whatsapp_phone, b.last_whatsapp_phone) AS bot_phone,
         tu.team_id AS team_id, t.name AS team_name,`,
        'tu.bot_account_id, tu.team_id'
      ),
      byModel: run("COALESCE(NULLIF(tu.model, ''), 'none') AS model,", "COALESCE(NULLIF(tu.model, ''), 'none')"),
      byCategory: run('tu.category AS category,', 'tu.category').map((row) => ({
        ...row,
        label: CATEGORY_LABELS[row.category] || row.category,
      })),
      daily: run(
        "date(datetime(tu.created_at), '+5 hours', '+30 minutes') AS day,",
        'day',
        'day ASC'
      ),
    };
  }

  formatCategoryLines(rows) {
    return rows.map((row) => {
      const label = CATEGORY_LABELS[row.category] || row.category;
      const cost = Number(row.estimated_cost_usd) || 0;
      const costText = cost > 0 ? ` (~$${cost.toFixed(4)})` : '';
      return `• ${label}: ${row.total_tokens} tokens${costText} — ${row.request_count} calls`;
    });
  }

  formatChatReport(chatProfileId, ownerUserId) {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT category,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd,
           COUNT(*) AS request_count
         FROM token_usage
         WHERE chat_profile_id = ?
         GROUP BY category`
      )
      .all(chatProfileId);

    if (!rows.length) {
      return '*Token Usage — This Chat*\n\nNo AI usage recorded yet.';
    }

    const totalTokens = rows.reduce((sum, r) => sum + (Number(r.total_tokens) || 0), 0);
    const totalCost = rows.reduce((sum, r) => sum + (Number(r.estimated_cost_usd) || 0), 0);

    return [
      '*Token Usage — This Chat*',
      '',
      ...this.formatCategoryLines(rows),
      '',
      `Total: ${totalTokens} tokens, ~$${totalCost.toFixed(4)}`,
    ].join('\n');
  }

  formatBotReport(ownerUserId, ownerPhone) {
    const stats = this.getBotStats({ ownerPhones: ownerPhone ? [ownerPhone] : [] });

    if (!stats.request_count) {
      return '*Token Usage — All Chats*\n\nNo AI usage recorded yet.';
    }

    return [
      '*Token Usage — All Chats*',
      '',
      ...this.formatCategoryLines(stats.byCategory),
      '',
      `Total: ${stats.total_tokens} tokens, ~$${Number(stats.estimated_cost_usd).toFixed(4)}`,
      `Blocked at firewall: ${stats.efficiency.blockedCount} (~$${stats.efficiency.estimatedSavingsUsd.toFixed(4)} saved)`,
    ].join('\n');
  }
}

module.exports = { tokenUsageService: new TokenUsageService() };
