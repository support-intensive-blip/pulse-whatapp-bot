const noteService = require('../services/noteService');

function execute(userId, args) {
  if (!args || !args.trim()) {
    return 'Please provide note content. Example: /note Buy groceries';
  }

  noteService.addNote(userId, args.trim());
  return `Note saved: "${args.trim()}"`;
}

module.exports = { execute };
