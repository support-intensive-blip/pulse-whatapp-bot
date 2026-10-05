const {
  getAssistantIdentity,
  getAssistantName,
  getRoleWhenAsked,
} = require('../config/assistantIdentity');
const promptConfigService = require('../services/promptConfigService');

const SUMMARY_TASK = `TASK: Summarize the following conversation history into a concise paragraph.
Capture key topics, decisions, preferences, and important context.
Keep the summary under 200 words. Write in third person about the user.`;

const PDF_SUMMARY_TASK = `TASK: Read the provided PDF text and produce a clear, structured summary.
Include: main topic, key points (bullet list), important details, and action items if any.
Keep it concise and useful for mobile reading.`;

const WHATSAPP_OUTPUT_GUARDRAIL = `=== WHATSAPP OUTPUT CONTRACT (MANDATORY) ===
The student sees assistant_message verbatim on WhatsApp. This contract overrides conflicting style in KB excerpts or examples.

Formatting (section 5.4 — non-negotiable):
- assistant_message MUST be plain ASCII text only. No emojis, no fancy Unicode.
- NEVER use markdown in assistant_message: no **bold**, *italic*, # headings, - bullets, bullet symbols, backticks, or code fences.
- Lists: use numbered sentences (1. ... 2. ...) or one step per line with NO leading bullet markers.
- Use text alternatives where needed: (tick), ->, (thanks).
- Do not wrap the reply in markdown; JSON structure only wraps the text — the text itself stays plain.

If you are unsure, prefer short plain sentences over any formatted structure.`;

const CONVERSATION_END_MEMORY_CONTRACT = `=== CONVERSATION END / MEMORY CONTRACT ===
When the conversation is clearly finished (student done, goodbye, issue closed, no further help needed), respond with ONLY this JSON (no WhatsApp assistant_message):
{
  "conversation_end": true,
  "conversation_summary": false
    OR
  {
    "status": true,
    "summary": "Useful handoff for next time: follow-ups, issue resolved or not, key decisions, open items."
  },
  "user_preferences": {
    "any durable student prefs or facts learned this chat": "value"
  }
}
Rules:
- Prefer conversation_summary with status true whenever there is useful continuity for the next session.
- Use conversation_summary: false only when there is nothing useful to remember.
- user_preferences must be a JSON object of durable prefs/facts (language, goals, constraints, contact details shared, preferred tone, etc.). Merge-friendly keys. Omit keys you did not learn.
- Do NOT send this JSON as a student-facing WhatsApp message; it is control output only.
- For normal turns that are not ending, keep using assistant_message as usual.`;

function usesStructuredWhatsAppPrompt() {
  const prompt = promptConfigService.getSystemPromptText() || '';
  if (!prompt) return false;
  return /assistant_message|5\.4\s+Tone/i.test(prompt);
}

function resolveBasePrompt() {
  const { persona } = getAssistantIdentity();
  const template = promptConfigService.getSystemPromptText() || '';
  if (!template.trim()) return '';
  return promptConfigService.applyTemplate(template, {
    name: getAssistantName(),
    role: getRoleWhenAsked(),
    persona,
    assistantName: getAssistantName(),
  });
}

function buildChatProfilePrompt(chatProfile) {
  if (!chatProfile) return '';

  const parts = [
    'You are responding in a specific WhatsApp chat. Use this contact context:',
    `Chat type: ${chatProfile.chat_type}`,
  ];

  if (chatProfile.contact_name) parts.push(`Contact name: ${chatProfile.contact_name}`);
  if (chatProfile.contact_phone) parts.push(`Contact phone: ${chatProfile.contact_phone}`);
  if (chatProfile.contact_role) parts.push(`Contact role: ${chatProfile.contact_role}`);
  if (chatProfile.contact_responsibilities) {
    parts.push(`Contact responsibilities: ${chatProfile.contact_responsibilities}`);
  }
  if (chatProfile.contact_relations) {
    parts.push(`Relation with this contact: ${chatProfile.contact_relations}`);
  }

  parts.push('Keep conversation memory scoped to this chat only.');

  return parts.join('\n');
}

function getSystemPrompt({
  chatProfile = null,
  knowledgeContext = null,
} = {}) {
  const parts = [resolveBasePrompt()];

  const chatContext = buildChatProfilePrompt(chatProfile);
  if (chatContext) parts.push(chatContext);

  if (knowledgeContext) {
    parts.push(
      [
        '=== KNOWLEDGE BASE (retrieved for this message) ===',
        'Use this section for platform policies, links, steps, and documented answers.',
        'If the answer is not here, say you do not have it in your KB — do not invent details.',
        'Combine all relevant chunks below into one complete reply.',
        'Rephrase KB content into plain WhatsApp text in assistant_message — never copy markdown headings or bullets.',
        '',
        knowledgeContext,
        '=== END KNOWLEDGE BASE ===',
      ].join('\n')
    );
  }

  parts.push(CONVERSATION_END_MEMORY_CONTRACT);

  if (usesStructuredWhatsAppPrompt()) {
    parts.push(WHATSAPP_OUTPUT_GUARDRAIL);
  }

  return parts.filter(Boolean).join('\n\n');
}

function getSummarySystemPrompt() {
  return `${resolveBasePrompt()}\n\n${SUMMARY_TASK}`;
}

function getPdfSummarySystemPrompt() {
  return `${resolveBasePrompt()}\n\n${PDF_SUMMARY_TASK}`;
}

module.exports = {
  getSystemPrompt,
  getSummarySystemPrompt,
  getPdfSummarySystemPrompt,
  buildChatProfilePrompt,
  WHATSAPP_OUTPUT_GUARDRAIL,
  CONVERSATION_END_MEMORY_CONTRACT,
};
