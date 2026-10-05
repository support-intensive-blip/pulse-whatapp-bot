const express = require('express');
const userService = require('../services/userService');
const noteService = require('../services/noteService');
const reminderService = require('../services/reminderService');
const memoryService = require('../services/memoryService');
const chatProfileService = require('../services/chatProfileService');
const knowledgeBaseService = require('../services/knowledgeBaseService');
const logger = require('../utils/logger');

function createRouter(botManagerRef) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    const readyBot = botManagerRef?.getAnyReadyBot?.() || null;
    res.json({
      status: 'running',
      whatsapp: {
        connected: Boolean(readyBot),
        botAccountId: readyBot?.getStatus?.()?.botAccountId || null,
      },
    });
  });

  router.get('/users', (req, res) => {
    try {
      const users = userService.getAll();
      res.json({ count: users.length, users });
    } catch (error) {
      logger.error(`API /users error: ${error.message}`);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  router.get('/notes', (req, res) => {
    try {
      const notes = noteService.getAll();
      res.json({ count: notes.length, notes });
    } catch (error) {
      logger.error(`API /notes error: ${error.message}`);
      res.status(500).json({ error: 'Failed to fetch notes' });
    }
  });

  router.get('/reminders', (req, res) => {
    try {
      const reminders = reminderService.getAll();
      res.json({ count: reminders.length, reminders });
    } catch (error) {
      logger.error(`API /reminders error: ${error.message}`);
      res.status(500).json({ error: 'Failed to fetch reminders' });
    }
  });

  router.get('/knowledge-base', async (req, res) => {
    try {
      res.json(await knowledgeBaseService.getStatus());
    } catch (error) {
      logger.error(`API /knowledge-base error: ${error.message}`);
      res.status(500).json({ error: 'Failed to fetch knowledge base status' });
    }
  });

  router.get('/chats', (req, res) => {
    try {
      const chats = chatProfileService.getAll();
      res.json({ count: chats.length, chats });
    } catch (error) {
      logger.error(`API /chats error: ${error.message}`);
      res.status(500).json({ error: 'Failed to fetch chat profiles' });
    }
  });

  router.get('/stats', (req, res) => {
    try {
      res.json({
        total_users: userService.getCount(),
        total_messages: memoryService.getTotalMessageCount(),
        total_notes: noteService.getCount(),
        total_reminders: reminderService.getCount(),
        total_chats: chatProfileService.getAll().length,
        whatsapp: botManagerRef?.getAnyReadyBot()?.getStatus() || { ready: false },
      });
    } catch (error) {
      logger.error(`API /stats error: ${error.message}`);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  return router;
}

module.exports = { createRouter };
