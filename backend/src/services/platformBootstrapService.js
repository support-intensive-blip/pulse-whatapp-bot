const fs = require('fs');
const path = require('path');
const { getDatabase } = require('../database/db');
const { botAccountService } = require('./botAccountService');
const { teamService } = require('./teamService');
const { promptVersionService } = require('./promptVersionService');
const { knowledgeResourceService } = require('./knowledgeResourceService');
const gallaboxApi = require('../bot/gallabox/gallaboxApi');
const intensiveConfig = require('../config/intensiveConfig');
const logger = require('../utils/logger');

const ROLES = ['owner', 'team_admin', 'team_user'];

/**
 * Carries the single-tenant setup into the multi-team model. Safe to run on every
 * boot: each step only fills in what is missing.
 *   - one owner login, a default team, every orphan bot/user placed in it
 *   - GALLABOX_* env → that number's bot (seed only; afterwards the dashboard owns them)
 *   - the hardcoded Intensive prompt → prompt v1 of the legacy bot
 *   - the repo KB file → knowledge resource linked to the legacy bot
 */
class PlatformBootstrapService {
  ensureOwner(db) {
    let owner = db.prepare("SELECT * FROM dashboard_users WHERE role = 'owner' ORDER BY id LIMIT 1").get();
    if (!owner) {
      owner = db.prepare('SELECT * FROM dashboard_users ORDER BY id LIMIT 1').get();
      if (!owner) return null;
      db.prepare("UPDATE dashboard_users SET role = 'owner', team_id = NULL WHERE id = ?").run(owner.id);
      logger.info(`Bootstrap: dashboard user ${owner.id} is now the owner`);
    }
    return owner;
  }

  ensureDefaultTeam(owner) {
    const existing = teamService.list()[0];
    if (existing) return existing;
    const team = teamService.create({
      name: 'Default team',
      description: 'Created automatically from the single-number setup',
      ownerUserId: owner.id,
    });
    logger.info(`Bootstrap: created default team ${team.id}`);
    return team;
  }

  assignOrphans(db, owner, team) {
    const bots = db.prepare('UPDATE bot_accounts SET team_id = ? WHERE team_id IS NULL').run(team.id);
    if (bots.changes) logger.info(`Bootstrap: ${bots.changes} bot(s) moved into team ${team.id}`);

    const placeholders = ROLES.map(() => '?').join(',');
    const users = db
      .prepare(
        `UPDATE dashboard_users SET role = 'team_user', team_id = COALESCE(team_id, ?)
         WHERE id != ? AND role NOT IN (${placeholders})`
      )
      .run(team.id, owner.id, ...ROLES);
    if (users.changes) logger.info(`Bootstrap: ${users.changes} legacy login(s) became team users`);
  }

  /** The bot the env-configured Gallabox number belongs to (created if none fits). */
  resolveEnvBot(owner, team, env) {
    const byChannel = botAccountService.findByChannelId(env.channelId);
    if (byChannel) return byChannel;

    const explicit = botAccountService.findById(parseInt(process.env.GALLABOX_BOT_ACCOUNT_ID, 10));
    if (explicit) return explicit;

    const byPhone = getDatabase()
      .prepare(
        `SELECT * FROM bot_accounts WHERE whatsapp_phone = ? OR last_whatsapp_phone = ?
         ORDER BY CASE WHEN whatsapp_phone = ? THEN 0 ELSE 1 END, id DESC LIMIT 1`
      )
      .get(env.phone, env.phone, env.phone);
    if (byPhone) return byPhone;

    const legacy = botAccountService.findByDashboardUserId(owner.id);
    if (legacy && !legacy.gallabox_channel_id) return legacy;

    return botAccountService.createBot({
      teamId: team.id,
      name: 'WhatsApp Bot',
      phone: env.phone,
      createdBy: owner.id,
    });
  }

  importEnvCredentials(owner, team) {
    if (!gallaboxApi.isConfigured()) return null;
    const env = gallaboxApi.getConfig();
    const bot = this.resolveEnvBot(owner, team, env);

    const creds = botAccountService.getCredentials(bot);
    const needsSeed = !botAccountService.hasCredentials(bot) || !creds.readable;
    if (needsSeed) {
      botAccountService.setCredentials(bot.id, {
        apiKey: env.apiKey,
        apiSecret: env.apiSecret,
        webhookSecret: env.webhookSecret,
        channelId: env.channelId,
        accountId: env.accountId,
      });
      botAccountService.updateStatus(bot.id, bot.status, { whatsappPhone: env.phone });
      logger.info(`Bootstrap: GALLABOX_* env credentials stored on bot ${bot.id}`);
    }
    return botAccountService.findById(bot.id);
  }

  /**
   * Bots from before per-bot prompts have system_prompt NULL (dashboard-created bots
   * get ''); the env number's bot also keeps answering as the Intensive assistant.
   */
  importLegacyPrompts(owner, envBot) {
    const ids = getDatabase()
      .prepare('SELECT id FROM bot_accounts WHERE system_prompt IS NULL')
      .all()
      .map((row) => row.id);
    if (envBot && !String(envBot.system_prompt || '').trim() && !promptVersionService.latest(envBot.id)) {
      ids.push(envBot.id);
    }
    const legacyIds = [...new Set(ids)];
    for (const id of legacyIds) {
      promptVersionService.publish(id, intensiveConfig.SYSTEM_PROMPT, {
        note: 'Imported from intensive-system-prompt.txt',
        userId: owner.id,
      });
      logger.info(`Bootstrap: prompt v1 created for bot ${id}`);
    }
    return legacyIds;
  }

  async importLegacyKnowledgeBase(owner, team, botIds) {
    const sourcePath = intensiveConfig.KNOWLEDGE_BASE_PATH;
    const already = getDatabase()
      .prepare('SELECT id FROM knowledge_resources WHERE source_path = ? LIMIT 1')
      .get(sourcePath);
    if (already) return;

    const filePath = path.resolve(sourcePath);
    if (!fs.existsSync(filePath)) {
      logger.warn(`Bootstrap: KB file ${sourcePath} not found — no knowledge resource imported`);
      return;
    }

    const { kind, text } = await knowledgeResourceService.extractText({
      buffer: fs.readFileSync(filePath),
      filename: filePath,
    });
    const resource = knowledgeResourceService.create({
      teamId: team.id,
      title: 'NxtWave Intensive knowledge base',
      kind,
      content: text,
      filename: path.basename(filePath),
      sourcePath,
      createdBy: owner.id,
    });
    for (const botId of botIds) {
      const bot = botAccountService.findById(botId);
      const ids = botAccountService.parseKnowledgeResourceIds(bot);
      botAccountService.setKnowledgeResourceIds(botId, [...ids, resource.id]);
    }
    logger.info(`Bootstrap: KB file imported as resource ${resource.id} (linked to bots ${botIds.join(',') || 'none'})`);
  }

  claimUnscopedMemory(db, bot) {
    const phone = botAccountService.getPhone(bot);
    if (!phone) return;
    // OR IGNORE: a row for (phone, student) may already exist — keep that one.
    const result = db
      .prepare("UPDATE OR IGNORE student_user_memory SET owner_phone = ? WHERE owner_phone = ''")
      .run(phone);
    if (result.changes) logger.info(`Bootstrap: ${result.changes} student memory row(s) scoped to ${phone}`);
  }

  async ensureDefaults() {
    const db = getDatabase();
    const owner = this.ensureOwner(db);
    if (!owner) return;

    const team = this.ensureDefaultTeam(owner);
    this.assignOrphans(db, owner, team);

    const envBot = this.importEnvCredentials(owner, team);
    const legacyBotIds = this.importLegacyPrompts(owner, envBot);
    await this.importLegacyKnowledgeBase(owner, team, legacyBotIds);

    const memoryBot =
      envBot || botAccountService.listByTeam(team.id).find((bot) => botAccountService.getPhone(bot));
    if (memoryBot) this.claimUnscopedMemory(db, memoryBot);
  }
}

module.exports = { platformBootstrapService: new PlatformBootstrapService(), ROLES };
