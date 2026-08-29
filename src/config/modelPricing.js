const MODEL_PRICING_USD_PER_MILLION = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-2024-08-06': { input: 2.5, output: 10 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'whisper-1': { input: 0, output: 0 },
};

const DEFAULT_PRICING = MODEL_PRICING_USD_PER_MILLION['gpt-4o-mini'];

function resolveModelPricing(model) {
  const key = String(model || '').trim().toLowerCase();
  if (!key) return DEFAULT_PRICING;
  if (MODEL_PRICING_USD_PER_MILLION[key]) return MODEL_PRICING_USD_PER_MILLION[key];
  if (key.includes('gpt-4o-mini')) return MODEL_PRICING_USD_PER_MILLION['gpt-4o-mini'];
  if (key.includes('gpt-4o')) return MODEL_PRICING_USD_PER_MILLION['gpt-4o'];
  return DEFAULT_PRICING;
}

function estimateCostUsd(model, promptTokens = 0, completionTokens = 0) {
  const pricing = resolveModelPricing(model);
  const prompt = Number(promptTokens) || 0;
  const completion = Number(completionTokens) || 0;
  const cost =
    (prompt * pricing.input + completion * pricing.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

module.exports = {
  MODEL_PRICING_USD_PER_MILLION,
  resolveModelPricing,
  estimateCostUsd,
};
