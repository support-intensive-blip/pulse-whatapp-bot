require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { initializeDatabaseAsync, closeDatabase } = require('./database/db');
const { isBigQueryPrimary } = require('./database/storageMode');
const bigqueryService = require('./services/bigqueryService');
const botManager = require('./bot/botManager');
const { createRouter } = require('./api/routes');
const { createDashboardRouter } = require('./api/dashboardRoutes');
const { createTestApiRouter } = require('./api/testApiRoutes');
const { dashboardUserService } = require('./services/dashboardUserService');
const botConfigService = require('./services/botConfigService');
const { botAccountService } = require('./services/botAccountService');
const { actionItemService, ACTION_SOURCES } = require('./services/actionItemService');
const reminderService = require('./services/reminderService');
const knowledgeBaseService = require('./services/knowledgeBaseService');
const logger = require('./utils/logger');
const { ensureAppDirs } = require('./utils/helpers');
const { clearStaleChromiumLocks } = require('./utils/chromiumProfile');
const { REMINDER_CHECK_CRON } = require('./utils/constants');

const PORT = parseInt(process.env.PORT, 10) || 3000;

let reminderCronJob = null;
let kbRefreshTimer = null;

const KB_REINGEST_INTERVAL_MS = (() => {
  const raw = Number(process.env.KB_REINGEST_INTERVAL_MS);
  if (Number.isFinite(raw) && raw >= 5000) return raw;
  return 10000;
})();

function validateEnvironment() {
  if (!process.env.OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY is required. Copy .env.example to .env and set your API key.');
    process.exit(1);
  }
  if (isBigQueryPrimary()) {
    if (!bigqueryService.isEnabled()) {
      logger.error('BigQuery-primary mode requires BQ_ENABLED=true and GCP_PROJECT_ID in .env');
      process.exit(1);
    }
    logger.info('Storage: BigQuery-primary (in-memory cache, no disk SQLite)');
  } else if (process.env.BQ_ENABLED === 'true') {
    logger.info('Storage: disk SQLite (durable) + BigQuery write-through');
  } else {
    logger.info('Storage: disk SQLite (durable)');
  }
}

function createExpressApp() {
  const app = express();

  if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  app.use(
    cors({
      origin: process.env.DASHBOARD_CORS_ORIGIN || true,
      credentials: true,
    })
  );
  app.use(express.json());

  app.use('/api', createDashboardRouter());
  app.use('/api/test', createTestApiRouter());
  app.use(createRouter(botManager));

  const dashboardDist = path.join(process.cwd(), 'dashboard', 'dist');
  const fs = require('fs');
  if (fs.existsSync(path.join(dashboardDist, 'index.html'))) {
    app.use(
      express.static(dashboardDist, {
        maxAge: '1h',
        setHeaders(res, filePath) {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
          if (filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Service-Worker-Allowed', '/');
          }
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );
    app.get('*', (req, res, next) => {
      if (
        req.path.startsWith('/api') ||
        ['/health', '/users', '/notes', '/reminders', '/knowledge-base', '/chats', '/stats'].includes(
          req.path.split('?')[0]
        )
      ) {
        return next();
      }
      res.sendFile(path.join(dashboardDist, 'index.html'), (err) => {
        if (err) next();
      });
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err, req, res, next) => {
    logger.error(`Express error: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

function startReminderScheduler() {
  reminderCronJob = cron.schedule(REMINDER_CHECK_CRON, async () => {
    try {
      const pending = reminderService.getPendingReminders();

      for (const reminder of pending) {
        const account = botAccountService
          .listReadyBots()
          .find((b) => b.whatsapp_phone === reminder.phone);

        const bot = account ? botManager.getBot(account.id) : botManager.getAnyReadyBot();
        if (!bot || !bot.getStatus().ready) continue;

        const phone = `${reminder.phone}@c.us`;
        const text = `⏰ *Reminder*\n\n${reminder.message}`;

        try {
          await bot.sendMessage(phone, text);
          reminderService.markAsSent(reminder.id);
          if (account) {
            actionItemService.create({
              botAccountId: account.id,
              source: ACTION_SOURCES.REMINDER,
              title: 'Reminder sent',
              description: reminder.message,
            });
          }
          logger.info(`Reminder sent to ${reminder.phone}: ${reminder.message}`);
        } catch (error) {
          logger.error(`Failed to send reminder ${reminder.id}: ${error.message}`);
        }
      }
    } catch (error) {
      logger.error(`Reminder scheduler error: ${error.message}`);
    }
  });

  logger.info('Reminder scheduler started');
}

function startKbRefreshScheduler() {
  if (process.env.KB_AUTO_REFRESH === 'false') {
    logger.info('KB auto-refresh disabled (KB_AUTO_REFRESH=false)');
    return;
  }

  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await knowledgeBaseService.refreshAll();
    } catch (error) {
      logger.warn(`KB auto-refresh error: ${error.message}`);
    } finally {
      running = false;
    }
  };

  kbRefreshTimer = setInterval(tick, KB_REINGEST_INTERVAL_MS);
  tick();
  logger.info(`KB auto-refresh every ${KB_REINGEST_INTERVAL_MS}ms`);
}

async function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  if (reminderCronJob) {
    reminderCronJob.stop();
  }

  if (kbRefreshTimer) {
    clearInterval(kbRefreshTimer);
    kbRefreshTimer = null;
  }

  await botManager.shutdownAll();

  try {
    const { getDatabase } = require('./database/db');
    const { flushAllPendingSyncs } = require('./database/bqSync');
    const db = getDatabase();
    flushAllPendingSyncs(db);
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (_error) {
      // :memory: or unsupported — ignore
    }
  } catch (error) {
    logger.warn(`Database flush on shutdown skipped: ${error.message}`);
  }

  closeDatabase();
  logger.info('Shutdown complete');
  process.exit(0);
}

async function start() {
  try {
    validateEnvironment();
    ensureAppDirs();
    await initializeDatabaseAsync();
    try {
      const { startSqliteBackupScheduler } = require('./database/sqliteGuard');
      startSqliteBackupScheduler();
    } catch (error) {
      logger.warn(`SQLite backup scheduler failed to start: ${error.message}`);
    }
    dashboardUserService.seedAdminIfNeeded();
    botConfigService.loadAllBotConfigs();
    await knowledgeBaseService.initialize();

    const app = createExpressApp();

    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Dashboard: http://localhost:${PORT}`);
      logger.info(`API: http://localhost:${PORT}/api`);
    });

    startReminderScheduler();
    startKbRefreshScheduler();
    clearStaleChromiumLocks('.wwebjs_auth');

    if (process.env.WHATSAPP_AUTO_START !== 'false') {
      const delayMs = Math.max(3000, Number(process.env.WHATSAPP_AUTO_START_DELAY_MS) || 8000);
      setTimeout(() => {
        botManager.startReadyBots().catch((error) => {
          logger.warn(`Auto-start bots failed: ${error.message}`);
        });
      }, delayMs);
      logger.info(`WhatsApp auto-start scheduled in ${delayMs}ms`);
    }

    logger.info('WhatsApp AI Assistant started successfully');
  } catch (error) {
    logger.error(`Startup failed: ${error.message}`, { stack: error.stack });
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.message}`, { stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  const { isRecoverableBrowserError } = require('./utils/chromiumProfile');

  if (isRecoverableBrowserError(reason)) {
    logger.warn(`Recoverable browser rejection: ${message}`);
    return;
  }

  logger.error(`Unhandled rejection: ${message}`, { stack });
});

start();
