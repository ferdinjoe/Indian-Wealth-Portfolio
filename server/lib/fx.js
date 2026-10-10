const https = require('https');

// Currencies the tracker understands. INR is the reporting base, so its rate
// is fixed at 1. Others are refreshed from the ECB reference feed.
const SUPPORTED = ['INR', 'USD', 'SGD', 'THB', 'EUR', 'GBP', 'AED', 'AUD', 'CAD', 'CHF', 'JPY', 'MYR', 'HKD'];

// ECB reference rates on 2026-10-02, used only when the feed has never been
// reached and no manual pin exists. Stale by design — the UI labels the source.
const FALLBACK_RATES = {
  INR: 1,
  USD: 96.34,
  SGD: 75.24,
  THB: 2.8671,
  EUR: 108.11,
  GBP: 127.23,
  AED: 26.22,
  AUD: 63.48,
  CAD: 69.35,
  CHF: 112.0,
  JPY: 0.589,
  MYR: 21.65,
  HKD: 12.35,
};

const FEED_URL = `https://api.frankfurter.dev/v1/latest?base=INR&symbols=${SUPPORTED.filter((c) => c !== 'INR').join(',')}`;

function get(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 301 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), timeoutMs));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`FX feed returned HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 1e6) { req.destroy(); reject(new Error('FX feed response too large')); } });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('FX feed returned malformed JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('FX feed timed out')); });
    req.on('error', reject);
  });
}

// Pulls INR->X and inverts it into X->INR, which is the direction the ledger
// actually needs for reporting.
async function fetchLiveRates() {
  const data = await get(FEED_URL);
  const out = {};
  for (const [code, inv] of Object.entries(data.rates || {})) {
    const n = Number(inv);
    if (Number.isFinite(n) && n > 0) out[code.toUpperCase()] = { rate: round6(1 / n), asOf: data.date, source: 'live' };
  }
  return out;
}

// Resolution order: user pin, then the last successful live pull, then the
// bundled default. `source` tells the UI which one won.
function resolve(fxTable, code) {
  const upper = String(code || 'INR').toUpperCase();
  if (upper === 'INR') return { rate: 1, asOf: null, source: 'base' };
  const entry = fxTable?.[upper] || {};
  if (Number.isFinite(entry.manualRate) && entry.manualRate > 0) {
    return { rate: entry.manualRate, asOf: entry.pinnedOn || null, source: 'manual' };
  }
  if (Number.isFinite(entry.liveRate) && entry.liveRate > 0) {
    return { rate: entry.liveRate, asOf: entry.asOf || null, source: 'cached' };
  }
  const fallback = FALLBACK_RATES[upper];
  if (Number.isFinite(fallback)) return { rate: fallback, asOf: 'bundled', source: 'fallback' };
  return { rate: null, asOf: null, source: 'unknown' };
}

// Mutates the fx table in place with a fresh live pull, leaving manual pins
// untouched so a refresh never clobbers a deliberate override.
function applyLiveRates(fxTable, live) {
  for (const [code, { rate, asOf }] of Object.entries(live)) {
    const entry = fxTable[code] || {};
    entry.liveRate = rate;
    entry.asOf = asOf;
    entry.fetchedAt = new Date().toISOString();
    fxTable[code] = entry;
  }
  fxTable.lastRefreshedAt = new Date().toISOString();
  return fxTable;
}

function rateMap(fxTable) {
  const out = {};
  for (const code of SUPPORTED) out[code] = resolve(fxTable, code);
  return out;
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

module.exports = { SUPPORTED, FALLBACK_RATES, fetchLiveRates, resolve, applyLiveRates, rateMap };
