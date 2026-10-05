const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const logger = require('../utils/logger');
const { DATA_DIR } = require('../utils/constants');
const { ensureDir } = require('../utils/helpers');
const vectorStoreService = require('./vectorStoreService');
const kbChunkUtils = require('./kbChunkUtils');
const kbLlmContext = require('./kbLlmContext');
const kbSearchQueryService = require('./kbSearchQueryService');
const intensiveConfig = require('../config/intensiveConfig');

const DEFAULT_PDF_PATH = path.join(process.cwd(), intensiveConfig.KNOWLEDGE_BASE_PATH);

const { TOKEN_BUDGET } = require('../config/tokenBudget');

const TOP_K = TOKEN_BUDGET.kbTopK;
const SEARCH_CONTEXT_MESSAGES = Number(process.env.KB_SEARCH_CONTEXT_MESSAGES) || 2;
const MIN_RESULTS = 1;
const BRIEF_ACK_PATTERN =
  /^(ok|okay|k|thanks|thank you|thanku|got it|understood|cool|nice|alright|fine|sure)[!.?\s]*$/i;

function teamStateKey(teamId) {
  return teamId ? String(teamId) : 'global';
}

const ingestLocks = new Map();
/** Per-team index job progress for dashboard polling. */
const indexJobs = new Map();

function idleIndexProgress() {
  return {
    status: 'idle',
    phase: null,
    percent: 0,
    done: 0,
    total: 0,
    message: null,
    error: null,
    startedAt: null,
    updatedAt: null,
  };
}

class KnowledgeBaseService {
  constructor() {
    this.teamStates = new Map();
  }

  getTeamState(teamId) {
    const key = teamStateKey(teamId);
    if (!this.teamStates.has(key)) {
      this.teamStates.set(key, { loaded: false, sourcePath: null, chunkCount: 0 });
    }
    return this.teamStates.get(key);
  }

  resolveSourcePath() {
    return process.env.KNOWLEDGE_BASE_PATH || DEFAULT_PDF_PATH;
  }

  setSourcePath(relativeOrAbsolutePath) {
    if (!relativeOrAbsolutePath) return;
    const state = this.getTeamState(null);
    state.sourcePath = relativeOrAbsolutePath;
    process.env.KNOWLEDGE_BASE_PATH = relativeOrAbsolutePath;
  }

  getIndexProgress(teamId = null) {
    return indexJobs.get(teamStateKey(teamId)) || idleIndexProgress();
  }

  beginIndexJob(teamId = null, message = 'Starting index…') {
    const key = teamStateKey(teamId);
    const now = new Date().toISOString();
    indexJobs.set(key, {
      status: 'indexing',
      phase: 'queued',
      percent: 1,
      done: 0,
      total: 0,
      message,
      error: null,
      startedAt: now,
      updatedAt: now,
    });
    return this.getIndexProgress(teamId);
  }

  updateIndexProgress(teamId = null, patch = {}) {
    const key = teamStateKey(teamId);
    const prev = indexJobs.get(key) || this.beginIndexJob(teamId);
    const next = {
      ...prev,
      ...patch,
      status: patch.status || prev.status || 'indexing',
      updatedAt: new Date().toISOString(),
    };
    if (Number.isFinite(Number(patch.done)) && Number.isFinite(Number(patch.total)) && patch.total > 0) {
      const phaseBase =
        patch.phase === 'upserting' ? 55 : patch.phase === 'embedding' ? 25 : patch.phase === 'parsing' ? 5 : 10;
      const phaseSpan =
        patch.phase === 'upserting' ? 40 : patch.phase === 'embedding' ? 30 : patch.phase === 'parsing' ? 15 : 20;
      next.percent = Math.min(
        99,
        Math.round(phaseBase + (phaseSpan * Number(patch.done)) / Number(patch.total))
      );
    } else if (Number.isFinite(Number(patch.percent))) {
      next.percent = Math.max(0, Math.min(100, Math.round(Number(patch.percent))));
    }
    indexJobs.set(key, next);
    return next;
  }

  completeIndexJob(teamId = null, { chunkCount = 0 } = {}) {
    const key = teamStateKey(teamId);
    const prev = indexJobs.get(key) || idleIndexProgress();
    indexJobs.set(key, {
      ...prev,
      status: 'ready',
      phase: 'complete',
      percent: 100,
      done: chunkCount || prev.done || 0,
      total: chunkCount || prev.total || 0,
      message: chunkCount
        ? `Indexed ${chunkCount} vectors`
        : 'Index complete',
      error: null,
      updatedAt: new Date().toISOString(),
    });
  }

  failIndexJob(teamId = null, errorMessage = 'Indexing failed') {
    const key = teamStateKey(teamId);
    const prev = indexJobs.get(key) || idleIndexProgress();
    indexJobs.set(key, {
      ...prev,
      status: 'error',
      phase: 'error',
      percent: prev.percent || 0,
      message: errorMessage,
      error: errorMessage,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Always resolve the configured KB path (avoids stale in-memory sourcePath). */
  syncTeamSourcePath(teamId = null) {
    const effective = this.resolveSourcePath(teamId);
    const state = this.getTeamState(teamId);
    state.sourcePath = effective;
    return effective;
  }

  normalizeQuery(text) {
    return (text || '').trim();
  }

  /**
   * WhatsApp sometimes puts raw image bytes/base64 into message.body as a "caption".
   * That must never be sent to the LLM or treated as student text.
   */
  looksLikeBinaryOrBase64Caption(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/^data:image\//i.test(t)) return true;
    if (/^\/9j\//i.test(t)) return true; // JPEG base64
    if (/^iVBOR/i.test(t)) return true; // PNG base64
    if (/^R0lGOD/i.test(t)) return true; // GIF base64
    if (/^UklGR/i.test(t)) return true; // WEBP/RIFF
    if (t.length > 400 && !/\s/.test(t.slice(0, 120))) return true;
    if (
      t.length > 300 &&
      /^[A-Za-z0-9+/=\r\n]+$/.test(t.slice(0, 800)) &&
      !/\b(error|assignment|fee|exam|please|screenshot|portal|login)\b/i.test(t.slice(0, 400))
    ) {
      return true;
    }
    return false;
  }

  sanitizeMediaCaption(caption) {
    const t = String(caption || '').trim();
    if (!t || this.looksLikeBinaryOrBase64Caption(t)) return '';
    return t.length > 1000 ? t.slice(0, 1000) : t;
  }

  isMediaNotice(text) {
    return /\[Student sent an [^\]]+\]/i.test(String(text || ''));
  }

  /**
   * True when the turn is only media notice(s) with no real student question text.
   * These must follow the system prompt image rules and must NOT hit KB retrieval.
   */
  isMediaOnlyNotice(text) {
    const raw = this.normalizeQuery(text);
    if (!this.isMediaNotice(raw)) return false;

    const rest = raw
      .replace(/The student sent \d+ messages[\s\S]*?Treat them as one turn\./gi, ' ')
      .replace(/Message\s+\d+:\s*/gi, ' ')
      .replace(/\[Student sent an [^\]]+\]/gi, ' ')
      .replace(/No text caption was included\.?/gi, ' ')
      .replace(/Follow the system prompt rules[\s\S]*$/gi, ' ')
      .replace(/Caption \/ message:\s*/gi, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .trim();

    if (!rest) return true;
    if (this.looksLikeBinaryOrBase64Caption(rest)) return true;
    if (rest.length < 12 && !rest.includes('?')) return true;
    return false;
  }

  buildFocusedSearchQuery(text) {
    return this.normalizeQuery(text);
  }

  isBriefAcknowledgment(text) {
    return BRIEF_ACK_PATTERN.test((text || '').trim());
  }

  isCasualOnly(text) {
    const query = this.normalizeQuery(text).toLowerCase();
    if (!query) return true;
    if (this.isMediaOnlyNotice(query)) return true;
    if (this.isBriefAcknowledgment(query)) return true;
    // Greetings / small-talk must never enter Intensive KB mode.
    return /^(hi+|hello|hey+|hola|namaste|namaskar|yo|wassup|what'?s\s*up|whats\s*up|good\s+(morning|afternoon|evening|night)|how\s+are\s+you|how\s+r\s+u|how(?:'|’)re\s+you|hru|hiya)(?:\s+(?:mam|ma'?am|madam|sir|anna|akka|bro|boss|team|ji))?[!.,?\s]*$/i.test(
      query
    );
  }

  isFollowUpMessage(text) {
    const query = this.normalizeQuery(text).toLowerCase();
    if (!query || this.isBriefAcknowledgment(query)) return false;
    if (query.length > 140) return false;

    const followUpPatterns = [
      /^what about\b/,
      /^and\b/,
      /^how about\b/,
      /^tell me more\b/,
      /^also\b/,
      /^same\b/,
      /^then\b/,
      /^eppudu\b/,
      /^appudu\b/,
      /\?$/,
    ];
    return followUpPatterns.some((pattern) => pattern.test(query));
  }

  shouldUseKnowledgeBase(text, recentMessages = []) {
    const query = this.normalizeQuery(text).toLowerCase();
    if (!query || this.isCasualOnly(query)) return false;
    if (this.isMediaOnlyNotice(query)) return false;

    if (query.includes('?')) return true;

    const words = query.split(/\s+/).filter(Boolean);
    // Need a real question footprint — do not flip to KB just because recent
    // Intensive history exists (that caused greetings like "Hello mam" to RAG).
    if (words.length >= 4) return true;
    if (words.length >= 3 && this.isFollowUpMessage(query)) return true;
    if (words.length >= 2 && this.isFollowUpMessage(query)) return true;

    return false;
  }

  async resolveSearchTopK(_teamId = null) {
    const envTopK = Number(process.env.KB_TOP_K);
    if (Number.isFinite(envTopK) && envTopK > 0) return envTopK;
    return TOP_K > 0 ? TOP_K : 8;
  }

  /** Wider top-K for batched multi-message turns, since results are merged across
   *  several per-message searches and need more headroom than a single query. */
  resolveMultiMessageTopK() {
    const envTopK = Number(process.env.KB_MULTI_MESSAGE_TOP_K);
    return Number.isFinite(envTopK) && envTopK > 0 ? envTopK : 10;
  }

  buildSearchQuery(text, recentMessages = []) {
    const query = this.normalizeQuery(text);
    if (!query) return '';

    // Never merge prior KB answers into greeting/small-talk searches.
    if (this.isCasualOnly(query) || !recentMessages.length) return query;

    // Standalone questions should search as-is. Only short follow-ups need
    // prior-turn context prepended; otherwise unrelated history hijacks retrieval.
    const words = query.split(/\s+/).filter(Boolean);
    const looksStandalone =
      words.length >= 5 || (query.includes('?') && words.length >= 3);
    if (looksStandalone && !this.isFollowUpMessage(query.toLowerCase())) {
      return query;
    }

    const recent = recentMessages
      .slice(-SEARCH_CONTEXT_MESSAGES)
      .map((msg) => msg.content?.trim())
      .filter(Boolean)
      .join(' ');

    return `${recent} ${query}`.replace(/\s+/g, ' ').trim();
  }

  filterResultsForContext(results = [], topK = TOP_K) {
    if (!results.length) return [];
    const limit = topK > 0 ? topK : results.length;
    return results.slice(0, limit);
  }

  mergeSearchResults(resultLists, { topK }) {
    const minScore = Number(process.env.KB_MIN_SEARCH_SCORE) || 0;
    const byRecord = new Map();

    for (const results of resultLists) {
      if (!results?.length) continue;
      for (const item of results) {
        const key = item.recordId || `${(item.text || '').slice(0, 160)}`;
        const prev = byRecord.get(key);
        byRecord.set(key, {
          ...(prev || {}),
          ...item,
          score: Math.max(prev?.score || 0, item.score || 0),
          semanticScore: Math.max(prev?.semanticScore || 0, item.semanticScore || 0),
          sparseScore: Math.max(prev?.sparseScore || 0, item.sparseScore || 0),
          hitCount: (prev?.hitCount || 0) + 1,
        });
      }
    }

    const ranked = [...byRecord.values()]
      .filter((item) => item.text)
      .sort((a, b) => b.score - a.score);

    const aboveMin =
      minScore > 0 ? ranked.filter((item) => item.score >= minScore) : ranked;
    const pool = aboveMin.length >= MIN_RESULTS ? aboveMin : ranked;

    return pool.slice(0, topK);
  }

  async buildEnglishSearchQueries(query, recentMessages = [], options = {}) {
    const rawQuestion = this.normalizeQuery(query);
    const contextualQueryOriginal = this.buildSearchQuery(query, recentMessages) || rawQuestion;
    const contextualQuery = await kbSearchQueryService.toEnglishKbSearchQuery(
      contextualQueryOriginal,
      options
    );
    const question = this.buildFocusedSearchQuery(
      contextualQuery !== contextualQueryOriginal
        ? contextualQuery
        : await kbSearchQueryService.toEnglishKbSearchQuery(rawQuestion, options)
    );
    return { rawQuestion, contextualQueryOriginal, contextualQuery, question };
  }

  async searchKnowledge(teamId, query, recentMessages = [], options = {}) {
    const translatedFragments = Array.isArray(options.translatedFragments)
      ? options.translatedFragments.filter(Boolean)
      : null;

    // Batched multi-message turn: search per-message (each keeps its own translated
    // intent) plus once more on the concatenation of all of them, then merge/dedupe/rank
    // the combined pool — reusing mergeSearchResults exactly as the single-query path does.
    if (translatedFragments && translatedFragments.length > 1) {
      const topK = this.resolveMultiMessageTopK();
      const fetchK = Math.max(topK * 2, 12);
      const resultLists = [];
      for (const fragmentQuery of translatedFragments) {
        resultLists.push(await vectorStoreService.hybridSearch(teamId, fragmentQuery, fetchK));
      }
      const concatenatedQuery = translatedFragments.join(' ');
      resultLists.push(await vectorStoreService.hybridSearch(teamId, concatenatedQuery, fetchK));
      return this.mergeSearchResults(resultLists, { topK });
    }

    const precomputed = options.precomputedSearch;
    const { rawQuestion, contextualQueryOriginal, contextualQuery, question } =
      precomputed?.contextualQuery
        ? {
            rawQuestion: this.normalizeQuery(query),
            contextualQueryOriginal:
              precomputed.contextualQueryOriginal || this.normalizeQuery(query),
            contextualQuery: precomputed.contextualQuery,
            question: this.buildFocusedSearchQuery(precomputed.contextualQuery),
          }
        : await this.buildEnglishSearchQueries(query, recentMessages, options);
    const topK = await this.resolveSearchTopK(teamId);
    const fetchK = Math.max(topK * 2, 12);
    const multiQuerySearch =
      String(process.env.KB_MULTI_QUERY_SEARCH ?? 'true').toLowerCase() !== 'false';
    const wasTranslated =
      Boolean(contextualQuery) &&
      Boolean(contextualQueryOriginal) &&
      contextualQuery.trim() !== contextualQueryOriginal.trim();

    const resultLists = [];
    const primaryQuery = contextualQuery || question;
    resultLists.push(await vectorStoreService.hybridSearch(teamId, primaryQuery, fetchK));
    if (!multiQuerySearch) {
      return this.mergeSearchResults(resultLists, { topK });
    }
    if (question && question !== contextualQuery) {
      resultLists.push(await vectorStoreService.hybridSearch(teamId, question, fetchK));
    }
    if (
      !wasTranslated &&
      rawQuestion &&
      rawQuestion !== question &&
      rawQuestion !== contextualQuery &&
      rawQuestion !== contextualQueryOriginal
    ) {
      resultLists.push(await vectorStoreService.hybridSearch(teamId, rawQuestion, fetchK));
    }

    return this.mergeSearchResults(resultLists, { topK });
  }

  async syncTeamStateFromVectorStore(teamId = null) {
    const state = this.getTeamState(teamId);
    if (state.loaded && (state.chunkCount || 0) > 0) {
      return true;
    }
    try {
      const chunkCount = await vectorStoreService.getChunkCount(teamId);
      if (chunkCount > 0) {
        state.loaded = true;
        // Never downgrade in-memory count when meta is briefly stale after re-index.
        state.chunkCount = Math.max(state.chunkCount || 0, chunkCount);
        return true;
      }
    } catch (error) {
      logger.warn(`KB sync failed (team=${teamId ?? 'global'}): ${error.message}`);
    }
    return state.loaded && (state.chunkCount || 0) > 0;
  }

  async resolveKbTeam() {
    await this.initialize(false, null);
    await this.syncTeamStateFromVectorStore(null);

    if (this.isReady(null)) {
      logger.info('KB enabled scope=global');
      return { useKb: true, kbTeamId: null, requestedTeamId: null, reason: 'kb', scope: 'global' };
    }

    logger.info('KB not ready scope=global — prompt-only');
    return {
      useKb: false,
      kbTeamId: null,
      requestedTeamId: null,
      reason: 'kb_not_indexed',
      globalChunkCount: 0,
    };
  }

  isReady(teamId = null) {
    const state = this.getTeamState(teamId);
    return state.loaded && (state.chunkCount || 0) > 0;
  }

  async getChatKbStatus(teamId = null, ownerPhone = null) {
    const kbTeam = await this.resolveKbTeam(teamId, ownerPhone);
    const statusTeamId = kbTeam.useKb ? kbTeam.kbTeamId : teamId;
    const status = await this.getStatus(statusTeamId ?? null);

    return {
      ...status,
      appliesToChat: kbTeam.useKb,
      chatBlockReason: kbTeam.useKb ? null : kbTeam.reason,
      kbScope: kbTeam.scope ?? null,
      globalChunkCount: kbTeam.globalChunkCount ?? null,
      botTeamId: teamId,
    };
  }

  async retrieveKnowledge(query, recentMessages = [], teamId = null, ownerPhone = null, options = {}) {
    const normalizedQuery = this.normalizeQuery(query);
    const apiKey = options.apiKey || process.env.OPENAI_API_KEY || null;

    const baseSearchOptions = { apiKey, usageContext: options.usageContext };

    const messageFragments = Array.isArray(options.messageFragments)
      ? options.messageFragments.map((f) => this.normalizeQuery(f)).filter(Boolean)
      : [];
    const isMultiMessage = messageFragments.length > 1;

    let contextualQueryOriginal;
    let contextualQuery;
    let translatedFragments = null;

    if (isMultiMessage) {
      // Translate each batched message individually instead of the whole
      // "Message 1:...Message 2:..." wrapper blob as one opaque string.
      translatedFragments = [];
      for (const fragment of messageFragments) {
        translatedFragments.push(
          await kbSearchQueryService.toEnglishKbSearchQuery(fragment, baseSearchOptions)
        );
      }
      contextualQueryOriginal = messageFragments.join(' ');
      contextualQuery = translatedFragments.join(' ');
    } else {
      const precomputed = options.precomputedSearch;
      ({ contextualQueryOriginal, contextualQuery } = precomputed?.contextualQuery
        ? {
            contextualQueryOriginal: precomputed.contextualQueryOriginal || normalizedQuery,
            contextualQuery: precomputed.contextualQuery,
          }
        : await this.buildEnglishSearchQueries(query, recentMessages, baseSearchOptions));
    }

    const searchOptions = {
      ...baseSearchOptions,
      precomputedSearch: { contextualQuery, contextualQueryOriginal },
      translatedFragments,
    };
    const kbTeam = await this.resolveKbTeam(teamId, ownerPhone);

    if (!kbTeam.useKb) {
      const mode =
        kbTeam.reason === 'not_team_admin'
          ? 'not_team_admin'
          : kbTeam.reason === 'team_kb_empty' || kbTeam.reason === 'kb_not_indexed'
            ? 'kb_not_found'
            : 'prompt_only';

      return {
        context: null,
        retrieval: {
          mode,
          reason: kbTeam.reason,
          query: normalizedQuery,
          searchQuery: contextualQuery,
          searchQueryOriginal: contextualQueryOriginal || normalizedQuery,
          translatedSearchQuery:
            contextualQuery !== (contextualQueryOriginal || normalizedQuery) ? contextualQuery : null,
          focusedQuery: normalizedQuery,
          kbTeamId: kbTeam.kbTeamId,
          requestedTeamId: kbTeam.requestedTeamId,
          globalChunkCount: kbTeam.globalChunkCount ?? null,
          topK: 0,
          hitCount: 0,
          chunkCount: 0,
          chunks: [],
        },
      };
    }

    const activeTeamId = kbTeam.kbTeamId;
    const topK = isMultiMessage
      ? this.resolveMultiMessageTopK()
      : await this.resolveSearchTopK(activeTeamId);
    const results = await this.searchKnowledge(activeTeamId, query, recentMessages, searchOptions);
    const filtered = this.filterResultsForContext(results, topK);
    const searchMeta = {
      searchQueryOriginal: contextualQueryOriginal || normalizedQuery,
      translatedSearchQuery:
        contextualQuery !== (contextualQueryOriginal || normalizedQuery) ? contextualQuery : null,
    };

    if (filtered.length < MIN_RESULTS) {
      logger.warn(
        `KB retrieval empty for "${normalizedQuery.slice(0, 80)}" (hits=${results.length})`
      );
      return {
        context: null,
        retrieval: {
          mode: 'kb_miss',
          reason: results.length > 0 ? 'below_min_score' : 'no_hits',
          query: normalizedQuery,
          searchQuery: contextualQuery,
          ...searchMeta,
          focusedQuery: this.buildFocusedSearchQuery(query),
          kbTeamId: activeTeamId,
          requestedTeamId: teamId,
          topK,
          hitCount: results.length,
          chunkCount: 0,
          chunks: [],
        },
      };
    }

    const llmContextResult = kbLlmContext.buildLlmContext(filtered, {
      queryText: contextualQuery || normalizedQuery,
    });

    if (llmContextResult.topicMismatch) {
      logger.warn(
        `KB topic mismatch for "${normalizedQuery.slice(0, 80)}" (hits=${filtered.length})`
      );
      return {
        context: llmContextResult.context,
        retrieval: {
          mode: 'kb_topic_mismatch',
          reason: 'topic_alignment_failed',
          query: normalizedQuery,
          searchQuery: contextualQuery,
          ...searchMeta,
          focusedQuery: this.buildFocusedSearchQuery(query),
          kbTeamId: activeTeamId,
          requestedTeamId: teamId,
          topK,
          hitCount: results.length,
          chunkCount: 0,
          chunks: [],
          hybrid: true,
        },
      };
    }

    return {
      context: llmContextResult.context,
      retrieval: {
        mode: 'kb',
        query: normalizedQuery,
        searchQuery: contextualQuery,
        ...searchMeta,
        focusedQuery: this.buildFocusedSearchQuery(query),
        kbTeamId: activeTeamId,
        requestedTeamId: teamId,
        topK,
        hitCount: results.length,
        chunkCount: filtered.length,
        chunks: kbLlmContext.buildChunkMeta(filtered),
        hybrid: true,
      },
    };
  }

  async getRelevantContext(query, recentMessages = [], teamId = null, ownerPhone = null) {
    const result = await this.retrieveKnowledge(query, recentMessages, teamId, ownerPhone);
    return result.context;
  }

  async hydrateFromVectorStore(teamId = null) {
    const state = this.getTeamState(teamId);
    try {
      await vectorStoreService.loadFromDisk(teamId);
      const chunkCount = await vectorStoreService.getChunkCount(teamId);
      if (chunkCount > 0) {
        state.loaded = true;
        state.chunkCount = chunkCount;
        return true;
      }
    } catch (error) {
      logger.warn(`KB hydrate from vector store failed (team=${teamId ?? 'global'}): ${error.message}`);
    }
    return false;
  }

  async parsePdf(filePath) {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text || '';
  }

  async loadSourceText(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.txt' || ext === '.json') {
      return fs.readFileSync(filePath, 'utf8');
    }
    return this.parsePdf(filePath);
  }

  async indexSourceText(teamId, fullText, sourceHash) {
    this.updateIndexProgress(teamId, {
      phase: 'parsing',
      percent: 8,
      message: 'Parsing KB and expanding variations…',
    });
    return vectorStoreService.indexDocument(teamId, fullText, sourceHash, {
      onProgress: (progress) => this.updateIndexProgress(teamId, progress),
    });
  }

  async initialize(force = false, teamId = null) {
    const key = teamStateKey(teamId);
    if (ingestLocks.has(key)) return ingestLocks.get(key);

    const run = this._initialize(force, teamId);
    ingestLocks.set(key, run);
    try {
      return await run;
    } finally {
      ingestLocks.delete(key);
    }
  }

  async _initialize(force = false, teamId = null) {
    const state = this.getTeamState(teamId);
    const sourcePath = this.syncTeamSourcePath(teamId);
    const tracking = force || indexJobs.get(teamStateKey(teamId))?.status === 'indexing';

    if (!force && state.loaded && (state.chunkCount || 0) > 0) return true;
    if (force) {
      state.loaded = false;
      state.chunkCount = 0;
      if (!indexJobs.get(teamStateKey(teamId)) || indexJobs.get(teamStateKey(teamId)).status !== 'indexing') {
        this.beginIndexJob(teamId, 'Re-indexing knowledge base…');
      }
    }

    const pdfPath = path.resolve(sourcePath);
    const sourceExists = fs.existsSync(pdfPath);

    try {
      ensureDir(DATA_DIR);

      if (await this.hydrateFromVectorStore(teamId)) {
        const sourceHash = sourceExists ? vectorStoreService.hashSource(pdfPath) : null;
        // Re-ingest whenever the KB file no longer matches the persisted index —
        // not just on an explicit force. This makes swapping the KB file take
        // effect on the next start with no manual re-index.
        if (sourceExists && !(await vectorStoreService.isIndexed(teamId, sourceHash))) {
          logger.info(`KB source changed for team=${teamId ?? 'global'} — re-ingesting`);
          if (!indexJobs.get(teamStateKey(teamId)) || indexJobs.get(teamStateKey(teamId)).status !== 'indexing') {
            this.beginIndexJob(teamId, 'Re-indexing knowledge base…');
          }
          this.updateIndexProgress(teamId, {
            phase: 'reading',
            percent: 5,
            message: 'Reading knowledge base file…',
          });
          const fullText = await this.loadSourceText(pdfPath);
          const indexedCount = await this.indexSourceText(teamId, fullText, sourceHash);
          state.loaded = true;
          state.chunkCount = indexedCount || (await vectorStoreService.getChunkCount(teamId));
          this.completeIndexJob(teamId, { chunkCount: state.chunkCount });
          logger.info(
            `Vector KB re-indexed for team=${teamId ?? 'global'} (${state.chunkCount} chunks)`
          );
          return true;
        }
        const stats = await vectorStoreService.getStats(teamId);
        logger.info(
          `Vector KB loaded for team=${teamId ?? 'global'} (${stats.chunkCount} chunks, backend=${stats.backend})`
        );
        if (tracking) this.completeIndexJob(teamId, { chunkCount: state.chunkCount });
        return true;
      }

      if (!sourceExists) {
        logger.warn(`Knowledge base file not found for team=${teamId ?? 'global'} at ${pdfPath}`);
        if (tracking) this.failIndexJob(teamId, 'Knowledge base file not found');
        return false;
      }

      const sourceHash = vectorStoreService.hashSource(pdfPath);
      await vectorStoreService.loadFromDisk(teamId);

      if (await vectorStoreService.isIndexed(teamId, sourceHash)) {
        state.loaded = true;
        state.chunkCount = await vectorStoreService.getChunkCount(teamId);
        const stats = await vectorStoreService.getStats(teamId);
        logger.info(
          `Vector KB loaded for team=${teamId ?? 'global'} (${stats.chunkCount} chunks, backend=${stats.backend})`
        );
        if (tracking) this.completeIndexJob(teamId, { chunkCount: state.chunkCount });
        return true;
      }

      logger.info(`Parsing KB and building vector index for team=${teamId ?? 'global'}...`);
      this.updateIndexProgress(teamId, {
        phase: 'reading',
        percent: 5,
        message: 'Reading knowledge base file…',
      });
      const fullText = await this.loadSourceText(pdfPath);
      const indexedCount = await this.indexSourceText(teamId, fullText, sourceHash);
      state.loaded = true;
      state.chunkCount = indexedCount || (await vectorStoreService.getChunkCount(teamId));
      logger.info(
        `Vector KB ready for team=${teamId ?? 'global'} (${state.chunkCount} chunks indexed)`
      );
      if (tracking) this.completeIndexJob(teamId, { chunkCount: state.chunkCount });
      return true;
    } catch (error) {
      logger.error(`Knowledge base initialization failed (team=${teamId ?? 'global'}): ${error.message}`);
      if (tracking) this.failIndexJob(teamId, error.message);
      return false;
    }
  }

  async getStatus(teamId = null) {
    const state = this.getTeamState(teamId);
    await this.syncTeamStateFromVectorStore(teamId);
    const stats = await vectorStoreService.getStats(teamId);
    const chunkCount = stats.chunkCount || state.chunkCount || 0;
    const ready = state.loaded && chunkCount > 0;
    const topK = await this.resolveSearchTopK(teamId);
    return {
      loaded: state.loaded,
      ready,
      mode: 'hybrid',
      backend: stats.backend || (vectorStoreService.usePinecone() ? 'pinecone' : 'local'),
      namespace: stats.namespace || teamStateKey(teamId),
      teamId: teamId || null,
      chunkCount,
      topK,
      indexedAt: stats.indexedAt,
      sourcePath: this.syncTeamSourcePath(teamId),
      vectorStorePath: stats.storePath,
      versions: stats.versions,
      metric: stats.metric || null,
      dimensions: stats.dimensions || null,
      indexing: this.getIndexProgress(teamId),
    };
  }

  async refresh(teamId = null) {
    const key = teamStateKey(teamId);
    if (ingestLocks.has(key)) return ingestLocks.get(key);

    const run = this._refresh(teamId);
    ingestLocks.set(key, run);
    try {
      return await run;
    } finally {
      ingestLocks.delete(key);
    }
  }

  async _refresh(teamId = null) {
    const state = this.getTeamState(teamId);
    const sourcePath = this.syncTeamSourcePath(teamId);

    const pdfPath = path.resolve(sourcePath);
    const sourceExists = fs.existsSync(pdfPath);

    try {
      ensureDir(DATA_DIR);

      if (!sourceExists) {
        return this.hydrateFromVectorStore(teamId);
      }

      const sourceHash = vectorStoreService.hashSource(pdfPath);

      // Cheap short-circuit: this scheduler ticks every few seconds, and the
      // full reload below re-parses the whole vector store JSON and rebuilds
      // the TF-IDF vocabulary from scratch — a synchronous, event-loop-blocking
      // cost that has nothing to do with whether the KB actually changed.
      // Skip it entirely when the already-loaded index matches the source file.
      if (state.loaded && vectorStoreService.getLoadedSourceHash(teamId) === sourceHash) {
        return true;
      }

      await vectorStoreService.loadFromDisk(teamId);

      if (await vectorStoreService.isIndexed(teamId, sourceHash)) {
        state.loaded = true;
        state.chunkCount = await vectorStoreService.getChunkCount(teamId);
        return true;
      }

      logger.info(`KB source changed for team=${teamId ?? 'global'} ΓÇö re-ingesting`);
      return this._initialize(true, teamId);
    } catch (error) {
      logger.warn(`KB refresh failed (team=${teamId ?? 'global'}): ${error.message}`);
      return false;
    }
  }

  async refreshAll() {
    await this.refresh(null);
  }
}

module.exports = new KnowledgeBaseService();
