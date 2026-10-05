const fs = require('fs');
const crypto = require('crypto');
const {
  chunkDocumentToTexts,
  detectChunkVersion,
  estimateTokens,
  MAX_CHUNK_TOKENS,
} = require('./kbSemanticChunker');

function hashSource(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

function extractSearchKeywords(query) {
  const stopwords = new Set([
    'coach',
    'the',
    'and',
    'for',
    'when',
    'does',
    'class',
    'start',
    'what',
    'how',
    'where',
    'which',
    'about',
    'please',
    'tell',
    'explain',
    'this',
    'that',
    'with',
    'from',
    'your',
  ]);

  return [...new Set(tokenize(query))].filter(
    (token) => token.length > 2 && !stopwords.has(token)
  );
}

function keywordOverlapScore(query, text) {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;

  const t = new Set(tokenize(text));
  if (t.size === 0) return 0;

  let overlap = 0;
  q.forEach((token) => {
    if (t.has(token)) overlap += 1;
  });

  return overlap / q.size;
}

/** @deprecated use kbSemanticChunker.chunkDocumentToTexts */
function splitIntoChunks(text) {
  return chunkDocumentToTexts(text);
}

module.exports = {
  hashSource,
  detectChunkVersion,
  splitIntoChunks,
  chunkDocumentToTexts,
  estimateTokens,
  MAX_CHUNK_TOKENS,
  tokenize,
  keywordOverlapScore,
  extractSearchKeywords,
};
