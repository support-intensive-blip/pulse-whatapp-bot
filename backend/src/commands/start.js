const chatProfileService = require('../services/chatProfileService');

function execute(chatProfileId) {
  const profile = chatProfileService.resumeAssistant(chatProfileId);
  const contact = profile?.contact_name || 'this contact';

  return `Assistant is now *active* in ${contact} chat.`;
}

module.exports = { execute };
