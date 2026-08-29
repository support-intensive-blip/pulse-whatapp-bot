const MODEL_TIERS = {
  FAST: 'fast',
  SMART: 'smart',
};

function getFastModel() {
  return process.env.OPENAI_MODEL_FAST || 'gpt-4o-mini';
}

function getSmartModel() {
  return (
    process.env.OPENAI_MODEL_SMART ||
    process.env.OPENAI_MODEL ||
    'gpt-4o-mini'
  );
}

function resolveChatModel(tier) {
  return tier === MODEL_TIERS.SMART ? getSmartModel() : getFastModel();
}

function formatModelLabel(tier) {
  const model = resolveChatModel(tier);
  const label = tier === MODEL_TIERS.SMART ? 'Smart' : 'Fast';
  return `${label} (${model})`;
}

function getChatTemperature() {
  const val = Number(process.env.CHAT_TEMPERATURE);
  return Number.isFinite(val) ? val : 0.2;
}

/** Used when no KB chunks were retrieved for the reply. */
function getNoKbTemperature() {
  const val = Number(process.env.NO_KB_TEMPERATURE);
  return Number.isFinite(val) ? val : 0.8;
}

/** Temperature for Tenglish / Indic → English KB query conversion only. */
function getTranslationTemperature() {
  const val = Number(process.env.KB_TRANSLATE_TEMPERATURE);
  return Number.isFinite(val) ? val : 0.4;
}

module.exports = {
  MODEL_TIERS,
  getFastModel,
  getSmartModel,
  resolveChatModel,
  formatModelLabel,
  getChatTemperature,
  getNoKbTemperature,
  getTranslationTemperature,
};
