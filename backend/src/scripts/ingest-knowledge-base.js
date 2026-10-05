require('dotenv').config();

const knowledgeBaseService = require('../services/knowledgeBaseService');
const logger = require('../utils/logger');

async function main() {
  const teamArg = process.argv.find((arg) => arg.startsWith('--team='));
  const teamId = teamArg ? parseInt(teamArg.split('=')[1], 10) : null;

  const ok = await knowledgeBaseService.initialize(true, teamId);
  if (!ok) {
    console.error('Knowledge base vector ingest failed');
    process.exit(1);
  }

  const status = await knowledgeBaseService.getStatus(teamId);
  console.log(`Vector KB ready: ${status.chunkCount} chunks`);
  console.log(`Backend: ${status.backend} | namespace: ${status.namespace}`);
  console.log(`Mode: ${status.mode} | topK: ${status.topK}`);
  console.log(`Source: ${status.sourcePath}`);
  console.log(`Vector store: ${status.vectorStorePath}`);
}

main().catch((error) => {
  logger.error(error.message);
  process.exit(1);
});
