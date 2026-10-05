const crypto = require('crypto');
const { Firestore } = require('@google-cloud/firestore');
const vertexAuth = require('./vertexAuth');
const logger = require('../utils/logger');
const networkInfo = require('../utils/networkInfo');

function opId() {
  return crypto.randomBytes(4).toString('hex');
}

// Vector Search only stores vectors + restricts, not payload text, so chunk
// text/metadata lives here, keyed by the same datapoint id used in the index.
const COLLECTION = process.env.VERTEX_FIRESTORE_COLLECTION || 'vertexKb';
const WRITE_BATCH_SIZE = 400; // Firestore batch limit is 500

let firestoreClient = null;

function isEnabled() {
  return Boolean(vertexAuth.getProjectId());
}

function getClient() {
  if (!firestoreClient) {
    firestoreClient = new Firestore({
      projectId: vertexAuth.getProjectId(),
      ignoreUndefinedProperties: true,
    });
  }
  return firestoreClient;
}

function namespaceDoc(namespace) {
  return getClient().collection(COLLECTION).doc(namespace);
}

function chunksCollection(namespace) {
  return namespaceDoc(namespace).collection('chunks');
}

async function getMeta(namespace) {
  const id = opId();
  const startedAt = Date.now();
  try {
    const snap = await namespaceDoc(namespace).get();
    const elapsedMs = Date.now() - startedAt;
    if (!snap.exists) {
      logger.info(`[vertex:firestore:${id}] getMeta namespace=${namespace} exists=false elapsedMs=${elapsedMs}`);
      return null;
    }
    const data = snap.data();
    if (!data || !data.sourceHash) {
      logger.warn(
        `[vertex:firestore:${id}] getMeta namespace=${namespace} exists=true but missing sourceHash elapsedMs=${elapsedMs}`
      );
      return null;
    }
    logger.info(
      `[vertex:firestore:${id}] getMeta namespace=${namespace} chunkCount=${data.chunkCount} sourceHash=${data.sourceHash} elapsedMs=${elapsedMs}`
    );
    return {
      sourceHash: data.sourceHash,
      chunkCount: Number(data.chunkCount) || 0,
      indexedAt: data.indexedAt || null,
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logger.error(
      `[vertex:firestore:${id}] getMeta FAILED namespace=${namespace} elapsedMs=${elapsedMs} message="${error.message}"`
    );
    throw error;
  }
}

async function setMeta(namespace, meta) {
  const id = opId();
  const startedAt = Date.now();
  try {
    await namespaceDoc(namespace).set(
      {
        sourceHash: meta.sourceHash,
        chunkCount: Number(meta.chunkCount) || 0,
        indexedAt: meta.indexedAt,
      },
      { merge: true }
    );
    logger.info(
      `[vertex:firestore:${id}] setMeta OK namespace=${namespace} chunkCount=${meta.chunkCount} elapsedMs=${Date.now() - startedAt}`
    );
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logger.error(
      `[vertex:firestore:${id}] setMeta FAILED namespace=${namespace} elapsedMs=${elapsedMs} message="${error.message}"`
    );
    throw error;
  }
}

/** records: [{ id, text, recordId, version, chunkIndex, sourceHash, recordType, questionId, tags }] */
async function setChunks(namespace, records) {
  const id = opId();
  const startedAt = Date.now();
  try {
    const collection = chunksCollection(namespace);
    for (let i = 0; i < records.length; i += WRITE_BATCH_SIZE) {
      const batch = getClient().batch();
      for (const record of records.slice(i, i + WRITE_BATCH_SIZE)) {
        batch.set(collection.doc(record.id), record);
      }
      // eslint-disable-next-line no-await-in-loop
      await batch.commit();
    }
    logger.info(
      `[vertex:firestore:${id}] setChunks OK namespace=${namespace} count=${records.length} elapsedMs=${Date.now() - startedAt}`
    );
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logger.error(
      `[vertex:firestore:${id}] setChunks FAILED namespace=${namespace} count=${records.length} elapsedMs=${elapsedMs} message="${error.message}"`
    );
    throw error;
  }
}

async function getChunksByIds(namespace, ids) {
  if (!ids.length) return {};
  const id = opId();
  const startedAt = Date.now();
  try {
    const collection = chunksCollection(namespace);
    const results = {};
    for (let i = 0; i < ids.length; i += WRITE_BATCH_SIZE) {
      const batchIds = ids.slice(i, i + WRITE_BATCH_SIZE);
      const refs = batchIds.map((docId) => collection.doc(docId));
      // eslint-disable-next-line no-await-in-loop
      const docs = await getClient().getAll(...refs);
      docs.forEach((doc) => {
        if (doc.exists) results[doc.id] = doc.data();
      });
    }
    logger.info(
      `[vertex:firestore:${id}] getChunksByIds OK namespace=${namespace} requested=${ids.length} found=${Object.keys(results).length} elapsedMs=${Date.now() - startedAt}`
    );
    return results;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logger.error(
      `[vertex:firestore:${id}] getChunksByIds FAILED namespace=${namespace} requested=${ids.length} elapsedMs=${elapsedMs} message="${error.message}"`
    );
    throw error;
  }
}

/** Returns ids of chunks belonging to a stale (non-current) sourceHash generation. */
async function getStaleChunkIds(namespace, currentSourceHash) {
  const id = opId();
  const startedAt = Date.now();
  try {
    const collection = chunksCollection(namespace);
    const snap = await collection.where('sourceHash', '!=', currentSourceHash).get();
    const ids = snap.docs.map((doc) => doc.id);
    logger.info(
      `[vertex:firestore:${id}] getStaleChunkIds OK namespace=${namespace} stale=${ids.length} elapsedMs=${Date.now() - startedAt}`
    );
    return ids;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logger.error(
      `[vertex:firestore:${id}] getStaleChunkIds FAILED namespace=${namespace} elapsedMs=${elapsedMs} message="${error.message}"`
    );
    throw error;
  }
}

async function deleteChunks(namespace, ids) {
  if (!ids.length) return;
  const id = opId();
  const startedAt = Date.now();
  try {
    const collection = chunksCollection(namespace);
    for (let i = 0; i < ids.length; i += WRITE_BATCH_SIZE) {
      const batch = getClient().batch();
      for (const docId of ids.slice(i, i + WRITE_BATCH_SIZE)) {
        batch.delete(collection.doc(docId));
      }
      // eslint-disable-next-line no-await-in-loop
      await batch.commit();
    }
    logger.info(
      `[vertex:firestore:${id}] deleteChunks OK namespace=${namespace} count=${ids.length} elapsedMs=${Date.now() - startedAt}`
    );
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logger.error(
      `[vertex:firestore:${id}] deleteChunks FAILED namespace=${namespace} count=${ids.length} elapsedMs=${elapsedMs} message="${error.message}"`
    );
    throw error;
  }
}

module.exports = {
  isEnabled,
  getMeta,
  setMeta,
  setChunks,
  getChunksByIds,
  getStaleChunkIds,
  deleteChunks,
};
