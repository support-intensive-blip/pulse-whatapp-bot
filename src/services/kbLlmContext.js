/**
 * Prepare retrieved KB chunks into clean, deduplicated context for the LLM.
 * Includes a lightweight topic-alignment gate before injection.
 */

const { estimateTokens } = require('./kbSemanticChunker');

const LLM_CONTEXT_MAX_TOKENS = Number(process.env.KB_LLM_CONTEXT_MAX_TOKENS) || 2800;

const TOPIC_MISMATCH_CONTEXT = [
  '=== KNOWLEDGE BASE ===',
  'No relevant excerpt found for this query. Do not invent an answer.',
  'State that information is not available and offer a ticket if appropriate.',
  '=== END KNOWLEDGE BASE ===',
].join('\n');

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'must',
  'shall',
  'can',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'under',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'nor',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  'just',
  'and',
  'but',
  'if',
  'or',
  'because',
  'until',
  'while',
  'about',
  'against',
  'what',
  'which',
  'who',
  'whom',
  'this',
  'that',
  'these',
  'those',
  'am',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'him',
  'his',
  'she',
  'her',
  'it',
  'its',
  'they',
  'them',
  'their',
]);

function normalizeForDedup(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function deduplicateChunks(chunks) {
  const seen = new Set();
  const out = [];
  for (const chunk of chunks) {
    const key = normalizeForDedup(chunk.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(chunk);
  }
  return out;
}

function trimToTokenBudget(chunks, maxTokens) {
  const selected = [];
  let used = 0;
  for (const chunk of chunks) {
    const tokens = estimateTokens(chunk.text);
    if (used + tokens > maxTokens) break;
    selected.push(chunk);
    used += tokens;
  }
  return selected;
}

function extractKeywords(queryText) {
  return String(queryText || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function extractQuestionIdPrefix(questionId) {
  const match = String(questionId || '')
    .trim()
    .match(/^([A-Z]+)-\d+/i);
  return match ? match[1].toUpperCase() : null;
}

/** Prefix groups: query intent → acceptable QUESTION_ID prefixes for that intent. */
const DOMAIN_PREFIX_GROUPS = {
  PLACE: ['PLACE', 'JOBS', 'PA', 'PRF', 'LI', 'SC'],
  JOBS: ['PLACE', 'JOBS', 'PA'],
  OC: ['OC'],
  DS: ['DS', 'ST', 'SD', 'DL', 'GM', 'LO', 'LS', 'NM', 'TM'],
  GC: ['GC', 'SEQ', 'EA', 'NL', 'TU', 'NS', 'FE', 'CA', 'SK', 'PJ', 'CS', 'CC'],
  JT: ['JT', 'CP', 'CODE', 'JV', 'PR', 'EPD', 'TEC', 'CDS', 'AR', 'APP'],
  CERT: ['CERT', 'IRC', 'GRD'],
  REF: ['REF'],
  TECH: ['TECH', 'CP', 'CODE', 'CI'],
  PRF: ['PRF', 'PA', 'PLACE', 'LI'],
  TA: ['TA', 'ABR', 'SPC'],
  OB: ['OB'],
  // Catch-all extras that appear in the KB but lacked a domain home.
  MISC: ['NM', 'AIT', 'AM', 'APP', 'BKM', 'CC', 'CI', 'CS', 'DIS', 'JP', 'MG', 'NB', 'OTH', 'PD', 'PT', 'QB', 'TM'],
};

const QUERY_DOMAIN_PATTERNS = [
  // OC before PLACE so "interview kit" / DSA are not swallowed by bare "interview".
  {
    domain: 'OC',
    pattern:
      /\b(dsa|data\s*structures?|algorithms?|competitive\s*program|xpm|exponential\s*performance|aptitude|english\s*session|other\s*courses?|mindset|(?:python|java|frontend|sql|mern)?\s*interview\s*kit|interview\s*kit|spoken\s*skills?)/i,
  },
  {
    domain: 'PLACE',
    pattern:
      /\b(placement|placements?|placed|on\s*hold|support\s*hold|job\s*opportunit|recruiter|salary|offer\s*letter|hiring\s*partner|apply\s*for\s*(?:a\s*)?job|shortlist|skill\s*profile|placement\s*support|16\s*months?)/i,
  },
  {
    domain: 'DS',
    pattern:
      /\b(daily\s*schedule|schedule\s*check|unlock\s*time|session\s*time|class\s*time|today'?s?\s*(class|session)|early\s*unlock|pending\s*for\s*today)/i,
  },
  {
    domain: 'GC',
    pattern: /\b(growth\s*cycle|gc\s*\d|gc1|gc2|gc3|gc4|fundamentals\s*exam)/i,
  },
  {
    domain: 'JT',
    pattern:
      /\b(job\s*track|mern|java\s*full\s*stack|python\s*full\s*stack|track\s*select|da\s*track|qa\s*track|specialization)/i,
  },
  {
    domain: 'CERT',
    pattern: /\b(certificate|certification|cert\b|irc\b|grade|overall\s*course\s*completion)/i,
  },
  {
    domain: 'REF',
    pattern: /\b(referral|refer\s*(a\s*)?friend|refearn|refer\s*and\s*earn)/i,
  },
  {
    domain: 'TECH',
    pattern:
      /\b(technical\s*issue|portal\s*(not\s*)?working|login\s*issue|bug|error|playground|code\s*playground|run\s*button|test\s*case)/i,
  },
  {
    domain: 'PRF',
    pattern: /\b(nxtwave\s*profile|profile\s*update|resume|portfolio\s*profile)/i,
  },
  {
    domain: 'TA',
    pattern: /\b(target\s*audience|who\s*is\s*this\s*for|intensive\s*for\s*whom)/i,
  },
  {
    domain: 'OB',
    pattern: /\b(orientation|onboarding|getting\s*started|first\s*week)/i,
  },
];

function inferQueryDomains(queryText) {
  const domains = new Set();
  for (const { domain, pattern } of QUERY_DOMAIN_PATTERNS) {
    if (pattern.test(String(queryText || ''))) domains.add(domain);
  }
  // Interview kits are OC even if "interview" co-occurs with placement words.
  if (/\binterview\s*kit\b/i.test(String(queryText || ''))) {
    domains.add('OC');
    domains.delete('PLACE');
  }
  return domains;
}

function allowedPrefixesForQueryDomains(queryDomains) {
  const allowed = new Set();
  for (const domain of queryDomains) {
    const prefixes = DOMAIN_PREFIX_GROUPS[domain] || [domain];
    for (const prefix of prefixes) allowed.add(prefix);
  }
  return allowed;
}

function chunkMatchesQueryDomain(chunk, queryDomains) {
  if (!queryDomains.size) return true;

  const prefix = extractQuestionIdPrefix(chunk.questionId || chunk.metadata?.questionId);
  if (!prefix) return true;

  const allowed = allowedPrefixesForQueryDomains(queryDomains);
  return allowed.has(prefix);
}

function isChunkRelevant(chunk, queryKeywords) {
  if (!queryKeywords.length) return true;

  const questionId = chunk.questionId || chunk.metadata?.questionId || '';
  const chunkText = `${chunk.text || ''} ${questionId}`.toLowerCase();
  // Require at least one meaningful keyword hit; prefer denser overlap when available.
  const hits = queryKeywords.filter((kw) => chunkText.includes(kw)).length;
  if (hits >= 1) return true;
  // High-scoring retrieval hits can survive without exact keyword overlap.
  const score = Number(chunk.score || chunk.semanticScore || 0);
  return score >= 0.35;
}

function formatChunkForLlm(chunk, index) {
  const score = typeof chunk.score === 'number' ? chunk.score.toFixed(3) : '—';
  const lines = [`Excerpt ${index + 1} (relevance ${score}):`, chunk.text.trim()];
  return lines.join('\n');
}

function buildLlmContext(chunks, { maxTokens = LLM_CONTEXT_MAX_TOKENS, queryText = '' } = {}) {
  if (!chunks?.length) return { context: null, topicMismatch: false };

  const queryKeywords = extractKeywords(queryText);
  const queryDomains = inferQueryDomains(queryText);

  let relevant = chunks.filter(
    (chunk) =>
      isChunkRelevant(chunk, queryKeywords) && chunkMatchesQueryDomain(chunk, queryDomains)
  );

  // Soft fallback: if domain/keyword gating wiped everything but retrieval
  // returned strong hits, keep the top 2 instead of forcing a hard miss.
  // This avoids inventing answers after false-negative domain tags (e.g.
  // interview-kit queries wrongly tagged PLACE).
  if (!relevant.length && chunks.length) {
    const ranked = [...chunks].sort(
      (a, b) => Number(b.score || b.semanticScore || 0) - Number(a.score || a.semanticScore || 0)
    );
    const topScore = Number(ranked[0]?.score || ranked[0]?.semanticScore || 0);
    if (topScore >= 0.25) {
      relevant = ranked.slice(0, 2);
    }
  }

  if (!relevant.length) {
    return { context: TOPIC_MISMATCH_CONTEXT, topicMismatch: true };
  }

  const deduped = deduplicateChunks(relevant);
  const trimmed = trimToTokenBudget(deduped, maxTokens);
  if (!trimmed.length) {
    return { context: TOPIC_MISMATCH_CONTEXT, topicMismatch: true };
  }

  const header =
    'Use the following knowledge base excerpts to answer. Prefer excerpt content over general knowledge. If excerpts do not cover the question, say you are not sure. If the student message is ambiguous between multiple cases, ask one short clarifying question before giving a long procedure.';
  const body = trimmed.map((chunk, i) => formatChunkForLlm(chunk, i)).join('\n\n');
  return {
    context: `${header}\n\n${body}`,
    topicMismatch: false,
  };
}

function buildChunkMeta(chunks) {
  return chunks.map((item, index) => {
    const text = item.text || '';
    return {
      rank: index + 1,
      chunkId: item.id ?? item.recordId ?? index + 1,
      recordId: item.recordId || null,
      questionId: item.questionId || null,
      score: typeof item.score === 'number' ? Number(item.score.toFixed(4)) : null,
      semanticScore:
        typeof item.semanticScore === 'number' ? Number(item.semanticScore.toFixed(4)) : null,
      sparseScore:
        typeof item.sparseScore === 'number' ? Number(item.sparseScore.toFixed(4)) : null,
      hitCount: item.hitCount || 1,
      preview: text.slice(0, 220),
      text: text.slice(0, 2000),
      truncated: text.length > 2000,
    };
  });
}

module.exports = {
  LLM_CONTEXT_MAX_TOKENS,
  TOPIC_MISMATCH_CONTEXT,
  extractKeywords,
  extractQuestionIdPrefix,
  inferQueryDomains,
  chunkMatchesQueryDomain,
  isChunkRelevant,
  buildLlmContext,
  buildChunkMeta,
};
