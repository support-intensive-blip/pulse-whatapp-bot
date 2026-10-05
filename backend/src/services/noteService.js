const { getDatabase } = require('../database/db');
const logger = require('../utils/logger');

class NoteService {
  addNote(userId, content) {
    const db = getDatabase();
    const result = db
      .prepare('INSERT INTO notes (user_id, content) VALUES (?, ?)')
      .run(userId, content);

    logger.info(`Note created for user ${userId}`);
    return this.findById(result.lastInsertRowid);
  }

  findById(id) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM notes WHERE id = ?').get(id) || null;
  }

  getNotesByUser(userId) {
    const db = getDatabase();
    return db
      .prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId);
  }

  getAll() {
    const db = getDatabase();
    return db
      .prepare(
        `SELECT n.*, u.phone, u.name
         FROM notes n
         JOIN users u ON n.user_id = u.id
         ORDER BY n.created_at DESC`
      )
      .all();
  }

  getCount() {
    const db = getDatabase();
    const result = db.prepare('SELECT COUNT(*) as count FROM notes').get();
    return result.count;
  }

  formatNotesList(notes) {
    if (!notes || notes.length === 0) {
      return 'You have no saved notes.';
    }

    return notes
      .map((note, index) => {
        const date = new Date(note.created_at).toLocaleDateString();
        return `${index + 1}. ${note.content} _(${date})_`;
      })
      .join('\n');
  }
}

module.exports = new NoteService();
