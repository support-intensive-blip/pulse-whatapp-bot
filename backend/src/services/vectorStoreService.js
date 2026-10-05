const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { DATA_DIR } = require('../utils/constants');
const { ensureDir } = require('../utils/helpers');
const { getEmbeddingService, resetEmbeddingService } = require('./embeddingService');
const kbChunkUtils = require('./kbChunkUtils');
const kbSemanticChunker = require('./kbSemanticChunker');
const kbIndexRecords = require('./kbIndexRecords');
const kbBm25Index = require('./kbBm25Index');
const pineconeClient = require('./pineconeClient');
const kbHybridSearch = require('./kbHybridSearch');
const pineconeVectorStore = require('./pineconeVectorStore');
const vertexVectorStore = require('./vertexVectorStore');
const intensiveConfig = require('../config/intensiveConfig');

const GLOBAL_STORE_PATH = path.join(process.cwd(), DATA_DIR, 'kb_vectors.json');
const MIN_SEARCH_SCORE = Number(process.env.KB_MIN_SEARCH_SCORE) || 0.05;

function teamKey(teamId) {
  return teamId ? String(teamId) : 'global';
}

function localStorePath(teamId) {
  if (teamId) {
    return path.join(process.cwd(), DATA_DIR, `kb_vectors_team_${teamId}.json`);
  }
  return GLOBAL_STORE_PATH;
}

function buildChunkRecords(fullText, sourceHash) {
  return kbIndexRecords.expandChunksToIndexRecords(
    kbSemanticChunker.chunkDocument(fullText),
    sourceHash
  );
}

class LocalTeamVectorStore {
  constructor(teamId) {
    this.teamId = teamId;
    this.chunks = [];
    this.sourceHash = null;
    this.indexedAt = null;
  }

  getStorePath() {
    return localStorePath(this.teamId);
  }

  loadFromDisk() {
    const storePath = this.getStorePath();
    if (!fs.existsSync(storePath)) return false;

    try {
      const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      this.chunks = data.chunks || [];
      this.sourceHash = data.sourceHash || null;
      this.indexedAt = data.indexedAt || null;
      if (this.chunks.length > 0) {
        resetEmbeddingService();
        getEmbeddingService().buildIdf(this.chunks.map((chunk) => chunk.text));
      }
      return this.chunks.length > 0;
    } catch (error) {
      logger.error(`Failed to load vector store (${storePath}): ${error.message}`);
      return false;
    }
  }

  saveToDisk() {
    ensureDir(DATA_DIR);
    fs.writeFileSync(
      this.getStorePath(),
      JSON.stringify({
        sourceHash: this.sourceHash,
        indexedAt: this.indexedAt,
        chunkCount: this.chunks.length,
        chunks: this.chunks,
      })
    );
  }

  get chunkCount() {
    return this.chunks.length;
  }

  isIndexed(sourceHash) {
    return this.sourceHash === sourceHash && this.chunks.length > 0;
  }

  async indexDocument(fullText, sourceHash) {
    const records = buildChunkRecords(fullText, sourceHash);
    const texts = records.map((r) => r.embedText || r.text);
    if (!texts.length) return 0;

    kbBm25Index.indexChunks(
      this.teamId,
      records.map((record) => ({ ...record, text: record.embedText || record.text })),
      sourceHash
    );

    logger.info(`Indexing ${texts.length} KB vectors into local store (${this.getStorePath()})...`);
    resetEmbeddingService();
    const embedder = getEmbeddingService();
    const embeddings = await embedder.embedAll(texts, (done, total) => {
      if (done % 32 === 0 || done === total) {
        logger.info(`Embedding progress: ${done}/${total}`);
      }
    });

    this.chunks = records.map((record, index) => ({
      text: record.text,
      version: record.version,
      embedding: embeddings[index],
      recordId: record.recordId || record.id,
      chunkIndex: record.chunkIndex,
      questionId: record.questionId || null,
    }));

    this.sourceHash = sourceHash;
    this.indexedAt = new Date().toISOString();
    this.saveToDisk();

    logger.info(`Local vector store indexed ${this.chunks.length} semantic chunks`);
    return this.chunks.length;
  }

  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async searchDense(query, topK = 8) {
    if (this.chunks.length === 0) return [];

    const embedder = getEmbeddingService();
    const queryEmbedding = await embedder.embedText(query, { inputType: 'query' });
    if (!queryEmbedding) return [];

    return this.chunks
      .map((chunk, index) => ({
        recordId: chunk.recordId || String(index),
        id: chunk.recordId || index + 1,
        chunkIndex: chunk.chunkIndex ?? index,
        text: chunk.text,
        version: chunk.version,
        semanticScore: this.cosineSimilarity(queryEmbedding, chunk.embedding),
        sparseScore: 0,
      }))
      .filter((item) => item.semanticScore >= MIN_SEARCH_SCORE)
      .sort((a, b) => b.semanticScore - a.semanticScore)
      .slice(0, topK);
  }

  getStats() {
    const versionCounts = {};
    for (const chunk of this.chunks) {
      versionCounts[chunk.version] = (versionCounts[chunk.version] || 0) + 1;
    }

    return {
      chunkCount: this.chunks.length,
      storePath: this.getStorePath(),
      versions: Object.entries(versionCounts).map(([version, count]) => ({ version, count })),
      indexedAt: this.indexedAt,
      sourceHash: this.sourceHash,
      backend: 'local-hybrid',
      namespace: teamKey(this.teamId),
    };
  }
}

class VectorStoreService {
  constructor() {
    this.localStores = new Map();
  }

  /**
   * 'vertex' | 'pinecone' | 'local'. Single-tenant default is 'local' (in-server
   * hybrid index, no external service) — see src/config/intensiveConfig.js.
   * Opt back into a hosted store only by setting VECTOR_BACKEND=vertex|pinecone.
   */
  activeBackend() {
    const backend = intensiveConfig.VECTOR_BACKEND;
    if (backend === 'vertex' || backend === 'pinecone') return backend;
    return 'local';
  }

  usePinecone() {
    return this.activeBackend() === 'pinecone';
  }

  useVertex() {
    return this.activeBackend() === 'vertex';
  }

  remoteStore() {
    return this.useVertex() ? vertexVectorStore : pineconeVectorStore;
  }

  getLocalStore(teamId) {
    const key = teamKey(teamId);
    if (!this.localStores.has(key)) {
      this.localStores.set(key, new LocalTeamVectorStore(teamId || null));
    }
    return this.localStores.get(key);
  }

  hashSource(filePath) {
    return kbChunkUtils.hashSource(filePath);
  }

  async loadFromDisk(teamId = null) {
    kbBm25Index.loadFromDisk(teamId);
    if (this.activeBackend() !== 'local') return (await this.remoteStore().getChunkCount(teamId)) > 0;
    return this.getLocalStore(teamId).loadFromDisk();
  }

  async getChunkCount(teamId = null) {
    if (this.activeBackend() !== 'local') return this.remoteStore().getChunkCount(teamId);
    return this.getLocalStore(teamId).chunkCount;
  }

  async isIndexed(teamId, sourceHash) {
    if (this.activeBackend() !== 'local') return this.remoteStore().isIndexed(teamId, sourceHash);
    return this.getLocalStore(teamId).isIndexed(sourceHash);
  }

  /** Source hash already held in memory for this team, with no disk read — lets
   *  callers skip a full reload when nothing has changed. Local backend only. */
  getLoadedSourceHash(teamId = null) {
    if (this.activeBackend() !== 'local') return null;
    return this.getLocalStore(teamId).sourceHash;
  }

  async indexDocument(teamId, fullText, sourceHash, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    onProgress?.({
      phase: 'parsing',
      percent: 10,
      message: 'Chunking QA entries…',
    });

    const chunks = kbSemanticChunker.chunkDocument(fullText);
    const bm25Records = chunks.map((chunk, index) => ({
      id: `${sourceHash.slice(0, 16)}-${chunk.chunkIndex ?? index}`,
      text: chunk.embedText || chunk.text,
      chunkIndex: chunk.chunkIndex ?? index,
      version: chunk.version || 'general',
    }));
    kbBm25Index.indexChunks(teamId, bm25Records, sourceHash);

    if (this.activeBackend() !== 'local') {
      return this.remoteStore().indexDocument(teamId, fullText, sourceHash, null, { onProgress });
    }
    return this.getLocalStore(teamId).indexDocument(fullText, sourceHash);
  }

  async hybridSearch(teamId, query, topK = 8) {
    const fetchK = Math.max(topK * 2, 12);
    let dense = [];

    if (this.activeBackend() !== 'local') {
      dense = await this.remoteStore().search(teamId, query, fetchK);
    } else {
      dense = await this.getLocalStore(teamId).searchDense(query, fetchK);
    }

    const sparse = kbBm25Index.search(teamId, query, fetchK);
    return kbHybridSearch.fuseHybridResults(dense, sparse, topK);
  }

  /** @deprecated use hybridSearch */
  async search(teamId, query, topK = 8) {
    return this.hybridSearch(teamId, query, topK);
  }

  async expandNeighborChunks(teamId, results, options = {}) {
    if (this.activeBackend() === 'local') return results;
    return this.remoteStore().expandNeighborChunks(teamId, results, options);
  }

  async getStats(teamId = null) {
    if (this.activeBackend() !== 'local') return this.remoteStore().getStats(teamId);
    return this.getLocalStore(teamId).getStats();
  }
}

module.exports = new VectorStoreService();
