const { getAssistantName, isIdentityQuestion } = require('../config/assistantIdentity');

const STRUCTURED_REPLY_KEYS = [
  'assistant_message',
  'message',
  'reply',
  'content',
  'text',
  'response',
];

function isConversationEndFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractConversationSummary(parsed) {
  const raw = parsed?.conversation_summary ?? parsed?.conversationSummary;
  if (raw === false || raw === 'false' || raw == null) return null;
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 8000);
  if (isPlainObject(raw)) {
    if (raw.status === false || raw.status === 'false') return null;
    if (typeof raw.summary === 'string' && raw.summary.trim()) {
      return raw.summary.trim().slice(0, 8000);
    }
  }
  return null;
}

function extractUserPreferences(parsed) {
  const candidates = [
    parsed?.user_preferences,
    parsed?.userPreferences,
    parsed?.user_data,
    parsed?.userData,
    parsed?.preferences,
  ];
  for (const candidate of candidates) {
    if (isPlainObject(candidate) && Object.keys(candidate).length) {
      return candidate;
    }
  }
  return null;
}

function isConversationEndControlBody(text) {
  if (!text || typeof text !== 'string') return false;

  let trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) trimmed = fenced[1].trim();
  if (!trimmed.startsWith('{')) {
    return /"conversation_end"\s*:\s*true/i.test(trimmed) && trimmed.length < 200;
  }

  try {
    const parsed = JSON.parse(trimmed);
    const ended =
      isConversationEndFlag(parsed?.conversation_end) ||
      isConversationEndFlag(parsed?.conversationEnd);
    if (!ended) return false;

    const hasHumanMessage = STRUCTURED_REPLY_KEYS.some(
      (key) => typeof parsed?.[key] === 'string' && parsed[key].trim()
    );
    return !hasHumanMessage;
  } catch {
    return /"conversation_end"\s*:\s*true/i.test(trimmed) && trimmed.length < 200;
  }
}

function stripLeakedJsonSuffix(text) {
  if (!text || typeof text !== 'string') return text;

  const leakStart = text.search(
    /\{\s*"(?:assistant_message|event|nudge_type|conversation_end|conversationEnd)"/i
  );
  if (leakStart <= 0) return text;

  const before = text.slice(0, leakStart).trim();
  const suffix = text.slice(leakStart).trim();
  if (isConversationEndControlBody(suffix)) return before;
  const fromSuffix = unwrapStructuredReply(suffix);

  if (before.length >= 8) return before;
  if (fromSuffix && fromSuffix !== suffix) return fromSuffix;
  return before || fromSuffix;
}

function parseStructuredReply(text) {
  const fallback = {
    message: text,
    eventType: null,
    actionText: null,
    nudgeType: null,
    conversationEnd: false,
    conversationSummary: null,
    userPreferences: null,
  };
  if (!text || typeof text !== 'string') return fallback;

  let trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) trimmed = fenced[1].trim();

  const leakStart = trimmed.search(
    /\{\s*"(?:assistant_message|event|nudge_type|conversation_end|conversationEnd|conversation_summary|user_preferences|user_data)"/i
  );
  if (leakStart > 0) trimmed = trimmed.slice(leakStart);

  if (!trimmed.startsWith('{')) return fallback;

  try {
    const parsed = JSON.parse(trimmed);
    const conversationEnd =
      isConversationEndFlag(parsed?.conversation_end) ||
      isConversationEndFlag(parsed?.conversationEnd);
    const conversationSummary = extractConversationSummary(parsed);
    const userPreferences = extractUserPreferences(parsed);
    const message =
      STRUCTURED_REPLY_KEYS.map((key) => parsed?.[key]).find(
        (value) => typeof value === 'string' && value.trim()
      ) || '';

    // Never fall back to raw JSON when this is a control signal.
    if (conversationEnd && !message) {
      return {
        message: '',
        eventType: null,
        actionText: null,
        nudgeType: null,
        conversationEnd: true,
        conversationSummary,
        userPreferences,
      };
    }

    return {
      message: message || (conversationEnd ? '' : text),
      eventType: typeof parsed?.event?.event_type === 'string' ? parsed.event.event_type.trim() : null,
      actionText: typeof parsed?.event?.action_text === 'string' ? parsed.event.action_text.trim() : null,
      nudgeType: typeof parsed?.nudge_type === 'string' ? parsed.nudge_type.trim() : null,
      conversationEnd,
      conversationSummary,
      userPreferences,
    };
  } catch {
    if (isConversationEndControlBody(trimmed)) {
      return {
        message: '',
        eventType: null,
        actionText: null,
        nudgeType: null,
        conversationEnd: true,
        conversationSummary: null,
        userPreferences: null,
      };
    }
    return fallback;
  }
}

function unwrapStructuredReply(text) {
  if (!text || typeof text !== 'string') return text;

  let trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) trimmed = fenced[1].trim();

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed.trim();

    for (const key of STRUCTURED_REPLY_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    if (
      isConversationEndFlag(parsed?.conversation_end) ||
      isConversationEndFlag(parsed?.conversationEnd)
    ) {
      return '';
    }
  } catch {
    for (const key of STRUCTURED_REPLY_KEYS) {
      const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
      const match = trimmed.match(re);
      if (match) {
        try {
          return JSON.parse(`"${match[1]}"`).trim();
        } catch {
          return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
        }
      }
    }
  }

  return text;
}

const ROBOTIC_PHRASE_PATTERNS = [
  [/knowledge\s*base/gi, ''],
  [/\bKB\b/g, ''],
  [/according to (the |our )?(document|database|reference|knowledge base)[^.]*\.?\s*/gi, ''],
  [/based on (the |our )?(document|database|reference|knowledge base)[^.]*\.?\s*/gi, ''],
  [/as per (the )?(document|policy)[^.]*\.?\s*/gi, ''],
  [/the (document|reference material) (says|states|mentions)[^.]*\.?\s*/gi, ''],
  [/context window/gi, ''],
  [/reference material/gi, ''],
  [/i('m| am) an? (ai|bot|language model|assistant bot|virtual assistant)[^.]*\.?\s*/gi, ''],
  [/as an ai[^.]*\.?\s*/gi, ''],
  [/(certainly|of course|absolutely)!\s*/gi, ''],
  [/great question!\s*/gi, ''],
  [/i('d| would) be happy to (help|assist)[^.]*\.?\s*/gi, ''],
  [/thank you for (reaching out|your (question|message))[^.]*\.?\s*/gi, ''],
  [/hope this helps[^.]*\.?\s*/gi, ''],
  [/please (let me know|feel free) if you (have|need)[^.]*\.?\s*/gi, ''],
  [/i understand (your )?concern[^.]*\.?\s*/gi, ''],
  [/i('m| am) here to (help|assist) you[^.]*\.?\s*/gi, ''],
  [/how can i assist you today\??\s*/gi, ''],
  [/is there anything else i can help[^.]*\.?\s*/gi, ''],
  [/,?\s*(you may also want to )?reach out to your success coach[^.]*\.?/gi, ''],
  [/,?\s*(please )?contact your success coach[^.]*\.?/gi, ''],
  [/,?\s*speak (to|with) your success coach[^.]*\.?/gi, ''],
  [/,?\s*connect with your success coach[^.]*\.?/gi, ''],
  [/,?\s*your success coach (can|will|may|could)[^.]*\.?/gi, ''],
  [/,?\s*for (assistance|clarification),?\s*(you can )?reach out to your success coach[^.]*\.?/gi, ''],
];

function stripUnpromptedIdentity(reply, userMessage) {
  if (!reply || isIdentityQuestion(userMessage)) return reply;

  const name = getAssistantName();
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return reply
    .replace(
      new RegExp(`i'?m\\s+${escapedName}[^.!?]*success coach[^.!?]*[.!?]?\\s*`, 'gi'),
      ''
    )
    .replace(/i'?m\s+[\w]+[^.!?]*your nxtwave success coach[^.!?]*[.!?]?\s*/gi, '')
    .replace(/i'?m\s+[\w]+[^.!?]*nxtwave success coach[^.!?]*[.!?]?\s*/gi, '')
    .trim();
}

function stripMarkdownForWhatsApp(text) {
  if (!text || typeof text !== 'string') return text;

  let reply = text;

  reply = reply.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1');
  reply = reply.replace(/^#{1,6}\s+/gm, '');
  reply = reply.replace(/\*\*([^*]+)\*\*/g, '$1');
  reply = reply.replace(/__([^_]+)__/g, '$1');
  reply = reply.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1');
  reply = reply.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1');
  reply = reply.replace(/`([^`]+)`/g, '$1');
  reply = reply.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  reply = reply.replace(/^\s*[-*•]\s+/gm, '');
  reply = reply.replace(/^\s*>\s?/gm, '');

  return reply
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function sanitizeUserReply(text, userMessage = '') {
  if (!text) return text;

  let reply = stripLeakedJsonSuffix(text);
  reply = unwrapStructuredReply(reply);
  reply = stripUnpromptedIdentity(reply, userMessage);

  for (const [pattern, replacement] of ROBOTIC_PHRASE_PATTERNS) {
    reply = reply.replace(pattern, replacement);
  }

  reply = stripMarkdownForWhatsApp(reply);

  return reply.replace(/[ \t]{2,}/g, ' ').replace(/^\s*[,.\-–]\s*/, '').trim();
}

function applyFirewallPostReply(text, { mode = 'redirect', redirectMessage = '' } = {}) {
  if (!text) return text;

  const contradictionPatterns = [
    /i don'?t have that in my knowledge/i,
    /not in (the |my )?knowledge base/i,
    /i cannot help with that/i,
    /outside (of )?my scope/i,
  ];

  const hasContradiction = contradictionPatterns.some((pattern) => pattern.test(text));
  if (!hasContradiction) {
    return text;
  }

  if (mode === 'silent') {
    return '';
  }

  return String(redirectMessage || '').trim() || text;
}

module.exports = {
  sanitizeUserReply,
  stripMarkdownForWhatsApp,
  stripUnpromptedIdentity,
  stripLeakedJsonSuffix,
  unwrapStructuredReply,
  parseStructuredReply,
  isConversationEndControlBody,
  applyFirewallPostReply,
};
