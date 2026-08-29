const { getDatabase } = require('../database/db');
const logger = require('../utils/logger');

const MAX_NOTE_CHARS = Number(process.env.ROUTING_SLOTS_NOTE_MAX_CHARS) || 480;

const JOB_TRACK_PATTERNS = [
  ['MERN Full Stack', /\bmern(?:\s+full\s+stack)?\b/i],
  ['Java Full Stack', /\bjava(?:\s+full\s+stack)?\b/i],
  ['QA Automation', /\bqa(?:\s+automation)?\b/i],
  ['Data Analytics', /\bdata\s+analytics\b/i],
  ['Python Full Stack', /\bpython(?:\s+full\s+stack)?\b/i],
];

function parseStored(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function extractSlotsFromText(text) {
  const updates = {};
  const q = String(text || '').trim();
  if (!q) return updates;

  const lower = q.toLowerCase();

  const programMatch =
    q.match(/\b(?:intensive|program|version|batch)?\s*(1\.0|2\.0|3\.0)\b/i) ||
    lower.match(/\bversion\s+(one|two|three|1|2|3)\b/);
  if (programMatch) {
    const token = String(programMatch[1]).toLowerCase();
    const versionMap = { one: '1.0', two: '2.0', three: '3.0', '1': '1.0', '2': '2.0', '3': '3.0' };
    updates.programVersion = versionMap[token] || programMatch[1];
  }

  const gcMatch = q.match(/\bGC\s*([1-4])\b/i) || lower.match(/growth\s*cycle\s*([1-4])/);
  if (gcMatch) {
    updates.growthCycle = `GC${gcMatch[1]}`;
  } else if (/placement\s*prep(?:aration)?/i.test(q)) {
    updates.growthCycle = 'Placement Prep';
  }

  for (const [label, pattern] of JOB_TRACK_PATTERNS) {
    if (pattern.test(q)) {
      updates.jobTrack = label;
      break;
    }
  }

  return updates;
}

function compactSlots(slots) {
  const out = {};
  if (slots.programVersion) out.programVersion = String(slots.programVersion).slice(0, 16);
  if (slots.growthCycle) out.growthCycle = String(slots.growthCycle).slice(0, 32);
  if (slots.jobTrack) out.jobTrack = String(slots.jobTrack).slice(0, 48);
  if (slots.topic) out.topic = String(slots.topic).slice(0, 120);
  // Internal TTL marker for Intensive context expiry (not shown to the LLM).
  if (slots._contextSetAt) out._contextSetAt = String(slots._contextSetAt).slice(0, 40);
  return out;
}

class ConversationSlotsService {
  getSlots(chatProfileId) {
    const db = getDatabase();
    const row = db
      .prepare('SELECT routing_slots FROM chat_profiles WHERE id = ?')
      .get(chatProfileId);
    return compactSlots(parseStored(row?.routing_slots));
  }

  saveSlots(chatProfileId, slots) {
    const db = getDatabase();
    const compact = compactSlots(slots);
    db.prepare(
      `UPDATE chat_profiles
       SET routing_slots = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(Object.keys(compact).length ? JSON.stringify(compact) : null, chatProfileId);
    return compact;
  }

  clearSlots(chatProfileId) {
    const db = getDatabase();
    db.prepare(
      `UPDATE chat_profiles
       SET routing_slots = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(chatProfileId);
  }

  updateFromMessage(chatProfileId, userMessage, { topic = null, clearTopic = false } = {}) {
    const current = this.getSlots(chatProfileId);
    const extracted = extractSlotsFromText(userMessage);
    const next = { ...current, ...extracted };

    if (clearTopic) {
      delete next.topic;
    } else if (topic) {
      next.topic = topic;
    }

    const changed = JSON.stringify(compactSlots(current)) !== JSON.stringify(compactSlots(next));
    if (!changed) return next;

    const saved = this.saveSlots(chatProfileId, next);
    logger.info(
      `Routing slots profile=${chatProfileId}: ${JSON.stringify(saved)}`
    );
    return saved;
  }

  buildContextNote(chatProfileId) {
    const slots = this.getSlots(chatProfileId);
    const lines = [];

    if (slots.programVersion) lines.push(`Program version: ${slots.programVersion}`);
    if (slots.growthCycle) lines.push(`Growth cycle: ${slots.growthCycle}`);
    if (slots.jobTrack) lines.push(`Job track: ${slots.jobTrack}`);
    if (slots.topic) lines.push(`Active topic: ${slots.topic}`);

    if (!lines.length) return '';

    const body = [
      'Resolved conversation state (internal routing — do not repeat verbatim to the student unless relevant):',
      ...lines.map((line) => `- ${line}`),
      'Carry these across follow-ups. Do not re-ask for values already resolved unless the student contradicts them.',
    ].join('\n');

    if (body.length <= MAX_NOTE_CHARS) return body;
    return `${body.slice(0, MAX_NOTE_CHARS - 3)}...`;
  }
}

module.exports = {
  conversationSlotsService: new ConversationSlotsService(),
  extractSlotsFromText,
  compactSlots,
};
