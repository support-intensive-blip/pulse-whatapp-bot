/**
 * In-memory BM25 sparse index per team (persisted to disk for reload).
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { DATA_DIR } = require('../utils/constants');
const { ensureDir } = require('../utils/helpers');

const K1 = 1.5;
const B = 0.75;

function teamKey(teamId) {
  return teamId ? String(teamId) : 'global';
}

function storePath(teamId) {
  const key = teamKey(teamId);
  return path.join(process.cwd(), DATA_DIR, `kb_bm25_${key}.json`);
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

class Bm25Index {
  constructor() {
    this.docs = [];
    this.docLens = [];
    this.avgDocLen = 0;
    this.docFreq = new Map();
    this.sourceHash = null;
  }

  build(chunks, sourceHash) {
    this.docs = chunks.map((c, i) => ({
      id: c.id || String(i),
      text: c.text || '',
      tokens: tokenize(c.text),
      chunkIndex: c.chunkIndex ?? i,
      version: c.version || 'general',
    }));

    this.docLens = this.docs.map((d) => d.tokens.length);
    this.avgDocLen =
      this.docLens.reduce((sum, len) => sum + len, 0) / Math.max(this.docs.length, 1);

    this.docFreq = new Map();
    for (const doc of this.docs) {
      const seen = new Set(doc.tokens);
      for (const token of seen) {
        this.docFreq.set(token, (this.docFreq.get(token) || 0) + 1);
      }
    }
    this.sourceHash = sourceHash;
  }

  scoreQueryTokens(queryTokens, docIndex) {
    const doc = this.docs[docIndex];
    if (!doc || !queryTokens.length) return 0;

    const docLen = this.docLens[docIndex] || 1;
    const tf = new Map();
    for (const token of doc.tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    let score = 0;
    const N = this.docs.length;

    for (const term of queryTokens) {
      const freq = tf.get(term) || 0;
      if (!freq) continue;
      const df = this.docFreq.get(term) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const numerator = freq * (K1 + 1);
      const denominator = freq + K1 * (1 - B + (B * docLen) / Math.max(this.avgDocLen, 1));
      score += idf * (numerator / denominator);
    }

    return score;
  }

  search(query, topK = 10) {
    if (!this.docs.length) return [];
    const queryTokens = [...new Set(tokenize(query))];
    if (!queryTokens.length) return [];

    const maxBm25 = 10;
    const ranked = this.docs
      .map((doc, index) => {
        const raw = this.scoreQueryTokens(queryTokens, index);
        return {
          recordId: doc.id,
          id: doc.id,
          chunkIndex: doc.chunkIndex,
          text: doc.text,
          version: doc.version,
          sparseScore: raw,
          semanticScore: 0,
        };
      })
      .filter((item) => item.sparseScore > 0)
      .sort((a, b) => b.sparseScore - a.sparseScore)
      .slice(0, topK)
      .map((item) => ({
        ...item,
        sparseScore: Math.min(1, item.sparseScore / maxBm25),
      }));

    return ranked;
  }
}

const teamIndexes = new Map();

function getIndex(teamId) {
  const key = teamKey(teamId);
  if (!teamIndexes.has(key)) {
    teamIndexes.set(key, new Bm25Index());
  }
  return teamIndexes.get(key);
}

function saveToDisk(teamId) {
  const index = getIndex(teamId);
  if (!index.docs.length) return;
  ensureDir(DATA_DIR);
  fs.writeFileSync(
    storePath(teamId),
    JSON.stringify({
      sourceHash: index.sourceHash,
      docs: index.docs.map((d) => ({
        id: d.id,
        text: d.text,
        chunkIndex: d.chunkIndex,
        version: d.version,
      })),
    })
  );
}

function loadFromDisk(teamId) {
  const file = storePath(teamId);
  if (!fs.existsSync(file)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const index = getIndex(teamId);
    index.build(data.docs || [], data.sourceHash);
    return index.docs.length > 0;
  } catch (error) {
    logger.warn(`BM25 load failed (${file}): ${error.message}`);
    return false;
  }
}

function indexChunks(teamId, chunks, sourceHash) {
  const index = getIndex(teamId);
  index.build(chunks, sourceHash);
  saveToDisk(teamId);
  return index.docs.length;
}

function search(teamId, query, topK = 10) {
  return getIndex(teamId).search(query, topK);
}

function clear(teamId) {
  teamIndexes.delete(teamKey(teamId));
  try {
    fs.unlinkSync(storePath(teamId));
  } catch {
    // ignore
  }
}

module.exports = {
  indexChunks,
  search,
  loadFromDisk,
  clear,
  getDocCount(teamId) {
    return getIndex(teamId).docs.length;
  },
};
