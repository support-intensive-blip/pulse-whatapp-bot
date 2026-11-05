const { getDatabase } = require('../database/db');
const { TOKEN_CATEGORIES } = require('../config/tokenCategories');
const { currentBotId } = require('../utils/botContext');

const OUTPUT_TASKS = ['chat', 'kb', 'context', 'summary', 'pdf', 'profile', 'firewall', 'action_trigger', 'other'];
const reservations = new Map();

class AiLimitError extends Error {
  constructor(message, reply) {
    super(message);
    this.code = 'AI_LIMIT';
    this.reply = reply;
  }
}

function validateLimit(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a whole number from 0 to ${maximum.toLocaleString('en-IN')}`);
  }
  return value;
}

function normalizeLimits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI limits must be an object');
  const output = value.outputTokens ?? {};
  if (typeof output !== 'object' || Array.isArray(output)) throw new Error('Output limits must be an object');
  return {
    inputChars: validateLimit(value.inputChars ?? 0, 100000, 'Input character limit'),
    contextTokens: validateLimit(value.contextTokens ?? 0, 1000000, 'Context token limit'),
    dailyTokens: validateLimit(value.dailyTokens ?? 0, 100000000, 'Daily bot budget'),
    outputTokens: Object.fromEntries(OUTPUT_TASKS.map(task => [task, validateLimit(output[task] ?? 0, 32768, `${task} output limit`)])),
  };
}

function readLimits(bot) {
  try { return normalizeLimits(JSON.parse(bot?.ai_limits || '{}')); }
  catch { return normalizeLimits({}); }
}

function assertInput(bot, text) {
  const limit = readLimits(bot).inputChars;
  if (limit && String(text || '').length > limit) {
    throw new AiLimitError(`Message exceeds this bot’s ${limit.toLocaleString('en-IN')}-character input limit.`,
      'Please send a shorter message. For code, share the error and the relevant function.');
  }
}

function estimateTokens(messages) {
  return 32 + messages.reduce((total, message) => total + 16 +
    Buffer.byteLength(typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''), 'utf8'), 0);
}

function fitContext(messages, maximum) {
  if (!maximum || estimateTokens(messages) <= maximum) return messages;
  const fitted = [...messages];
  while (estimateTokens(fitted) > maximum) {
    const oldest = fitted.findIndex((message, index) => index < fitted.length - 1 && message.role !== 'system' && message.role !== 'developer');
    if (oldest < 0) throw new AiLimitError('The prompt and current message exceed this bot’s context limit.',
      'I can’t process that much context. Please send a shorter question.');
    fitted.splice(oldest, 1);
  }
  return fitted;
}

function istDayBounds(now = Date.now()) {
  const offset = 330 * 60000;
  const start = Date.parse(new Date(now + offset).toISOString().slice(0, 10)) - offset;
  return [new Date(start).toISOString(), new Date(start + 86400000).toISOString()];
}

function reserveCompletion(messages, usageContext = {}, limitTask) {
  const botId = usageContext.botAccountId || currentBotId() ||
    (usageContext.chatProfileId && require('./tokenUsageService').tokenUsageService.resolveBot(getDatabase(), usageContext)?.id);
  if (!botId) return { messages, release() {} };
  const db = getDatabase();
  const bot = db.prepare('SELECT id, team_id, ai_limits FROM bot_accounts WHERE id = ?').get(botId);
  const limits = readLimits(bot);
  const fitted = fitContext(messages, limits.contextTokens);
  const category = limitTask || usageContext.category || TOKEN_CATEGORIES.CHAT;
  const task = OUTPUT_TASKS.includes(category) ? category : 'other';
  let output = limits.outputTokens[task];
  const teamBudget = bot?.team_id
    ? db.prepare('SELECT daily_ai_token_budget FROM teams WHERE id = ?').get(bot.team_id)?.daily_ai_token_budget
    : 0;
  const [start, end] = istDayBounds();
  const scopes = [
    { label: 'bot', column: 'bot_account_id', id: botId, budget: limits.dailyTokens },
    { label: 'team', column: 'team_id', id: bot?.team_id, budget: teamBudget },
  ];
  const active = scopes.filter(scope => scope.id);
  const input = estimateTokens(fitted);
  for (const scope of active) {
    scope.key = `${start}:${scope.label}:${scope.id}`;
    if (!scope.budget) continue;
    const used = db.prepare(`SELECT COALESCE(SUM(total_tokens), 0) AS used FROM token_usage
      WHERE ${scope.column} = ? AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)`)
      .get(scope.id, start, end).used;
    const remaining = scope.budget - used - (reservations.get(scope.key) || 0) - input;
    if (remaining < 1) throw new AiLimitError(`This ${scope.label} has insufficient daily AI tokens for this request. Budgets reset at midnight IST.`,
      'AI support is temporarily unavailable. Please try again later or contact your team.');
    output = output ? Math.min(output, remaining) : Math.min(remaining, 32768);
  }
  const reserved = input + (output || 32768);
  for (const scope of active) reservations.set(scope.key, (reservations.get(scope.key) || 0) + reserved);
  return { messages: fitted, output, botId, release() {
    for (const scope of active) {
      const next = (reservations.get(scope.key) || 0) - reserved;
      if (next > 0) reservations.set(scope.key, next);
      else reservations.delete(scope.key);
    }
  } };
}

module.exports = { AiLimitError, normalizeLimits, validateLimit, readLimits, assertInput, reserveCompletion, fitContext, istDayBounds };
