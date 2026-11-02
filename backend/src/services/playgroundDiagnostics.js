/**
 * Turns a playground debug trace into something a bot admin can act on:
 * structured KB chunks (QUESTION_ID / CANONICAL_QUESTION / ...) and a list of
 * findings saying what to fix — knowledge base, prompt, temperature, or retrieval.
 * Pure rules, no LLM call, so it is free and deterministic.
 */

const KB_FIELDS = ['QUESTION_ID', 'SECTION', 'CANONICAL_QUESTION', 'QUESTION_VARIATIONS', 'ANSWER', 'TAGS'];
const FIELD_RE = new RegExp(`\\b(${KB_FIELDS.join('|')}):`, 'g');

const STOP_WORDS = new Set(
  'a an the is are was were be to of in on for and or with what how when where why who which do does did i my me you your can could will would should it this that there about from at as by im am'.split(
    ' '
  )
);

// Replies where the model says it has no answer even though KB text was supplied.
const NO_ANSWER_RE =
  /\b(i\s+(?:do\s+not|don['’]t)\s+have|not\s+(?:in|available\s+in)\s+my|i['’]?m\s+not\s+sure|no\s+information|couldn['’]t\s+find|could\s+not\s+find|please\s+check\s+(?:your|the)\s+(?:learning\s+)?portal|contact\s+(?:the\s+)?support)\b/i;

function parseKbChunk(text) {
  const out = {};
  const source = String(text || '');
  const marks = [...source.matchAll(FIELD_RE)];
  marks.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : source.length;
    out[m[1]] = source.slice(start, end).trim();
  });
  const variations = out.QUESTION_VARIATIONS
    ? out.QUESTION_VARIATIONS.split(/\s*\*\s+|\n+/).map((v) => v.trim()).filter(Boolean)
    : [];
  return {
    questionId: out.QUESTION_ID || null,
    section: out.SECTION || null,
    canonicalQuestion: out.CANONICAL_QUESTION || null,
    variations,
    answer: out.ANSWER || null,
  };
}

function describeChunk(chunk) {
  const parsed = parseKbChunk(chunk.text || chunk.preview);
  return {
    rank: chunk.rank ?? null,
    questionId: chunk.questionId || parsed.questionId,
    section: parsed.section,
    canonicalQuestion: parsed.canonicalQuestion,
    variations: parsed.variations,
    answer: parsed.answer,
    score: chunk.score ?? null,
    semanticScore: chunk.semanticScore ?? null,
    sparseScore: chunk.sparseScore ?? null,
    text: chunk.text || chunk.preview || '',
    truncated: Boolean(chunk.truncated),
  };
}

function contentWords(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

function overlap(a, b) {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  wa.forEach((w) => {
    if (wb.has(w)) shared += 1;
  });
  return shared / Math.min(wa.size, wb.size);
}

/** Emails, links and phone numbers in the reply that appear nowhere in what the model was given. */
function findUngroundedFacts(reply, groundingText) {
  const haystack = String(groundingText || '').toLowerCase();
  const patterns = [
    /[\w.+-]+@[\w-]+\.[\w.]+/g,
    /https?:\/\/[^\s)]+|\bwww\.[^\s)]+/g,
    /(?:\+?91[\s-]?)?\b[6-9]\d{9}\b/g,
  ];
  const facts = new Set();
  for (const re of patterns) {
    for (const match of String(reply || '').match(re) || []) {
      const value = match.replace(/[.,;:!?]+$/, '');
      if (!haystack.includes(value.toLowerCase())) facts.add(value);
    }
  }
  return [...facts];
}

function label(chunk) {
  const id = chunk.questionId || `chunk #${chunk.rank ?? '?'}`;
  const score = typeof chunk.score === 'number' ? ` (score ${chunk.score})` : '';
  return `${id}${chunk.canonicalQuestion ? ` — "${chunk.canonicalQuestion}"` : ''}${score}`;
}

function diagnose({ studentMessage, reply, usedDraft, kbMeta, debug, chunks, candidates }) {
  const findings = [];
  const add = (severity, area, title, detail, fix) => findings.push({ severity, area, title, detail, fix });

  const query = kbMeta?.translatedSearchQuery || kbMeta?.searchQuery || studentMessage;
  const llm = debug?.llm || null;
  const mode = kbMeta?.mode || null;

  if (debug?.shortCircuit === 'brief_ack') {
    add(
      'info',
      'retrieval',
      'Answered as a brief acknowledgement',
      `"${studentMessage}" was treated as "ok/thanks", so the model was not called and the reply is the fixed "Got it!".`,
      'If this is a real question, the brief-acknowledgement detector (knowledgeBaseService.isBriefAcknowledgment) is too eager for this phrasing.'
    );
    return findings;
  }

  if (usedDraft) {
    add('info', 'prompt', 'Draft prompt in use', 'This reply used the unpublished draft prompt, not the live one.', 'Publish the draft when you are happy with the results.');
  }

  if (kbMeta?.translatedSearchQuery) {
    add(
      'info',
      'retrieval',
      'Message was rewritten before search',
      `"${kbMeta.searchQueryOriginal}" → "${kbMeta.translatedSearchQuery}". Both the KB search and the model saw the rewritten text.`,
      'If the rewrite changed the meaning, add the original phrasing as a QUESTION_VARIATION so it matches directly.'
    );
  }

  if (debug?.kb && !debug.kb.available) {
    add(
      'error',
      'knowledge',
      'No knowledge base available',
      `KB not used (${debug.kb.unavailableReason}). The reply came from the prompt alone.`,
      'Link a knowledge document to this bot and re-index it from the Knowledge Base tab.'
    );
  } else if (debug?.kb && !debug.kb.usedForMessage) {
    add(
      'warning',
      'retrieval',
      `KB skipped — conversation classified as "${debug.context?.label || debug.context?.mode}"`,
      `Context mode: ${debug.context?.mode}${debug.context?.reason ? ` (reason: ${debug.context.reason})` : ''}. KB search only runs in Intensive mode.`,
      'If this was a program question, the context classifier misread it: include program keywords, or adjust contextService rules.'
    );
  } else if (mode === 'kb_miss') {
    const top = candidates[0];
    if (!candidates.length) {
      add(
        'error',
        'knowledge',
        'Nothing in the KB matched',
        `Search for "${query}" returned no entries.`,
        `Add a QUESTION_ID block for this question, with "${studentMessage}" as a QUESTION_VARIATION.`
      );
    } else {
      add(
        'error',
        'knowledge',
        'KB matches were too weak and were dropped',
        `Closest entry: ${label(top)}${debug?.kb?.minScore ? `; KB_MIN_SEARCH_SCORE is ${debug.kb.minScore}` : ''}.`,
        `If ${top.questionId || 'that entry'} is the right answer, add "${studentMessage}" to its QUESTION_VARIATIONS. Otherwise add a new entry. Lower KB_MIN_SEARCH_SCORE only as a last resort.`
      );
    }
  } else if (mode === 'kb_topic_mismatch') {
    add(
      'error',
      'knowledge',
      'Matches were rejected as a different topic',
      `Search found entries, but none passed the topic check for "${query}". Closest: ${candidates.slice(0, 3).map(label).join('; ') || 'n/a'}.`,
      'Add a dedicated entry for this topic, or put the topic words of this question into the right entry\'s CANONICAL_QUESTION / variations.'
    );
  } else if (mode === 'kb' && chunks.length) {
    const top = chunks[0];
    const sim = overlap(query, `${top.canonicalQuestion || ''} ${top.variations.join(' ')}`);
    if (top.canonicalQuestion && sim < 0.2) {
      add(
        'warning',
        'knowledge',
        'Top match looks unrelated to the question',
        `Ranked #1: ${label(top)} — it shares almost no key words with "${query}".`,
        'Check whether the correct entry exists. If it does, add this phrasing as a variation so it outranks the others; if not, add it.'
      );
    }
    if (NO_ANSWER_RE.test(reply)) {
      add(
        'warning',
        'knowledge',
        'KB was supplied but the bot said it has no answer',
        `The model received ${chunks.length} chunk(s) (top: ${label(top)}) and still declined.`,
        'Either the retrieved chunks do not contain the answer (fix or add the KB entry), or the prompt\'s "do not invent" wording is too strict for this case.'
      );
    }
  }

  if (!debug?.kb?.contextChars && llm && typeof llm.temperatureSent === 'number' && llm.temperatureSent >= 0.5) {
    add(
      'warning',
      'temperature',
      `Answered without KB at temperature ${llm.temperatureSent}`,
      'With no KB context the model is improvising, and a high temperature makes invented details more likely.',
      'Lower NO_KB_TEMPERATURE (for example 0.3) for steadier fallbacks, and fix the missing KB entry above.'
    );
  }
  if (llm && llm.temperatureSent === null) {
    add(
      'info',
      'temperature',
      `${llm.model} ignores the temperature setting`,
      `The pipeline asked for ${llm.temperatureRequested}, but this model only accepts its default, so it was not sent.`,
      'Changing CHAT_TEMPERATURE / NO_KB_TEMPERATURE has no effect with this model; fix behaviour through the prompt or KB.'
    );
  }

  const invented = findUngroundedFacts(reply, debug?.systemPrompt);
  if (invented.length) {
    add(
      'error',
      'prompt',
      'Reply contains details not found in the prompt or KB',
      `Not present in anything the model was given: ${invented.join(', ')}.`,
      'These were likely invented. Add the correct value to the KB or prompt, or tell the prompt never to give contact details that are not in the KB.'
    );
  }

  if (llm?.finishReason === 'length') {
    add('error', 'model', 'Reply was cut off', 'The model hit its output token limit.', 'Ask for shorter replies in the prompt, or raise the output limit.');
  }

  if (!findings.some((f) => f.severity !== 'info')) {
    add('success', 'overall', 'No problems detected', 'Retrieval, prompt and model settings look consistent for this reply.', 'If the answer is still wrong, compare the ANSWER text of the top chunk with the reply.');
  }

  return findings;
}

/** Builds the payload the playground "Inspect reply" drawer renders. */
function buildPlaygroundTrace({ studentMessage, reply, usedDraft, promptVersion, kbMeta, debug }) {
  const chunks = (kbMeta?.chunks || []).map(describeChunk);
  const candidates = (debug?.kb?.candidates || []).map(describeChunk);
  return {
    studentMessage,
    retrieval: {
      mode: kbMeta?.mode || null,
      reason: kbMeta?.reason || null,
      searchQueryOriginal: kbMeta?.searchQueryOriginal || studentMessage,
      translatedSearchQuery: kbMeta?.translatedSearchQuery || null,
      focusedQuery: kbMeta?.focusedQuery || null,
      topK: kbMeta?.topK ?? null,
      hitCount: kbMeta?.hitCount ?? 0,
      minScore: debug?.kb?.minScore ?? null,
      usedForMessage: debug?.kb?.usedForMessage ?? null,
      contextChars: debug?.kb?.contextChars ?? 0,
      chunks,
      // On a hit these duplicate `chunks`; on a miss / topic mismatch they are the near-misses.
      rejectedCandidates: chunks.length ? [] : candidates,
    },
    prompt: {
      source: usedDraft ? 'draft' : 'published',
      version: promptVersion,
      systemPrompt: debug?.systemPrompt || null,
      llmUserMessage: debug?.llmUserMessage || null,
      messages: (debug?.messages || []).map((m) => ({ role: m.role, content: m.content })),
    },
    context: debug?.context || null,
    model: debug?.llm
      ? { ...debug.llm, temperatureRule: debug.temperatureRule }
      : null,
    structured: debug?.structured || null,
    shortCircuit: debug?.shortCircuit || null,
    findings: diagnose({ studentMessage, reply, usedDraft, kbMeta, debug, chunks, candidates }),
  };
}

module.exports = { buildPlaygroundTrace, parseKbChunk, findUngroundedFacts };
