/**
 * KB chunking, in priority order:
 *  1. Pre-chunked JSON array (chunk_id/type/embed_text/metadata) — one record = one chunk/variation.
 *  2. Delimiter-based (##QA## / ##END##) — one entry = one chunk.
 *  3. QUESTION_ID blocks without ##QA## markers.
 *  4. Token-budget splitting for legacy PDFs without any QA structure.
 */

const PINECONE_MAX_INPUT_TOKENS = Number(process.env.PINECONE_MAX_INPUT_TOKENS) || 507;
const MAX_CHUNK_TOKENS = Math.min(
  Number(process.env.KB_CHUNK_MAX_TOKENS) || 500,
  PINECONE_MAX_INPUT_TOKENS
);
const CHUNK_OVERLAP_TOKENS = Number(process.env.KB_CHUNK_OVERLAP_TOKENS) || 50;
const CHARS_PER_TOKEN = Number(process.env.KB_CHARS_PER_TOKEN) || 4;
const MIN_QA_ENTRY_CHARS = Number(process.env.KB_MIN_QA_ENTRY_CHARS) || 50;

const QA_START = '##QA##';
const QA_END = '##END##';

const STRUCTURAL_BOUNDARY =
  /(?=(?:^|\n)(?:#{1,6}\s+\S|-{3,}\s*$|\d+(?:\.\d+)*[.)]\s+\S))/gm;

const SENTENCE_SPLIT = /(?<=[.!?…])\s+(?=[A-Z0-9*"●•(-])|(?<=\n)\s*(?=[●•*-]\s)/;

const FIELD_LINE = /^([A-Z][A-Z0-9_]*):\s*(.*)$/;

function estimateTokens(text) {
  const clean = String(text || '').trim();
  if (!clean) return 0;
  const words = clean.split(/\s+/).filter(Boolean).length;
  const charEst = Math.ceil(clean.length / CHARS_PER_TOKEN);
  return Math.max(words, charEst);
}

/** Strip TAGS / SCOPE_NOTE from text used for embedding and BM25 (kept as metadata). */
function chunkForEmbedding(rawEntry) {
  return String(rawEntry || '')
    .replace(/^TAGS:.*$/gm, '')
    .replace(/^SCOPE_NOTE:.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractField(entryText, fieldName) {
  const re = new RegExp(`^${fieldName}:\\s*(.*)$`, 'im');
  const match = String(entryText || '').match(re);
  return match ? match[1].trim() : null;
}

function extractQuestionVariations(entryText) {
  const lines = String(entryText || '').split('\n');
  let inBlock = false;
  const variations = [];

  for (const line of lines) {
    const fieldMatch = line.match(FIELD_LINE);
    if (fieldMatch) {
      if (fieldMatch[1].toUpperCase() === 'QUESTION_VARIATIONS') {
        inBlock = true;
        const inline = fieldMatch[2].trim();
        if (inline) variations.push(inline);
        continue;
      }
      if (inBlock) break;
      continue;
    }

    if (!inBlock) continue;
    const bullet = line.replace(/^[-*•]\s*/, '').trim();
    if (bullet) variations.push(bullet);
  }

  return [...new Set(variations.filter((v) => v.length > 1))];
}

function parseTags(entryText) {
  const raw = extractField(entryText, 'TAGS');
  if (!raw) return [];
  return [...new Set(raw.split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

function parseQaEntry(entryText) {
  const raw = String(entryText || '').trim();
  const embedText = chunkForEmbedding(raw);
  return {
    text: embedText,
    embedText,
    questionId: extractField(raw, 'QUESTION_ID'),
    tags: parseTags(raw),
    variations: extractQuestionVariations(raw),
    version: detectChunkVersion(raw),
    tokenEstimate: estimateTokens(embedText),
  };
}

/**
 * Pre-chunked JSON KB format: a JSON array of records, one per QA "main" entry
 * or per question "variation", grouped by metadata.question_id.
 *
 *   { "chunk_id": "100DOC-001::main", "type": "main", "embed_text": "...",
 *     "metadata": { "question_id": "100DOC-001", "canonical_question": "...",
 *                    "answer": "...", "tags": [...] } }
 *   { "chunk_id": "100DOC-001::var_0", "type": "variation", "embed_text": "...",
 *     "metadata": { "question_id": "100DOC-001", ... } }
 *
 * "main" embed_text is the dense chunk vector (question + answer already merged
 * by the author); "variation" embed_text is a single alternate phrasing that
 * resolves back to the same parent recordId, exactly like QUESTION_VARIATIONS
 * bullets in the ##QA## text format.
 */
function isJsonKbArray(fullText) {
  return String(fullText || '').trimStart().startsWith('[');
}

function chunkDocumentFromJson(fullText) {
  if (!isJsonKbArray(fullText)) return null;

  let records;
  try {
    records = JSON.parse(fullText);
  } catch {
    return null;
  }
  if (!Array.isArray(records) || !records.length) return null;
  if (!records.every((r) => r && typeof r === 'object' && r.metadata)) return null;

  const groups = new Map();
  const order = [];

  for (const record of records) {
    const meta = record.metadata || {};
    const questionId = String(
      meta.question_id || String(record.chunk_id || '').split('::')[0] || ''
    ).trim();
    if (!questionId) continue;

    if (!groups.has(questionId)) {
      groups.set(questionId, { main: null, variations: [] });
      order.push(questionId);
    }
    const group = groups.get(questionId);

    if (String(record.type || '').toLowerCase() === 'variation') {
      const variationText = String(record.embed_text || '').trim();
      if (variationText.length > 1) group.variations.push(variationText);
    } else if (!group.main) {
      group.main = record;
    }
  }

  const chunks = [];
  let index = 0;
  for (const questionId of order) {
    const group = groups.get(questionId);
    if (!group.main) continue;

    const meta = group.main.metadata || {};
    const answer = String(meta.answer || '').trim();
    const rawEmbedText = String(group.main.embed_text || '').trim() || answer;
    const embedText = chunkForEmbedding(rawEmbedText);
    const tags = Array.isArray(meta.tags)
      ? [...new Set(meta.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
      : [];

    chunks.push({
      text: chunkForEmbedding(answer) || embedText,
      embedText,
      questionId,
      tags,
      variations: [...new Set(group.variations)],
      version: detectChunkVersion(answer || embedText),
      tokenEstimate: estimateTokens(embedText),
      chunkIndex: index++,
    });
  }

  return chunks.length ? chunks : null;
}

function splitQaEntries(fullText) {
  const normalized = String(fullText || '').replace(/\r\n/g, '\n').trim();
  if (!normalized.includes(QA_START)) return null;

  return normalized
    .split(QA_START)
    .map((segment) => {
      const entry = segment.split(QA_END)[0];
      const qidMatch = entry.search(/QUESTION_ID:/i);
      return qidMatch >= 0 ? entry.slice(qidMatch).trim() : '';
    })
    .filter((entry) => entry.length >= MIN_QA_ENTRY_CHARS);
}

/** Structured KB without ##QA## markers — one QUESTION_ID block = one chunk. */
function splitQuestionIdEntries(fullText) {
  const normalized = String(fullText || '').replace(/\r\n/g, '\n').trim();
  const qidCount = (normalized.match(/QUESTION_ID:/gi) || []).length;
  if (qidCount < 2) return null;

  const firstQid = normalized.search(/QUESTION_ID:/i);
  const body = firstQid >= 0 ? normalized.slice(firstQid) : normalized;

  return body
    .split(/(?=^QUESTION_ID:)/im)
    .map((segment) => {
      const qidMatch = segment.search(/QUESTION_ID:/i);
      return qidMatch >= 0 ? segment.slice(qidMatch).trim() : '';
    })
    .filter((entry) => entry.length >= MIN_QA_ENTRY_CHARS);
}

function chunkDocumentByQuestionIdBlocks(fullText) {
  const entries = splitQuestionIdEntries(fullText);
  if (!entries?.length) return null;

  return entries.map((entryText, index) => ({
    ...parseQaEntry(entryText),
    chunkIndex: index,
  }));
}

function chunkDocumentByQaDelimiters(fullText) {
  const entries = splitQaEntries(fullText);
  if (!entries?.length) return null;

  return entries.map((entryText, index) => ({
    ...parseQaEntry(entryText),
    chunkIndex: index,
  }));
}

function splitSemanticUnits(text) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  if (!normalized) return [];

  const sections = normalized.split(STRUCTURAL_BOUNDARY).map((s) => s.trim()).filter(Boolean);
  if (!sections.length && normalized) sections.push(normalized);
  const units = [];

  for (const section of sections) {
    if (estimateTokens(section) <= MAX_CHUNK_TOKENS) {
      units.push(section);
      continue;
    }

    const paragraphs = section.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    for (const para of paragraphs) {
      if (estimateTokens(para) <= MAX_CHUNK_TOKENS) {
        units.push(para);
        continue;
      }

      const sentences = para
        .split(SENTENCE_SPLIT)
        .map((s) => s.trim())
        .filter(Boolean);

      if (sentences.length <= 1) {
        units.push(para.slice(0, MAX_CHUNK_TOKENS * CHARS_PER_TOKEN));
        continue;
      }

      let buffer = '';
      for (const sentence of sentences) {
        const candidate = buffer ? `${buffer} ${sentence}` : sentence;
        if (estimateTokens(candidate) <= MAX_CHUNK_TOKENS) {
          buffer = candidate;
        } else {
          if (buffer) units.push(buffer);
          buffer =
            estimateTokens(sentence) > MAX_CHUNK_TOKENS
              ? sentence.slice(0, MAX_CHUNK_TOKENS * CHARS_PER_TOKEN)
              : sentence;
        }
      }
      if (buffer) units.push(buffer);
    }
  }

  return units;
}

function hardSplitByTokenBudget(text, maxTokens = MAX_CHUNK_TOKENS) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const parts = [];
  let buffer = [];

  for (const word of words) {
    const candidate = buffer.length ? [...buffer, word] : [word];
    if (estimateTokens(candidate.join(' ')) <= maxTokens) {
      buffer = candidate;
      continue;
    }

    if (buffer.length) parts.push(buffer.join(' '));
    buffer = estimateTokens(word) > maxTokens ? [] : [word];
    if (estimateTokens(word) > maxTokens) {
      const maxChars = maxTokens * CHARS_PER_TOKEN;
      for (let i = 0; i < word.length; i += maxChars) {
        parts.push(word.slice(i, i + maxChars));
      }
    }
  }

  if (buffer.length) parts.push(buffer.join(' '));
  return parts.filter(Boolean);
}

function enforceTokenBudget(chunks) {
  const out = [];
  for (const chunk of chunks) {
    if (estimateTokens(chunk) <= MAX_CHUNK_TOKENS) {
      out.push(chunk);
      continue;
    }
    out.push(...hardSplitByTokenBudget(chunk, MAX_CHUNK_TOKENS));
  }
  return out;
}

function mergeUnitsToChunks(units) {
  const chunks = [];
  let current = '';

  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (estimateTokens(candidate) <= MAX_CHUNK_TOKENS) {
      current = candidate;
    } else {
      if (current) chunks.push(current.trim());
      current = unit;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  if (chunks.length <= 1 || CHUNK_OVERLAP_TOKENS <= 0) {
    return chunks;
  }

  const overlapped = [chunks[0]];
  for (let i = 1; i < chunks.length; i += 1) {
    const prev = chunks[i - 1];
    const prevWords = prev.split(/\s+/);
    const overlapWords = Math.min(prevWords.length, Math.ceil(CHUNK_OVERLAP_TOKENS * 0.75));
    const tail = prevWords.slice(-overlapWords).join(' ');
    overlapped.push(`${tail}\n\n${chunks[i]}`.trim());
  }
  return overlapped;
}

function detectChunkVersion(chunk) {
  const match = String(chunk || '').match(/\bversion\s*([\d]+(?:\.[\d]+)?)\b/i);
  return match ? match[1] : 'general';
}

function chunkDocumentLegacy(fullText) {
  const units = splitSemanticUnits(fullText);
  const merged = mergeUnitsToChunks(units);
  const bounded = enforceTokenBudget(merged);
  return bounded.map((text, index) => {
    const embedText = chunkForEmbedding(text);
    return {
      text: embedText,
      embedText,
      chunkIndex: index,
      tokenEstimate: estimateTokens(embedText),
      version: detectChunkVersion(text),
      questionId: extractField(text, 'QUESTION_ID'),
      tags: parseTags(text),
      variations: extractQuestionVariations(text),
    };
  });
}

function chunkDocument(fullText) {
  const jsonChunks = chunkDocumentFromJson(fullText);
  if (jsonChunks?.length) return jsonChunks;
  const qaChunks = chunkDocumentByQaDelimiters(fullText);
  if (qaChunks?.length) return qaChunks;
  const qidChunks = chunkDocumentByQuestionIdBlocks(fullText);
  if (qidChunks?.length) return qidChunks;
  return chunkDocumentLegacy(fullText);
}

function chunkDocumentToTexts(fullText) {
  return chunkDocument(fullText).map((c) => c.embedText || c.text);
}

module.exports = {
  MAX_CHUNK_TOKENS,
  QA_START,
  QA_END,
  estimateTokens,
  chunkForEmbedding,
  chunkDocument,
  chunkDocumentFromJson,
  chunkDocumentToTexts,
  detectChunkVersion,
  extractQuestionVariations,
  parseQaEntry,
};
