const { getCommandCatalog } = require('../config/commandCatalog');
const intensiveConfig = require('../config/intensiveConfig');

// Single-tenant: the system prompt, KB and firewall config are hardcoded in
// src/config/intensiveConfig.js. This module is now just a thin accessor kept so
// existing callers (systemPrompts, scopeFirewallService, escalationService) don't
// need to know where the values live.

function applyTemplate(text, vars = {}) {
  if (!text) return '';
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : ''));
}

function getSystemPromptText() {
  return intensiveConfig.SYSTEM_PROMPT;
}

function resolveStoredSystemPrompt() {
  return intensiveConfig.SYSTEM_PROMPT;
}

function hasConfiguredPrompt() {
  return Boolean(intensiveConfig.SYSTEM_PROMPT);
}

function getActionItemTriggerPrompt() {
  return intensiveConfig.ACTION_ITEM_TRIGGER_PROMPT || '';
}

function getConfigPayload() {
  const fw = intensiveConfig.FIREWALL;
  return {
    systemPrompt: intensiveConfig.SYSTEM_PROMPT,
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
