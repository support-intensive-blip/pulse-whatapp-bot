const express = require('express');
const knowledgeBaseService = require('../services/knowledgeBaseService');
const logger = require('../utils/logger');

// Public, unauthenticated routes. Keep them free of contact or chat data — the
// old /users, /chats, /notes, /reminders and /stats dumps were removed for that
// reason; the dashboard reads everything through the authenticated /api routes.
function createRouter(botManagerRef) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    const ready = botManagerRef?.getReadyBots?.() || [];
    res.json({
      status: 'running',
      whatsapp: { connected: ready.length > 0, runningBots: ready.length },
    });
  });

  router.get('/knowledge-base', async (req, res) => {
    try {
      res.json(await knowledgeBaseService.getStatus());
    } catch (error) {
      logger.error(`API /knowledge-base error: ${error.message}`);
      res.status(500).json({ error: 'Failed to fetch knowledge base status' });
    }
  });

  return router;
}

module.exports = { createRouter };
