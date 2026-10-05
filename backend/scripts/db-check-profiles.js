const Database = require('better-sqlite3');
const db = new Database('/app/data/assistant.db');

const ids = [458, 459, 460, 557, 558, 461];
const profiles = db
  .prepare(`SELECT * FROM chat_profiles WHERE id IN (${ids.join(',')})`)
  .all();

const bot2Profiles = db
  .prepare("SELECT COUNT(*) c FROM chat_profiles WHERE owner_phone='919281433572'")
  .get();
const bot1Profiles = db
  .prepare("SELECT COUNT(*) c FROM chat_profiles WHERE owner_phone='916309499278'")
  .get();

console.log(JSON.stringify({ profiles, bot1Profiles, bot2Profiles }, null, 2));
