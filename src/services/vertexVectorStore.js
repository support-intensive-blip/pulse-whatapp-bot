const crypto = require('crypto');
const logger = require('../utils/logger');
const networkInfo = require('../utils/networkInfo');
const kbChunkUtils = require('./kbChunkUtils');
const kbSemanticChunker = require('./kbSemanticChunker');
const kbIndexRecords = require('./kbIndexRecords');
const vertexVectorClient = require('./vertexVectorClient');
const vertexMetadataStore = require('./vertexMetadataStore');

function opId() {
  return crypto.randomBytes(4).toString('hex');
}

const MIN_SEARCH_SCORE = Number(process.env.KB_MIN_SEARCH_SCORE) || 0;
const UPSERT_BATCH = 96;
const META_TTL_MS = Number(process.env.VERTEX_META_CACHE_TTL_MS) || 300000;

const metaCache = new Map();

function namespaceFor(teamId) {
  if (!teamId) return 'global';
  return `team-${teamId}`;
}

function isEnabled() {
  return vertexVectorClient.isEnabled() && vertexMetadataStore.isEnabled();
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

async function readMeta(teamId) {
  const ns = namespaceFor(teamId);
  const cached = metaCache.get(ns);
  if (cached && Date.now() - cached.at < META_TTL_MS) return cached.meta;

  const meta = await vertexMetadataStore.getMeta(ns);
  metaCache.set(ns, { meta, at: Date.now() });
  return meta;
}

async function writeMeta(teamId, meta) {
  const ns = namespaceFor(teamId);
  await vertexMetadataStore.setMeta(ns, meta);
  metaCache.set(ns, { meta, at: Date.now() });
}

/**
 * Remove the previous generation's vectors, but only after the new generation
 * has already been upserted successfully — mirrors pineconeVectorStore's
 * deleteStaleGeneration so a failed embed/upsert never leaves the namespace
 * empty. Best-effort: a failure here just leaves old + new coexisting.
 */
async function deleteStaleGeneration(teamId, currentSourceHash) {
  const ns = namespaceFor(teamId);
  try {
    const staleIds = await vertexMetadataStore.getStaleChunkIds(ns, currentSourceHash);
    if (!staleIds.length) return;
    await vertexVectorClient.removeDatapoints(staleIds);
    await vertexMetadataStore.deleteChunks(ns, staleIds);
  } catch (error) {
    logger.warn(`Vertex stale-generation cleanup for ${ns}: ${error.message}`);
  }
}

async function indexDocument(teamId, fullText, sourceHash, prebuiltRecords = null, options = {}) {
  const id = opId();
  const startedAt = Date.now();
  const hostTag = await networkInfo.getHostTag();
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const ns = namespaceFor(teamId);
  logger.info(`[vertex:index:${id}] START namespace=${ns} sourceHash=${sourceHash} ${hostTag}`);
  onProgress?.({ phase: 'parsing', percent: 12, message: 'Building index records…' });

  try {
    const records = buildIndexRecords(fullText, sourceHash, prebuiltRecords);
    if (!records.length) {
      logger.warn(`[vertex:index:${id}] ABORTED namespace=${ns} reason=no_records_built ${hostTag}`);
      return 0;
    }

    const entryCount = new Set(records.map((r) => r.recordId)).size;
    logger.info(
      `[vertex:index:${id}] step=chunked namespace=${ns} vectors=${records.length} qaEntries=${entryCount} ${hostTag}`
    );

    const texts = records.map((r) => r.embedText);
    onProgress?.({ phase: 'embedding', done: 0, total: texts.length, message: `Embedding ${texts.length} vectors…` });
    const embedStartedAt = Date.now();
    const embeddings = await vertexVectorClient.embedTexts(texts, {
      inputType: vertexVectorClient.WRITE_TASK_TYPE,
    });
    logger.info(
      `[vertex:index:${id}] step=embedded namespace=${ns} vectors=${embeddings.length} elapsedMs=${Date.now() - embedStartedAt} ${hostTag}`
    );
    onProgress?.({
      phase: 'embedding',
      done: texts.length,
      total: texts.length,
      message: `Embedded ${texts.length} vectors`,
    });

    // Write the new generation first; only once it has landed do we remove the
    // old one (see deleteStaleGeneration).
    for (let i = 0; i < records.length; i += UPSERT_BATCH) {
      const batch = records.slice(i, i + UPSERT_BATCH);
      const datapoints = batch.map((record, j) => ({
        id: record.id,
        values: embeddings[i + j],
        namespace: ns,
      }));
      // eslint-disable-next-line no-await-in-loop
      await vertexVectorClient.upsertDatapoints(datapoints);
      // eslint-disable-next-line no-await-in-loop
      await vertexMetadataStore.setChunks(
        ns,
        batch.map((record) => ({
          id: record.id,
          text: record.text.slice(0, 38000),
          recordId: record.recordId,
          version: record.version,
          chunkIndex: record.chunkIndex,
          sourceHash,
          recordType: record.recordType || 'chunk',
          tokenEstimate: record.tokenEstimate,
          questionId: record.questionId || '',
          tags: Array.isArray(record.tags) ? record.tags.join(',') : '',
        }))
      );
      const done = Math.min(i + UPSERT_BATCH, records.length);
      logger.info(`[vertex:index:${id}] step=batch_upserted namespace=${ns} progress=${done}/${records.length} ${hostTag}`);
      onProgress?.({
        phase: 'upserting',
        done,
        total: records.length,
        message: `Uploading vectors ${done}/${records.length}…`,
      });
    }

    onProgress?.({ phase: 'cleanup', message: 'Removing previous generation…' });
    await deleteStaleGeneration(teamId, sourceHash);
    logger.info(`[vertex:index:${id}] step=stale_cleanup_done namespace=${ns} ${hostTag}`);

    const meta = {
      sourceHash,
      indexedAt: new Date().toISOString(),
      chunkCount: records.length,
    };
    await writeMeta(teamId, meta);
    logger.info(`[vertex:index:${id}] step=meta_written namespace=${ns} ${hostTag}`);

    onProgress?.({
      phase: 'complete',
      percent: 100,
      done: records.length,
      total: records.length,
      message: `Indexed ${records.length} vectors`,
    });

    const elapsedMs = Date.now() - startedAt;
    logger.info(`[vertex:index:${id}] OK namespace=${ns} vectors=${records.length} elapsedMs=${elapsedMs} ${hostTag}`);
    logger.info(`Vertex indexed ${records.length} vectors in ${ns}`);
    return records.length;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logger.error(
      `[vertex:index:${id}] FAILED namespace=${ns} elapsedMs=${elapsedMs} message="${error.message}" ${hostTag}`
    );
    onProgress?.({ phase: 'error', message: error.message, error: error.message });
    throw error;
  }
}

async function isIndexed(teamId, sourceHash) {
  const meta = await readMeta(teamId);
  return meta?.sourceHash === sourceHash && (meta?.chunkCount || 0) > 0;
}

async function getChunkCount(teamId) {
  const meta = await readMeta(teamId);
  return meta?.chunkCount || 0;
}

function resolveRecordId(fields, rawId) {
  if (fields.recordId) return String(fields.recordId);
  if (rawId) return String(rawId).replace(/_var_\d+$/, '');
  return null;
}

async function search(teamId, query, topK = 8) {
  const id = opId();
  const startedAt = Date.now();
  const hostTag = await networkInfo.getHostTag();
  const ns = namespaceFor(teamId);
  const trimmedQuery = String(query || '').trim();
  logger.info(`[vertex:search:${id}] START namespace=${ns} topK=${topK} queryLen=${trimmedQuery.length} ${hostTag}`);

  try {
    const queryVector = await vertexVectorClient.embedQuery(trimmedQuery);
    if (!queryVector) {
      logger.warn(`[vertex:search:${id}] ABORTED namespace=${ns} reason=empty_query_embedding ${hostTag}`);
      return [];
    }
    logger.info(`[vertex:search:${id}] step=query_embedded namespace=${ns} ${hostTag}`);

    const requestTopK = Math.max(topK, 8);
    const neighbors = await vertexVectorClient.findNeighbors(queryVector, {
      namespace: ns,
      neighborCount: requestTopK,
    });
    if (!neighbors.length) {
      logger.warn(`[vertex:search:${id}] EMPTY namespace=${ns} reason=no_neighbors_returned ${hostTag}`);
      return [];
    }
    logger.info(`[vertex:search:${id}] step=neighbors_found namespace=${ns} count=${neighbors.length} ${hostTag}`);

    const ids = neighbors.map((n) => n.datapoint?.datapointId).filter(Boolean);
    const metaStartedAt = Date.now();
    const textsById = await vertexMetadataStore.getChunksByIds(ns, ids);
    const foundCount = Object.keys(textsById).length;
    logger.info(
      `[vertex:search:${id}] step=metadata_fetched namespace=${ns} requested=${ids.length} found=${foundCount} elapsedMs=${Date.now() - metaStartedAt} ${hostTag}`
    );
    if (foundCount < ids.length) {
      logger.warn(
        `[vertex:search:${id}] step=metadata_gap namespace=${ns} missing=${ids.length - foundCount} — Vector Search returned datapoint ids with no matching Firestore chunk (stale index vs. Firestore?) ${hostTag}`
      );
    }

    const mapped = neighbors
      .map((n) => {
        const nid = n.datapoint?.datapointId;
        const fields = textsById[nid];
        if (!fields || !fields.text) return null;
        const recordId = resolveRecordId(fields, nid);
        const semanticScore = Number(n.distance) || 0;
        return {
          recordId,
          id: recordId || nid,
          chunkIndex: Number(fields.chunkIndex) || null,
          text: fields.text,
          version: fields.version || kbChunkUtils.detectChunkVersion(fields.text),
          questionId: fields.questionId || null,
          tags: fields.tags || null,
          recordType: fields.recordType || 'chunk',
          semanticScore,
          sparseScore: 0,
          score: semanticScore,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.semanticScore - a.semanticScore);

    if (!mapped.length) {
      logger.warn(`[vertex:search:${id}] EMPTY namespace=${ns} reason=no_chunks_resolved_from_metadata ${hostTag}`);
      return [];
    }

    const aboveMin =
      MIN_SEARCH_SCORE > 0 ? mapped.filter((item) => item.semanticScore >= MIN_SEARCH_SCORE) : mapped;
    const pool = aboveMin.length > 0 ? aboveMin : mapped;
    const result = pool.slice(0, topK);

    const elapsedMs = Date.now() - startedAt;
    logger.info(
      `[vertex:search:${id}] OK namespace=${ns} returned=${result.length} topScore=${result[0]?.semanticScore?.toFixed(3) || 'n/a'} minScoreFilter=${MIN_SEARCH_SCORE} elapsedMs=${elapsedMs} ${hostTag}`
    );
    return result;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logger.error(
      `[vertex:search:${id}] FAILED namespace=${ns} elapsedMs=${elapsedMs} message="${error.message}" ${hostTag}`
    );
    throw error;
  }
}

async function expandNeighborChunks(teamId, results) {
  return results;
}

async function getStats(teamId) {
  const meta = (await readMeta(teamId)) || {};
  return {
    chunkCount: meta.chunkCount || 0,
    storePath: `vertex://${vertexVectorClient.INDEX_ID}/${namespaceFor(teamId)}`,
    versions: [],
    indexedAt: meta.indexedAt || null,
    sourceHash: meta.sourceHash || null,
    backend: 'vertex-vector-search',
    namespace: namespaceFor(teamId),
    chunkMaxTokens: kbSemanticChunker.MAX_CHUNK_TOKENS,
    metric: 'dot_product',
    dimensions: vertexVectorClient.EMBED_DIMENSIONS,
  };
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
