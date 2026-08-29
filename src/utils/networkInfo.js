const os = require('os');
const http = require('http');
const https = require('https');

const PUBLIC_IP_TTL_MS = Number(process.env.PUBLIC_IP_CACHE_TTL_MS) || 15 * 60 * 1000;
const PUBLIC_IP_TIMEOUT_MS = 2500;
// Fallback chain — first responder wins. All plain HTTP/HTTPS, no deps.
const PUBLIC_IP_ENDPOINTS = [
  { host: 'api.ipify.org', path: '/', protocol: https },
  { host: 'checkip.amazonaws.com', path: '/', protocol: http },
  { host: 'ifconfig.me', path: '/ip', protocol: https },
];

let privateIpCache = null;
let publicIpCache = { ip: null, at: 0 };
let inFlight = null;

/** First non-internal IPv4 across all interfaces, e.g. the LAN/VPC-private address. */
function getPrivateIp() {
  if (privateIpCache) return privateIpCache;
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        privateIpCache = iface.address;
        return privateIpCache;
      }
    }
  }
  privateIpCache = '127.0.0.1';
  return privateIpCache;
}

function fetchFrom(endpoint) {
  return new Promise((resolve, reject) => {
    const req = endpoint.protocol.get(
      { host: endpoint.host, path: endpoint.path, timeout: PUBLIC_IP_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const ip = body.trim();
          if (res.statusCode === 200 && /^[\d.:a-fA-F]+$/.test(ip)) resolve(ip);
          else reject(new Error(`bad response from ${endpoint.host}: ${res.statusCode}`));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timeout contacting ${endpoint.host}`)));
    req.on('error', reject);
  });
}

/** Outbound-egress public IP, cached for PUBLIC_IP_TTL_MS. Never throws — resolves 'unknown' on failure. */
async function getPublicIp() {
  const now = Date.now();
  if (publicIpCache.ip && now - publicIpCache.at < PUBLIC_IP_TTL_MS) return publicIpCache.ip;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    for (const endpoint of PUBLIC_IP_ENDPOINTS) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const ip = await fetchFrom(endpoint);
        publicIpCache = { ip, at: Date.now() };
        return ip;
      } catch (_err) {
        // try next endpoint
      }
    }
    publicIpCache = { ip: 'unknown', at: Date.now() };
    return 'unknown';
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** "private=10.0.0.5 public=34.12.9.1" — resolved once per process/refresh, safe to call often. */
async function getHostTag() {
  const [privateIp, publicIp] = [getPrivateIp(), await getPublicIp()];
  return `private=${privateIp} public=${publicIp}`;
}

module.exports = {
  getPrivateIp,
  getPublicIp,
  getHostTag,
};
