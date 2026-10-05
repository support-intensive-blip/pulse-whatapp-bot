const MIN_TEXT_LENGTH_TO_SPLIT = 120;

function splitIntoUnits(text) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function groupIntoChunks(units, maxChunks) {
  const totalLength = units.reduce((sum, u) => sum + u.length, 0);
  const targetLength = Math.ceil(totalLength / maxChunks);

  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const unit of units) {
    current.push(unit);
    currentLength += unit.length;
    if (currentLength >= targetLength && chunks.length < maxChunks - 1) {
      chunks.push(current.join(' '));
      current = [];
      currentLength = 0;
    }
  }
  if (current.length) chunks.push(current.join(' '));

  return chunks;
}

/**
 * Splits a reply into up to `maxChunks` shorter WhatsApp messages along
 * sentence/paragraph boundaries, so a long reply reads as a natural burst
 * of texts instead of one wall of text. Short or single-sentence replies
 * are returned unsplit.
 */
function splitReplyIntoChunks(text, { maxChunks = 3, minChunkLength = 40 } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.length < MIN_TEXT_LENGTH_TO_SPLIT || maxChunks <= 1) return [trimmed];

  const units = splitIntoUnits(trimmed);
  if (units.length <= 1) return [trimmed];

  let chunks = groupIntoChunks(units, maxChunks);

  // Merge a trailing chunk that's too short into its neighbor.
  while (chunks.length > 1 && chunks[chunks.length - 1].length < minChunkLength) {
    const last = chunks.pop();
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${last}`;
  }

  return chunks;
}

module.exports = { splitReplyIntoChunks };
