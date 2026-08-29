const { Pinecone } = require('@pinecone-database/pinecone');
const logger = require('../utils/logger');
const { withRetry, isTransientUpstreamError } = require('../utils/helpers');

const EMBED_MODEL = process.env.PINECONE_EMBED_MODEL || 'multilingual-e5-large';
const EMBED_FIELD = process.env.PINECONE_EMBED_FIELD || 'chunk_text';
// Field-map source key for integrated search inputs (maps to EMBED_FIELD on the index).
const EMBED_INPUT_KEY = process.env.PINECONE_EMBED_INPUT_KEY || 'text';
const WRITE_INPUT_TYPE = process.env.PINECONE_WRITE_INPUT_TYPE || 'passage';
const READ_INPUT_TYPE = process.env.PINECONE_READ_INPUT_TYPE || 'query';
const EMBED_TRUNCATE = (process.env.PINECONE_EMBED_TRUNCATE || 'END').toUpperCase();
const MAX_EMBED_INPUT_TOKENS = Number(process.env.PINECONE_MAX_INPUT_TOKENS) || 507;
const EMBED_DIMENSIONS = Number(process.env.PINECONE_EMBED_DIMENSIONS) || 1024;
const VECTOR_METRIC = (process.env.PINECONE_METRIC || 'cosine').toLowerCase();
const EMBED_CACHE_SIZE = 512;
const META_RECORD_ID = '__kb_meta__';

let pineconeClient = null;
let pineconeIndex = null;
const embedCache = new Map();

function isEnabled() {
  return Boolean(process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX);
}

function useIntegratedIndex() {
  return isEnabled() && process.env.PINECONE_INTEGRATED !== 'false';
}

function getClient() {
  if (!isEnabled()) {
    throw new Error('Pinecone is not configured (PINECONE_API_KEY and PINECONE_INDEX required)');
  }
  if (!pineconeClient) {
    pineconeClient = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return pineconeClient;
}

function getIndex() {
  if (!pineconeIndex) {
    assertVectorMetric();
    const pc = getClient();
    const indexName = process.env.PINECONE_INDEX;
    pineconeIndex = process.env.PINECONE_HOST
      ? pc.index(indexName, process.env.PINECONE_HOST)
      : pc.index(indexName);
  }
  return pineconeIndex;
}

/**
 * "passage: " / "query: " literal text prefixes are an e5-family training
 * convention (multilingual-e5-large expects them baked into the input text).
 * Other hosted models (e.g. llama-text-embed-v2) take input_type as an API
 * parameter instead — prefixing their text would embed junk tokens and hurt
 * retrieval quality, so this only applies for e5 models.
 */
function usesE5TextPrefix() {
  return /e5/i.test(EMBED_MODEL);
}

/** multilingual-e5-large expects passage: on indexed text. */
function formatPassageText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (!usesE5TextPrefix()) return trimmed;
  return /^passage:\s/i.test(trimmed) ? trimmed : `passage: ${trimmed}`;
}

/** multilingual-e5-large expects query: on search queries. */
function formatQueryText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (!usesE5TextPrefix()) return trimmed;
  return /^query:\s/i.test(trimmed) ? trimmed : `query: ${trimmed}`;
}

function normalizeEmbeddingVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;

  let values = vector.slice();
  if (values.length > EMBED_DIMENSIONS) {
    values = values.slice(0, EMBED_DIMENSIONS);
  } else if (values.length < EMBED_DIMENSIONS) {
    values = values.concat(new Array(EMBED_DIMENSIONS - values.length).fill(0));
  }

  let norm = 0;
  for (let i = 0; i < values.length; i += 1) {
    norm += values[i] * values[i];
  }
  norm = Math.sqrt(norm) || 1;
  return values.map((v) => v / norm);
}

function assertVectorMetric() {
  if (VECTOR_METRIC !== 'cosine') {
    logger.warn(`PINECONE_METRIC=${VECTOR_METRIC}; cosine is recommended for ${EMBED_MODEL}`);
  }
}

function cacheKey(text, inputType) {
  return `${inputType}:${text}`;
}

function readEmbedCache(text, inputType) {
  const key = cacheKey(text, inputType);
  if (!embedCache.has(key)) return null;
  const value = embedCache.get(key);
  embedCache.delete(key);
  embedCache.set(key, value);
  return value;
}

function writeEmbedCache(text, inputType, vector) {
  const key = cacheKey(text, inputType);
  if (embedCache.size >= EMBED_CACHE_SIZE) {
    const oldest = embedCache.keys().next().value;
    embedCache.delete(oldest);
  }
  embedCache.set(key, vector);
}

function embedParameters(inputType) {
  return {
    input_type: inputType,
    truncate: EMBED_TRUNCATE,
  };
}

function prepareEmbedInput(text, inputType) {
  if (inputType === READ_INPUT_TYPE || inputType === 'query') {
    return formatQueryText(text);
  }
  return formatPassageText(text);
}

async function embedTexts(texts, { inputType = WRITE_INPUT_TYPE } = {}) {
  if (!texts.length) return [];

  const prepared = texts.map((text) => prepareEmbedInput(text, inputType));
  const results = new Array(texts.length);
  const missing = [];

  prepared.forEach((text, index) => {
    const cached = readEmbedCache(text, inputType);
    if (cached) {
      results[index] = cached;
    } else {
      missing.push({ text, index });
    }
  });

  if (missing.length > 0) {
    const pc = getClient();
    // Hosted embedding models cap tokens-PER-MINUTE independent of any monthly
    // quota; a short backoff can't outlast that window, so retries wait long
    // enough to clear it instead of failing the whole batch immediately.
    const response = await withRetry(
      () =>
        pc.inference.embed({
          model: EMBED_MODEL,
          inputs: missing.map((item) => item.text),
          parameters: embedParameters(inputType),
        }),
      {
        attempts: 4,
        baseDelayMs: Number(process.env.PINECONE_RATE_LIMIT_RETRY_BASE_MS) || 20000,
        shouldRetry: isTransientUpstreamError,
        label: 'Pinecone embed',
      }
    );

    const vectors = response.data || [];
    missing.forEach((item, i) => {
      const raw = vectors[i]?.values || vectors[i]?.denseValues || [];
      const values = normalizeEmbeddingVector(raw);
      if (raw.length && raw.length !== EMBED_DIMENSIONS) {
        logger.warn(
          `Embedding dimension ${raw.length} != ${EMBED_DIMENSIONS}; normalized for Pinecone`
        );
      }
      results[item.index] = values;
      writeEmbedCache(item.text, inputType, values);
    });
  }

  return results;
}

async function embedQuery(text) {
  const vectors = await embedTexts([text], { inputType: READ_INPUT_TYPE });
  return vectors[0] || null;
}

module.exports = {
  isEnabled,
  useIntegratedIndex,
  getClient,
  getIndex,
  embedTexts,
  embedQuery,
  formatPassageText,
  formatQueryText,
  prepareEmbedInput,
  normalizeEmbeddingVector,
  EMBED_MODEL,
  EMBED_FIELD,
  EMBED_INPUT_KEY,
  WRITE_INPUT_TYPE,
  READ_INPUT_TYPE,
  EMBED_TRUNCATE,
  MAX_EMBED_INPUT_TOKENS,
  EMBED_DIMENSIONS,
  VECTOR_METRIC,
  META_RECORD_ID,
};
