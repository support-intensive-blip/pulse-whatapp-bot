const { COMMANDS } = require('../utils/constants');
const { getAssistantPersona } = require('../config/assistantIdentity');

function execute() {
  return `*WhatsApp AI Assistant — Commands*

${COMMANDS.HELP} — Show this help message
${COMMANDS.PING} — Check if the bot is online
${COMMANDS.RESET} — Clear conversation history for this chat
${COMMANDS.SUMMARY} — Generate a summary for this chat
${COMMANDS.ME} — Assistant persona
${COMMANDS.CONTACTS} — List personal chats with names and numbers
${COMMANDS.PROFILE} — Contact role/relations (set in self-chat only)
${COMMANDS.ASSISTANT} — Show assistant status (self-chat + contacts)
${COMMANDS.ASSISTANT} self on|off — Your Message Yourself chat
${COMMANDS.ASSISTANT} contacts on|off — All contact chats (pinned stay ON)
${COMMANDS.ASSISTANT} contact: Name on|off — One contact
${COMMANDS.ASSISTANT} contacts all off — Force disable every contact
${COMMANDS.PAUSE} or ${COMMANDS.STOP} — Pause contact chat 5 min
${COMMANDS.START} or ${COMMANDS.RESUME} — Resume contact chat
${COMMANDS.NOTE} <text> — Save a note (e.g. ${COMMANDS.NOTE} Buy groceries)
${COMMANDS.NOTES} — List your saved notes
${COMMANDS.REMIND} YYYY-MM-DD HH:MM <message> — Set a reminder
${COMMANDS.MODEL} fast|smart — Routine chat model (summaries always use smart)

*Media Support*
• Send a voice message — I'll transcribe and respond
• Send a PDF — I'll summarize the document

${getAssistantPersona()}

*Self-chat only:* All commands work here — profiles, ${COMMANDS.ASSISTANT}, notes, reminders, AI control.
*Contact chats:* AI replies only. No commands — use self-chat ${COMMANDS.ASSISTANT} to enable/disable contacts.`;
}

module.exports = { execute };
