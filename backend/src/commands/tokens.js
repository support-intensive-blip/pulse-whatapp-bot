const { tokenUsageService } = require('../services/tokenUsageService');
const chatProfileService = require('../services/chatProfileService');
const userService = require('../services/userService');

function execute(ownerUserId, chatProfileId, args, isSelfChat) {
  const query = args?.trim();

  if (!isSelfChat) {
    return tokenUsageService.formatChatReport(chatProfileId, ownerUserId);
  }

  if (query) {
    const owner = userService.findById(ownerUserId);
    const match = owner?.phone
      ? chatProfileService.findByContactName(owner.phone, query)
      : null;
    if (!match) {
      return `No chat found matching "${query}". Use /tokens to see all chats.`;
    }
    return tokenUsageService.formatChatReport(match.id, ownerUserId);
  }

  const owner = userService.findById(ownerUserId);
  return tokenUsageService.formatBotReport(ownerUserId, owner?.phone || null);
}

module.exports = { execute };
