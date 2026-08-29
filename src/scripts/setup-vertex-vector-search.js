#!/usr/bin/env node
/**
 * Provision a Vertex AI Vector Search index + endpoint for the KB.
 *
 * This creates BILLED, always-on infrastructure (a deployed Index Endpoint
 * bills per node-hour continuously, even idle). Only run this when you're
 * ready to commit to that cost.
 *
 * Usage:
 *   GCP_PROJECT_ID=... node src/scripts/setup-vertex-vector-search.js
 */
require('dotenv').config();

const axios = require('axios');
const vertexAuth = require('../services/vertexAuth');

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const REGION = process.env.VERTEX_REGION || 'us-central1';
const EMBED_DIMENSIONS = Number(process.env.VERTEX_EMBED_DIMENSIONS) || 768;
const INDEX_DISPLAY_NAME = process.env.VERTEX_INDEX_DISPLAY_NAME || 'pulse-kb';
const ENDPOINT_DISPLAY_NAME = process.env.VERTEX_ENDPOINT_DISPLAY_NAME || 'pulse-kb-endpoint';
const DEPLOYED_INDEX_ID = process.env.VERTEX_DEPLOYED_INDEX_ID || 'pulse_kb_deployed';
// Smallest practical machine; still bills continuously once deployed.
const MACHINE_TYPE = process.env.VERTEX_MACHINE_TYPE || 'e2-standard-2';
const BUCKET_NAME = process.env.VERTEX_INIT_BUCKET || `${PROJECT_ID}-vector-search-init`;

function baseUrl() {
  return `https://${REGION}-aiplatform.googleapis.com/v1`;
}

async function headers() {
  return vertexAuth.authHeaders();
}

async function pollOperation(operationName) {
  const url = `https://${REGION}-aiplatform.googleapis.com/v1/${operationName}`;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await axios.get(url, { headers: await headers() });
    if (data.done) {
      if (data.error) throw new Error(`Operation failed: ${JSON.stringify(data.error)}`);
      return data.response;
    }
    process.stdout.write('.');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
}

async function ensureInitBucket() {
  const h = await headers();
  try {
    await axios.get(`https://storage.googleapis.com/storage/v1/b/${BUCKET_NAME}`, { headers: h });
    console.log(`GCS init bucket gs://${BUCKET_NAME} already exists`);
  } catch (error) {
    if (error.response?.status !== 404) throw error;
    console.log(`Creating GCS init bucket gs://${BUCKET_NAME}...`);
    await axios.post(
      `https://storage.googleapis.com/storage/v1/b?project=${PROJECT_ID}`,
      { name: BUCKET_NAME, location: REGION },
      { headers: h }
    );
  }
  return `gs://${BUCKET_NAME}/`;
}

async function findExistingByDisplayName(resourceType, displayName) {
  const h = await headers();
  const { data } = await axios.get(`${baseUrl()}/projects/${PROJECT_ID}/locations/${REGION}/${resourceType}`, {
    headers: h,
  });
  const list = data[resourceType] || [];
  return list.find((item) => item.displayName === displayName) || null;
}

async function createIndex(contentsDeltaUri) {
  const existing = await findExistingByDisplayName('indexes', INDEX_DISPLAY_NAME);
  if (existing) {
    console.log(`Index "${INDEX_DISPLAY_NAME}" already exists: ${existing.name}`);
    return existing;
  }

  console.log(`Creating index "${INDEX_DISPLAY_NAME}" (dimensions=${EMBED_DIMENSIONS})...`);
  const h = await headers();
  const { data: op } = await axios.post(
    `${baseUrl()}/projects/${PROJECT_ID}/locations/${REGION}/indexes`,
    {
      displayName: INDEX_DISPLAY_NAME,
      metadata: {
        contentsDeltaUri,
        config: {
          dimensions: EMBED_DIMENSIONS,
          approximateNeighborsCount: 150,
          distanceMeasureType: 'DOT_PRODUCT_DISTANCE',
          shardSize: 'SHARD_SIZE_SMALL',
          algorithmConfig: {
            treeAhConfig: { leafNodeEmbeddingCount: 1000, leafNodesToSearchPercent: 10 },
          },
        },
      },
      indexUpdateMethod: 'STREAM_UPDATE',
    },
    { headers: h }
  );
  process.stdout.write('Waiting for index creation ');
  const index = await pollOperation(op.name);
  console.log('\nIndex ready:', index.name);
  return index;
}

async function createIndexEndpoint() {
  const existing = await findExistingByDisplayName('indexEndpoints', ENDPOINT_DISPLAY_NAME);
  if (existing) {
    console.log(`Index endpoint "${ENDPOINT_DISPLAY_NAME}" already exists: ${existing.name}`);
    return existing;
  }

  console.log(`Creating index endpoint "${ENDPOINT_DISPLAY_NAME}"...`);
  const h = await headers();
  const { data: op } = await axios.post(
    `${baseUrl()}/projects/${PROJECT_ID}/locations/${REGION}/indexEndpoints`,
    { displayName: ENDPOINT_DISPLAY_NAME, publicEndpointEnabled: true },
    { headers: h }
  );
  process.stdout.write('Waiting for index endpoint creation ');
  const endpoint = await pollOperation(op.name);
  console.log('\nIndex endpoint ready:', endpoint.name);
  return endpoint;
}

async function deployIndex(index, endpoint) {
  const alreadyDeployed = (endpoint.deployedIndexes || []).find((d) => d.id === DEPLOYED_INDEX_ID);
  if (alreadyDeployed) {
    console.log(`Deployed index "${DEPLOYED_INDEX_ID}" already exists on this endpoint`);
    return endpoint;
  }

  console.log(
    `Deploying index to endpoint as "${DEPLOYED_INDEX_ID}" (machine=${MACHINE_TYPE})... this can take 20-30+ minutes.`
  );
  const h = await headers();
  const { data: op } = await axios.post(`${baseUrl()}/${endpoint.name}:deployIndex`, {
    deployedIndex: {
      id: DEPLOYED_INDEX_ID,
      index: index.name,
      displayName: DEPLOYED_INDEX_ID,
      dedicatedResources: {
        machineSpec: { machineType: MACHINE_TYPE },
        minReplicaCount: 1,
        maxReplicaCount: 1,
      },
    },
  }, { headers: h });
  process.stdout.write('Waiting for index deployment ');
  const result = await pollOperation(op.name);
  console.log('\nIndex deployed.');
  return result.indexEndpoint || endpoint;
}

async function describeIndexEndpoint(name) {
  const h = await headers();
  const { data } = await axios.get(`${baseUrl()}/${name}`, { headers: h });
  return data;
}

async function main() {
  if (!PROJECT_ID) {
    console.error('GCP_PROJECT_ID is required');
    process.exit(1);
  }

  const contentsDeltaUri = await ensureInitBucket();
  const index = await createIndex(contentsDeltaUri);
  let endpoint = await createIndexEndpoint();
  await deployIndex(index, endpoint);
  endpoint = await describeIndexEndpoint(endpoint.name);

  const indexId = index.name.split('/').pop();
  const endpointId = endpoint.name.split('/').pop();

  console.log('\nDone. Add to .env:');
  console.log(`GCP_PROJECT_ID=${PROJECT_ID}`);
  console.log(`VERTEX_REGION=${REGION}`);
  console.log(`VECTOR_BACKEND=vertex`);
  console.log(`VERTEX_INDEX_ID=${indexId}`);
  console.log(`VERTEX_INDEX_ENDPOINT_ID=${endpointId}`);
  console.log(`VERTEX_DEPLOYED_INDEX_ID=${DEPLOYED_INDEX_ID}`);
  console.log(`VERTEX_INDEX_ENDPOINT_DOMAIN=${endpoint.publicEndpointDomainName}`);
  console.log(`VERTEX_EMBED_DIMENSIONS=${EMBED_DIMENSIONS}`);
  console.log('\nAlso run once: gcloud firestore databases create --location=' + REGION + ' --type=firestore-native');
}

main().catch((error) => {
  console.error('\n' + (error.response?.data ? JSON.stringify(error.response.data) : error.message));
  process.exit(1);
});
