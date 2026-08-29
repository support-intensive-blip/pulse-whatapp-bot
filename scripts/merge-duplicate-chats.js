const chatProfileService = require('./src/services/chatProfileService');
const { getDatabase } = require('./src/database/db');

getDatabase();

const merges = [
  [460, 558],
];
const deletes = [459];

for (const [keepId, dropId] of merges) {
  chatProfileService.mergeProfiles(keepId, dropId);
}

const db = getDatabase();
for (const id of deletes) {
  db.prepare('DELETE FROM chat_profiles WHERE id = ?').run(id);
}

console.log('Cleanup complete', { merges, deletes });
