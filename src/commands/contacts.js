const chatProfileService = require('../services/chatProfileService');
const userService = require('../services/userService');

function execute(ownerUserId) {
  const owner = userService.findById(ownerUserId);
  const profiles = chatProfileService.getByOwner(owner.phone);
  return chatProfileService.formatContactsList(profiles);
}

module.exports = { execute };
