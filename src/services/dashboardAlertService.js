const { botAccountService } = require('./botAccountService');
const logger = require('../utils/logger');

const DEDUPE_MS = 5 * 60 * 1000;

class DashboardAlertService {
  constructor() {
    this.alerts = [];
    this.nextId = 1;
  }

  resolveRecipientUserIds(_teamId, botDashboardUserId = null) {
    const ids = new Set();
    if (botDashboardUserId) ids.add(Number(botDashboardUserId));
    return [...ids].filter(Boolean);
  }

  notifyNoApiKeyInbound({
    botAccountId,
    chatProfileId,
    contactName = 'Unknown contact',
    messagePreview = '',
  }) {
    const bot = botAccountService.findById(botAccountId);
    if (!bot) return [];

    const teamId = null;
    const recipientIds = this.resolveRecipientUserIds(teamId, bot.dashboard_user_id);
    if (!recipientIds.length) return [];

    const now = Date.now();
    const created = [];

    for (const dashboardUserId of recipientIds) {
      const recent = this.alerts.find(
        (alert) =>
          alert.dashboard_user_id === dashboardUserId
          && alert.type === 'no_api_key_message'
          && alert.chat_profile_id === chatProfileId
          && !alert.read
          && now - new Date(alert.created_at).getTime() < DEDUPE_MS
      );
      if (recent) {
        recent.body = String(messagePreview || '').slice(0, 180);
        recent.contact_name = contactName || recent.contact_name;
        created.push(recent);
        continue;
      }

      const alert = {
        id: this.nextId++,
        dashboard_user_id: dashboardUserId,
        team_id: teamId,
        bot_account_id: botAccountId,
        chat_profile_id: chatProfileId,
        type: 'no_api_key_message',
        title: 'Contact messaged — no API key',
        body: String(messagePreview || '').slice(0, 180),
        contact_name: contactName || 'Unknown contact',
        read: false,
        created_at: new Date().toISOString(),
      };
      this.alerts.unshift(alert);
      created.push(alert);
    }

    if (created.length) {
      logger.info(
        `Dashboard alert: no API key inbound (chat=${chatProfileId}, recipients=${recipientIds.join(',')})`
      );
    }

    return created;
  }

  notifyFirewallBlocked({
    botAccountId,
    chatProfileId,
    contactName = 'Unknown contact',
    messagePreview = '',
    reason = '',
  }) {
    const bot = botAccountService.findById(botAccountId);
    if (!bot) return [];

    const teamId = null;
    const recipientIds = this.resolveRecipientUserIds(teamId, bot.dashboard_user_id);
    if (!recipientIds.length) return [];

    const now = Date.now();
    const created = [];

    for (const dashboardUserId of recipientIds) {
      const recent = this.alerts.find(
        (alert) =>
          alert.dashboard_user_id === dashboardUserId
          && alert.type === 'firewall_blocked'
          && alert.chat_profile_id === chatProfileId
          && !alert.read
          && now - new Date(alert.created_at).getTime() < DEDUPE_MS
      );
      if (recent) {
        recent.body = String(messagePreview || '').slice(0, 180);
        recent.contact_name = contactName || recent.contact_name;
        recent.reason = reason || recent.reason;
        created.push(recent);
        continue;
      }

      const alert = {
        id: this.nextId++,
        dashboard_user_id: dashboardUserId,
        team_id: teamId,
        bot_account_id: botAccountId,
        chat_profile_id: chatProfileId,
        type: 'firewall_blocked',
        title: 'Out-of-scope message blocked',
        body: String(messagePreview || '').slice(0, 180),
        contact_name: contactName || 'Unknown contact',
        reason: String(reason || '').slice(0, 120),
        read: false,
        created_at: new Date().toISOString(),
      };
      this.alerts.unshift(alert);
      created.push(alert);
    }

    if (created.length) {
      logger.info(
        `Dashboard alert: firewall blocked (chat=${chatProfileId}, recipients=${recipientIds.join(',')})`
      );
    }

    return created;
  }

  notifyCtaCreated({
    botAccountId,
    actionItemId,
    chatProfileId,
    triggerMessageId = null,
    title,
    contactName = 'Unknown contact',
    assignedDashboardUserId = null,
  }) {
    const bot = botAccountService.findById(botAccountId);
    if (!bot) return [];

    const teamId = null;
    const recipientIds = new Set(this.resolveRecipientUserIds(teamId, bot.dashboard_user_id));
    if (assignedDashboardUserId) recipientIds.add(Number(assignedDashboardUserId));

    const created = [];
    for (const dashboardUserId of [...recipientIds].filter(Boolean)) {
      const alert = {
        id: this.nextId++,
        dashboard_user_id: dashboardUserId,
        team_id: teamId,
        bot_account_id: botAccountId,
        chat_profile_id: chatProfileId,
        action_item_id: actionItemId,
        trigger_message_id: triggerMessageId,
        type: 'cta_created',
        title: title || 'New Call to Action',
        body: contactName || 'Unknown contact',
        contact_name: contactName || 'Unknown contact',
        read: false,
        created_at: new Date().toISOString(),
      };
      this.alerts.unshift(alert);
      created.push(alert);
    }

    if (created.length) {
      logger.info(`Dashboard alert: CTA created (item=${actionItemId})`);
    }

    return created;
  }

  listForUser(dashboardUserId, { unreadOnly = false, limit = 50 } = {}) {
    return this.alerts
      .filter((alert) => {
        if (alert.dashboard_user_id !== dashboardUserId) return false;
        if (unreadOnly && alert.read) return false;
        return true;
      })
      .slice(0, limit);
  }

  unreadCount(dashboardUserId) {
    return this.alerts.filter((alert) => alert.dashboard_user_id === dashboardUserId && !alert.read)
      .length;
  }

  markRead(alertId, dashboardUserId) {
    const alert = this.alerts.find((row) => row.id === alertId && row.dashboard_user_id === dashboardUserId);
    if (!alert) return null;
    alert.read = true;
    return alert;
  }

  markAllRead(dashboardUserId) {
    let count = 0;
    for (const alert of this.alerts) {
      if (alert.dashboard_user_id === dashboardUserId && !alert.read) {
        alert.read = true;
        count += 1;
      }
    }
    return count;
  }
}

module.exports = {
  dashboardAlertService: new DashboardAlertService(),
};
