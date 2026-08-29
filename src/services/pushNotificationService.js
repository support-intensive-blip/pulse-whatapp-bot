const webpush = require('web-push');
const logger = require('../utils/logger');

let vapidKeys = null;

function ensureVapidKeys() {
  if (vapidKeys) return vapidKeys;
  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY;
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY;
  if (publicKey && privateKey) {
    vapidKeys = { publicKey, privateKey };
  } else {
    vapidKeys = webpush.generateVAPIDKeys();
    logger.warn(
      'WEB_PUSH_PUBLIC_KEY/WEB_PUSH_PRIVATE_KEY not set; generated ephemeral VAPID keys for this process'
    );
  }

  const subject = process.env.WEB_PUSH_SUBJECT || 'mailto:admin@nxtwave.pulse';
  webpush.setVapidDetails(subject, vapidKeys.publicKey, vapidKeys.privateKey);
  return vapidKeys;
}

class PushNotificationService {
  getPublicKey() {
    return ensureVapidKeys().publicKey;
  }

  async sendToSubscriptions(subscriptions = [], payload = {}) {
    if (!subscriptions.length) return { sent: 0, removed: 0 };
    ensureVapidKeys();
    const { pushSubscriptionService } = require('./pushSubscriptionService');

    const body = JSON.stringify(payload);
    let sent = 0;
    let removed = 0;

    for (const sub of subscriptions) {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        await webpush.sendNotification(subscription, body, {
          TTL: 60,
          urgency: 'high',
        });
        sent += 1;
      } catch (error) {
        const statusCode = Number(error?.statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          pushSubscriptionService.removeByEndpoint(sub.endpoint);
          removed += 1;
        } else {
          logger.warn(`Push send failed: ${error.message}`);
        }
      }
    }

    return { sent, removed };
  }
}

module.exports = {
  pushNotificationService: new PushNotificationService(),
};
