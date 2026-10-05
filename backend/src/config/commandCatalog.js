const { COMMANDS } = require('../utils/constants');

const COMMAND_CATALOG = [
  {
    category: 'General',
    commands: [
      {
        command: COMMANDS.HELP,
        title: 'Help',
        syntax: COMMANDS.HELP,
        description: 'Shows the full command list and assistant persona.',
        where: 'Any chat',
      },
      {
        command: COMMANDS.PING,
        title: 'Ping',
        syntax: COMMANDS.PING,
        description: 'Checks if the bot is online and responding.',
        where: 'Any chat',
      },
      {
        command: COMMANDS.RESET,
        title: 'Reset history',
        syntax: COMMANDS.RESET,
        description: 'Clears stored conversation history for the current chat only.',
        where: 'Any chat',
      },
      {
        command: COMMANDS.SUMMARY,
        title: 'Summary',
        syntax: COMMANDS.SUMMARY,
        description: 'Generates an AI summary of this chat’s recent messages.',
        where: 'Any chat',
      },
      {
        command: COMMANDS.ME,
        title: 'Persona',
        syntax: COMMANDS.ME,
        description: 'Shows the assistant name and persona line.',
        where: 'Self-chat only',
      },
      {
        command: COMMANDS.TOKENS,
        title: 'Token usage',
        syntax: COMMANDS.TOKENS,
        description: 'Shows OpenAI token usage for this account, broken down by chat and category.',
        where: 'Self-chat only',
      },
    ],
  },
  {
    category: 'Contacts & profiles',
    commands: [
      {
        command: COMMANDS.CONTACTS,
        title: 'List contacts',
        syntax: COMMANDS.CONTACTS,
        description: 'Lists synced personal chats with names and phone numbers.',
        where: 'Self-chat only',
      },
      {
        command: COMMANDS.PROFILE,
        title: 'Contact profile',
        syntax: `${COMMANDS.PROFILE} show`,
        description: 'Shows role, responsibilities, and relations for a contact.',
        where: 'Any chat (view); self-chat (edit)',
        examples: [
          `${COMMANDS.PROFILE} set contact: Rahul role: teammate relations: college friend`,
        ],
      },
    ],
  },
  {
    category: 'Assistant control',
    commands: [
      {
        command: COMMANDS.ASSISTANT,
        title: 'Assistant on/off',
        syntax: `${COMMANDS.ASSISTANT} [show|self on|off|contacts on|off]`,
        description:
          'Controls self-chat AI and global contact replies. Use contact: Name on|off for one person.',
        where: 'Self-chat only',
        examples: [
          COMMANDS.ASSISTANT,
          `${COMMANDS.ASSISTANT} self on`,
          `${COMMANDS.ASSISTANT} contacts off`,
          `${COMMANDS.ASSISTANT} contacts all off`,
          `${COMMANDS.ASSISTANT} contact: Priya on`,
        ],
      },
      {
        command: COMMANDS.PAUSE,
        title: 'Pause contact chat',
        syntax: `${COMMANDS.PAUSE} or ${COMMANDS.STOP}`,
        description: 'Pauses the assistant in a contact chat for 5 minutes.',
        where: 'Contact chats only',
      },
      {
        command: COMMANDS.START,
        title: 'Resume contact chat',
        syntax: `${COMMANDS.START} or ${COMMANDS.RESUME}`,
        description: 'Resumes the assistant in a paused contact chat.',
        where: 'Contact chats only',
      },
      {
        command: COMMANDS.MODEL,
        title: 'Chat model tier',
        syntax: `${COMMANDS.MODEL} fast|smart`,
        description: 'Sets default model tier for routine replies. Summaries always use the smart model.',
        where: 'Self-chat only',
      },
    ],
  },
  {
    category: 'Notes & reminders',
    commands: [
      {
        command: COMMANDS.NOTE,
        title: 'Save note',
        syntax: `${COMMANDS.NOTE} <text>`,
        description: 'Saves a personal note linked to your account.',
        where: 'Self-chat only',
        examples: [`${COMMANDS.NOTE} Follow up with the design team`],
      },
      {
        command: COMMANDS.NOTES,
        title: 'List notes',
        syntax: COMMANDS.NOTES,
        description: 'Lists all saved notes.',
        where: 'Self-chat only',
      },
      {
        command: COMMANDS.REMIND,
        title: 'Reminder',
        syntax: `${COMMANDS.REMIND} YYYY-MM-DD HH:MM <message>`,
        description: 'Schedules a WhatsApp reminder message at the given date and time.',
        where: 'Self-chat only',
        examples: [`${COMMANDS.REMIND} 2026-06-15 09:00 Standup prep`],
      },
    ],
  },
  {
    category: 'Media',
    commands: [
      {
        command: '(voice)',
        title: 'Voice messages',
        syntax: 'Send a voice note',
        description: 'Transcribed with Whisper, then answered like a normal text message.',
        where: 'Any chat',
      },
      {
        command: '(pdf)',
        title: 'PDF documents',
        syntax: 'Send a PDF file',
        description: 'Text is extracted and summarized using the PDF summary prompt.',
        where: 'Any chat',
      },
    ],
  },
];

function getCommandCatalog() {
  return COMMAND_CATALOG;
}

module.exports = { COMMAND_CATALOG, getCommandCatalog };
