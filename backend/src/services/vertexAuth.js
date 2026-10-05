const { GoogleAuth } = require('google-auth-library');
const logger = require('../utils/logger');
const networkInfo = require('../utils/networkInfo');

let authClient = null;
let loggedHostOnce = false;

function getProjectId() {
  return process.env.GCP_PROJECT_ID || null;
}

function getAuth() {
  if (!authClient) {
    authClient = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      projectId: getProjectId(),
    });
  }
  return authClient;
}

/** Logs this process's private/public IP once — correlates "which box" with Vertex call logs below. */
async function logHostOnce() {
  if (loggedHostOnce) return;
  loggedHostOnce = true;
  try {
    const hostTag = await networkInfo.getHostTag();
    logger.info(`[vertex:auth] host identity resolved ${hostTag} project=${getProjectId() || 'unset'}`);
  } catch (error) {
    logger.warn(`[vertex:auth] host identity resolution failed: ${error.message}`);
  }
}

async function getAccessToken() {
  logHostOnce();
  const startedAt = Date.now();
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || '(ADC / metadata server)';
  try {
    const client = await getAuth().getClient();
    const { token } = await client.getAccessToken();
    const elapsedMs = Date.now() - startedAt;
    if (!token) {
      logger.error(
        `[vertex:auth] getAccessToken FAILED (empty token) keyFile=${keyFile} elapsedMs=${elapsedMs}`
      );
      throw new Error('Failed to obtain a GCP access token (check ADC/service account credentials)');
    }
    logger.info(`[vertex:auth] getAccessToken OK keyFile=${keyFile} elapsedMs=${elapsedMs}`);
    return token;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logger.error(
      `[vertex:auth] getAccessToken ERROR keyFile=${keyFile} elapsedMs=${elapsedMs} message="${error.message}"`
    );
    throw error;
  }
}

async function authHeaders() {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

module.exports = {
  getProjectId,
  getAuth,
  getAccessToken,
  authHeaders,
};
