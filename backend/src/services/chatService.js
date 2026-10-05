const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const pdfParse = require('pdf-parse');
const { getGroqClient } = require('../ai/groqClient');
const {
  getSystemPrompt,
  getSummarySystemPrompt,
} = require('../ai/systemPrompts');
const { sanitizeUserReply, parseStructuredReply } = require('../ai/replyRules');
const { actionItemService, ACTION_SOURCES } = require('./actionItemService');
const { MODEL_TIERS, getChatTemperature, getNoKbTemperature } = require('../config/modelConfig');
const { getTierForTask } = require('../config/tokenBudget');
const knowledgeBaseService = require('./knowledgeBaseService');
const { botAccountService } = require('./botAccountService');
const { TOKEN_CATEGORIES } = require('../config/tokenCategories');
const memoryService = require('./memoryService');
const { contextService, CONTEXT_MODES } = require('./contextService');
const chatProfileService = require('./chatProfileService');
const userService = require('./userService');
const logger = require('../utils/logger');
const { MESSAGE_ROLES, MESSAGE_SOURCES } = require('../utils/constants');
const {
  generateTempFilePath,
  safeDeleteFile,
  truncateText,
} = require('../utils/helpers');

class ChatService {
  polishReply(text) {
    return sanitizeUserReply((text || '').trim());
  }

  async buildSystemPrompt({
    chatProfile,
    contextNote,
    userMessage,
    recentHistory,
    knowledgeContext = null,
  }) {
    let resolvedKbContext = knowledgeContext;

    if (resolvedKbContext === undefined) {
      const kbTeam = await knowledgeBaseService.resolveKbTeam();
      if (kbTeam.useKb) {
        resolvedKbContext = await knowledgeBaseService.getRelevantContext(
          userMessage,
          recentHistory
        );
      }
    }

    let prompt = getSystemPrompt({
      chatProfile,
      knowledgeContext: resolvedKbContext || null,
    });

    if (!contextNote) return { prompt, knowledgeContext: resolvedKbContext || null };
    return {
      prompt: `${prompt}\n\n${contextNote}`,
      knowledgeContext: resolvedKbContext || null,
    };
  }

  buildMessages({ systemPrompt, history, userMessage }) {
    return [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ];
  }

  resolveUsageCategory(hasKbContext = false) {
    return hasKbContext ? TOKEN_CATEGORIES.KB : TOKEN_CATEGORIES.CHAT;
  }

  resolveGenerationOptions(ownerUserId, { hasKbContext = false, contextMode = null } = {}) {
    const userTier = userService.getChatModelTier(ownerUserId);
    // KB hit → configured chat temperature. No retrieved chunks → higher creativity (0.8).
    const temperature = hasKbContext ? getChatTemperature() : getNoKbTemperature();

    if (hasKbContext || contextMode === CONTEXT_MODES.INTENSIVE) {
      return {
        tier: getTierForTask('intensive', userTier),
        temperature,
      };
    }

    if (contextMode === CONTEXT_MODES.GURU) {
      return {
        tier: getTierForTask('chat', userTier),
        temperature,
      };
    }

    return {
      tier: getTierForTask('chat', userTier),
      temperature,
    };
  }

  buildKbMeta({ retrieval, kbTeam, question }) {
    if (!retrieval) {
      const reason = kbTeam?.reason || null;
      let mode = 'prompt_only';
      if (reason === 'not_team_admin') {
        mode = 'not_team_admin';
      } else if (reason === 'team_kb_empty' || reason === 'kb_not_indexed') {
        mode = 'kb_not_found';
      }

      return {
        mode,
        reason,
        query: question,
        kbTeamId: kbTeam?.kbTeamId ?? null,
        requestedTeamId: kbTeam?.requestedTeamId ?? null,
        globalChunkCount: kbTeam?.globalChunkCount ?? null,
        chunks: [],
        chunkCount: 0,
        hitCount: 0,
      };
    }

    return {
      mode: retrieval.mode,
      reason: retrieval.reason || null,
      query: retrieval.query,
      searchQuery: retrieval.searchQuery,
      focusedQuery: retrieval.focusedQuery,
      kbTeamId: retrieval.kbTeamId ?? kbTeam?.kbTeamId ?? null,
      requestedTeamId: retrieval.requestedTeamId ?? null,
      topK: retrieval.topK,
      hitCount: retrieval.hitCount,
      chunkCount: retrieval.chunkCount,
      chunks: retrieval.chunks || [],
      globalChunkCount: retrieval.globalChunkCount ?? kbTeam?.globalChunkCount ?? null,
    };
  }

  wrapChatResponse(reply, kbMeta = null, extra = {}) {
    return { reply, kbMeta, ...extra };
  }

  raiseAssistantTicket({ botAccountId, ownerPhone, chatProfileId, userMessage, structured }) {
    try {
      const resolvedBotId = botAccountId || botAccountService.findByWhatsappPhone(ownerPhone)?.id || null;
      if (!resolvedBotId) {
        logger.warn(`Assistant requested CREATE_TICKET but no bot account resolved (chatProfile=${chatProfileId})`);
        return;
      }

      const description = (structured.actionText || userMessage || structured.message || '')
        .trim()
        .slice(0, 500);
      const title =
        (structured.actionText || '').trim().slice(0, 120) ||
        'Assistant offered to raise a ticket';
      const dedupeKey = `assistant-ticket:${chatProfileId}:${Buffer.from(description.slice(0, 80)).toString('base64').slice(0, 32)}`;

      const item = actionItemService.createEscalation({
        botAccountId: resolvedBotId,
        chatProfileId,
        source: ACTION_SOURCES.ASSISTANT,
        title,
        description,
        category: 'assistant',
        priority: 'l2',
        dedupeKey,
      });

      if (item?.created) {
        logger.info(`Assistant-triggered ticket created for chat profile ${chatProfileId}`);
      }
    } catch (error) {
      logger.error(`Failed to create assistant-triggered ticket: ${error.message}`);
    }
  }

  shouldCreateTicketFromReply(structured, replyText) {
    const eventType = String(structured?.eventType || '').toUpperCase();
    if (eventType === 'CREATE_TICKET') return true;
    const nudge = String(structured?.nudgeType || '').toUpperCase();
    if (nudge === 'CREATE_TICKET_NUDGE') return true;

    const text = String(replyText || structured?.message || '');
    return (
      /\b(raise|raising|raised|create|creating|open|opening)\b[\s\S]{0,48}\b(ticket|escalat)/i.test(
        text
      ) ||
      /\bi(?:'|’)(?:ll| will)\b[\s\S]{0,40}\b(ticket|escalat|raise)/i.test(text) ||
      /\bwill\s+(?:raise|create|open)\b[\s\S]{0,40}\b(ticket|escalat)/i.test(text) ||
      /\bticket\b[\s\S]{0,40}\b(for you|has been|will be)\b/i.test(text)
    );
  }

  async generateResponse(
    ownerUserId,
    chatProfileId,
    userMessage,
    isSelfChat = false,
    botAccountId = null,
    { historyExcludeTrailingUserCount = 0, messageFragments = null } = {}
  ) {
    const question = knowledgeBaseService.normalizeQuery(userMessage);
    const owner = userService.findById(ownerUserId);
    const chatProfile = chatProfileService.findById(chatProfileId);
    const kbTeam = await knowledgeBaseService.resolveKbTeam();
    if (kbTeam.useKb) {
      await knowledgeBaseService.initialize(false);
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn(
        `No OPENAI_API_KEY set (bot=${botAccountId || 'n/a'}) — skipping AI response`
      );
      return this.wrapChatResponse('', {
        mode: 'no_api_key',
        query: question,
        chunks: [],
      });
    }
    const groq = getGroqClient(apiKey);

    await chatProfileService.tryUpdateProfileFromMessage(
      chatProfileId,
      userMessage,
      owner,
      isSelfChat
    );

    const guruMode = owner?.guru_mode === 1;
    const contextState = contextService.resolveMode({
      chatProfileId,
      userMessage: question,
      guruModeEnabled: guruMode,
      kbAccess: kbTeam.useKb,
    });

    const contextWindowMinutes = botAccountService.resolveContextWindowMinutes(botAccountId);
    const window = contextService.buildContextWindow(chatProfileId, contextState.mode, {
      windowMinutes: contextWindowMinutes,
    });
    let historyMessages = window.messages;
    if (historyExcludeTrailingUserCount > 0) {
      historyMessages = [...window.messages];
      let remaining = historyExcludeTrailingUserCount;
      for (let i = historyMessages.length - 1; i >= 0 && remaining > 0; i -= 1) {
        const role = historyMessages[i]?.role;
        if (role === MESSAGE_ROLES.USER || role === 'user') {
          historyMessages.splice(i, 1);
          remaining -= 1;
        }
      }
    }

    if (knowledgeBaseService.isBriefAcknowledgment(question)) {
      return this.wrapChatResponse('Got it!', {
        mode: 'brief_ack',
        query: question,
        chunks: [],
        contextMode: contextState.mode,
        contextTopic: contextState.topic,
      });
    }

    const useKbForMessage =
      kbTeam.useKb && contextState.mode === CONTEXT_MODES.INTENSIVE;
    let knowledgeContext = null;
    let kbRetrieval = null;

    const translateUsage = {
      apiKey,
      usageContext: {
        chatProfileId,
        ownerUserId,
        category: TOKEN_CATEGORIES.KB,
      },
    };

    // Same English query used for KB search is also sent to the main LLM.
    // Casual greetings/small-talk must NOT rewrite through recent Intensive history
    // (that was turning "How are you" into a gamification FAQ reply).
    const searchHistory =
      contextState.mode === CONTEXT_MODES.CASUAL ||
      knowledgeBaseService.isCasualOnly(question)
        ? []
        : historyMessages;
    const { contextualQuery, contextualQueryOriginal } =
      await knowledgeBaseService.buildEnglishSearchQueries(
        question,
        searchHistory,
        translateUsage
      );
    const llmUserMessage =
      contextState.mode === CONTEXT_MODES.CASUAL || knowledgeBaseService.isCasualOnly(question)
        ? question
        : contextualQuery || question;
    if (llmUserMessage !== (contextualQueryOriginal || question) && llmUserMessage !== question) {
      logger.info(
        `LLM user message converted: "${(contextualQueryOriginal || question).slice(0, 60)}" -> "${llmUserMessage.slice(0, 60)}"`
      );
    }

    if (useKbForMessage) {
      const retrievalResult = await knowledgeBaseService.retrieveKnowledge(
        question,
        historyMessages,
        null,
        null,
        {
          ...translateUsage,
          // Reuse the English query already built for the main LLM.
          precomputedSearch: {
            contextualQuery,
            contextualQueryOriginal,
          },
          messageFragments,
        }
      );
      knowledgeContext = retrievalResult.context;
      kbRetrieval = retrievalResult.retrieval;
      if (!knowledgeContext) {
        logger.info(
          `KB miss — prompt-only fallback profile=${chatProfileId} q="${question.slice(0, 80)}"`
        );
      }
    } else if (kbTeam.useKb) {
      logger.info(
        `KB skipped — ${contextState.mode} mode profile=${chatProfileId}`
      );
    } else {
      logger.info(
        `KB skipped — prompt-only profile=${chatProfileId} reason=${kbTeam.reason || 'no_kb'}`
      );
    }

    const kbMeta = {
      ...this.buildKbMeta({
        retrieval: kbRetrieval,
        kbTeam,
        question,
      }),
      searchQuery: llmUserMessage,
      searchQueryOriginal: contextualQueryOriginal || question,
      translatedSearchQuery:
        llmUserMessage !== (contextualQueryOriginal || question) ? llmUserMessage : null,
      contextMode: contextState.mode,
      contextTopic: contextState.topic || null,
      contextSwitched: contextState.switched,
      contextReason: contextState.reason,
    };

    const { prompt: systemPrompt } = await this.buildSystemPrompt({
      chatProfile,
      contextNote: window.contextNote,
      userMessage: llmUserMessage,
      recentHistory: historyMessages,
      knowledgeContext,
    });

    const messages = this.buildMessages({
      systemPrompt,
      history: historyMessages,
      userMessage: llmUserMessage,
    });

    const genOptions = this.resolveGenerationOptions(ownerUserId, {
      hasKbContext: Boolean(knowledgeContext),
      contextMode: contextState.mode,
    });

    logger.info(
      `Chat profile=${chatProfileId} context=${contextState.mode} (${contextService.getModeLabel(contextState.mode)}) msgs=${historyMessages.length} chars=${window.charCount} kbTeam=${kbTeam.kbTeamId ?? 'none'} useKb=${useKbForMessage}${knowledgeContext ? ` kbChars=${knowledgeContext.length} chunks=${kbRetrieval?.chunkCount ?? '?'}` : ' kbChunks=0'} temp=${genOptions.temperature}${contextState.switched ? ` switched=${contextState.reason}` : ''}${historyExcludeTrailingUserCount ? ` batchExclude=${historyExcludeTrailingUserCount}` : ''}`
    );

    const response = await groq.chat(messages, {
      temperature: genOptions.temperature,
      tier: genOptions.tier,
      usageContext: {
        chatProfileId,
        ownerUserId,
        category: this.resolveUsageCategory(Boolean(knowledgeContext)),
      },
    });

    const structured = parseStructuredReply(response);
    const polished = this.polishReply(structured.message);
    if (this.shouldCreateTicketFromReply(structured, polished)) {
      this.raiseAssistantTicket({
        botAccountId,
        ownerPhone: owner?.phone,
        chatProfileId,
        userMessage,
        structured: {
          ...structured,
          actionText:
            structured.actionText ||
            `Student asked: ${(userMessage || '').slice(0, 180)} | Bot offered ticket help`,
          message: polished,
        },
      });
    }

    return this.wrapChatResponse(polished, kbMeta, {
      conversationEnd: Boolean(structured?.conversationEnd),
      conversationSummary: structured?.conversationSummary || null,
      userPreferences: structured?.userPreferences || null,
    });
  }

  async generateSummary(chatProfileId) {
    const messages = memoryService.getMessages(chatProfileId, 100);
    const summaries = memoryService.getSummaries(chatProfileId);
    const chatProfile = chatProfileService.findById(chatProfileId);

    if (messages.length === 0 && summaries.length === 0) {
      return 'No conversation history to summarize for this chat.';
    }

    const ownerUserId = memoryService.resolveOwnerUserId(chatProfileId);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return 'No API key configured — set OPENAI_API_KEY.';
    }

    const groq = getGroqClient(apiKey);
    const profileContext = chatProfile
      ? `Contact: ${chatProfile.contact_name || 'Unknown'}, Role: ${chatProfile.contact_role || 'N/A'}, Relations: ${chatProfile.contact_relations || 'N/A'}\n`
      : '';

    const conversationText = messages
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join('\n');

    const priorSummary = summaries.length
      ? `Previous summary:\n${summaries[summaries.length - 1].summary}\n\n`
      : '';

    const summary = await groq.summarizeText(
      `${profileContext}${priorSummary}Recent messages:\n${conversationText}`,
      getSummarySystemPrompt(),
      {
        tier: MODEL_TIERS.SMART,
        usageContext: {
          chatProfileId,
          ownerUserId: memoryService.resolveOwnerUserId(chatProfileId),
          category: TOKEN_CATEGORIES.SUMMARY,
        },
      }
    );

    return summary;
  }

  async processVoiceMessage(
    ownerUserId,
    chatProfileId,
    base64Data,
    mimetype,
    botAccountId = null,
    options = {}
  ) {
    const ext = (mimetype || '').includes('ogg') ? 'ogg' : 'mp3';
    const inputPath = generateTempFilePath(ext);
    fs.writeFileSync(inputPath, Buffer.from(base64Data, 'base64'));
    return this.handleVoiceMessage(ownerUserId, chatProfileId, inputPath, botAccountId, options);
  }

  async processPdfDocument(
    ownerUserId,
    chatProfileId,
    base64Data,
    filename,
    botAccountId = null,
    options = {}
  ) {
    const ext = path.extname(filename || '') || '.pdf';
    const inputPath = generateTempFilePath(ext.replace('.', '') || 'pdf');
    fs.writeFileSync(inputPath, Buffer.from(base64Data, 'base64'));
    return this.handlePdfMessage(ownerUserId, chatProfileId, inputPath, filename, botAccountId, options);
  }

  async handlePdfMessage(
    ownerUserId,
    chatProfileId,
    filePath,
    originalName,
    botAccountId = null,
    { respond = true, persist = true } = {}
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { reply: '', kbMeta: { mode: 'no_api_key' }, fragment: '' };
    }

    try {
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      const text = truncateText(data.text || '', 12000);
      const name = originalName || 'document.pdf';

      let userContent;
      if (!text.trim()) {
        userContent = `[Student shared a PDF "${name}" but no readable text could be extracted.]`;
      } else {
        userContent =
          `[Student shared a PDF: ${name}]\n\n` +
          `Extracted text:\n${text}\n\n` +
          `Respond helpfully using the assistant prompt and knowledge base. Answer questions about this document if asked.`;
      }

      if (persist) {
        memoryService.addMessage(chatProfileId, MESSAGE_ROLES.USER, userContent, {
          source: text.trim() ? 'pdf' : MESSAGE_SOURCES.WHATSAPP,
        });
      }

      if (!respond) {
        return { reply: '', kbMeta: null, fragment: userContent };
      }

      return this.generateResponse(ownerUserId, chatProfileId, userContent, false, botAccountId);
    } finally {
      safeDeleteFile(filePath);
    }
  }

  async handleVoiceMessage(
    ownerUserId,
    chatProfileId,
    audioPath,
    botAccountId = null,
    { respond = true, persist = true } = {}
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { reply: '', kbMeta: { mode: 'no_api_key' }, fragment: '' };
    }
    const groq = getGroqClient(apiKey);

    const outputPath = generateTempFilePath('ogg');
    try {
      await new Promise((resolve, reject) => {
        ffmpeg(audioPath)
          .toFormat('ogg')
          .on('end', resolve)
          .on('error', reject)
          .save(outputPath);
      });

      const transcription = await groq.transcribeAudio(outputPath, {
        usageContext: {
          chatProfileId,
          ownerUserId,
          category: TOKEN_CATEGORIES.VOICE,
        },
      });

      const userContent = transcription
        ? transcription
        : '[Student sent a voice message that could not be transcribed clearly.]';

      if (persist) {
        memoryService.addMessage(chatProfileId, MESSAGE_ROLES.USER, userContent, {
          source: transcription ? 'voice' : MESSAGE_SOURCES.WHATSAPP,
        });
      }

      if (!respond) {
        return { reply: '', kbMeta: null, fragment: userContent };
      }

      return this.generateResponse(ownerUserId, chatProfileId, userContent, false, botAccountId);
    } finally {
      safeDeleteFile(audioPath);
      safeDeleteFile(outputPath);
    }
  }

  /**
   * Build the user-facing media note for the LLM (no reply generated).
   * Keep this factual only — reply style must come from the system / agent prompt.
   */
  buildGenericMediaUserContent({ mediaType, filename, mimetype, caption }) {
    const typeLabel = mediaType || 'file';
    const niceLabel =
      typeLabel === 'image'
        ? 'image'
        : typeLabel === 'video'
          ? 'video'
          : typeLabel === 'sticker'
            ? 'sticker'
            : typeLabel === 'document'
              ? 'document'
              : typeLabel === 'ptt' || typeLabel === 'audio'
                ? 'voice message'
                : typeLabel;

    const safeCaption = knowledgeBaseService.sanitizeMediaCaption(caption);
    const parts = [`[Student sent an ${niceLabel}`];
    if (filename) parts[0] += `: ${filename}`;
    if (mimetype) parts[0] += ` (${mimetype})`;
    parts[0] += ']';

    if (safeCaption) {
      parts.push(`Caption / message: ${safeCaption}`);
    } else {
      parts.push('No text caption was included.');
    }

    parts.push(
      'Follow the system prompt rules for this media type exactly. Do not use a generic acknowledgment or "inform the team" stock line unless the prompt requires it.'
    );

    return parts.join('\n');
  }

  /**
   * Route any non-voice/non-PDF media through the team prompt with a clear media note.
   * Pass { respond: false } to only build/store the fragment for inbound batching.
   */
  async handleGenericMediaMessage(
    ownerUserId,
    chatProfileId,
    { mediaType, filename, mimetype, caption },
    botAccountId = null,
    { respond = true, persist = true } = {}
  ) {
    const userContent = this.buildGenericMediaUserContent({
      mediaType,
      filename,
      mimetype,
      caption,
    });

    if (persist) {
      memoryService.addMessage(chatProfileId, MESSAGE_ROLES.USER, userContent, {
        source: MESSAGE_SOURCES.WHATSAPP,
      });
    }

    if (!respond) {
      return { reply: '', kbMeta: null, fragment: userContent };
    }

    return this.generateResponse(ownerUserId, chatProfileId, userContent, false, botAccountId);
  }
}

module.exports = new ChatService();
