const { getCommandCatalog } = require('../config/commandCatalog');
const intensiveConfig = require('../config/intensiveConfig');
const { currentBot } = require('../utils/botContext');

// Each bot (Gallabox number) has its own published prompt in bot_accounts.system_prompt
// (history in bot_prompt_versions). Callers read it through the current bot context;
// outside one (scripts, eval harness) the hardcoded Intensive prompt is used.
// Firewall and action-item trigger config stay global (src/config/intensiveConfig.js).

// Used when a dashboard-created bot is running before anyone wrote its prompt.
const FALLBACK_PROMPT = `You are {{name}}, a helpful WhatsApp assistant.
Answer briefly and politely in plain text. If you are not sure about something, say so
and tell the person a team member will follow up. Never invent facts, links or policies.`;

function applyTemplate(text, vars = {}) {
  if (!text) return '';
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : ''));
}

function getSystemPromptText() {
  const bot = currentBot();
  if (!bot) return intensiveConfig.SYSTEM_PROMPT;
  return String(bot.system_prompt || '').trim() || FALLBACK_PROMPT;
}

function resolveStoredSystemPrompt() {
  return getSystemPromptText();
}

function hasConfiguredPrompt() {
  return Boolean(getSystemPromptText());
}

function getActionItemTriggerPrompt() {
  return intensiveConfig.ACTION_ITEM_TRIGGER_PROMPT || '';
}

function getConfigPayload() {
  const fw = intensiveConfig.FIREWALL;
  return {
    systemPrompt: getSystemPromptText(),
    systemPromptDefault: '',
    promptConfigured: true,
    actionItemTriggerPrompt: intensiveConfig.ACTION_ITEM_TRIGGER_PROMPT || '',
    actionNotificationPhones: '',
    firewallEnabled: Boolean(fw.enabled),
    firewallMode: fw.mode === 'silent' ? 'silent' : 'redirect',
    firewallRedirectMessage: fw.redirectMessage || '',
    firewallScopePrompt: fw.scopePrompt || '',
    firewallOutOfScopePrompt: fw.outOfScopePrompt || '',
    commands: getCommandCatalog(),
  };
}

module.exports = {
  applyTemplate,
  getSystemPromptText,
  resolveStoredSystemPrompt,
  hasConfiguredPrompt,
  getActionItemTriggerPrompt,
  getConfigPayload,
};
