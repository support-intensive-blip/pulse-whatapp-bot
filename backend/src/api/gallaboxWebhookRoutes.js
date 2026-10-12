const express = require('express');
const gallaboxApi = require('../bot/gallabox/gallaboxApi');
const logger = require('../utils/logger');

/**
 * Receives Gallabox webhooks (Settings → Webhooks → Add Webhook, events
 * `Message.Received`, optionally `Conversation.Create` / `Conversation.Update`
 * and `Message.WA.Status.Failed`).
 *
 *   POST /webhooks/gallabox/:botId   one URL per connected number (preferred)
 *   POST /webhooks/gallabox          legacy single URL, routed by payload channelId
 *
 * Expects `req.rawBody` (set by the express.json verify hook in app.js) so the
 * HMAC signature is checked against the exact bytes Gallabox signed, using the
 * receiving bot's own webhook secret.
 */
function createGallaboxWebhookRouter(botManager) {
  const router = express.Router();

  function dispatch(req, res, bot) {
    const eventName = req.get('x-event-name') || req.body?.event || req.body?.eventName || 'Message.Received';
    const signature = req.get('x-gallabox-signature');

    if (!bot) {
      // 200 so Gallabox doesn't retry a number nobody is running.
      logger.warn(`Gallabox webhook ${eventName} for an unknown or stopped bot (${req.originalUrl}) — ignored`);
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (bot.webhookSecret) {
      if (!gallaboxApi.verifySignature(bot.webhookSecret, req.rawBody, signature)) {
        // No secrets logged — just enough to tell "no header" from "wrong secret/format".
        logger.warn(
          `Rejected Gallabox webhook for bot ${bot.botAccountId}: ${signature ? `signature mismatch (header length ${String(signature).length})` : 'no x-gallabox-signature header'}, event=${eventName}, body=${req.rawBody?.length || 0} bytes — check the webhook secret saved for this number`
        );
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } else if (process.env.NODE_ENV === 'production') {
      logger.error(`Rejected Gallabox webhook for bot ${bot.botAccountId}: a webhook secret is required in production`);
      return res.status(503).json({ error: 'Webhook secret not configured' });
    }

    const payload = req.body || {};
    logger.info(`Gallabox webhook accepted: bot=${bot.botAccountId}, event=${eventName}, type=${payload?.whatsapp?.type || 'n/a'}`);

    // Acknowledge first: Gallabox only needs a 2xx, and the AI reply (batch window
    // + LLM call) takes far longer than a webhook should be held open.
    res.status(200).json({ ok: true });

    bot.handleWebhookEvent(eventName, payload).catch((error) => {
      logger.error(`Gallabox webhook ${eventName} handling failed (bot ${bot.botAccountId}): ${error.message}`, {
        stack: error.stack,
      });
    });
    return undefined;
  }

  router.post('/webhooks/gallabox/:botId', (req, res) => {
    const bot = botManager.getBot(parseInt(req.params.botId, 10));
    return dispatch(req, res, bot?.isReady ? bot : null);
  });

  router.post('/webhooks/gallabox', (req, res) => {
    const channelId =
      req.body?.channelId || req.body?.latestChatMessage?.channelId || req.body?.latestMessage?.channelId || null;
    let bot = botManager.getBotForChannel(channelId);
    // Payloads without a channel id still work while only one number is running.
    if (!bot && !channelId) {
      const ready = botManager.getReadyBots();
      if (ready.length === 1) [bot] = ready;
    }
    return dispatch(req, res, bot);
  });

  return router;
}

module.exports = { createGallaboxWebhookRouter };
