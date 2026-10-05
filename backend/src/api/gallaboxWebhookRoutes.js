const express = require('express');
const gallaboxApi = require('../bot/gallabox/gallaboxApi');
const logger = require('../utils/logger');

/**
 * Receives Gallabox webhooks (Settings → Webhooks → Add Webhook, events
 * `Message.Received` and optionally `Message.WA.Status.Failed`).
 *
 * Expects `req.rawBody` (set by the express.json verify hook in app.js) so the
 * HMAC signature is checked against the exact bytes Gallabox signed.
 */
function createGallaboxWebhookRouter(botManager) {
  const router = express.Router();

  router.post('/webhooks/gallabox', (req, res) => {
    const { webhookSecret } = gallaboxApi.getConfig();
    const signature = req.get('x-gallabox-signature');

    if (webhookSecret) {
      if (!gallaboxApi.verifySignature(req.rawBody, signature)) {
        logger.warn('Rejected Gallabox webhook with missing/invalid signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } else if (process.env.NODE_ENV === 'production') {
      logger.error('Rejected Gallabox webhook: GALLABOX_WEBHOOK_SECRET must be set in production');
      return res.status(503).json({ error: 'Webhook secret not configured' });
    }

    const eventName = req.get('x-event-name') || req.body?.event || req.body?.eventName || 'Message.Received';
    const payload = req.body || {};

    // Acknowledge first: Gallabox only needs a 2xx, and the AI reply (batch window
    // + LLM call) takes far longer than a webhook should be held open.
    res.status(200).json({ ok: true });

    const bot = botManager.getAnyReadyBot();
    if (!bot) {
      logger.warn(`Gallabox webhook ${eventName} received but no bot is running (check GALLABOX_* env)`);
      return;
    }

    bot.handleWebhookEvent(eventName, payload).catch((error) => {
      logger.error(`Gallabox webhook ${eventName} handling failed: ${error.message}`, { stack: error.stack });
    });
  });

  return router;
}

module.exports = { createGallaboxWebhookRouter };
