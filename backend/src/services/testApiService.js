const { getDatabase } = require('../database/db');
const crypto = require('crypto');
const chatService = require('./chatService');
const chatProfileService = require('./chatProfileService');
const userService = require('./userService');
const botConfigService = require('./botConfigService');
const scopeFirewallService = require('./scopeFirewallService');
const memoryService = require('./memoryService');
const { applyFirewallPostReply, sanitizeUserReply } = require('../ai/replyRules');
const { MESSAGE_ROLES, MESSAGE_SOURCES } = require('../utils/constants');
const { normalizePhone } = require('../utils/helpers');
const { KeyedQueue, ConcurrencyLimiter } = require('../utils/requestQueue');
const logger = require('../utils/logger');

const TEST_CHAT_PREFIX = 'api-test';
// Single-tenant: no teams. Kept as a stable label for chat/session/queue keys and
// for backward compatibility with the Opik eval harness response shape.
const TEST_TEAM = { id: 'intensive', name: 'Intensive' };
const sessionQueue = new KeyedQueue();
const globalLimiter = new ConcurrencyLimiter(
  Math.max(1, Number(process.env.TEST_API_MAX_CONCURRENT) || 8)
);

let cachedRuntime = null;
let cachedRuntimeAt = 0;
const RUNTIME_CACHE_MS = 60_000;

function isSkipFirewallEnabled() {
  return String(process.env.TEST_API_SKIP_FIREWALL ?? 'true').toLowerCase() === 'true';
}

function shouldSkipFirewall(options = {}) {
  if (options.skipFirewall === true) return true;
  if (options.skipFirewall === false) return false;
  return isSkipFirewallEnabled();
}

function resolveEffectiveSessionId(sessionId = 'default', options = {}) {
  const base = String(sessionId || 'default').trim() || 'default';
  if (options.isolated || options.parallel || options.stateless) {
    const suffix = crypto.randomBytes(6).toString('hex');
    return `${base}-${suffix}`;
  }
  return base;
}

function sessionQueueKey(teamId, sessionId) {
  return `${teamId}:${sessionId}`;
}

function isSqliteBusyError(error) {
  const message = String(error?.message || error || '');
  return /SQLITE_BUSY|database is locked/i.test(message);
}

function isRateLimitError(error) {
  const message = String(error?.message || error || '');
  return /429|rate limit|too many requests/i.test(message);
}

function classifyRunError(error) {
  if (isRateLimitError(error)) {
    return { status: 429, code: 'rate_limited', retryable: true };
  }
  if (isSqliteBusyError(error)) {
    return { status: 503, code: 'db_busy', retryable: true };
  }
  const message = String(error?.message || error || '');
  if (/timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(message)) {
    return { status: 504, code: 'timeout', retryable: true };
  }
  return { status: 500, code: 'internal_error', retryable: false };
}

function isEnabled() {
  return String(process.env.TEST_API_ENABLED || '').toLowerCase() === 'true';
}

function getConfiguredToken() {
  return String(process.env.TEST_API_TOKEN || '').trim();
}

function validateToken(provided) {
  const expected = getConfiguredToken();
  if (!isEnabled() || !expected) return false;
  return Boolean(provided && provided === expected);
}

function resolveTeam() {
  return TEST_TEAM;
}

function resolvePrimaryBot() {
  const db = getDatabase();
  return (
    db
      .prepare(
        `SELECT * FROM bot_accounts
         ORDER BY
           CASE WHEN status = 'ready' THEN 0 ELSE 1 END,
           CASE WHEN whatsapp_phone IS NOT NULL AND whatsapp_phone != '' THEN 0 ELSE 1 END,
           id ASC
         LIMIT 1`
      )
      .get() || null
  );
}

function resolveOwnerPhone(bot) {
  return normalizePhone(bot?.whatsapp_phone || bot?.last_whatsapp_phone || '');
}

function sessionChatId(teamId, sessionId = 'default') {
  const safe = String(sessionId || 'default')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 48) || 'default';
  return `${TEST_CHAT_PREFIX}-${teamId}-${safe}@pulse.test`;
}

function getOrCreateTestProfile(teamId, ownerPhone, sessionId = 'default') {
  const chatId = sessionChatId(teamId, sessionId);
  const owner = normalizePhone(ownerPhone);
  try {
    return chatProfileService.getOrCreate({
      chatId,
      ownerPhone,
      // Unique per session so name-based sibling matching cannot merge
      // unrelated eval chats into one contaminated memory window.
      contactName: `API Test ${String(sessionId).slice(0, 48)}`,
      contactPhone: null,
      chatType: 'contact',
    });
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE constraint failed')) {
      const existing = chatProfileService.findByChatIdForOwner(chatId, owner);
      if (existing) return existing;
    }
    throw error;
  }
}

function buildRuntimeContext() {
  const team = resolveTeam();

  const bot = resolvePrimaryBot();
  if (!bot) {
    return { error: 'No bot account found — connect WhatsApp first.' };
  }

  const ownerPhone = resolveOwnerPhone(bot);
  if (!ownerPhone) {
    return { error: `Bot ${bot.id} has no linked WhatsApp phone — connect WhatsApp first.` };
  }

  botConfigService.loadConfigForBotAccount(bot.id);

  const owner = userService.getOrCreate(`${ownerPhone}@c.us`, null);
  const apiKey = process.env.OPENAI_API_KEY || null;
  if (!apiKey) {
    return { error: 'No OpenAI API key configured (set OPENAI_API_KEY).' };
  }

  return { team, bot, ownerPhone, owner, apiKey };
}

function getRuntimeContext() {
  const now = Date.now();
  if (cachedRuntime && !cachedRuntime.error && now - cachedRuntimeAt < RUNTIME_CACHE_MS) {
    return cachedRuntime;
  }
  cachedRuntime = buildRuntimeContext();
  cachedRuntimeAt = now;
  return cachedRuntime;
}

async function runChatInner({
  message,
  sessionId = 'default',
  skipFirewall,
  isolated = false,
  parallel = false,
  stateless = false,
  persistMemory = true,
}) {
  const body = String(message || '').trim();
  if (!body) {
    return { error: 'message is required' };
  }

  const ctx = getRuntimeContext();
  if (ctx.error) return { error: ctx.error };

  const { team, bot, owner, apiKey } = ctx;
  const effectiveSessionId = resolveEffectiveSessionId(sessionId, {
    isolated,
    parallel,
    stateless,
  });
  const profile = getOrCreateTestProfile(team.id, ctx.ownerPhone, effectiveSessionId);
  const skipFw = shouldSkipFirewall({ skipFirewall });
  const storeMemory = persistMemory !== false && !stateless;

  let firewallResult = null;
  if (!skipFw) {
    firewallResult = await scopeFirewallService.evaluate({
      message: body,
      botAccountId: bot.id,
      chatProfileId: profile.id,
      ownerUserId: owner.id,
      apiKey,
    });
  }

  if (firewallResult && !firewallResult.allowed) {
    if (storeMemory) {
      memoryService.addMessage(profile.id, MESSAGE_ROLES.USER, body, {
        source: MESSAGE_SOURCES.WHATSAPP,
      });
    }

    if (firewallResult.mode === 'silent') {
      return {
        teamId: team.id,
        teamName: team.name,
        sessionId: effectiveSessionId,
        requestedSessionId: sessionId,
        isolated: effectiveSessionId !== sessionId,
        chatProfileId: profile.id,
        blocked: true,
        silent: true,
        firewall: {
          tier: firewallResult.tier,
          reason: firewallResult.reason,
          category: firewallResult.category,
        },
        reply: null,
      };
    }

    const redirect = String(firewallResult.redirectMessage || '').trim();
    if (storeMemory) {
      memoryService.addMessage(profile.id, MESSAGE_ROLES.ASSISTANT, redirect, {
        source: MESSAGE_SOURCES.FIREWALL,
      });
    }

    return {
      teamId: team.id,
      teamName: team.name,
      sessionId: effectiveSessionId,
      requestedSessionId: sessionId,
      isolated: effectiveSessionId !== sessionId,
      chatProfileId: profile.id,
      blocked: true,
      silent: false,
      firewall: {
        tier: firewallResult.tier,
        reason: firewallResult.reason,
        category: firewallResult.category,
      },
      reply: redirect,
      kbMeta: { mode: 'firewall', query: body, chunks: [] },
    };
  }

  if (storeMemory) {
    memoryService.addMessage(profile.id, MESSAGE_ROLES.USER, body, {
      source: MESSAGE_SOURCES.WHATSAPP,
    });
  }

  const result = await chatService.generateResponse(
    owner.id,
    profile.id,
    body,
    false,
    bot.id
  );

  const replyText = typeof result === 'object' && result?.reply != null ? result.reply : result;
  const kbMeta = typeof result === 'object' ? result.kbMeta || null : null;

  let outgoing = sanitizeUserReply(String(replyText || '').trim(), body);
  const firewallConfig = scopeFirewallService.getConfigForBot(bot.id);
  if (firewallConfig.enabled && outgoing) {
    outgoing = applyFirewallPostReply(outgoing, {
      mode: firewallConfig.mode,
      redirectMessage: firewallConfig.redirectMessage,
    });
  }

  if (!outgoing && firewallConfig.enabled && firewallConfig.mode === 'silent') {
    return {
      teamId: team.id,
      teamName: team.name,
      sessionId: effectiveSessionId,
      requestedSessionId: sessionId,
      isolated: effectiveSessionId !== sessionId,
      chatProfileId: profile.id,
      blocked: true,
      silent: true,
      firewall: { tier: 'post_reply', reason: 'contradiction_or_deny_phrase' },
      reply: null,
      kbMeta,
    };
  }

  if (outgoing && storeMemory) {
    memoryService.addMessage(profile.id, MESSAGE_ROLES.ASSISTANT, outgoing, {
      source: MESSAGE_SOURCES.ASSISTANT,
      kbMeta,
    });
  }

  logger.info(
    `Test API chat team=${team.id} profile=${profile.id} session=${effectiveSessionId} replyLen=${outgoing.length} skipFw=${skipFw} stateless=${stateless}`
  );

  return {
    teamId: team.id,
    teamName: team.name,
    sessionId: effectiveSessionId,
    requestedSessionId: sessionId,
    isolated: effectiveSessionId !== sessionId,
    chatProfileId: profile.id,
    botAccountId: bot.id,
    blocked: false,
    reply: outgoing || null,
    kbMeta,
    skipFirewall: skipFw,
    stateless,
  };
}

async function runChat(options = {}) {
  const ctx = getRuntimeContext();
  if (ctx.error) return { error: ctx.error };

  const isIsolated = Boolean(options.isolated || options.parallel || options.stateless);

  return globalLimiter.run(async () => {
    if (isIsolated) {
      return runChatInner(options);
    }
    const queueKey = sessionQueueKey(ctx.team.id, options.sessionId || 'default');
    return sessionQueue.run(queueKey, () => runChatInner(options));
  });
}

function resetSession(sessionId = 'default') {
  const ctx = getRuntimeContext();
  if (ctx.error) return { error: ctx.error };

  const profile = getOrCreateTestProfile(ctx.team.id, ctx.ownerPhone, sessionId);
  memoryService.deleteAllMessages(profile.id, { purpose: 'test_session_reset' });
  return {
    teamId: ctx.team.id,
    teamName: ctx.team.name,
    sessionId,
    chatProfileId: profile.id,
    reset: true,
  };
}

function getStatus() {
  if (!isEnabled()) {
    return { enabled: false, reason: 'TEST_API_ENABLED is not true' };
  }
  if (!getConfiguredToken()) {
    return { enabled: false, reason: 'TEST_API_TOKEN is not set' };
  }

  const ctx = getRuntimeContext();
  if (ctx.error) {
    return { enabled: true, ready: false, error: ctx.error };
  }

  return {
    enabled: true,
    ready: true,
    teamId: ctx.team.id,
    teamName: ctx.team.name,
    botAccountId: ctx.bot.id,
    ownerPhone: ctx.ownerPhone,
    hasApiKey: Boolean(ctx.apiKey),
    firewallEnabled: scopeFirewallService.getConfigForBot(ctx.bot.id).enabled,
  };
}

module.exports = {
  isEnabled,
  validateToken,
  getStatus,
  runChat,
  resetSession,
  resolveTeam,
  classifyRunError,
  resolveEffectiveSessionId,
  isSkipFirewallEnabled,
};
