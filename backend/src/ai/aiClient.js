const fs = require('fs');
const OpenAI = require('openai');
const { MODEL_TIERS, getChatTemperature, resolveChatModel } = require('../config/modelConfig');
const { withRetry, isTransientUpstreamError } = require('../utils/helpers');
const logger = require('../utils/logger');

const SUMMARY_SYSTEM_PROMPT =
  'Summarize the following WhatsApp conversation between an assistant and a contact. ' +
  'Keep it to 3-5 sentences, capturing key facts, decisions, and open questions. ' +
  'Write in third person, plain text only, no markdown.';

class AiClient {
  constructor(apiKey) {
    this.client = new OpenAI({ apiKey });
  }

  recordUsage(model, usage, usageContext) {
    if (!usageContext?.category) return;
    try {
      const { tokenUsageService } = require('../services/tokenUsageService');
      tokenUsageService.record({
        chatProfileId: usageContext.chatProfileId ?? null,
        ownerUserId: usageContext.ownerUserId ?? null,
        category: usageContext.category,
        model,
        promptTokens: usage?.prompt_tokens || 0,
        completionTokens: usage?.completion_tokens || 0,
        totalTokens: usage?.total_tokens || 0,
      });
    } catch (error) {
      logger.warn(`Token usage recording failed (non-fatal): ${error.message}`);
    }
  }

  async chat(messages, options = {}) {
    const tier = options.tier || MODEL_TIERS.FAST;
    const model = options.model || resolveChatModel(tier);
    const temperature = options.temperature ?? getChatTemperature();

    const request = { model, messages, temperature };

    const response = await withRetry(() => this.client.chat.completions.create(request), {
      attempts: 3,
      baseDelayMs: 600,
      shouldRetry: isTransientUpstreamError,
      label: `AI completion (model=${model})`,
    });

    this.recordUsage(model, response.usage, options.usageContext);
    return response.choices?.[0]?.message?.content || '';
  }

  async summarizeText(text, systemPrompt, options = {}) {
    return this.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      {
        tier: options.tier || MODEL_TIERS.SMART,
        temperature: options.temperature ?? getChatTemperature(),
        usageContext: options.usageContext,
      }
    );
  }

  async summarizeConversation(messages, options = {}) {
    const transcript = (messages || [])
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'Contact'}: ${m.content}`)
      .join('\n');
    return this.summarizeText(transcript, SUMMARY_SYSTEM_PROMPT, options);
  }

  async transcribeAudio(filePath, options = {}) {
    const model = 'whisper-1';
    const response = await withRetry(
      () =>
        this.client.audio.transcriptions.create({
          file: fs.createReadStream(filePath),
          model,
        }),
      {
        attempts: 3,
        baseDelayMs: 600,
        shouldRetry: isTransientUpstreamError,
        label: 'AI audio transcription',
      }
    );

    this.recordUsage(model, null, options.usageContext);
    return (response?.text || '').trim();
  }
}

const clients = new Map();

function getGroqClient(apiKey) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('No OpenAI API key configured for this bot/owner');
  }
  if (!clients.has(key)) {
    clients.set(key, new AiClient(key));
  }
  return clients.get(key);
}

module.exports = { getGroqClient };
