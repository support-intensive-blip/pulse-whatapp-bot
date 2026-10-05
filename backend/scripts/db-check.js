const Database = require('better-sqlite3');
const db = new Database('/app/data/assistant.db');

const bots = db.prepare('SELECT id, dashboard_user_id, whatsapp_phone, status FROM bot_accounts').all();
const profiles = db
  .prepare(
    `SELECT id, owner_phone, chat_id, contact_name, contact_phone, chat_type
     FROM chat_profiles ORDER BY id DESC LIMIT 30`
  )
  .all();
const selfChats = db.prepare("SELECT id, owner_phone, chat_id, contact_name FROM chat_profiles WHERE chat_type='self'").all();
const msgCount = db.prepare('SELECT COUNT(*) c FROM messages').get();
const msgsByProfile = db
  .prepare(
    `SELECT chat_profile_id, COUNT(*) c FROM messages GROUP BY chat_profile_id ORDER BY c DESC LIMIT 10`
  )
  .all();
const recentMsgs = db
  .prepare(
    `SELECT m.id, m.chat_profile_id, m.role, m.source, substr(m.content,1,60) content, cp.chat_type, cp.contact_name
     FROM messages m
     LEFT JOIN chat_profiles cp ON cp.id = m.chat_profile_id
     ORDER BY m.id DESC LIMIT 15`
  )
  .all();

console.log(
  JSON.stringify(
    { bots, profileCount: profiles.length, selfChatCount: selfChats.length, selfChats, msgCount, msgsByProfile, recentMsgs, sampleProfiles: profiles },
    null,
    2
  )
);
