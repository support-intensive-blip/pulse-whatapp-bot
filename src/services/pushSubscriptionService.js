const { getDatabase } = require('../database/db');

class PushSubscriptionService {
  upsert({ dashboardUserId, subscription, userAgent = null }) {
    if (!dashboardUserId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return null;
    }
    const db = getDatabase();
    db.prepare(
      `INSERT INTO push_subscriptions (dashboard_user_id, endpoint, p256dh, auth, user_agent)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         dashboard_user_id = excluded.dashboard_user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent`
    ).run(
      dashboardUserId,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      userAgent
    );

    const row = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(subscription.endpoint);
    if (row?.id) {
      try {
        const { flushSyncToBigQuery } = require('../database/bqSync');
        flushSyncToBigQuery(db, 'push_subscriptions', 'id', row.id);
      } catch (error) {
        // best-effort sync
      }
    }

    return this.listByUserIds([dashboardUserId]);
  }

  removeByEndpoint(endpoint) {
    if (!endpoint) return 0;
    const db = getDatabase();
    const row = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
    const result = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    if (row?.id) {
      try {
        const { flushSyncToBigQuery } = require('../database/bqSync');
        flushSyncToBigQuery(db, 'push_subscriptions', 'id', row.id);
      } catch (error) {
        // best-effort sync
      }
    }
    return result.changes;
  }

  listByUserIds(userIds = []) {
    const ids = [...new Set((userIds || []).map((id) => Number(id)).filter(Boolean))];
    if (!ids.length) return [];
    const db = getDatabase();
    const placeholders = ids.map(() => '?').join(',');
    return db
      .prepare(
        `SELECT id, dashboard_user_id, endpoint, p256dh, auth
         FROM push_subscriptions
         WHERE dashboard_user_id IN (${placeholders})`
      )
      .all(...ids);
  }
}

module.exports = {
  pushSubscriptionService: new PushSubscriptionService(),
};
