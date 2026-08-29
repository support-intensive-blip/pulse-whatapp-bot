const { conversationSlotsService } = require('../services/conversationSlotsService');

function execute(chatProfileId) {
  conversationSlotsService.clearSlots(chatProfileId);
  return 'Conversation context has been reset.';
}

module.exports = { execute };
