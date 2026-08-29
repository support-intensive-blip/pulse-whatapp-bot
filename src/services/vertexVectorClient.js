const crypto = require('crypto');
const axios = require('axios');
const { withRetry, isTransientUpstreamError } = require('../utils/helpers');
const vertexAuth = require('./vertexAuth');
const logger = require('../utils/logger');
const networkInfo = require('../utils/networkInfo');

function opId() {
  return crypto.randomBytes(4).toString('hex');
}

const REGION = process.env.VERTEX_REGION || 'us-central1';
const EMBED_MODEL = process.env.VERTEX_EMBED_MODEL || 'text-multilingual-embedding-002';
const EMBED_DIMENSIONS = Number(process.env.VERTEX_EMBED_DIMENSIONS) || 768;
const WRITE_TASK_TYPE = process.env.VERTEX_WRITE_TASK_TYPE || 'RETRIEVAL_DOCUMENT';
const READ_TASK_TYPE = process.env.VERTEX_READ_TASK_TYPE || 'RETRIEVAL_QUERY';
const EMBED_BATCH_SIZE = Number(process.env.VERTEX_EMBED_BATCH_SIZE) || 32;
const EMBED_RETRY_BASE_MS = Number(process.env.VERTEX_EMBED_RETRY_BASE_MS) || 5000;

const INDEX_ID = process.env.VERTEX_INDEX_ID || null;
const INDEX_ENDPOINT_ID = process.env.VERTEX_INDEX_ENDPOINT_ID || null;
const DEPLOYED_INDEX_ID = process.env.VERTEX_DEPLOYED_INDEX_ID || null;
// Public Vector Search domain, e.g. "1234.us-central1-567.vdb.vertexai.goog" —
// findNeighbors must be called against this host, not aiplatform.googleapis.com.
const INDEX_ENDPOINT_DOMAIN = process.env.VERTEX_INDEX_ENDPOINT_DOMAIN || null;

function isEnabled() {
  const enabled = Boolean(
    vertexAuth.getProjectId() && INDEX_ID && INDEX_ENDPOINT_ID && DEPLOYED_INDEX_ID && INDEX_ENDPOINT_DOMAIN
  );
  return enabled;
}

function assertEnabled() {
  if (!isEnabled()) {
    const missing = [
      !vertexAuth.getProjectId() && 'GCP_PROJECT_ID',
      !INDEX_ID && 'VERTEX_INDEX_ID',
      !INDEX_ENDPOINT_ID && 'VERTEX_INDEX_ENDPOINT_ID',
      !DEPLOYED_INDEX_ID && 'VERTEX_DEPLOYED_INDEX_ID',
      !INDEX_ENDPOINT_DOMAIN && 'VERTEX_INDEX_ENDPOINT_DOMAIN',
    ].filter(Boolean);
    logger.error(`[vertex:config] not configured — missing env: ${missing.join(', ')}`);
    throw new Error(
      'Vertex AI Vector Search is not configured (GCP_PROJECT_ID, VERTEX_INDEX_ID, VERTEX_INDEX_ENDPOINT_ID, VERTEX_DEPLOYED_INDEX_ID, VERTEX_INDEX_ENDPOINT_DOMAIN required)'
    );
  }
}

function indexResourceName() {
  return `projects/${vertexAuth.getProjectId()}/locations/${REGION}/indexes/${INDEX_ID}`;
}

function indexEndpointResourceName() {
  return `projects/${vertexAuth.getProjectId()}/locations/${REGION}/indexEndpoints/${INDEX_ENDPOINT_ID}`;
}

function aiplatformBaseUrl() {
  return `https://${REGION}-aiplatform.googleapis.com/v1`;
}

/** L2-normalize so DOT_PRODUCT_DISTANCE on the index equals cosine similarity. */
function normalizeEmbeddingVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm) || 1;
  return vector.map((v) => v / norm);
}

async function embedBatch(texts, taskType) {
  const id = opId();
  const startedAt = Date.now();
  const hostTag = await networkInfo.getHostTag();
  logger.info(
    `[vertex:embed:${id}] START count=${texts.length} taskType=${taskType} model=${EMBED_MODEL} dims=${EMBED_DIMENSIONS} ${hostTag}`
  );
  try {
    const headers = await vertexAuth.authHeaders();
    const url = `${aiplatformBaseUrl()}/projects/${vertexAuth.getProjectId()}/locations/${REGION}/publishers/google/models/${EMBED_MODEL}:predict`;
    const response = await withRetry(
      () =>
        axios.post(
          url,
          {
            instances: texts.map((text) => ({ content: text, task_type: taskType })),
            parameters: { outputDimensionality: EMBED_DIMENSIONS },
          },
          { headers, timeout: 30000 }
        ),
      {
        attempts: 4,
        baseDelayMs: EMBED_RETRY_BASE_MS,
        shouldRetry: isTransientUpstreamError,
        label: 'Vertex AI embed',
      }
    );
    const vectors = (response.data.predictions || []).map((prediction) =>
      normalizeEmbeddingVector(prediction.embeddings?.values || [])
    );
    const elapsedMs = Date.now() - startedAt;
    logger.info(
      `[vertex:embed:${id}] OK returned=${vectors.length}/${texts.length} elapsedMs=${elapsedMs} ${hostTag}`
    );
    return vectors;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const status = error.response?.status;
    const body = error.response?.data ? JSON.stringify(error.response.data).slice(0, 500) : null;
    logger.error(
      `[vertex:embed:${id}] FAILED count=${texts.length} elapsedMs=${elapsedMs} status=${status || 'n/a'} message="${error.message}"${body ? ` body=${body}` : ''} ${hostTag}`
    );
    throw error;
  }
}

async function embedTexts(texts, { inputType = WRITE_TASK_TYPE } = {}) {
  if (!texts.length) return [];
  const taskType = inputType === READ_TASK_TYPE || inputType === 'query' ? READ_TASK_TYPE : WRITE_TASK_TYPE;

  const results = new Array(texts.length);
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedBatch(batch, taskType);
    vectors.forEach((vector, j) => {
      results[i + j] = vector;
    });
  }
  return results;
}

async function embedQuery(text) {
  const vectors = await embedTexts([text], { inputType: READ_TASK_TYPE });
  return vectors[0] || null;
}

/**
 * datapoints: [{ id, values, namespace, fields... }] — fields beyond id/values/namespace
 * are ignored here (Vector Search only stores vectors + restricts; text/metadata lives
 * in Firestore via vertexMetadataStore).
 */
async function upsertDatapoints(datapoints) {
  assertEnabled();
  if (!datapoints.length) return;
  const id = opId();
  const startedAt = Date.now();
  const hostTag = await networkInfo.getHostTag();
  const namespaces = [...new Set(datapoints.map((dp) => dp.namespace))].join(',');
  logger.info(
    `[vertex:upsert:${id}] START count=${datapoints.length} namespaces=${namespaces} index=${INDEX_ID} ${hostTag}`
  );
  try {
    const headers = await vertexAuth.authHeaders();
    const url = `${aiplatformBaseUrl()}/${indexResourceName()}:upsertDatapoints`;
    await withRetry(
      () =>
        axios.post(
          url,
          {
            datapoints: datapoints.map((dp) => ({
              datapoint_id: dp.id,
              feature_vector: dp.values,
              restricts: [{ namespace: 'team', allow_list: [dp.namespace] }],
            })),
          },
          { headers, timeout: 30000 }
        ),
      { attempts: 4, baseDelayMs: 4000, shouldRetry: isTransientUpstreamError, label: 'Vertex upsertDatapoints' }
    );
    const elapsedMs = Date.now() - startedAt;
    logger.info(`[vertex:upsert:${id}] OK count=${datapoints.length} elapsedMs=${elapsedMs} ${hostTag}`);
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const status = error.response?.status;
    const body = error.response?.data ? JSON.stringify(error.response.data).slice(0, 500) : null;
    logger.error(
      `[vertex:upsert:${id}] FAILED count=${datapoints.length} elapsedMs=${elapsedMs} status=${status || 'n/a'} message="${error.message}"${body ? ` body=${body}` : ''} ${hostTag}`
    );
    throw error;
  }
}

async function removeDatapoints(ids) {
  assertEnabled();
  if (!ids.length) return;
  const id = opId();
  const startedAt = Date.now();
  const hostTag = await networkInfo.getHostTag();
  logger.info(`[vertex:remove:${id}] START count=${ids.length} index=${INDEX_ID} ${hostTag}`);
  try {
    const headers = await vertexAuth.authHeaders();
    const url = `${aiplatformBaseUrl()}/${indexResourceName()}:removeDatapoints`;
    await withRetry(() => axios.post(url, { datapoint_ids: ids }, { headers, timeout: 30000 }), {
      attempts: 4,
      baseDelayMs: 4000,
      shouldRetry: isTransientUpstreamError,
      label: 'Vertex removeDatapoints',
    });
    const elapsedMs = Date.now() - startedAt;
    logger.info(`[vertex:remove:${id}] OK count=${ids.length} elapsedMs=${elapsedMs} ${hostTag}`);
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const status = error.response?.status;
    logger.error(
      `[vertex:remove:${id}] FAILED count=${ids.length} elapsedMs=${elapsedMs} status=${status || 'n/a'} message="${error.message}" ${hostTag}`
    );
    throw error;
  }
}

async function findNeighbors(queryVector, { namespace, neighborCount = 8 } = {}) {
  assertEnabled();
  const id = opId();
  const startedAt = Date.now();
  const hostTag = await networkInfo.getHostTag();
  logger.info(
    `[vertex:findNeighbors:${id}] START namespace=${namespace || 'n/a'} neighborCount=${neighborCount} endpoint=${INDEX_ENDPOINT_DOMAIN} deployedIndex=${DEPLOYED_INDEX_ID} ${hostTag}`
  );
  try {
    const headers = await vertexAuth.authHeaders();
    const url = `https://${INDEX_ENDPOINT_DOMAIN}/v1/${indexEndpointResourceName()}:findNeighbors`;
    const response = await withRetry(
      () =>
        axios.post(
          url,
          {
            deployed_index_id: DEPLOYED_INDEX_ID,
            queries: [
              {
                datapoint: {
                  datapoint_id: '__query__',
                  feature_vector: queryVector,
                  restricts: namespace ? [{ namespace: 'team', allow_list: [namespace] }] : undefined,
                },
                neighbor_count: neighborCount,
              },
            ],
          },
          { headers, timeout: 20000 }
        ),
      { attempts: 3, baseDelayMs: 800, shouldRetry: isTransientUpstreamError, label: 'Vertex findNeighbors' }
    );
    const neighbors = response.data.nearestNeighbors?.[0]?.neighbors || [];
    const elapsedMs = Date.now() - startedAt;
    logger.info(
      `[vertex:findNeighbors:${id}] OK namespace=${namespace || 'n/a'} neighbors=${neighbors.length} elapsedMs=${elapsedMs} ${hostTag}`
    );
    return neighbors;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const status = error.response?.status;
    const body = error.response?.data ? JSON.stringify(error.response.data).slice(0, 500) : null;
    logger.error(
      `[vertex:findNeighbors:${id}] FAILED namespace=${namespace || 'n/a'} elapsedMs=${elapsedMs} status=${status || 'n/a'} message="${error.message}"${body ? ` body=${body}` : ''} ${hostTag}`
    );
    throw error;
  }
}

module.exports = {
  isEnabled,
  EMBED_MODEL,
  EMBED_DIMENSIONS,
  WRITE_TASK_TYPE,
  READ_TASK_TYPE,
  REGION,
  INDEX_ID,
  normalizeEmbeddingVector,
  embedTexts,
  embedQuery,
  upsertDatapoints,
  removeDatapoints,
  findNeighbors,
};
