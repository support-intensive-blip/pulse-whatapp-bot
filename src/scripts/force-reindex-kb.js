/**
 * Force re-index KB (semantic chunks + BM25 + Pinecone) even if source hash unchanged.
 * Usage: node src/scripts/force-reindex-kb.js [--team=1]
 */
require('dotenv').config();

const path = require('path');
const { initializeDatabaseAsync } = require('../database/db');
const knowledgeBaseService = require('../services/knowledgeBaseService');
const vectorStoreService = require('../services/vectorStoreService');

async function main() {
  await initializeDatabaseAsync();

  const pathArg = process.argv.find((arg) => arg.startsWith('--path='));
  const teamArg = process.argv.find((arg) => arg.startsWith('--team='));
  const teamId = teamArg ? parseInt(teamArg.split('=')[1], 10) : null;

  const sourcePath = pathArg
    ? path.resolve(pathArg.split('=').slice(1).join('='))
    : path.resolve(knowledgeBaseService.resolveSourcePath(teamId));
  const fullText = await knowledgeBaseService.loadSourceText(sourcePath);
  const sourceHash = vectorStoreService.hashSource(sourcePath);

  console.log(`Re-indexing team=${teamId ?? 'global'} from ${sourcePath}`);
  const count = await vectorStoreService.indexDocument(teamId, fullText, sourceHash);
  const status = await knowledgeBaseService.getStatus(teamId);

  console.log(JSON.stringify({
    indexedChunks: count,
    chunkCount: status.chunkCount,
    mode: status.mode,
    backend: status.backend,
    metric: status.metric,
    dimensions: status.dimensions,
    namespace: status.namespace,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
