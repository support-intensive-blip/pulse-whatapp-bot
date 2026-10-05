const chatProfileService = require('../services/chatProfileService');
const { ASSISTANT_PAUSE_MS } = require('../utils/constants');

function execute(chatProfileId) {
  const profile = chatProfileService.pauseAssistant(chatProfileId, ASSISTANT_PAUSE_MS);
  const minutes = ASSISTANT_PAUSE_MS / 60000;
  const contact = profile?.contact_name || 'this contact';

  return `Assistant paused in *${contact}* chat for ${minutes} minutes.\n\nSend /start to resume sooner.`;
}

module.exports = { execute };
