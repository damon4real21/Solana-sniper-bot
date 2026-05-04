// Resilient fetch with DNS retry for Render free tier
const https = require('https');
const http = require('http');

// Keep-alive agent to reuse connections and avoid DNS re-lookup
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  timeout: 15000,
});

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000 });

// Alternative Jupiter endpoints
const JUPITER_ENDPOINTS = [
  'https://quote-api.jup.ag/v6',
  'https://public.jupiterapi.com',
];

let currentEndpointIdx = 0;
function getJupiterBase() { return JUPITER_ENDPOINTS[currentEndpointIdx]; }
function rotateJupiterEndpoint() {
  currentEndpointIdx = (currentEndpointIdx + 1) % JUPITER_ENDPOINTS.length;
}

async function resilientFetch(url, options = {}, retries = 3) {
  const isHttps = url.startsWith('https');
  const agent = isHttps ? httpsAgent : httpAgent;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { default: fetch } = await import('node-fetch');
      const res = await fetch(url, {
        ...options,
        agent,
        timeout: options.timeout || 10000,
      });
      return res;
    } catch (err) {
      const isNetworkErr = err.message.includes('ENOTFOUND') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('network');

      if (isNetworkErr && url.includes('jup.ag')) {
        // Rotate Jupiter endpoint and retry
        rotateJupiterEndpoint();
        url = url.replace(JUPITER_ENDPOINTS[(currentEndpointIdx - 1 + JUPITER_ENDPOINTS.length) % JUPITER_ENDPOINTS.length], getJupiterBase());
      }

      if (attempt < retries) {
        const delay = attempt * 2000; // 2s, 4s, 6s
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

module.exports = { resilientFetch, getJupiterBase, httpsAgent };
