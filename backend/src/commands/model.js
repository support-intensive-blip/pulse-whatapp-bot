const userService = require('../services/userService');
const { MODEL_TIERS, formatModelLabel } = require('../config/modelConfig');

function execute(userId, args) {
  const mode = args?.trim().toLowerCase();

  if (mode === MODEL_TIERS.FAST) {
    userService.setChatModelTier(userId, MODEL_TIERS.FAST);
    return `Chat model set to *fast* — ${formatModelLabel(MODEL_TIERS.FAST)}.\nCost-efficient default for routine replies.`;
  }

  if (mode === MODEL_TIERS.SMART) {
    userService.setChatModelTier(userId, MODEL_TIERS.SMART);
    return `Chat model set to *smart* — ${formatModelLabel(MODEL_TIERS.SMART)}.\nHigher-quality model — switch back with /model fast to save cost.`;
  }

  const tier = userService.getChatModelTier(userId);
  return [
    `*Model Settings*`,
    `Current: ${formatModelLabel(tier)}`,
    `Default is fast (gpt-4o-mini) to save cost.`,
    '',
    '/model fast — routine + KB answers (recommended)',
    '/model smart — larger model for all replies',
  ].join('\n');
}

module.exports = { execute };
