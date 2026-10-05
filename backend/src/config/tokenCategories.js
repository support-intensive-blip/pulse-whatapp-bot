const TOKEN_CATEGORIES = {
  KB: 'kb',
  CHAT: 'chat',
  CONTEXT: 'context',
  SUMMARY: 'summary',
  PDF: 'pdf',
  VOICE: 'voice',
  PROFILE: 'profile',
  FIREWALL: 'firewall',
  BLOCKED: 'blocked',
  ACTION_TRIGGER: 'action_trigger',
};

const CATEGORY_LABELS = {
  kb: 'Knowledge base',
  chat: 'Chat replies',
  context: 'Context / memory',
  summary: 'Summaries',
  pdf: 'PDF',
  voice: 'Voice',
  profile: 'Profile extract',
  firewall: 'AI firewall',
  blocked: 'Blocked (no LLM)',
  action_trigger: 'Call to Action',
};

module.exports = {
  TOKEN_CATEGORIES,
  CATEGORY_LABELS,
};
