const express = require('express');
const { getDatabase } = require('../database/db');
const { botAccountService } = require('../services/botAccountService');
const { OPEN_STATUSES } = require('../services/actionItemService');
const { requireAuth, requireTeam } = require('./middleware/auth');
const { normalizePhoneDigits } = require('../utils/helpers');

// Day buckets follow IST, the team's working day.
const IST = "'+330 minutes'";
const NOT_TEST = "cp.chat_id NOT LIKE '%@pulse.test'";

function inList(values) {
  return values.map(() => '?').join(',');
}

function dayRange(days) {
  const out = [];
  const now = new Date(Date.now() + 330 * 60 * 1000);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setUTCDate(now.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Analytics derived only from stored data: messages (role = user / assistant /
 * owner), chat_profiles and action_items. Metrics the backend doesn't record yet
 * (e.g. AI pause/handoff history) are reported in `unsupported`, not estimated.
 */
function buildAnalytics(bots, days) {
  const db = getDatabase();
  const phones = bots.map((bot) => normalizePhoneDigits(botAccountService.getPhone(bot))).filter(Boolean);
  const botIds = bots.map((bot) => bot.id);
  const range = dayRange(days);
  const since = range[0];
  const empty = () => Object.fromEntries(range.map((d) => [d, 0]));

  const series = {
    inbound: empty(),
    aiReplies: empty(),
    humanReplies: empty(),
    activeContacts: empty(),
    actionsCreated: empty(),
    actionsResolved: empty(),
  };

  if (phones.length) {
    const rows = db
      .prepare(
        `SELECT date(m.timestamp, ${IST}) AS day, m.role, COUNT(*) AS c, COUNT(DISTINCT m.chat_profile_id) AS contacts
         FROM messages m
         JOIN chat_profiles cp ON cp.id = m.chat_profile_id
         WHERE cp.owner_phone IN (${inList(phones)}) AND ${NOT_TEST}
           AND date(m.timestamp, ${IST}) >= ?
         GROUP BY day, m.role`
      )
      .all(...phones, since);
    for (const row of rows) {
      if (!(row.day in series.inbound)) continue;
      if (row.role === 'user') {
        series.inbound[row.day] += row.c;
        series.activeContacts[row.day] += row.contacts;
      } else if (row.role === 'assistant') {
        series.aiReplies[row.day] += row.c;
      } else if (row.role === 'owner') {
        series.humanReplies[row.day] += row.c;
      }
    }
  }

  let resolution = { resolvedCount: 0, avgHours: null };
  if (botIds.length) {
    for (const row of db
      .prepare(
        `SELECT date(triggered_at, ${IST}) AS day, COUNT(*) AS c FROM action_items
         WHERE bot_account_id IN (${inList(botIds)}) AND date(triggered_at, ${IST}) >= ?
         GROUP BY day`
      )
      .all(...botIds, since)) {
      if (row.day in series.actionsCreated) series.actionsCreated[row.day] = row.c;
    }
    for (const row of db
      .prepare(
        `SELECT date(completed_at, ${IST}) AS day, COUNT(*) AS c FROM action_items
         WHERE bot_account_id IN (${inList(botIds)}) AND status = 'resolved' AND completed_at IS NOT NULL
           AND date(completed_at, ${IST}) >= ?
         GROUP BY day`
      )
      .all(...botIds, since)) {
      if (row.day in series.actionsResolved) series.actionsResolved[row.day] = row.c;
    }
    const avg = db
      .prepare(
        `SELECT COUNT(*) AS n, AVG((julianday(completed_at) - julianday(triggered_at)) * 24) AS hours
         FROM action_items
         WHERE bot_account_id IN (${inList(botIds)}) AND status = 'resolved' AND completed_at IS NOT NULL
           AND date(completed_at, ${IST}) >= ?`
      )
      .get(...botIds, since);
    resolution = { resolvedCount: avg.n, avgHours: avg.hours == null ? null : Math.round(avg.hours * 10) / 10 };
  }

  const perNumber = bots.map((bot) => {
    const phone = normalizePhoneDigits(botAccountService.getPhone(bot));
    const chats = phone
      ? db
          .prepare(
            `SELECT COUNT(*) AS total, SUM(CASE WHEN assistant_active = 1 THEN 1 ELSE 0 END) AS aiOn
             FROM chat_profiles cp WHERE owner_phone = ? AND chat_type = 'contact' AND ${NOT_TEST}`
          )
          .get(phone)
      : { total: 0, aiOn: 0 };
    const msgs = phone
      ? db
          .prepare(
            `SELECT m.role, COUNT(*) AS c FROM messages m JOIN chat_profiles cp ON cp.id = m.chat_profile_id
             WHERE cp.owner_phone = ? AND ${NOT_TEST} AND date(m.timestamp, ${IST}) >= ?
             GROUP BY m.role`
          )
          .all(phone, since)
      : [];
    const byRole = Object.fromEntries(msgs.map((row) => [row.role, row.c]));
    const openActions = db
      .prepare(`SELECT COUNT(*) AS c FROM action_items WHERE bot_account_id = ? AND status IN (${inList(OPEN_STATUSES)})`)
      .get(bot.id, ...OPEN_STATUSES).c;
    return {
      botId: bot.id,
      botName: bot.name,
      phone,
      aiStatus: bot.ai_status,
      conversations: chats.total || 0,
      chatsWithAiOff: (chats.total || 0) - (chats.aiOn || 0),
      inbound: byRole.user || 0,
      aiReplies: byRole.assistant || 0,
      humanReplies: byRole.owner || 0,
      openActions,
    };
  });

  const toSeries = (obj) => range.map((day) => ({ day, value: obj[day] }));
  const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
  return {
    days,
    range: { from: range[0], to: range[range.length - 1] },
    totals: {
      inbound: sum(series.inbound),
      aiReplies: sum(series.aiReplies),
      humanReplies: sum(series.humanReplies),
      actionsCreated: sum(series.actionsCreated),
      actionsResolved: sum(series.actionsResolved),
      avgResolutionHours: resolution.avgHours,
      chatsWithAiOff: perNumber.reduce((a, row) => a + row.chatsWithAiOff, 0),
    },
    series: Object.fromEntries(Object.entries(series).map(([key, value]) => [key, toSeries(value)])),
    perNumber,
    unsupported: [
      { metric: 'AI pause / handoff frequency', reason: 'AI on/off changes are not logged yet — only the current state per chat is known.' },
      { metric: 'Response time', reason: 'Not tracked yet.' },
    ],
  };
}

function createAnalyticsRouter() {
  const router = express.Router();

  router.get('/analytics', requireAuth, requireTeam, (req, res) => {
    const days = Math.max(7, Math.min(parseInt(req.query.days, 10) || 14, 90));
    const ids = new Set(req.scope.botIds);
    res.json(buildAnalytics(req.scope.bots.filter((bot) => ids.has(bot.id)), days));
  });

  return router;
}

module.exports = { createAnalyticsRouter };
