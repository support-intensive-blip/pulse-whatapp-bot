/**
 * Fuse dense (vector) and sparse (BM25) retrieval via reciprocal rank fusion.
 */

const RRF_K = Number(process.env.KB_RRF_K) || 60;
const DENSE_WEIGHT = Number(process.env.KB_HYBRID_DENSE_WEIGHT) || 0.85;
const SPARSE_WEIGHT = Number(process.env.KB_HYBRID_SPARSE_WEIGHT) || 0.15;

function normalizeScores(items, scoreKey) {
  const max = Math.max(...items.map((i) => i[scoreKey] || 0), 0.0001);
  return items.map((item) => ({
    ...item,
    [`${scoreKey}Norm`]: (item[scoreKey] || 0) / max,
  }));
}

function reciprocalRankFusion(lists, weights) {
  const byId = new Map();

  lists.forEach((list, listIndex) => {
    const weight = weights[listIndex] ?? 1;
    list.forEach((item, rank) => {
      const id = item.recordId || item.id || `${rank}-${listIndex}`;
      const rrf = weight / (RRF_K + rank + 1);
      const prev = byId.get(id);
      if (prev) {
        prev.rrfScore += rrf;
        prev.semanticScore = Math.max(prev.semanticScore || 0, item.semanticScore || 0);
        prev.sparseScore = Math.max(prev.sparseScore || 0, item.sparseScore || 0);
        prev.hitCount = (prev.hitCount || 1) + 1;
        if (!prev.text && item.text) prev.text = item.text;
      } else {
        byId.set(id, {
          ...item,
          recordId: id,
          rrfScore: rrf,
          semanticScore: item.semanticScore || 0,
          sparseScore: item.sparseScore || 0,
          hitCount: 1,
        });
      }
    });
  });

  return [...byId.values()]
    .map((item) => {
      const denseNorm = item.semanticScoreNorm ?? item.semanticScore ?? 0;
      const sparseNorm = item.sparseScoreNorm ?? item.sparseScore ?? 0;
      const blended =
        denseNorm * DENSE_WEIGHT + sparseNorm * SPARSE_WEIGHT + (item.rrfScore || 0) * 0.15;
      return {
        ...item,
        score: blended,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function fuseHybridResults(denseResults, sparseResults, topK = 8) {
  const dense = normalizeScores(denseResults || [], 'semanticScore');
  const sparse = normalizeScores(sparseResults || [], 'sparseScore');
  const fused = reciprocalRankFusion([dense, sparse], [DENSE_WEIGHT, SPARSE_WEIGHT]);
  return fused.slice(0, topK);
}

module.exports = {
  fuseHybridResults,
  DENSE_WEIGHT,
  SPARSE_WEIGHT,
};
