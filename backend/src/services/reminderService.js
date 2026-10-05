const { getDatabase } = require('../database/db');
const logger = require('../utils/logger');
const { parseReminderDateTime, formatReminderTime } = require('../utils/helpers');

class ReminderService {
  createReminder(userId, dateStr, timeStr, message) {
    const scheduledTime = parseReminderDateTime(dateStr, timeStr);

    if (!scheduledTime) {
      return { error: 'Invalid date or time. Use format: /remind YYYY-MM-DD HH:MM Your message' };
    }

    if (scheduledTime <= new Date()) {
      return { error: 'Reminder time must be in the future.' };
    }

    const db = getDatabase();
    const result = db
      .prepare(
        'INSERT INTO reminders (user_id, message, scheduled_time) VALUES (?, ?, ?)'
      )
      .run(userId, message, scheduledTime.toISOString());

    const reminder = this.findById(result.lastInsertRowid);
    logger.info(`Reminder created for user ${userId} at ${scheduledTime.toISOString()}`);

    return {
      reminder,
      confirmation: `Reminder set for ${formatReminderTime(scheduledTime)}:\n"${message}"`,
    };
  }

  findById(id) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) || null;
  }

  getPendingReminders() {
    const db = getDatabase();
    const now = new Date().toISOString();
    return db
      .prepare(
        `SELECT r.*, u.phone
         FROM reminders r
         JOIN users u ON r.user_id = u.id
         WHERE r.sent = 0 AND r.scheduled_time <= ?`
      )
      .all(now);
  }

  getAll() {
    const db = getDatabase();
    return db
      .prepare(
        `SELECT r.*, u.phone, u.name
         FROM reminders r
         JOIN users u ON r.user_id = u.id
         ORDER BY r.scheduled_time ASC`
      )
      .all();
  }

  markAsSent(id) {
    const db = getDatabase();
    db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(id);
    logger.info(`Reminder ${id} marked as sent`);
  }

  getCount() {
    const db = getDatabase();
    const result = db.prepare('SELECT COUNT(*) as count FROM reminders').get();
    return result.count;
  }
}

module.exports = new ReminderService();
