#!/usr/bin/env node
/**
 * Create or verify a Pinecone integrated index for Pulse team knowledge bases.
 *
 * Usage:
 *   PINECONE_API_KEY=... PINECONE_INDEX=pulse-kb node src/scripts/setup-pinecone.js
 */
require('dotenv').config();

const { Pinecone } = require('@pinecone-database/pinecone');

const INDEX_NAME = process.env.PINECONE_INDEX || 'pulse-kb';
const CLOUD = process.env.PINECONE_CLOUD || 'aws';
const REGION = process.env.PINECONE_REGION || 'us-east-1';
const EMBED_MODEL = process.env.PINECONE_EMBED_MODEL || 'multilingual-e5-large';
const EMBED_FIELD = process.env.PINECONE_EMBED_FIELD || 'chunk_text';
const EMBED_INPUT_KEY = process.env.PINECONE_EMBED_INPUT_KEY || 'text';
const WRITE_INPUT_TYPE = process.env.PINECONE_WRITE_INPUT_TYPE || 'passage';
const READ_INPUT_TYPE = process.env.PINECONE_READ_INPUT_TYPE || 'passage';
const EMBED_TRUNCATE = process.env.PINECONE_EMBED_TRUNCATE || 'END';
const EMBED_DIMENSIONS = Number(process.env.PINECONE_EMBED_DIMENSIONS) || 1024;
const VECTOR_METRIC = process.env.PINECONE_METRIC || 'cosine';

const embedParams = { input_type: WRITE_INPUT_TYPE, truncate: EMBED_TRUNCATE };

async function main() {
  if (!process.env.PINECONE_API_KEY) {
    console.error('PINECONE_API_KEY is required');
    process.exit(1);
  }

  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const existing = await pc.listIndexes();
  const names = (existing.indexes || []).map((item) => item.name);

  if (names.includes(INDEX_NAME)) {
    const desc = await pc.describeIndex(INDEX_NAME);
    console.log(`Index "${INDEX_NAME}" already exists`);
    console.log(`  host: ${desc.host}`);
    console.log(`  embed model: ${desc.embeddedModel || desc.model || 'see Pinecone console'}`);
    if (desc.host) {
      console.log(`PINECONE_HOST=${desc.host}`);
    }
    return;
  }

  console.log(`Creating integrated index "${INDEX_NAME}" with model ${EMBED_MODEL}...`);
  await pc.createIndexForModel({
    name: INDEX_NAME,
    cloud: CLOUD,
    region: REGION,
    embed: {
      model: EMBED_MODEL,
      metric: VECTOR_METRIC,
      dimension: EMBED_DIMENSIONS,
      fieldMap: { [EMBED_INPUT_KEY]: EMBED_FIELD },
      writeParameters: embedParams,
      readParameters: { input_type: READ_INPUT_TYPE, truncate: EMBED_TRUNCATE },
    },
    waitUntilReady: true,
  });

  const desc = await pc.describeIndex(INDEX_NAME);
  console.log('Integrated index ready (server-side embed + cache).');
  console.log(`  host: ${desc.host}`);
  console.log('');
  console.log('Add to .env:');
  console.log(`PINECONE_API_KEY=...`);
  console.log(`PINECONE_INDEX=${INDEX_NAME}`);
  console.log(`PINECONE_INTEGRATED=true`);
  console.log(`PINECONE_EMBED_MODEL=${EMBED_MODEL}`);
  console.log(`PINECONE_EMBED_FIELD=${EMBED_FIELD}`);
  console.log(`PINECONE_EMBED_INPUT_KEY=${EMBED_INPUT_KEY}`);
  console.log(`PINECONE_WRITE_INPUT_TYPE=${WRITE_INPUT_TYPE}`);
  console.log(`PINECONE_READ_INPUT_TYPE=${READ_INPUT_TYPE}`);
  console.log(`PINECONE_EMBED_TRUNCATE=${EMBED_TRUNCATE}`);
  if (desc.host) {
    console.log(`PINECONE_HOST=${desc.host}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
