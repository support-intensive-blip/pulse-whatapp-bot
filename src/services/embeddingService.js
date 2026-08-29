const logger = require('../utils/logger');
const pineconeClient = require('./pineconeClient');
const intensiveConfig = require('../config/intensiveConfig');

const VECTOR_DIM = 512;
const BATCH_SIZE = 32;

class EmbeddingService {
  constructor() {
    this.idfMap = new Map();
    this.docCount = 0;
  }

  usePineconeInference() {
    // 'local' backend must stay fully in-server — never call Pinecone's hosted
    // embedding API even if PINECONE_* env vars are present.
    if (intensiveConfig.VECTOR_BACKEND === 'local') return false;
    return pineconeClient.isEnabled();
  }

  tokenize(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2);
  }

  buildIdf(corpus) {
    this.docCount = corpus.length;
    const docFreq = new Map();

    for (const doc of corpus) {
      const seen = new Set(this.tokenize(doc));
      for (const token of seen) {
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
      }
    }

    this.idfMap = new Map();
    for (const [token, freq] of docFreq.entries()) {
      this.idfMap.set(token, Math.log((1 + this.docCount) / (1 + freq)) + 1);
    }

    logger.info(`Built TF-IDF vocabulary (${this.idfMap.size} tokens) for local vector fallback`);
  }

  hashToken(token, slot) {
    let hash = slot;
    for (let i = 0; i < token.length; i += 1) {
      hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
    }
    return hash % VECTOR_DIM;
  }

  embedTextLocal(text) {
    const tokens = this.tokenize(text);
    const vec = new Float32Array(VECTOR_DIM);
    const tf = new Map();

    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    for (const [token, count] of tf.entries()) {
      const weight = (1 + Math.log(count)) * (this.idfMap.get(token) || 1);
      vec[this.hashToken(token, 0)] += weight;
      vec[this.hashToken(token, 1)] += weight * 0.5;
    }

    let norm = 0;
    for (let i = 0; i < VECTOR_DIM; i += 1) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < VECTOR_DIM; i += 1) vec[i] /= norm;

    return Array.from(vec);
  }

  async embedText(text, { inputType = 'query' } = {}) {
    if (!text) return null;
    if (this.usePineconeInference()) {
      if (inputType === 'query') {
        return pineconeClient.embedQuery(text);
      }
      const vectors = await pineconeClient.embedTexts([text], {
        inputType: pineconeClient.WRITE_INPUT_TYPE,
      });
      return vectors[0] || null;
    }

    const prepared =
      inputType === 'query'
        ? pineconeClient.formatQueryText(text)
        : pineconeClient.formatPassageText(text);
    return this.embedTextLocal(prepared);
  }

  async embedBatch(texts) {
    if (this.usePineconeInference()) {
      return pineconeClient.embedTexts(texts, { inputType: 'passage' });
    }
    return texts.map((text) => this.embedTextLocal(text));
  }

  async embedAll(texts, onProgress) {
    if (this.usePineconeInference()) {
      const results = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        results.push(
          ...(await pineconeClient.embedTexts(batch, {
            inputType: pineconeClient.WRITE_INPUT_TYPE,
          }))
        );
        if (onProgress) onProgress(Math.min(i + batch.length, texts.length), texts.length);
      }
      return results;
    }

    const prepared = texts.map((text) => pineconeClient.formatPassageText(text));
    this.buildIdf(prepared);
    const results = [];
    for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
      const batch = prepared.slice(i, i + BATCH_SIZE);
      results.push(...batch.map((text) => this.embedTextLocal(text)));
      if (onProgress) onProgress(Math.min(i + batch.length, texts.length), texts.length);
    }
    return results;
  }
}

let embeddingServiceInstance = null;

function getEmbeddingService() {
  if (!embeddingServiceInstance) {
    embeddingServiceInstance = new EmbeddingService();
  }
  return embeddingServiceInstance;
}

function resetEmbeddingService() {
  embeddingServiceInstance = null;
}

module.exports = {
  EmbeddingService,
  getEmbeddingService,
  resetEmbeddingService,
};
