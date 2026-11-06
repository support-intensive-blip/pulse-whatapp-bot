const express = require('express');
const crypto = require('crypto');

function createGupshupWebhookRouter(botManager) {
  const router = express.Router();
  router.post('/webhooks/gupshup/:botId', async (req, res) => {
    const bot = botManager.getBot(Number(req.params.botId));
    if (!bot?.isReady || bot.getStatus().provider !== 'gupshup') return res.sendStatus(503);
    const supplied = Buffer.from(String(req.query.token || ''));
    const expected = Buffer.from(bot.webhookSecret || '');
    if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.sendStatus(401);
    try {
      if (req.body?.type !== 'message') return res.json({ ok: true });
      const signature = crypto.createHmac('sha256', bot.webhookSecret).update(req.rawBody).digest('hex');
      const inbox = require('../services/reliableInbox');
      await inbox.accept(bot.botAccountId, 'gupshup', req.rawBody, signature);
      setImmediate(() => inbox.tick(botManager));
      return res.json({ ok: true, durable: true });
    } catch {
      return res.sendStatus(503);
    }
  });
  return router;
}

module.exports = { createGupshupWebhookRouter };
