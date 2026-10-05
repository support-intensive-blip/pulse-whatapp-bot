const { initializeDatabaseAsync, getDatabase } = require('../src/database/db');

(async () => {
  await initializeDatabaseAsync();
  const db = getDatabase();
  const kbPath = 'knowledge-base/nxtwave-intensive-brain-memory-kb.txt';
  db.prepare(
    `UPDATE team_settings SET knowledge_base_path = ?, updated_at = datetime('now') WHERE team_id = 1`
  ).run(kbPath);
  const row = db
    .prepare('SELECT team_id, knowledge_base_path FROM team_settings WHERE team_id = 1')
    .get();
  console.log(JSON.stringify(row));
  process.exit(0);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
