const fs = require('fs');
const path = require('path');

// Single-tenant hardcoded config for the NxtWave "Intensive" assistant.
// The role/team/multi-tenant machinery was removed — this is the one and only
// system prompt + knowledge base the bot runs with.

const SYSTEM_PROMPT = fs
  .readFileSync(path.join(__dirname, 'intensive-system-prompt.txt'), 'utf8')
  .trim();

const KNOWLEDGE_BASE_PATH =
  process.env.KNOWLEDGE_BASE_PATH || 'knowledge-base/nxtwave-intensive-brain-memory-kb.txt';

// Vector store backend. 'local' = an in-server hybrid index (TF-IDF dense + BM25
// sparse, persisted to data/kb_vectors.json + data/kb_bm25_global.json). No
// third-party vector service or hosted embedding API is called.
// Set VECTOR_BACKEND=vertex|pinecone to opt back into an external service.
const VECTOR_BACKEND = (process.env.VECTOR_BACKEND || 'local').toLowerCase();

// Prompt that decides when an inbound message should raise an action item.
// Empty = feature off (matches current production config).
const ACTION_ITEM_TRIGGER_PROMPT = '';

// Scope firewall — disabled in production. Kept as a fixed shape so
// scopeFirewallService keeps working without per-bot config.
const FIREWALL = {
  enabled: false,
  mode: 'redirect',
  redirectMessage:
    "I can only help with Intensive program questions here. Your coach will follow up on anything else.",
  scopePrompt: '',
  outOfScopePrompt: '',
};

module.exports = {
  SYSTEM_PROMPT,
  KNOWLEDGE_BASE_PATH,
  VECTOR_BACKEND,
  ACTION_ITEM_TRIGGER_PROMPT,
  FIREWALL,
};
