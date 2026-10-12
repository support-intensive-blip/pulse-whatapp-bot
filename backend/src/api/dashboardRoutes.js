const express = require('express');
const multer = require('multer');
const { login } = require('../services/dashboardAuthService');
const { dashboardUserService } = require('../services/dashboardUserService');
const { botAccountService } = require('../services/botAccountService');
const { teamService } = require('../services/teamService');
const { requireAuth, requireRole, requireTeam, botForProfile, canAccessProfile } = require('./middleware/auth');
const { parseActiveFlag, parseCsvMessages, parseCsvAiBulk } = require('./csvUtils');
const { formatUserFacingError, canonicalContactPhone } = require('../utils/helpers');
const { runWithBot } = require('../utils/botContext');
const botManager = require('../bot/botManager');
const conversationService = require('../services/conversationService');
const chatRelayService = require('../services/chatRelayService');
const chatProfileService = require('../services/chatProfileService');
const memoryService = require('../services/memoryService');
const chatService = require('../services/chatService');
const { actionItemService, ACTION_SOURCES } = require('../services/actionItemService');
const { tokenUsageService } = require('../services/tokenUsageService');
const reminderService = require('../services/reminderService');
const noteService = require('../services/noteService');
const userService = require('../services/userService');
const { registerImportedContactOnWhatsApp, registerImportedContactsBatch } = require('../services/whatsappContactService');
const { pushSubscriptionService } = require('../services/pushSubscriptionService');
const { pushNotificationService } = require('../services/pushNotificationService');
const { dashboardAlertService } = require('../services/dashboardAlertService');
const { createTeamRouter } = require('./teamRoutes');
const { createUserRouter } = require('./userRoutes');
const { createBotRouter } = require('./botRoutes');
const { createKnowledgeRouter } = require('./knowledgeRoutes');
const { createContactRouter } = require('./contactRoutes');
const { createActionItemRouter } = require('./actionItemRoutes');
const { createAnalyticsRouter } = require('./analyticsRoutes');
const logger = require('../utils/logger');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const STATS_CACHE_TTL_MS = 30 * 1000;

/** Bots the request is narrowed to (?botId= / x-bot-id), else every team bot. */
function selectedBots(req) {
  const ids = new Set(req.scope.botIds);
  return req.scope.bots.filter((bot) => ids.has(bot.id));
}

/** Single bot for write actions on "the" number (import etc.). */
function resolveSingleBot(req, explicitBotId = null) {
  const id = Number(explicitBotId) || (req.scope.botIds.length === 1 ? req.scope.botIds[0] : null);
  return id ? req.scope.bots.find((bot) => bot.id === id) || null : null;
}

/** Loads a chat profile the caller may access, or answers 404. */
function loadScopedProfile(req, res) {
  const profile = chatProfileService.findById(parseInt(req.params.chatProfileId, 10));
  if (!profile || !canAccessProfile(req.scope, profile)) {
    res.status(404).json({ error: 'Conversation not found' });
    return null;
  }
  return profile;
}

function withBotInfo(chat, bot) {
  if (!chat || !bot) return chat;
  return { ...chat, botId: bot.id, botName: bot.name, botPhone: botAccountService.getPhone(bot) };
}

function connectionSummary(bots) {
  const connected = bots.filter((bot) => botManager.getBot(bot.id)?.isReady).length;
  return { connected: connected > 0, connectedCount: connected, numberCount: bots.length };
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

const statsCache = new Map();

function getCachedStats(key) {
  const entry = statsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > STATS_CACHE_TTL_MS) {
    statsCache.delete(key);
    return null;
  }
  return entry.data;
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

  // Who am I + the team/numbers the dashboard shell needs (selectors, nav).
  router.get('/auth/me', requireAuth, (req, res) => {
    const { scope } = req;
    const bots = scope.bots.map((bot) => ({
      ...botAccountService.toSummary(bot),
      connected: Boolean(botManager.getBot(bot.id)?.isReady),
    }));
    res.json({
      user: dashboardUserService.toPublic(req.dashboardUser),
      team: teamService.toPublic(scope.team),
      teams: scope.isOwner ? teamService.listWithStats().map((team) => teamService.toPublic(team)) : undefined,
      bots,
      permissions: {
        isOwner: scope.isOwner,
        isAdmin: scope.isAdmin,
      },
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
    return res.json({ user: dashboardUserService.toPublic(result.user) });
  });

  router.get('/admin/sqlite-guard', requireAuth, requireRole('owner'), (req, res) => {
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

  router.post('/admin/sqlite-backup', requireAuth, requireRole('owner'), (req, res) => {
    try {
      const { backupSqliteDatabase } = require('../database/sqliteGuard');
      const result = backupSqliteDatabase({ reason: 'admin-api' });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/admin/sqlite-purge', requireAuth, requireRole('owner'), (req, res) => {
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

  // ---- Unified inbox (all numbers of the team, or one via ?botId=) ----

  function listInbox(req) {
    const bots = selectedBots(req);
    const assistantFilter = String(req.query.assistant || 'all').toLowerCase();
    const assigned = req.query.assigned === 'me' ? req.dashboardUser.id : req.query.assigned || null;
    const chats = conversationService.listForBots(bots, {
      search: req.query.search || '',
      assistant: ['all', 'enabled', 'disabled'].includes(assistantFilter) ? assistantFilter : 'all',
      tag: req.query.tag || '',
      assignedUserId: assigned,
      awaiting: req.query.awaiting === '1' || req.query.awaiting === 'true',
      limit: Math.min(parseInt(req.query.limit, 10) || 300, 1000),
    });
    const connection = connectionSummary(bots);
    let message;
    if (!bots.length) {
      message = 'No WhatsApp number is connected to this team yet.';
    } else if (!chats.length) {
      message = connection.connected
        ? 'No chats yet — they appear as people message your WhatsApp numbers.'
        : 'WhatsApp (Gallabox) is not connected — see AI Bots.';
    }
    return { chats, count: chats.length, ...connection, reconnecting: false, hasSession: connection.connected, message, syncedAt: new Date().toISOString() };
  }

  router.get('/conversations', requireAuth, requireTeam, (req, res) => {
    res.json(listInbox(req));
  });

  // Gallabox has no "list chats" API; kept for the dashboard's refresh button.
  router.post('/conversations/sync', requireAuth, requireTeam, (req, res) => {
    try {
      res.json({ synced: false, syncedCount: 0, ...listInbox(req) });
    } catch (error) {
      res.status(503).json({ error: 'Could not load chats. Try again in a moment.', detail: error.message });
    }
  });

  router.patch('/conversations/:chatProfileId/assistant', requireAuth, (req, res) => {
    let profile = loadScopedProfile(req, res);
    if (!profile) return undefined;

    const active = req.body?.active;
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active (boolean) is required' });
    }

    // Avoid full-owner consolidation here — with 10k+ chats it blocks the
    // event loop and makes the dashboard appear stuck loading.
    profile = chatProfileService.consolidateProfileGroup(profile, profile.owner_phone) || profile;

    const updated = active
      ? chatProfileService.enableAssistantExplicit(profile.id)
      : chatProfileService.disableAssistant(profile.id);

    return res.json({ chat: withBotInfo(conversationService.enrichChat(updated), botForProfile(req.scope, updated)) });
  });

  // Tags, assignee, notes, display name.
  router.patch('/conversations/:chatProfileId/contact', requireAuth, (req, res) => {
    const profile = loadScopedProfile(req, res);
    if (!profile) return undefined;

    const { tags, assignedUserId, contactNotes, contactName } = req.body || {};
    if (assignedUserId) {
      const assignee = dashboardUserService.findById(assignedUserId);
      const sameTeam = assignee && (assignee.team_id === req.scope.teamId || assignee.role === 'owner');
      if (!sameTeam || !assignee.is_active) {
        return res.status(400).json({ error: 'Assignee must be an active member of this team' });
      }
    }
    if (tags !== undefined && !Array.isArray(tags)) {
      return res.status(400).json({ error: 'tags must be a list' });
    }

    const updated = chatProfileService.updateContactDetails(profile.id, { tags, assignedUserId, contactNotes, contactName });
    return res.json({ chat: withBotInfo(conversationService.enrichChat(updated), botForProfile(req.scope, updated)) });
  });

  router.patch('/conversations/assistant/bulk-all', requireAuth, requireRole('admin'), requireTeam, (req, res) => {
    const active = req.body?.active;
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active (boolean) is required' });
    }

    const bots = selectedBots(req);
    for (const bot of bots) {
      const ownerPhone = botAccountService.getPhone(bot);
      if (!ownerPhone) continue;
      const ownerUser =
        userService.findByPhone(ownerPhone) || userService.getOrCreate(`${ownerPhone}@c.us`, null);
      userService.setAssistantContacts(ownerUser.id, active);
      if (!active) chatProfileService.forceDisableAllContactAssistants(ownerPhone);
    }

    const contacts = conversationService.listForBots(bots).filter((c) => c.chatType !== 'self');
    return res.json({ active, updatedCount: contacts.length, chats: contacts });
  });

  router.patch('/conversations/assistant/bulk', requireAuth, requireRole('admin'), requireTeam, (req, res) => {
    const active = req.body?.active;
    const names = Array.isArray(req.body?.contactNames) ? req.body.contactNames : [];
    if (typeof active !== 'boolean' || names.length === 0) {
      return res.status(400).json({ error: 'active (boolean) and contactNames[] are required' });
    }

    const tokens = names.map((n) => String(n || '').trim()).filter(Boolean);
    const updatedChats = selectedBots(req).flatMap((bot) =>
      bulkUpdateAssistantForContacts(
        botAccountService.getPhone(bot),
        tokens.map((name) => ({ name, active })),
        active
      )
    );

    return res.json({ updatedCount: updatedChats.length, requestedCount: tokens.length, chats: updatedChats });
  });

  router.post(
    '/conversations/assistant/bulk-csv',
    requireAuth,
    requireRole('admin'),
    requireTeam,
    upload.single('file'),
    (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'CSV file is required' });
      }

      const defaultActive = parseActiveFlag(req.body?.defaultActive, true);
      const entries = parseCsvAiBulk(req.file.buffer.toString('utf8'));
      if (!entries.length) {
        return res.status(400).json({ error: 'No valid rows — need contact_name column' });
      }

      const updatedChats = selectedBots(req).flatMap((bot) =>
        bulkUpdateAssistantForContacts(botAccountService.getPhone(bot), entries, defaultActive)
      );
      return res.json({ updatedCount: updatedChats.length, requestedCount: entries.length, chats: updatedChats });
    }
  );

  // Imports one contact with past message history into a chosen number.
  router.post('/conversations/import', requireAuth, requireTeam, async (req, res) => {
    const bot = resolveSingleBot(req, req.body?.botId);
    const ownerPhone = botAccountService.getPhone(bot);
    if (!bot || !ownerPhone) {
      return res.status(400).json({ error: 'Choose which WhatsApp number to import into' });
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
    const profile = chatProfileService.getOrCreate({
      chatId: `${chatIdBase}@manual.import`,
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
      chat: withBotInfo(conversationService.enrichChat(finalProfile), bot),
      messageCount: messages.length,
      whatsappContact,
    });
  });

  router.post('/conversations/import-csv', requireAuth, requireTeam, upload.single('file'), async (req, res) => {
    const bot = resolveSingleBot(req, req.body?.botId);
    const ownerPhone = botAccountService.getPhone(bot);
    if (!bot || !ownerPhone) {
      return res.status(400).json({ error: 'Choose which WhatsApp number to import into' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'CSV file is required' });
    }

    const records = parseCsvMessages(req.file.buffer.toString('utf8'));
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

    const batchItems = [];
    for (const entry of grouped.values()) {
      const profile = chatProfileService.getOrCreate({
        chatId: `${entry.phone || entry.name.toLowerCase().replace(/\s+/g, '_')}@manual.import`,
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

    const chats = [];
    const registered = await registerImportedContactsBatch(bot.id, batchItems);
    for (const item of registered) {
      let { profile } = item;
      if (item.enableAi) {
        chatProfileService.enableAssistantExplicit(profile.id);
        profile = chatProfileService.findById(profile.id);
      }
      chats.push({ ...withBotInfo(conversationService.enrichChat(profile), bot), whatsappContact: item.whatsapp });
    }

    return res.status(201).json({
      imported: true,
      contacts: chats.length,
      records: records.length,
      chats,
      whatsappAdded: registered.filter((r) => r.whatsapp?.ok).length,
    });
  });

  router.get('/conversations/export', requireAuth, requireTeam, (req, res) => {
    const format = (req.query.format || 'json').toLowerCase();
    const ids = req.query.ids
      ? req.query.ids.split(',').map((id) => parseInt(id.trim(), 10)).filter(Boolean)
      : null;
    const from = req.query.from || req.query.start || null;
    const to = req.query.to || req.query.end || null;

    const data = selectedBots(req).flatMap((bot) =>
      conversationService.exportChats(botAccountService.getPhone(bot), ids, { from, to })
    );

    const rangeSuffix =
      from || to
        ? `_${String(from || 'start').replace(/[:\s]/g, '-')}_to_${String(to || 'now').replace(/[:\s]/g, '-')}`
        : '';

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="chats-export${rangeSuffix}.csv"`);
      return res.send(conversationService.toCsv(data));
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="chats-export${rangeSuffix}.json"`);
    return res.json(conversationService.toExportJson(data));
  });

  router.get('/conversations/contact/:contactKey/chats', requireAuth, requireTeam, (req, res) => {
    const contactKey = decodeURIComponent(req.params.contactKey);
    const search = req.query.search || '';
    const chats = selectedBots(req).flatMap((bot) =>
      conversationService
        .listChatsForContact(botAccountService.getPhone(bot), contactKey, { search })
        .map((chat) => withBotInfo(chat, bot))
    );
    res.json({ contactKey, count: chats.length, chats });
  });

  router.get('/conversations/:chatProfileId/messages', requireAuth, (req, res) => {
    let profile = loadScopedProfile(req, res);
    if (!profile) return undefined;

    profile = chatProfileService.consolidateProfileGroup(profile, profile.owner_phone) || profile;

    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const sinceId = req.query.since ? parseInt(req.query.since, 10) : null;
    const siblingIds = chatProfileService.getSiblingProfiles(profile).map((p) => p.id);
    const profileIds = siblingIds.length ? siblingIds : [profile.id];
    const messages = memoryService.getMessagesForProfiles(profileIds, limit, { sinceId });
    const bot = botForProfile(req.scope, profile);

    return res.json({
      chat: withBotInfo(conversationService.enrichChat(profile), bot),
      messages,
      connected: Boolean(bot && botManager.getBot(bot.id)?.isReady),
      syncedAt: new Date().toISOString(),
    });
  });

  router.post('/conversations/:chatProfileId/messages', requireAuth, async (req, res) => {
    try {
      const profile = loadScopedProfile(req, res);
      if (!profile) return undefined;
      const bot = botForProfile(req.scope, profile);
      if (!bot) return res.status(404).json({ error: 'This chat’s WhatsApp number is no longer connected' });

      const result = await chatRelayService.sendOwnerMessage(bot.id, profile.id, req.body?.content);
      return res.json({
        message: result.message,
        chat: withBotInfo(conversationService.enrichChat(result.chat || profile), bot),
      });
    } catch (error) {
      return res.status(400).json({ error: formatUserFacingError(error) });
    }
  });

  router.post('/conversations/:chatProfileId/summarize', requireAuth, async (req, res) => {
    try {
      const profile = loadScopedProfile(req, res);
      if (!profile) return undefined;
      const bot = botForProfile(req.scope, profile);
      const summary = await runWithBot(bot?.id, () => chatService.generateSummary(profile.id));
      return res.json({ summary, contactName: profile.contact_name || 'Contact' });
    } catch (error) {
      return res.status(500).json({ error: formatUserFacingError(error) });
    }
  });

  // Sends one new WhatsApp message with a Pulse conversation summary.
  // Cannot restore past Pulse bubbles onto mobile/web — WhatsApp owns history.
  router.post('/conversations/:chatProfileId/summarize-to-whatsapp', requireAuth, async (req, res) => {
    try {
      let profile = loadScopedProfile(req, res);
      if (!profile) return undefined;
      const bot = botForProfile(req.scope, profile);
      if (!bot) return res.status(404).json({ error: 'This chat’s WhatsApp number is no longer connected' });

      profile = chatProfileService.consolidateProfileGroup(profile, profile.owner_phone) || profile;

      const summary = await runWithBot(bot.id, () => chatService.generateSummary(profile.id));
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
      return res.json({
        summary,
        message: result.message,
        chat: withBotInfo(conversationService.enrichChat(result.chat || profile), bot),
        contactName: profile.contact_name || 'Contact',
      });
    } catch (error) {
      return res.status(400).json({ error: formatUserFacingError(error) });
    }
  });

  router.post('/conversations/:chatProfileId/escalate', requireAuth, (req, res) => {
    try {
      const profile = loadScopedProfile(req, res);
      if (!profile) return undefined;
      const bot = botForProfile(req.scope, profile);
      if (!bot) return res.status(400).json({ error: 'No WhatsApp number for this chat' });

      const recentMessages = memoryService.getMessages(profile.id, 30);
      const lastUserMsg = [...recentMessages].reverse().find((m) => m.role === 'user');
      const description = String(req.body?.description || lastUserMsg?.content || '')
        .trim()
        .slice(0, 500);
      const contactLabel = profile.contact_name || profile.contact_phone || 'Contact';
      const title = String(req.body?.title || `Follow up: ${contactLabel}`).trim().slice(0, 120);

      const item = actionItemService.createEscalation({
        botAccountId: bot.id,
        chatProfileId: profile.id,
        source: ACTION_SOURCES.MANUAL,
        title,
        description: description || `Manual escalation from dashboard for ${contactLabel}.`,
        category: 'manual',
        priority: req.body?.priority || 'high',
        dedupeKey: lastUserMsg?.id
          ? `manual:${profile.id}:${lastUserMsg.id}`
          : `manual:${profile.id}:${Date.now()}`,
        assignedDashboardUserId: req.body?.assignedUserId || req.dashboardUser.id,
        createdByUserId: req.dashboardUser.id,
        triggerMessageId: lastUserMsg?.id || null,
      });

      return res.json({
        item,
        created: item.created !== false,
        message: item.created === false
          ? 'An open action item already exists for this chat.'
          : 'Added to Call to Action.',
      });
    } catch (error) {
      return res.status(500).json({ error: formatUserFacingError(error) });
    }
  });

  router.get('/stats', requireAuth, requireTeam, (req, res) => {
    const bots = selectedBots(req);
    const cacheKey = `stats-${req.scope.teamId}-${bots.map((b) => b.id).join(',')}`;
    if (!req.query.fresh) {
      const cached = getCachedStats(cacheKey);
      if (cached) return res.json(cached);
    }

    const ownerPhones = bots.map((bot) => botAccountService.getPhone(bot)).filter(Boolean);
    const counts = conversationService.getStatsForOwnerPhones(ownerPhones);

    const payload = {
      scope: req.scope.botIds.length === req.scope.bots.length ? 'team' : 'number',
      ...connectionSummary(bots),
      bots: bots.map((bot) => ({
        ...botAccountService.toSummary(bot),
        connected: Boolean(botManager.getBot(bot.id)?.isReady),
      })),
      totalChats: counts.totalChats,
      activeChats: counts.activeChats,
      totalMessages: counts.totalMessages,
      messagesToday: counts.messagesToday,
      aiResponses: counts.aiResponses,
      tokenUsage: req.scope.isAdmin && ownerPhones.length ? tokenUsageService.getBotStats({ ownerPhones }) : null,
      reminders: reminderService.getCount(),
      notes: noteService.getCount(),
      actionItems: actionItemService.getCountsForBots(bots.map((bot) => bot.id)),
    };

    statsCache.set(cacheKey, { at: Date.now(), data: payload });
    return res.json(payload);
  });

  router.use(createTeamRouter());
  router.use(createUserRouter());
  router.use(createBotRouter());
  router.use(createKnowledgeRouter());
  router.use(createContactRouter());
  router.use(createActionItemRouter());
  router.use(createAnalyticsRouter());

  return router;
}

module.exports = { createDashboardRouter };
