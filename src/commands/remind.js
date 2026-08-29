const reminderService = require('../services/reminderService');

function execute(userId, args) {
  if (!args || !args.trim()) {
    return 'Usage: /remind YYYY-MM-DD HH:MM Your reminder message\nExample: /remind 2026-06-10 06:00 Wake up and meditate';
  }

  const match = args.trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/);

  if (!match) {
    return 'Invalid format. Use: /remind YYYY-MM-DD HH:MM Your message';
  }

  const [, dateStr, timeStr, message] = match;
  const result = reminderService.createReminder(userId, dateStr, timeStr, message);

  if (result.error) {
    return result.error;
  }

  return result.confirmation;
}

module.exports = { execute };
