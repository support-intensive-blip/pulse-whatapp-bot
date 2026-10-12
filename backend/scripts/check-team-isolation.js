require('dotenv').config();
const { initializeDatabaseAsync, getDatabase } = require('../src/database/db');
const { botAccountService } = require('../src/services/botAccountService');
const conversationService = require('../src/services/conversationService');

(async () => {
  await initializeDatabaseAsync();
  const db = getDatabase();

  const bots = db
    .prepare(
      'SELECT id, team_id, whatsapp_phone, last_whatsapp_phone FROM bot_accounts ORDER BY id'
    )
    .all();

  console.log('=== Bot accounts ===');
  for (const bot of bots) {
    const ownerPhone = botAccountService.getPhone(bot);
    const chats = ownerPhone ? conversationService.listForOwner(ownerPhone, { limit: 5 }) : [];
    console.log({
      botId: bot.id,
      teamId: bot.team_id,
      whatsapp_phone: bot.whatsapp_phone,
      last_whatsapp_phone: bot.last_whatsapp_phone,
      resolvedOwner: ownerPhone,
      sampleChats: chats.map((c) => ({ id: c.id, name: c.contactName })),
    });
  }

  console.log('\n=== Owner phone distribution ===');
  console.log(
    db
      .prepare(
        'SELECT owner_phone, COUNT(*) AS count FROM chat_profiles GROUP BY owner_phone ORDER BY count DESC'
      )
      .all()
  );

  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
