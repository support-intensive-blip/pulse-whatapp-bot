const intensiveConfig = require('../config/intensiveConfig');
const { getGroqClient } = require('../ai/groqClient');
const { MODEL_TIERS, getChatTemperature } = require('../config/modelConfig');
const { TOKEN_CATEGORIES } = require('../config/tokenCategories');
const logger = require('../utils/logger');

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

function buildClassifierSystemPrompt(scopePrompt, outOfScopePrompt) {
  const lines = [
    'You are a scope-compliance gate for a WhatsApp assistant.',
    'Decide whether the incoming student message is IN SCOPE (the assistant is allowed to answer it) or OUT OF SCOPE (it must be blocked).',
  ];

  if (scopePrompt) {
    lines.push('', 'In-scope topics this assistant is configured to handle:', scopePrompt);
  }
  if (outOfScopePrompt) {
    lines.push('', 'Out-of-scope topics that must be blocked:', outOfScopePrompt);
  }

  lines.push(
    '',
    'Casual greetings, thanks, and small talk are always in scope.',
    'Respond with JSON only: {"inScope":boolean,"reason":string}',
    'reason: short phrase explaining the decision (max 12 words).'
  );

  return lines.join('\n');
}

class ScopeFirewallService {
  getConfigForBot() {
    const fw = intensiveConfig.FIREWALL;
    return {
      enabled: Boolean(fw.enabled),
      mode: fw.mode === 'silent' ? 'silent' : 'redirect',
      redirectMessage: fw.redirectMessage || '',
      scopePrompt: fw.scopePrompt || '',
      outOfScopePrompt: fw.outOfScopePrompt || '',
    };
  }

  async evaluate({ message, botAccountId, chatProfileId, ownerUserId, apiKey } = {}) {
    const config = this.getConfigForBot(botAccountId);

    if (!config.enabled || (!config.scopePrompt && !config.outOfScopePrompt) || !apiKey) {
      return { allowed: true };
    }

    try {
      const groq = getGroqClient(apiKey);
      const response = await groq.chat(
        [
          {
            role: 'system',
            content: buildClassifierSystemPrompt(config.scopePrompt, config.outOfScopePrompt),
          },
          { role: 'user', content: String(message || '') },
        ],
        {
          temperature: getChatTemperature(),
          tier: MODEL_TIERS.FAST,
          usageContext: { chatProfileId, ownerUserId, category: TOKEN_CATEGORIES.FIREWALL },
        }
      );

      const parsed = parseClassifierJson(response);
      if (parsed && parsed.inScope === false) {
        return {
          allowed: false,
          tier: 'scope',
          reason: parsed.reason || 'out_of_scope',
          mode: config.mode,
          redirectMessage: config.redirectMessage,
        };
      }

      return { allowed: true };
    } catch (error) {
      logger.warn(`Scope firewall classifier failed (fail-open): ${error.message}`);
      return { allowed: true };
    }
  }
}

module.exports = new ScopeFirewallService();
