const chatProfileService = require('./chatProfileService');
const { actionItemService, ACTION_SOURCES } = require('./actionItemService');
const { botAccountService } = require('./botAccountService');
const promptConfigService = require('./promptConfigService');
const { getGroqClient } = require('../ai/groqClient');
const { MODEL_TIERS, getChatTemperature } = require('../config/modelConfig');
const logger = require('../utils/logger');

const MIN_MESSAGE_LENGTH = 6;
const MATCH_CONFIDENCE_THRESHOLD = Number(process.env.ACTION_TRIGGER_MIN_CONFIDENCE) || 0.65;

function parseTriggerLines(triggerPrompt) {
  return String(triggerPrompt || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter(Boolean);
}

function parseClassifierJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function buildClassifierSystemPrompt(triggerLines) {
  const rules = triggerLines.map((line, index) => `${index + 1}. ${line}`).join('\n');

  return [
    'You classify inbound WhatsApp messages for a coach dashboard "Call to Action" queue.',
    'The team configured these trigger scenarios (lines describe intent/patterns to flag):',
    '',
    rules,
    '',
    'Match when the student message clearly fits the MEANING or intent of any scenario — not only exact keywords.',
    'Do not match casual greetings, thanks, or generic small talk.',
    'Respond with JSON only:',
    '{"match":boolean,"title":string,"category":string,"confidence":number,"reason":string}',
    '',
    'title: short dashboard label (max 8 words).',
    'category: short slug (e.g. call, refund, complaint, billing).',
    'confidence: 0.0 to 1.0 — how sure you are this should be flagged.',
    'If nothing applies, return {"match":false,"title":"","category":"","confidence":0,"reason":"no match"}.',
  ].join('\n');
}

function keywordEscalationMatch(body, triggerLines) {
  const lower = String(body || '').toLowerCase();
  if (!lower || lower.length < MIN_MESSAGE_LENGTH) return null;

  for (const line of triggerLines) {
    const tokens = String(line)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4);
    if (!tokens.length) continue;

    const hits = tokens.filter((token) => lower.includes(token));
    const required = tokens.length === 1 ? 1 : Math.min(2, tokens.length);
    if (hits.length < required) continue;

    const title = String(line).trim().slice(0, 80) || 'Call to Action';
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48);

    return {
      id: `keyword:${slug || 'trigger'}`,
      category: hits[0] || 'general',
      priority: 'l2',
      title,
      autoReply: null,
      confidence: 0.7,
      reason: `keyword match: ${hits.join(', ')}`,
      ruleCount: triggerLines.length,
    };
  }

  return null;
}

function normalizeClassifierResult(parsed, triggerLines) {
  if (!parsed || parsed.match !== true) return null;

  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < MATCH_CONFIDENCE_THRESHOLD) {
    return null;
  }

  const title = String(parsed.title || '').trim();
  if (!title) return null;

  const category = String(parsed.category || 'general')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .slice(0, 40);

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  return {
    id: `config:${slug || category || 'trigger'}`,
    category: category || 'general',
    priority: 'l2',
    title,
    autoReply: null,
    confidence,
    reason: String(parsed.reason || '').trim(),
    ruleCount: triggerLines.length,
  };
}

function containsUrl(text) {
  return /https?:\/\/\S+/i.test(String(text || '')) || /\bwww\.[a-z0-9.-]+\.[a-z]{2,}\S*/i.test(String(text || ''));
}

function buildMediaEscalationContent({ mediaType, caption = '', body = '' } = {}) {
  const parts = [`Student sent a WhatsApp ${mediaType || 'media'} message.`];
  const captionText = String(caption || '').trim();
  const bodyText = String(body || '').trim();
  if (captionText) parts.push(`Caption: ${captionText}`);
  if (bodyText && bodyText !== captionText) parts.push(`Message: ${bodyText}`);
  const urls = `${captionText} ${bodyText}`.match(/https?:\/\/\S+/gi);
  if (urls?.length) parts.push(`Links: ${urls.join(' ')}`);
  return parts.join('\n');
}

function autoMatchMediaOrLink(content, { hasMedia = false, mediaType = null } = {}) {
  const text = String(content || '');
  const hasUrl = containsUrl(text);
  if (!hasMedia && !hasUrl) return null;

  const kind = hasMedia
    ? mediaType === 'image'
      ? 'Image'
      : mediaType === 'video'
        ? 'Video'
        : mediaType === 'sticker'
          ? 'Sticker'
          : mediaType === 'document'
            ? 'Document'
            : 'Media'
    : 'Link';

  return {
    id: `auto:${String(kind).toLowerCase()}`,
    category: String(kind).toLowerCase(),
    priority: 'l2',
    title: hasMedia ? `Student sent ${String(kind).toLowerCase()}` : 'Student sent a link',
    autoReply: null,
    confidence: 1,
    reason: hasMedia ? 'automatic media trigger' : 'automatic link trigger',
    ruleCount: 0,
  };
}

function resolveEscalationContext(profile, botAccountId = null) {
  const bot = botAccountId
    ? botAccountService.findById(botAccountId)
    : botAccountService.findByWhatsappPhone(profile?.owner_phone);

  if (!bot) return null;

  const triggerPrompt = promptConfigService.getActionItemTriggerPrompt();
  const apiKey = process.env.OPENAI_API_KEY || null;

  return { bot, teamId: null, triggerPrompt, apiKey };
}

async function detectEscalation(text, options = {}) {
  const body = (text || '').trim();
  if (!body || body.length < MIN_MESSAGE_LENGTH) return null;

  const triggerPrompt =
    options.triggerPrompt !== undefined
      ? options.triggerPrompt
      : promptConfigService.getActionItemTriggerPrompt();

  const triggerLines = parseTriggerLines(triggerPrompt);
  if (triggerLines.length === 0) return null;

  const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('Call to action AI check skipped: no API key — trying keyword match');
    return keywordEscalationMatch(body, triggerLines);
  }

  try {
    const groq = getGroqClient(apiKey);
    const response = await groq.chat(
      [
        { role: 'system', content: buildClassifierSystemPrompt(triggerLines) },
        { role: 'user', content: body },
      ],
      {
        temperature: getChatTemperature(),
        tier: MODEL_TIERS.FAST,
        usageContext: options.usageContext,
      }
    );

    const parsed = parseClassifierJson(response);
    return normalizeClassifierResult(parsed, triggerLines);
  } catch (error) {
    logger.warn(`Call to action classifier failed: ${error.message}`);
    return null;
  }
}

function resolveBotAccountId(ownerPhone) {
  const bot = botAccountService.findByWhatsappPhone(ownerPhone);
  return bot?.id || null;
}

async function processInbound({
  chatProfileId,
  content,
  botAccountId = null,
  triggerMessageId = null,
  hasMedia = false,
  mediaType = null,
  forceMediaOrLink = false,
}) {
  const profile = chatProfileService.findById(chatProfileId);
  if (!profile || profile.chat_type === 'self') return null;

  const context = resolveEscalationContext(profile, botAccountId);
  const shouldForce =
    forceMediaOrLink || hasMedia || containsUrl(content);
  if (!context?.triggerPrompt?.trim() && !shouldForce) return null;

  let match = null;
  if (context?.triggerPrompt?.trim()) {
    match = await detectEscalation(content, {
      triggerPrompt: context.triggerPrompt,
      apiKey: context.apiKey,
      usageContext: {
        chatProfileId,
        category: 'action_trigger',
      },
    });
  }

  if (!match && shouldForce) {
    match = autoMatchMediaOrLink(content, { hasMedia, mediaType });
  }

  if (!match) return null;

  const resolvedBotId = botAccountId || resolveBotAccountId(profile.owner_phone);
  if (!resolvedBotId) {
    logger.warn(`Escalation detected but no bot account for chat profile ${chatProfileId}`);
    return null;
  }

  const description = (content || '').trim().slice(0, 500);
  const dedupeKey = triggerMessageId
    ? `esc:${match.id}:${chatProfileId}:${triggerMessageId}`
    : `esc:${match.id}:${chatProfileId}:${description.slice(0, 64)}:${Date.now()}`;
  const item = actionItemService.createEscalation({
    botAccountId: resolvedBotId,
    chatProfileId,
    source: ACTION_SOURCES.ESCALATION,
    title: match.title,
    description,
    category: match.category,
    priority: match.priority,
    dedupeKey,
    triggerMessageId,
  });

  if (item?.created) {
    logger.info(
      `Call to action created: ${match.title} (chat=${chatProfileId}, category=${match.category}, confidence=${match.confidence})`
    );
  }

  return {
    item,
    autoReply: match.autoReply || null,
    rule: match,
  };
}

async function onInboundContactMessage(params) {
  return processInbound(params);
}

module.exports = {
  detectEscalation,
  processInbound,
  onInboundContactMessage,
  parseTriggerLines,
  buildClassifierSystemPrompt,
  buildMediaEscalationContent,
  containsUrl,
};
