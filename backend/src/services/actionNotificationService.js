const botManager = require('../bot/botManager');
const { botAccountService } = require('./botAccountService');
const { dashboardUserService } = require('./dashboardUserService');
const logger = require('../utils/logger');
const { pushSubscriptionService } = require('./pushSubscriptionService');
const { pushNotificationService } = require('./pushNotificationService');

class ActionNotificationService {
  parseConfiguredNumbers(raw) {
    return [...new Set(
      String(raw || '')
        .split(/\r?\n|,/)
        .map((v) => String(v || '').replace(/\D/g, ''))
        .filter((v) => v.length >= 10)
    )];
  }

  formatWhatsappMessage(actionItem) {
    const lines = [
      'Pulse Action Alert',
      `Category: ${actionItem.category || 'general'}`,
      `Priority: ${actionItem.priority || 'normal'}`,
      `Title: ${actionItem.title}`,
      `Student: ${actionItem.contact_name || 'Unknown'}`,
    ];

    if (actionItem.contact_phone) {
      lines.push(`Student Phone: ${actionItem.contact_phone}`);
    }
    if (actionItem.description) {
      lines.push(`Details: ${String(actionItem.description).slice(0, 180)}`);
    }
    if (actionItem.chat_profile_id) {
      lines.push(`Open Chat: /conversations/${actionItem.chat_profile_id}`);
    }

    return lines.join('\n');
  }

  async sendWhatsAppAlerts(actionItem) {
    if (!actionItem?.assigned_dashboard_user_id) return false;

    const coach = dashboardUserService.findById(actionItem.assigned_dashboard_user_id);
    const coachPhone = coach?.coach_phone;
    const userAlertPhones = this.parseConfiguredNumbers(coach?.action_alert_phones);

    // Sent from the number the item belongs to (24h-window rules still apply).
    const adminBot = botManager.getBot(actionItem.bot_account_id);
    if (!adminBot?.isReady) return false;

    const recipients = [...new Set([coachPhone, ...userAlertPhones].filter(Boolean))];
    if (!recipients.length) return false;

    try {
      for (const phone of recipients) {
        await adminBot.sendMessage(`${phone}@c.us`, this.formatWhatsappMessage(actionItem));
      }
      logger.info(`WhatsApp action notification sent for action ${actionItem.id}`);
      return true;
    } catch (error) {
      logger.warn(`WhatsApp action notification failed for action ${actionItem.id}: ${error.message}`);
      return false;
    }
  }

  // The assignee plus the item's team admins — never users of other teams.
  resolvePushRecipientUserIds(actionItem) {
    const ids = new Set();
    if (actionItem?.assigned_dashboard_user_id) {
      ids.add(Number(actionItem.assigned_dashboard_user_id));
    }

    const bot = botAccountService.findById(actionItem?.bot_account_id);
    const { dashboardAlertService } = require('./dashboardAlertService');
    for (const id of dashboardAlertService.resolveRecipientUserIds(bot)) {
      ids.add(id);
    }

    return [...ids];
  }

  async sendPushAlerts(actionItem) {
    const userIds = this.resolvePushRecipientUserIds(actionItem);
    if (!userIds.length) return false;
    const subscriptions = pushSubscriptionService.listByUserIds(userIds);
    if (!subscriptions.length) return false;

    const payload = {
      title: 'Pulse Action Alert',
      body: `${actionItem.title} · ${actionItem.contact_name || 'Unknown contact'}`,
      chatProfileId: actionItem.chat_profile_id || null,
      actionItemId: actionItem.id,
      url: actionItem.chat_profile_id
        ? `/conversations/${actionItem.chat_profile_id}${
            actionItem.trigger_message_id ? `?msg=${actionItem.trigger_message_id}` : ''
          }`
        : '/actions',
    };
    await pushNotificationService.sendToSubscriptions(subscriptions, payload);
    logger.info(
      `Push alerts sent for action ${actionItem.id} to ${subscriptions.length} subscription(s)`
    );
    return true;
  }

  async notifyCoach(actionItem) {
    await Promise.allSettled([
      this.sendWhatsAppAlerts(actionItem),
      this.sendPushAlerts(actionItem),
    ]);
    return true;
  }
}

module.exports = {
  actionNotificationService: new ActionNotificationService(),
};
