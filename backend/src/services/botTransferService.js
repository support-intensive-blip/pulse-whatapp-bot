const { getDatabase } = require('../database/db');
const { botAccountService } = require('./botAccountService');
const { teamService } = require('./teamService');
const { knowledgeResourceService } = require('./knowledgeResourceService');
const { normalizePhoneDigits } = require('../utils/helpers');

/**
 * Moves a bot (WhatsApp number) to another team — e.g. out of the default team.
 * Chats, messages and CTAs follow automatically (keyed by the bot's number / id).
 * What is team-scoped gets carried over:
 *   - linked knowledge resources: reused if the target team has the same content,
 *     otherwise copied into the target team (the source team keeps its originals)
 *   - chat / CTA assignments to users outside the target team are cleared
 */
class BotTransferService {
  /** Target-team resource ids standing in for the bot's current ones. */
  remapKnowledge(db, bot, targetTeamId, userId) {
    const targetByHash = new Map(
      knowledgeResourceService
        .list(targetTeamId)
        .filter((r) => r.content_hash)
        .map((r) => [r.content_hash, r.id])
    );
    const ids = [];
    let copied = 0;
    for (const id of botAccountService.parseKnowledgeResourceIds(bot)) {
      const resource = knowledgeResourceService.findById(id);
      if (!resource) continue;
      if (resource.team_id === targetTeamId) {
        ids.push(resource.id);
        continue;
      }
      let targetId = resource.content_hash ? targetByHash.get(resource.content_hash) : null;
      if (!targetId) {
        const result = db
          .prepare(
            `INSERT INTO knowledge_resources
               (team_id, title, kind, content, filename, source_path, content_hash, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            targetTeamId,
            resource.title,
            resource.kind,
            resource.content,
            resource.filename,
            resource.source_path,
            resource.content_hash,
            userId || resource.created_by
          );
        targetId = Number(result.lastInsertRowid);
        if (resource.content_hash) targetByHash.set(resource.content_hash, targetId);
        copied += 1;
      }
      if (!ids.includes(targetId)) ids.push(targetId);
    }
    return { ids, copied };
  }

  clearForeignAssignments(db, bot, targetTeamId) {
    const memberIds = new Set(
      db.prepare('SELECT id FROM dashboard_users WHERE team_id = ?').all(targetTeamId).map((u) => u.id)
    );
    const phone = normalizePhoneDigits(botAccountService.getPhone(bot));

    let chats = 0;
    if (phone) {
      const clearChat = db.prepare(
        "UPDATE chat_profiles SET assigned_user_id = NULL, updated_at = datetime('now') WHERE id = ?"
      );
      const assigned = db
        .prepare('SELECT id, owner_phone, assigned_user_id FROM chat_profiles WHERE assigned_user_id IS NOT NULL')
        .all();
      for (const row of assigned) {
        if (normalizePhoneDigits(row.owner_phone) === phone && !memberIds.has(row.assigned_user_id)) {
          chats += clearChat.run(row.id).changes;
        }
      }
    }

    let ctas = 0;
    const clearCta = db.prepare(
      "UPDATE action_items SET assigned_dashboard_user_id = NULL, updated_at = datetime('now') WHERE id = ?"
    );
    const assignedCtas = db
      .prepare(
        'SELECT id, assigned_dashboard_user_id FROM action_items WHERE bot_account_id = ? AND assigned_dashboard_user_id IS NOT NULL'
      )
      .all(bot.id);
    for (const row of assignedCtas) {
      if (!memberIds.has(row.assigned_dashboard_user_id)) ctas += clearCta.run(row.id).changes;
    }
    return { chats, ctas };
  }

  moveBot(botId, targetTeamId, { userId = null } = {}) {
    const bot = botAccountService.findById(botId);
    if (!bot) throw new Error('Bot not found');
    const target = teamService.findById(targetTeamId);
    if (!target) throw new Error('Target team not found');
    if (bot.team_id === target.id) throw new Error(`This number is already in ${target.name}`);

    const db = getDatabase();
    const fromTeam = teamService.findById(bot.team_id);
    const result = db.transaction(() => {
      const knowledge = this.remapKnowledge(db, bot, target.id, userId);
      db.prepare(
        `UPDATE bot_accounts
         SET team_id = ?, knowledge_resource_ids = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(target.id, JSON.stringify(knowledge.ids), bot.id);
      const cleared = this.clearForeignAssignments(db, bot, target.id);
      return { knowledge, cleared };
    })();

    return {
      bot: botAccountService.findById(bot.id),
      fromTeam,
      toTeam: target,
      copiedResources: result.knowledge.copied,
      clearedChatAssignments: result.cleared.chats,
      clearedCtaAssignments: result.cleared.ctas,
    };
  }
}

module.exports = { botTransferService: new BotTransferService() };
