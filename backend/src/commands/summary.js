const chatService = require('../services/chatService');
const chatProfileService = require('../services/chatProfileService');

async function execute(chatProfileId) {
  const profile = chatProfileService.findById(chatProfileId);
  const summary = await chatService.generateSummary(chatProfileId);
  const contact = profile?.contact_name || 'this chat';
  return `*Conversation Summary — ${contact}*\n\n${summary}`;
}

module.exports = { execute };
