const noteService = require('../services/noteService');

function execute(userId) {
  const notes = noteService.getNotesByUser(userId);
  const formatted = noteService.formatNotesList(notes);
  return `*Your Notes*\n\n${formatted}`;
}

module.exports = { execute };
