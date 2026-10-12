const express = require('express');
const { getDatabase } = require('../database/db');
const { botAccountService, AI_STATUS } = require('../services/botAccountService');
const { promptVersionService } = require('../services/promptVersionService');
const { knowledgeResourceService } = require('../services/knowledgeResourceService');
const knowledgeBaseService = require('../services/knowledgeBaseService');
const { playgroundService } = require('../services/playgroundService');
const { auditLogService } = require('../services/auditLogService');
const conversationService = require('../services/conversationService');
const gallaboxApi = require('../bot/gallabox/gallaboxApi');
const botManager = require('../bot/botManager');
const { requireAuth, requireRole, requireTeam, findScopedBot } = require('./middleware/auth');
const logger = require('../utils/logger');

const SETTINGS_FIELDS = [
  'name',
  'description',
  'aiStatus',
  'defaultAiOn',
  'assistantName',
  'replyDelaySeconds',
  'batchDelaySeconds',
  'contextWindowMinutes',
  'testNumbers',
];

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function credentialInput(body) {
  const g = body?.gallabox || body || {};
  return {
    apiKey: g.apiKey,
    apiSecret: g.apiSecret,
    webhookSecret: g.webhookSecret,
    channelId: g.channelId,
    accountId: g.accountId,
  };
}

function botDetail(bot) {
  const phone = botAccountService.getPhone(bot);
  const stats = conversationService.getStatsForOwnerPhones(phone ? [phone] : []);
  return {
    ...botAccountService.toPublic(bot),
    connection: botManager.getConnection(bot.id),
    conversationCount: stats.totalChats,
    aiActiveChats: stats.activeChats,
  };
}

/** Starts the bot after a change, unless it is deactivated; never throws. */
async function restartQuietly(botId) {
  try {
    await botManager.restartBot(botId);
  } catch (error) {
    logger.error(`Bot ${botId} restart failed: ${error.message}`);
  }
}

function reindexInBackground(botId) {
  const bot = botAccountService.findById(botId);
  if (!bot) return;
  knowledgeBaseService.initializeBot(bot).catch((error) => {
    logger.warn(`KB reindex for bot ${botId} failed: ${error.message}`);
  });
}

/** Resource ids must belong to the bot's team. */
function validResourceIds(teamId, ids) {
  if (!Array.isArray(ids)) throw new Error('resourceIds must be a list');
  const allowed = new Set(knowledgeResourceService.list(teamId).map((resource) => resource.id));
  const invalid = ids.map(Number).filter((id) => !allowed.has(id));
  if (invalid.length) throw new Error(`Unknown knowledge resource(s): ${invalid.join(', ')}`);
  return ids.map(Number);
}

/** AI bot (Gallabox number) management — team admins and the owner. */
function createBotRouter() {
  const router = express.Router();
  const adminOnly = [requireAuth, requireRole('admin'), requireTeam];

  function loadBot(req, res) {
    const bot = findScopedBot(req.scope, req.params.botId);
    if (!bot) {
      res.status(404).json({ error: 'Bot not found in this team' });
      return null;
    }
    return bot;
  }

  function audit(req, bot, action, meta = null) {
    auditLogService.record({
      actorUserId: req.dashboardUser.id,
      teamId: bot.team_id,
      action,
      targetType: 'bot',
      targetId: bot.id,
      meta,
    });
  }

  router.get('/bots', ...adminOnly, (req, res) => {
    res.json({ bots: req.scope.bots.map(botDetail) });
  });

  // Wizard step 2 "Test connection", before or after the bot exists.
  router.post('/bots/test-connection', ...adminOnly, async (req, res) => {
    const input = credentialInput(req.body);
    const existing = req.body?.botId ? findScopedBot(req.scope, req.body.botId) : null;
    const stored = existing ? botAccountService.getCredentials(existing) : {};
    const config = {
      apiKey: input.apiKey || stored.apiKey || '',
      apiSecret: input.apiSecret || stored.apiSecret || '',
      channelId: input.channelId || stored.channelId || '',
      accountId: input.accountId ?? stored.accountId ?? '',
      phone: String(req.body?.phone || stored.phone || '').replace(/\D/g, ''),
    };
    res.json(await gallaboxApi.testConnection(config));
  });

  /**
   * Connect-number wizard in one call:
   * { name, description, phone, gallabox: {...}, systemPrompt, aiStatus, defaultAiOn,
   *   assistantName, testNumbers, knowledgeResourceIds, activate }
   */
  router.post('/bots', ...adminOnly, async (req, res) => {
    const body = req.body || {};
    let bot;
    try {
      const resourceIds = body.knowledgeResourceIds ? validResourceIds(req.scope.teamId, body.knowledgeResourceIds) : [];
      bot = botAccountService.createBot({
        teamId: req.scope.teamId,
        name: body.name,
        description: body.description,
        phone: body.phone,
        createdBy: req.dashboardUser.id,
      });
      botAccountService.setCredentials(bot.id, credentialInput(body));
      if (String(body.systemPrompt || '').trim()) {
        promptVersionService.publish(bot.id, body.systemPrompt, { note: 'Initial prompt', userId: req.dashboardUser.id });
      }
      botAccountService.updateSettings(bot.id, {
        ...pick(body, SETTINGS_FIELDS.filter((key) => key !== 'name' && key !== 'description')),
        assistantName: body.assistantName || body.name,
        // A bot is created paused unless the wizard explicitly activates it.
        aiStatus: body.activate ? body.aiStatus || AI_STATUS.ACTIVE : AI_STATUS.PAUSED,
      });
      if (resourceIds.length) botAccountService.setKnowledgeResourceIds(bot.id, resourceIds);
    } catch (error) {
      // Undo a half-created bot so the wizard can simply be retried.
      if (bot) getDatabase().prepare('DELETE FROM bot_accounts WHERE id = ?').run(bot.id);
      return res.status(400).json({ error: error.message });
    }

    audit(req, bot, 'bot.create', { name: bot.name, phone: botAccountService.getPhone(bot) });
    await restartQuietly(bot.id);
    reindexInBackground(bot.id);
    return res.status(201).json({ bot: botDetail(botAccountService.findById(bot.id)) });
  });

  router.get('/bots/:botId', ...adminOnly, async (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    return res.json({
      bot: botDetail(bot),
      knowledge: await knowledgeBaseService.getBotStatus(bot),
    });
  });

  router.patch('/bots/:botId', ...adminOnly, async (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    const body = req.body || {};
    try {
      const settings = pick(body, SETTINGS_FIELDS);
      if (body.isActive !== undefined) settings.isActive = Boolean(body.isActive);
      botAccountService.updateSettings(bot.id, settings);

      let phoneChanged = false;
      if (body.phone !== undefined) {
        const phone = botAccountService.normalizeBotPhone(body.phone);
        if (phone !== botAccountService.getPhone(bot)) {
          botAccountService.assertPhoneAvailable(phone, bot.id);
          botAccountService.updateStatus(bot.id, bot.status, { whatsappPhone: phone });
          phoneChanged = true;
        }
      }

      audit(req, bot, 'bot.update', { ...settings, phoneChanged });
      // A deactivated bot is stopped by the restart (canRun is false).
      if (phoneChanged || body.isActive !== undefined) await restartQuietly(bot.id);
      return res.json({ bot: botDetail(botAccountService.findById(bot.id)) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // Secrets are write-only: send only the fields being replaced.
  router.put('/bots/:botId/credentials', ...adminOnly, async (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    try {
      botAccountService.setCredentials(bot.id, credentialInput(req.body));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    audit(req, bot, 'bot.credentials_update', {
      fields: Object.entries(credentialInput(req.body))
        .filter(([, value]) => value !== undefined && String(value).trim())
        .map(([key]) => key),
    });
    await restartQuietly(bot.id);
    return res.json({ bot: botDetail(botAccountService.findById(bot.id)) });
  });

  router.post('/bots/:botId/test-connection', ...adminOnly, async (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    res.json(await gallaboxApi.testConnection(botAccountService.getCredentials(bot)));
    return undefined;
  });

  router.post('/bots/:botId/restart', ...adminOnly, async (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    await restartQuietly(bot.id);
    audit(req, bot, 'bot.restart');
    return res.json({ bot: botDetail(botAccountService.findById(bot.id)) });
  });

  // ---- Prompt (live + version history) ----

  router.get('/bots/:botId/prompt', ...adminOnly, (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    return res.json({
      content: bot.system_prompt || '',
      versions: promptVersionService.list(bot.id),
    });
  });

  router.put('/bots/:botId/prompt', ...adminOnly, (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    try {
      const { version, changed } = promptVersionService.publish(bot.id, req.body?.content, {
        note: req.body?.note,
        userId: req.dashboardUser.id,
      });
      if (changed) audit(req, bot, 'bot.prompt_publish', { versionId: version.id });
      return res.json({ content: version.content, versionId: version.id, changed, versions: promptVersionService.list(bot.id) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.get('/bots/:botId/prompt/versions/:versionId', ...adminOnly, (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    const version = promptVersionService.findById(bot.id, parseInt(req.params.versionId, 10));
    if (!version) return res.status(404).json({ error: 'Version not found' });
    return res.json({ version });
  });

  router.post('/bots/:botId/prompt/versions/:versionId/restore', ...adminOnly, (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    const version = promptVersionService.findById(bot.id, parseInt(req.params.versionId, 10));
    if (!version) return res.status(404).json({ error: 'Version not found' });
    const result = promptVersionService.publish(bot.id, version.content, {
      note: `Restored version #${version.id}`,
      userId: req.dashboardUser.id,
    });
    audit(req, bot, 'bot.prompt_restore', { fromVersionId: version.id });
    return res.json({ content: result.version.content, versions: promptVersionService.list(bot.id) });
  });

  // ---- Knowledge links ----

  router.put('/bots/:botId/knowledge', ...adminOnly, (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    try {
      const ids = validResourceIds(bot.team_id, req.body?.resourceIds);
      botAccountService.setKnowledgeResourceIds(bot.id, ids);
      audit(req, bot, 'bot.knowledge_update', { resourceIds: ids });
      reindexInBackground(bot.id);
      return res.json({ bot: botDetail(botAccountService.findById(bot.id)) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.get('/bots/:botId/knowledge/status', ...adminOnly, async (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    return res.json(await knowledgeBaseService.getBotStatus(bot));
  });

  router.post('/bots/:botId/knowledge/reindex', ...adminOnly, (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    knowledgeBaseService.initializeBot(bot, { force: true }).catch((error) => {
      logger.warn(`Forced KB reindex for bot ${bot.id} failed: ${error.message}`);
    });
    return res.status(202).json({ started: true });
  });

  // ---- Testing playground (never sends to WhatsApp) ----

  router.get('/bots/:botId/playground', ...adminOnly, (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    return res.json({ messages: playgroundService.history(bot, req.dashboardUser.id, req.query.sessionId) });
  });

  router.post('/bots/:botId/playground', ...adminOnly, async (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    try {
      const result = await playgroundService.send(bot, req.dashboardUser.id, {
        sessionId: req.body?.sessionId,
        message: req.body?.message,
        draftPrompt: req.body?.draftPrompt,
      });
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // ---- Diagnostics / activity ----

  router.get('/bots/:botId/activity', ...adminOnly, (req, res) => {
    const bot = loadBot(req, res);
    if (!bot) return undefined;
    return res.json({
      connection: botManager.getConnection(bot.id),
      lastInboundAt: bot.last_inbound_at,
      lastError: bot.last_error,
      entries: auditLogService.list({
        targetType: 'bot',
        targetId: bot.id,
        limit: 100,
      }),
    });
  });

  return router;
}

module.exports = { createBotRouter };
