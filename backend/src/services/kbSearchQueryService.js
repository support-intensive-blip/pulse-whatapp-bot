const { getGroqClient } = require('../ai/groqClient');
const {
  MODEL_TIERS,
  getTranslationTemperature,
  resolveChatModel,
} = require('../config/modelConfig');
const { TOKEN_CATEGORIES } = require('../config/tokenCategories');
const logger = require('../utils/logger');

const TRANSLATION_ENABLED = String(process.env.KB_TRANSLATE_SEARCH_QUERY ?? 'true').toLowerCase() !== 'false';

const INDIC_SCRIPT =
  /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/;

const ROMANIZED_HINTS =
  /\b(eppudu|ela|emi|enduku|cheppu|cheppandi|naku|meeru|gurinchi|enti|avutundi|avutha|undha|ledha|kaise|kya|kyun|kyu|hai|hain|nahi|nahin|karna|chahiye|mujhe|aap|batao|bataiye|sertifikat|placements?|cheyali|cheyyali|telusu|teliyali)\b/i;

const ENGLISH_HINTS =
  /\b(what|how|when|where|why|who|which|can|could|should|would|is|are|was|were|the|my|your|certificate|placement|course|exam|eligible|deadline|schedule)\b/i;

const translationCache = new Map();
const CACHE_MAX = 500;

function isEnabled() {
  return TRANSLATION_ENABLED;
}

function needsEnglishTranslation(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  if (INDIC_SCRIPT.test(trimmed)) return true;
  if (ROMANIZED_HINTS.test(trimmed)) return true;

  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;

  const englishHits = words.filter((word) => ENGLISH_HINTS.test(word)).length;
  if (englishHits === 0 && words.length >= 2) return true;
  if (words.length >= 4 && englishHits / words.length < 0.2) return true;

  return false;
}

function cacheGet(key) {
  return translationCache.get(key) || null;
}

function cacheSet(key, value) {
  if (translationCache.size >= CACHE_MAX) {
    const firstKey = translationCache.keys().next().value;
    if (firstKey) translationCache.delete(firstKey);
  }
  translationCache.set(key, value);
}

async function toEnglishKbSearchQuery(query, { apiKey, usageContext } = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed || !apiKey || !isEnabled()) return trimmed;
  if (!needsEnglishTranslation(trimmed)) return trimmed;

  const cacheKey = trimmed.toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const groq = getGroqClient(apiKey);
    const translateModel =
      process.env.KB_TRANSLATE_MODEL || resolveChatModel(MODEL_TIERS.SMART);
    const response = await groq.chat(
      [
        {
          role: 'system',
          content: [
            'You convert user messages into exact, natural English search queries for an English knowledge base.',
            'Rules:',
            '- If the text is already clear English, return it unchanged (light cleanup only).',
            '- Accurately convert Tenglish (romanized Telugu), Telugu script, Hindi, Hinglish, and mixed Indian languages into precise English.',
            '- Preserve meaning exactly — do not add, drop, or invent intent.',
            '- Preserve domain-specific terms, abbreviations, proper nouns, and product names as-is — do not translate or expand them.',
            '- Keep only the search intent; no explanations or quotes.',
            '- Output ONLY the English query text.',
          ].join('\n'),
        },
        { role: 'user', content: trimmed },
      ],
      {
        model: translateModel,
        temperature: getTranslationTemperature(),
        maxTokens: 160,
        tier: MODEL_TIERS.SMART,
        usageContext: {
          ...usageContext,
          category: TOKEN_CATEGORIES.KB,
        },
      }
    );

    const translated = String(response || '').trim().replace(/^["']|["']$/g, '');
    const result = translated || trimmed;
    if (result !== trimmed) {
      logger.info(`KB search query translated: "${trimmed.slice(0, 60)}" -> "${result.slice(0, 60)}"`);
    }
    cacheSet(cacheKey, result);
    return result;
  } catch (error) {
    logger.warn(`KB search query translation failed: ${error.message}`);
    return trimmed;
  }
}

module.exports = {
  isEnabled,
  needsEnglishTranslation,
  toEnglishKbSearchQuery,
};
