const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { login } = require('../services/dashboardAuthService');
const { dashboardUserService } = require('../services/dashboardUserService');
const { botAccountService, BOT_STATUS } = require('../services/botAccountService');
const { actionItemService, ACTION_STATUS, ACTION_SOURCES } = require('../services/actionItemService');
const { requireAuth } = require('./middleware/auth');
const { resolveOwnerPhone, fastOwnerPhone, canAccessChatProfile, syncChatsIfReady, getBotConnectionState } = require('./dashboardHelpers');
const { formatUserFacingError, normalizePhone, canonicalContactPhone } = require('../utils/helpers');
const botManager = require('../bot/botManager');
const conversationService = require('../services/conversationService');
const chatRelayService = require('../services/chatRelayService');
const chatProfileService = require('../services/chatProfileService');
const memoryService = require('../services/memoryService');
const chatService = require('../services/chatService');
const { tokenUsageService } = require('../services/tokenUsageService');
const reminderService = require('../services/reminderService');
const noteService = require('../services/noteService');
const userService = require('../services/userService');
const { registerImportedContactOnWhatsApp, registerImportedContactsBatch } = require('../services/whatsappContactService');
const { pushSubscriptionService } = require('../services/pushSubscriptionService');
const { pushNotificationService } = require('../services/pushNotificationService');
const { dashboardAlertService } = require('../services/dashboardAlertService');
const logger = require('../utils/logger');

const upload = multer({ storage: multer.memoryStorage() });

function parseCsvRows(csvText) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const text = `${csvText || ''}\n`;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(field);
      field = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i += 1;
      if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else {
      field += ch;
    }
  }

  return rows;
}

function parseCsvMessages(csvText) {
  const rows = parseCsvRows(csvText).filter((r) => r.some((c) => String(c || '').trim()));
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const getIndex = (names) => headers.findIndex((h) => names.includes(h));

  const idxContactName = getIndex(['contact_name', 'contactname', 'name']);
  const idxContactPhone = getIndex(['contact_phone', 'contactphone', 'phone']);
  const idxRole = getIndex(['role']);
  const idxContent = getIndex(['content', 'message', 'text']);
  const idxTimestamp = getIndex(['timestamp', 'time', 'created_at']);
  const idxEnableAi = getIndex(['enable_ai', 'enableai', 'ai', 'active']);

  if (idxContent < 0) return [];

  return rows.slice(1).map((r) => ({
    contactName: idxContactName >= 0 ? String(r[idxContactName] || '').trim() : '',
    contactPhone: idxContactPhone >= 0 ? String(r[idxContactPhone] || '').trim() : '',
    role: idxRole >= 0 ? String(r[idxRole] || '').trim().toLowerCase() : 'user',
    content: String(r[idxContent] || '').trim(),
    timestamp: idxTimestamp >= 0 ? String(r[idxTimestamp] || '').trim() : '',
    enableAi: idxEnableAi >= 0 ? parseActiveFlag(r[idxEnableAi], null) : null,
  }));
}

function parseActiveFlag(value, fallback = true) {
  if (value == null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'enable', 'enabled'].includes(v)) return true;
  if (['false', '0', 'no', 'off', 'disable', 'disabled'].includes(v)) return false;
  return fallback;
}

function parseCsvAiBulk(csvText) {
  const rows = parseCsvRows(csvText).filter((r) => r.some((c) => String(c || '').trim()));
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const getIndex = (names) => headers.findIndex((h) => names.includes(h));
  const idxName = getIndex(['contact_name', 'contactname', 'name']);
  const idxActive = getIndex(['active', 'enable_ai', 'enableai', 'ai']);

  if (idxName < 0) return [];

  return rows
    .slice(1)
    .map((r) => ({
      name: String(r[idxName] || '').trim(),
      active: idxActive >= 0 ? parseActiveFlag(r[idxActive], null) : null,
    }))
    .filter((row) => row.name);
}

function bulkUpdateAssistantForContacts(ownerPhone, entries, defaultActive = true) {
  const profiles = chatProfileService
    .getByOwner(ownerPhone)
    .filter((p) => p.chat_type === 'contact');

  const updatedChats = [];
  const seen = new Set();

  for (const entry of entries) {
    const token = String(entry.name || '').trim().toLowerCase();
    if (!token) continue;
    const active = entry.active == null ? defaultActive : Boolean(entry.active);

    const matched = profiles.filter((p) => {
      const v = `${p.contact_name || ''}`.toLowerCase();
      return v.includes(token);
    });

    for (const profile of matched) {
      if (seen.has(profile.id)) continue;
      seen.add(profile.id);
      const updated = active
        ? chatProfileService.enableAssistantExplicit(profile.id)
        : chatProfileService.disableAssistant(profile.id);
      updatedChats.push(conversationService.enrichChat(updated));
    }
  }

  return updatedChats;
}

function getUserBot(req) {
  const userId = req.dashboardUser?.id;
  const ownBot = botAccountService.findByDashboardUserId(userId);
  if (!ownBot || !userId) return ownBot || null;

  // Never borrow another user's live WhatsApp session — that shared QR/Connect
  // and chats across team members. Only reconcile with a live client that
  // belongs to this same dashboard user (stale status row edge case).
  if (ownBot.status === BOT_STATUS.READY) return ownBot;

  const liveReadyBot = botManager.getAnyReadyBot();
  const liveBotId = liveReadyBot?.getStatus?.()?.botAccountId;
  if (liveBotId) {
    const liveAccount = botAccountService.findById(liveBotId);
    if (liveAccount?.dashboard_user_id === userId) {
      return liveAccount;
    }
  }

  return ownBot;
}

function resolveStatsOwnerPhones(manager, bot) {
  const phones = new Set();
  const add = (value) => {
    const normalized = normalizePhone(value);
    if (normalized) phones.add(normalized);
  };

  add(fastOwnerPhone(bot));
  if (bot) {
    add(bot.whatsapp_phone);
    add(bot.last_whatsapp_phone);
  }
  add(manager.coach_phone);

  return [...phones];
}

const statsCache = new Map();

function getCachedStats(botId) {
  const entry = statsCache.get(botId);
  if (!entry) return null;
  if (Date.now() - entry.at > STATS_CACHE_TTL_MS) {
    statsCache.delete(botId);
    return null;
  }
  return entry.data;
}

function setCachedStats(botId, data) {
  statsCache.set(botId, { at: Date.now(), data });
}

function ensureBotLinkStarted(botAccountId) {
  const account = botAccountService.findById(botAccountId);
  if (!account) return;

  const hasSession = Boolean(account.whatsapp_phone || account.last_whatsapp_phone);
  if (account.status === BOT_STATUS.DISCONNECTED && !hasSession) return;

  const live = botManager.getBot(botAccountId);
  if (live?.getStatus()?.ready) return;
  if (live?.isInitializing || live?._qrRestartInFlight || botManager.isStarting(botAccountId)) return;

  botManager.startBot(botAccountId).catch((error) => {
    logger.warn(`Background bot start failed (bot ${botAccountId}): ${error.message}`);
  });
}

function createDashboardRouter() {
  const router = express.Router();

  router.post('/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = login(email, password);
    if (result.error) {
      return res.status(401).json({ error: result.error });
    }
    return res.json(result);
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    let bot = getUserBot(req);
    const user = dashboardUserService.findById(req.dashboardUser.id);
    if (!bot && user) {
      bot = botAccountService.createForUser(user.id, user.name);
    }
    const refreshed = bot ? botAccountService.findById(bot.id) : null;

    if (refreshed) {
      ensureBotLinkStarted(refreshed.id);
      resolveOwnerPhone(refreshed).catch(() => {});
    }

    const liveStatus = refreshed ? botManager.getStatus(refreshed.id) : null;
    const connection = refreshed ? getBotConnectionState(refreshed) : null;
    const publicBot = refreshed ? botAccountService.toPublic(refreshed) : null;

    res.json({
      user,
      bot: publicBot
        ? {
            ...publicBot,
            status: liveStatus?.live?.ready ? BOT_STATUS.READY : publicBot.status,
            live: liveStatus?.live,
            connected: connection?.connected ?? false,
            reconnecting: connection?.reconnecting ?? false,
            hasSession: connection?.hasSession ?? false,
          }
        : null,
    });
  });

  router.patch('/auth/password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }

    const result = dashboardUserService.changePassword(
      req.dashboardUser.id,
      currentPassword,
      newPassword
    );
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    return res.json({ user: result.user });
  });

  router.get('/admin/sqlite-guard', requireAuth, (req, res) => {
    const {
      isDeletionGuardEnabled,
      getSqlitePaths,
    } = require('../database/sqliteGuard');
    const fs = require('fs');
    const { backupDir, dbPath } = getSqlitePaths();
    const backups = fs.existsSync(backupDir)
      ? fs
          .readdirSync(backupDir)
          .filter((n) => n.endsWith('.db'))
          .sort()
          .reverse()
          .slice(0, 20)
      : [];
    res.json({
      deletionGuardEnabled: isDeletionGuardEnabled(),
      dbExists: fs.existsSync(dbPath),
      backups,
    });
  });

  router.post('/admin/sqlite-backup', requireAuth, (req, res) => {
    try {
      const { backupSqliteDatabase } = require('../database/sqliteGuard');
      const result = backupSqliteDatabase({ reason: 'admin-api' });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/admin/sqlite-purge', requireAuth, (req, res) => {
    try {
      const {
        assertDeletionPassword,
        backupSqliteDatabase,
      } = require('../database/sqliteGuard');
      const { getDatabase } = require('../database/db');
      assertDeletionPassword(req.body?.password, {
        action: 'purge conversation tables',
      });
      backupSqliteDatabase({ reason: 'pre-admin-purge' });
      const db = getDatabase();
      const purge = db.transaction(() => {
        db.exec('DELETE FROM messages');
        db.exec('DELETE FROM conversation_summaries');
        db.exec('DELETE FROM action_items');
        db.exec('DELETE FROM token_usage');
        db.exec('DELETE FROM chat_profiles');
        db.exec('DELETE FROM notes');
        db.exec('DELETE FROM reminders');
      });
      purge();
      logger.warn(
        `Owner ${req.dashboardUser.id} purged conversation tables after password check`
      );
      return res.json({ ok: true });
    } catch (error) {
      const status =
        error.code === 'SQLITE_GUARD_INVALID_PASSWORD' ||
        error.code === 'SQLITE_GUARD_NOT_CONFIGURED'
          ? 403
          : 500;
      return res.status(status).json({ error: error.message });
    }
  });

  router.get('/bot', requireAuth, (req, res) => {
    const bot = getUserBot(req);
    if (!bot) {
      return res.status(404).json({ error: 'No bot account' });
    }
    res.json(botManager.getStatus(bot.id));
  });

  router.post('/bot/start', requireAuth, async (req, res) => {
    try {
      const bot = getUserBot(req);
      if (!bot) {
        return res.status(404).json({ error: 'No bot account' });
      }

      const statusPayload = botManager.getStatus(bot.id);
      if (statusPayload.live?.ready) {
        return res.json(statusPayload);
      }

      if (!botManager.isStarting(bot.id)) {
        botManager.startBot(bot.id).catch((error) => {
          logger.error(`Background bot start failed: ${error.message}`);
        });
      }

      return res.status(202).json({
        ...botManager.getStatus(bot.id),
        starting: true,
      });
    } catch (error) {
      logger.error(`Bot start failed: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/bot/stop', requireAuth, async (req, res) => {
    try {
      const bot = getUserBot(req);
      if (!bot) {
        return res.status(404).json({ error: 'No bot account' });
      }
      await botManager.stopBot(bot.id);
      res.json(botManager.getStatus(bot.id));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/bot/prepare-link', requireAuth, async (req, res) => {
    try {
      const bot = getUserBot(req);
      if (!bot) {
        return res.status(404).json({ error: 'No bot account' });
      }
      const mode = req.body?.mode === 'code' ? 'code' : 'qr';
      const force = Boolean(req.body?.force);
      await botManager.prepareLinkMode(bot.id, mode, { force });
      const qr = botManager.getQrDataUrl(bot.id);
      res.json({
        status: bot.status,
        qr,
        pairingCode: botManager.getPairingCode(bot.id),
        authMode: mode,
        ...botManager.getStatus(bot.id),
      });
    } catch (error) {
      logger.error(`Prepare link failed: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/bot/qr', requireAuth, (req, res) => {
    const bot = getUserBot(req);
    if (!bot) {
      return res.status(404).json({ error: 'No bot account' });
    }

    ensureBotLinkStarted(bot.id);

    const statusPayload = botManager.getStatus(bot.id);
    res.json({
      ...statusPayload,
      qr: botManager.getQrDataUrl(bot.id),
      pairingCode: botManager.getPairingCode(bot.id),
    });
  });

  router.post('/bot/pairing-code', requireAuth, async (req, res) => {
    try {
      const bot = getUserBot(req);
      if (!bot) {
        return res.status(404).json({ error: 'No bot account' });
      }
      const phoneNumber = String(req.body?.phoneNumber || '').trim();
      if (!phoneNumber) {
        return res.status(400).json({ error: 'phoneNumber is required (10-digit Indian mobile, e.g. 123456789)' });
      }
      const code = await botManager.requestPairingCode(bot.id, phoneNumber);
      res.json({
        pairingCode: code,
        ...botManager.getStatus(bot.id),
      });
    } catch (error) {
      logger.error(`Pairing code request failed: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  router.patch('/bot/settings', requireAuth, (req, res) => {
    const bot = getUserBot(req);
    if (!bot) {
      return res.status(404).json({ error: 'No bot account' });
    }

    const updated = botAccountService.updateSettings(bot.id, {
      name: req.body?.name,
      assistantName: req.body?.assistantName,
      assistantSelfEnabled: req.body?.assistantSelfEnabled,
      assistantContactsEnabled: req.body?.assistantContactsEnabled,
    });

    res.json(botAccountService.toPublic(updated));
  });

  router.get('/notifications/vapid-public-key', requireAuth, (req, res) => {
    res.json({ publicKey: pushNotificationService.getPublicKey() });
  });

  router.post('/notifications/subscribe', requireAuth, (req, res) => {
    const subscription = req.body?.subscription;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription payload' });
    }
    pushSubscriptionService.upsert({
      dashboardUserId: req.dashboardUser.id,
      subscription,
      userAgent: req.headers['user-agent'] || null,
    });
    const logger = require('../utils/logger');
    logger.info(`Push subscription saved for dashboard user ${req.dashboardUser.id}`);
    return res.json({ subscribed: true });
  });

  router.post('/notifications/unsubscribe', requireAuth, (req, res) => {
    const endpoint = req.body?.endpoint;
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
    pushSubscriptionService.removeByEndpoint(endpoint);
    return res.json({ unsubscribed: true });
  });

  router.get('/notifications/inbox', requireAuth, (req, res) => {
    const alerts = dashboardAlertService.listForUser(req.dashboardUser.id);
    res.json({
      alerts,
      unreadCount: dashboardAlertService.unreadCount(req.dashboardUser.id),
    });
  });

  router.post('/notifications/inbox/:id/read', requireAuth, (req, res) => {
    const alertId = Number(req.params.id);
    if (!Number.isFinite(alertId)) {
      return res.status(400).json({ error: 'Invalid alert id' });
    }
    const alert = dashboardAlertService.markRead(alertId, req.dashboardUser.id);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    return res.json({
      alert,
      unreadCount: dashboardAlertService.unreadCount(req.dashboardUser.id),
    });
  });

  router.post('/notifications/inbox/read-all', requireAuth, (req, res) => {
    const count = dashboardAlertService.markAllRead(req.dashboardUser.id);
    return res.json({ marked: count, unreadCount: 0 });
  });

  router.post('/conversations/sync', requireAuth, async (req, res) => {
    try {
      const bot = getUserBot(req);
      if (!bot) return res.status(404).json({ error: 'No bot account' });

      ensureBotLinkStarted(bot.id);
      const syncResult = await syncChatsIfReady(bot);
      const ownerPhone = await resolveOwnerPhone(bot);
      const search = req.query.search || '';
      const chats = ownerPhone
        ? conversationService.listForOwner(ownerPhone, { search, consolidate: false })
        : [];
      const connection = getBotConnectionState(bot);

      const connected = syncResult.connected || connection.connected;
      let message;
      if (syncResult.reconnecting) {
        message =
          'WhatsApp is reconnecting from your saved session (no new QR needed). Wait a moment and try Sync again.';
      } else if (!connected && !connection.hasSession) {
        message = 'Connect WhatsApp first — open Connect and scan QR once.';
      } else if (syncResult.timedOut && !connected) {
        message = 'WhatsApp is still starting after deploy. Wait ~30 seconds and try Sync again.';
      } else if (syncResult.syncedCount > 0) {
        message = `Synced ${syncResult.syncedCount} contact(s) from WhatsApp.`;
      } else if (connected && chats.length > 0) {
        message = `Showing ${chats.length} saved chat(s). Live list refresh returned 0 — try Sync once more in a few seconds.`;
      } else if (connected) {
        message = 'Connected, but WhatsApp returned no chats yet. Message someone, then Sync again.';
      }

      res.json({
        synced: syncResult.syncedCount > 0,
        syncedCount: syncResult.syncedCount,
        connected,
        reconnecting: syncResult.reconnecting || connection.reconnecting,
        hasSession: connection.hasSession,
        message,
        count: chats.length,
        chats,
      });
    } catch (error) {
      res.status(503).json({
        error: 'WhatsApp browser disconnected during sync. Wait a moment and try again.',
        detail: error.message,
      });
    }
  });

  router.get('/conversations', requireAuth, (req, res) => {
    const bot = getUserBot(req);
    if (bot) ensureBotLinkStarted(bot.id);
    const { connected, reconnecting, hasSession } = getBotConnectionState(bot);
    const ownerPhone = fastOwnerPhone(bot);

    if (ownerPhone && bot && !bot.whatsapp_phone) {
      resolveOwnerPhone(bot).catch(() => {});
    }

    if (!ownerPhone) {
      return res.json({
        chats: [],
        connected,
        reconnecting,
        hasSession,
        message: connected
          ? 'Account linking… click Sync to load chats.'
          : reconnecting
            ? 'WhatsApp is reconnecting from your saved session…'
            : 'Connect WhatsApp to load chats',
      });
    }

    const search = req.query.search || '';
    const assistantFilter = String(req.query.assistant || 'all').toLowerCase();
    const assistant = ['all', 'enabled', 'disabled'].includes(assistantFilter)
      ? assistantFilter
      : 'all';
    const chats = conversationService.listForOwner(ownerPhone, { search, assistant });

    res.json({
      connected,
      reconnecting,
      hasSession,
      count: chats.length,
      chats,
      syncedAt: new Date().toISOString(),
    });
  });

  router.patch('/conversations/:chatProfileId/assistant', requireAuth, async (req, res) => {
    const bot = getUserBot(req);
    const ownerPhone = await resolveOwnerPhone(bot);
    const chatProfileId = parseInt(req.params.chatProfileId, 10);
    let profile = chatProfileService.findById(chatProfileId);

    if (!profile || !canAccessChatProfile(bot, profile)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Avoid full-owner consolidation here — with 10k+ chats it blocks the
    // event loop and makes the dashboard appear stuck loading.
    profile = chatProfileService.consolidateProfileGroup(profile, ownerPhone);

    const active = req.body?.active;
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active (boolean) is required' });
    }

    const updated = active
      ? chatProfileService.enableAssistantExplicit(profile.id)
      : chatProfileService.disableAssistant(profile.id);

    res.json({ chat: conversationService.enrichChat(updated) });
  });

  router.patch('/conversations/assistant/bulk-all', requireAuth, async (req, res) => {
    const bot = getUserBot(req);
    const ownerPhone = await resolveOwnerPhone(bot);
    if (!ownerPhone) {
      return res.status(400).json({ error: 'WhatsApp not connected' });
    }

    const active = req.body?.active;
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active (boolean) is required' });
    }

    const ownerUser =
      userService.findByPhone(ownerPhone) ||
      userService.getOrCreate(`${ownerPhone}@c.us`, null);

    if (active) {
      userService.setAssistantContacts(ownerUser.id, true);
    } else {
      userService.setAssistantContacts(ownerUser.id, false);
      chatProfileService.forceDisableAllContactAssistants(ownerPhone);
    }

    const chats = conversationService.listForOwner(ownerPhone);
    const contacts = chats.filter((c) => c.chatType !== 'self');

    return res.json({
      active,
      updatedCount: contacts.length,
      chats: contacts,
    });
  });

  router.patch('/conversations/assistant/bulk', requireAuth, async (req, res) => {
    const bot = getUserBot(req);
    const ownerPhone = await resolveOwnerPhone(bot);
    if (!ownerPhone) {
      return res.status(400).json({ error: 'WhatsApp not connected' });
    }

    const active = req.body?.active;
    const names = Array.isArray(req.body?.contactNames) ? req.body.contactNames : [];
    if (typeof active !== 'boolean' || names.length === 0) {
      return res.status(400).json({ error: 'active (boolean) and contactNames[] are required' });
    }

    const tokens = names.map((n) => String(n || '').trim()).filter(Boolean);
    const updatedChats = bulkUpdateAssistantForContacts(
      ownerPhone,
      tokens.map((name) => ({ name, active })),
      active
    );

    return res.json({
      updatedCount: updatedChats.length,
      requestedCount: tokens.length,
      chats: updatedChats,
    });
  });

  router.post('/conversations/assistant/bulk-csv', requireAuth, upload.single('file'), async (req, res) => {
    const bot = getUserBot(req);
    const ownerPhone = await resolveOwnerPhone(bot);
    if (!ownerPhone) {
      return res.status(400).json({ error: 'WhatsApp not connected' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'CSV file is required' });
    }

    const defaultActive = parseActiveFlag(req.body?.defaultActive, true);
    const entries = parseCsvAiBulk(req.file.buffer.toString('utf8'));
    if (!entries.length) {
      return res.status(400).json({ error: 'No valid rows — need contact_name column' });
    }

    const updatedChats = bulkUpdateAssistantForContacts(ownerPhone, entries, defaultActive);

    return res.json({
      updatedCount: updatedChats.length,
      requestedCount: entries.length,
      chats: updatedChats,
    });
  });

  router.post('/conversations/import', requireAuth, async (req, res) => {
    const bot = getUserBot(req);
    const ownerPhone = await resolveOwnerPhone(bot);
    if (!ownerPhone) {
      return res.status(400).json({ error: 'WhatsApp not connected' });
    }

    const contactName = String(req.body?.contactName || '').trim();
    const contactPhone = canonicalContactPhone(req.body?.contactPhone || '') || '';
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const enableAi = Boolean(req.body?.enableAi);

    if (!contactName && !contactPhone) {
      return res.status(400).json({ error: 'contactName or contactPhone is required' });
    }
    if (!messages.length) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const chatIdBase = contactPhone || contactName.toLowerCase().replace(/\s+/g, '_');
    const chatId = `${chatIdBase}@manual.import`;
    const profile = chatProfileService.getOrCreate({
      chatId,
      ownerPhone,
      contactName: contactName || contactPhone,
      contactPhone: contactPhone || null,
      chatType: 'contact',
    });

    messages.forEach((msg) => {
      const role = ['user', 'owner', 'assistant'].includes(msg?.role) ? msg.role : 'user';
      const content = String(msg?.content || '').trim();
      if (!content) return;
      memoryService.addMessage(profile.id, role, content, { source: 'manual_import' });
    });

    let finalProfile = chatProfileService.findById(profile.id);
    let whatsappContact = null;
    if (contactPhone) {
      const registered = await registerImportedContactOnWhatsApp(bot.id, finalProfile, {
        contactName: contactName || contactPhone,
        contactPhone,
      });
      finalProfile = registered.profile;
      whatsappContact = registered.whatsapp;
    }

    if (enableAi) {
      chatProfileService.enableAssistantExplicit(finalProfile.id);
      finalProfile = chatProfileService.findById(finalProfile.id);
    }

    return res.status(201).json({
      imported: true,
      chat: conversationService.enrichChat(finalProfile),
      messageCount: messages.length,
      whatsappContact,
    });
  });

  router.post('/conversations/import-csv', requireAuth, upload.single('file'), async (req, res) => {
    const bot = getUserBot(req);
    const ownerPhone = await resolveOwnerPhone(bot);
    if (!ownerPhone) {
      return res.status(400).json({ error: 'WhatsApp not connected' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'CSV file is required' });
    }

    const csvText = req.file.buffer.toString('utf8');
    const records = parseCsvMessages(csvText);
    if (!records.length) {
      return res.status(400).json({ error: 'No valid records found in CSV' });
    }

    const grouped = new Map();
    records.forEach((r) => {
      if (!r.content) return;
      const phone = canonicalContactPhone(r.contactPhone || '') || '';
      const name = r.contactName || phone || 'Imported Contact';
      const key = phone || name.toLowerCase();
      if (!grouped.has(key)) {
        grouped.set(key, { name, phone, messages: [], enableAi: null });
      }
      const bucket = grouped.get(key);
      if (r.enableAi != null) bucket.enableAi = r.enableAi;
      bucket.messages.push({
        role: ['user', 'owner', 'assistant'].includes(r.role) ? r.role : 'user',
        content: r.content,
      });
    });

    const chats = [];
    const batchItems = [];
    for (const entry of grouped.values()) {
      const chatId = `${entry.phone || entry.name.toLowerCase().replace(/\s+/g, '_')}@manual.import`;
      const profile = chatProfileService.getOrCreate({
        chatId,
        ownerPhone,
        contactName: entry.name,
        contactPhone: entry.phone || null,
        chatType: 'contact',
      });
      entry.messages.forEach((m) => {
        memoryService.addMessage(profile.id, m.role, m.content, { source: 'manual_import_csv' });
      });
      batchItems.push({
        profile: chatProfileService.findById(profile.id),
        contactName: entry.name,
        contactPhone: entry.phone || null,
        enableAi: entry.enableAi,
      });
    }

    const registered = await registerImportedContactsBatch(bot.id, batchItems);
    for (const item of registered) {
      let profile = item.profile;
      if (item.enableAi) {
        chatProfileService.enableAssistantExplicit(profile.id);
        profile = chatProfileService.findById(profile.id);
      }
      chats.push({
        ...conversationService.enrichChat(profile),
        whatsappContact: item.whatsapp,
      });
    }

    res.status(201).json({
      imported: true,
      contacts: chats.length,
      records: records.length,
      chats,
      whatsappAdded: registered.filter((r) => r.whatsapp?.ok).length,
    });
  });

  router.get('/conversations/export', requireAuth, async (req, res) => {
    const bot = getUserBot(req);
    const ownerPhone = await resolveOwnerPhone(bot);
    if (!ownerPhone) {
      return res.status(400).json({ error: 'WhatsApp not connected' });
    }

    const format = (req.query.format || 'json').toLowerCase();
    const ids = req.query.ids
      ? req.query.ids.split(',').map((id) => parseInt(id.trim(), 10)).filter(Boolean)
      : null;
    const from = req.query.from || req.query.start || null;
    const to = req.query.to || req.query.end || null;

    const data = conversationService.exportChats(ownerPhone, ids, { from, to });

    const rangeSuffix =
      from || to
        ? `_${String(from || 'start').replace(/[:\s]/g, '-')}_to_${String(to || 'now').replace(/[:\s]/g, '-')}`
        : '';

    if (format === 'csv') {
      const csv = conversationService.toCsv(data);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="chats-export${rangeSuffix}.csv"`
      );
      return res.send(csv);
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="chats-export${rangeSuffix}.json"`
    );
    return res.json(conversationService.toExportJson(data));
  });

  router.get('/conversations/contact/:contactKey/chats', requireAuth, async (req, res) => {
    const bot = getUserBot(req);
    const ownerPhone = await resolveOwnerPhone(bot);
    if (!ownerPhone) {
      return res.status(400).json({ error: 'WhatsApp not connected' });
    }

    const contactKey = decodeURIComponent(req.params.contactKey);
    const search = req.query.search || '';
    const chats = conversationService.listChatsForContact(ownerPhone, contactKey, { search });

    res.json({
      contactKey,
      count: chats.length,
      chats,
    });
  });

  router.get('/conversations/:chatProfileId/messages', requireAuth, (req, res) => {
    const bot = getUserBot(req);
    const ownerPhone = fastOwnerPhone(bot);
    const chatProfileId = parseInt(req.params.chatProfileId, 10);
    let profile = chatProfileService.findById(chatProfileId);

    if (!profile || !canAccessChatProfile(bot, profile)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    profile =
      chatProfileService.consolidateProfileGroup(profile, ownerPhone) || profile;

    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const sinceId = req.query.since ? parseInt(req.query.since, 10) : null;
    const siblingIds = chatProfileService.getSiblingProfiles(profile).map((p) => p.id);
    const profileIds = siblingIds.length ? siblingIds : [profile.id];
    const messages = memoryService.getMessagesForProfiles(profileIds, limit, { sinceId });
    const liveBot = botManager.getBot(bot?.id);

    res.json({
      chat: conversationService.enrichChat(profile),
      messages,
      connected: Boolean(liveBot?.isReady),
      syncedAt: new Date().toISOString(),
    });
  });

  router.post('/conversations/:chatProfileId/messages', requireAuth, async (req, res) => {
    try {
      const bot = getUserBot(req);
      if (!bot) return res.status(404).json({ error: 'No bot account' });

      const chatProfileId = parseInt(req.params.chatProfileId, 10);
      let profile = chatProfileService.findById(chatProfileId);

      if (!profile || !canAccessChatProfile(bot, profile)) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const ownerPhone = fastOwnerPhone(bot);
      profile =
        chatProfileService.consolidateProfileGroup(profile, ownerPhone) || profile;

      const content = req.body?.content;
      const result = await chatRelayService.sendOwnerMessage(bot.id, profile.id, content);
      res.json({
        message: result.message,
        chat: conversationService.enrichChat(result.chat || profile),
      });
    } catch (error) {
      res.status(400).json({ error: formatUserFacingError(error) });
    }
  });

  router.post('/conversations/:chatProfileId/summarize', requireAuth, async (req, res) => {
    try {
      const bot = getUserBot(req);
      const chatProfileId = parseInt(req.params.chatProfileId, 10);
      const profile = chatProfileService.findById(chatProfileId);

      if (!profile || !canAccessChatProfile(bot, profile)) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const summary = await chatService.generateSummary(chatProfileId);
      res.json({
        summary,
        contactName: profile.contact_name || 'Contact',
      });
    } catch (error) {
      res.status(500).json({ error: formatUserFacingError(error) });
    }
  });

  // Sends one new WhatsApp message with a Pulse conversation summary.
  // Cannot restore past Pulse bubbles onto mobile/web — WhatsApp owns history.
  router.post('/conversations/:chatProfileId/summarize-to-whatsapp', requireAuth, async (req, res) => {
    try {
      const bot = getUserBot(req);
      if (!bot) return res.status(404).json({ error: 'No bot account' });

      const chatProfileId = parseInt(req.params.chatProfileId, 10);
      let profile = chatProfileService.findById(chatProfileId);

      if (!profile || !canAccessChatProfile(bot, profile)) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const ownerPhone = fastOwnerPhone(bot);
      profile =
        chatProfileService.consolidateProfileGroup(profile, ownerPhone) || profile;

      const summary = await chatService.generateSummary(profile.id);
      if (!summary || !String(summary).trim()) {
        return res.status(400).json({ error: 'No conversation history to summarize for this chat.' });
      }
      if (/no conversation history|no api key configured/i.test(summary)) {
        return res.status(400).json({ error: summary });
      }

      const contactLabel = profile.contact_name || profile.contact_phone || 'this chat';
      const content = [
        'Conversation summary (from Pulse)',
        `Contact: ${contactLabel}`,
        '',
        String(summary).trim(),
        '',
        'Note: This is a summary of Pulse history — WhatsApp cannot restore older Pulse messages as past chat bubbles.',
      ].join('\n');

      const result = await chatRelayService.sendOwnerMessage(bot.id, profile.id, content);
      res.json({
        summary,
        message: result.message,
        chat: conversationService.enrichChat(result.chat || profile),
        contactName: profile.contact_name || 'Contact',
      });
    } catch (error) {
      res.status(400).json({ error: formatUserFacingError(error) });
    }
  });

  router.post('/conversations/:chatProfileId/escalate', requireAuth, async (req, res) => {
    try {
      const bot = getUserBot(req);
      const chatProfileId = parseInt(req.params.chatProfileId, 10);
      const profile = chatProfileService.findById(chatProfileId);

      if (!profile || !canAccessChatProfile(bot, profile)) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const ownerBot =
        botAccountService.findByWhatsappPhone(profile.owner_phone) || bot;
      const botAccountId = bot?.id || ownerBot?.id;
      if (!botAccountId) {
        return res.status(400).json({ error: 'No bot account for this chat' });
      }

      const recentMessages = memoryService.getMessages(chatProfileId, 30);
      const lastUserMsg = [...recentMessages].reverse().find((m) => m.role === 'user');
      const description = String(req.body?.description || lastUserMsg?.content || '')
        .trim()
        .slice(0, 500);
      const contactLabel = profile.contact_name || profile.contact_phone || 'Contact';
      const title = String(req.body?.title || `Follow up: ${contactLabel}`).trim().slice(0, 120);

      const item = actionItemService.createEscalation({
        botAccountId,
        chatProfileId,
        source: ACTION_SOURCES.MANUAL,
        title,
        description: description || `Manual escalation from dashboard for ${contactLabel}.`,
        category: 'manual',
        priority: 'l2',
        dedupeKey: lastUserMsg?.id
          ? `manual:${chatProfileId}:${lastUserMsg.id}`
          : `manual:${chatProfileId}:${Date.now()}`,
        assignedDashboardUserId: req.dashboardUser.id,
        triggerMessageId: lastUserMsg?.id || null,
      });

      res.json({
        item,
        created: item.created !== false,
        message: item.created === false
          ? 'An open action item already exists for this chat.'
          : 'Added to Call to Action.',
      });
    } catch (error) {
      res.status(500).json({ error: formatUserFacingError(error) });
    }
  });

  router.get('/action-items', requireAuth, (req, res) => {
    const bot = getUserBot(req);
    const status = req.query.status || null;
    const coach = req.query.coach || '';
    const student = req.query.student || '';
    const category = req.query.category || '';

    const items = actionItemService.listGlobal({
      status,
      coachQuery: coach,
      studentQuery: student,
      category,
    });
    const counts = bot?.id ? actionItemService.getCounts(bot.id) : [];
    res.json({ items, counts, scope: 'self' });
  });

  router.patch('/action-items/:id', requireAuth, (req, res) => {
    const bot = getUserBot(req);
    const id = parseInt(req.params.id, 10);
    const item = actionItemService.findById(id);

    if (!item) {
      return res.status(404).json({ error: 'Action item not found' });
    }

    const status = req.body?.status;
    if (![ACTION_STATUS.DONE, ACTION_STATUS.PENDING, ACTION_STATUS.CANCELLED].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    res.json({ item: actionItemService.updateStatus(id, status) });
  });

  router.get('/stats', requireAuth, (req, res) => {
    const bot = getUserBot(req);
    const manager = req.dashboardUser;
    const cacheKey = `stats-${manager.id}`;
    if (!req.query.fresh) {
      const cached = getCachedStats(cacheKey);
      if (cached) {
        return res.json(cached);
      }
    }

    const ownerPhone = fastOwnerPhone(bot);
    if (ownerPhone && bot && !bot.whatsapp_phone) {
      resolveOwnerPhone(bot).catch(() => {});
    } else if (bot) {
      resolveOwnerPhone(bot).catch(() => {});
    }

    const scope = 'self';
    let ownerPhones = resolveStatsOwnerPhones(manager, bot);
    const managedBotIds = bot?.id ? [bot.id] : [];

    if (!ownerPhones.length) {
      const db = require('../database/db').getDatabase();
      ownerPhones = db
        .prepare('SELECT DISTINCT owner_phone FROM chat_profiles WHERE owner_phone IS NOT NULL')
        .all()
        .map((row) => normalizePhone(row.owner_phone))
        .filter(Boolean);
    }

    const counts = conversationService.getStatsForOwnerPhones(ownerPhones);
    const emptyTokenUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estimated_cost_usd: 0,
      request_count: 0,
      byCategory: [],
      efficiency: {
        blockedCount: 0,
        firewallCount: 0,
        chatCount: 0,
        estimatedSavingsUsd: 0,
        avgChatCostUsd: 0,
      },
    };

    const payload = {
      scope,
      bot: botManager.getStatus(bot?.id),
      totalChats: counts.totalChats,
      activeChats: counts.activeChats,
      totalMessages: counts.totalMessages,
      messagesToday: counts.messagesToday,
      aiResponses: counts.aiResponses,
      tokenUsage: ownerPhones.length
        ? tokenUsageService.getBotStats({ ownerPhones })
        : emptyTokenUsage,
      reminders: reminderService.getCount(),
      notes: noteService.getCount(),
      actionItems: managedBotIds.length
        ? actionItemService.getCountsForBots(managedBotIds)
        : [],
    };

    setCachedStats(cacheKey, payload);
    res.json(payload);
  });

  return router;
}

module.exports = { createDashboardRouter };
