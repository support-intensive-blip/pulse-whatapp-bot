const express = require('express');
const multer = require('multer');
const { knowledgeResourceService } = require('../services/knowledgeResourceService');
const knowledgeBaseService = require('../services/knowledgeBaseService');
const { botAccountService } = require('../services/botAccountService');
const { auditLogService } = require('../services/auditLogService');
const { requireAuth, requireRole, requireTeam } = require('./middleware/auth');
const logger = require('../utils/logger');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function reindexBots(botIds) {
  for (const botId of botIds) {
    const bot = botAccountService.findById(botId);
    if (!bot) continue;
    knowledgeBaseService.initializeBot(bot).catch((error) => {
      logger.warn(`KB reindex for bot ${botId} failed: ${error.message}`);
    });
  }
}

/** Team knowledge resources (documents shared by the team's bots). Team admins only. */
function createKnowledgeRouter() {
  const router = express.Router();
  const adminOnly = [requireAuth, requireRole('admin'), requireTeam];

  function loadResource(req, res) {
    const resource = knowledgeResourceService.findById(parseInt(req.params.resourceId, 10));
    if (!resource || resource.team_id !== req.scope.teamId) {
      res.status(404).json({ error: 'Knowledge resource not found' });
      return null;
    }
    return resource;
  }

  function usedBy(req, resourceId) {
    return knowledgeResourceService
      .botsUsing(resourceId, req.scope.teamId)
      .map((bot) => ({ id: bot.id, name: bot.name }));
  }

  function audit(req, action, resource, meta = null) {
    auditLogService.record({
      actorUserId: req.dashboardUser.id,
      teamId: req.scope.teamId,
      action,
      targetType: 'knowledge_resource',
      targetId: resource.id,
      meta: { title: resource.title, ...(meta || {}) },
    });
  }

  router.get('/knowledge', ...adminOnly, async (req, res) => {
    const resources = knowledgeResourceService
      .list(req.scope.teamId)
      .map((resource) => knowledgeResourceService.toPublic(resource, { usedBy: usedBy(req, resource.id) }));
    const bots = await Promise.all(
      req.scope.bots.map(async (bot) => ({
        id: bot.id,
        name: bot.name,
        resourceIds: botAccountService.parseKnowledgeResourceIds(bot),
        index: await knowledgeBaseService.getBotStatus(bot),
      }))
    );
    res.json({ resources, bots });
  });

  router.get('/knowledge/:resourceId', ...adminOnly, (req, res) => {
    const resource = loadResource(req, res);
    if (!resource) return undefined;
    return res.json({
      resource: {
        ...knowledgeResourceService.toPublic(resource, { usedBy: usedBy(req, resource.id) }),
        content: resource.content,
      },
    });
  });

  // JSON { title, content, botIds? } or multipart file upload (field "file", optional "title", "botIds").
  router.post('/knowledge', ...adminOnly, upload.single('file'), async (req, res) => {
    try {
      let { title, content } = req.body || {};
      let kind = 'text';
      let filename = null;
      if (req.file) {
        const extracted = await knowledgeResourceService.extractText({
          buffer: req.file.buffer,
          filename: req.file.originalname,
          mimetype: req.file.mimetype,
        });
        kind = extracted.kind;
        content = extracted.text;
        filename = req.file.originalname;
        title = title || req.file.originalname.replace(/\.[^.]+$/, '');
      }

      const resource = knowledgeResourceService.create({
        teamId: req.scope.teamId,
        title,
        kind,
        content,
        filename,
        createdBy: req.dashboardUser.id,
      });

      // Optionally link to bots right away (wizard step 4).
      const rawBotIds = typeof req.body?.botIds === 'string' ? req.body.botIds.split(',') : req.body?.botIds || [];
      const linkBots = rawBotIds.map(Number).filter((id) => req.scope.bots.some((bot) => bot.id === id));
      for (const botId of linkBots) {
        const bot = botAccountService.findById(botId);
        botAccountService.setKnowledgeResourceIds(botId, [...botAccountService.parseKnowledgeResourceIds(bot), resource.id]);
      }
      reindexBots(linkBots);

      audit(req, 'knowledge.create', resource, { linkedBots: linkBots });
      return res.status(201).json({
        resource: knowledgeResourceService.toPublic(resource, { usedBy: usedBy(req, resource.id) }),
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.patch('/knowledge/:resourceId', ...adminOnly, (req, res) => {
    const resource = loadResource(req, res);
    if (!resource) return undefined;
    try {
      const updated = knowledgeResourceService.update(resource.id, {
        title: req.body?.title,
        content: req.body?.content,
        detachFile: true,
      });
      const users = knowledgeResourceService.botsUsing(resource.id, req.scope.teamId);
      if (req.body?.content !== undefined) reindexBots(users.map((bot) => bot.id));
      audit(req, 'knowledge.update', updated, { contentChanged: req.body?.content !== undefined });
      return res.json({ resource: knowledgeResourceService.toPublic(updated, { usedBy: usedBy(req, resource.id) }) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.delete('/knowledge/:resourceId', ...adminOnly, (req, res) => {
    const resource = loadResource(req, res);
    if (!resource) return undefined;
    const affected = knowledgeResourceService.remove(resource.id);
    reindexBots(affected);
    audit(req, 'knowledge.delete', resource, { unlinkedBots: affected });
    return res.json({ deleted: true, unlinkedBots: affected });
  });

  return router;
}

module.exports = { createKnowledgeRouter };
