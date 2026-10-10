const http = require('http');
const https = require('https');

const MAX_BODY = 5e5;

// Shared GET for the price feeds, so a stalled upstream fails the same way
// whichever one it is: same timeout, one redirect hop, capped response.
// expect 'json' parses the body, 'text' hands it back as-is. A caller reading a
// whole directory page passes its own ceiling, since that is page size, not a
// runaway response.
function get(url, { label = 'price feed', timeoutMs = 8000, expect = 'json', maxBytes = MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http://') ? http : https;
    const req = lib.get(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: expect === 'json' ? 'application/json' : 'text/html' },
    }, (res) => {
      if (res.statusCode >= 301 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), { label, timeoutMs, expect, maxBytes }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${label} returned HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > maxBytes) {
          req.destroy(new Error(`${label} response too large`));
        }
      });
      res.on('end', () => {
        if (expect === 'text') return resolve(body);
        try { resolve(JSON.parse(body)); } catch { reject(new Error(`${label} returned malformed JSON`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`${label} timed out`)); });
    req.on('error', reject);
  });
}

module.exports = { get };
