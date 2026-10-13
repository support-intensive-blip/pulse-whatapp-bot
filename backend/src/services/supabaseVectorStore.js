const crypto = require('crypto');
const logger = require('../utils/logger');
const kbSemanticChunker = require('./kbSemanticChunker');
const kbIndexRecords = require('./kbIndexRecords');
const embeddings = require('./openaiEmbeddings');

/**
 * KB vector store on Supabase Postgres + pgvector (VECTOR_BACKEND=supabase).
 *
 * One namespace per index ("bot_3", or "global"), each with a pointer row in
 * kb_vector_indexes naming its live generation. A re-index inserts a brand-new
 * generation, then flips the pointer and drops the old rows in one transaction —
 * bots keep answering from the previous index until the new one is complete, and
 * a failed embed/insert never leaves a namespace empty.
 *
 * Search is an exact cosine scan inside one namespace (a few thousand rows per bot).
 * Deliberately no HNSW index: an ANN index post-filters by namespace and can return
 * fewer than topK rows; add one only if a single KB grows past ~100k vectors.
 *
 * Needs SUPABASE_DB_URL (Session pooler URI). Tables are created on first use.
 */

const INSERT_BATCH = 50;
const META_CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_SEARCH_SCORE = Number(process.env.KB_MIN_SEARCH_SCORE) || 0;

const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.kb_vector_indexes (
  namespace text PRIMARY KEY,
  generation text NOT NULL,
  source_hash text NOT NULL,
  chunk_count integer NOT NULL DEFAULT 0,
  entry_count integer NOT NULL DEFAULT 0,
  embed_model text NOT NULL,
  dimensions integer NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kb_vector_chunks (
  id bigserial PRIMARY KEY,
  namespace text NOT NULL,
  generation text NOT NULL,
  record_id text NOT NULL,
  record_type text NOT NULL DEFAULT 'chunk',
  chunk_index integer,
  version text,
  question_id text,
  tags text,
  answer_text text NOT NULL,
  embed_text text NOT NULL,
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_vector_chunks_ns_gen
  ON public.kb_vector_chunks (namespace, generation);

-- RLS on with no policies: only the server's own connection can read or write.
ALTER TABLE public.kb_vector_indexes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_vector_chunks ENABLE ROW LEVEL SECURITY;
`;

let pool = null;
let schemaReady = null;
const metaCache = new Map();

function isEnabled() {
  return Boolean(process.env.SUPABASE_DB_URL);
}

function namespaceFor(teamId) {
  return teamId ? String(teamId) : 'global';
}

function getPool() {
  if (pool) return pool;
  if (!isEnabled()) throw new Error('Supabase vector store needs SUPABASE_DB_URL');
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: process.env.KB_PG_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: Number(process.env.KB_PG_POOL_MAX) || 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    statement_timeout: 60000,
  });
  pool.on('error', (error) => logger.warn(`Supabase KB pool: ${error.message}`));
  return pool;
}

/** Pooled client with pgvector resolvable — Supabase installs it in "extensions". */
async function connect() {
  const client = await getPool().connect();
  if (!client.kbSearchPath) {
    try {
      await client.query('SET search_path TO public, extensions');
      client.kbSearchPath = true;
    } catch (error) {
      client.release(error);
      throw error;
    }
  }
  return client;
}

async function run(sql, params = []) {
  const client = await connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = run(SCHEMA_SQL)
      .then(() => logger.info('Supabase KB vector tables ready'))
      .catch((error) => {
        schemaReady = null;
        throw new Error(`Supabase KB schema setup failed: ${error.message}`);
      });
  }
  return schemaReady;
}

async function query(sql, params = []) {
  await ensureSchema();
  return run(sql, params);
}

function toVectorLiteral(values) {
  return `[${values.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
}

function rowToMeta(row) {
  if (!row) return null;
  return {
    generation: row.generation,
    sourceHash: row.source_hash,
    chunkCount: Number(row.chunk_count) || 0,
    entryCount: Number(row.entry_count) || 0,
    embedModel: row.embed_model,
    dimensions: Number(row.dimensions) || 0,
    indexedAt: row.indexed_at ? new Date(row.indexed_at).toISOString() : null,
  };
}

async function readMeta(teamId, { fresh = false } = {}) {
  const ns = namespaceFor(teamId);
  const cached = metaCache.get(ns);
  if (!fresh && cached && Date.now() - cached.at < META_CACHE_TTL_MS) return cached.meta;
  const { rows } = await query('SELECT * FROM public.kb_vector_indexes WHERE namespace = $1', [ns]);
  const meta = rowToMeta(rows[0]);
  metaCache.set(ns, { meta, at: Date.now() });
  return meta;
}

/** Vectors made with another model/size can't be compared with today's queries. */
function matchesEmbedder(meta) {
  return Boolean(meta) && meta.embedModel === embeddings.EMBED_MODEL && meta.dimensions === embeddings.EMBED_DIMENSIONS;
}

function buildIndexRecords(fullText, sourceHash, prebuiltRecords = null) {
  const chunks = prebuiltRecords || kbSemanticChunker.chunkDocument(fullText);
  return kbIndexRecords
    .expandChunksToIndexRecords(chunks, sourceHash)
    .filter((record) => String(record.embedText || record.text || '').trim());
}

async function insertGeneration(ns, generation, records, vectors, onProgress) {
  for (let i = 0; i < records.length; i += INSERT_BATCH) {
    const batch = records.slice(i, i + INSERT_BATCH);
    const params = [];
    const rows = batch.map((record, offset) => {
      params.push(
        ns,
        generation,
        record.recordId,
        record.recordType || 'chunk',
        Number.isFinite(Number(record.chunkIndex)) ? Number(record.chunkIndex) : null,
        record.version || 'general',
        record.questionId || null,
        Array.isArray(record.tags) ? record.tags.join(',') : record.tags || null,
        record.text || record.embedText,
        record.embedText || record.text,
        toVectorLiteral(vectors[i + offset])
      );
      const base = offset * 11;
      const slots = Array.from({ length: 11 }, (_, k) => `$${base + k + 1}`);
      slots[10] = `${slots[10]}::vector`;
      return `(${slots.join(', ')})`;
    });
    await query(
      `INSERT INTO public.kb_vector_chunks
         (namespace, generation, record_id, record_type, chunk_index, version, question_id, tags,
          answer_text, embed_text, embedding)
       VALUES ${rows.join(', ')}`,
      params
    );
    const done = Math.min(i + INSERT_BATCH, records.length);
    onProgress?.({ phase: 'upserting', done, total: records.length, message: `Saving vectors to Supabase ${done}/${records.length}…` });
  }
}

/** Points the namespace at the new generation and drops every other one, atomically. */
async function activateGeneration(ns, meta) {
  await ensureSchema();
  const client = await connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO public.kb_vector_indexes
         (namespace, generation, source_hash, chunk_count, entry_count, embed_model, dimensions, indexed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (namespace) DO UPDATE SET
         generation = EXCLUDED.generation, source_hash = EXCLUDED.source_hash,
         chunk_count = EXCLUDED.chunk_count, entry_count = EXCLUDED.entry_count,
         embed_model = EXCLUDED.embed_model, dimensions = EXCLUDED.dimensions, indexed_at = now()`,
      [ns, meta.generation, meta.sourceHash, meta.chunkCount, meta.entryCount, embeddings.EMBED_MODEL, embeddings.EMBED_DIMENSIONS]
    );
    await client.query('DELETE FROM public.kb_vector_chunks WHERE namespace = $1 AND generation <> $2', [ns, meta.generation]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  metaCache.delete(ns);
}

async function discardGeneration(ns, generation) {
  try {
    await query('DELETE FROM public.kb_vector_chunks WHERE namespace = $1 AND generation = $2', [ns, generation]);
  } catch (error) {
    logger.warn(`Supabase KB cleanup of failed generation in ${ns}: ${error.message}`);
  }
}

async function indexDocument(teamId, fullText, sourceHash, prebuiltRecords = null, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const ns = namespaceFor(teamId);
  onProgress?.({ phase: 'parsing', percent: 12, message: 'Building index records…' });
  const records = buildIndexRecords(fullText, sourceHash, prebuiltRecords);
  if (!records.length) return 0;

  const entryCount = new Set(records.map((record) => record.recordId)).size;
  logger.info(`Embedding ${records.length} vectors (${entryCount} entries) into Supabase namespace ${ns}...`);

  onProgress?.({ phase: 'embedding', done: 0, total: records.length, message: `Embedding ${records.length} vectors…` });
  const vectors = await embeddings.embedPassages(
    records.map((record) => record.embedText || record.text),
    (done, total) => onProgress?.({ phase: 'embedding', done, total, message: `Embedding vectors ${done}/${total}…` })
  );

  const generation = crypto.randomUUID();
  try {
    await insertGeneration(ns, generation, records, vectors, onProgress);
    onProgress?.({ phase: 'cleanup', message: 'Activating new index…' });
    await activateGeneration(ns, { generation, sourceHash, chunkCount: records.length, entryCount });
  } catch (error) {
    await discardGeneration(ns, generation);
    throw error;
  }

  logger.info(`Supabase indexed ${records.length} vectors in ${ns}`);
  return records.length;
}

async function isIndexed(teamId, sourceHash) {
  const meta = await readMeta(teamId);
  return matchesEmbedder(meta) && meta.sourceHash === sourceHash && meta.chunkCount > 0;
}

async function getChunkCount(teamId) {
  const meta = await readMeta(teamId);
  return matchesEmbedder(meta) ? meta.chunkCount : 0;
}

async function search(teamId, queryText, topK = 8) {
  const meta = await readMeta(teamId);
  if (!matchesEmbedder(meta) || !String(queryText || '').trim()) return [];

  const vector = toVectorLiteral(await embeddings.embedQuery(queryText));
  // Variations share their parent's record_id — over-fetch, then keep the best hit per entry.
  const { rows } = await query(
    `SELECT c.record_id, c.record_type, c.chunk_index, c.version, c.question_id, c.tags, c.answer_text,
            1 - (c.embedding <=> $2::vector) AS score
       FROM public.kb_vector_chunks c
       JOIN public.kb_vector_indexes i ON i.namespace = c.namespace AND i.generation = c.generation
      WHERE c.namespace = $1
      ORDER BY c.embedding <=> $2::vector
      LIMIT $3`,
    [namespaceFor(teamId), vector, Math.max(topK, 8) * 3]
  );

  const byRecord = new Map();
  for (const row of rows) {
    if (byRecord.has(row.record_id)) continue;
    const score = Number(row.score) || 0;
    byRecord.set(row.record_id, {
      recordId: row.record_id,
      id: row.record_id,
      chunkIndex: row.chunk_index,
      text: row.answer_text,
      version: row.version,
      questionId: row.question_id || null,
      tags: row.tags || null,
      recordType: row.record_type,
      semanticScore: score,
      sparseScore: 0,
      score,
    });
  }
  const hits = [...byRecord.values()];
  const aboveMin = MIN_SEARCH_SCORE > 0 ? hits.filter((hit) => hit.semanticScore >= MIN_SEARCH_SCORE) : hits;
  return (aboveMin.length ? aboveMin : hits).slice(0, topK);
}

/** Main-chunk docs of the live generation, shaped like the BM25 index input. */
async function listBm25Docs(teamId) {
  const meta = await readMeta(teamId);
  if (!matchesEmbedder(meta)) return { sourceHash: null, docs: [] };
  const { rows } = await query(
    `SELECT record_id, embed_text, chunk_index, version FROM public.kb_vector_chunks
      WHERE namespace = $1 AND generation = $2 AND record_type = 'chunk'
      ORDER BY chunk_index`,
    [namespaceFor(teamId), meta.generation]
  );
  return {
    sourceHash: meta.sourceHash,
    docs: rows.map((row) => ({ id: row.record_id, text: row.embed_text, chunkIndex: row.chunk_index, version: row.version })),
  };
}

async function expandNeighborChunks(_teamId, results) {
  return results;
}

async function getStats(teamId) {
  const meta = await readMeta(teamId);
  const live = matchesEmbedder(meta) ? meta : null;
  return {
    chunkCount: live?.chunkCount || 0,
    storePath: `supabase://kb_vector_chunks/${namespaceFor(teamId)}`,
    versions: [],
    indexedAt: live?.indexedAt || null,
    sourceHash: live?.sourceHash || null,
    backend: 'supabase-pgvector',
    namespace: namespaceFor(teamId),
    metric: 'cosine',
    dimensions: embeddings.EMBED_DIMENSIONS,
    embedModel: embeddings.EMBED_MODEL,
  };
}

async function close() {
  if (pool) await pool.end().catch(() => {});
  pool = null;
  schemaReady = null;
  metaCache.clear();
}

module.exports = {
  isEnabled,
  namespaceFor,
  ensureSchema,
  indexDocument,
  isIndexed,
  getChunkCount,
  search,
  listBm25Docs,
  expandNeighborChunks,
  getStats,
  close,
};
