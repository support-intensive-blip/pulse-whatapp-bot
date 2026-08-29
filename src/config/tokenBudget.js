const { MODEL_TIERS } = require('./modelConfig');

// Override with KB_TOP_K in .env if needed.
const TOKEN_BUDGET = {
  kbTopK: 8,
  memorySummarize: false,
};

function getTierForTask(task, userTier = MODEL_TIERS.FAST) {
  const smartTasks = new Set(['pdf', 'manual_summary']);
  if (smartTasks.has(task) && userTier === MODEL_TIERS.SMART) {
    return MODEL_TIERS.SMART;
  }
  return MODEL_TIERS.FAST;
}

module.exports = {
  TOKEN_BUDGET,
  getTierForTask,
};
