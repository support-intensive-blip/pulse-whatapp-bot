/**
 * Expand semantic chunks into Pinecone/local index records (main chunk + question variations).
 */

function expandChunksToIndexRecords(chunks, sourceHash) {
  const hashPrefix = String(sourceHash || '').slice(0, 16);
  const records = [];

  for (const chunk of chunks) {
    const parentId = `${hashPrefix}-${chunk.chunkIndex}`;
    const answerText = chunk.text || chunk.embedText || '';
    const embedSource = chunk.embedText || chunk.text || '';

    records.push({
      id: parentId,
      recordId: parentId,
      text: answerText,
      embedText: embedSource,
      version: chunk.version || 'general',
      chunkIndex: chunk.chunkIndex,
      tokenEstimate: chunk.tokenEstimate,
      questionId: chunk.questionId || null,
      tags: chunk.tags || [],
      recordType: 'chunk',
    });

    for (const [variationIndex, variation] of (chunk.variations || []).entries()) {
      const trimmed = String(variation || '').trim();
      if (trimmed.length < 2) continue;

      records.push({
        id: `${parentId}_var_${variationIndex}`,
        recordId: parentId,
        text: answerText,
        embedText: trimmed,
        version: chunk.version || 'general',
        chunkIndex: chunk.chunkIndex,
        tokenEstimate: chunk.tokenEstimate,
        questionId: chunk.questionId || null,
        tags: chunk.tags || [],
        recordType: 'variation',
        variationIndex,
      });
    }
  }

  return records;
}

module.exports = {
  expandChunksToIndexRecords,
};
