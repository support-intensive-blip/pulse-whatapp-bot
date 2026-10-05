const express = require('express');
const testApiService = require('../services/testApiService');
const logger = require('../utils/logger');

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function requireTestApiAuth(req, res, next) {
  if (!testApiService.isEnabled()) {
    return res.status(404).json({ error: 'Test API is disabled' });
  }

  const token = extractBearerToken(req);
  if (!testApiService.validateToken(token)) {
    return res.status(401).json({ error: 'Invalid or missing test API token' });
  }

  return next();
}

function parseBoolean(value, fallback = false) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return fallback;
}

function createTestApiRouter() {
  const router = express.Router();

  router.use(requireTestApiAuth);

  router.get('/status', (req, res) => {
    res.json({
      ...testApiService.getStatus(),
      skipFirewallDefault: testApiService.isSkipFirewallEnabled(),
      maxConcurrent: Number(process.env.TEST_API_MAX_CONCURRENT) || 8,
    });
  });

  router.post('/chat', async (req, res) => {
    try {
      const message = req.body?.message ?? req.body?.input ?? req.body?.text;
      const sessionId = req.body?.sessionId || req.body?.session || 'default';
      const isolated = parseBoolean(
        req.body?.isolated ?? req.body?.parallel ?? req.body?.stateless,
        false
      );
      const stateless = parseBoolean(
        req.body?.stateless,
        String(process.env.TEST_API_STATELESS_DEFAULT || '').toLowerCase() === 'true'
      );
      const skipFirewall = req.body?.skipFirewall;

      const result = await testApiService.runChat({
        message,
        sessionId,
        isolated,
        parallel: parseBoolean(req.body?.parallel, isolated),
        stateless,
        skipFirewall,
        persistMemory: stateless ? false : undefined,
      });

      if (result.error) {
        return res.status(400).json(result);
      }

      if (result.isolated) {
        res.setHeader('X-Test-Session-Id', result.sessionId);
      }
      return res.json(result);
    } catch (error) {
      const classified = testApiService.classifyRunError(error);
      logger.error(`Test API /chat error [${classified.code}]: ${error.message}`, {
        stack: error.stack,
      });
      return res.status(classified.status).json({
        error: 'Test chat failed',
        code: classified.code,
        retryable: classified.retryable,
        detail: error.message,
      });
    }
  });

  router.post('/reset', (req, res) => {
    try {
      const sessionId = req.body?.sessionId || req.body?.session || 'default';
      const result = testApiService.resetSession(sessionId);
      if (result.error) {
        return res.status(400).json(result);
      }
      return res.json(result);
    } catch (error) {
      const classified = testApiService.classifyRunError(error);
      logger.error(`Test API /reset error [${classified.code}]: ${error.message}`);
      return res.status(classified.status).json({
        error: 'Test reset failed',
        code: classified.code,
        retryable: classified.retryable,
        detail: error.message,
      });
    }
  });

  return router;
}

module.exports = { createTestApiRouter };
