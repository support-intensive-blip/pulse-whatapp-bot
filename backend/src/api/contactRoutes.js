const express = require('express');
const multer = require('multer');
const { getDatabase } = require('../database/db');
const chatProfileService = require('../services/chatProfileService');
const conversationService = require('../services/conversationService');
const { botAccountService } = require('../services/botAccountService');
const { auditLogService } = require('../services/auditLogService');
const { OPEN_STATUSES } = require('../services/actionItemService');
const { requireAuth, requireTeam, findScopedBot } = require('./middleware/auth');
const { parseCsvTable, csvCell } = require('./csvUtils');
const { canonicalContactPhone } = require('../utils/helpers');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const MAX_IMPORT_ROWS = 5000;

const FIELD_ALIASES = {
  name: ['name', 'contact_name', 'contactname', 'full name', 'student name'],
  phone: ['phone', 'contact_phone', 'contactphone', 'mobile', 'whatsapp', 'number', 'phone number'],
  tags: ['tags', 'tag', 'labels'],
  notes: ['notes', 'note', 'comments'],
};

const TEMPLATE_CSV = 'name,phone,tags,notes\nRavi Kumar,919876543210,batch-12;admissions,Asked about fee installments\n';

function suggestMapping(headers) {
  const lower = headers.map((h) => h.toLowerCase());
  const mapping = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const index = lower.findIndex((h) => aliases.includes(h));
    mapping[field] = index >= 0 ? headers[index] : null;
  }
  return mapping;
}

function validPhone(raw) {
  const phone = canonicalContactPhone(raw);
  return phone && phone.length >= 11 && phone.length <= 13 ? phone : null;
}

function splitTags(raw) {
  return String(raw || '')
    .split(/[;|]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Parses the CSV with a column mapping and classifies every row for one number:
 * new | existing (already a chat on this number) | duplicate (repeated in file) | invalid.
 */
function analyzeImport(csvText, mappingInput, ownerPhone) {
  const { headers, rows } = parseCsvTable(csvText);
  if (!headers.length) throw new Error('The CSV file is empty');
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`Import at most ${MAX_IMPORT_ROWS} rows at a time`);

  const mapping = { ...suggestMapping(headers), ...(mappingInput || {}) };
  if (!mapping.phone || !headers.includes(mapping.phone)) {
    throw new Error('Map a column to "phone" — it is required');
  }
  const col = (field) => (mapping[field] ? headers.indexOf(mapping[field]) : -1);
  const idx = { name: col('name'), phone: col('phone'), tags: col('tags'), notes: col('notes') };

  const seen = new Set();
  const analyzed = rows.map((row, i) => {
    const value = (field) => (idx[field] >= 0 ? String(row[idx[field]] || '').trim() : '');
    const rawPhone = value('phone');
    const phone = validPhone(rawPhone);
    const entry = {
      rowNumber: i + 2,
      name: value('name'),
      rawPhone,
      phone,
      tags: splitTags(value('tags')),
      notes: value('notes'),
      status: 'new',
      error: null,
      existingChatId: null,
    };
    if (!phone) {
      entry.status = 'invalid';
      entry.error = rawPhone ? 'Not a valid mobile number (use 10 digits or include the country code)' : 'Phone is empty';
    } else if (seen.has(phone)) {
      entry.status = 'duplicate';
      entry.error = 'Same number appears earlier in this file';
    } else {
      seen.add(phone);
      const existing = chatProfileService.findLinkedContactProfile(ownerPhone, {
        contactPhone: phone,
        chatId: `${phone}@c.us`,
      });
      if (existing) {
        entry.status = 'existing';
        entry.existingChatId = existing.id;
      }
    }
    return entry;
  });

  const count = (status) => analyzed.filter((r) => r.status === status).length;
  return {
    headers,
    mapping,
    rows: analyzed,
    summary: {
      total: analyzed.length,
      new: count('new'),
      existing: count('existing'),
      duplicate: count('duplicate'),
      invalid: count('invalid'),
    },
  };
}

function readCsvInput(req) {
  if (req.file) return { csvText: req.file.buffer.toString('utf8'), filename: req.file.originalname };
  if (req.body?.csv) return { csvText: String(req.body.csv), filename: req.body.filename || 'pasted.csv' };
  throw new Error('Upload a CSV file');
}

function parseMapping(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    throw new Error('mapping must be JSON');
  }
}

/** Contacts = chats per number. The same person on two numbers is two contacts. */
function createContactRouter() {
  const router = express.Router();

  function importBot(req) {
    const bot = findScopedBot(req.scope, req.body?.botId);
    if (!bot || !botAccountService.getPhone(bot)) throw new Error('Choose which WhatsApp number these contacts belong to');
    return bot;
  }

  router.get('/contacts', requireAuth, requireTeam, (req, res) => {
    const ids = new Set(req.scope.botIds);
    const bots = req.scope.bots.filter((bot) => ids.has(bot.id));
    const assigned = req.query.assigned === 'me' ? req.dashboardUser.id : req.query.assigned || null;
    let contacts = conversationService
      .listForBots(bots, {
        search: req.query.search || '',
        tag: req.query.tag || '',
        assignedUserId: assigned,
        limit: Math.min(parseInt(req.query.limit, 10) || 1000, 5000),
      })
      .filter((chat) => chat.chatType === 'contact');
    if (req.query.source) contacts = contacts.filter((chat) => (chat.importSource || 'whatsapp').startsWith(req.query.source));

    // Open CTA count per contact, in one query.
    const openCounts = new Map();
    if (contacts.length) {
      const profileIds = contacts.map((c) => c.id);
      const rows = getDatabase()
        .prepare(
          `SELECT chat_profile_id, COUNT(*) AS c FROM action_items
           WHERE chat_profile_id IN (${profileIds.map(() => '?').join(',')})
             AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
           GROUP BY chat_profile_id`
        )
        .all(...profileIds, ...OPEN_STATUSES);
      for (const row of rows) openCounts.set(row.chat_profile_id, row.c);
    }

    const tags = [...new Set(contacts.flatMap((c) => c.tags))].sort();
    res.json({
      contacts: contacts.map((c) => ({ ...c, openActionItems: openCounts.get(c.id) || 0 })),
      count: contacts.length,
      tags,
    });
  });

  router.get('/contacts/import/template', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pulse-contacts-template.csv"');
    res.send(TEMPLATE_CSV);
  });

  // Step 1: upload + map + validate. Nothing is written.
  router.post('/contacts/import/preview', requireAuth, requireTeam, upload.single('file'), (req, res) => {
    try {
      const bot = importBot(req);
      const { csvText, filename } = readCsvInput(req);
      const result = analyzeImport(csvText, parseMapping(req.body?.mapping), botAccountService.getPhone(bot));
      return res.json({ ...result, filename, botId: bot.id, rows: result.rows.slice(0, 500) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // Step 2: write. Existing chats get tags/notes merged (never a second chat); invalid/duplicate rows are skipped.
  router.post('/contacts/import/commit', requireAuth, requireTeam, upload.single('file'), (req, res) => {
    try {
      const bot = importBot(req);
      const ownerPhone = botAccountService.getPhone(bot);
      const { csvText, filename } = readCsvInput(req);
      const { rows, summary } = analyzeImport(csvText, parseMapping(req.body?.mapping), ownerPhone);
      const updateExisting = String(req.body?.updateExisting ?? 'true') !== 'false';
      const aiSetting = req.body?.enableAi;
      const enableAi = aiSetting === undefined || aiSetting === '' ? bot.default_ai_on === 1 : String(aiSetting) === 'true';
      const source = `csv:${String(filename).slice(0, 80)}`;

      const result = { created: 0, updated: 0, skipped: 0, errors: [] };
      const db = getDatabase();
      db.transaction(() => {
        for (const row of rows) {
          if (row.status === 'invalid' || row.status === 'duplicate') {
            result.skipped += 1;
            result.errors.push({ rowNumber: row.rowNumber, error: row.error });
            continue;
          }
          if (row.status === 'existing') {
            if (!updateExisting) {
              result.skipped += 1;
              continue;
            }
            const existing = chatProfileService.findById(row.existingChatId);
            const tags = [...new Set([...conversationService.parseTags(existing?.tags), ...row.tags])];
            chatProfileService.updateContactDetails(row.existingChatId, {
              tags,
              contactNotes: row.notes ? [existing?.contact_notes, row.notes].filter(Boolean).join('\n') : undefined,
            });
            result.updated += 1;
            continue;
          }

          const profile = chatProfileService.getOrCreate({
            chatId: `${row.phone}@c.us`,
            ownerPhone,
            contactName: row.name || row.phone,
            contactPhone: row.phone,
            chatType: 'contact',
          });
          chatProfileService.updateContactDetails(profile.id, { tags: row.tags, contactNotes: row.notes || undefined });
          db.prepare('UPDATE chat_profiles SET import_source = ? WHERE id = ?').run(source, profile.id);
          if (enableAi) chatProfileService.enableAssistantExplicit(profile.id);
          else chatProfileService.disableAssistant(profile.id);
          result.created += 1;
        }
      })();

      auditLogService.record({
        actorUserId: req.dashboardUser.id,
        teamId: req.scope.teamId,
        action: 'contacts.import',
        targetType: 'bot',
        targetId: bot.id,
        meta: { filename, ...summary, created: result.created, updated: result.updated },
      });
      return res.json({ ...result, summary, errors: result.errors.slice(0, 200) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // CSV export of the filtered contact list.
  router.get('/contacts/export', requireAuth, requireTeam, (req, res) => {
    const ids = new Set(req.scope.botIds);
    const bots = req.scope.bots.filter((bot) => ids.has(bot.id));
    const contacts = conversationService.listForBots(bots, { search: req.query.search || '', tag: req.query.tag || '', limit: 5000 });
    const lines = ['name,phone,whatsapp_number,tags,ai_on,last_activity'];
    for (const c of contacts.filter((chat) => chat.chatType === 'contact')) {
      lines.push(
        [c.contactName, c.contactPhone, `${c.botName} (${c.botPhone})`, c.tags.join(';'), c.aiOn ? 'yes' : 'no', c.updatedAt]
          .map(csvCell)
          .join(',')
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pulse-contacts.csv"');
    res.send(lines.join('\n'));
  });

  return router;
}

module.exports = { createContactRouter };
