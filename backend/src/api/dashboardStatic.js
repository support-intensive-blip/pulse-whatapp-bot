const express = require('express');
const path = require('node:path');

function createDashboardStatic(directory) {
  const router = express.Router();
  const root = path.resolve(directory);
  const serve = express.static(root, {
    index: false,
    setHeaders(res, filename) {
      const relative = path.relative(root, filename);
      res.setHeader('Cache-Control', relative.startsWith(`assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache');
    },
  });
  router.use((req, res, next) => {
    if (/^\/(api|webhooks|health|knowledge-base)(\/|$)/i.test(req.path)) return next();
    return serve(req, res, next);
  });
  router.get('*', (req, res, next) => {
    if (/^\/(api|webhooks|assets|health|knowledge-base)(\/|$)/i.test(req.path) ||
        path.posix.extname(req.path) || !req.accepts('html')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(path.join(root, 'index.html'));
  });
  return router;
}

module.exports = { createDashboardStatic };
