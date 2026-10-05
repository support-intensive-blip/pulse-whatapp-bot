const userService = require('../services/userService');

function execute() {
  return userService.formatAssistantInfo();
}

module.exports = { execute };
