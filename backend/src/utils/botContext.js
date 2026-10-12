const { AsyncLocalStorage } = require('async_hooks');

/**
 * Which bot (Gallabox number) the current async call chain is working for.
 * Prompt, assistant identity and KB getters read it instead of process.env, so
 * several bots can answer concurrently without overwriting each other's config.
 * Outside a bot context (scripts, legacy callers) getters fall back to defaults.
 */
const storage = new AsyncLocalStorage();

/** `overrides` replaces bot_accounts fields for this call only (e.g. a draft prompt in the playground). */
function runWithBot(botAccountId, fn, { overrides = null } = {}) {
  if (!botAccountId) return fn();
  return storage.run({ botAccountId: Number(botAccountId), overrides }, fn);
}

function currentBotId() {
  return storage.getStore()?.botAccountId || null;
}

function currentBot() {
  const store = storage.getStore();
  if (!store?.botAccountId) return null;
  // Lazy require: botAccountService → db → … must not load at module init.
  const { botAccountService } = require('../services/botAccountService');
  const bot = botAccountService.findById(store.botAccountId);
  return bot && store.overrides ? { ...bot, ...store.overrides } : bot;
}

module.exports = { runWithBot, currentBotId, currentBot };
