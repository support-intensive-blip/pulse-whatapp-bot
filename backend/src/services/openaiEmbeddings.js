const OpenAI = require('openai');
const { withRetry, isTransientUpstreamError } = require('../utils/helpers');

/**
 * OpenAI embeddings for the Supabase (pgvector) KB store. Passages and queries use
 * the same model; the model + dimensions are recorded with each index so changing
 * either forces a re-embed instead of mixing incompatible vectors.
 */

const EMBED_MODEL = process.env.KB_EMBED_MODEL || 'text-embedding-3-small';
const EMBED_DIMENSIONS = Number(process.env.KB_EMBED_DIMENSIONS) || 1536;
const BATCH_SIZE = Number(process.env.KB_EMBED_BATCH_SIZE) || 100;
// ~8k-token input cap per item; chunks are far smaller, this only guards odd input.
const MAX_INPUT_CHARS = 24000;
const QUERY_CACHE_LIMIT = 500;

let client = null;
const queryCache = new Map();

function getClient() {
  if (client) return client;
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for KB embeddings');
  client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function prepare(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return (t || ' ').slice(0, MAX_INPUT_CHARS);
}

async function embedBatch(texts) {
  const request = { model: EMBED_MODEL, input: texts.map(prepare) };
  // Only text-embedding-3-* accept `dimensions`; at their native size it is a no-op.
  if (EMBED_MODEL.startsWith('text-embedding-3')) request.dimensions = EMBED_DIMENSIONS;
  const response = await withRetry(() => getClient().embeddings.create(request), {
    attempts: 5,
    baseDelayMs: 1500,
    shouldRetry: isTransientUpstreamError,
    label: `OpenAI embeddings (${texts.length})`,
  });
  return response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

async function embedPassages(texts, onProgress = null) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    vectors.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE))));
    onProgress?.(Math.min(i + BATCH_SIZE, texts.length), texts.length);
  }
  return vectors;
}

/** A turn runs up to three searches on overlapping queries — cache to avoid re-embedding. */
async function embedQuery(text) {
  const key = prepare(text);
  if (queryCache.has(key)) return queryCache.get(key);
  const [vector] = await embedBatch([key]);
  if (queryCache.size >= QUERY_CACHE_LIMIT) queryCache.delete(queryCache.keys().next().value);
  queryCache.set(key, vector);
  return vector;
}

module.exports = { EMBED_MODEL, EMBED_DIMENSIONS, embedPassages, embedQuery };
