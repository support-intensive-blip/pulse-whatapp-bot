const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { DATA_DIR } = require('../utils/constants');
const { ensureDir, withRetry, isTransientUpstreamError } = require('../utils/helpers');
const kbChunkUtils = require('./kbChunkUtils');
const kbSemanticChunker = require('./kbSemanticChunker');
const kbIndexRecords = require('./kbIndexRecords');
const pineconeClient = require('./pineconeClient');

const META_DIR = path.join(DATA_DIR, 'pinecone-meta');
const metaCache = new Map();
const statsCache = new Map();

const MIN_SEARCH_SCORE = Number(process.env.KB_MIN_SEARCH_SCORE) || 0;
const STATS_CACHE_TTL_MS = Number(process.env.PINECONE_STATS_CACHE_TTL_MS) || 300000;
const STATS_TIMEOUT_MS = Number(process.env.PINECONE_STATS_TIMEOUT_MS) || 15000;
const SEARCH_TIMEOUT_MS = Number(process.env.PINECONE_SEARCH_TIMEOUT_MS) || 60000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const UPSERT_BATCH = 96;
const META_RECORD_ID = pineconeClient.META_RECORD_ID;
const EMBED_FIELD = pineconeClient.EMBED_FIELD;
// Hosted embedding models enforce a tokens-PER-MINUTE cap (independent of any
// monthly quota) — a short exponential backoff can't outlast that window, so
// retries on a 429 here wait long enough to clear it, and batches are paced
// with a small gap to avoid bursting past the cap in the first place.
const UPSERT_BATCH_PACING_MS = Number(process.env.PINECONE_UPSERT_BATCH_PACING_MS) || 15000;
const RATE_LIMIT_RETRY_BASE_MS = Number(process.env.PINECONE_RATE_LIMIT_RETRY_BASE_MS) || 25000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function namespaceFor(teamId) {
  if (!teamId) return 'global';
  return `team-${teamId}`;
}

function localMetaPath(teamId) {
  return path.join(META_DIR, `${namespaceFor(teamId)}.json`);
}

function readLocalMeta(teamId) {
  try {
    const raw = fs.readFileSync(localMetaPath(teamId), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      sourceHash: parsed.sourceHash || null,
      chunkCount: Number(parsed.chunkCount) || 0,
      indexedAt: parsed.indexedAt || null,
      backend: 'pinecone-hybrid',
      namespace: namespaceFor(teamId),
    };
  } catch {
    return null;
  }
}

function writeLocalMeta(teamId, meta) {
  ensureDir(META_DIR);
  fs.writeFileSync(localMetaPath(teamId), JSON.stringify(meta));
}

function normalizeMetaRecord(record, ns) {
  if (!record) return null;
  const fields = record.fields || record.metadata || {};
  const chunkCount = Number(fields.chunkCount ?? fields.chunk_count) || 0;
  if (!fields.sourceHash && chunkCount === 0) return null;
  return {
    sourceHash: fields.sourceHash || null,
    chunkCount,
    indexedAt: fields.indexedAt || null,
    backend: 'pinecone-hybrid',
    namespace: ns,
  };
}

async function readMeta(teamId) {
  const ns = namespaceFor(teamId);
  if (metaCache.has(ns)) return metaCache.get(ns);

  const fromDisk = readLocalMeta(teamId);
  if (fromDisk?.chunkCount > 0) {
    metaCache.set(ns, fromDisk);
    return fromDisk;
  }

  const index = pineconeClient.getIndex();
  try {
    const fetched = await withTimeout(
      index.namespace(ns).fetch({ ids: [META_RECORD_ID] }),
      STATS_TIMEOUT_MS,
      `Pinecone meta fetch ${ns}`
    );
    const record = fetched.records?.[META_RECORD_ID];
    const fromPinecone = normalizeMetaRecord(record, ns);
    if (fromPinecone) {
      metaCache.set(ns, fromPinecone);
      return fromPinecone;
    }
  } catch (error) {
    logger.warn(`Pinecone meta fetch for ${ns}: ${error.message}`);
  }

  if (fromDisk) {
    metaCache.set(ns, fromDisk);
    return fromDisk;
  }
  return null;
}

async function writeMeta(teamId, meta) {
  const index = pineconeClient.getIndex();
  const ns = namespaceFor(teamId);
  const normalized = {
    sourceHash: meta.sourceHash,
    chunkCount: Number(meta.chunkCount) || 0,
    indexedAt: meta.indexedAt,
    backend: 'pinecone-hybrid',
    namespace: ns,
  };
  metaCache.set(ns, normalized);
  writeLocalMeta(teamId, normalized);

  if (pineconeClient.useIntegratedIndex()) {
    await index.namespace(ns).upsertRecords({
      records: [
        {
          id: META_RECORD_ID,
          [EMBED_FIELD]: pineconeClient.formatPassageText('knowledge base index metadata'),
          sourceHash: normalized.sourceHash,
          chunkCount: String(normalized.chunkCount),
          indexedAt: normalized.indexedAt,
          recordType: 'meta',
        },
      ],
    });
    return;
  }

  const [vector] = await pineconeClient.embedTexts(['knowledge base index metadata'], {
    inputType: pineconeClient.WRITE_INPUT_TYPE,
  });
  await index.namespace(ns).upsert([
    {
      id: META_RECORD_ID,
      values: pineconeClient.normalizeEmbeddingVector(vector),
      metadata: {
        sourceHash: normalized.sourceHash,
        chunkCount: normalized.chunkCount,
        indexedAt: normalized.indexedAt,
        recordType: 'meta',
      },
    },
  ]);
}

/**
 * Remove the previous generation's vectors, but only after the new generation
 * has already been upserted successfully. Every record from a given re-index
 * carries its sourceHash in metadata, so this targets exactly the leftovers —
 * it must never run before the new upsert, or a failed embed/upsert (quota,
 * network, ...) would leave the namespace empty instead of serving stale data.
 * Best-effort: a failure here just leaves old + new vectors coexisting
 * temporarily, which is far safer than the alternative.
 */
async function deleteStaleGeneration(teamId, currentSourceHash) {
  const index = pineconeClient.getIndex();
  const ns = namespaceFor(teamId);
  try {
    await index.namespace(ns).deleteMany({ filter: { sourceHash: { $ne: currentSourceHash } } });
  } catch (error) {
    logger.warn(`Pinecone stale-generation cleanup for ${ns}: ${error.message}`);
  }
}

function resolveRecordId(hit) {
  const fields = hit.fields || hit.metadata || {};
  const rawId = hit.id || hit._id;
  if (fields.recordId) return String(fields.recordId);
  if (rawId) return String(rawId).replace(/_var_\d+$/, '');
  return null;
}

function mapSearchHits(hits, topK) {
  const mapped = (hits || [])
    .filter((hit) => {
      const id = hit.id || hit._id;
      return id && id !== META_RECORD_ID;
    })
    .map((hit) => {
      const fields = hit.fields || hit.metadata || {};
      const text = fields.answerText || fields[EMBED_FIELD] || fields.text || '';
      const semanticScore = hit.score ?? hit._score ?? 0;
      const recordId = resolveRecordId(hit);
      return {
        recordId,
        id: recordId || hit.id || hit._id,
        chunkIndex: Number(fields.chunkIndex ?? fields.chunk_index) || null,
        text,
        version: fields.version || kbChunkUtils.detectChunkVersion(text),
        questionId: fields.questionId || null,
        tags: fields.tags || null,
        recordType: fields.recordType || 'chunk',
        semanticScore,
        sparseScore: 0,
        score: semanticScore,
      };
    })
    .filter((item) => item.text)
    .sort((a, b) => b.semanticScore - a.semanticScore);

  if (!mapped.length) return [];

  const aboveMin =
    MIN_SEARCH_SCORE > 0
      ? mapped.filter((item) => item.semanticScore >= MIN_SEARCH_SCORE)
      : mapped;
  const pool = aboveMin.length > 0 ? aboveMin : mapped;
  return pool.slice(0, topK);
}

const MAX_ANSWER_TEXT_BYTES = Number(process.env.PINECONE_MAX_ANSWER_TEXT_BYTES) || 12000;

function truncateUtf8(text, maxBytes = MAX_ANSWER_TEXT_BYTES) {
  const buf = Buffer.from(String(text || ''), 'utf8');
  if (buf.length <= maxBytes) return String(text || '');
  return buf.subarray(0, maxBytes).toString('utf8');
}

function buildIndexRecords(fullText, sourceHash, prebuiltRecords = null) {
  const chunks = prebuiltRecords
    ? prebuiltRecords.map((record, index) => ({
        text: record.text,
        embedText: record.embedText || record.text,
        chunkIndex: record.chunkIndex ?? index,
        tokenEstimate: record.tokenEstimate,
        version: record.version,
        questionId: record.questionId,
        tags: record.tags,
        variations: record.variations || [],
      }))
    : kbSemanticChunker.chunkDocument(fullText);

  return kbIndexRecords.expandChunksToIndexRecords(chunks, sourceHash);
}

async function indexDocumentIntegrated(records, sourceHash, teamId, onProgress = null) {
  const index = pineconeClient.getIndex();
  const ns = namespaceFor(teamId);

  for (let i = 0; i < records.length; i += UPSERT_BATCH) {
    const batch = records.slice(i, i + UPSERT_BATCH);
    await withRetry(
      () =>
        index.namespace(ns).upsertRecords({
          records: batch.map((record) => ({
            id: record.id,
            [EMBED_FIELD]: pineconeClient.formatPassageText(record.embedText),
            answerText: truncateUtf8(record.text),
            recordId: record.recordId,
            version: record.version,
            chunkIndex: record.chunkIndex,
            sourceHash,
            recordType: record.recordType || 'chunk',
            tokenEstimate: record.tokenEstimate,
            questionId: record.questionId || '',
            tags: Array.isArray(record.tags) ? record.tags.join(',') : '',
          })),
        }),
      {
        attempts: 5,
        baseDelayMs: RATE_LIMIT_RETRY_BASE_MS,
        shouldRetry: isTransientUpstreamError,
        label: `Pinecone upsert ${ns} batch ${i / UPSERT_BATCH + 1}`,
      }
    );
    if (i + UPSERT_BATCH < records.length) await sleep(UPSERT_BATCH_PACING_MS);
    const done = Math.min(i + UPSERT_BATCH, records.length);
    onProgress?.({
      phase: 'upserting',
      done,
      total: records.length,
      message: `Uploading vectors ${done}/${records.length}…`,
    });
  }
}

async function indexDocumentVectors(records, sourceHash, teamId, onProgress = null) {
  const index = pineconeClient.getIndex();
  const ns = namespaceFor(teamId);
  const texts = records.map((r) => r.embedText);
  onProgress?.({
    phase: 'embedding',
    done: 0,
    total: texts.length,
    message: `Embedding ${texts.length} vectors…`,
  });
  const embeddings = await pineconeClient.embedTexts(texts, {
    inputType: pineconeClient.WRITE_INPUT_TYPE,
  });
  onProgress?.({
    phase: 'embedding',
    done: texts.length,
    total: texts.length,
    message: `Embedded ${texts.length} vectors`,
  });

  const vectors = records.map((record, index) => ({
    id: record.id,
    values: pineconeClient.normalizeEmbeddingVector(embeddings[index]),
    metadata: {
      text: record.text.slice(0, 38000),
      answerText: record.text.slice(0, 38000),
      recordId: record.recordId,
      version: record.version,
      chunkIndex: record.chunkIndex,
      sourceHash,
      recordType: record.recordType || 'chunk',
      tokenEstimate: record.tokenEstimate,
      questionId: record.questionId || '',
      tags: Array.isArray(record.tags) ? record.tags.join(',') : '',
    },
  }));

  for (let i = 0; i < vectors.length; i += UPSERT_BATCH) {
    await index.namespace(ns).upsert(vectors.slice(i, i + UPSERT_BATCH));
    const done = Math.min(i + UPSERT_BATCH, vectors.length);
    onProgress?.({
      phase: 'upserting',
      done,
      total: vectors.length,
      message: `Uploading vectors ${done}/${vectors.length}…`,
    });
  }
}

async function indexDocument(teamId, fullText, sourceHash, prebuiltRecords = null, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  onProgress?.({
    phase: 'parsing',
    percent: 12,
    message: 'Building index records…',
  });
  const records = buildIndexRecords(fullText, sourceHash, prebuiltRecords);
  if (!records.length) return 0;

  const entryCount = new Set(records.map((r) => r.recordId)).size;
  logger.info(
    `Indexing ${records.length} vectors (${entryCount} QA entries incl. variations) into Pinecone namespace ${namespaceFor(teamId)}...`
  );

  // Write the new generation first. Only once it has landed do we remove the
  // old one — a failed embed/upsert here (quota, network, ...) must leave the
  // previous working index in place, not an empty namespace.
  if (pineconeClient.useIntegratedIndex()) {
    await indexDocumentIntegrated(records, sourceHash, teamId, onProgress);
  } else {
    await indexDocumentVectors(records, sourceHash, teamId, onProgress);
  }

  onProgress?.({
    phase: 'cleanup',
    message: 'Removing previous generation…',
  });
  await deleteStaleGeneration(teamId, sourceHash);

  const meta = {
    sourceHash,
    indexedAt: new Date().toISOString(),
    chunkCount: records.length,
    entryCount,
    backend: 'pinecone-hybrid',
    namespace: namespaceFor(teamId),
  };
  await writeMeta(teamId, meta);

  onProgress?.({
    phase: 'complete',
    percent: 100,
    done: records.length,
    total: records.length,
    message: `Indexed ${records.length} vectors`,
  });

  logger.info(`Pinecone indexed ${records.length} vectors in ${namespaceFor(teamId)}`);
  return records.length;
}

async function getNamespaceStatsChunkCount(teamId) {
  const ns = namespaceFor(teamId);
  const now = Date.now();
  const cached = statsCache.get(ns);
  if (cached && now - cached.at < STATS_CACHE_TTL_MS) {
    return cached.count;
  }

  const localMeta = readLocalMeta(teamId);
  if (localMeta?.chunkCount > 0) {
    statsCache.set(ns, { count: localMeta.chunkCount, at: now });
    return localMeta.chunkCount;
  }

  const metaCached = metaCache.get(ns);
  if (metaCached?.chunkCount > 0) {
    statsCache.set(ns, { count: metaCached.chunkCount, at: now });
    return metaCached.chunkCount;
  }

  try {
    const index = pineconeClient.getIndex();
    const stats = await withTimeout(
      index.describeIndexStats(),
      STATS_TIMEOUT_MS,
      `Pinecone describeIndexStats ${ns}`
    );
    const recordCount = stats.namespaces?.[ns]?.recordCount || 0;
    const count = recordCount <= 0 ? 0 : recordCount > 1 ? recordCount - 1 : 0;
    statsCache.set(ns, { count, at: now });
    return count;
  } catch (error) {
    logger.warn(`Pinecone stats for ${ns}: ${error.message}`);
    const fallback = Math.max(
      Number(localMeta?.chunkCount) || 0,
      Number(metaCached?.chunkCount) || 0
    );
    if (fallback > 0) {
      statsCache.set(ns, { count: fallback, at: now });
      return fallback;
    }
    return 0;
  }
}

async function isIndexed(teamId, sourceHash) {
  const meta = await readMeta(teamId);
  return meta?.sourceHash === sourceHash && (meta?.chunkCount || 0) > 0;
}

async function getChunkCount(teamId) {
  const ns = namespaceFor(teamId);
  const localMeta = readLocalMeta(teamId);
  const localCount = Number(localMeta?.chunkCount) || 0;
  const cached = metaCache.get(ns);
  const cachedCount = Number(cached?.chunkCount) || 0;
  const bestKnown = Math.max(localCount, cachedCount);

  if (bestKnown > 0) {
    return bestKnown;
  }

  const statsCount = await getNamespaceStatsChunkCount(teamId);

  if (cached && statsCount > (cached.chunkCount || 0)) {
    metaCache.delete(ns);
  }

  const meta = await readMeta(teamId);
  const metaCount = Number(meta?.chunkCount) || 0;
  const best = Math.max(statsCount, metaCount, localCount);

  if (best > 0 && statsCount > 0 && statsCount >= best && meta?.sourceHash && best > metaCount) {
    try {
      await writeMeta(teamId, { ...meta, chunkCount: best });
      logger.info(`KB meta self-healed for ${ns}: ${metaCount} → ${best} chunks`);
    } catch (error) {
      logger.warn(`KB meta self-heal failed for ${ns}: ${error.message}`);
    }
  }

  return best;
}

async function searchIntegrated(teamId, query, topK) {
  const index = pineconeClient.getIndex();
  const ns = namespaceFor(teamId);
  const requestTopK = Math.max(topK, 8);
  const queryText = pineconeClient.formatQueryText(String(query || '').trim());
  const response = await withTimeout(
    withRetry(
      () =>
        index.namespace(ns).searchRecords({
          query: {
            topK: requestTopK,
            inputs: { [pineconeClient.EMBED_INPUT_KEY]: queryText },
          },
          fields: [
            EMBED_FIELD,
            'answerText',
            'recordId',
            'version',
            'recordType',
            'chunkIndex',
            'questionId',
            'tags',
          ],
        }),
      { attempts: 2, baseDelayMs: 400, shouldRetry: isTransientUpstreamError, label: `Pinecone search ${ns}` }
    ),
    SEARCH_TIMEOUT_MS,
    `Pinecone search ${ns}`
  );
  return mapSearchHits(response.result?.hits, topK);
}

async function searchVectors(teamId, query, topK) {
  const queryEmbedding = pineconeClient.normalizeEmbeddingVector(
    await pineconeClient.embedQuery(query)
  );
  if (!queryEmbedding) return [];

  const index = pineconeClient.getIndex();
  const ns = namespaceFor(teamId);
  const requestTopK = Math.max(topK, 8);
  const result = await withRetry(
    () =>
      index.namespace(ns).query({
        vector: queryEmbedding,
        topK: requestTopK,
        includeMetadata: true,
      }),
    { attempts: 3, baseDelayMs: 400, shouldRetry: isTransientUpstreamError, label: `Pinecone query ${ns}` }
  );

  return mapSearchHits(
    (result.matches || []).map((match) => ({
      id: match.id,
      score: match.score,
      metadata: match.metadata,
      fields: match.metadata,
    })),
    topK
  );
}

async function search(teamId, query, topK = 8) {
  if (pineconeClient.useIntegratedIndex()) {
    return searchIntegrated(teamId, query, topK);
  }
  return searchVectors(teamId, query, topK);
}

async function expandNeighborChunks(teamId, results) {
  return results;
}

async function getStats(teamId) {
  const meta = (await readMeta(teamId)) || {};
  const chunkCount = (await getChunkCount(teamId)) || meta.chunkCount || 0;
  return {
    chunkCount,
    storePath: `pinecone://${process.env.PINECONE_INDEX}/${namespaceFor(teamId)}`,
    versions: [],
    indexedAt: meta.indexedAt || null,
    sourceHash: meta.sourceHash || null,
    backend: pineconeClient.useIntegratedIndex()
      ? 'pinecone-hybrid-integrated'
      : 'pinecone-hybrid-inference',
    namespace: namespaceFor(teamId),
    chunkMaxTokens: kbSemanticChunker.MAX_CHUNK_TOKENS,
    metric: pineconeClient.VECTOR_METRIC,
    dimensions: pineconeClient.EMBED_DIMENSIONS,
  };
}

function isEnabled() {
  return pineconeClient.isEnabled();
}

module.exports = {
  isEnabled,
  namespaceFor,
  indexDocument,
  isIndexed,
  getChunkCount,
  search,
  expandNeighborChunks,
  getStats,
  hashSource: kbChunkUtils.hashSource,
};
