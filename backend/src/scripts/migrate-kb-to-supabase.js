#!/usr/bin/env node
/**
 * Moves every bot's knowledge-base index into Supabase pgvector: the KB text already
 * lives in knowledge_resources, so each bot's linked documents are re-embedded
 * (OpenAI) and written to Supabase. Safe to re-run — a bot whose Supabase index is
 * already current is skipped unless --force is given.
 *
 * The server does the same lazily on boot once VECTOR_BACKEND=supabase; run this
 * first to warm the index so no bot answers without KB after the switch.
 *
 * Usage:
 *   npm run kb:migrate-supabase              # every active bot
 *   npm run kb:migrate-supabase -- --force   # re-embed even if up to date
 *   npm run kb:migrate-supabase -- --bot=3   # one bot
 *
 * Needs SUPABASE_DB_URL (Session pooler URI) and OPENAI_API_KEY.
 */
require('dotenv').config();

process.env.VECTOR_BACKEND = 'supabase';

const { initializeDatabaseAsync } = require('../database/db');
const knowledgeBaseService = require('../services/knowledgeBaseService');
const { botAccountService } = require('../services/botAccountService');
const supabaseVectorStore = require('../services/supabaseVectorStore');

async function main() {
  if (!supabaseVectorStore.isEnabled()) throw new Error('Set SUPABASE_DB_URL in .env');
  await initializeDatabaseAsync();
  await supabaseVectorStore.ensureSchema();

  const force = process.argv.includes('--force');
  const botArg = process.argv.find((arg) => arg.startsWith('--bot='));
  const bots = botArg
    ? [botAccountService.findById(Number(botArg.split('=')[1]))].filter(Boolean)
    : botAccountService.listAll({ includeInactive: false });
  if (!bots.length) throw new Error('No matching bots');

  let failed = 0;
  for (const bot of bots) {
    if (!botAccountService.parseKnowledgeResourceIds(bot).length) {
      console.log(`- bot ${bot.id} (${bot.name}): no linked knowledge, skipped`);
      continue;
    }
    const ok = await knowledgeBaseService.initializeBot(bot, { force });
    const status = await knowledgeBaseService.getBotStatus(bot);
    if (!ok) failed += 1;
    console.log(
      `${ok ? '✓' : '✗'} bot ${bot.id} (${bot.name}): ${status.chunkCount} vectors` +
        (ok ? '' : ` — ${status.indexing?.error || 'indexing failed'}`)
    );
  }

  await supabaseVectorStore.close();
  if (failed) throw new Error(`${failed} bot(s) failed to index`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
