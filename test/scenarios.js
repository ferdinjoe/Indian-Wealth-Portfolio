// Functional test suite: 212 critical scenarios run against a synthetic ledger
// in test/.sandbox/. The live data/wealth-data.json is only ever opened
// read-only, hashed before and after, and scenario I9 fails if one byte moved.
//
//   node test/scenarios.js        (or: npm test)
//
// Exit code is non-zero if any scenario fails. Results are also written to
// test/results.md.

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SANDBOX = path.join(__dirname, '.sandbox');
const CORRUPT = path.join(__dirname, '.sandbox-corrupt');
const PLANNING_SHIM = path.join(__dirname, '.planning.mjs');
const FORMAT_SHIM = path.join(__dirname, '.format.mjs');
const OFFLINE_SHIM = path.join(__dirname, '.offline.mjs');
const LIVE_FILE = path.join(ROOT, 'data', 'wealth-data.json');
const PORT = Number(process.env.TEST_PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}`;
// The refresh route is pointed here through WEALTH_METAL_RATES_URL, so the
// bullion scenarios exercise the real fetch-and-parse path without the
// suite depending on a third-party site or the network.
const METAL_PORT = PORT + 1;
// The emailing scenarios need a peer that answers in SMTP, so the suite runs a
// scripted one locally rather than handing a report to a real mail provider.
const SMTP_PORT = PORT + 2;

// A capture of livechennai.com/gold_silverrate.asp trimmed to its three tables,
// with the real class names and column order kept. The summary table carries
// wrong figures on purpose: reading it instead of the rate table must fail.
const METAL_PAGE = `<!DOCTYPE html><html><body>
<table class="table table-bordered today-gold-rate"><tbody>
  <tr><td class="date-col">05/Oct/2026</td>
      <td><i class="fa fa-inr"></i> 99,999 (<span class="goldrate_nogainloss">0 <i class="fa fa-arrows-h"></i></span>)</td>
      <td><i class="fa fa-inr"></i> 888.00 (<span class="goldrate_nogainloss">0.00 <i class="fa fa-arrows-h"></i></span>)</td></tr>
</tbody></table>
<table class="table table-bordered table-striped gold-rates">
  <thead><tr><th>Date</th><th colspan="2">Pure Gold (24 k)</th><th colspan="2">Standard Gold (22 K)</th></tr>
  <tr><th>1 Gm</th><th>8 Gm</th><th>1 Gm</th><th>8 Gm</th></tr></thead>
  <tbody>
    <tr><td class="date-col">05/Oct/2026</td><td class=""><i class="fa fa-inr"></i> 14,918</td><td><i class="fa fa-inr"></i> 119,344</td><td><i class="fa fa-inr"></i> 13,675</td><td><i class="fa fa-inr"></i> 109,400</td></tr>
    <tr><td class="date-col">04/Oct/2026</td><td class=""><i class="fa fa-inr"></i> 14,918</td><td><i class="fa fa-inr"></i> 119,344</td><td><i class="fa fa-inr"></i> 13,675</td><td><i class="fa fa-inr"></i> 109,400</td></tr>
  </tbody>
</table>
<table class="table table-bordered table-striped silver-rates">
  <thead><tr><th>Date</th><th>Silver 1 Gm</th><th>Ready Silver (1 Kg)</th></tr></thead>
  <tbody><tr><td class="date-col">05/Oct/2026</td><td><i class="fa fa-inr"></i> 245.00</td><td><i class="fa fa-inr"></i> 245,000.00</td></tr></tbody>
</table>
</body></html>`;

// A capture of indiabonds.com/bond-directory/ trimmed to three issues, with the
// real card classes, block order and the ₹-prefixed price kept. The corporate
// NCD is listed twice on purpose, at a ₹10,000 and a ₹1,00,000 lot: the smaller
// denomination is the one a holder can count in, so it must win the dedupe.
const BOND_PAGE = `<!DOCTYPE html><html><body><div class="searched-bond-list-container">
<div class="container bond-card-wrapper company-block">
  <div class="row"><div class="col-xs-8"><label class="cursor-pointer compareBondDetail hide">
    <input type="checkbox" class="compare-checkbox-bond-details" id="INE0DEMO0001"> Add to Compare
    <span style="display: none;">
      <span class="bondISIN">INE0DEMO0001</span>
      <span class="bondIssuer">MANBA FINANCE LIMITED</span>
      <span class="bondImg">https://assets.indiabonds.com/manba.png</span>
      <span class="bondCoupon">10.6500 %</span>
      <span class="bondVendorId">7f0f1e34-0e0a-4b7d-9d0a-1c2a4f2b7f11</span>
      <span class="bondMaturity">Nov 2028</span>
      <span class="bondYield">11.1694%</span>
    </span>
  </label></div></div>
  <div class="row bond-card-inner-content">
    <div class="col-md-6 col-sm-6 col-xs-6 bond-value-block"><p class="info-title p-no-margin">Coupon</p><p class="info-value">10.6500%</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 no-pad-left bond-value-block"><p class="info-title p-no-margin">Maturity</p><p class="info-value">Nov 2028</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 bond-value-block"><p class="info-title p-no-margin">Rating</p><p class="info-value rating-div-bond-card"><span class="care-name">ICRA &nbsp;</span>AA-</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 no-pad-left bond-value-block"><p class="info-title p-no-margin">Type of Bond</p><p class="info-value rating-div-bond-card">Secured - Regular Bond/Debenture</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 bond-value-block"><p class="info-title p-no-margin">Yield</p><p class="info-value tan-colored">11.1694%</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 no-pad-left bond-value-block"><p class="info-title p-no-margin">Price</p><p class="info-value"><i class="fa fa-inr"></i> 10,037.93</p></div>
  </div>
  <div class="last-traded-date"></div>
</div>
<div class="container bond-card-wrapper company-block">
  <div class="row"><div class="col-xs-8"><label class="cursor-pointer compareBondDetail hide">
    <span style="display: none;">
      <span class="bondISIN">INE0DEMO0001</span>
      <span class="bondIssuer">MANBA FINANCE LIMITED</span>
      <span class="bondCoupon">10.6500 %</span>
      <span class="bondVendorId">b2a3c4d5-0000-1111-2222-333344445555</span>
      <span class="bondMaturity">Nov 2028</span>
      <span class="bondYield">11.1700%</span>
    </span>
  </label></div></div>
  <div class="row bond-card-inner-content">
    <div class="col-md-6 col-sm-6 col-xs-6 bond-value-block"><p class="info-title p-no-margin">Coupon</p><p class="info-value">10.6500%</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 no-pad-left bond-value-block"><p class="info-title p-no-margin">Maturity</p><p class="info-value">Nov 2028</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 bond-value-block"><p class="info-title p-no-margin">Rating</p><p class="info-value rating-div-bond-card">AA-</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 no-pad-left bond-value-block"><p class="info-title p-no-margin">Type of Bond</p><p class="info-value">Secured</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 bond-value-block"><p class="info-title p-no-margin">Yield</p><p class="info-value tan-colored">11.1700%</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 no-pad-left bond-value-block"><p class="info-title p-no-margin">Price</p><p class="info-value"><i class="fa fa-inr"></i> 1,00,379.30</p></div>
  </div>
</div>
<div class="container bond-card-wrapper company-block">
  <div class="row"><div class="col-xs-8"><label class="cursor-pointer compareBondDetail hide">
    <span style="display: none;">
      <span class="bondISIN">IN0202310483</span>
      <span class="bondIssuer">GOVERNMENT OF INDIA 2028</span>
      <span class="bondCoupon">7.2600 %</span>
      <span class="bondVendorId">0d1e2f3a-4b5c-6d7e-8f90-a1b2c3d4e5f6</span>
      <span class="bondMaturity">Apr 2033</span>
      <span class="bondYield">7.1150%</span>
    </span>
  </label></div></div>
  <div class="row bond-card-inner-content">
    <div class="col-md-6 col-sm-6 col-xs-6 bond-value-block"><p class="info-title p-no-margin">Coupon</p><p class="info-value">7.2600%</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 no-pad-left bond-value-block"><p class="info-title p-no-margin">Maturity</p><p class="info-value">Apr 2033</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 bond-value-block"><p class="info-title p-no-margin">Rating</p><p class="info-value">Sovereign</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 no-pad-left bond-value-block"><p class="info-title p-no-margin">Type of Bond</p><p class="info-value">Unsecured - Dated Securities</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 bond-value-block"><p class="info-title p-no-margin">Yield</p><p class="info-value tan-colored">7.1150%</p></div>
    <div class="col-md-6 col-sm-6 col-xs-6 no-pad-left bond-value-block"><p class="info-title p-no-margin">Price</p><p class="info-value"><i class="fa fa-inr"></i> 1,00,150.41</p></div>
  </div>
</div>
</div><footer class="yc-search-bonds-screen">IndiaBonds</footer></body></html>`;

// Must be set before anything requires store.js.
process.env.WEALTH_DATA_DIR = SANDBOX;

const returns = require('../server/lib/returns');
const valuation = require('../server/lib/valuation');
const income = require('../server/lib/income');
const store = require('../server/lib/store');
const fx = require('../server/lib/fx');
const prices = require('../server/lib/prices');
const metals = require('../server/lib/metals');
const bonds = require('../server/lib/bonds');
const analysis = require('../server/lib/analysis');
const healthEngine = require('../server/lib/health');
const pdfLib = require('../server/lib/pdf');
const reportLib = require('../server/lib/report');
const mailer = require('../server/lib/mailer');
const access = require('../server/lib/access');
const tlsLib = require('../server/lib/tls');

const TODAY = new Date('2026-10-05T12:00:00Z');
// Deliberately different from the bundled fallback rates, so a test that mixes
// up "cached" and "fallback" cannot pass by accident.
const R = { USD: 88.5, SGD: 71.25, THB: 2.6 };

// Ledger maths the UI depends on, restated here so the assertions are explicit.
const GROSS_ASSETS = 500000 + 1000000 + 25000 + 1000 * R.USD + 5000000 + 100000 * R.THB + 10000 + 200000 + 300000;
const LIABILITIES = 3000000;
const NET_WORTH = GROSS_ASSETS - LIABILITIES;
const LIQUID = 500000 + 1000000 + 25000 + 1000 * R.USD + 10000;
const COSTED = 10000 + 500 * R.USD + 4000000 + 20000 + 250000;

function holding(o) {
  return {
    id: o.id, name: o.name, category: o.category, country: o.country, currency: o.currency,
    instrument: o.instrument || '', institution: o.institution || '', units: o.units ?? null,
    pricePerUnit: o.pricePerUnit ?? null, valueNative: o.valueNative ?? null,
    interestRatePct: o.interestRatePct ?? null, acquiredOn: o.acquiredOn ?? null,
    maturityDate: o.maturityDate ?? null, costNative: o.costNative ?? null,
    liquidityOverride: o.liquidityOverride ?? null, notes: '',
  };
}

function fixtureDoc(over = {}) {
  const stamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    fxDate: '2026-10-02',
    profile: {
      salutation: 'Ms', fullName: 'Test Person', dateOfBirth: '1996-06-15', nationality: 'Indian',
      residenceCountry: 'IN', email: 't@example.com', phone: '', maritalStatus: 'Single',
      dependants: 1, plannedRetirementAge: 60, lifeExpectancy: 90,
      monthlyExpensesNowINR: 100000, monthlyExpensesInRetirementINR: 120000,
      monthlyIncomeINR: 400000, monthlyInvestableSurplusINR: 150000, monthlyEmiINR: 50000,
      riskProfile: 'moderate', notes: '',
    },
    settings: {
      baseCurrency: 'INR',
      fx: {
        USD: { liveRate: R.USD, asOf: '2026-10-02', fetchedAt: stamp },
        SGD: { liveRate: R.SGD, asOf: '2026-10-02', fetchedAt: stamp },
        THB: { liveRate: R.THB, asOf: '2026-10-02', fetchedAt: stamp },
      },
      targetAllocation: {},
      assumptions: { preRetirementReturnPct: 11, postRetirementReturnPct: 7, inflationPct: 6, salaryGrowthPct: 6, corpusBufferPct: 10 },
    },
    holdings: [
      holding({ id: 'h_bank', name: 'Sample Savings', category: 'bank_account', country: 'IN', currency: 'INR', valueNative: 500000 }),
      holding({ id: 'h_fd', name: '1Y FD', category: 'fixed_deposit', country: 'IN', currency: 'INR', valueNative: 1000000, interestRatePct: 7, maturityDate: '2027-06-30' }),
      holding({ id: 'h_eq_in', name: 'Reliance', category: 'equity', country: 'IN', currency: 'INR', units: 100, pricePerUnit: 250, costNative: 10000, acquiredOn: '2021-01-01' }),
      holding({ id: 'h_eq_us', name: 'Apple', category: 'equity', country: 'US', currency: 'USD', units: 10, pricePerUnit: 100, costNative: 500, acquiredOn: '2025-09-01' }),
      holding({ id: 'h_flat', name: 'Demo Nagar Flat', category: 'real_estate', country: 'IN', currency: 'INR', valueNative: 5000000, costNative: 4000000, acquiredOn: '2019-01-01' }),
      holding({ id: 'h_loan', name: 'Home Loan', category: 'liability', country: 'IN', currency: 'INR', valueNative: 3000000, maturityDate: '2040-01-01' }),
      holding({ id: 'h_policy', name: 'Thai Endowment', category: 'policy', country: 'TH', currency: 'THB', valueNative: 100000, interestRatePct: 4 }),
      holding({ id: 'h_weird', name: 'Unpriced Token', category: 'other_asset', country: 'ZZ', currency: 'XTS', valueNative: 999999 }),
      holding({ id: 'h_recent', name: 'Freshest Buy', category: 'equity', country: 'IN', currency: 'INR', valueNative: 10000, costNative: 20000, acquiredOn: '2026-08-01' }),
      holding({ id: 'h_fd2', name: 'Locked FD', category: 'fixed_deposit', country: 'IN', currency: 'INR', valueNative: 200000, liquidityOverride: 'illiquid' }),
      holding({ id: 'h_gold', name: 'SGB', category: 'gold_commodity', country: 'IN', currency: 'INR', valueNative: 300000, costNative: 250000, acquiredOn: '2025-06-01' }),
    ],
    goals: [],
    snapshots: [],
    ...over,
  };
}

// ---------------------------------------------------------------- harness ---

const results = [];
let currentGroup = '';

function group(name) { currentGroup = name; }

function test(name, fn) {
  results.push({ group: currentGroup, name, fn, ok: false, detail: '' });
}

class Fail extends Error {}

function check(cond, message) {
  if (!cond) throw new Fail(message);
}

function near(a, b, tol, label) {
  check(Number.isFinite(a) && Math.abs(a - b) <= tol, `${label}: expected ${b} ±${tol}, got ${a}`);
  return `${a}`;
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON responses are asserted by callers */ }
  return { status: res.status, body: json, text };
}

async function reset() {
  const r = await api('PUT', '/api/import', fixtureDoc());
  check(r.status === 200, `fixture import failed with ${r.status}`);
  return r.body;
}

async function state() {
  const r = await api('GET', '/api/state');
  check(r.status === 200, `state fetch failed with ${r.status}`);
  return r.body;
}

function byId(rows, id) {
  return rows.find((r) => r.id === id);
}

// planning.js ships as an ES module for the browser; Node would parse a .js
// file in this CommonJS package as CJS, so it is copied to a .mjs shim.
let planning = null;
async function loadPlanning() {
  if (!planning) {
    fs.copyFileSync(path.join(ROOT, 'public', 'js', 'planning.js'), PLANNING_SHIM);
    planning = await import(pathToFileURL(PLANNING_SHIM).href);
  }
  return planning;
}

// format.js is a browser module as well: the grouping rules that decide whether
// a dollar figure reads "$12,34,567" are worth asserting without a screen.
let format = null;
async function loadFormat() {
  if (!format) {
    fs.copyFileSync(path.join(ROOT, 'public', 'js', 'format.js'), FORMAT_SHIM);
    format = await import(pathToFileURL(FORMAT_SHIM).href);
  }
  return format;
}

// offline.js is the phone's own stored reading, and it only ever touches
// window.localStorage, so a fake one is enough to drive the real module.
let offline = null;
async function loadOffline() {
  if (!offline) {
    fs.copyFileSync(path.join(ROOT, 'public', 'js', 'offline.js'), OFFLINE_SHIM);
    offline = await import(pathToFileURL(OFFLINE_SHIM).href);
  }
  return offline;
}

function fakeStorage() {
  const map = new Map();
  global.window = {
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
    },
  };
  return global.window.localStorage;
}

// --------------------------------------------------------------- scenarios ---

function defineScenarios() {
  // ---- A. Storage safety ---------------------------------------------------
  group('A. Storage safety');

  test('A1 Atomic save leaves no .tmp file behind', async () => {
    await reset();
    await api('POST', '/api/holdings', { name: 'Temp', category: 'bank_account', currency: 'INR', country: 'IN', valueNative: 1 });
    const leftovers = fs.readdirSync(SANDBOX).filter((f) => f.endsWith('.tmp'));
    check(leftovers.length === 0, `temp files left behind: ${leftovers.join(', ')}`);
    return 'no partial writes';
  });

  test('A2 Backup file holds the state from before the last save', async () => {
    await reset();
    const before = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'wealth-data.json'), 'utf8'));
    await api('POST', '/api/holdings', { name: 'Extra FD', category: 'fixed_deposit', currency: 'INR', country: 'IN', valueNative: 10 });
    const backup = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'wealth-data.backup.json'), 'utf8'));
    check(backup.holdings.length === before.holdings.length, `backup has ${backup.holdings.length} rows, expected ${before.holdings.length}`);
    check(!backup.holdings.some((h) => h.name === 'Extra FD'), 'backup already contains the new row');
    return `${backup.holdings.length} rows preserved`;
  });

  test('A3 Unparseable ledger refuses to start and is not overwritten', async () => {
    fs.rmSync(CORRUPT, { recursive: true, force: true });
    fs.mkdirSync(CORRUPT, { recursive: true });
    const bad = '{ this is not json ';
    fs.writeFileSync(path.join(CORRUPT, 'wealth-data.json'), bad);
    const out = spawnSync(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, WEALTH_DATA_DIR: CORRUPT, PORT: String(PORT + 1) },
      encoding: 'utf8', timeout: 20000,
    });
    const after = fs.readFileSync(path.join(CORRUPT, 'wealth-data.json'), 'utf8');
    check(out.status === 1, `exit code ${out.status}, expected 1 (${(out.stderr || out.stdout).slice(0, 120)})`);
    check(after === bad, 'the corrupt file was modified instead of preserved');
    check(/Refusing to overwrite/.test(out.stderr + out.stdout), 'no refusal message on stderr');
    fs.rmSync(CORRUPT, { recursive: true, force: true });
    return 'exited 1, file untouched';
  });

  test('A4 A partial document is repaired to a usable schema on load', async () => {
    const merged = store.merge(store.blankDb(), { holdings: [{ name: 'Bare', valueNative: 5 }], goals: [{ name: 'Linkless', targetAmountINR: 1000 }] });
    check(merged.profile.plannedRetirementAge === 60, 'profile defaults missing');
    check(merged.settings.assumptions.inflationPct === 6, 'assumption defaults missing');
    check(merged.settings.targetAllocation && typeof merged.settings.targetAllocation === 'object', 'targetAllocation missing');
    check(Array.isArray(merged.snapshots), 'goals/snapshots missing');
    check(merged.holdings[0].currency === 'INR', `currency not defaulted: ${merged.holdings[0].currency}`);
    check(merged.holdings[0].id, 'an id-less holding was not assigned one - it could never be edited');
    check(merged.goals[0].id, 'an id-less goal was not assigned one - it could never be deleted');
    return 'all sections filled, ids backfilled';
  });

  test('A5 Holding ids stay unique across rapid creates', async () => {
    await reset();
    for (let i = 0; i < 12; i += 1) {
      const r = await api('POST', '/api/holdings', { name: `Dup ${i}`, category: 'bank_account', currency: 'INR', country: 'IN', valueNative: 100 });
      check(r.status === 201, `create ${i} returned ${r.status}`);
    }
    const s = await state();
    const ids = s.holdings.map((h) => h.id);
    check(new Set(ids).size === ids.length, `${ids.length - new Set(ids).size} duplicate ids`);
    return `${ids.length} distinct ids`;
  });

  test('A6 Import rejects a document with no holdings array', async () => {
    const good = await api('PUT', '/api/import', { holdings: [] });
    const bad = await api('PUT', '/api/import', { profile: { fullName: 'x' } });
    check(good.status === 200, `valid import returned ${good.status}`);
    check(bad.status === 400, `invalid import returned ${bad.status}, expected 400`);
    check(/holdings array/i.test(bad.body.error || ''), `unclear message: ${bad.body.error}`);
    await reset();
    return '400 with a reason';
  });

  test('A7 Export then import round-trips the ledger exactly', async () => {
    await reset();
    const exported = (await api('GET', '/api/export')).body;
    check(exported.holdings.length === 11, `export carried ${exported.holdings.length} rows`);
    await api('PUT', '/api/holdings/h_fd', { valueNative: 42 });
    const restored = await api('PUT', '/api/import', exported);
    check(restored.status === 200, `restore returned ${restored.status}`);
    near(byId(restored.body.holdings, 'h_fd').valueINR, 1000000, 0.01, 'value after restore');
    check(restored.body.profile.fullName === 'Test Person', 'profile lost in the round trip');
    const sumBefore = (await state()).summary.netWorthINR;
    near(sumBefore, NET_WORTH, 1, 'net worth after restore');
    return `${exported.holdings.length} rows survived the loop`;
  });

  // ---- B. Currency conversion ---------------------------------------------
  group('B. Currency conversion');

  test('B1 INR converts at exactly 1 and is labelled as the base', async () => {
    const s = await reset();
    const h = byId(s.holdings, 'h_bank');
    check(h.rate === 1, `rate ${h.rate}`);
    check(h.rateSource === 'base', `source ${h.rateSource}`);
    check(h.valueINR === 500000, `valueINR ${h.valueINR}`);
    return 'rate 1, source base';
  });

  test('B2 A manual pin outranks the cached live rate', async () => {
    await reset();
    const pinned = await api('PUT', '/api/fx/USD', { manualRate: 111.5 });
    check(pinned.status === 200, `pin returned ${pinned.status}`);
    const h = byId(pinned.body.holdings, 'h_eq_us');
    check(h.rate === 111.5 && h.rateSource === 'manual', `rate ${h.rate} / ${h.rateSource}`);
    near(h.valueINR, 1000 * 111.5, 0.01, 'pinned value');
    return 'manual wins';
  });

  test('B3 Unpinning falls back to the cached rate rather than zero', async () => {
    const r = await api('PUT', '/api/fx/USD', { manualRate: null });
    check(r.status === 200, `unpin returned ${r.status}`);
    const h = byId(r.body.holdings, 'h_eq_us');
    check(h.rate === R.USD && h.rateSource === 'cached', `rate ${h.rate} / ${h.rateSource}`);
    near(h.valueINR, 1000 * R.USD, 0.01, 'restored value');
    return `back to ${h.rate} (${h.rateSource})`;
  });

  test('B4 An unknown currency is excluded from net worth and flagged', async () => {
    const s = await reset();
    const weird = byId(s.holdings, 'h_weird');
    check(weird.valueINR === null, `expected null conversion, got ${weird.valueINR}`);
    check(weird.rateSource === 'unknown', `source ${weird.rateSource}`);
    check(s.meta.unconverted.some((u) => u.id === 'h_weird'), 'not listed in meta.unconverted');
    check(s.summary.byCategory.other_asset.valueINR === 0, 'excluded asset still counted');
    near(s.summary.totalAssetsINR, GROSS_ASSETS, 0.01, 'gross assets ignore the unpriceable holding');
    return 'excluded + banner data present';
  });

  test('B5 THB holding converts at the cached rate', async () => {
    const s = await reset();
    const h = byId(s.holdings, 'h_policy');
    near(h.valueINR, 100000 * R.THB, 0.01, 'THB -> INR');
    check(h.rateSource === 'cached', `source ${h.rateSource}`);
    return `${h.valueINR} INR`;
  });

  test('B6 A foreign-currency liability converts and subtracts', async () => {
    const base = (await reset()).summary.netWorthINR;
    const created = await api('POST', '/api/holdings', { name: 'SG Loan', category: 'liability', country: 'SG', currency: 'SGD', valueNative: 10000 });
    check(created.status === 201, `create returned ${created.status}`);
    const row = created.body.holdings.find((x) => x.name === 'SG Loan');
    near(row.valueINR, 10000 * R.SGD, 0.01, 'SGD liability');
    check(created.body.summary.totalLiabilitiesINR === LIABILITIES + 712500, `liability total ${created.body.summary.totalLiabilitiesINR}`);
    near(created.body.summary.netWorthINR, base - 712500, 1, 'net worth after loan');
    await reset();
    return 'subtracts at the converted value';
  });

  test('B7 Bundled fallback rates are used when nothing newer exists', async () => {
    await reset();
    const cleared = await api('PUT', '/api/import', { ...fixtureDoc(), settings: { ...fixtureDoc().settings, fx: {} } });
    check(cleared.status === 200, `import returned ${cleared.status}`);
    const h = byId(cleared.body.holdings, 'h_eq_us');
    check(h.rateSource === 'fallback', `source ${h.rateSource}`);
    check(h.rate === fx.FALLBACK_RATES.USD, `rate ${h.rate}`);
    check(h.rate !== R.USD, 'fallback and cached rates are identical - fixture is not discriminating');
    await reset();
    return `fallback ${h.rate}`;
  });

  test('B8 A pinned rate survives a settings save', async () => {
    await reset();
    await api('PUT', '/api/fx/SGD', { manualRate: 80 });
    const after = await api('PUT', '/api/settings', { assumptions: { inflationPct: 5 } });
    const sgd = after.body.rates.SGD;
    check(sgd.rate === 80 && sgd.source === 'manual', `SGD after settings save: ${sgd.rate}/${sgd.source}`);
    check(after.body.settings.assumptions.inflationPct === 5, 'assumption not saved');
    await api('PUT', '/api/fx/SGD', { manualRate: null });
    await reset();
    return 'pin outlives an unrelated write';
  });

  // ---- C. Valuation and aggregation ---------------------------------------
  group('C. Valuation and aggregation');

  test('C1 units x price overrides a stale lump-sum value', async () => {
    const s = await reset();
    const h = byId(s.holdings, 'h_eq_in');
    near(h.nativeValue, 100 * 250, 0.01, 'units x price');
    const edited = await api('PUT', '/api/holdings/h_eq_in', { valueNative: 999999 });
    check(edited.status === 200, `edit returned ${edited.status}`);
    const after = byId(edited.body.holdings, 'h_eq_in');
    near(after.nativeValue, 25000, 0.01, 'units x price still wins');
    return 'product beats lump sum';
  });

  test('C2 Net worth equals gross assets minus liabilities', async () => {
    const { summary } = await reset();
    near(summary.netWorthINR, summary.totalAssetsINR - summary.totalLiabilitiesINR, 0.01, 'identity');
    check(summary.totalAssetsINR === Math.round(GROSS_ASSETS * 100) / 100, `expected ${GROSS_ASSETS} gross assets, got ${summary.totalAssetsINR}`);
    check(summary.totalLiabilitiesINR === LIABILITIES, `expected ${LIABILITIES} liabilities, got ${summary.totalLiabilitiesINR}`);
    return `${summary.netWorthINR} = ${summary.totalAssetsINR} - ${summary.totalLiabilitiesINR}`;
  });

  test('C3 liquidityOverride moves a deposit out of the liquid bucket', async () => {
    const s = await reset();
    const fd = byId(s.holdings, 'h_fd2');
    check(fd.liquid === false, 'override to illiquid ignored');
    check(s.summary.liquidAssetsINR + s.summary.illiquidAssetsINR === s.summary.totalAssetsINR, 'liquid + illiquid != total');
    near(s.summary.liquidAssetsINR, LIQUID, 0.01, 'liquid total');
    const back = await api('PUT', '/api/holdings/h_fd2', { liquidityOverride: null });
    check(byId(back.body.holdings, 'h_fd2').liquid === true, 'clearing the override did not restore liquidity');
    near(back.body.summary.liquidAssetsINR, LIQUID + 200000, 0.01, 'liquid total after clearing');
    await reset();
    return 'override honoured both ways';
  });

  test('C4 Category shares of assets sum to 100%', async () => {
    const { summary } = await reset();
    const shares = Object.values(summary.byCategory).reduce((a, c) => a + c.shareOfAssetsPct, 0);
    near(shares, 100, 0.1, 'sum of shares');
    const contrib = Object.values(summary.byCategory).reduce((a, c) => a + c.netContributionINR, 0);
    near(contrib, summary.netWorthINR, 1, 'net contributions');
    check(summary.byCategory.liability.shareOfAssetsPct === 0, 'liability claimed a share of assets');
    return `${shares.toFixed(1)}% and contributions reconcile`;
  });

  test('C5 Country rollup nets liabilities against that country', async () => {
    const { summary } = await reset();
    const in_ = summary.byCountry.IN;
    near(in_.netContributionINR, in_.valueINR - in_.liabilitiesINR, 0.01, 'IN net');
    check(summary.byCountry.TH.liabilitiesINR === 0, 'TH should carry no liabilities');
    near(summary.byCountry.TH.netContributionINR, 100000 * R.THB, 0.01, 'TH net');
    near(summary.byCountry.US.netContributionINR, 1000 * R.USD, 0.01, 'US net');
    const countries = Object.values(summary.byCountry).reduce((a, c) => a + c.netContributionINR, 0);
    near(countries, summary.netWorthINR, 1, 'country nets reconcile to net worth');
    return 'per-country net correct';
  });

  test('C6 A zero-value ledger produces no NaN anywhere', async () => {
    const zero = { ...fixtureDoc(), holdings: [holding({ id: 'z1', name: 'Empty', category: 'bank_account', country: 'IN', currency: 'INR', valueNative: 0 })] };
    const r = await api('PUT', '/api/import', zero);
    check(r.status === 200, `import returned ${r.status}`);
    const s = r.body.summary;
    check(s.netWorthINR === 0, `net worth ${s.netWorthINR}`);
    check(Number.isFinite(s.netWorthINR), 'netWorth is NaN');
    check(Object.values(s.byCategory).every((c) => Number.isFinite(c.shareOfAssetsPct)), 'NaN share');
    check(s.performance.unrealisedGainPct === null, `gain pct ${s.performance.unrealisedGainPct}`);
    check(r.body.analysis.health.score === null || Number.isFinite(r.body.analysis.health.score), 'NaN health score');
    await reset();
    return 'all finite or null';
  });

  test('C7 Snapshots keep one row per calendar month, sorted', async () => {
    const first = valuation.upsertSnapshot([], { totalAssetsINR: 5, totalLiabilitiesINR: 0, netWorthINR: 5, liquidAssetsINR: 5 }, new Date('2026-10-15T00:00:00Z'));
    check(first.created === true && first.snapshots.length === 1, 'first write not recorded as new');
    const second = valuation.upsertSnapshot(first.snapshots, { totalAssetsINR: 1, totalLiabilitiesINR: 0, netWorthINR: 1, liquidAssetsINR: 1 }, new Date('2026-10-28T00:00:00Z'));
    check(second.snapshots.length === 1, `October produced ${second.snapshots.length} rows`);
    check(second.created === false, 'second write should not report a new period');
    check(second.snapshots[0].netWorthINR === 1, 'October row kept the stale figure');
    const third = valuation.upsertSnapshot(second.snapshots, { netWorthINR: 2, totalAssetsINR: 2, totalLiabilitiesINR: 0, liquidAssetsINR: 2 }, new Date('2026-09-05T00:00:00Z'));
    check(third.snapshots.length === 2 && third.snapshots[0].period === '2026-09', 'September row not sorted first');
    await reset();
    return 'deduped, refreshed and sorted';
  });

  test('C8 The snapshot endpoint refreshes the current month', async () => {
    await reset();
    const period = new Date().toISOString().slice(0, 7);
    const r = await api('POST', '/api/snapshot');
    check(r.status === 200, `snapshot returned ${r.status}`);
    check(r.body.snapshotResult.period === period, `period ${r.body.snapshotResult.period}`);
    check(r.body.snapshots.length === 1, `${r.body.snapshots.length} rows for one month`);
    near(r.body.snapshotResult.netWorthINR, NET_WORTH, 1, 'snapshot value');
    await api('PUT', '/api/holdings/h_bank', { valueNative: 600000 });
    const again = await api('POST', '/api/snapshot');
    check(again.body.snapshots.length === 1, 'a second row appeared for the same month');
    near(again.body.snapshots[0].netWorthINR, NET_WORTH + 100000, 1, 'refreshed snapshot value');
    await reset();
    return 'one row per month, refreshed in place';
  });

  // ---- D. Holdings API -----------------------------------------------------
  group('D. Holdings API');

  test('D1 A holding without a name is rejected with 400', async () => {
    await reset();
    const r = await api('POST', '/api/holdings', { category: 'equity', currency: 'INR', valueNative: 10 });
    check(r.status === 400, `status ${r.status}`);
    check(/name is required/i.test(r.body.error || ''), `message: ${r.body.error}`);
    const s = await state();
    check(s.holdings.length === 11, `row count moved to ${s.holdings.length}`);
    return 'rejected, no row added';
  });

  test('D2 PUT updates in place and preserves untouched fields', async () => {
    await reset();
    const r = await api('PUT', '/api/holdings/h_fd', { valueNative: 1250000 });
    check(r.status === 200, `status ${r.status}`);
    const h = byId(r.body.holdings, 'h_fd');
    check(r.body.holdings.length === 11, `row count became ${r.body.holdings.length}`);
    near(h.valueINR, 1250000, 0.01, 'updated value');
    check(h.name === '1Y FD', 'untouched field was cleared');
    check(h.interestRatePct === 7, 'untouched rate was cleared');
    check(h.maturityDate === '2027-06-30', 'untouched maturity was cleared');
    return 'sparse patch honoured';
  });

  test('D3 DELETE removes exactly one row', async () => {
    await reset();
    const r = await api('DELETE', '/api/holdings/h_gold');
    check(r.status === 200, `status ${r.status}`);
    check(r.body.holdings.length === 10, `${r.body.holdings.length} rows remain`);
    check(!byId(r.body.holdings, 'h_gold'), 'row still present');
    check(byId(r.body.holdings, 'h_flat'), 'a different row disappeared');
    near(r.body.summary.netWorthINR, NET_WORTH - 300000, 1, 'net worth after delete');
    await reset();
    return '11 -> 10, totals followed';
  });

  test('D4 Unknown ids return 404, not a crash', async () => {
    await reset();
    const put = await api('PUT', '/api/holdings/nope', { valueNative: 1 });
    const del = await api('DELETE', '/api/holdings/nope');
    const goal = await api('PUT', '/api/goals/nope', { name: 'x' });
    const goalDel = await api('DELETE', '/api/goals/nope');
    check(put.status === 404 && del.status === 404 && goal.status === 404 && goalDel.status === 404, `${put.status}/${del.status}/${goal.status}/${goalDel.status}`);
    const alive = await state();
    check(alive.holdings.length === 11, 'a 404 mutated the ledger');
    return '404 on all four, nothing changed';
  });

  test('D5 A malformed JSON body yields 400 and the server survives', async () => {
    const res = await fetch(`${BASE}/api/holdings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name": broken' });
    check(res.status === 400, `status ${res.status}`);
    const alive = await api('GET', '/api/state');
    check(alive.status === 200, 'server died after bad JSON');
    return '400, still serving';
  });

  test('D6 Changing an asset currency re-values it immediately', async () => {
    await reset();
    near(byId((await state()).holdings, 'h_bank').valueINR, 500000, 0.01, 'INR first');
    const r = await api('PUT', '/api/holdings/h_bank', { currency: 'USD' });
    near(byId(r.body.holdings, 'h_bank').valueINR, 500000 * R.USD, 0.01, 'USD second');
    near(r.body.summary.netWorthINR, NET_WORTH - 500000 + 500000 * R.USD, 1, 'net worth after re-conversion');
    await reset();
    return 'reconverted on currency change';
  });

  test('D7 Absurd numeric input is sanitised, never NaN', async () => {
    await reset();
    const r = await api('POST', '/api/holdings', { name: 'Wild', category: 'nonsense', country: 'in', currency: 'usd', valueNative: 1e21, units: 'abc', acquiredOn: 'not-a-date', maturityDate: '31/12/2030' });
    check(r.status === 201, `create returned ${r.status}`);
    const h = r.body.holdings.find((x) => x.name === 'Wild');
    check(h.category === 'other_asset', `unknown category kept as ${h.category}`);
    check(h.country === 'IN' && h.currency === 'USD', `case not normalised: ${h.country}/${h.currency}`);
    check(Number.isFinite(h.valueINR), `valueINR ${h.valueINR}`);
    check(h.units === null, `units sanitised to ${h.units}`);
    check(h.acquiredOn === null && h.maturityDate === null, `dates sanitised to ${h.acquiredOn}/${h.maturityDate}`);
    await reset();
    return 'garbage sanitised on write';
  });

  test('D8 Clearing a field with null really clears it', async () => {
    await reset();
    const r = await api('PUT', '/api/holdings/h_fd', { interestRatePct: null, maturityDate: null });
    const h = byId(r.body.holdings, 'h_fd');
    check(h.interestRatePct === null, `rate ${h.interestRatePct}`);
    check(h.maturityDate === null, `maturity ${h.maturityDate}`);
    check(h.name === '1Y FD' && h.valueNative === 1000000, 'null patch clobbered unrelated fields');
    await reset();
    return 'explicit null clears, absent keeps';
  });

  test('D9 Bulk delete removes a batch in one write', async () => {
    await reset();
    const ids = ['h_gold', 'h_fd2', 'h_recent'];
    const r = await api('POST', '/api/holdings/bulk-delete', { ids });
    check(r.status === 200, `bulk delete returned ${r.status}`);
    check(r.body.bulkResult.removed === 3, `removed ${r.body.bulkResult?.removed}`);
    ids.forEach((id) => check(!byId(r.body.holdings, id), `${id} survived the batch`));
    check(r.body.holdings.length === 8, `${r.body.holdings.length} rows left, expected 8`);
    // Ten separate DELETE calls would rotate the backup ten times and the last
    // rotation would be missing the earlier victims; one save keeps all of them.
    const backup = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'wealth-data.backup.json'), 'utf8'));
    check(backup.holdings.length === 11, `backup has ${backup.holdings.length} rows, expected the full pre-batch ledger`);
    check(ids.every((id) => byId(backup.holdings, id)), 'backup is missing a row the batch deleted');
    const gone = 300000 + 200000 + 10000;
    near(r.body.summary.netWorthINR, NET_WORTH - gone, 1, 'net worth after the batch');
    return '3 rows in one write, backup whole';
  });

  test('D10 A malformed bulk delete is refused and changes nothing', async () => {
    await reset();
    const cases = [undefined, {}, { ids: [] }, { ids: 'h_gold' }, { ids: null }];
    for (const body of cases) {
      const r = await api('POST', '/api/holdings/bulk-delete', body);
      check(r.status === 400, `payload ${JSON.stringify(body)} returned ${r.status}, expected 400`);
    }
    const unknown = await api('POST', '/api/holdings/bulk-delete', { ids: ['nope_1', 'nope_2'] });
    check(unknown.status === 404, `unknown ids returned ${unknown.status}, expected 404`);
    const after = await state();
    check(after.holdings.length === 11, `${after.holdings.length} rows remain after rejected batches`);
    return `${cases.length} bad payloads + 1 no-match rejected`;
  });

  test('D11 A mixed batch deletes what exists and drops a liability', async () => {
    await reset();
    const r = await api('POST', '/api/holdings/bulk-delete', { ids: ['h_loan', 'h_weird', 'ghost', 'h_loan'] });
    check(r.status === 200, `status ${r.status}`);
    check(r.body.bulkResult.removed === 2, `removed ${r.body.bulkResult?.removed}`);
    check(r.body.bulkResult.requested === 3, `requested ${r.body.bulkResult?.requested} (duplicate ids collapse)`);
    check(!byId(r.body.holdings, 'h_loan'), 'the liability survived');
    check(byId(r.body.holdings, 'h_weird') === undefined, 'unpriced foreign row survived');
    // Removing the ₹30 Lakh loan lifts net worth even though the row is an asset removal.
    near(r.body.summary.netWorthINR, NET_WORTH + 3000000, 1, 'net worth after removing debt');
    check(!byId(r.body.holdings, 'h_loan') && r.body.summary.liabilityCount === 0, 'liability count not cleared');
    await reset();
    return 'ghost id ignored, debt removal raises net worth';
  });

  // ---- E. Returns and XIRR -------------------------------------------------
  group('E. Returns and XIRR');

  test('E1 A single costed lot reports its own annualised rate', async () => {
    const one = [{ category: 'equity', country: 'IN', currency: 'INR', rate: 1, nativeValue: 150000, costNative: 100000, costINR: 100000, acquiredOn: '2021-01-01' }];
    const p = returns.portfolioXirr(one, TODAY);
    near(p.xirrPct, 7.29, 0.05, 'single-lot XIRR');
    check(p.coveredCount === 1, `coveredCount ${p.coveredCount}`);
    check(p.costedValueINR === 150000, `costedValueINR ${p.costedValueINR}`);
    return `XIRR ${p.xirrPct}%`;
  });

  test('E2 A liability carrying a cost is excluded from returns', async () => {
    const rows = [{ category: 'liability', country: 'IN', currency: 'INR', rate: 1, nativeValue: 500000, costNative: 100, costINR: 100, acquiredOn: '2021-01-01' }];
    const p = returns.portfolioXirr(rows, TODAY);
    check(p.coveredCount === 0, `coveredCount ${p.coveredCount}`);
    check(p.costedINR === 0, `costedINR ${p.costedINR}`);
    check(p.xirrPct === null, `xirr ${p.xirrPct}`);
    const s = await reset();
    near(s.summary.performance.costedINR, COSTED, 1, 'fixture costed base');
    return 'loans never count as invested';
  });

  test('E3 Zero cost is treated as no cost, not a divide-by-zero', async () => {
    const r = returns.holdingReturns({ nativeValue: 5000, costNative: 0, rate: 1, currency: 'INR', country: 'IN', category: 'equity', acquiredOn: '2020-01-01' }, TODAY);
    check(r.costINR === null, `costINR ${r.costINR}`);
    check(r.gainPct === null, `gainPct ${r.gainPct}`);
    check(r.annualisedPct === null, `annualised ${r.annualisedPct}`);
    const negative = returns.holdingReturns({ nativeValue: 0, costNative: 5000, rate: 1, currency: 'INR', country: 'IN', category: 'equity', acquiredOn: '2020-01-01' }, TODAY);
    check(negative.gainPct === -100, `total loss reported as ${negative.gainPct}`);
    return 'nulls, no Infinity';
  });

  test('E4 Indian equity crosses to LTCG at twelve months', async () => {
    const justBefore = returns.taxStatus({ country: 'IN', category: 'equity' }, 11 / 12);
    const justAfter = returns.taxStatus({ country: 'IN', category: 'equity' }, 1.0);
    check(justBefore === 'STCG', `11 months -> ${justBefore}`);
    check(justAfter === 'LTCG', `12 months -> ${justAfter}`);
    const debt = returns.taxStatus({ country: 'IN', category: 'bond' }, 1.5);
    check(debt === 'STCG', `bond at 18 months -> ${debt}`);
    const debt2 = returns.taxStatus({ country: 'IN', category: 'bond' }, 2.1);
    check(debt2 === 'LTCG', `bond at 25 months -> ${debt2}`);
    const gold = returns.taxStatus({ country: 'IN', category: 'gold_commodity' }, 1.0);
    check(gold === 'LTCG', `gold at 12 months -> ${gold}`);
    return '12m equity/gold, 24m debt boundaries';
  });

  test('E5 Tax buckets only apply to costed India-country lots', async () => {
    const s = await reset();
    check(byId(s.holdings, 'h_eq_us').taxStatus === 'n/a', 'US equity got a bucket');
    check(byId(s.holdings, 'h_eq_in').taxStatus === 'LTCG', 'IN equity should be LTCG');
    check(byId(s.holdings, 'h_gold').taxStatus === 'LTCG', 'SGB should be LTCG');
    check(byId(s.holdings, 'h_recent').taxStatus === 'STCG', 'a 2-month equity lot is not LTCG');
    check(byId(s.holdings, 'h_bank').taxStatus === null, 'an uncosted holding claimed a bucket');
    check(byId(s.holdings, 'h_policy').taxStatus === null, 'an uncosted policy claimed a bucket');
    const created = await api('POST', '/api/holdings', { name: 'SG Bond', category: 'bond', country: 'SG', currency: 'SGD', valueNative: 1000, costNative: 900, acquiredOn: '2024-01-01' });
    check(byId(created.body.holdings, created.body.holdings.find((x) => x.name === 'SG Bond').id).taxStatus === 'n/a', 'a costed Singapore bond got an Indian bucket');
    await reset();
    return 'n/a outside India, STCG/LTCG inside, null without a cost';
  });

  test('E6 Coverage counts follow cost edits', async () => {
    const before = await reset();
    check(before.summary.performance.coveredCount === 5, `fixture covers ${before.summary.performance.coveredCount}`);
    check(before.summary.performance.uncoveredCount === 5, `uncovered ${before.summary.performance.uncoveredCount}`);
    const after = await api('PUT', '/api/holdings/h_bank', { costNative: 400000, acquiredOn: '2020-01-01' });
    check(after.body.summary.performance.coveredCount === 6, `after edit ${after.body.summary.performance.coveredCount}`);
    check(after.body.analysis.health.costBasisCoveragePct > before.analysis.health.costBasisCoveragePct, 'coverage pct did not rise');
    const cleared = await api('PUT', '/api/holdings/h_bank', { costNative: null });
    check(cleared.body.summary.performance.coveredCount === 5, `after clearing ${cleared.body.summary.performance.coveredCount}`);
    near(cleared.body.summary.performance.costedINR, COSTED, 1, 'costed base back to fixture');
    await reset();
    return '5 -> 6 -> 5';
  });

  test('E7 Best and worst performers ignore lots under six months', async () => {
    const perf = (await reset()).summary.performance;
    check(perf.best.name === 'Reliance', `best was ${perf.best.name}`);
    near(perf.best.gainPct, 150, 0.01, 'best gain');
    check(perf.worst.name === 'SGB', `worst was ${perf.worst.name}`);
    near(perf.worst.gainPct, 20, 0.01, 'worst gain');
    check(perf.worst.name !== 'Freshest Buy', 'a 2-month losing lot was ranked');
    near(perf.unrealisedGainINR, perf.costedValueINR - perf.costedINR, 1, 'unrealised gain reconciles');
    return `best ${perf.best.name} ${perf.best.gainPct}% / worst ${perf.worst.name} ${perf.worst.gainPct}%`;
  });

  test('E8 Returns are computed in native currency so FX cannot inflate them', async () => {
    const lot = (rate) => [{ category: 'equity', country: 'US', currency: 'USD', rate, nativeValue: 1000, costNative: 500, costINR: 500 * rate, acquiredOn: '2025-09-01' }];
    const atCached = returns.portfolioXirr(lot(R.USD), TODAY).xirrPct;
    const atPinned = returns.portfolioXirr(lot(200), TODAY).xirrPct;
    near(atCached, 88.5, 0.5, 'USD lot annualised return');
    check(Math.abs(atCached - atPinned) < 0.01, `the same lot returned ${atCached}% at 88.5 and ${atPinned}% at 200`);
    await reset();
    const apple = byId((await state()).holdings, 'h_eq_us');
    near(apple.gainPct, 100, 0.01, 'native gain pct');
    const pinned = await api('PUT', '/api/fx/USD', { manualRate: 200 });
    const after = byId(pinned.body.holdings, 'h_eq_us');
    near(after.valueINR, 200000, 0.01, 'INR value follows the pin');
    near(after.gainPct, 100, 0.01, 'native gain moved with FX');
    await api('PUT', '/api/fx/USD', { manualRate: null });
    await reset();
    return 'rate-independent return, FX still revalues';
  });

  test('E9 A holding with a cost but no purchase date earns no annualised rate', async () => {
    await reset();
    const created = await api('POST', '/api/holdings', { name: 'Undated', category: 'bond', country: 'IN', currency: 'INR', valueNative: 120000, costNative: 100000 });
    const h = created.body.holdings.find((x) => x.name === 'Undated');
    near(h.gainPct, 20, 0.01, 'absolute gain still reported');
    check(h.annualisedPct === null, `annualised ${h.annualisedPct}`);
    check(h.taxStatus === null, `tax bucket ${h.taxStatus}`);
    check(h.yearsHeld === null, `yearsHeld ${h.yearsHeld}`);
    check(created.body.summary.performance.coveredCount === 5, 'an undated lot entered the XIRR cash flows');
    await reset();
    return 'gain without a date, excluded from XIRR';
  });

  // ---- F. Allocation and health -------------------------------------------
  group('F. Allocation and health');

  test('F1 Targets that total 100 produce drift summing to zero', async () => {
    await reset();
    const r = await api('PUT', '/api/settings', { targetAllocation: { equity: 20, real_estate: 40, bank_account: 15, fixed_deposit: 10, policy: 5, gold_commodity: 5, bond: 2, other_asset: 2, retirement_scheme: 1 } });
    check(r.status === 200, `save returned ${r.status}`);
    const rows = r.body.analysis.allocation.rows;
    near(rows.reduce((a, x) => a + x.driftPct, 0), 0, 0.2, 'sum of drift');
    check(r.body.analysis.allocation.targetsComplete === true, 'targets reported incomplete');
    near(r.body.analysis.allocation.targetSumPct, 100, 0.01, 'target sum');
    near(r.body.analysis.allocation.totalINR, GROSS_ASSETS, 1, 'allocation base total');
    await reset();
    return 'drift reconciles';
  });

  test('F2 Unknown classes and out-of-range weights are dropped on save', async () => {
    await reset();
    const r = await api('PUT', '/api/settings', { targetAllocation: { equity: 50, nonsense: 30, bond: 250, policy: -5, gold_commodity: 50 } });
    const t = r.body.settings.targetAllocation;
    check(t.equity === 50 && t.gold_commodity === 50, `valid weights lost: ${JSON.stringify(t)}`);
    check(!('nonsense' in t), 'unknown class accepted');
    check(!('policy' in t), 'negative weight accepted');
    check(t.bond === 100, `bond clamped to ${t.bond}`);
    check(r.body.analysis.allocation.targetsComplete === false, 'an over-100 target set claimed completeness');
    await reset();
    return 'filtered and clamped';
  });

  test('F3 Clearing targets switches the discipline component off', async () => {
    await reset();
    const withTargets = await api('PUT', '/api/settings', { targetAllocation: { equity: 100 } });
    check(withTargets.body.analysis.health.components.some((c) => c.key === 'discipline'), 'no discipline component');
    const cleared = await api('PUT', '/api/settings', { targetAllocation: {} });
    check(Object.keys(cleared.body.settings.targetAllocation).length === 0, 'targets survived the clear');
    check(!cleared.body.analysis.health.components.some((c) => c.key === 'discipline'), 'discipline still scored');
    check(cleared.body.analysis.allocation.rows.every((row) => row.action === 'unassigned'), 'advice still issued without targets');
    await reset();
    return 'component appears and disappears';
  });

  test('F4 The rupee move suggested always matches its buy/trim label', async () => {
    await reset();
    const r = await api('PUT', '/api/settings', { targetAllocation: { equity: 60, real_estate: 5, bank_account: 15, fixed_deposit: 10, policy: 3, gold_commodity: 4, bond: 2, other_asset: 1, retirement_scheme: 0 } });
    const total = r.body.summary.totalAssetsINR;
    const rows = r.body.analysis.allocation.rows.filter((x) => x.hasTarget && Math.abs(x.driftPct) >= 1);
    check(rows.length >= 2, `only ${rows.length} actionable rows`);
    for (const x of rows) {
      if (x.action === 'buy') check(x.deltaINR > 0, `${x.key}: buy with delta ${x.deltaINR}`);
      if (x.action === 'trim') check(x.deltaINR < 0, `${x.key}: trim with delta ${x.deltaINR}`);
      near(Math.abs(x.deltaINR), Math.abs(x.targetPct / 100 * total - x.heldINR), 1, `${x.key} delta size`);
      near(x.actualPct - x.driftPct, x.targetPct, 0.02, `${x.key} drift definition`);
    }
    await reset();
    return `${rows.length} actionable rows agree`;
  });

  test('F5 A concentrated book scores below a diversified one', async () => {
    const m = 1000000;
    const spreadDoc = fixtureDoc({ holdings: [
      holding({ id: 's1', name: 'Cash', category: 'bank_account', country: 'IN', currency: 'INR', valueNative: m }),
      holding({ id: 's2', name: 'FD', category: 'fixed_deposit', country: 'IN', currency: 'INR', valueNative: m }),
      holding({ id: 's3', name: 'Infosys', category: 'equity', country: 'IN', currency: 'INR', valueNative: m }),
      holding({ id: 's4', name: 'VTI', category: 'equity', country: 'US', currency: 'USD', valueNative: m / R.USD }),
      holding({ id: 's5', name: 'G-Sec', category: 'bond', country: 'IN', currency: 'INR', valueNative: m }),
      holding({ id: 's6', name: 'EPF', category: 'retirement_scheme', country: 'IN', currency: 'INR', valueNative: m }),
      holding({ id: 's7', name: 'Condo', category: 'real_estate', country: 'SG', currency: 'SGD', valueNative: m / R.SGD }),
      holding({ id: 's8', name: 'SGB', category: 'gold_commodity', country: 'IN', currency: 'INR', valueNative: m }),
      holding({ id: 's9', name: 'Policy', category: 'policy', country: 'TH', currency: 'THB', valueNative: m / R.THB }),
      holding({ id: 's10', name: 'Car', category: 'other_asset', country: 'IN', currency: 'INR', valueNative: m }),
    ] });
    const targets = { equity: 20, real_estate: 10, bank_account: 10, fixed_deposit: 10, policy: 10, gold_commodity: 10, bond: 10, retirement_scheme: 10, other_asset: 10 };
    const spread = await api('PUT', '/api/import', { ...spreadDoc, settings: { ...spreadDoc.settings, targetAllocation: targets } });
    const spreadHealth = spread.body.analysis.health;
    const mono = await api('PUT', '/api/import', { ...fixtureDoc(), holdings: [
      holding({ id: 'm1', name: 'Everything', category: 'real_estate', country: 'IN', currency: 'INR', valueNative: 9000000 }),
      holding({ id: 'm2', name: 'Loan', category: 'liability', country: 'IN', currency: 'INR', valueNative: 100000 }),
    ] });
    const h = mono.body.analysis.health;
    check(h.score < spreadHealth.score, `concentrated book scored ${h.score} vs diversified ${spreadHealth.score}`);
    check(h.components.find((c) => c.key === 'diversification').score < 40, 'diversification did not react');
    check(h.components.find((c) => c.key === 'glidepath').score < 40, 'glidepath did not react');
    check(spreadHealth.components.find((c) => c.key === 'diversification').score > 60, 'diversified book was not rewarded');
    check(spreadHealth.components.every((c) => Number.isFinite(c.score)), 'a component is NaN');
    near(h.costBasisCoveragePct, 0, 0.01, 'coverage of an undated book');
    await reset();
    return `${h.score} concentrated vs ${spreadHealth.score} diversified`;
  });

  test('F6 Health scoring survives an empty ledger without throwing', async () => {
    const empty = await api('PUT', '/api/import', { ...fixtureDoc(), holdings: [] });
    check(empty.status === 200, `import returned ${empty.status}`);
    const h = empty.body.analysis.health;
    check(h.score === null, `score ${h.score}`);
    check(h.grade === '—', `grade ${h.grade}`);
    check(Array.isArray(h.components) && h.components.length === 0, `${h.components.length} scored components on an empty ledger`);
    check(h.costBasisCoveragePct === 0, `coverage ${h.costBasisCoveragePct}`);
    check(empty.body.summary.netWorthINR === 0, `net worth ${empty.body.summary.netWorthINR}`);
    check(Array.isArray(empty.body.analysis.allocation.rows) && empty.body.analysis.allocation.rows.length === 0, 'allocation rows not empty');
    check(empty.body.analysis.concentration.largest === null, 'concentration invented an asset');
    await reset();
    return 'empty ledger scores null';
  });

  test('F7 Concentration metrics recompute after the largest asset goes', async () => {
    const before = await reset();
    check(before.analysis.concentration.largest === 'Demo Nagar Flat', `largest was ${before.analysis.concentration.largest}`);
    near(before.analysis.concentration.top1Pct, 5000000 / GROSS_ASSETS * 100, 0.01, 'top1 share');
    const after = await api('DELETE', '/api/holdings/h_flat');
    check(after.body.analysis.concentration.largest === '1Y FD', `largest after delete ${after.body.analysis.concentration.largest}`);
    check(after.body.analysis.concentration.top5Pct <= 100, `top5 ${after.body.analysis.concentration.top5Pct}`);
    check(after.body.analysis.concentration.hhi < before.analysis.concentration.hhi, 'HHI did not fall');
    near(after.body.analysis.concentration.top1Pct, 1000000 / (GROSS_ASSETS - 5000000) * 100, 0.01, 'top1 after delete');
    await reset();
    return `largest -> ${after.body.analysis.concentration.largest}`;
  });

  test('F8 Risk buckets and geography partition the assets exactly once', async () => {
    const s = await reset();
    const sum = s.analysis.riskMix.reduce((a, x) => a + x.pct, 0);
    near(sum, 100, 0.1, 'risk bucket shares');
    check(s.analysis.riskMix.every((x) => x.label && x.valueINR > 0), 'an empty bucket was published');
    near(s.analysis.riskMix.reduce((a, x) => a + x.valueINR, 0), GROSS_ASSETS, 1, 'risk bucket rupees');
    const geo = s.analysis.geography;
    check(geo.countryCount === 3, `${geo.countryCount} countries - the unconvertible ZZ asset should not count`);
    near(geo.foreignPct, (1000 * R.USD + 100000 * R.THB) / GROSS_ASSETS * 100, 0.01, 'foreign exposure');
    near(geo.largestCountryPct, 7035000 / GROSS_ASSETS * 100, 0.01, 'largest country share');
    return `${geo.countryCount} countries, ${geo.foreignPct}% foreign`;
  });

  // ---- G. Goals ------------------------------------------------------------
  group('G. Goals');

  test('G1 Goal create, read, update and delete round-trip', async () => {
    await reset();
    const created = await api('POST', '/api/goals', { name: 'Education', targetAmountINR: 2000000, targetDate: '2035-06-30', monthlyContributionINR: 20000, expectedReturnPct: 11, inflationPct: 8, linkedHoldingIds: ['h_eq_in'] });
    check(created.status === 201, `create returned ${created.status}`);
    const goal = created.body.goals[0];
    check(goal.name === 'Education' && goal.linked.length === 1, `read back ${JSON.stringify({ n: goal.name, l: goal.linked })}`);
    check(goal.linked[0].valueINR === 25000, `linked value ${goal.linked[0].valueINR}`);
    const updated = await api('PUT', `/api/goals/${goal.id}`, { targetAmountINR: 3000000 });
    check(updated.body.goals[0].targetAmountINR === 3000000, 'update ignored');
    check(updated.body.goals[0].name === 'Education', 'sparse update cleared the name');
    check(updated.body.goals[0].linked.length === 1, 'sparse update dropped the links');
    const deleted = await api('DELETE', `/api/goals/${goal.id}`);
    check(deleted.body.goals.length === 0, 'delete did not remove it');
    check(deleted.body.holdings.length === 11, 'deleting a goal removed a holding');
    await reset();
    return 'full cycle';
  });

  test('G2 A goal without a name or a positive target is rejected', async () => {
    await reset();
    const zero = await api('POST', '/api/goals', { name: 'Vague', targetAmountINR: 0 });
    const negative = await api('POST', '/api/goals', { name: 'Negative', targetAmountINR: -500000 });
    const blank = await api('POST', '/api/goals', { targetAmountINR: 100 });
    check(zero.status === 400, `zero target returned ${zero.status}`);
    check(/above zero/i.test(zero.body.error || ''), `message: ${zero.body.error}`);
    check(negative.status === 400, `negative target returned ${negative.status}`);
    check(blank.status === 400, `blank name returned ${blank.status}`);
    const s = await state();
    check(s.goals.length === 0, `${s.goals.length} junk goals were stored`);
    return 'both guards reject, nothing stored';
  });

  test('G3 The target inflates to its date at the stated rate', async () => {
    await reset();
    const r = await api('POST', '/api/goals', { name: 'Car', targetAmountINR: 1000000, horizonYears: 5, expectedReturnPct: 10, inflationPct: 6 });
    const g = r.body.goals[0];
    near(g.targetTodayINR, 1000000, 1, 'target today');
    near(g.targetAtDateINR, 1000000 * Math.pow(1.06, 5), 1500, 'inflated target');
    check(g.years > 4.9 && g.years < 5.1, `horizon read as ${g.years}`);
    near(g.progressPct, 0, 0.01, 'an unlinked goal has no progress');
    check(g.status === 'at-risk', `status ${g.status}`);
    await reset();
    return `₹${g.targetAtDateINR} at +6%/yr`;
  });

  test('G4 The recommended monthly amount actually reaches the target', async () => {
    await reset();
    const r = await api('POST', '/api/goals', { name: 'House', targetAmountINR: 5000000, horizonYears: 10, monthlyContributionINR: 0, expectedReturnPct: 11, inflationPct: 6, linkedHoldingIds: ['h_fd'] });
    const g = r.body.goals[0];
    check(g.shortfallINR > 0, `no shortfall computed (${g.shortfallINR})`);
    near(g.currentINR, 1000000, 1, 'linked pot');
    const i = 0.11 / 12;
    const n = Math.round(g.years * 12);
    const fv = g.currentINR * Math.pow(1.11, g.years) + g.neededMonthlyINR * ((Math.pow(1 + i, n) - 1) / i);
    near(fv, g.targetAtDateINR, g.targetAtDateINR * 0.02, 'FV of the recommendation');
    check(g.extraMonthlyINR === g.neededMonthlyINR, `extra ${g.extraMonthlyINR} vs needed ${g.neededMonthlyINR} with no plan`);
    const funded = await api('PUT', `/api/goals/${g.id}`, { monthlyContributionINR: g.neededMonthlyINR });
    const f = funded.body.goals[0];
    check(f.projectedINR >= f.targetAtDateINR * 0.98, `following the advice still leaves ${f.progressPct}% funded`);
    check(['on-track', 'close', 'funded'].includes(f.status), `status after funding the plan: ${f.status}`);
    await reset();
    return `₹${Math.round(g.neededMonthlyINR)}/mo lands within 2%`;
  });

  test('G5 A goal already fully funded asks for no extra money', async () => {
    await reset();
    const r = await api('POST', '/api/goals', { name: 'Done', targetAmountINR: 100000, horizonYears: 10, monthlyContributionINR: 5000, linkedHoldingIds: ['h_flat', 'h_fd'] });
    const g = r.body.goals[0];
    check(g.shortfallINR === 0, `shortfall ${g.shortfallINR} on a funded goal`);
    check(g.extraMonthlyINR === 0, `recommended extra ${g.extraMonthlyINR}`);
    check(g.neededMonthlyINR === 5000, `needed ${g.neededMonthlyINR} should stay at the recorded plan`);
    check(g.status === 'on-track', `status ${g.status}`);
    check(g.progressPct > 100, `progress ${g.progressPct}`);
    await reset();
    return 'overfunded goal asks for nothing';
  });

  test('G6 Deleting a linked holding flags the goal instead of breaking it', async () => {
    await reset();
    const created = await api('POST', '/api/goals', { name: 'Travel', targetAmountINR: 500000, horizonYears: 3, linkedHoldingIds: ['h_gold', 'h_fd'] });
    check(created.body.goals[0].linkedCount === 2, 'links not stored');
    near(created.body.goals[0].currentINR, 1300000, 1, 'both links valued');
    const after = await api('DELETE', '/api/holdings/h_gold');
    const g = after.body.goals[0];
    check(g.linkedCount === 1, `linked ${g.linkedCount}`);
    check(g.missingLinkCount === 1, `missingLinkCount ${g.missingLinkCount}`);
    near(g.currentINR, 1000000, 1, 'currentINR after the link went');
    check(after.body.goals.length === 1, 'goal vanished with its holding');
    check(after.body.goals[0].linkedHoldingIds.length === 2, 'the stored link list was silently rewritten');
    await reset();
    return 'one link lost, goal intact';
  });

  test('G7 Goals sort by the horizon and expose status per goal', async () => {
    await reset();
    await api('POST', '/api/goals', { name: 'Far', targetAmountINR: 1000000, horizonYears: 20 });
    await api('POST', '/api/goals', { name: 'Soon', targetAmountINR: 1000000, horizonYears: 1 });
    await api('POST', '/api/goals', { name: 'Mid', targetAmountINR: 1000000, horizonYears: 5 });
    const s = await state();
    check(s.goals.map((g) => g.name).join(',') === 'Soon,Mid,Far', `order ${s.goals.map((g) => g.name)}`);
    check(s.goals.every((g) => g.status && g.progressPct >= 0), 'missing status/progress');
    check(s.goals[0].years < s.goals[2].years, 'years not monotonic');
    const dated = await api('POST', '/api/goals', { name: 'Dated', targetAmountINR: 1000000, targetDate: '2026-12-31' });
    const d = dated.body.goals.find((g) => g.name === 'Dated');
    check(d.years < 0.25 && d.status === 'urgent', `a goal 3 months out read as ${d.status} (${d.years}y)`);
    await reset();
    return 'ordered by urgency, near-dated flagged';
  });

  test('G8 Deleting a goal leaves the holdings untouched', async () => {
    await reset();
    const created = await api('POST', '/api/goals', { name: 'Temp', targetAmountINR: 100, linkedHoldingIds: ['h_eq_in', 'h_flat'] });
    const id = created.body.goals[0].id;
    const r = await api('DELETE', `/api/goals/${id}`);
    check(r.body.goals.length === 0, 'goal remains');
    check(r.body.holdings.length === 11, `${r.body.holdings.length} holdings left`);
    check(byId(r.body.holdings, 'h_eq_in') && byId(r.body.holdings, 'h_flat'), 'a linked holding was deleted');
    near(r.body.summary.netWorthINR, NET_WORTH, 1, 'net worth unchanged');
    return 'holdings survive';
  });

  // ---- H. Retirement and FIRE maths ---------------------------------------
  group('H. Retirement and FIRE maths');

  test('H1 Required corpus collapses to zero when there is no drawdown span', async () => {
    const m = await loadPlanning();
    const r = m.requiredCorpus({ monthlyExpensesAtRetirementToday: 100000, retireAge: 60, lifeAge: 60, preInflation: 6, postReturn: 7, bufferPct: 10, yearsToRetirement: 20 });
    check(r.requiredINR === 0, `required ${r.requiredINR}`);
    check(r.spanYears === 0, `span ${r.spanYears}`);
    check(Number.isFinite(r.firstYearWithdrawalINR), 'withdrawal NaN');
    const reversed = m.requiredCorpus({ monthlyExpensesAtRetirementToday: 100000, retireAge: 70, lifeAge: 60, preInflation: 6, postReturn: 7, bufferPct: 10, yearsToRetirement: 20 });
    check(reversed.requiredINR === 0, `retiring after dying required ${reversed.requiredINR}`);
    return 'no span, no corpus';
  });

  test('H2 A funded corpus grows with spending, horizon and inflation', async () => {
    const m = await loadPlanning();
    const args = { monthlyExpensesAtRetirementToday: 100000, retireAge: 60, lifeAge: 90, preInflation: 6, postReturn: 7, bufferPct: 10, yearsToRetirement: 30 };
    const base = m.requiredCorpus(args);
    const moreSpend = m.requiredCorpus({ ...args, monthlyExpensesAtRetirementToday: 200000 });
    const longer = m.requiredCorpus({ ...args, lifeAge: 100 });
    const hotter = m.requiredCorpus({ ...args, preInflation: 9 });
    const safer = m.requiredCorpus({ ...args, postReturn: 3 });
    const later = m.requiredCorpus({ ...args, yearsToRetirement: 35 });
    const bufferless = m.requiredCorpus({ ...args, bufferPct: 0 });
    near(moreSpend.requiredINR, base.requiredINR * 2, 1, 'corpus is linear in spending');
    check(longer.requiredINR > base.requiredINR, 'longer horizon did not raise the target');
    check(hotter.requiredINR > base.requiredINR, 'inflation did not raise the target');
    check(safer.requiredINR > base.requiredINR, 'lower post-retirement return did not raise the target');
    check(later.requiredINR > base.requiredINR, 'more accumulation years did not raise the target');
    near(bufferless.requiredINR, base.requiredINR / 1.1, 1, 'buffer is a clean multiplier');
    return `base ₹${Math.round(base.requiredINR)}`;
  });

  test('H3 The projection reports the exact age the money runs out', async () => {
    const m = await loadPlanning();
    const p = m.project({ netWorthINR: 1000000, currentAge: 40, retireAge: 50, lifeAge: 90, preReturnPct: 8, postReturnPct: 5, inflationPct: 6, monthlySurplusINR: 5000, salaryGrowthPct: 3, annualExpenseAtRetirementINR: 1800000 });
    check(p.runsOutAge !== null, 'a hopeless plan reported no run-out');
    check(p.runsOutAge > 50 && p.runsOutAge <= 90, `run-out age ${p.runsOutAge}`);
    check(p.series[p.runsOutAge - 40].balanceINR < 0, 'balance at the reported age is not negative');
    check(p.series[p.runsOutAge - 40 - 1].balanceINR >= 0, 'the previous year was already negative');
    check(p.series[0].balanceINR === 1000000, 'series does not start at net worth');
    check(p.series[p.series.length - 1].age === 90, `series ends at ${p.series[p.series.length - 1].age}`);
    const healthy = m.project({ netWorthINR: 50000000, currentAge: 40, retireAge: 50, lifeAge: 90, preReturnPct: 8, postReturnPct: 5, inflationPct: 6, monthlySurplusINR: 50000, salaryGrowthPct: 3, annualExpenseAtRetirementINR: 1800000 });
    check(healthy.runsOutAge === null, `well-funded plan runs out at ${healthy.runsOutAge}`);
    return `runs out at ${p.runsOutAge}`;
  });

  test('H4 The top-up Plan B recommends closes the gap without overshooting', async () => {
    const m = await loadPlanning();
    const profile = { dateOfBirth: '1990-01-01', plannedRetirementAge: 55, lifeExpectancy: 92, monthlyExpensesInRetirementINR: 250000, monthlyInvestableSurplusINR: 40000 };
    const assumptions = { preRetirementReturnPct: 11, postRetirementReturnPct: 7, inflationPct: 6, salaryGrowthPct: 6, corpusBufferPct: 10 };
    const plan = m.buildPlan({ profile, assumptions, netWorthINR: 8000000, liquidAssetsINR: 2000000, currentAge: 36 });
    check(plan.gapINR > 0, `no gap to close (${plan.gapINR})`);
    check(plan.additionalMonthlyTopUpINR > 0, 'no top-up recommended');
    check(plan.funded.balanceAtRetirementINR >= plan.corpus.requiredINR, `funded ${plan.funded.balanceAtRetirementINR} < required ${plan.corpus.requiredINR}`);
    // The recommendation is monthly money: it must land on the target, not a
    // multiple of it, or the planner tells you to invest an impossible amount.
    check(plan.funded.balanceAtRetirementINR < plan.corpus.requiredINR * 1.05, `top-up overshoots to ${Math.round(plan.funded.balanceAtRetirementINR / plan.corpus.requiredINR * 100)}% of target`);
    check(plan.funded.balanceAtRetirementINR > plan.baseline.balanceAtRetirementINR, 'top-up changed nothing');
    check(plan.baseline.runsOutAge === null || plan.baseline.runsOutAge > plan.retireAge, 'baseline fails before retirement');
    near(plan.gapTodayValueINR * Math.pow(1.06, plan.yearsToRetirement), plan.gapINR, 2000, 'gap deflated back to today');
    check(plan.financiallyFreeAge > 36 && plan.financiallyFreeAge <= 92, `FIRE age ${plan.financiallyFreeAge}`);
    return `+₹${plan.additionalMonthlyTopUpINR}/mo clears a ₹${Math.round(plan.gapINR)} gap`;
  });

  test('H5 FIRE number, coast FIRE and savings rate reconcile', async () => {
    const m = await loadPlanning();
    const cf = m.cashFlow({
      profile: { monthlyIncomeINR: 400000, monthlyExpensesNowINR: 100000, monthlyEmiINR: 50000, monthlyInvestableSurplusINR: 150000, plannedRetirementAge: 60 },
      netWorthINR: 5000000, totalLiabilitiesINR: 0, currentAge: 35,
      assumptions: { preRetirementReturnPct: 11, inflationPct: 6 },
    });
    check(cf.fireNumberINR === 45000000, `FIRE number ${cf.fireNumberINR}`);
    near(cf.fireProgressPct, 5000000 / 45000000 * 100, 0.01, 'progress to FIRE');
    check(cf.monthlyCommittedINR === 150000, `committed ${cf.monthlyCommittedINR}`);
    near(cf.savingsRatePct, 62.5, 0.01, 'savings rate');
    near(cf.investedRatePct, 37.5, 0.01, 'invested rate');
    check(cf.leakINR === 100000, `leak ${cf.leakINR}`);
    near(cf.coastFireINR, 45000000 / Math.pow(1.11, 25), 1000, 'coast discount over 25 years');
    check(cf.coastFireINR < cf.fireNumberINR, 'coast FIRE is not smaller than FIRE');
    near(cf.coastProgressPct, 5000000 / cf.coastFireINR * 100, 0.01, 'progress to coast FIRE');
    near(cf.emiBurdenPct, 12.5, 0.01, 'EMI burden');
    check(cf.fireAge > 35 && cf.yearsToFire === cf.fireAge - 35, `fireAge ${cf.fireAge}, yearsToFire ${cf.yearsToFire}`);
    return `FIRE ₹4.5cr at ${cf.fireProgressPct.toFixed(1)}% in ${cf.yearsToFire} years`;
  });

  test('H6 FIRE maths degrades safely with no income or zero spending', async () => {
    const m = await loadPlanning();
    const none = m.cashFlow({ profile: {}, netWorthINR: 0, totalLiabilitiesINR: 0, currentAge: null, assumptions: { preRetirementReturnPct: 11, inflationPct: 6 } });
    check(none.monthlyIncomeINR === 0, 'income not zero');
    check(none.savingsRatePct === null, `savings rate ${none.savingsRatePct}`);
    check(none.fireNumberINR === 0, `fire number ${none.fireNumberINR}`);
    check(none.fireProgressPct === null, `progress on a zero number: ${none.fireProgressPct}`);
    check(none.fireAge === null && none.yearsToFire === null, 'invented a FIRE age from nothing');
    check(none.debtToIncomeYears === null, 'debt-to-income invented from nothing');
    check(none.emiBurdenPct === null, 'EMI burden invented from nothing');
    const overspent = m.cashFlow({ profile: { monthlyIncomeINR: 100000, monthlyExpensesNowINR: 120000, monthlyEmiINR: 0, monthlyInvestableSurplusINR: 0 }, netWorthINR: 0, totalLiabilitiesINR: 0, currentAge: 40, assumptions: { preRetirementReturnPct: 11 } });
    check(overspent.leakINR === 0, `negative income leaked ${overspent.leakINR}`);
    check(overspent.savingsRatePct <= 0, `negative savings rate read as ${overspent.savingsRatePct}`);
    const zeroReturn = m.cashFlow({ profile: { monthlyIncomeINR: 100000, monthlyExpensesNowINR: 50000, monthlyEmiINR: 0, monthlyInvestableSurplusINR: 50000 }, netWorthINR: 100000, totalLiabilitiesINR: 0, currentAge: 40, assumptions: { preRetirementReturnPct: 0, inflationPct: 0 } });
    check(Number.isFinite(zeroReturn.coastFireINR), `coast with 0% return: ${zeroReturn.coastFireINR}`);
    near(zeroReturn.coastFireINR, zeroReturn.fireNumberINR, 1, '0% return makes coast equal FIRE');
    return 'no NaN, no Infinity';
  });

  test('H7 buildPlan warns when the inputs cannot support a projection', async () => {
    const m = await loadPlanning();
    const assumptions = { preRetirementReturnPct: 11, postRetirementReturnPct: 3, inflationPct: 6, salaryGrowthPct: 6, corpusBufferPct: 10 };
    const noDob = m.buildPlan({ profile: { plannedRetirementAge: 60, lifeExpectancy: 90, monthlyExpensesInRetirementINR: 100000 }, assumptions, netWorthINR: 1000000, liquidAssetsINR: 0, currentAge: undefined });
    check(noDob.warnings.some((w) => /date of birth/i.test(w.text)), 'no DOB warning');
    const noSpend = m.buildPlan({ profile: { dateOfBirth: '1990-01-01', plannedRetirementAge: 60, lifeExpectancy: 90 }, assumptions, netWorthINR: 1000000, liquidAssetsINR: 0, currentAge: 36 });
    check(noSpend.warnings.some((w) => /retirement spending/i.test(w.text)), 'no spending warning');
    const inverted = m.buildPlan({ profile: { dateOfBirth: '1990-01-01', plannedRetirementAge: 95, lifeExpectancy: 90, monthlyExpensesInRetirementINR: 100000 }, assumptions, netWorthINR: 1000000, liquidAssetsINR: 0, currentAge: 36 });
    check(inverted.warnings.some((w) => /life expectancy/i.test(w.text)), 'retire-after-die not flagged');
    const eroding = m.buildPlan({ profile: { dateOfBirth: '1990-01-01', plannedRetirementAge: 60, lifeExpectancy: 90, monthlyExpensesInRetirementINR: 100000 }, assumptions, netWorthINR: 1000000, liquidAssetsINR: 0, currentAge: 36 });
    check(eroding.warnings.some((w) => /inflation/i.test(w.text)), 'real-return warning missing');
    const everyWarning = m.buildPlan({ profile: { plannedRetirementAge: 95, lifeExpectancy: 90 }, assumptions, netWorthINR: 0, liquidAssetsINR: 0, currentAge: undefined });
    check(everyWarning.warnings.every((w) => ['bad', 'warn', 'ok'].includes(w.level)), 'a warning has no level for the UI to colour');
    near(eroding.liquidMonthsCover, 0, 0.01, 'cover on an empty cash bucket');
    const noSpendCover = m.buildPlan({ profile: { dateOfBirth: '1990-01-01', plannedRetirementAge: 60, lifeExpectancy: 90 }, assumptions, netWorthINR: 1000000, liquidAssetsINR: 500000, currentAge: 36 });
    check(noSpendCover.liquidMonthsCover === null, 'divide-by-zero on empty retirement spending');
    return `${noDob.warnings.length}/${noSpend.warnings.length}/${inverted.warnings.length}/${eroding.warnings.length} warnings raised`;
  });

  test('H8 A funded plan reports zero gap and no top-up', async () => {
    const m = await loadPlanning();
    const plan = m.buildPlan({
      profile: { dateOfBirth: '1990-01-01', plannedRetirementAge: 55, lifeExpectancy: 92, monthlyExpensesInRetirementINR: 250000, monthlyInvestableSurplusINR: 40000 },
      assumptions: { preRetirementReturnPct: 11, postRetirementReturnPct: 7, inflationPct: 6, salaryGrowthPct: 6, corpusBufferPct: 10 },
      netWorthINR: 400000000, liquidAssetsINR: 50000000, currentAge: 36,
    });
    check(plan.gapINR === 0, `gap ${plan.gapINR} on a fully funded plan`);
    check(plan.additionalMonthlyTopUpINR === 0, `top-up ${plan.additionalMonthlyTopUpINR}`);
    check(plan.progressPct === 100, `progress capped at ${plan.progressPct}`);
    check(plan.warnings.some((w) => /already covers/i.test(w.text)), 'no positive confirmation offered');
    check(plan.financiallyFreeAge === 36, `FIRE age ${plan.financiallyFreeAge} for someone already past the number`);
    near(m.monthlyTopUpFor(0, 19, 11, 6), 0, 0.01, 'top-up on no gap');
    near(m.monthlyTopUpFor(1000000, 0, 11, 6), 0, 0.01, 'top-up with no time to invest');
    return 'surplus plan asks for nothing';
  });

  // ---- I. API contract and regressions ------------------------------------
  group('I. API contract and regressions');

  test('I1 Profile saves apply: the route reads a flat body', async () => {
    await reset();
    const r = await api('PUT', '/api/profile', { fullName: 'Renamed Person', monthlyEmiINR: 75000, dateOfBirth: '1985-03-03' });
    check(r.status === 200, `status ${r.status}`);
    check(r.body.profile.fullName === 'Renamed Person', 'fullName not written (the wrapped-body regression)');
    check(r.body.profile.monthlyEmiINR === 75000, `EMI not written: ${r.body.profile.monthlyEmiINR}`);
    check(r.body.age === 41, `derived age ${r.body.age}`);
    const wrapped = await api('PUT', '/api/profile', { profile: { fullName: 'Should Not Stick' } });
    check(wrapped.body.profile.fullName === 'Renamed Person', 'a wrapped body silently wrote');
    await reset();
    return 'flat body honoured';
  });

  test('I2 Derived age tracks the date of birth and tolerates a blank one', async () => {
    await reset();
    let s = await state();
    check(s.age === 30, `fixture age ${s.age}`);
    await api('PUT', '/api/profile', { dateOfBirth: '' });
    s = await state();
    check(s.age === null, `blank DOB produced ${s.age}`);
    await api('PUT', '/api/profile', { dateOfBirth: 'nonsense' });
    s = await state();
    check(s.age === null, `garbage DOB produced ${s.age}`);
    check(s.profile.dateOfBirth === '', `garbage DOB was stored: ${s.profile.dateOfBirth}`);
    await reset();
    return 'null, not NaN';
  });

  test('I3 Impossible profile numbers are clamped or rejected, never stored', async () => {
    await reset();
    const r = await api('PUT', '/api/profile', { plannedRetirementAge: 58, lifeExpectancy: 88, dependants: 99, monthlyIncomeINR: -50000, monthlyEmiINR: 1e15, notes: 'x'.repeat(900) });
    check(r.status === 200, `a salvageable save returned ${r.status}: ${r.body.error}`);
    const p = r.body.profile;
    check(p.dependants === 20, `dependants ${p.dependants}`);
    check(p.monthlyIncomeINR === 0, `negative income ${p.monthlyIncomeINR}`);
    check(p.monthlyEmiINR === 1e12, `EMI clamped to ${p.monthlyEmiINR}`);
    check(p.notes.length === 400, `notes kept ${p.notes.length} chars`);
    check(p.plannedRetirementAge === 58 && p.lifeExpectancy === 88, `ages ${p.plannedRetirementAge}/${p.lifeExpectancy}`);
    const reversed = await api('PUT', '/api/profile', { plannedRetirementAge: 100, lifeExpectancy: 90 });
    check(reversed.status === 400, `retiring after dying returned ${reversed.status}`);
    check(/life expectancy/i.test(reversed.body.error || ''), `message: ${reversed.body.error}`);
    const outOfRange = await api('PUT', '/api/profile', { plannedRetirementAge: 200 });
    check(outOfRange.status === 400, `an unclampable age pair returned ${outOfRange.status}`);
    const s = await state();
    check(s.profile.plannedRetirementAge === 58, `a rejected save moved the profile to ${s.profile.plannedRetirementAge}`);
    check(s.profile.lifeExpectancy === 88, 'a rejected save moved life expectancy');
    await reset();
    return 'clamped, cross-checked, rejected writes kept out';
  });

  test('I4 Every /api response is marked no-store', async () => {
    const res = await fetch(`${BASE}/api/state`);
    check(res.headers.get('cache-control') === 'no-store', `cache-control: ${res.headers.get('cache-control')}`);
    const post = await api('POST', '/api/snapshot');
    check(post.body.holdings.length === 11, 'snapshot write disturbed the ledger');
    const asset = await fetch(`${BASE}/js/app.js`);
    check(asset.ok, `app.js fetch ${asset.status}`);
    check(asset.headers.get('cache-control') === 'no-cache', `static cache-control: ${asset.headers.get('cache-control')}`);
    const mod = await fetch(`${BASE}/js/planning.js`);
    check(mod.headers.get('cache-control') === 'no-cache', 'module cache not revalidated');
    return 'api no-store, assets revalidated';
  });

  test('I5 Unknown API routes 404 and the SPA fallback still serves', async () => {
    const nope = await fetch(`${BASE}/api/does-not-exist`);
    check(nope.status === 404, `unknown api ${nope.status}`);
    const spa = await fetch(`${BASE}/holdings`);
    check(spa.status === 200, `spa fallback ${spa.status}`);
    const html = await spa.text();
    check(/<div class="layout">/.test(html), 'index.html not served for deep links');
    const mod = await fetch(`${BASE}/js/views/goals.js`);
    check(mod.status === 200, `module fetch ${mod.status}`);
    const body = await mod.text();
    check(!/g\.link\.length/.test(body), 'the g.link regression is back');
    const badMethod = await fetch(`${BASE}/api/state`, { method: 'DELETE' });
    check(badMethod.status === 404, `DELETE /api/state returned ${badMethod.status}`);
    return 'routes and modules resolve';
  });

  test('I6 State exposes every field the views destructure', async () => {
    const s = await reset();
    const required = ['profile', 'settings', 'holdings', 'goals', 'rates', 'summary', 'snapshots', 'analysis', 'portfolioHealth', 'age', 'meta', 'fxDate'];
    const missing = required.filter((k) => !(k in s));
    check(missing.length === 0, `missing top-level keys: ${missing.join(', ')}`);
    const a = ['allocation', 'riskMix', 'concentration', 'geography', 'health'];
    check(a.every((k) => k in s.analysis), `analysis missing ${a.filter((k) => !(k in s.analysis))}`);
    check(Array.isArray(s.analysis.allocation.rows) && 'targetsComplete' in s.analysis.allocation, 'allocation contract changed');
    check(s.goals.every((g) => Array.isArray(g.linked) && 'progressPct' in g && 'status' in g), 'goal contract changed');
    check('costBasisCoveragePct' in s.analysis.health, 'health coverage field missing');
    check(s.fxDate === '2026-10-02', `fxDate ${s.fxDate}`);
    check(s.meta.dataFile.startsWith('test'), `meta.dataFile points at ${s.meta.dataFile}`);
    const h = s.holdings[0];
    for (const k of ['id', 'name', 'category', 'country', 'currency', 'nativeValue', 'valueINR', 'rate', 'rateSource', 'liquid', 'gainPct', 'taxStatus', 'yearsHeld']) {
      check(k in h, `holding row is missing ${k}`);
    }
    check(store.CATEGORIES.every((c) => s.meta.categoryLabels[c]), 'category label missing');
    return 'contract intact';
  });

  test('I7 Concurrent edits do not lose a write', async () => {
    await reset();
    const writes = await Promise.all([
      api('POST', '/api/holdings', { name: 'Race A', category: 'bank_account', currency: 'INR', country: 'IN', valueNative: 1000 }),
      api('POST', '/api/holdings', { name: 'Race B', category: 'bank_account', currency: 'INR', country: 'IN', valueNative: 2000 }),
      api('POST', '/api/holdings', { name: 'Race C', category: 'bank_account', currency: 'INR', country: 'IN', valueNative: 3000 }),
    ]);
    check(writes.every((w) => w.status === 201), 'a concurrent create failed');
    const s = await state();
    for (const n of ['Race A', 'Race B', 'Race C']) {
      check(s.holdings.some((h) => h.name === n), `${n} was lost`);
    }
    near(s.summary.totalAssetsINR, GROSS_ASSETS + 6000, 1, 'all three valued');
    await reset();
    return '3 of 3 persisted';
  });

  test('I8 Every front-end module parses as ESM and fixed regressions stay fixed', async () => {
    // An unterminated template literal once broke a whole view: the browser
    // fails the import silently and the tab renders empty. `node --check`
    // catches exactly that, and parses as a module when the file ends .mjs.
    const dir = path.join(__dirname, '.syntax');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const files = ['app.js', 'planning.js', 'charts.js', 'ui.js', 'api.js', 'format.js',
      ...fs.readdirSync(path.join(ROOT, 'public', 'js', 'views')).map((f) => path.join('views', f))];
    for (const f of files) {
      const shim = path.join(dir, f.replace(/[\\/]/g, '_').replace(/\.js$/, '.mjs'));
      fs.copyFileSync(path.join(ROOT, 'public', 'js', f), shim);
      const out = spawnSync(process.execPath, ['--check', shim], { encoding: 'utf8' });
      check(out.status === 0, `${f} does not parse: ${(out.stderr || '').split('\n')[0]}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    const styles = fs.readFileSync(path.join(ROOT, 'public', 'css', 'styles.css'), 'utf8');
    check(/\.bar-fill\s*\{[^}]*display:\s*block/.test(styles), 'the .bar-fill inline regression is back - progress bars would render empty');
    check(/\.field\[hidden\]\s*\{\s*display:\s*none/.test(styles), '.field has no [hidden] rule - its author display:flex beats the browser default and hidden fields would show');
    const allocationSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'allocation.js'), 'utf8');
    check(!/targetPct \?\? ''/.test(allocationSrc), 'cleared targets would render 0 again');
    const dashboardSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'dashboard.js'), 'utf8');
    check(/coveredCount === 1 \? '' : 's'/.test(dashboardSrc), 'singular/plural handling missing on the dashboard');
    const holdingsSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'holdings.js'), 'utf8');
    check(/FD_SKIP = \[[^\]]*'instrument'/.test(holdingsSrc), 'the deposit form no longer takes the ticker and per-unit boxes out');
    check(/fixed_deposit'\)\s*\{\s*form\.units = null;/.test(holdingsSrc), 'saving a deposit would keep inherited per-unit figures hidden in the form, which switches the quarterly accrual off');
    return `${files.length} modules parse, six fixed regressions hold`;
  });

  test('I9 The live ledger file is untouched by this run', async () => {
    const now = crypto.createHash('sha256').update(fs.readFileSync(LIVE_FILE)).digest('hex');
    check(now === LIVE_HASH_BEFORE, 'the live data file changed during testing');
    const s = fs.statSync(LIVE_FILE);
    return `sha ${now.slice(0, 12)} unchanged (${s.size} bytes)`;
  });

  test('I10 The holdings table is sectioned by asset type through tabs', async () => {
    // The pills replaced the class dropdown, so assert no second control writes
    // the same filter - two of them would disagree about what is on screen.
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'holdings.js'), 'utf8');
    check(/id="type-tabs"/.test(src), 'the tab host is missing from the toolbar');
    check(/function paintTabs\(/.test(src), 'nothing builds the per-type pills');
    check(/paintTabs\(ctx\.data\.holdings/.test(src), 'drawTable no longer repaints the tabs, so their counts would go stale');
    check(!/selectize\('f-category'/.test(src), 'the class dropdown is back - two controls writing filters.category');
    check(/oneType \? '' : '<th>Class<\/th>'/.test(src), 'the Class column no longer steps aside when one type is on screen');
    const styles = fs.readFileSync(path.join(ROOT, 'public', 'css', 'styles.css'), 'utf8');
    check(/\.tab\.is-active\s*\{/.test(styles), 'the selected tab has no style, so the section in view is invisible');
    return 'one pill per class, counts refreshed with the table, no duplicate class filter';
  });

  test('I11 Equity and bond rows are sectioned by the broker that holds them', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'holdings.js'), 'utf8');
    check(/BROKER_CLASSES = new Set\(\['equity', 'bond'\]\)/.test(src), 'the broker sections are not limited to the two classes bought through a broker');
    check(/BROKER_CLASSES\.has\(filters\.category\)/.test(src), 'no tab consults the broker classes, so nothing groups');
    check(/const name = String\(h\.institution \|\| ''\)\.trim\(\);[\s\S]{0,120}name\.toLowerCase\(\)/.test(src), 'brokers are not matched case-insensitively, so "Demo Brokers" and "DEMO BROKERS" would split into two sections');
    check(/NO_BROKER = '[^']+'/.test(src), 'a holding with no broker recorded has no section to fall into');
    check(/netINR: netINR\(g\.rows\)/.test(src), 'the section subtotal is not built by netINR, so a header could disagree with the table total');
    check(/if \(a\.listed !== b\.listed\) return a\.listed \? -1 : 1;/.test(src), 'the unlabelled bucket is not pinned last, so it would sort among the real brokers');
    check(/class="group-row"[^<]*<td colspan="\$\{cols\}"/.test(src), 'broker headers are not full-width rows, so they would look like a column of their own');
    check(/head\(g\) \+ g\.rows\.map\(\(h\) => row\(h, ctx, true\)\)/.test(src), 'rows are not emitted under their broker header');
    check(/grouped \? '' : h\.institution/.test(src), 'each row still repeats the broker its section header already names');
    check(/row\(h, ctx, grouped = false\)/.test(src), 'row() has no grouped parameter, so the ungrouped tabs would lose the broker line');
    const styles = fs.readFileSync(path.join(ROOT, 'public', 'css', 'styles.css'), 'utf8');
    check(/\.group-row td\s*\{/.test(styles), 'the broker header has no style, so it reads as another holding');
    return 'brokers section equity and bond only, bucketed case-insensitively, subtotalled by netINR and styled';
  });

  test('I12 The double-click launcher starts the app and never touches the ledger', async () => {
    // The only entry point a person who will not open a terminal needs, and it ships in
    // the published copy, so every branch that decides whether the app comes up is
    // asserted here as text. cmd is unforgiving about two things a normal editor does
    // silently, so both are checked: CRLF line endings and 7-bit ASCII.
    const bat = fs.readFileSync(path.join(ROOT, 'start-wealth-ledger.bat'), 'utf8');
    check(/^@echo off\r?\n/.test(bat), 'the launcher is not a batch file Windows will run');
    check(/cd \/d "%~dp0"/.test(bat), 'the launcher does not move into its own folder, so it would look for server.js wherever cmd happened to start');
    check(/where node\.exe/.test(bat), 'a machine without Node gets a window that closes before it can say so');
    check(/node_modules\\express\\package\.json/.test(bat) && /call npm install/.test(bat), 'a bare clone gets no first-run install, so the app would never start for anyone who only unzipped it');
    check(/call :probe[\s\S]{0,60}goto :open/.test(bat), 'nothing asks whether the port is already answering, so a second double-click would put a rival server on the same ledger file');
    check(/start "Wealth Ledger[^"]*" \/min cmd \/c "node server\.js"/.test(bat), 'the server is not left in a window of its own, so there is nothing obvious to close to stop the app');
    check(/ping -n 2 127\.0\.0\.1/.test(bat) && /if %TRIES% LSS 40/.test(bat), 'the launcher does not wait for the boot, which fetches rates before it listens');
    check(/start "" "%URL%"/.test(bat), 'the launcher never hands the address to the browser, which is the whole point of double-clicking');
    check(/:probe\r?\ncurl\.exe -s -o nul -m 2 "%URL%\/"/.test(bat), 'the probe does not ask the app its own root, so it would answer for any other server on the port');
    check(!/wealth-data|WEALTH_DATA_DIR|\/api\/reset|\/api\/import|\/api\/seed/.test(bat), 'the launcher reaches for the data file or a destructive route');
    check(!/[^\x00-\x7F]/.test(bat), 'non-ASCII bytes in a .bat print as mojibake under the console codepage');
    check(bat.includes('\r\n') && !/[^\r]\n/.test(bat), 'the launcher has bare LF lines - cmd can stop at a label when the file is not CRLF');
    return 'node, first-run deps, port probe, browser, and a window to close';
  });

  // ---- J. Market prices ----------------------------------------------------
  group('J. Market prices');

  const eqRow = (over = {}) => ({
    id: 'j', name: 'Row', category: 'equity', instrument: 'AAPL', country: 'US', currency: 'USD',
    units: 10, pricePerUnit: 100, valueNative: 1000, costNative: 500, acquiredOn: '2025-01-01',
    priceAuto: null, priceSymbol: null, priceAsOf: null, ...over,
  });
  const feedWith = (symbol, q) => ({ quotes: new Map([[symbol, q]]), errors: {} });

  test('J1 The exchange suffix follows the listing currency, not the country', () => {
    const cases = [
      [{ instrument: 'FICTX', country: 'SG', currency: 'USD' }, 'FICTX'],
      [{ instrument: 'C6L', country: 'SG', currency: 'SGD' }, 'C6L.SI'],
      [{ instrument: 'reliance', country: 'IN', currency: 'INR' }, 'RELIANCE.NS'],
      [{ instrument: 'CPALL', country: 'TH', currency: 'THB' }, 'CPALL.BK'],
      // An explicit suffix is the owner overriding the guess, so it is left alone.
      [{ instrument: 'DEMOBANK.BO', country: 'IN', currency: 'INR' }, 'DEMOBANK.BO'],
      [{ instrument: 'cpall.bk', country: 'TH', currency: 'THB' }, 'CPALL.BK'],
      // A US stock held via a Singapore broker must not be priced off SGX.
      [eqRow({ instrument: 'FICTX', country: 'SG', currency: 'USD' }), 'FICTX'],
    ];
    cases.forEach(([h, want]) => {
      const got = prices.resolveSymbol(h);
      check(got === want, `${h.instrument}/${h.currency} resolved to ${got}, expected ${want}`);
    });
    return `${cases.length} mappings correct`;
  });

  test('J2 Ticker text that is not a symbol is refused, never sent to the feed', () => {
    const junk = ['', '   ', 'GS 7.26% 2035', 'X;rm -rf /', 'TCS>>/tmp/x', '0', 'A'.repeat(40), '%%%', 'Nifty 50 Index'];
    junk.forEach((instrument) => {
      const got = prices.resolveSymbol(eqRow({ instrument }));
      check(got === null, `"${instrument}" resolved to ${JSON.stringify(got)}, expected null`);
    });
    check(!prices.isTrackable(eqRow({ instrument: 'not a ticker' })), 'a junk ticker was still classed trackable');
    return `${junk.length} rejected`;
  });

  test('J3 A pinned price survives every refresh', () => {
    const row = eqRow({ priceAuto: false, pricePerUnit: 999 });
    const r = prices.applyQuotes([row], feedWith('AAPL', { symbol: 'AAPL', price: 100, currency: 'USD', asOf: '2026-10-05' }));
    check(r.updated.length === 0, 'a pinned row was repriced');
    check(row.pricePerUnit === 999, `pinned price became ${row.pricePerUnit}`);
    check(r.skipped[0]?.reason === 'pinned', `skip reason was ${r.skipped[0]?.reason}`);
    return 'pinned row untouched';
  });

  test('J4 A feed priced in another currency is rejected, not converted', () => {
    // Bare VOD on Yahoo is the US ADR. Storing that against a GBP holding would
    // misstate the position by the whole ADR ratio.
    const row = eqRow({ instrument: 'VOD', country: 'GB', currency: 'GBP', pricePerUnit: 22.4 });
    const r = prices.applyQuotes([row], feedWith('VOD', { symbol: 'VOD', price: 333.4, currency: 'USD', asOf: '2026-10-05' }));
    check(r.updated.length === 0, 'a USD quote was written onto a GBP holding');
    check(row.pricePerUnit === 22.4, `GBP price became ${row.pricePerUnit}`);
    check(/feed says USD/.test(r.skipped[0].reason), `reason was ${r.skipped[0].reason}`);
    return 'currency mismatch blocked';
  });

  test('J5 An implausible jump is flagged for review instead of applied', () => {
    const row = eqRow({ pricePerUnit: 500 });
    const r = prices.applyQuotes([row], feedWith('AAPL', { symbol: 'AAPL', price: 100, currency: 'USD', asOf: '2026-10-05' }));
    check(r.updated.length === 0, 'an 80% move was applied silently');
    check(row.pricePerUnit === 500, 'the implausible price was written anyway');
    check(r.skipped[0].needsReview === true, 'the skip was not flagged for review');
    // A move just inside the tolerance does apply, so the guard cannot be a no-op.
    const ok = eqRow({ pricePerUnit: 100 });
    const r2 = prices.applyQuotes([ok], feedWith('AAPL', { symbol: 'AAPL', price: 140, currency: 'USD', asOf: '2026-10-05' }));
    check(r2.updated.length === 1 && ok.pricePerUnit === 140, 'a 40% move was blocked, so the tolerance is wrong');
    return '80% blocked, 40% applied';
  });

  test('J6 Classes without an exchange quote are never touched', () => {
    const rows = ['bond', 'policy', 'gold_commodity', 'fixed_deposit', 'real_estate', 'retirement_scheme']
      .map((category, i) => eqRow({ id: `n${i}`, category, instrument: 'AAPL' }));
    const before = rows.map((r) => r.pricePerUnit);
    const r = prices.applyQuotes(rows, feedWith('AAPL', { symbol: 'AAPL', price: 100, currency: 'USD', asOf: '2026-10-05' }));
    check(r.updated.length === 0, `a non-equity row was repriced: ${JSON.stringify(r.updated)}`);
    check(rows.every((row, i) => row.pricePerUnit === before[i]), 'a non-equity price changed');
    return '6 classes left alone';
  });

  test('J7 A reprice keeps units, cost basis and purchase date intact', () => {
    const row = eqRow({ units: 450, pricePerUnit: 105, costNative: 40000, acquiredOn: '2024-02-01' });
    prices.applyQuotes([row], feedWith('AAPL', { symbol: 'AAPL', price: 109.98, currency: 'USD', asOf: '2026-10-05' }));
    check(row.units === 450, `units became ${row.units}`);
    check(row.costNative === 40000, `cost basis became ${row.costNative}`);
    check(row.acquiredOn === '2024-02-01', `acquiredOn became ${row.acquiredOn}`);
    check(row.pricePerUnit === 109.98, `price became ${row.pricePerUnit}`);
    near(row.valueNative, 450 * 109.98, 0.01, 'valueNative recomputed');
    check(row.priceSymbol === 'AAPL' && row.priceAsOf === '2026-10-05', 'provenance was not recorded');
    return '450 @ 109.98, basis intact';
  });

  test('J8 The new price fields round-trip the store', () => {
    const stored = store.normalizeHolding({ name: 'X', category: 'equity', currency: 'USD', priceAuto: '0', priceSymbol: 'baba.si', priceAsOf: '2026-10-05' });
    check(stored.priceAuto === false, `priceAuto from the form came back as ${stored.priceAuto}`);
    check(stored.priceSymbol === 'FICTX.SI', `symbol came back as ${stored.priceSymbol}`);
    check(stored.priceAsOf === '2026-10-05', `asOf came back as ${stored.priceAsOf}`);
    // Absent must not read as false, or a partial edit would silently un-pin rows.
    const kept = store.normalizeHolding({ name: 'X' }, stored);
    check(kept.priceAuto === false, 'an edit that omitted priceAuto cleared the pin');
    const cleared = store.normalizeHolding({ priceAuto: null }, stored);
    check(cleared.priceAuto === null, `explicit null gave ${cleared.priceAuto}`);
    check(store.normalizeHolding({ priceAuto: 'maybe' }).priceAuto === null, 'junk did not become a pin');
    return 'pin kept, null cleared, junk ignored';
  });

  test('J9 The refresh route writes nothing when no holding is trackable', async () => {
    await reset();
    const file = path.join(SANDBOX, 'wealth-data.json');
    const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const r = await api('POST', '/api/prices/refresh', {});
    check(r.status === 200, `refresh returned ${r.status}`);
    check(r.body.priceResult.updated.length === 0, 'rows were repriced with no tickers present');
    check(/no holding has a ticker, a metal rate or a bond ISIN/.test(r.body.priceResult.note || ''), `note was ${JSON.stringify(r.body.priceResult.note)}`);
    const after = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    check(after === before, 'the ledger was rewritten by a refresh that changed nothing');
    return 'no tickers, no fetch, no write';
  });

  test('J10 State exposes the symbol each row would be priced under', async () => {
    await reset();
    const created = await api('POST', '/api/holdings', { name: 'Demo Brokers FICTX', category: 'equity', country: 'SG', currency: 'USD', instrument: 'FICTX', units: 450 });
    check(created.status === 201, `create returned ${created.status}`);
    const row = byId(created.body.holdings, created.body.holdings.find((h) => h.name === 'Demo Brokers FICTX').id);
    check(row.trackedSymbol === 'FICTX', `trackedSymbol was ${row.trackedSymbol}`);
    check(row.altSymbol === null, `a US listing was promised a second board: ${row.altSymbol}`);
    const inr = await api('POST', '/api/holdings', { name: 'Samplex', category: 'equity', country: 'IN', currency: 'INR', instrument: 'SAMPLEX', units: 100 });
    const inRow = inr.body.holdings.find((h) => h.name === 'Samplex');
    check(inRow.trackedSymbol === 'SAMPLEX.NS' && inRow.altSymbol === 'SAMPLEX.BO', `rupee row said ${inRow.trackedSymbol}/${inRow.altSymbol}`);
    const pinned = await api('PUT', `/api/holdings/${row.id}`, { priceAuto: '0' });
    const p = pinned.body.holdings.find((h) => h.id === row.id);
    check(p.priceAuto === false, 'the pin did not persist through the route');
    check(p.trackedSymbol === 'FICTX', 'a pinned row lost its resolved symbol');
    const scoped = await api('POST', '/api/prices/refresh', { ids: [row.id] });
    check(/pinned/.test(scoped.body.priceResult.note || ''), `a pinned-only scope said ${JSON.stringify(scoped.body.priceResult.note)}`);
    return 'USD FICTX -> FICTX, INR SAMPLEX -> .NS with .BO ready, pin respected';
  });

  test('J11 A rupee ticker has a second board to try, anything else has none', () => {
    const cases = [
      [{ instrument: 'SAMPLEX', currency: 'INR' }, 'SAMPLEX.BO'],
      [{ instrument: 'n sdl', currency: 'INR' }, null], // a space is not a symbol
      // The owner typed the suffix, so the board is their call, not a guess.
      [{ instrument: 'DEMOBANK.NS', currency: 'INR' }, null],
      [{ instrument: 'FICTX', currency: 'USD' }, null],
      [{ instrument: 'D05', currency: 'SGD' }, null],
      [{ instrument: 'CPALL', currency: 'THB' }, null],
    ];
    cases.forEach(([h, want]) => {
      const got = prices.alternateSymbol(eqRow(h));
      check(got === want, `${h.instrument}/${h.currency} alternate was ${got}, expected ${want}`);
    });
    const map = prices.alternatesFor([eqRow({ instrument: 'SAMPLEX', currency: 'INR' }), eqRow({ instrument: 'TATA', currency: 'USD' })]);
    check(map.size === 1 && map.get('SAMPLEX.NS') === 'SAMPLEX.BO', `alternatesFor built ${JSON.stringify([...map])}`);
    return `${cases.length} cases, one mapped for the batch`;
  });

  test('J12 A BSE-only listing prices itself when NSE prints nothing', async () => {
    const asked = [];
    // Yahoo answers the NSE board for TATA, has never heard of SAMPLEX.NS, and
    // prints SAMPLEX on the BSE one.
    const fake = async (symbol) => {
      asked.push(symbol);
      if (symbol === 'TATA.NS') return { symbol, price: 41.5, currency: 'INR', asOf: '2026-10-07' };
      if (symbol === 'SAMPLEX.BO') return { symbol, price: 96.4, currency: 'INR', asOf: '2026-10-07' };
      throw new Error(`no usable price for ${symbol}`);
    };
    const feed = await prices.fetchQuotes(['TATA.NS', 'SAMPLEX.NS'], {
      alternates: new Map([['SAMPLEX.NS', 'SAMPLEX.BO']]),
      fetchOne: fake,
    });
    check(feed.quotes.has('TATA.NS') && !asked.includes('TATA.BO'), 'a board that answered was re-asked of the other one');
    const hit = feed.quotes.get('SAMPLEX.NS');
    check(hit && hit.price === 96.4, 'the BSE quote did not land under the symbol the row asked for');
    check(hit.symbol === 'SAMPLEX.BO', `provenance said ${hit.symbol}, so the row would claim an NSE price`);
    check(!feed.errors['SAMPLEX.NS'], `the fallback was still reported as a miss: ${feed.errors['SAMPLEX.NS']}`);
    check(!feed.quotes.has('SAMPLEX.BO'), 'the alternate kept a stray key of its own');

    // Both boards silent: one reason, naming both, so the skip is explainable.
    const dead = await prices.fetchQuotes(['GHOST.NS'], {
      alternates: new Map([['GHOST.NS', 'GHOST.BO']]),
      fetchOne: async (s) => { throw new Error(`no usable price for ${s}`); },
    });
    check(/GHOST.NS/.test(dead.errors['GHOST.NS']) && /GHOST\.BO/.test(dead.errors['GHOST.NS']), `reason was ${dead.errors['GHOST.NS']}`);
    check(!('GHOST.BO' in dead.errors), 'the retried board reported a second, duplicate error');

    // A row that asked for BSE by name must not lose its entry to another row's retry.
    const both = await prices.fetchQuotes(['SAMPLEX.BO'], {
      alternates: new Map([['SAMPLEX.NS', 'SAMPLEX.BO']]),
      fetchOne: fake,
    });
    check(both.quotes.get('SAMPLEX.BO')?.price === 96.4, 'an explicitly requested board was consumed by a fallback');

    const row = eqRow({ instrument: 'SAMPLEX', country: 'IN', currency: 'INR', units: 100, pricePerUnit: null, valueNative: 0 });
    const r = prices.applyQuotes([row], { quotes: feed.quotes, errors: feed.errors });
    check(r.updated.length === 1 && row.pricePerUnit === 96.4, 'the fallback quote was not written in');
    check(row.priceSymbol === 'SAMPLEX.BO', `the row claims ${row.priceSymbol}`);
    near(row.valueNative, 9640, 0.01, 'the fallback price did not revalue the row');
    return 'NSE hit costs one request, NSE miss falls back to BSE';
  });

  test('J13 A board tagged onto the front of the ticker picks that board', () => {
    const cases = [
      [{ instrument: 'BSE:SAMPLEX', currency: 'INR' }, 'SAMPLEX.BO'],
      [{ instrument: 'bse: nsdl', currency: 'INR' }, 'NSDL.BO'],
      // The tag decides, not the currency guess: an NSE tag on a dollar row
      // still reads the NSE board it names.
      [{ instrument: 'NSE:TCS', currency: 'INR' }, 'TCS.NS'],
      [{ instrument: 'BSE:WIDGET', currency: 'USD' }, 'WIDGET.BO'],
      // A tag we don't know is decoration: the ticker still gets the currency suffix.
      [{ instrument: 'MCX:GOLDDEMO', currency: 'INR' }, 'GOLDDEMO.NS'],
      [{ instrument: 'BSE:', currency: 'INR' }, null], // nothing behind the tag
      [{ instrument: 'BSE:n s dl', currency: 'INR' }, null],
    ];
    cases.forEach(([h, want]) => {
      const got = prices.resolveSymbol(eqRow(h));
      check(got === want, `${h.instrument}/${h.currency} resolved to ${got}, expected ${want}`);
    });
    // Naming the board is the owner's call, so there is no second one to try.
    check(prices.alternateSymbol(eqRow({ instrument: 'BSE:SAMPLEX', currency: 'INR' })) === null, 'a BSE-tagged row was still offered NSE');
    check(prices.alternateSymbol(eqRow({ instrument: 'MCX:GOLDDEMO', currency: 'INR' })) === 'GOLDDEMO.BO', 'an unknown tag cancelled the fallback too');
    check(prices.isTrackable(eqRow({ instrument: 'BSE:SAMPLEX', currency: 'INR' })) === true, 'a tagged row was left out of the batch entirely');
    return `${cases.length} cases, tagged rows off the retry list`;
  });

  // ---- K. Bullion rates ----------------------------------------------------
  group('K. Bullion rates');

  const CARD = { gold22: 13675, gold24: 14918, silver: 245, asOf: '2026-10-05' };
  const metalRow = (over = {}) => ({
    id: 'k', name: 'Gold chain', category: 'gold_commodity', country: 'IN', currency: 'INR',
    units: 20, pricePerUnit: 13000, valueNative: 260000, costNative: 200000, acquiredOn: '2024-02-02',
    metalRate: 'gold22', priceAuto: null, priceSymbol: null, priceAsOf: null, ...over,
  });

  test('K1 The captured rate page yields per-gram figures for 22K, 24K and silver', () => {
    const r = metals.parseRates(METAL_PAGE);
    check(r.gold22 === 13675, `22K per gram was ${r.gold22}`);
    check(r.gold24 === 14918, `24K per gram was ${r.gold24}`);
    check(r.silver === 245, `silver per gram was ${r.silver}`);
    check(r.asOf === '2026-10-05', `rate date was ${r.asOf}`);
    return '22K 13,675 · 24K 14,918 · silver 245 · 2026-10-05';
  });

  test('K2 A page that changed shape is rejected, never guessed at', () => {
    const swapped = METAL_PAGE.replace(
      '<td class=""><i class="fa fa-inr"></i> 14,918</td><td><i class="fa fa-inr"></i> 119,344</td>',
      '<td class=""><i class="fa fa-inr"></i> 119,344</td><td><i class="fa fa-inr"></i> 14,918</td>'
    );
    check(swapped !== METAL_PAGE, 'the fixture no longer carries the column pair to swap');
    let caught = '';
    try { metals.parseRates(swapped); } catch (err) { caught = err.message; }
    check(/layout/.test(caught), `reordered columns gave "${caught || 'no error'}"`);
    try { metals.parseRates('<html><body>redesigned</body></html>'); check(false, 'a page with no rate table parsed'); }
    catch (err) { check(/no gold rate table/.test(err.message), `missing table said "${err.message}"`); }
    return 'reordered columns and a missing table both refused';
  });

  test('K3 An opted-in gold row prices as grams times the per-gram rate', () => {
    const row = metalRow();
    const r = metals.applyRates([row], CARD);
    check(r.updated.length === 1, 'the row was not repriced');
    check(row.pricePerUnit === 13675, `price became ${row.pricePerUnit}`);
    check(row.valueNative === 273500, `20 g valued at ${row.valueNative}`);
    check(row.priceSymbol === '22K GOLD/G', `tag was ${row.priceSymbol}`);
    check(row.priceAsOf === '2026-10-05', `as-of was ${row.priceAsOf}`);
    check(row.costNative === 200000 && row.acquiredOn === '2024-02-02', 'cost basis or date moved');
    return '20 g x 13,675 = 2,73,500, basis intact';
  });

  test('K4 A row only joins the bullion feed by choosing it', () => {
    const manual = metalRow({ metalRate: null });
    const stale = metalRow({ id: 'k2', category: 'bank_account', metalRate: 'silver' });
    const sg = metalRow({ id: 'k3', metalRate: null, instrument: 'NIFTYGOLD', units: 5 });
    const r = metals.applyRates([manual, stale, sg], CARD);
    check(r.updated.length === 0, 'a row that never opted in was repriced');
    check(manual.pricePerUnit === 13000, 'a manual gold row was overwritten');
    check(stale.pricePerUnit === 13000, 'a bank row was priced off the gold card');
    check(sg.pricePerUnit === 13000, 'an SGB-style row was repriced per gram');
    return 'manual, wrong-class and untagged rows left alone';
  });

  test('K5 A rupee-per-gram rate is refused on a row held in another currency', () => {
    const row = metalRow({ currency: 'USD' });
    const r = metals.applyRates([row], CARD);
    check(r.updated.length === 0, 'a USD row took an INR per-gram price');
    check(/INR per gram/.test(r.skipped[0].reason), `reason was ${r.skipped[0].reason}`);
    check(row.pricePerUnit === 13000, 'the price moved anyway');
    return 'USD gold row skipped, not converted';
  });

  test('K6 A metal row with no grams keeps the total the owner typed', () => {
    const row = metalRow({ units: null, valueNative: 2500000 });
    const r = metals.applyRates([row], CARD);
    check(r.updated.length === 0, 'a row with no quantity was repriced');
    check(/grams/.test(r.skipped[0].reason), `reason was ${r.skipped[0].reason}`);
    check(row.valueNative === 2500000, `the hand-entered total became ${row.valueNative}`);
    return 'no grams, no write';
  });

  test('K7 A quarter-day jump is held back, a purity switch is applied', () => {
    const jumped = metalRow({ pricePerUnit: 10000 });
    const r1 = metals.applyRates([jumped], CARD);
    check(r1.skipped[0]?.needsReview === true, 'a 36% jump was applied without review');
    check(jumped.pricePerUnit === 10000, 'the implausible rate was written');
    const upgraded = metalRow({ pricePerUnit: 13675, metalRate: 'gold24' });
    const r2 = metals.applyRates([upgraded], CARD);
    check(r2.updated.length === 1 && upgraded.pricePerUnit === 14918, 'switching 22K to 24K was blocked as a jump');
    check(upgraded.priceSymbol === '24K GOLD/G', `tag was ${upgraded.priceSymbol}`);
    return '36% blocked, 9% purity switch applied';
  });

  test('K8 metalRate round-trips the store', () => {
    const stored = store.normalizeHolding({ name: 'X', category: 'gold_commodity', metalRate: 'GOLD24' });
    check(stored.metalRate === 'gold24', `came back as ${stored.metalRate}`);
    check(store.normalizeHolding({ metalRate: 'platinum' }).metalRate === null, 'an unknown rate was accepted');
    const kept = store.normalizeHolding({}, stored);
    check(kept.metalRate === 'gold24', 'an edit that omitted the field cleared it');
    check(store.normalizeHolding({ metalRate: '' }, stored).metalRate === null, 'choosing Manual did not clear it');
    return 'case folded, junk dropped, absent kept, blank clears';
  });

  test('K9 The refresh route prices a gold row from the rate site, onto disk', async () => {
    await reset();
    const created = await api('POST', '/api/holdings', { name: 'Gold chain 22K', category: 'gold_commodity', country: 'IN', currency: 'INR', units: 20, metalRate: 'gold22' });
    check(created.status === 201, `create returned ${created.status}`);
    const id = created.body.holdings.find((h) => h.name === 'Gold chain 22K').id;
    const r = await api('POST', '/api/prices/refresh', {});
    check(r.status === 200, `refresh returned ${r.status}: ${r.text.slice(0, 180)}`);
    const row = byId(r.body.holdings, id);
    check(row.pricePerUnit === 13675, `route priced it at ${row.pricePerUnit}`);
    check(row.valueINR === 273500, `INR value was ${row.valueINR}`);
    check(row.priceSymbol === '22K GOLD/G', `tag was ${row.priceSymbol}`);
    check(r.body.meta.metalRates.gold24 === 14918, 'the fetched card was not exposed in state');
    const doc = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'wealth-data.json'), 'utf8'));
    check(doc.holdings.find((h) => h.id === id).pricePerUnit === 13675, 'the ledger file was not updated');
    check(doc.metalRates?.asOf === '2026-10-05', 'the card was not cached in the file');
    return 'fetched, priced and persisted: 20 g at 13,675';
  });

  test('K10 A dead rate site fails loudly and writes nothing', async () => {
    await reset();
    const created = await api('POST', '/api/holdings', { name: 'Silver bar', category: 'gold_commodity', country: 'IN', currency: 'INR', units: 100, metalRate: 'silver' });
    const id = created.body.holdings.find((h) => h.name === 'Silver bar').id;
    const file = path.join(SANDBOX, 'wealth-data.json');
    const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    metalPage = '<html><body>the site was redesigned</body></html>';
    try {
      const r = await api('POST', '/api/prices/refresh', {});
      check(r.status === 502, `a dead feed returned ${r.status}`);
      check(/no gold rate table/.test((r.body.priceResult.errors || []).join(' ')), `errors were ${JSON.stringify(r.body.priceResult.errors)}`);
      check(r.body.priceResult.updated.length === 0, 'rows were updated by a failed fetch');
      check(byId(r.body.holdings, id).pricePerUnit === null, 'a row was priced off a page with no rates');
      const after = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      check(after === before, 'the ledger was rewritten after the feed failed');
      return '502, no write, no invented price';
    } finally {
      metalPage = METAL_PAGE;
    }
  });

  test('K11 Switching a row to another metal re-prices it; the old metal is not the baseline', async () => {
    await reset();
    const created = await api('POST', '/api/holdings', { name: 'Chain', category: 'gold_commodity', country: 'IN', currency: 'INR', units: 20, metalRate: 'gold22' });
    const id = created.body.holdings.find((h) => h.name === 'Chain').id;
    await api('POST', '/api/prices/refresh', {});
    const switched = await api('PUT', `/api/holdings/${id}`, { metalRate: 'silver' });
    check(byId(switched.body.holdings, id).pricePerUnit === 13675, 'the switch itself repriced the row');
    const r = await api('POST', '/api/prices/refresh', {});
    const row = byId(r.body.holdings, id);
    check(row.pricePerUnit === 245, `silver was held back as a jump: ${row.pricePerUnit}`);
    check(row.priceSymbol === 'SILVER/G', `tag was ${row.priceSymbol}`);
    check(row.valueNative === 4900, `20 g of silver valued at ${row.valueNative}`);
    await api('DELETE', `/api/holdings/${id}`);
    return 'gold to silver is a change of metal, not a 98% crash';
  });

  group('L. Fixed deposits');

  test('L1 A term round-trips the store and derives the maturity date', () => {
    const h = store.normalizeHolding({ category: 'fixed_deposit', name: 'FD', termMonths: 18, acquiredOn: '2025-01-31' }, null);
    check(h.termMonths === 18, `term became ${h.termMonths}`);
    check(h.maturityDate === '2026-07-31', `18 months from 2025-01-31 gave ${h.maturityDate}`);
    const one = store.normalizeHolding({ termMonths: 1 }, h);
    check(one.maturityDate === '2025-02-28', `month-end clamp gave ${one.maturityDate}`);
    check(store.normalizeHolding({ termMonths: 'abc' }, h).termMonths === null, 'a junk term survived');
    check(store.normalizeHolding({ termMonths: '' }, h).termMonths === null, 'a blank term did not clear');
    check(store.normalizeHolding({}, h).termMonths === 18, 'an absent term dropped the stored one');
    check(store.normalizeHolding({ termMonths: 900 }, h).termMonths === 600, 'an absurd term was not clamped');
    return '18 mo from 31 Jan 2025 matures 31 Jul 2026, clamps to 28 Feb, junk clears';
  });

  test('L2 A deposit accrues quarterly from its date and stops at maturity', () => {
    const today = new Date('2026-10-06T00:00:00Z');
    const fd = { category: 'fixed_deposit', valueNative: 1000000, interestRatePct: 8, termMonths: 12, acquiredOn: '2025-10-06', maturityDate: '2026-10-06' };
    const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
    const grow = (n) => 1000000 * (1 + 8 / 400) ** (4 * n / 365.25);
    near(valuation.fdAccrued(fd, today), grow(days('2025-10-06', '2026-10-06')), 0.01, 'a full year at 8% compounded quarterly');
    near(valuation.fdAccrued({ ...fd, acquiredOn: '2026-04-06', maturityDate: '2027-04-06' }, today), grow(days('2026-04-06', '2026-10-06')), 0.01, 'half a year');
    near(valuation.fdAccrued({ ...fd, acquiredOn: '2020-01-01', maturityDate: '2021-01-01' }, today), grow(days('2020-01-01', '2021-01-01')), 0.01, 'a matured FD stops at its maturity value');
    near(valuation.fdAccrued({ ...fd, acquiredOn: '2027-01-01', maturityDate: '2028-01-01' }, today), 1000000, 0.01, 'a deposit not yet made');
    return '8% p.a. = 1.02 per quarter, capped once matured';
  });

  test('L3 The state payload values an FD at its accrual and keeps the principal editable', async () => {
    const created = await api('POST', '/api/holdings', {
      name: 'TEST FD', category: 'fixed_deposit', country: 'IN', currency: 'INR',
      valueNative: 500000, interestRatePct: 7.5, acquiredOn: '2025-10-06', termMonths: 24,
    });
    check(created.status === 201, `create returned ${created.status}: ${created.text.slice(0, 120)}`);
    const rec = created.body.holdings.find((h) => h.name === 'TEST FD');
    check(rec.maturityDate === '2027-10-06', `maturity became ${rec.maturityDate}`);
    check(rec.fdPrincipal === 500000, `fdPrincipal became ${rec.fdPrincipal}`);
    check(rec.nativeValue > 500000 && rec.nativeValue < 580000, `accrued value ${rec.nativeValue}`);
    // The form posts fdPrincipal back as the total value; doing that twice must
    // not stack a year of interest onto last year's accrued figure.
    const upd = await api('PUT', `/api/holdings/${rec.id}`, {
      name: 'TEST FD', category: 'fixed_deposit', country: 'IN', currency: 'INR',
      valueNative: rec.fdPrincipal, interestRatePct: 7.5, acquiredOn: '2025-10-06', termMonths: 24,
    });
    const rec2 = upd.body.holdings.find((h) => h.id === rec.id);
    check(rec2.nativeValue === rec.nativeValue, `re-saving compounded: ${rec.nativeValue} -> ${rec2.nativeValue}`);
    await api('DELETE', `/api/holdings/${rec.id}`);
    return `5,00,000 at 7.5% accrued to ${rec.nativeValue}, matures ${rec.maturityDate}`;
  });

  test('L4 Without a rate, a term, a date - or with units - a deposit stays manual', () => {
    const today = new Date('2026-10-06T00:00:00Z');
    const base = { category: 'fixed_deposit', valueNative: 100000 };
    check(valuation.fdAccrued({ ...base, termMonths: 12, acquiredOn: '2025-01-01' }, today) === null, 'a rate-less row accrued');
    check(valuation.fdAccrued({ ...base, interestRatePct: 7, acquiredOn: '2025-01-01' }, today) === null, 'a term-less row accrued');
    check(valuation.fdAccrued({ ...base, interestRatePct: 7, termMonths: 12 }, today) === null, 'a date-less row accrued');
    check(valuation.fdAccrued({ ...base, units: 1, pricePerUnit: 100000, interestRatePct: 7, termMonths: 12, acquiredOn: '2025-01-01' }, today) === null, 'a units row accrued');
    check(valuation.fdAccrued({ ...base, category: 'bank_account', interestRatePct: 7, termMonths: 12, acquiredOn: '2025-01-01' }, today) === null, 'another class accrued');
    const row = store.normalizeHolding({ category: 'fixed_deposit', currency: 'INR', valueNative: 100000 }, null);
    const e = valuation.enrich({ settings: { fx: { INR: { liveRate: 1, asOf: '2026-10-02' } } }, holdings: [row] }, today).holdings[0];
    check(e.nativeValue === 100000 && e.fdPrincipal === undefined, `a plain FD moved: ${e.nativeValue}/${e.fdPrincipal}`);
    return 'rate, term, date, units and class all gate the accrual';
  });

  test('L5 An existing deposit without a term keeps the value its owner entered', async () => {
    const st = await api('GET', '/api/state');
    const fd = st.body.holdings.find((h) => h.id === 'h_fd');
    check(fd.nativeValue === 1000000, `the fixture FD moved to ${fd.nativeValue}`);
    check(fd.maturityDate === '2027-06-30', `the fixture maturity moved to ${fd.maturityDate}`);
    check(fd.fdPrincipal === undefined, 'a non-accruing row gained fdPrincipal');
    return '10,00,000 and 2027-06-30 untouched';
  });

  test('L6 Renewal walks the maturity forward to the term now running', () => {
    // Fixed "today" for the walk: 2026-10-06, so a 12-month term from June 2024
    // has matured twice already.
    const today = '2026-10-06';
    const input = { category: 'fixed_deposit', name: 'FD', currency: 'INR', valueNative: 1000000, interestRatePct: 8, termMonths: 12, acquiredOn: '2024-06-01' };
    const off = store.normalizeHolding(input, null);
    check(off.fdAutoRenew === false, `the switch defaulted to ${off.fdAutoRenew}`);
    check(off.maturityDate === '2025-06-01', `a deposit that does not renew was moved to ${off.maturityDate}`);
    check(store.currentMaturity('2024-06-01', 12, true, '2026-05-01') === '2026-06-01', 'one renewal from June 2024 is not June 2026');
    const on = store.normalizeHolding({ ...input, fdAutoRenew: '1' }, null);
    check(on.fdAutoRenew === true, `a posted '1' did not read as yes (${on.fdAutoRenew})`);
    const rolled = store.currentMaturity(on.acquiredOn, on.termMonths, true, today);
    check(rolled === '2027-06-01', `the running term ends ${rolled}, not 2027-06-01`);
    // Still inside the first term, renewal changes nothing.
    check(store.currentMaturity('2026-06-01', 12, true, today) === '2027-06-01', 'a fresh deposit was rolled forward early');
    // Absent from a later write, the stored yes stays yes.
    check(store.normalizeHolding({ name: 'FD' }, on).fdAutoRenew === true, 'an absent switch cleared a stored renewal');
    check(store.normalizeHolding({ fdAutoRenew: '' }, on).fdAutoRenew === false, 'a blank switch did not renew the deposit');
    return `2024-06-01 + 12 mo renews to ${rolled}`;
  });

  test('L7 A renewing deposit compounds through every renewal', () => {
    const today = new Date('2026-10-06T00:00:00Z');
    const base = { category: 'fixed_deposit', valueNative: 1000000, interestRatePct: 8, termMonths: 12, acquiredOn: '2024-06-01' };
    const stopped = valuation.fdAccrued({ ...base, maturityDate: '2025-06-01' }, today);
    // The owner's own row, run through the store so the maturity is the current
    // term's, is what the accrual should read.
    const row = store.normalizeHolding({ ...base, name: 'FD', fdAutoRenew: '1' }, null);
    const renewing = valuation.fdAccrued(row, today);
    check(renewing > stopped * 1.1, `renewing gave ${renewing} against a stopped ${stopped}`);
    // Rolling term by term - each term's closing balance being the next one's
    // principal - must give the same figure, or the value is inventing interest.
    const quarter = 1 + 8 / 400;
    let balance = 1000000;
    let start = '2024-06-01';
    for (let term = 0; term < 2; term += 1) {
      const end = store.currentMaturity(start, 12, false, '2099-01-01');
      const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
      balance *= quarter ** (4 * days / 365.25);
      start = end;
    }
    const left = (Date.parse('2026-10-06T00:00:00Z') - Date.parse(`${start}T00:00:00Z`)) / 86400000;
    near(renewing, balance * quarter ** (4 * left / 365.25), 0.02, 'rolling two terms then part of a third');
    // A deposit whose term has not ended yet is identical either way.
    const fresh = { ...base, acquiredOn: '2026-01-01', maturityDate: '2027-01-01' };
    near(valuation.fdAccrued(fresh, today), valuation.fdAccrued({ ...fresh, fdAutoRenew: true }, today), 0.01, 'renewal changed a live term');
    // Renewal is not a licence to price a deposit that has nothing to renew with.
    check(valuation.fdAccrued({ ...base, fdAutoRenew: true, interestRatePct: null }, today) === null, 'a rate-less row renewed into a number');
    check(valuation.fdAccrued({ ...base, fdAutoRenew: true, termMonths: null }, today) === null, 'a term-less row invented one');
    return `two renewals carried ₹10 L to ${Math.round(renewing)}`;
  });

  test('L8 The switch round-trips the API and revalues a long-matured deposit', async () => {
    const created = await api('POST', '/api/holdings', {
      name: 'TEST RENEWING FD', category: 'fixed_deposit', country: 'IN', currency: 'INR',
      valueNative: 1000000, interestRatePct: 8, acquiredOn: '2020-01-01', termMonths: 12, fdAutoRenew: '1',
    });
    check(created.status === 201, `create returned ${created.status}`);
    const rec = created.body.holdings.find((h) => h.name === 'TEST RENEWING FD');
    check(rec.fdAutoRenew === true, `stored as ${rec.fdAutoRenew}`);
    const iso = new Date().toISOString().slice(0, 10);
    check(rec.maturityDate > iso, `a renewing deposit still shows a finished maturity (${rec.maturityDate})`);
    check(rec.maturityDate.slice(5) === '01-01', `rolling a 1 January deposit drifted to ${rec.maturityDate}`);
    check(rec.nativeValue > 1600000, `₹10 L at 8% since 2020 read ${rec.nativeValue}`);
    // The interest paid out on withdrawal is not what this models, so turning
    // the switch back off must drop the row to its first term's maturity value.
    const off = await api('PUT', `/api/holdings/${rec.id}`, { fdAutoRenew: '0' });
    const stopped = off.body.holdings.find((h) => h.id === rec.id);
    check(stopped.fdAutoRenew === false, 'the switch did not come back off');
    check(stopped.maturityDate === '2021-01-01', `switched off, maturity read ${stopped.maturityDate}`);
    check(stopped.nativeValue < 1100000 && stopped.nativeValue > 1070000, `one year at 8% gave ${stopped.nativeValue}`);
    // A deposit is the only class that renews; the form's hidden box must not
    // leave a yes sitting on a savings account.
    const bank = await api('POST', '/api/holdings', {
      name: 'TEST Savings', category: 'bank_account', country: 'IN', currency: 'INR', valueNative: 50000, fdAutoRenew: '1',
    });
    const b = bank.body.holdings.find((h) => h.name === 'TEST Savings');
    check(b.fdAutoRenew === false || b.fdAutoRenew === null, `a savings account took renewal (${b.fdAutoRenew})`);
    await api('DELETE', `/api/holdings/${rec.id}`);
    await api('DELETE', `/api/holdings/${b.id}`);
    return `₹10 L since 2020 grew to ${rec.nativeValue}, back to ${stopped.nativeValue} when switched off`;
  });

  test('L9 The deposit form carries the switch and the table reads a rolling deposit', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'holdings.js'), 'utf8');
    const fields = /data-fd-fields[\s\S]{0,700}fdAutoRenew[\s\S]{0,400}termMonths/.test(src)
      || /termMonths[\s\S]{0,400}fdAutoRenew/.test(src);
    check(fields, 'the renewal switch is not in the deposit field-set');
    check(/fdRenewalHint\(rec\)/.test(src), 'the switch has no explanation next to it');
    check(/h\.fdAutoRenew \? 'renewing · next' : 'accrued · matures'/.test(src), 'the table does not tell a rolling deposit from a finished one');
    check(/Edit the rate when your bank gives you a new one/.test(src), 'nothing tells the owner that a renewal reuses the row\'s own rate');
    return 'the box, its hint and the table tag are all wired';
  });

  group('M. India income and tax');

  const M_TODAY = new Date('2026-10-06T00:00:00Z');
  const M_FX = {
    INR: { liveRate: 1, asOf: '2026-10-02', fetchedAt: '2026-10-02T00:00:00Z' },
    USD: { liveRate: R.USD, asOf: '2026-10-02', fetchedAt: '2026-10-02T00:00:00Z' },
    THB: { liveRate: R.THB, asOf: '2026-10-02', fetchedAt: '2026-10-02T00:00:00Z' },
  };

  // The engine reads valued rows, so a report is assembled exactly the way the
  // server assembles one: normalise, enrich through the FX table, then accrue.
  function taxReport(rows, over = {}) {
    const base = store.blankDb();
    const db = {
      settings: { fx: M_FX, assumptions: base.settings.assumptions, tax: { ...base.settings.tax, ...(over.tax || {}) } },
      profile: { dateOfBirth: over.dob ?? '1996-06-15', monthlyIncomeINR: over.monthlySalary ?? 0 },
      holdings: rows.map((r) => store.normalizeHolding({ name: 'row', category: 'other_asset', country: 'IN', currency: 'INR', ...r }, null)),
    };
    const { holdings } = valuation.enrich(db, M_TODAY);
    return income.summarise({ holdings, profile: db.profile, settings: db.settings, today: M_TODAY });
  }

  const lineFor = (rep, name) => rep.lines.find((l) => l.name === name);

  test('M1 The financial year runs 1 April to 31 March', () => {
    const oct = income.financialYear(M_TODAY);
    check(oct.label === 'FY 2026-27', `October gave ${oct.label}`);
    check(oct.startISO === '2026-04-01' && oct.endISO === '2027-03-31', `window ${oct.startISO}..${oct.endISO}`);
    check(oct.totalDays === 365, `${oct.totalDays} days in the window`);
    check(income.financialYear(new Date('2027-01-10T00:00:00Z')).label === 'FY 2026-27', 'January rolled into the next year');
    check(income.financialYear(new Date('2026-04-01T00:00:00Z')).elapsedDays === 1, 'the opening day is not day one');
    const last = income.financialYear(new Date('2027-03-31T00:00:00Z'));
    check(last.elapsedDays === last.totalDays && last.fraction === 1, `the closing day read ${last.elapsedDays}/${last.totalDays}`);
    check(income.financialYear(new Date('2026-10-06T18:00:00Z')).elapsedDays === 189, 'a reading after noon UTC counted an extra day');
    return 'FY 2026-27 spans 365 days; 1 Apr is day 1, 31 Mar is the whole year, and the time of day does not move it';
  });

  test('M2 Only Indian earning rows accrue, and only the classes that pay', () => {
    const rep = taxReport([
      { name: 'IN bank', category: 'bank_account', interestRatePct: 3, valueNative: 1000000 },
      { name: 'TH bank', category: 'bank_account', country: 'TH', currency: 'THB', interestRatePct: 3, valueNative: 100000 },
      { name: 'IN loan', category: 'liability', interestRatePct: 9, valueNative: 500000 },
      { name: 'IN flat', category: 'real_estate', interestRatePct: 8, valueNative: 5000000 },
      { name: 'IN equity no yield', category: 'equity', units: 100, pricePerUnit: 1000 },
      { name: 'IN bond', category: 'bond', interestRatePct: 7, valueNative: 100000 },
      { name: 'IN cash no rate', category: 'bank_account', valueNative: 50000 },
    ]);
    check(rep.lines.length === 2, `expected two income lines, got ${rep.lines.map((l) => l.name).join(', ')}`);
    check(rep.totals.holdingCount === 2, 'the line count disagrees with the totals');
    near(lineFor(rep, 'IN bank').incomeINR.full, 30000, 0.01, 'a year of 3% on ten lakh');
    near(lineFor(rep, 'IN bank').incomeINR.ytd, 30000 * income.financialYear(M_TODAY).fraction, 1, 'to date pro-rates the year');
    check(!lineFor(rep, 'IN bond').unconverted, 'an INR row reported itself unconverted');
    check(rep.skipped.length === 0, `a rate-less row was announced as skipped: ${JSON.stringify(rep.skipped)}`);
    return 'a Thai deposit, a liability, a flat and a rate-less row all stay out';
  });

  test('M3 An NRE or FCNR row reads as exempt, an NRO row as taxable', () => {
    const rep = taxReport([
      { name: 'Sample Bank NRE Savings', category: 'bank_account', interestRatePct: 3, valueNative: 1000000 },
      { name: 'Example Bank NRO Savings', category: 'bank_account', interestRatePct: 3, valueNative: 1000000 },
      { name: 'Demo Bank Savings', category: 'bank_account', interestRatePct: 3, valueNative: 1000000 },
      { name: 'FCNR(B) deposit', category: 'fixed_deposit', currency: 'USD', interestRatePct: 5, valueNative: 10000 },
      { name: 'NRO but elected', category: 'bank_account', interestRatePct: 3, valueNative: 1000000, indianTax: 'exempt' },
      { name: 'PPF', category: 'retirement_scheme', interestRatePct: 7.1, valueNative: 800000 },
    ]);
    check(lineFor(rep, 'Sample Bank NRE Savings').treatment === 'exempt', 'an NRE account was taxed');
    check(lineFor(rep, 'FCNR(B) deposit').treatment === 'exempt', 'an FCNR deposit was taxed');
    near(lineFor(rep, 'FCNR(B) deposit').incomeINR.full, 500 * R.USD, 0.01, 'a dollar deposit converts at the ledger rate');
    check(lineFor(rep, 'Example Bank NRO Savings').treatment === 'taxable', 'an NRO account went untaxed');
    check(lineFor(rep, 'Demo Bank Savings').treatment === 'taxable', 'a plain savings account escaped the slab base');
    check(lineFor(rep, 'NRO but elected').treatment === 'exempt', 'the per-row override was ignored');
    check(lineFor(rep, 'PPF').treatment === 'deferred', 'a small-savings accrual was taxed in the year it grew');
    check(lineFor(rep, 'PPF').tdsPct === 0, 'TDS was cut on a small-savings accrual');
    check(rep.lines.filter((l) => l.treatment === 'taxable').length === 2, 'exactly two lines should reach the slab base');
    near(rep.totals.deferredProjectedINR, 56800, 0.01, 'the deferred pool');
    return 'NRE and FCNR escape, NRO and plain savings are taxed, EPF-type rows wait';
  });

  test('M4 A deposit accrues its own curve inside the year', () => {
    const grow = (days) => 1000000 * (1 + 8 / 400) ** (4 * days / 365.25);
    const days = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
    const rep = taxReport([
      { name: 'Opened with the year', category: 'fixed_deposit', interestRatePct: 8, valueNative: 1000000, acquiredOn: '2026-04-01', termMonths: 24 },
      { name: 'Opened mid-year', category: 'fixed_deposit', interestRatePct: 8, valueNative: 1000000, acquiredOn: '2026-08-01', termMonths: 24 },
      { name: 'Matured years ago', category: 'fixed_deposit', interestRatePct: 8, valueNative: 1000000, acquiredOn: '2020-01-01', termMonths: 12 },
    ]);
    near(lineFor(rep, 'Opened with the year').incomeINR.full, grow(days('2026-04-01', '2027-03-31')) - 1000000, 1, 'a year of quarterly interest');
    near(lineFor(rep, 'Opened with the year').incomeINR.ytd, grow(days('2026-04-01', '2026-10-06')) - 1000000, 1, 'accrued to today');
    near(lineFor(rep, 'Opened mid-year').incomeINR.full, grow(days('2026-08-01', '2027-03-31')) - 1000000, 1, 'part of a year');
    const stale = lineFor(rep, 'Matured years ago');
    check(stale.incomeINR.full === 0 && stale.maturedBeforeYear, 'a deposit that matured long ago still projected interest');
    return 'the curve runs from the deposit date, and stops at a renewal nobody recorded';
  });

  test('M5 A bond follows its ISIN family for the tax cut at source', () => {
    const rep = taxReport([
      { name: 'Central G-Sec', category: 'bond', interestRatePct: 7, valueNative: 100000, priceSymbol: 'IN0020210202' },
      { name: 'Tamil Nadu SDL', category: 'bond', interestRatePct: 7.3, valueNative: 100000, instrument: 'IN30DEMO0002' },
      { name: 'Example NCD', category: 'bond', interestRatePct: 10.65, valueNative: 100000, priceSymbol: 'INE0DEMO0001' },
      { name: 'Mystery paper', category: 'bond', interestRatePct: 9, valueNative: 100000 },
    ]);
    check(lineFor(rep, 'Central G-Sec').bondKind === 'government', 'IN0 did not read as a central issue');
    check(lineFor(rep, 'Tamil Nadu SDL').bondKind === 'state', 'IN3 did not read as a state development loan');
    check(lineFor(rep, 'Example NCD').bondKind === 'corporate', 'INE did not read as corporate debt');
    check(lineFor(rep, 'Mystery paper').bondKind === 'unlisted', 'a row with no ISIN invented a family');
    check(lineFor(rep, 'Central G-Sec').tdsPct === 0 && lineFor(rep, 'Tamil Nadu SDL').tdsPct === 0, 'TDS was cut on a government security');
    near(lineFor(rep, 'Example NCD').tdsINR.full, 2130, 0.01, 'coupon TDS on a corporate NCD');
    check(rep.bonds.count === 4 && rep.bonds.payableProjectedINR === 33950, `payable read ${rep.bonds.payableProjectedINR}`);
    near(rep.bonds.tdsProjectedINR, 3930, 0.01, 'the bond block adds the withheld tax up');
    near(rep.bonds.payableAccruedINR, 33950 * income.financialYear(M_TODAY).fraction, 1, 'part of the coupon has been earned already');
    const manba = rep.bonds.rows.find((r) => r.name === 'Example NCD');
    near(manba.netReceivableINR, 8520, 0.01, 'net of TDS is what reaches the account');
    check(/no ISIN/.test(lineFor(rep, 'Mystery paper').tdsBasis), 'the missing ISIN is not explained to the owner');
    return 'G-Sec and SDL pay gross, a corporate NCD is cut at 20%, an unknown ISIN says so';
  });

  test('M6 Bank TDS waits for the section 194A limit, pooled across deposits', () => {
    const rows = [
      { name: 'Bank A', category: 'bank_account', interestRatePct: 2, valueNative: 1000000 },
      { name: 'Bank B', category: 'bank_account', interestRatePct: 2, valueNative: 1250000 },
    ];
    const under = taxReport(rows);
    near(under.depositTds.depositInterestINR, 45000, 0.01, 'the pooled interest');
    check(under.lines.every((l) => l.tdsPct === 0), 'TDS was cut below the limit');
    check(/50,000/.test(under.lines[0].tdsBasis), `the threshold was never explained: ${under.lines[0].tdsBasis}`);
    const third = { name: 'Bank C', category: 'bank_account', interestRatePct: 2, valueNative: 500000 };
    const over = taxReport([...rows, third]);
    check(over.depositTds.depositTdsApplied, 'a 55,000 pool escaped TDS');
    check(over.lines.every((l) => l.tdsPct === 20), 'one deposit was left uncut once the pool crossed');
    near(over.totals.tdsProjectedINR, 11000, 0.01, 'TDS on the pooled interest');
    const withNRE = taxReport([...rows, { name: 'NRE filler', category: 'bank_account', interestRatePct: 20, valueNative: 5000000 }]);
    check(withNRE.lines.every((l) => l.tdsPct === 0), 'exempt NRE interest pushed the pool over the limit');
    const senior = taxReport([...rows, third], { dob: '1960-06-15' });
    check(senior.depositTds.depositTdsThresholdINR === 100000, `a senior got the limit ${senior.depositTds.depositTdsThresholdINR}`);
    check(senior.lines.every((l) => l.tdsPct === 0), 'a senior citizen was cut at 55,000');
    return '45k untaxed, 55k cut at 20%, a senior waits for 1 lakh, NRE never counts';
  });

  test('M7 Both regimes are priced, and the twelve-lakh rebate lands', () => {
    const rep = taxReport([], { monthlySalary: 106250 });
    const [neu, old] = rep.regimes;
    check(neu.taxableIncomeINR === 1200000, `new-regime taxable read ${neu.taxableIncomeINR}`);
    near(neu.slabTaxINR, 60000, 0.01, 'tax on twelve lakh under the new slabs');
    check(neu.liabilityINR === 0, `rebate 87A left ${neu.liabilityINR} standing`);
    check(old.liabilityINR > 180000, `the old regime read ${old.liabilityINR}`);
    check(rep.preferred === 'new', `the cheaper regime was picked as ${rep.preferred}`);
    const claimed = taxReport([], { monthlySalary: 106250, tax: { oldRegimeDeductionsINR: 400000 } });
    check(claimed.regimes[1].liabilityINR < old.liabilityINR, 'an 80C claim did not move the old regime');
    check(claimed.regimes[0].liabilityINR === neu.liabilityINR, 'a claim the new regime ignores changed it anyway');
    const rich = taxReport([], { monthlySalary: 500000 });
    check(rich.regimes[0].surchargePct === 10, `surcharge read ${rich.regimes[0].surchargePct}% above fifty lakh`);
    check(rich.regimes[0].cessINR > 0 && rich.regimes[0].effectiveRatePct > 20, 'no cess on a surcharged liability');
    const poor = taxReport([], { monthlySalary: 25000 });
    check(poor.regimes[0].liabilityINR === 0 && poor.regimes[0].taxableIncomeINR === 225000, `three lakh a year read ${poor.regimes[0].taxableIncomeINR} taxable and ${poor.regimes[0].liabilityINR} tax`);
    return 'new slabs, 87A at 12 lakh, claims only under the old regime, surcharge above 50 lakh';
  });

  test('M8 TDS already deducted is credited, and over-credit reads as a refund', () => {
    const rep = taxReport(
      [{ name: 'NRO FD', category: 'fixed_deposit', interestRatePct: 8, valueNative: 1000000, acquiredOn: '2026-04-01', termMonths: 12 }],
      { monthlySalary: 50000, tax: { salaryTdsCreditedINR: 40000 } },
    );
    const settle = rep.settlement.find((s) => s.key === rep.preferred);
    check(rep.totals.tdsProjectedINR > 0, 'a crossed deposit pool cut no TDS at all');
    near(settle.tdsCreditedINR, 40000 + rep.totals.tdsProjectedINR, 0.01, 'both credits counted');
    near(settle.balanceINR, settle.liabilityINR - settle.tdsCreditedINR, 0.01, 'the balance is liability less credit');
    const over = taxReport([], { monthlySalary: 50000, tax: { salaryTdsCreditedINR: 200000 } });
    check(over.settlement[0].liabilityINR === 0 && over.settlement[0].balanceINR === -200000, `a nil liability with heavy salary TDS read ${over.settlement[0].balanceINR}`);
    return 'the balance turns negative when the credits beat the tax';
  });

  test('M9 The state payload carries the tax block and the settings route clamps it', async () => {
    const st = await api('GET', '/api/state');
    check(st.status === 200, `state returned ${st.status}`);
    const t = st.body.indiaTax;
    check(t, 'the payload has no indiaTax block');
    const todayISO = new Date().toISOString().slice(0, 10);
    check(t.financialYear.startISO <= todayISO && todayISO <= t.financialYear.endISO, `${todayISO} outside ${t.financialYear.label}`);
    check(t.regimes.length === 2 && t.preferred, 'the two regimes are not side by side in the payload');
    const fd = t.lines.find((l) => l.name === '1Y FD');
    check(fd && fd.incomeINR.full === 70000, `the fixture deposit read ${fd && fd.incomeINR.full}`);
    check(!t.lines.some((l) => l.name === 'Thai Endowment'), 'a Thai policy joined the Indian income lines');
    const bad = await api('PUT', '/api/settings', { tax: { bankInterestTdsPct: 999, dividendTdsPct: -5, otherTaxableIncomeINR: 'lots' } });
    check(bad.status === 200, `settings write returned ${bad.status}`);
    check(bad.body.settings.tax.bankInterestTdsPct === 50, `no clamp: ${bad.body.settings.tax.bankInterestTdsPct}`);
    check(bad.body.settings.tax.dividendTdsPct === 0, 'a negative rate was stored');
    check(bad.body.settings.tax.otherTaxableIncomeINR === 0, 'junk money was stored');
    check(bad.body.indiaTax.residence.seniorCitizen === false, 'the fixture profile read as a senior');
    const stated = await api('PUT', '/api/settings', { tax: { seniorCitizen: true } });
    check(stated.body.settings.tax.seniorCitizen === true, 'a stated senior flag was not stored');
    check(stated.body.indiaTax.residence.seniorSource === 'stated under Settings', 'the senior source did not follow the override');
    await reset();
    return 'fixture income accrues, Thai rows stay out, 999% clamps to 50%';
  });

  test('M10 The two income fields round-trip the store', () => {
    const h = store.normalizeHolding({ category: 'equity', name: 'INFY', country: 'IN', currency: 'INR', dividendYieldPct: 2.4, indianTax: 'taxable' }, null);
    check(h.dividendYieldPct === 2.4, `the yield became ${h.dividendYieldPct}`);
    check(h.indianTax === 'taxable', `the treatment became ${h.indianTax}`);
    check(store.normalizeHolding({ indianTax: 'MUMBOJUMBO' }, h).indianTax === 'auto', 'a junk treatment was stored');
    check(store.normalizeHolding({ indianTax: '  EXEMPT  ' }, h).indianTax === 'exempt', 'case and spaces were not folded');
    check(store.normalizeHolding({}, h).dividendYieldPct === 2.4, 'an absent yield dropped the stored one');
    check(store.normalizeHolding({ dividendYieldPct: '' }, h).dividendYieldPct === null, 'a blank yield did not clear');
    check(store.normalizeHolding({ name: 'x' }, null).indianTax === 'auto', 'a fresh row carried no treatment');
    const merged = store.merge(store.blankDb(), { settings: { tax: { bankInterestTdsPct: 300 } } });
    check(merged.settings.tax.bankInterestTdsPct === 50, 'a merge let an absurd rate through');
    check(merged.settings.tax.govtBondTdsPct === store.blankDb().settings.tax.govtBondTdsPct, 'a merge lost an untouched rate');
    return 'yield kept and cleared, treatment allow-listed, tax defaults survive a merge';
  });

  test('M11 The tax page is wired into the app and the holding form carries its fields', () => {
    const view = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'tax.js'), 'utf8');
    check(/export function render\(/.test(view), 'the tax view exports nothing to render');
    check(/ctx\.data\.indiaTax/.test(view), 'the tax view does not read the block the server sends');
    check(/function bondsCard\(/.test(view), 'the bond payable and TDS block is gone');
    check(/t\.regimes\.map/.test(view), 'the two regimes are no longer side by side');
    check(/INSTALMENTS/.test(view), 'the advance-tax calendar was dropped');
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    check(/tax: \{ title: 'India income & tax'/.test(appSrc), 'the view is not registered in app.js');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    check(/data-view="tax"/.test(html), 'no nav button for the tax page');
    check(/id="view-tax"/.test(html), 'no section for the tax page');
    const apiSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'api.js'), 'utf8');
    check(/saveTax: \(tax\) => request\('PUT', '\/api\/settings', \{ tax \}\)/.test(apiSrc), 'the tax form has no transport');
    const holdingsSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'holdings.js'), 'utf8');
    check(/input\('dividendYieldPct'/.test(holdingsSrc), 'the holding form cannot take a dividend yield');
    check(/select\('indianTax'/.test(holdingsSrc), 'the holding form cannot override the tax treatment');
    check(/indiaFields\.hidden = country\.value !== 'IN'/.test(holdingsSrc), 'the India block does not follow the country');
    return 'the page, its nav, its transport and its two holding fields are all present';
  });

  test('M12 A renewing deposit is still earning in a year its first term missed', () => {
    const grow = (days) => 1000000 * (1 + 8 / 400) ** (4 * days / 365.25);
    const days = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
    const rep = taxReport([
      { name: 'Stopped in 2021', category: 'fixed_deposit', interestRatePct: 8, valueNative: 1000000, acquiredOn: '2020-01-01', termMonths: 12 },
      { name: 'Renewed since 2020', category: 'fixed_deposit', interestRatePct: 8, valueNative: 1000000, acquiredOn: '2020-01-01', termMonths: 12, fdAutoRenew: '1' },
    ]);
    const stopped = lineFor(rep, 'Stopped in 2021');
    check(stopped.incomeINR.full === 0 && stopped.maturedBeforeYear, 'a finished deposit was projected to earn anyway');
    const rolls = lineFor(rep, 'Renewed since 2020');
    check(!rolls.maturedBeforeYear && rolls.incomeINR.full > 0, `the renewing row read ${JSON.stringify(rolls.incomeINR)}`);
    // Interest already in the deposit earns more, so the year is the compounded
    // difference between its start and end balance - not 8% of the principal.
    near(rolls.incomeINR.full, grow(days('2020-01-01', '2027-03-31')) - grow(days('2020-01-01', '2026-04-01')), 1, 'a year of interest on a rolled deposit');
    near(rolls.incomeINR.ytd, grow(days('2020-01-01', '2026-10-06')) - grow(days('2020-01-01', '2026-04-01')), 1, 'the part of the year already run');
    return `the same row earns ${Math.round(rolls.incomeINR.full)} once it renews`;
  });

  group('N. IndiaBonds bond prices');

  const bondRow = (over = {}) => ({
    id: 'n', name: 'Example NCD', category: 'bond', country: 'IN', currency: 'INR',
    units: 10, pricePerUnit: 10000, valueNative: 100000, interestRatePct: 10.65,
    instrument: 'INE0DEMO0001', priceAuto: null, priceSymbol: null, priceAsOf: null, ...over,
  });
  const bondQuotes = () => bonds.parseQuotes(BOND_PAGE);
  const reasonFor = (res, id) => (res.skipped.find((s) => s.id === id) || {}).reason || '';

  test('N1 The directory page yields one quote per ISIN', () => {
    const parsed = bondQuotes();
    check(parsed.count === 2, `${parsed.count} issues read from 3 cards`);
    check(parsed.cards === 3, `${parsed.cards} cards found`);
    const manba = parsed.quotes.get('INE0DEMO0001');
    check(manba.priceINR === 10037.93, `NCD price was ${manba.priceINR}`);
    check(manba.faceINR === 10000, `NCD lot inferred as ${manba.faceINR}`);
    check(manba.couponPct === 10.65, `coupon was ${manba.couponPct}`);
    check(manba.yieldPct === 11.1694, `yield was ${manba.yieldPct}`);
    check(manba.maturityLabel === 'Nov 2028', `maturity was ${manba.maturityLabel}`);
    check(manba.issuer === 'MANBA FINANCE LIMITED', `issuer was ${manba.issuer}`);
    const gsec = parsed.quotes.get('IN0202310483');
    check(gsec.priceINR === 100150.41 && gsec.faceINR === 100000, `G-Sec read ${gsec.priceINR} / ${gsec.faceINR}`);
    return '2 issues from 3 cards · NCD ₹10,037.93 of ₹10,000 face at 11.1694%';
  });

  test('N2 The smaller lot wins when an issue is listed twice', () => {
    const manba = bondQuotes().quotes.get('INE0DEMO0001');
    check(manba.priceINR === 10037.93, `the ₹1,00,000 lot won instead of the ₹10,000 one at ${manba.priceINR}`);
    check(manba.vendorId === '7f0f1e34-0e0a-4b7d-9d0a-1c2a4f2b7f11', 'the quote carries a different lot id');
    return 'one ISIN, the ₹10,000 denomination, counted in units a holder can buy';
  });

  test('N3 A page that changed shape is rejected, never guessed at', () => {
    let threw = '';
    try { bonds.parseQuotes('<html><body>the site was redesigned</body></html>'); } catch (err) { threw = err.message; }
    check(/no readable bond cards/.test(threw), `a shapeless page gave "${threw}"`);
    const far = BOND_PAGE.replace('10,037.93', '55,000.00').replace('1,00,379.30', '5,50,000.00').replace('1,00,150.41', '55,000.00');
    threw = '';
    try { bonds.parseQuotes(far); } catch (err) { threw = err.message; }
    check(/not near par/.test(threw), `prices far from par were accepted: "${threw}"`);
    return 'no cards and impossible prices both throw before a row is touched';
  });

  test('N4 A bond row is priced as its count times the price of one bond', () => {
    const row = bondRow();
    const res = bonds.applyQuotes([row], { ...bondQuotes(), asOf: '2026-10-06' });
    check(res.updated.length === 1 && res.skipped.length === 0, JSON.stringify(res));
    check(row.pricePerUnit === 10037.93, `price became ${row.pricePerUnit}`);
    check(row.valueNative === 100379.3, `10 bonds are worth ${row.valueNative}`);
    check(row.priceSymbol === 'INE0DEMO0001', `tagged ${row.priceSymbol}`);
    check(row.priceAsOf === '2026-10-06', `as of ${row.priceAsOf}`);
    check(row.bondFaceINR === 10000 && row.bondYieldPct === 11.1694, 'the lot or the yield was not recorded');
    return '10 × ₹10,037.93 = ₹1,00,379.30, tagged with the ISIN and the fetch date';
  });

  test('N5 A row that cannot be multiplied is left alone with a reason', () => {
    const noCount = bondRow({ id: 'n1', units: null, pricePerUnit: null, valueNative: 100000 });
    const unlisted = bondRow({ id: 'n2', priceSymbol: 'INE000000000' });
    const res = bonds.applyQuotes([noCount, unlisted], { ...bondQuotes(), asOf: '2026-10-06' });
    check(res.updated.length === 0, 'a row was priced that should not have been');
    check(/no bond count/.test(reasonFor(res, 'n1')), `missing units gave "${reasonFor(res, 'n1')}"`);
    check(noCount.valueNative === 100000, 'the typed value was overwritten');
    check(/not among the 2 issues/.test(reasonFor(res, 'n2')), `unknown ISIN gave "${reasonFor(res, 'n2')}"`);
    check(unlisted.pricePerUnit === 10000, 'an unlisted row was re-priced anyway');
    return 'no count and an unlisted ISIN are both reported, not invented around';
  });

  test('N6 A quarter-point move is refused, a re-tagged row is not', () => {
    const jumped = bondRow({ id: 'n3', pricePerUnit: 8000, priceSymbol: 'INE0DEMO0001' });
    const retagged = bondRow({ id: 'n4', pricePerUnit: 8000, priceSymbol: 'SOMETHING ELSE' });
    const res = bonds.applyQuotes([jumped, retagged], { ...bondQuotes(), asOf: '2026-10-06' });
    check(jumped.pricePerUnit === 8000, 'an implausible move was applied');
    const flagged = res.skipped.find((s) => s.id === 'n3');
    check(flagged && flagged.needsReview === true, 'the move was not flagged for review');
    check(retagged.pricePerUnit === 10037.93, 'choosing a different bond was blocked by the old price');
    return 'a 25% jump on the same ISIN waits for the owner; a row switched to another bond prices straight away';
  });

  test('N7 Pinned rows and rupee-only quotes are respected', () => {
    const pinned = bondRow({ id: 'n5', priceAuto: false });
    const dollars = bondRow({ id: 'n6', currency: 'USD' });
    const res = bonds.applyQuotes([pinned, dollars], { ...bondQuotes(), asOf: '2026-10-06' });
    check(res.updated.length === 0, 'a row was priced that asked not to be');
    check(/switched off/.test(reasonFor(res, 'n5')), `pinned gave "${reasonFor(res, 'n5')}"`);
    check(/quotes in rupees/.test(reasonFor(res, 'n6')), `USD gave "${reasonFor(res, 'n6')}"`);
    check(pinned.pricePerUnit === 10000 && dollars.pricePerUnit === 10000, 'a skipped row moved anyway');
    check(!bonds.isTrackable(pinned) && bonds.isTrackable(dollars), 'the batch filter disagrees with the applier');
    return 'a pinned price stays, a dollar bond is left to its owner, and the batch agrees';
  });

  test('N8 The directory coupon fills a blank rate but never overwrites a stated one', () => {
    const blank = bondRow({ id: 'n7', interestRatePct: null });
    const stated = bondRow({ id: 'n8', interestRatePct: 9.5 });
    const res = bonds.applyQuotes([blank, stated], { ...bondQuotes(), asOf: '2026-10-06' });
    check(blank.interestRatePct === 10.65, `the blank rate stayed ${blank.interestRatePct}`);
    check(res.updated.find((u) => u.id === 'n7').couponFilled === true, 'the fill was not reported');
    check(stated.interestRatePct === 9.5, 'a typed coupon was replaced');
    return 'an empty coupon comes from the issuer, an owned one stays owned';
  });

  test('N9 The refresh route prices a bond row and persists it', async () => {
    await reset();
    const created = await api('POST', '/api/holdings', {
      name: 'Example NCD', category: 'bond', country: 'IN', currency: 'INR', units: 10, instrument: 'INE0DEMO0001',
    });
    check(created.status === 201, `create returned ${created.status}`);
    const id = created.body.holdings.find((h) => h.name === 'Example NCD').id;
    const r = await api('POST', '/api/prices/refresh', {});
    check(r.status === 200, `refresh returned ${r.status}: ${r.text.slice(0, 180)}`);
    const row = byId(r.body.holdings, id);
    check(row.pricePerUnit === 10037.93, `route priced it at ${row.pricePerUnit}`);
    check(row.valueINR === 100379.3, `INR value was ${row.valueINR}`);
    check(row.priceSymbol === 'INE0DEMO0001', `tag was ${row.priceSymbol}`);
    check(row.bondYieldPct === 11.1694, 'the yield did not survive the route');
    check(row.trackedSymbol === null, 'a bond row was given an exchange symbol it does not have');
    check(r.body.priceResult.bonds.count === 2, `the route reported ${JSON.stringify(r.body.priceResult.bonds)} for the directory`);
    check(/IndiaBonds/.test(r.body.meta.bondSource || ''), 'the source is not named in meta');
    const doc = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'wealth-data.json'), 'utf8'));
    check(doc.holdings.find((h) => h.id === id).pricePerUnit === 10037.93, 'the ledger file was not updated');
    return 'fetched, priced and persisted: 10 bonds at ₹10,037.93';
  });

  test('N10 A dead bond site costs the other feeds nothing', async () => {
    await reset();
    const created = await api('POST', '/api/holdings', {
      name: 'Dead feed NCD', category: 'bond', country: 'IN', currency: 'INR', units: 10, instrument: 'INE0DEMO0001',
    });
    const id = created.body.holdings.find((h) => h.name === 'Dead feed NCD').id;
    const gold = await api('POST', '/api/holdings', {
      name: 'Chain for N10', category: 'gold_commodity', country: 'IN', currency: 'INR', units: 20, metalRate: 'gold22',
    });
    const goldId = gold.body.holdings.find((h) => h.name === 'Chain for N10').id;
    bondPage = '<html><body>the site was redesigned</body></html>';
    try {
      const r = await api('POST', '/api/prices/refresh', {});
      check(r.status === 200, `a dead bond feed returned ${r.status} instead of pricing the rest`);
      check(/bond directory page has no readable/.test((r.body.priceResult.errors || []).join(' ')), `errors were ${JSON.stringify(r.body.priceResult.errors)}`);
      check(byId(r.body.holdings, id).pricePerUnit === null, 'a bond was priced off a page with no cards');
      check(byId(r.body.holdings, goldId).pricePerUnit === 13675, 'the bullion feed was taken down with the bond site');
      check(r.body.priceResult.bonds === null, 'a failed directory was reported as a quote count');
      return 'the bond error is reported, its row untouched, the bullion price still written';
    } finally {
      bondPage = BOND_PAGE;
    }
  });

  test('N11 The two quote fields round-trip the store', () => {
    const created = store.normalizeHolding({ name: 'B', category: 'bond', bondFaceINR: 10000, bondYieldPct: 11.1694 });
    check(created.bondFaceINR === 10000 && created.bondYieldPct === 11.1694, 'the fields were dropped on create');
    const kept = store.normalizeHolding({ name: 'B' }, created);
    check(kept.bondFaceINR === 10000 && kept.bondYieldPct === 11.1694, 'editing the row lost the quote provenance');
    const cleared = store.normalizeHolding({ bondFaceINR: null, bondYieldPct: null }, created);
    check(cleared.bondFaceINR === null && cleared.bondYieldPct === null, 'an explicit clear did not stick');
    return 'kept on create, kept through an edit, cleared on demand';
  });

  test('N12 The bond feed is wired into the batch and explained in the form', () => {
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check(/require\('\.\/server\/lib\/bonds'\)/.test(srv), 'server.js does not load the bond reader');
    check(/bonds\.fetchQuotes\(\)/.test(srv), 'the refresh batch never calls the bond directory');
    check(/bonds\.applyQuotes\(pool, bondFeed\)/.test(srv), 'bond quotes are not applied to the batch');
    check(/bond\.length \? 1 : 0/.test(srv), 'the bond fetch is not counted among the feeds that must answer');
    const getter = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'httpget.js'), 'utf8');
    check(/maxBytes/.test(getter), 'the shared GET still caps the 508 KB directory page');
    const reader = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'bonds.js'), 'utf8');
    check(/WEALTH_BOND_DIRECTORY_URL/.test(reader), 'the bond source cannot be pointed at a fixture');
    const form = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'holdings.js'), 'utf8');
    check(/category === 'bond'/.test(form), 'the holding form says nothing about the bond feed');
    check(/bondFaceINR/.test(form), 'the form does not show the lot and yield the feed recorded');
    return 'the third feed is fetched, applied, counted, size-capable and explained';
  });

  // ---- O. Portfolio health -------------------------------------------------
  group('O. Portfolio health rules');

  // The engine takes the same analysis blocks server.js hands it, so a scenario
  // that builds its own ledger has to assemble them the same way.
  function reportFor(rows, over = {}) {
    const profile = over.profile || { monthlyExpensesNowINR: 100000 };
    const targets = over.targets || {};
    const age = 'age' in over ? over.age : 35;
    return healthEngine.portfolioHealth({
      rows,
      profile,
      settings: { assumptions: { inflationPct: over.inflation === undefined ? 6 : over.inflation } },
      age,
      goals: over.goals || [],
      allocation: analysis.allocation(rows, targets),
      concentration: analysis.concentration(rows),
      geography: analysis.geography(rows),
      health: analysis.healthScore({ rows, profile, targets, age }),
      unconverted: over.unconverted || [],
      today: over.today || TODAY,
    });
  }

  const row = (category, valueINR, over = {}) => ({
    id: over.id || category, name: over.name || `Row ${category}`, category, country: over.country || 'IN',
    currency: 'INR', valueINR, institution: over.institution ?? '', interestRatePct: over.interestRatePct ?? null,
    costINR: null, liquid: over.liquid ?? true, ...over,
  });

  test('O1 The report carries every field the page reads', async () => {
    const s = await reset();
    const r = s.portfolioHealth;
    check(r, 'state sends no portfolioHealth block');
    check(/^\d{4}-\d{2}-\d{2}$/.test(r.asOf), `asOf is ${r.asOf}`);
    const themes = r.themes.map((t) => t.key);
    check(themes.length === 6 && new Set(themes).size === 6, `themes are ${themes.join(', ')}`);
    check(r.themes.every((t) => t.label && t.note), 'a theme has no heading or note');
    const sumByTheme = themes.reduce((a, k) => a + r.checks.filter((c) => c.theme === k).length, 0);
    check(sumByTheme === r.checks.length, `${sumByTheme} of ${r.checks.length} checks are in a named theme`);
    check(r.themes.every((t) => t.checks >= 3), 'a theme is too thin to be worth its own card');
    check(r.themes.reduce((a, t) => a + t.checks, 0) === r.checks.length, 'theme counts disagree with the checks');
    const verdicts = new Set(['good', 'watch', 'risk', 'unknown']);
    for (const c of r.checks) {
      check(verdicts.has(c.verdict), `${c.key} verdict ${c.verdict}`);
      check(c.key && c.label && typeof c.detail === 'string' && c.detail.length > 12, `thin check ${c.key}`);
      check(!/NaN|undefined|\[object/.test(c.detail), `${c.key} detail leaks a raw value: ${c.detail}`);
      // A rule that passes has nothing to send the reader to; anything else must.
      if (c.verdict === 'good') check(!c.remedy && !c.view, `${c.key} passes but still prescribes`);
      else check(c.remedy && c.view, `${c.key} needs a remedy and a destination`);
    }
    const counts = r.counts;
    check(counts.risk + counts.watch + counts.good + counts.unknown === r.checks.length, 'verdict counts do not add up');
    check(counts.assets === s.holdings.filter((h) => h.category !== 'liability' && h.valueINR > 0).length, 'valued asset count disagrees with the ledger');
    near(r.depositInsuranceLimitINR, 500000, 0, 'DICGC cover');
    check(r.topRows.length <= 10 && r.topRows.every((t, i, a) => !i || t.valueINR <= a[i - 1].valueINR), 'largest-holdings list is not sorted and capped');
    check(r.topRows.every((t, i, a) => !i || t.cumulativePct >= a[i - 1].cumulativePct), 'the running total ran backwards');
    near(r.topRows[0].cumulativePct, r.topRows[0].pct, 0.01, 'the first row is its own running total');
    return `${r.checks.length} rules over ${themes.length} themes, every verdict and remedy in shape`;
  });

  test('O2 An empty ledger is reported as no data, not as six failures', async () => {
    const r = await api('PUT', '/api/import', fixtureDoc({ holdings: [] }));
    check(r.status === 200, `empty import returned ${r.status}`);
    const report = r.body.portfolioHealth;
    check(report.counts.assets === 0, `${report.counts.assets} valued assets`);
    check(report.checks.length === 1, `${report.checks.length} rules ran against nothing`);
    check(report.checks[0].verdict === 'unknown', `empty ledger verdict ${report.checks[0].verdict}`);
    check(report.themes.every((t) => t.verdict === 'unknown'), 'a theme invented a verdict on an empty ledger');
    check(report.actions.length === 0, 'an empty ledger still produced an action list');
    check(report.topRows.length === 0 && report.income.blendedYieldPct === null, 'empty figures were invented');
    await reset();
    return 'one rule, no data, nothing to act on';
  });

  test('O3 Earning power reads the rates on the rows', async () => {
    const s = await reset();
    const inc = s.portfolioHealth.income;
    // ₹10 lakh FD at 7% and a ₹2.6 lakh policy at 4% are the only rate-bearing rows.
    near(inc.annualIncomeINR, 70000 + 10400, 1, 'contractual income');
    near(inc.interestIncomeINR, 80400, 1, 'interest half of it');
    check(inc.dividendIncomeINR === 0, 'a dividend appeared from a row that states none');
    near(inc.earningValueINR, 1260000, 1, 'value the rates sit on');
    near(inc.blendedYieldPct, 80400 / 1260000 * 100, 0.01, 'yield on earning assets');
    near(inc.portfolioYieldPct, 80400 / GROSS_ASSETS * 100, 0.01, 'yield on the whole portfolio');
    near(inc.silentValueINR, GROSS_ASSETS - 1260000, 1, 'silent value');
    check(inc.silentCount === 7 && inc.earningCount === 2, `${inc.earningCount} earning / ${inc.silentCount} silent rows`);
    check(inc.debtValueINR === LIABILITIES && inc.debtCostPct === null, 'an uncosted loan was read as free or as a rate');
    near(inc.uncostedDebtINR, LIABILITIES, 1, 'debt with no rate on it');
    const cover = s.portfolioHealth.checks.find((c) => c.key === 'passive-cover');
    near(inc.annualIncomeINR / (s.profile.monthlyExpensesNowINR * 12) * 100, 6.7, 0.05, 'income against spending');
    check(cover.verdict === 'risk', `6.7% cover reported ${cover.verdict}`);
    return `₹${inc.annualIncomeINR} a year on ₹${inc.earningValueINR}, ${inc.silentCount} silent rows`;
  });

  test('O4 Deposits are measured against the cover, bank by bank', async () => {
    const s = await reset();
    const inst = s.portfolioHealth.institutions;
    // The fixture names no banks, so all three Indian deposit rows fall into one
    // unnamed bucket - which is exactly how the limit has to be applied.
    near(inst.depositsINR, 500000 + 1000000 + 200000, 1, 'Indian deposit money');
    check(inst.deposits.length === 1 && inst.deposits[0].count === 3, JSON.stringify(inst.deposits));
    near(inst.deposits[0].insuredINR, 500000, 1, 'inside cover');
    near(inst.deposits[0].uncoveredINR, 1200000, 1, 'above cover');
    near(inst.uncoveredINR, 1200000, 1, 'total uninsured');
    const cover = s.portfolioHealth.checks.find((c) => c.key === 'deposit-cover');
    check(cover.verdict === 'risk', `₹12 lakh uninsured read as ${cover.verdict}`);
    check(/12,00,000/.test(cover.detail), `detail hides the amount: ${cover.detail}`);
    check(inst.list.length === 0 && inst.unnamedCount === 9, 'rows with no institution were counted as one');
    // Splitting the same money across two banks must halve the exposure.
    const split = reportFor([
      row('bank_account', 400000, { id: 'a', institution: 'Central Bank' }),
      row('fixed_deposit', 400000, { id: 'b', institution: 'Union Bank' }),
    ]);
    check(split.institutions.uncoveredINR === 0, 'two banks under the limit were flagged');
    const one = reportFor([row('bank_account', 800000, { id: 'c', institution: 'Central Bank' })]);
    near(one.institutions.uncoveredINR, 300000, 1, 'one bank over the limit');
    near(one.institutions.deposits[0].insuredINR, 500000, 1, 'covered half');
    const oneCover = one.checks.find((c) => c.key === 'deposit-cover');
    check(/largest single gap is ₹3,00,000 at Central Bank/.test(oneCover.detail),
      `the gap is not attributed to a bank and an amount: ${oneCover.detail}`);
    const foreign = reportFor([row('bank_account', 900000, { id: 'd', country: 'TH', institution: 'Sample Bank Thailand' })]);
    check(foreign.institutions.deposits.length === 0, 'a Thai account was measured against Indian cover');
    check(foreign.checks.find((c) => c.key === 'deposit-cover').verdict === 'unknown', 'no Indian deposits was called safe');
    return '₹12,00,000 uninsured on the fixture, and the limit lands per bank';
  });

  test('O5 The maturity ladder dates nothing in year zero', async () => {
    const s = await reset();
    const lad = s.portfolioHealth.ladder;
    check(lad.ladder.every((b) => b.year >= 2000), `a phantom bucket appeared: ${JSON.stringify(lad.ladder)}`);
    check(lad.ladder.length === 1 && lad.ladder[0].year === 2027, JSON.stringify(lad.ladder));
    near(lad.ladder[0].valueINR, 1000000, 1, 'the dated FD');
    check(lad.ladder[0].overdue === false, 'a 2027 maturity was called overdue');
    near(lad.undatedINR, GROSS_ASSETS - 1000000, 1, 'everything without a date');
    near(lad.datedINR, 1000000, 1, 'dated total');
    // The one dated year owns all of the dated money, so the cliff is the whole.
    near(lad.cliff.pct, 100, 0.01, 'cliff share');
    check(s.portfolioHealth.checks.find((c) => c.key === 'maturity-cliff').verdict === 'risk', 'a single-year ladder is not a cliff');
    const spread = reportFor([
      row('fixed_deposit', 100000, { id: 'x', maturityDate: '2027-01-01', name: 'FD A' }),
      row('fixed_deposit', 100000, { id: 'y', maturityDate: '2029-01-01', name: 'FD B' }),
      row('equity', 100000, { id: 'z', name: 'No date' }),
    ]);
    check(spread.ladder.ladder.length === 2 && spread.ladder.cliff.pct === 50, `two-year ladder reads ${JSON.stringify(spread.ladder.cliff)}`);
    near(spread.ladder.undatedINR, 100000, 1, 'the undated bucket stays out of the years');
    check(spread.checks.find((c) => c.key === 'maturity-cliff').verdict === 'risk', 'half the dated money landing in one year was called safe');
    const stepped = reportFor([1, 2, 3, 4, 5].map((n) => row('fixed_deposit', 100000, {
      id: `s${n}`, name: `FD ${n}`, maturityDate: `${2026 + n}-01-01`,
    })));
    near(stepped.ladder.cliff.pct, 20, 0.01, 'five equal years');
    check(stepped.checks.find((c) => c.key === 'maturity-cliff').verdict === 'good', 'a ladder spread over five years was still called a cliff');
    const nothing = reportFor([row('equity', 100000, { id: 'q' })]);
    check(nothing.ladder.cliff === null && nothing.ladder.ladder.length === 0, 'a dateless ledger invented a cliff');
    check(nothing.checks.find((c) => c.key === 'maturity-cliff').verdict === 'unknown', 'no dates was judged anyway');
    return `one bucket in ${lad.ladder[0].year}, ₹${Math.round(lad.undatedINR / 100000)}L undated`;
  });

  test('O6 A loan at 12% costs 12%, not 0.12%', () => {
    const r = reportFor([
      row('equity', 5000000, { id: 'e', name: 'Widow fund' }),
      row('liability', 1000000, { id: 'l1', name: 'Personal loan', interestRatePct: 12, liquid: false }),
      row('liability', 9000000, { id: 'l2', name: 'Home loan', interestRatePct: 6, liquid: false }),
    ]);
    // Value-weighted over the rates themselves: the big 6% loan dominates.
    near(r.income.debtCostPct, 6.6, 0.01, 'blended debt cost');
    check(r.income.debtCostPct > 1, 'the blend came out as a fraction of a percent');
    near(r.income.debtValueINR, 10000000, 1, 'debt total');
    check(r.income.uncostedDebtINR === 0, 'costed debt was counted as uncosted');
    const chk = r.checks.find((c) => c.key === 'debt-cost');
    check(/6\.6%/.test(chk.detail), `the blend is missing from the sentence: ${chk.detail}`);
    check(chk.verdict === 'unknown' && /no asset states a rate/.test(chk.detail), `a rated debt against silent assets read ${chk.verdict}: ${chk.detail}`);
    check(!/return 0\.0%/.test(chk.detail), 'an unknown yield was printed as zero');
    const silent = reportFor([
      row('equity', 1000000, { id: 'e2', name: 'Fund' }),
      row('liability', 1000000, { id: 'l3', name: 'No rate' }),
    ]);
    check(silent.income.debtCostPct === null, 'a loan with no rate produced a cost');
    const silentChk = silent.checks.find((c) => c.key === 'debt-cost');
    check(silentChk.verdict === 'unknown' && /no rate on its row/.test(silentChk.detail), `an unknown cost was graded ${silentChk.verdict}: ${silentChk.detail}`);
    const debtFree = reportFor([row('equity', 1000000, { id: 'e3', name: 'Fund' })]);
    const clean = debtFree.checks.find((c) => c.key === 'debt-cost');
    check(clean.verdict === 'good' && !clean.remedy, `owning no debt was reported as ${clean.verdict}`);
    return '12% and 6% blend to 6.6%, and a blank rate stays unknown';
  });

  test('O7 The action list puts failures before decisions', async () => {
    const s = await reset();
    const r = s.portfolioHealth;
    check(r.actions.length <= 6, `${r.actions.length} actions is a list, not a priority`);
    check(r.actions.every((a) => a.verdict === 'risk' || a.verdict === 'watch'), 'the list carries a rule that needs nothing');
    const order = r.actions.map((a) => (a.verdict === 'risk' ? 0 : 1));
    check(order.every((v, i) => !i || v >= order[i - 1]), 'a watch action is ranked above a risk one');
    const themeOrder = healthEngine.THEMES.map((t) => t.key);
    let k = 0;
    while (k < r.actions.length) {
      const verdict = r.actions[k].verdict;
      let seen = -1;
      for (; k < r.actions.length && r.actions[k].verdict === verdict; k += 1) {
        const at = themeOrder.indexOf(r.actions[k].theme);
        check(at >= seen, `${r.actions[k].theme} cuts ahead of the card order inside ${verdict}`);
        seen = at;
      }
    }
    const risky = r.checks.filter((c) => c.verdict === 'risk').length;
    check(risky > 0 || !r.actions.some((a) => a.verdict === 'risk'), 'a risk action has no failing rule');
    check(r.actions.length === Math.min(6, r.checks.filter((c) => c.verdict !== 'good' && c.verdict !== 'unknown').length), 'the list is not every rule asking for a decision');
    return `${r.actions.length} ranked actions, ${risky} of ${r.checks.length} rules failing`;
  });

  test('O8 Every jump the page offers lands on a real tab', async () => {
    const s = await reset();
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    const views = [...appSrc.matchAll(/^  (\w+): \{ title:/gm)].map((m) => m[1]);
    check(views.length >= 9, `only ${views.length} views registered`);
    const targets = new Set(s.portfolioHealth.checks.filter((c) => c.view).map((c) => c.view));
    for (const v of targets) {
      check(views.includes(v), `the page would go to ${v}, which app.js does not know`);
      check(new RegExp(`id="view-${v}"`).test(html), `${v} has no section to render into`);
    }
    // A destination the engine can name but the page cannot label would render a
    // bare "Open" button with no hint of where it goes.
    const viewSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'health.js'), 'utf8');
    const labelBlock = viewSrc.match(/function gotoLabel\(view\)[\s\S]*?\n\}/);
    check(labelBlock, 'gotoLabel disappeared');
    for (const v of targets) check(new RegExp(`${v}: '`).test(labelBlock[0]), `${v} has no button label`);
    return `${targets.size} distinct destinations, all registered and labelled`;
  });

  test('O9 The tab is wired and the Allocation page stopped duplicating it', async () => {
    const s = await reset();
    check(s.portfolioHealth, 'the state contract dropped portfolioHealth');
    const viewSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'health.js'), 'utf8');
    check(/export function render\(/.test(viewSrc), 'the health view exports nothing to render');
    check(/data\.portfolioHealth|ctx\.data\.portfolioHealth/.test(viewSrc), 'the view does not read the block the server sends');
    check(!/<a href="#/.test(viewSrc), 'the view hard-links a tab instead of asking the app to switch');
    for (const verdict of ['good', 'watch', 'risk', 'unknown']) {
      check(new RegExp(`${verdict}: '`).test(viewSrc), `no tag style for the ${verdict} verdict`);
    }
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    check(/import \* as health from '\.\/views\/health\.js'/.test(appSrc), 'the view is not imported');
    check(/health: \{ title: 'Portfolio health'/.test(appSrc), 'the view is not registered in VIEWS');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    check(/data-view="health"/.test(html), 'no nav button for the page');
    check(/id="view-health"/.test(html), 'no section for the page');
    const styles = fs.readFileSync(path.join(ROOT, 'public', 'css', 'styles.css'), 'utf8');
    check(/\.check-row\s*\{/.test(styles), 'a rule row has no layout, so the list would collapse into one line');
    check(/\.card\.is-alert\s*\{/.test(styles), 'a failing theme card has no red tint - is-flagged means the opposite');
    // The score and the concentration figures moved out of the Allocation page;
    // a second copy of either would let the two tabs disagree about a number.
    const allocSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'allocation.js'), 'utf8');
    check(!/function scoreRing\(/.test(allocSrc), 'the Allocation page re-grew its own score ring');
    check(!/function componentRow\(/.test(allocSrc), 'the scored components are duplicated');
    check(!/function hhiNote\(/.test(allocSrc), 'the Herfindahl reading is duplicated');
    check(!/Concentration &amp; geography/.test(allocSrc), 'the concentration card is back');
    check(/id="a-open-health"/.test(allocSrc) && /ctx\.go\('health'\)/.test(allocSrc), 'the Allocation page no longer points at the new tab');
    const dashboardSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'dashboard.js'), 'utf8');
    check(!/portfolioHealth/.test(dashboardSrc), 'the dashboard grew its own copy of the rules');
    return `report over ${s.portfolioHealth.checks.length} rules, one nav entry, no duplicated figures`;
  });

  test('O10 A quarter-century of cover is stated in years', () => {
    const longRows = [row('bank_account', 100000 * 300, { id: 'huge', name: 'War Chest' })];
    const longCover = reportFor(longRows).checks.find((c) => c.key === 'emergency-cover');
    check(/25\.0 years of spending/.test(longCover.detail), `decades printed as months: ${longCover.detail}`);
    const shortRows = [row('bank_account', 100000 * 8, { id: 'small', name: 'Float' })];
    const shortCover = reportFor(shortRows).checks.find((c) => c.key === 'emergency-cover');
    check(/8\.0 months of spending/.test(shortCover.detail), `a small cover switched to years: ${shortCover.detail}`);
    // The score card reads the same cover figure through its own formatter.
    const scoreLine = (rows) => analysis.healthScore({
      rows, profile: { monthlyExpensesNowINR: 100000 }, targets: {}, age: 35,
    }).components.find((c) => c.key === 'liquidity').detail;
    check(/25\.0 years of spending in liquid assets/.test(scoreLine(longRows)), `score detail: ${scoreLine(longRows)}`);
    check(/8 months of spending in liquid assets \(target 6 months\)/.test(scoreLine(shortRows)), `score detail: ${scoreLine(shortRows)}`);
    return 'years above ten years of cover, months below it, on both the rules and the score';
  });

  // ---- P. PDF report and the emailed copy ----------------------------------
  group('P. PDF report and the emailed copy');

  // The file is written by hand, so its structure is the thing to prove: a wrong
  // xref offset or a byte-count-as-character-count stream length shows up as a
  // blank viewer, never as an error message.
  function inspectPdf(buf) {
    const text = buf.toString('latin1');
    check(text.startsWith('%PDF-1.4'), `header is ${JSON.stringify(text.slice(0, 12))}`);
    check(/%%EOF\s*$/.test(text), 'no %%EOF at the end of the file');
    const tail = /startxref\n(\d+)\n%%EOF/.exec(text.slice(-160));
    check(!!tail, `no startxref pointer: ${JSON.stringify(text.slice(-60))}`);
    const table = text.slice(Number(tail[1]));
    const hdr = /^xref\n0 (\d+)\n/.exec(table);
    check(!!hdr, `xref does not open with a size: ${JSON.stringify(table.slice(0, 40))}`);
    const entries = [...table.matchAll(/^(\d{10}) (\d{5}) ([nf])/gm)];
    check(entries.length === Number(hdr[1]), `xref lists ${entries.length} entries, its size says ${hdr[1]}`);
    entries.forEach((e, i) => {
      if (i === 0 || e[3] === 'f') return;
      const at = Number(e[1]);
      check(new RegExp(`^${i} 0 obj`).test(text.slice(at, at + 14)),
        `object ${i} points at byte ${at}, which reads ${JSON.stringify(text.slice(at, at + 16))}`);
    });
    const count = Number(/\/Type \/Pages \/Count (\d+)/.exec(text)[1]);
    const pageObjects = (text.match(/\/Type \/Page \/Parent/g) || []).length;
    check(count === pageObjects, `/Count says ${count}, ${pageObjects} page objects are present`);
    let streams = 0;
    for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = m.index + m[0].length;
      const end = text.indexOf('\nendstream', start);
      check(end > start, 'a content stream has no endstream');
      check(end - start === Number(m[1]), `content stream is ${end - start} bytes but /Length says ${m[1]}`);
      streams += 1;
    }
    // Every drawn string in reading order, unwrapped: a sentence the writer broke
    // over two lines must still be assertable as one sentence.
    const parts = [];
    for (const m of text.matchAll(/\(((?:\\.|[^\\()])*)\) Tj/g)) {
      parts.push(m[1].replace(/\\([()\\])/g, '$1'));
    }
    return { text, plain: parts.join(' '), pages: count, objects: entries.length, streams };
  }

  test('P1 The hand-written PDF is structurally valid', async () => {
    await reset();
    const built = reportLib.buildReport({ state: await state(), now: TODAY });
    const info = inspectPdf(built.buffer);
    check(info.pages === built.pages, `buildReport says ${built.pages} pages, the file says ${info.pages}`);
    check(info.streams === info.pages, `${info.streams} content streams for ${info.pages} pages`);
    check(/\/Title \(Wealth Ledger portfolio report - 2026-10-05\)/.test(info.text), 'the title carries no date');
    check(/\/Producer \(Wealth Ledger\)/.test(info.text), 'no producer in /Info');
    check(/\/CreationDate \(D:20261005/.test(info.text), 'the creation stamp is not the supplied date');
    return `${info.pages} pages, ${info.objects} objects, every xref offset and stream length verified`;
  });

  test('P2 A rupee sign becomes Rs and other punctuation keeps a real byte', async () => {
    check(pdfLib.encode('₹1,000') === 'Rs1,000', `encode: ${JSON.stringify(pdfLib.encode('₹1,000'))}`);
    check(pdfLib.encode('a — b') === 'a \x97 b', `em dash: ${JSON.stringify(pdfLib.encode('a — b'))}`);
    check(pdfLib.encode('“x”') === '\x93x\x94', `curly quotes: ${JSON.stringify(pdfLib.encode('“x”'))}`);
    check(pdfLib.encode('…') === '\x85', 'ellipsis has no WinAnsi byte');
    check(pdfLib.encode('日') === '?', 'an unmappable glyph is not silently dropped');
    check(pdfLib.encode(null) === '', 'null encodes to something');
    // Right-aligned amounts only line up because every digit shares a width.
    check(pdfLib.widthOf('12345', 10, false) === pdfLib.widthOf('99999', 10, false), 'digits differ in width');
    await reset();
    const built = reportLib.buildReport({ state: await state(), now: TODAY });
    check(!built.buffer.includes(Buffer.from('₹', 'utf8')), 'a UTF-8 rupee sign reached the PDF bytes');
    check(/Rs \d/.test(inspectPdf(built.buffer).text), 'no rupee figure printed in the Rs form');
    return 'Rs for the rupee sign, WinAnsi punctuation, no multi-byte leftovers';
  });

  test('P3 Every promised section and its rupee figures are in the file', async () => {
    await reset();
    const s = await state();
    const built = reportLib.buildReport({ state: s, now: TODAY });
    const doc = inspectPdf(built.buffer);
    const text = doc.plain;
    const promised = ['Cover', 'What you hold', 'Positions', 'Allocation', 'Health', 'Income & tax', 'Goals', 'Retirement', 'Sources'];
    check(JSON.stringify(built.sections) === JSON.stringify(promised), `sections: ${built.sections.join(', ')}`);
    for (const heading of ['What you hold, by asset class', 'Every position on the ledger', 'Allocation against target',
      'Portfolio health', 'India income and tax', 'Goals and what they still need',
      'Retirement and financial independence', 'How this document was produced']) {
      check(text.includes(heading), `the heading "${heading}" is missing`);
    }
    check(text.includes(reportLib.rs(s.summary.netWorthINR)), `net worth ${reportLib.rs(s.summary.netWorthINR)} is not printed`);
    check(text.includes(reportLib.rs(s.summary.totalAssetsINR)), 'gross assets are not printed');
    s.holdings.filter((h) => h.category !== 'liability').forEach((h) => {
      check(text.includes(String(h.name)), `the position "${h.name}" is missing`);
    });
    return `${built.sections.length} sections over ${built.pages} pages, figures read back from the bytes`;
  });

  test('P4 An empty ledger still produces a readable document', async () => {
    const empty = await api('PUT', '/api/import', fixtureDoc({ holdings: [] }));
    check(empty.status === 200, `import failed with ${empty.status}`);
    const built = reportLib.buildReport({ state: (await api('GET', '/api/state')).body, now: TODAY });
    const doc = inspectPdf(built.buffer);
    check(/Nothing is valued yet/.test(doc.plain), 'an empty mix is not explained');
    for (const bad of ['NaN', 'undefined', 'null', 'Infinity']) {
      check(!new RegExp(`\\b${bad}\\b`).test(doc.plain), `${bad} reached the page`);
    }
    await reset();
    return `an empty ledger composes into ${built.pages} clean page${built.pages === 1 ? '' : 's'}`;
  });

  test('P5 A long position list flows over pages and repeats its header', async () => {
    const many = Array.from({ length: 120 }, (_, i) => holding({
      id: `m${i}`, name: `Position ${String(i).padStart(3, '0')}`, category: 'equity',
      country: 'IN', currency: 'INR', units: 10, pricePerUnit: 100 + i, costNative: 500, acquiredOn: '2024-04-01',
    }));
    const doc = fixtureDoc({ holdings: many });
    const r = await api('PUT', '/api/import', doc);
    check(r.status === 200, `import failed with ${r.status}`);
    const built = reportLib.buildReport({ state: (await api('GET', '/api/state')).body, now: TODAY });
    const pdf = inspectPdf(built.buffer);
    check(built.pages > 1, `120 rows fitted on ${built.pages} page`);
    const headers = (pdf.text.match(/\(Matures\) Tj/g) || []).length;
    check(headers >= 2, `the table header appears ${headers} time across ${built.pages} pages`);
    // Every row must survive the flow, not just the ones that fit.
    for (const name of ['Position 000', 'Position 059', 'Position 119']) {
      check(pdf.plain.includes(name), `${name} fell off the end`);
    }
    const footers = (pdf.text.match(/Page \d+ of \d+/g) || []).length;
    check(footers === built.pages, `${footers} footers for ${built.pages} pages`);
    await reset();
    return `${many.length} rows over ${built.pages} pages, header redrawn ${headers} times`;
  });

  test('P6 The PDF route streams it as a download and reports its shape', async () => {
    const res = await fetch(`${BASE}/api/report/pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    check(res.status === 200, `status ${res.status}`);
    check(res.headers.get('content-type') === 'application/pdf', `content-type ${res.headers.get('content-type')}`);
    const today = new Date().toISOString().slice(0, 10);
    check(res.headers.get('content-disposition') === `attachment; filename="wealth-report-${today}.pdf"`,
      `content-disposition ${res.headers.get('content-disposition')}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const info = inspectPdf(buf);
    check(Number(res.headers.get('X-Report-Pages')) === info.pages, `header says ${res.headers.get('X-Report-Pages')}, file ${info.pages}`);
    check(Number(res.headers.get('X-Report-Sections')) === 9, `section header says ${res.headers.get('X-Report-Sections')}`);
    check(res.headers.get('cache-control') === 'no-store', 'a download could be cached and report a stale net worth');
    const bad = await fetch(`${BASE}/api/report/pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"plan":',
    });
    check(bad.status === 400, `malformed JSON answered ${bad.status}`);
    return `${info.pages} pages, ${buf.length} bytes served as an attachment`;
  });

  test('P7 The retirement block is the browser arithmetic, or the report says so', async () => {
    const { buildPlan, cashFlow } = await loadPlanning();
    await reset();
    const s = await state();
    const plan = buildPlan({
      profile: s.profile,
      assumptions: s.settings.assumptions,
      netWorthINR: s.summary.netWorthINR,
      liquidAssetsINR: s.summary.liquidAssetsINR,
      currentAge: s.age,
    });
    const cash = cashFlow({
      profile: s.profile,
      netWorthINR: s.summary.netWorthINR,
      totalLiabilitiesINR: s.summary.totalLiabilitiesINR,
      currentAge: plan.currentAge,
      assumptions: s.settings.assumptions,
    });
    const withPlanBuilt = reportLib.buildReport({ state: s, plan, cash, now: TODAY });
    const withPlan = inspectPdf(withPlanBuilt.buffer).plain;
    check(withPlan.includes(reportLib.rs(plan.corpus.requiredINR)), 'the corpus the plan needs is not printed');
    check(withPlan.includes(reportLib.rs(cash.fireNumberINR)), 'the FIRE number is not printed');
    check(/Cash flow and financial independence/.test(withPlan), 'the cash-flow block is missing');
    check(!withPlanBuilt.warnings.some((w) => /retirement projection/.test(w)), 'a supplied projection is warned about anyway');
    const withoutBuilt = reportLib.buildReport({ state: s, now: TODAY });
    const without = inspectPdf(withoutBuilt.buffer).plain;
    check(withoutBuilt.warnings.some((w) => /No retirement projection was supplied/.test(w)),
      `warnings: ${withoutBuilt.warnings.join(' | ')}`);
    check(/Generate PDF Report tab to include the projection/.test(without),
      'a report with no projection does not say where to get one');
    // An empty object is the shape a stale page would post; it must not 500.
    const lenient = reportLib.buildReport({ state: s, plan: {}, cash: {}, now: TODAY });
    check(lenient.pages >= 1, 'an empty plan produced no page');
    return `plan and cash flow printed verbatim, ${plan.corpus.requiredINR ? 'corpus' : 'corpus'} in rupees`;
  });

  test('P8 Email settings save, and the password never travels back out', async () => {
    const saved = await api('PUT', '/api/settings', {
      email: {
        host: 'smtp.example.test', port: 587, security: 'starttls',
        user: 'me@example.test', pass: 'hunter2-secret', from: 'me@example.test',
        to: 'owner@example.test', autoSend: false,
      },
    });
    check(saved.status === 200, `save failed with ${saved.status}`);
    const e = saved.body.settings.email;
    check(e.host === 'smtp.example.test' && e.user === 'me@example.test' && e.port === 587, `saved as ${JSON.stringify(e)}`);
    check(e.hasPass === true, 'the page is not told a password is stored');
    check(!('pass' in e), 'the password came back in the settings block');
    check(!JSON.stringify(saved.body).includes('hunter2-secret'), 'the password is somewhere in /api/state');
    check(!JSON.stringify(saved.body.meta.email).includes('hunter2-secret'), 'the password leaked through the email status');
    check(saved.body.meta.email.ready === true, `still not ready: ${saved.body.meta.email.problems.join('; ')}`);
    return 'host, user, port and recipient persist while the secret stays write-only';
  });

  test('P9 A blank password keeps the stored one, an explicit null clears it', async () => {
    const kept = await api('PUT', '/api/settings', { email: { pass: '', host: 'smtp2.example.test' } });
    check(kept.body.settings.email.hasPass === true, 'typing nothing threw away the password');
    check(kept.body.settings.email.host === 'smtp2.example.test', 'a partial edit lost the other fields');
    const untouched = await api('PUT', '/api/settings', { email: { host: 'smtp3.example.test' } });
    check(untouched.body.settings.email.hasPass === true, 'omitting the key cleared the password');
    const cleared = await api('PUT', '/api/settings', { email: { pass: null } });
    check(cleared.body.settings.email.hasPass === false, 'null did not clear the password');
    check(cleared.body.settings.email.host === 'smtp3.example.test', 'clearing the password lost the host');
    const stored = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'wealth-data.json'), 'utf8'));
    check(stored.settings.email.pass === '', `the file still holds ${JSON.stringify(stored.settings.email.pass)}`);
    await reset();
    const back = await api('GET', '/api/state');
    check(back.body.settings.email.host === '' && back.body.settings.email.autoSend === false,
      'the fixture did not restore the private defaults');
    return 'keep-on-blank, clear-on-null, and a reset returns to no mail server';
  });

  test('P10 Emailing starts switched off and refuses until it is configured', async () => {
    const fresh = store.blankDb();
    check(fresh.settings.email.autoSend === false, 'auto-send defaults on');
    check(fresh.settings.email.host === '' && fresh.settings.email.pass === '', 'a fresh ledger ships with mail settings');
    const s = await reset();
    check(s.settings.email.autoSend === false && s.meta.email.ready === false, 'the fixture is send-ready out of the box');
    check(/no mail server host/.test(s.meta.email.problems.join('; ')), `problems read: ${s.meta.email.problems.join('; ')}`);
    const refused = await api('POST', '/api/report/email', {});
    check(refused.status === 400, `an unconfigured send answered ${refused.status}`);
    check(/Emailing is not set up yet/.test(refused.body.error), `error: ${refused.body.error}`);
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const pdfRoute = /app\.post\('\/api\/report\/pdf'[\s\S]*?\n\}\);/.exec(serverSrc)[0];
    check(!/sendMail/.test(pdfRoute), 'the download route mails without being asked');
    return 'opt-in by default, refused with the reasons, and the download route holds no mail call';
  });

  test('P11 The address list falls back to the profile and rejects a malformed one', async () => {
    await api('PUT', '/api/settings', {
      email: { host: 'smtp.example.test', security: 'none', user: '', from: 'sender@example.test', to: '', pass: null },
    });
    const s = await api('GET', '/api/state');
    check(s.body.meta.email.to === 't@example.com', `recipient fell back to ${s.body.meta.email.to}`);
    const typed = await api('POST', '/api/report/email', { to: 'someone@else.test' });
    check(typed.status !== 400 || !/no recipient/.test(typed.body.error || ''), 'a typed recipient was ignored');
    const bad = await api('POST', '/api/report/email', { to: 'not-an-address' });
    check(bad.status === 400 && /is not an email address/.test(bad.body.error), `malformed answered ${bad.status}: ${bad.body.error}`);
    const two = await api('PUT', '/api/settings', { email: { to: 'a@example.test, b@example.test' } });
    check(two.body.meta.email.to === 'a@example.test, b@example.test', `list reads ${two.body.meta.email.to}`);
    await reset();
    return 'profile email used, a bad address named, and a comma-separated list kept';
  });

  test('P12 The SMTP client completes a real dialogue and the PDF arrives intact', async () => {
    smtpReset();
    const cfg = {
      host: '127.0.0.1', port: SMTP_PORT, security: 'none',
      user: 'ledger@example.test', pass: 'app-password-1',
      from: 'ledger@example.test', to: 'owner@example.test', autoSend: false,
    };
    const saved = await api('PUT', '/api/settings', { email: cfg });
    check(saved.body.meta.email.ready === true, `not ready: ${saved.body.meta.email.problems.join('; ')}`);
    const r = await api('POST', '/api/report/email', {});
    check(r.status === 200, `send failed with ${r.status}: ${r.body && r.body.error}`);
    check(r.body.ok === true && r.body.to === 'owner@example.test', `reply: ${JSON.stringify(r.body)}`);
    check(r.body.security === 'none' && r.body.port === SMTP_PORT, `transport: ${JSON.stringify(r.body)}`);
    const lines = smtpLog.lines;
    check(/^EHLO /.test(lines[0] || ''), `first command was ${lines[0]}`);
    check(lines.some((l) => /^AUTH LOGIN$/i.test(l)), 'no AUTH LOGIN was offered');
    check(Buffer.from(smtpLog.user, 'base64').toString('utf8') === 'ledger@example.test', `user went as ${smtpLog.user}`);
    check(Buffer.from(smtpLog.pass, 'base64').toString('utf8') === 'app-password-1', 'the password did not arrive');
    check(lines.some((l) => /^MAIL FROM:<ledger@example\.test>$/i.test(l)), 'no MAIL FROM');
    check(lines.some((l) => /^RCPT TO:<owner@example\.test>$/i.test(l)), 'no RCPT TO');
    check(lines.some((l) => /^QUIT$/i.test(l)), 'the connection was left open');
    check(/Content-Type: application\/pdf; name="wealth-report-.*\.pdf"/.test(smtpLog.data), 'no PDF part');
    check(/Content-Transfer-Encoding: base64/.test(smtpLog.data), 'the attachment is not base64');
    const b64 = /Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n------=/.exec(smtpLog.data);
    check(!!b64, 'the attachment body could not be located');
    const pdf = Buffer.from(b64[1].replace(/\s+/g, ''), 'base64');
    const info = inspectPdf(pdf);
    check(info.pages >= 1, `the emailed file has ${info.pages} pages`);
    check(/Retirement and financial independence/.test(info.text), 'the emailed PDF lost its sections');
    return `delivered over port ${SMTP_PORT}: ${info.pages} pages, ${pdf.length} bytes, xref verified after the round trip`;
  });

  test('P13 A mail server that says no has its own words reported', async () => {
    smtpReset('norelay');
    const saved = await api('PUT', '/api/settings', {
      email: {
        host: '127.0.0.1', port: SMTP_PORT, security: 'none', user: 'ledger@example.test',
        pass: 'app-password-1', from: 'ledger@example.test', to: 'blocked@example.test',
      },
    });
    check(saved.body.meta.email.ready === true, 'a relay refusal was treated as unconfigured');
    const r = await api('POST', '/api/report/email', {});
    check(r.status === 502, `answered ${r.status}`);
    check(/550/.test(r.body.error), `error lost the reply: ${r.body.error}`);
    smtpReset('authfail');
    const bad = await api('POST', '/api/report/email', {});
    check(bad.status === 502 && /535/.test(bad.body.error), `auth failure answered ${bad.status}: ${bad.body.error}`);
    smtpReset('drop');
    const hung = await api('POST', '/api/report/email', {});
    check(hung.status === 502, `a server that hung up answered ${hung.status}`);
    check(/closed the connection|no reply/i.test(hung.body.error), `error: ${hung.body.error}`);
    await api('PUT', '/api/settings', { email: { host: '', pass: null, to: '' } });
    return 'a refusal, a bad password and a silent server each surface the server\'s own text';
  });

  test('P14 The MIME is well formed and a body line cannot forge the terminator', () => {
    const attachment = Buffer.from('%PDF-1.4 test %%EOF\n');
    const m = mailer.buildMessage({
      from: 'a@example.test', to: ['b@example.test', 'c@example.test'],
      subject: 'Rapor ₹1,000', text: 'line one\r\n.\r\nline three',
      attachment: { fileName: 'we"ird.pdf', buffer: attachment },
    });
    check(m.recipients.length === 2, `recipients: ${m.recipients.join(',')}`);
    check(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/.test(m.raw), 'a non-ASCII subject was not encoded');
    check(Buffer.from(/Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=.*/.exec(m.raw)[1], 'base64').toString('utf8') === 'Rapor ₹1,000',
      'the encoded subject says something else');
    check(/multipart\/mixed; boundary="----=_WealthLedger_[a-f0-9]+"/.test(m.raw), 'no multipart boundary');
    check(/\r\n\.\.\r\n/.test(m.raw), 'a body line starting with a dot is not stuffed');
    check(!/name="we"ird/.test(m.raw) && /filename=".*\.pdf"/.test(m.raw), 'the file name kept its quote');
    const plain = mailer.buildMessage({ from: 'a@example.test', to: 'b@example.test', subject: 's', text: 't' });
    check(/Content-Type: text\/plain/.test(plain.raw) && !/multipart/.test(plain.raw), 'a message with no attachment is still multipart');
    return 'RFC 2047 subject, dot-stuffed body and a sanitised file name';
  });

  test('P15 The report tab sits under Settings and warns before it mails', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const settingsAt = html.indexOf('data-view="settings"');
    const reportAt = html.indexOf('data-view="report"');
    check(reportAt > settingsAt, 'Generate PDF Report is not below Settings');
    check(/Generate PDF Report/.test(html), 'the menu item does not carry the requested title');
    check(/<section class="view is-hidden" id="view-report">/.test(html), 'the tab has no mount point');
    const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    check(/report: \{ title: 'Generate PDF Report'/.test(app), 'app.js has no entry for the tab');
    const view = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'report.js'), 'utf8');
    check(/leaves this machine only if you ask/.test(view), 'the page never warns that emailing exports the portfolio');
    check(/type="checkbox" name="autoSend"/.test(view), 'auto-send is not something the owner switches on');
    check(/autocomplete="new-password"/.test(view), 'the browser will offer to remember the app password');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies || {}).sort().join(',');
    check(deps === 'chart.js,express', `a PDF or mail package was installed: ${deps}`);
    return `${html.match(/data-view="(.*?)"/g).length} nav entries, still only chart.js and express`;
  });

  // ---- Q. Wealth bands on the dashboard ------------------------------------
  group('Q. Wealth bands');

  const BANDS = { mass: 25e5, emerging: 5e6, hni: 5e7, vhni: 25e7, uhni: 1e9 };
  const A11 = { preRetirementReturnPct: 11, salaryGrowthPct: 6, inflationPct: 6 };
  const STILL = { monthlyInvestableSurplusINR: 0 };
  const CR416 = 41658353;

  test('Q1 The six bands are the Indian ones, in order and edge to edge', async () => {
    const { WEALTH_TIERS } = await loadPlanning();
    check(WEALTH_TIERS.length === 6, `the ladder has ${WEALTH_TIERS.length} rungs`);
    check(WEALTH_TIERS[0].floorINR === 0, 'the bottom rung does not start at zero');
    const floors = WEALTH_TIERS.map((t) => t.floorINR);
    check(floors.every((f, i) => i === 0 || f > floors[i - 1]), `bands overlap: ${floors.join(' ')}`);
    const byKey = Object.fromEntries(WEALTH_TIERS.map((t) => [t.key, t.floorINR]));
    for (const [key, floor] of Object.entries(BANDS)) {
      check(byKey[key] === floor, `${key} starts at ${byKey[key]}, not ${floor}`);
    }
    check(/Mass Affluent/.test(WEALTH_TIERS[1].label), 'the ₹25 L band is not called Mass Affluent');
    check(/Emerging HNI/.test(WEALTH_TIERS[2].label), 'the ₹50 L band is not called Emerging HNI');
    check(/VHNI/.test(WEALTH_TIERS[4].label), 'the ₹25 Cr band is not called VHNI');
    check(/UHNI/.test(WEALTH_TIERS[5].label), 'the ₹100 Cr band is not called UHNI');
    return '₹25 L through ₹100 Cr in six rungs, each named as the owner quoted';
  });

  test('Q2 A balance belongs to the highest floor it clears', async () => {
    const { tierFor } = await loadPlanning();
    const cases = [[-5e6, 'below'], [0, 'below'], [2499999, 'below'], [BANDS.mass, 'mass'], [4999999, 'mass'],
      [BANDS.emerging, 'emerging'], [49999999, 'emerging'], [BANDS.hni, 'hni'], [249999999, 'hni'],
      [BANDS.vhni, 'vhni'], [999999999, 'vhni'], [BANDS.uhni, 'uhni'], [9e9, 'uhni']];
    for (const [net, key] of cases) {
      const t = tierFor(net);
      check(t.tier.key === key, `${net} landed in ${t.tier.key}, expected ${key}`);
    }
    near(tierFor(3.75e6).bandProgressPct, 50, 0.01, 'progress through the middle of a band');
    near(tierFor(2499999).bandProgressPct, 100, 0.01, 'a rupee below the next floor');
    check(tierFor(-1e6).bandProgressPct === 0, 'a negative balance claims progress');
    check(tierFor(BANDS.uhni).isTop === true && tierFor(BANDS.emerging).isTop === false, 'the top band is not recognised');
    check(tierFor(BANDS.emerging).next.floorINR === BANDS.hni, 'the next band up is not the one above it');
    return `${cases.length} balances classified, including every boundary`;
  });

  test('Q3 The next two levels are priced in rupees, not in encouragement', async () => {
    const { tierLadder } = await loadPlanning();
    const l = tierLadder({ netWorthINR: CR416, currentAge: 39, assumptions: A11, profile: STILL, startYear: 2026 });
    check(l.current.tier.key === 'emerging', `₹4.17 Cr is not Emerging HNI but ${l.current.tier.key}`);
    check(l.targets.length === 2, `the ladder offers ${l.targets.length} next levels, the page promises two`);
    check(l.targets[0].tier.key === 'hni' && l.targets[1].tier.key === 'vhni', 'the rungs above are out of order');
    near(l.targets[0].gapINR, BANDS.hni - CR416, 1, 'gap to HNI');
    near(l.targets[1].gapINR, BANDS.vhni - CR416, 1, 'gap to VHNI');
    near(l.targets[0].multipleNeeded, BANDS.hni / CR416, 1e-6, 'how many times over the balance must grow');
    check(l.crossings.length === 3, `${l.crossings.length} bands ahead of an Emerging HNI, expected three`);
    check(l.targets.every((t) => t.gapINR > 0), 'a band already reached is still being chased');
    return `+${Math.round(l.targets[0].gapINR)} to HNI, +${Math.round(l.targets[1].gapINR)} to VHNI`;
  });

  test('Q4 The year a band is reached is the year the FIRE maths reaches it', async () => {
    const { tierLadder, financiallyFreeAge, accumulationCurve } = await loadPlanning();
    const surplus = 250000;
    const l = tierLadder({ netWorthINR: CR416, currentAge: 39, assumptions: A11, profile: { monthlyInvestableSurplusINR: surplus }, startYear: 2026 });
    for (const t of l.targets) {
      const same = financiallyFreeAge({
        netWorthINR: CR416, currentAge: 39, preReturnPct: 11, monthlySurplusINR: surplus,
        salaryGrowthPct: 6, targetINR: t.tier.floorINR, horizonAge: 69,
      });
      check(t.atPace && same === t.atPace.age, `${t.tier.key}: the ladder says age ${t.atPace && t.atPace.age}, the FIRE walk says ${same}`);
      const point = l.curve[t.atPace.years];
      check(point.balanceINR >= t.tier.floorINR, `${t.tier.key} crossed at a balance below its floor`);
      check(l.curve[t.atPace.years - 1].balanceINR < t.tier.floorINR, `${t.tier.key} was already cleared a year earlier`);
      check(point.year === 2026 + t.atPace.years && point.age === 39 + t.atPace.years, 'crossing year and age do not line up');
    }
    const flat = accumulationCurve({ netWorthINR: 1e6, years: 3, preReturnPct: 0, monthlySurplusINR: 0, salaryGrowthPct: 0, startAge: 40, startYear: 2026 });
    check(flat.length === 4 && flat.every((p) => p.balanceINR === 1e6), 'a flat walk moved the balance');
    check(flat[2].year === 2028 && flat[2].age === 42, 'the walk does not count years');
    return l.targets.map((t) => `${t.tier.key} in ${t.atPace.year}`).join(', ');
  });

  test('Q5 Nothing new invested makes the pace and the market one story', async () => {
    const { tierLadder } = await loadPlanning();
    const none = tierLadder({ netWorthINR: CR416, currentAge: 39, assumptions: A11, profile: STILL, startYear: 2026 });
    for (const t of none.targets) {
      check(t.growthOnly.years === t.atPace.years, `${t.tier.key}: nothing invested yet the pace beats the market`);
    }
    const heavy = tierLadder({ netWorthINR: CR416, currentAge: 39, assumptions: A11, profile: { monthlyInvestableSurplusINR: 2000000 }, startYear: 2026 });
    const vhni = heavy.targets.find((t) => t.tier.key === 'vhni');
    check(vhni.atPace.years < vhni.growthOnly.years, '₹20 L a month does not beat compounding alone');
    check(vhni.atPace.years < none.targets[1].atPace.years, 'more money did not shorten the climb');
    check(heavy.inputs.monthlySurplusINR === 2000000, 'the pace the card describes is not the one it walked');
    return `VHNI in ${vhni.atPace.years} yr investing, ${vhni.growthOnly.years} yr on growth alone`;
  });

  test('Q6 A trajectory that never arrives says so instead of inventing a year', async () => {
    const { tierLadder } = await loadPlanning();
    const frozen = { preRetirementReturnPct: 0, salaryGrowthPct: 0 };
    const l = tierLadder({ netWorthINR: 1e6, currentAge: 40, assumptions: frozen, profile: STILL, startYear: 2026 });
    check(l.targets.every((t) => t.atPace === null && t.growthOnly === null), 'a frozen balance is shown crossing a band');
    check(l.crossings.every((c) => c.at === null), 'the band strip still promises a year');
    check(l.curve.length === l.horizonYears + 1, `a ${l.horizonYears}-year horizon walked ${l.curve.length - 1} years`);
    check(l.endBalanceINR === 1e6, 'the balance grew with no return and no money');
    const short = tierLadder({ netWorthINR: 1e6, currentAge: 40, assumptions: frozen, profile: STILL, horizonYears: 5, startYear: 2026 });
    check(short.curve.length === 6 && short.targets[0].atPace === null, 'a shorter horizon did not shorten the walk');
    const negative = tierLadder({ netWorthINR: -3e6, currentAge: 40, assumptions: A11, profile: STILL, startYear: 2026 });
    check(negative.current.tier.key === 'below', 'a debt-heavy ledger was given a band it has not earned');
    near(negative.targets[0].gapINR, BANDS.mass + 3e6, 1, 'gap from debt to the first band');
    return `${l.horizonYears} years walked, no year invented`;
  });

  test('Q7 The five-year figure is the investing level that lands the band', async () => {
    const { tierLadder, accumulationCurve } = await loadPlanning();
    const l = tierLadder({ netWorthINR: CR416, currentAge: 39, assumptions: A11, profile: STILL, startYear: 2026 });
    const vhni = l.targets.find((t) => t.tier.key === 'vhni');
    const need = vhni.investMonthlyINR.five;
    check(need > 0, 'no investing figure was produced for a band five years away');
    const walk = (monthly) => accumulationCurve({
      netWorthINR: CR416, years: 5, preReturnPct: 11, monthlySurplusINR: monthly,
      salaryGrowthPct: 6, startAge: 39, startYear: 2026,
    });
    check(walk(need)[5].balanceINR >= BANDS.vhni, `investing ${need}/mo lands at ${walk(need)[5].balanceINR}, short of ${BANDS.vhni}`);
    check(walk(need - 10000)[5].balanceINR < BANDS.vhni, 'the figure is not the level that clears the band');
    check(vhni.investMonthlyINR.ten < vhni.investMonthlyINR.five, 'a decade costs more a month than five years');
    const soon = l.targets.find((t) => t.tier.key === 'hni');
    check(soon.investMonthlyINR.five === 0, 'a band already inside five years still asks for money');
    return `₹${need}/mo for five years reaches VHNI`;
  });

  test('Q8 The top band has no next level to price', async () => {
    const { tierLadder } = await loadPlanning();
    const top = tierLadder({ netWorthINR: 5e9, currentAge: 44, assumptions: A11, profile: STILL, startYear: 2026 });
    check(top.targets.length === 0 && top.crossings.length === 0, 'a level above UHNI was invented');
    check(top.current.isTop && top.current.bandProgressPct === 100, 'the top band is not reported as complete');
    check(top.endBalanceINR > 5e9, 'the projection stops compounding at the top');
    const zero = tierLadder({ netWorthINR: 0, currentAge: 30, assumptions: A11, profile: STILL, startYear: 2026 });
    check(zero.current.tier.key === 'below' && zero.targets[0].tier.key === 'mass', 'an empty ledger has no band at all');
    check(zero.targets.every((t) => t.atPace === null && t.multipleNeeded === null), 'nothing grew into something');
    near(zero.targets[0].gapINR, BANDS.mass, 1, 'gap from nothing to Mass Affluent');
    return 'UHNI has nothing above it, zero has a band and a gap';
  });

  test('Q9 No date of birth leaves the age blank but keeps the year', async () => {
    const { tierLadder } = await loadPlanning();
    const l = tierLadder({ netWorthINR: CR416, currentAge: null, assumptions: A11, profile: STILL, startYear: 2026 });
    check(l.currentAge === null, 'an unknown age became zero');
    check(l.curve.every((p) => p.age === null), 'the curve invented ages');
    check(l.targets[0].atPace.age === null && l.targets[0].atPace.year === 2028, 'the crossing lost its calendar year');
    const blank = tierLadder({ netWorthINR: CR416, currentAge: undefined, assumptions: {}, profile: {}, startYear: 2026 });
    check(blank.currentAge === null && blank.inputs.preReturnPct === 0, 'missing assumptions became a number');
    check(blank.targets[0].atPace === null, 'a zero return still climbed');
    check(blank.inputs.monthlySurplusINR === 0, 'an absent surplus became an investment');
    return `age unknown, HNI still in ${l.targets[0].atPace.year}`;
  });

  test('Q10 The dashboard reads the bands and nothing else recomputes them', async () => {
    const dash = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'dashboard.js'), 'utf8');
    check(/from '\.\.\/planning\.js'/.test(dash), 'the view does not import from planning.js');
    check(/WEALTH_TIERS/.test(dash) && /tierLadder\(/.test(dash), 'the view does not build a ladder');
    check(/netWorthINR: summary\.netWorthINR/.test(dash), 'the band is not measured on the headline net worth');
    check(/class="tag is-tier"/.test(dash), 'no band label beside the net worth figure');
    check(/id="c-tier"/.test(dash), 'the projection has no chart');
    check(/to earn/.test(dash) && /at this pace/.test(dash), 'the gap is not stated in rupees and years');
    check(/growth alone/.test(dash), 'the card never separates compounding from new money');
    const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'styles.css'), 'utf8');
    for (const cls of ['.tier-strip', '.tier.is-current', '.band-meter', '.level-gap', '.tag.is-tier', 'td.num']) {
      check(css.includes(cls), `styles.css never defines ${cls}`);
    }
    // One table of floors, not two: a second copy would drift the first time the
    // owner edits a band.
    for (const f of ['server.js', 'public/js/app.js', 'public/js/views/report.js', 'public/js/views/planner.js',
      'public/js/views/health.js', 'server/lib/report.js', 'server/lib/analysis.js', 'server/lib/valuation.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      check(!/25e5|25e7/.test(src), `${f} carries its own copy of the band floors`);
    }
    return 'the view paints what planning.js computes';
  });

  test('Q11 A valued ledger falls in the band its net worth earns', async () => {
    await reset();
    const s = await state();
    const { tierFor, tierLadder, WEALTH_TIERS } = await loadPlanning();
    const t = tierFor(s.summary.netWorthINR);
    check(WEALTH_TIERS.some((x) => x.key === t.tier.key), 'a valued ledger fell off the ladder');
    const l = tierLadder({
      netWorthINR: s.summary.netWorthINR, currentAge: s.age,
      assumptions: s.settings.assumptions, profile: s.profile, startYear: 2026,
    });
    check(l.current.tier.key === t.tier.key, 'the ladder and the classifier disagree on one balance');
    check(l.targets.length > 0 && l.targets[0].gapINR > 0, 'the next band has no gap');
    near(l.targets[0].gapINR, l.targets[0].tier.floorINR - s.summary.netWorthINR, 1, 'gap against the fixture net worth');
    check(l.curve[0].balanceINR === Math.round(s.summary.netWorthINR), 'the curve does not start at today');
    return `${Math.round(s.summary.netWorthINR)} is ${t.tier.label}, next ${l.targets[0].tier.label}`;
  });

  group('R. Net worth in five currencies');

  test('R1 Net worth is restated in the reporting base and four more currencies', async () => {
    await reset();
    const s = await state();
    const list = s.summary.netWorthByCurrency;
    check(Array.isArray(list) && list.length === 5, `expected five currencies, got ${list && list.length}`);
    check(list.map((c) => c.code).join(',') === 'INR,USD,SGD,THB,MYR', `list is ${list.map((c) => c.code).join(',')}`);
    check(list[0].source === 'base' && list[0].rateToINR === 1, 'rupees are not the base of the strip');
    check(list[0].amount === s.summary.netWorthINR, `INR restated as ${list[0].amount}, headline is ${s.summary.netWorthINR}`);
    return `${list.map((c) => c.code).join(' ')} · ₹${s.summary.netWorthINR}`;
  });

  test('R2 Each currency gets the same net worth at the rate the ledger was valued at', async () => {
    await reset();
    const s = await state();
    const net = s.summary.netWorthINR;
    near(s.summary.netWorthByCurrency.find((c) => c.code === 'USD').amount, NET_WORTH / R.USD, 1, 'usd amount');
    for (const c of s.summary.netWorthByCurrency.filter((x) => x.code !== 'INR')) {
      check(c.amount !== null, `${c.code} has no amount`);
      near(c.amount * s.rates[c.code].rate, net, 1, `${c.code} re-converted to rupees`);
    }
    return `$${Math.round(net / R.USD)} · S$${Math.round(net / R.SGD)} · ฿${Math.round(net / R.THB)}`;
  });

  test('R3 A rate pinned by hand changes the restated figure, not just the label', async () => {
    await reset();
    await api('PUT', '/api/fx/USD', { manualRate: 111.5 });
    const s = await state();
    const usd = s.summary.netWorthByCurrency.find((c) => c.code === 'USD');
    await api('PUT', '/api/fx/USD', { manualRate: null });
    check(usd.source === 'manual', `source reads ${usd.source}`);
    check(usd.rateToINR === 111.5, `rate reads ${usd.rateToINR}`);
    near(usd.amount, s.summary.netWorthINR / 111.5, 1, 'pinned conversion');
    return `₹111.5 per dollar → $${Math.round(usd.amount)}`;
  });

  test('R4 A currency with no rate yields a dash, never a guessed number', async () => {
    const bare = analysis.netWorthByCurrency(5e6, {});
    check(bare.length === 5, 'the fixed list shrank');
    check(bare.every((r) => r.amount === null && r.rateToINR === null && r.source === 'unknown'), 'an empty rate table still produced amounts');
    const partial = analysis.netWorthByCurrency(5e6, { INR: { rate: 1, source: 'base' }, USD: { rate: 88.5, source: 'cached' } });
    check(partial.find((c) => c.code === 'SGD').amount === null, 'SGD was invented with no rate');
    near(partial.find((c) => c.code === 'USD').amount, 5e6 / 88.5, 1, 'usd with a rate');
    const dash = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'dashboard.js'), 'utf8');
    check(/amount === null \? '—'/.test(dash), 'the view prints a number for a missing amount');
    return 'null out, dash on screen';
  });

  test('R5 A negative or empty balance converts without hiding the sign', async () => {
    const neg = analysis.netWorthByCurrency(-3e6, { INR: { rate: 1, source: 'base' }, USD: { rate: 88.5, source: 'cached' } });
    near(neg.find((c) => c.code === 'USD').amount, -3e6 / 88.5, 1, 'negative dollars');
    const zero = analysis.netWorthByCurrency(0, { USD: { rate: 88.5, source: 'cached' } });
    check(zero.every((r) => (r.code === 'USD' ? r.amount === 0 : r.amount === null)), 'an empty ledger invented balances');
    return 'minus survives, zero stays zero';
  });

  test('R6 Rupee grouping never leaks into a dollar figure', async () => {
    const { converted } = await loadFormat();
    check(converted(1234567.891, 'USD') === '$1,234,568', `usd read ${converted(1234567.891, 'USD')}`);
    check(converted(1234567.891, 'INR') === '₹12,34,568', `inr read ${converted(1234567.891, 'INR')}`);
    check(converted(980.5, 'SGD') === 'S$980.50', `sgd read ${converted(980.5, 'SGD')}`);
    check(converted(500000, 'MYR') === 'RM 500,000', `myr read ${converted(500000, 'MYR')}`);
    check(converted(-1234.4, 'THB') === '-฿1,234', `thb read ${converted(-1234.4, 'THB')}`);
    return 'each currency grouped its own way';
  });

  test('R7 The view paints the server conversion and does no currency maths itself', async () => {
    const dash = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'dashboard.js'), 'utf8');
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check(/summary\.netWorthByCurrency/.test(dash), 'the view brings its own currency list');
    check(!/amount\s*\//.test(dash), 'the view divides by a rate itself');
    check(/converted\(c\.amount, c\.code\)/.test(dash), 'the chip does not use the shared formatter');
    check(!/'USD'/.test(dash), 'the view hardcodes a currency code');
    check(/analysis\.netWorthByCurrency\(summary\.netWorthINR, rates\)/.test(srv), 'the state does not build the strip from resolved rates');
    const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'styles.css'), 'utf8');
    for (const cls of ['.fx-strip', '.fx-item', '.fx-code', '.fx-amt', '.fx-note', '.fx-item.is-missing']) {
      check(css.includes(cls), `styles.css never defines ${cls}`);
    }
    return 'one conversion, on the server';
  });

  test('R8 A bundled default converts too, and the chip says where the rate came from', async () => {
    await reset();
    const s = await state();
    const myr = s.summary.netWorthByCurrency.find((c) => c.code === 'MYR');
    check(myr.source === 'fallback', `MYR came from ${myr.source}`);
    check(myr.asOf === 'bundled', `asOf reads ${myr.asOf}`);
    near(myr.amount, s.summary.netWorthINR / s.meta.fallbackRates.MYR, 1, 'myr at the bundled rate');
    const dash = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'dashboard.js'), 'utf8');
    check(/bundled default/.test(dash) && /pinned in Settings/.test(dash), 'the view never names where a rate came from');
    return `RM ${Math.round(myr.amount)} at the bundled ${myr.rateToINR}`;
  });

  group('S. Wealth Analytics projection');

  // A row with a year of history and a measured return, a row that pays a known
  // rate, a row with neither, and a debt.
  function projRows(over = {}) {
    return [
      { id: 'p1', name: 'Reliance', category: 'equity', country: 'IN', currency: 'INR', valueINR: 1000000, annualisedPct: 18.4, yearsHeld: 3.2 },
      { id: 'p2', name: 'FD', category: 'fixed_deposit', country: 'IN', currency: 'INR', valueINR: 500000, interestRatePct: 7.1 },
      { id: 'p3', name: 'Savings', category: 'bank_account', country: 'IN', currency: 'INR', valueINR: 200000 },
      { id: 'p4', name: 'Loan', category: 'liability', country: 'IN', currency: 'INR', valueINR: 300000 },
      ...over.extra || [],
    ];
  }

  test('S1 Each asset grows at the best rate the ledger actually knows', async () => {
    const { assetGrowthRate } = await loadPlanning();
    const own = assetGrowthRate({ annualisedPct: 18.4, yearsHeld: 3.2 }, { assumptionPct: 11 });
    check(own.ratePct === 18.4 && own.why === 'measured', `measured lost: ${JSON.stringify(own)}`);
    const tooYoung = assetGrowthRate({ annualisedPct: 18.4, yearsHeld: 0.4 }, { assumptionPct: 11 });
    check(tooYoung.why === 'assumed' && tooYoung.ratePct === 11, 'a six-month winner was extrapolated for fifteen years');
    const pays = assetGrowthRate({ interestRatePct: 7.1 }, { assumptionPct: 11 });
    check(pays.ratePct === 7.1 && pays.why === 'coupon', `coupon lost: ${JSON.stringify(pays)}`);
    const nothing = assetGrowthRate({}, { assumptionPct: 11 });
    check(nothing.ratePct === 11 && nothing.why === 'assumed', 'the fallback is not the assumption');
    return 'measured > coupon > assumed';
  });

  test('S2 A spectacular history is capped and the cap is admitted', async () => {
    const { assetGrowthRate, MEASURED_RATE } = await loadPlanning();
    const moon = assetGrowthRate({ annualisedPct: 140, yearsHeld: 2 }, { assumptionPct: 11 });
    check(moon.ratePct === MEASURED_RATE.maxPct, `a 140% run projected at ${moon.ratePct}`);
    check(moon.capped && moon.rawPct === 140, 'the cap was applied silently');
    const crash = assetGrowthRate({ annualisedPct: -60, yearsHeld: 4 }, { assumptionPct: 11 });
    check(crash.ratePct === MEASURED_RATE.minPct && crash.capped, `a -60% run was left at ${crash.ratePct}`);
    const honest = assetGrowthRate({ annualisedPct: -6, yearsHeld: 4 }, { assumptionPct: 11 });
    check(honest.ratePct === -6 && !honest.capped, 'an ordinary loss was distorted');
    return `clamped to ${MEASURED_RATE.minPct}..${MEASURED_RATE.maxPct}%`;
  });

  test('S3 The grid runs 2027 to 2041 and the milestones are columns in it', async () => {
    const { wealthProjection, PROJECTION_YEARS } = await loadPlanning();
    check(PROJECTION_YEARS === 15, `the horizon is ${PROJECTION_YEARS}`);
    const p = wealthProjection({ holdings: projRows(), assumptionPct: 11, startYear: 2026 });
    check(p.yearLabels[0] === 2027 && p.yearLabels[14] === 2041 && p.yearLabels.length === 15, `columns are ${p.yearLabels.join(',')}`);
    const r = p.rows.find((x) => x.id === 'p1');
    check(r.series.length === 15, 'a row does not fill the grid');
    check(r.milestones.five === r.series[4] && r.milestones.ten === r.series[9] && r.milestones.fifteen === r.series[14],
      'the milestone figures are not the year cells');
    near(r.series[0], 1000000 * 1.184, 1, 'one year of compounding');
    return `${p.yearLabels[0]}–${p.yearLabels[14]} · +5 +10 +15`;
  });

  test('S4 Nothing goes in and nothing comes out', async () => {
    const { wealthProjection, projectValue } = await loadPlanning();
    near(projectValue(1e6, 10, 15), 1e6 * Math.pow(1.1, 15), 1, 'fifteen years at 10%');
    near(projectValue(1e6, 0, 7), 1e6, 0, 'a flat rate stayed flat');
    const flat = wealthProjection({ holdings: projRows(), assumptionPct: 11, overridePct: 0, startYear: 2026 });
    check(flat.totals.series.every((v) => v === flat.totals.todayINR), 'a zero-return portfolio still moved');
    check(flat.totals.netSeries.every((v) => v === flat.totals.netTodayINR), 'net worth drifted with no growth at all');
    return 'contributions: none, withdrawals: none';
  });

  test('S5 Debts are held flat and net worth is assets minus what is owed', async () => {
    const { wealthProjection } = await loadPlanning();
    const p = wealthProjection({ holdings: projRows(), assumptionPct: 11, startYear: 2026 });
    check(p.rows.every((r) => r.id !== 'p4'), 'a liability was projected like an asset');
    near(p.totals.debtINR, 300000, 1, 'debt held flat');
    for (let n = 0; n < 15; n += 1) {
      near(p.totals.netSeries[n], p.totals.series[n] - 300000, 1, `year ${2027 + n} net worth`);
    }
    const back = p.totals.netTodayINR * Math.pow(1 + p.totals.blendedPct / 100, 15);
    near(back, p.totals.netSeries[14], p.totals.netSeries[14] * 0.002, 'the blended rate does not reproduce the end balance');
    return `blended ${p.totals.blendedPct}% a year`;
  });

  test('S6 One rate for everything overrides every asset’s own history', async () => {
    const { wealthProjection } = await loadPlanning();
    const own = wealthProjection({ holdings: projRows(), assumptionPct: 11, startYear: 2026 });
    const nine = wealthProjection({ holdings: projRows(), assumptionPct: 11, overridePct: 9, startYear: 2026 });
    check(nine.rows.every((r) => r.ratePct === 9 && r.why === 'override'), 'an override missed a row');
    check(nine.totals.netMilestones.fifteen < own.totals.netMilestones.fifteen, 'a lower rate did not lower the total');
    const zero = wealthProjection({ holdings: projRows(), assumptionPct: 11, overridePct: 0, startYear: 2026 });
    check(zero.rows.every((r) => r.ratePct === 0), 'a zero override was ignored');
    check(zero.totals.netSeries[14] === own.totals.netTodayINR, 'holding everything flat changed the balance');
    return `override reaches ${nine.rows.length} rows`;
  });

  test('S7 The awkward rows say so instead of producing a number', async () => {
    const { wealthProjection } = await loadPlanning();
    const rows = projRows({ extra: [
      { id: 'p5', name: 'No rate', category: 'other_asset', country: 'ZZ', currency: 'XTS', valueINR: null },
      { id: 'p6', name: 'Wiped out', category: 'equity', country: 'IN', currency: 'INR', valueINR: 100000, annualisedPct: -100, yearsHeld: 2 },
      { id: 'p7', name: 'Falling', category: 'equity', country: 'IN', currency: 'INR', valueINR: 100000, annualisedPct: -8, yearsHeld: 3 },
    ] });
    const p = wealthProjection({ holdings: rows, assumptionPct: 11, startYear: 2026 });
    const unpriced = p.rows.find((r) => r.id === 'p5');
    check(unpriced.priced === false && unpriced.todayINR === 0, 'an unpriced row invented a balance');
    const wiped = p.rows.find((r) => r.id === 'p6');
    check(wiped.ratePct === -15, `a -100% run was taken at ${wiped.ratePct}`);
    check(wiped.series.every((v) => Number.isFinite(v) && v >= 0), 'a negative balance factor produced NaN');
    const falling = p.rows.find((r) => r.id === 'p7');
    near(falling.series[14], 100000 * Math.pow(0.92, 15), 1, 'a shrinking asset grew');
    check(p.totals.netTodayINR === p.totals.todayINR - p.totals.debtINR, 'the totals stopped adding up');
    return 'unpriced, wiped and falling all handled';
  });

  test('S8 The analytics tab is wired and shares the projection maths', async () => {
    const view = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'analytics.js'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    check(/from '\.\.\/planning\.js'/.test(view) && /wealthProjection\(/.test(view), 'the view does its own projection maths');
    check(!/\* 1\.|\*\* (n|years)/.test(view), 'the view compounds balances itself');
    check(/analytics: \{ title: 'Wealth Analytics'/.test(app), 'the tab is not registered');
    check(/data-view="analytics"/.test(html), 'the sidebar has no Wealth Analytics button');
    check(/id="view-analytics"/.test(html), 'the view has no mount section to render into');
    // Every tab registered in app.js needs a section in index.html, or show()
    // renders into null.
    for (const [, key] of app.matchAll(/^  (\w+): \{ title:/gm)) {
      check(html.includes(`id="view-${key}"`), `view-${key} has no mount section`);
    }
    check(/id="wa-mode"/.test(view) && /id="c-proj"/.test(view), 'the controls or the chart are missing');
    check(/is-milestone/.test(view) && /sticky-name/.test(view), 'the milestone and pinned columns are missing');
    check(/nothing typed yet/.test(view), 'an empty custom rate is shown as a 0% override');
    check(/t\.liabilityCount/.test(view), 'the debt rows print even when nothing is owed');
    const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'styles.css'), 'utf8');
    for (const cls of ['.sticky-name', '.is-milestone', '.rate-chip', '.wa-plus', 'tr.row-total']) {
      check(css.includes(cls), `styles.css never defines ${cls}`);
    }
    return 'a real tab on real maths';
  });

  test('S9 The ledger’s own net worth is the projection’s starting balance', async () => {
    await reset();
    const s = await state();
    const { wealthProjection } = await loadPlanning();
    const p = wealthProjection({ holdings: s.holdings, assumptionPct: s.settings.assumptions.preRetirementReturnPct, startYear: 2026 });
    near(p.totals.netTodayINR, s.summary.netWorthINR, p.rows.length + 2, 'analytics starts somewhere other than today');
    check(p.rows.length === s.summary.assetCount, `${p.rows.length} rows projected against ${s.summary.assetCount} assets`);
    check(p.totals.netMilestones.fifteen > p.totals.netTodayINR, 'the fixture portfolio projected backwards');
    check(p.yearLabels.join(',') === '2027,2028,2029,2030,2031,2032,2033,2034,2035,2036,2037,2038,2039,2040,2041', `columns are ${p.yearLabels.join(',')}`);
    return `₹${p.totals.netTodayINR} → ₹${p.totals.netMilestones.fifteen} by 2041`;
  });

  test('S10 Nothing owed means net worth and assets are the same number', async () => {
    const { wealthProjection } = await loadPlanning();
    const withDebt = wealthProjection({ holdings: projRows(), assumptionPct: 11, startYear: 2026 });
    const clean = wealthProjection({ holdings: projRows().filter((r) => r.category !== 'liability'), assumptionPct: 11, startYear: 2026 });
    check(clean.totals.liabilityCount === 0 && clean.totals.debtINR === 0, `a debt-free ledger still found ${clean.totals.debtINR} owed`);
    check(clean.totals.netTodayINR === clean.totals.todayINR, 'the opening net worth differs from the asset total');
    check(clean.totals.netSeries.every((v, n) => v === clean.totals.series[n]), 'a year of net worth differs from the asset total');
    check(clean.totals.series.join(',') === withDebt.totals.series.join(','), 'removing a liability re-priced an asset');
    return `${clean.totals.netSeries[14]} assets and the same as net`;
  });

  // ---- T. Phone access, installing it, and the offline copy -----------------
  group('T. Phone access and the installed app');

  // The gate is plain middleware, so it can be driven with a stand-in socket:
  // a peer that is not this machine, asking for a path this machine chose. That
  // proves the rules without needing a second network interface.
  function peer(over = {}) {
    return {
      socket: { remoteAddress: over.ip || '::ffff:192.168.1.77' },
      method: over.method || 'GET',
      path: over.path || '/',
      headers: over.headers || {},
      body: over.body,
    };
  }

  function reply() {
    const out = { status: 0, cookie: '', sent: '', json: null, redirect: '', type: '', next: false };
    const res = {
      status: (c) => { out.status = c; return res; },
      setHeader: (k, v) => { if (k === 'Set-Cookie') out.cookie = String(v); return res; },
      type: (t) => { out.type = t; return res; },
      send: (b) => { out.sent = String(b); return res; },
      json: (b) => { out.json = b; out.sent = JSON.stringify(b); return res; },
      redirect: (c, to) => { out.status = c; out.redirect = to; return res; },
    };
    return { res, next: () => { out.next = true; }, out };
  }

  function phonePin(pin) {
    const salt = access.newSalt();
    return { enabled: true, salt, pinHash: access.hashPin(pin, salt), tokenEpoch: 1, setAt: '', lastUnlockedAt: '' };
  }

  test('T1 A peer that is not this machine never reaches the ledger while access is off', async () => {
    const off = { enabled: false, salt: '', pinHash: '', tokenEpoch: 1 };
    const mw = access.gate({ getAccess: () => off });
    const laptop = reply();
    mw(peer({ ip: '::ffff:127.0.0.1' }), laptop.res, laptop.next);
    check(laptop.out.next, 'loopback was blocked - the laptop could not use its own app');
    const stranger = reply();
    mw(peer(), stranger.res, stranger.next);
    check(!stranger.out.next && stranger.out.status === 403, `a stranger got ${stranger.out.status} instead of a lock page`);
    check(/Phone access is off/.test(stranger.out.sent) && /Settings/.test(stranger.out.sent), 'the lock page does not tell the owner what to do');
    check(!/"holdings"|"netWorthINR"|"pinHash"/.test(stranger.out.sent), 'the lock page carries ledger data');
    const apiCall = reply();
    mw(peer({ path: '/api/state' }), apiCall.res, apiCall.next);
    check(!apiCall.out.next && apiCall.out.status === 403 && apiCall.out.json.error, 'a stranger read the API without the PIN');
    const noApp = reply();
    mw(peer({ path: '/js/app.js' }), noApp.res, noApp.next);
    check(!noApp.out.next, 'a stranger fetched the app bundle itself');
    return 'laptop through, stranger locked';
  });

  test('T2 The PIN unlocks a phone once, and six wrong tries cool that address down', async () => {
    const acc = phonePin('4224');
    let unlocks = 0;
    const mw = access.gate({ getAccess: () => acc, onUnlock: () => { unlocks += 1; } });
    const short = reply();
    mw(peer({ method: 'POST', path: '/api/unlock', body: { pin: '12' } }), short.res, short.next);
    check(short.out.status === 400 && !short.out.next, `a 2-digit PIN was answered with ${short.out.status}`);
    const wrong = reply();
    mw(peer({ method: 'POST', path: '/api/unlock', body: { pin: '9999' } }), wrong.res, wrong.next);
    check(wrong.out.status === 401 && !wrong.out.next, 'a wrong PIN was accepted');
    const right = reply();
    mw(peer({ method: 'POST', path: '/api/unlock', body: { pin: '4224' } }), right.res, right.next);
    check(right.out.status === 200 && right.out.json.ok === true, `the right PIN got ${right.out.status}`);
    check(/^wl_device=\d+\.\d+\.[0-9a-f]+; Path=\/; HttpOnly; SameSite=Lax/.test(right.out.cookie), `cookie was "${right.out.cookie}"`);
    check(unlocks === 1, `onUnlock fired ${unlocks} times`);

    const noisy = '::ffff:192.168.1.201';
    for (let i = 0; i < access.ATTEMPTS_BEFORE_LOCK; i += 1) {
      const r = reply();
      mw(peer({ ip: noisy, method: 'POST', path: '/api/unlock', body: { pin: '0000' } }), r.res, r.next);
      check(r.out.status === 401, `attempt ${i + 1} was answered with ${r.out.status}`);
    }
    const cooled = reply();
    mw(peer({ ip: noisy, method: 'POST', path: '/api/unlock', body: { pin: '4224' } }), cooled.res, cooled.next);
    check(cooled.out.status === 429 && /Wait/.test(cooled.out.json.error), 'the right PIN worked straight after six wrong ones');
    access.clearFailures(access.normalizeIp(noisy));
    const recovered = reply();
    mw(peer({ ip: noisy, method: 'POST', path: '/api/unlock', body: { pin: '4224' } }), recovered.res, recovered.next);
    check(recovered.out.status === 200, 'the address was still frozen after the cooldown');
    return 'one cookie, six tries then a wait';
  });

  test('T3 A signed-in phone stops working the moment the PIN or the epoch changes', async () => {
    const acc = phonePin('7788');
    const token = access.mintToken(acc);
    const mw = access.gate({ getAccess: () => acc });
    const withCookie = reply();
    mw(peer({ headers: { cookie: `${access.COOKIE}=${token}` } }), withCookie.res, withCookie.next);
    check(withCookie.out.next, 'a phone holding a good cookie was locked out');
    check(Number(token.split('.')[1]) > Date.now() + 30 * 86400_000, 'the cookie does not outlive a month');

    const tampered = reply();
    const flipped = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    mw(peer({ headers: { cookie: `${access.COOKIE}=${flipped}` } }), tampered.res, tampered.next);
    check(!tampered.out.next && tampered.out.redirect === '/unlock', 'a forged cookie got through');

    acc.tokenEpoch += 1;
    const revoked = reply();
    mw(peer({ headers: { cookie: `${access.COOKIE}=${token}` } }), revoked.res, revoked.next);
    check(!revoked.out.next, 'signing every phone out left this one signed in');

    acc.tokenEpoch -= 1;
    acc.pinHash = access.hashPin('9999', acc.salt);
    const rotated = reply();
    mw(peer({ headers: { cookie: `${access.COOKIE}=${token}` } }), rotated.res, rotated.next);
    check(!rotated.out.next, 'changing the PIN left the old sessions alive');
    check(access.verifyToken(null, acc) === false && access.verifyToken('nonsense', acc) === false, 'a meaningless cookie was verified');
    return 'cookie bound to the PIN and the epoch';
  });

  test('T4 Setting the PIN over the API turns phone access on and keeps the secret home', async () => {
    await reset();
    const before = await state();
    check(before.meta.access.enabled === false && before.meta.access.hasPin === false, 'a fresh fixture starts with phone access on');
    check(before.settings.phoneAccess.salt === undefined && before.settings.phoneAccess.pinHash === undefined, 'the salt or hash was sent to the browser');
    const shape = await api('PUT', '/api/settings', { phoneAccess: { pin: 'abcd' } });
    check(shape.status === 400 && /4 to 12/.test(shape.body.error), `a letters PIN got ${shape.status}`);
    const bare = await api('PUT', '/api/settings', { phoneAccess: { enabled: true } });
    check(bare.status === 400 && /Set a PIN/.test(bare.body.error), 'access switched on with no PIN to check');
    const set = await api('PUT', '/api/settings', { phoneAccess: { pin: '4321', enabled: true } });
    check(set.status === 200 && set.body.meta.access.enabled === true && set.body.meta.access.hasPin === true, `setting a PIN failed with ${set.status}`);
    check(Array.isArray(set.body.meta.access.phoneUrls) && set.body.meta.access.tokenDays >= 30, 'the state does not say what to type on the phone');

    const stored = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'wealth-data.json'), 'utf8')).settings.phoneAccess;
    check(/^[0-9a-f]{64}$/.test(stored.pinHash), `the PIN is not hashed: ${stored.pinHash}`);
    check(!Object.values(stored).includes('4321'), 'the PIN itself is written in the ledger file');
    check(access.verifyPin('4321', stored) === true && access.verifyPin('4322', stored) === false, 'the stored hash does not answer to the PIN');

    const epoch = stored.tokenEpoch;
    const revoke = await api('POST', '/api/access/revoke');
    check(revoke.status === 200 && revoke.body.settings.phoneAccess.tokenEpoch === epoch + 1, 'revoking did not rotate the epoch');
    check(revoke.body.settings.phoneAccess.pinHash === undefined, 'revoke sent the hash back');

    const cleared = await api('PUT', '/api/settings', { phoneAccess: { pin: null } });
    check(cleared.body.meta.access.enabled === false && cleared.body.meta.access.hasPin === false, 'removing the PIN left access on');
    // Restoring a file that never had a PIN must not leave the old one live.
    const restored = await reset();
    check(restored.meta.access.enabled === false, 'an import without a PIN kept phone access on');
    return 'hashed, revocable, fail-closed';
  });

  test('T5 Every file the page asks for is in the worker’s install list', async () => {
    const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
    const listed = [...(/const SHELL = \[([\s\S]*?)\];/.exec(sw) || [, ''])[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    check(listed.length > 10, `the shell list has ${listed.length} entries`);
    for (const url of listed) {
      if (url === '/') continue;
      check(fs.existsSync(path.join(ROOT, 'public', url.slice(1))), `the worker precaches ${url}, which does not exist`);
    }
    const walk = (dir, base) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (
      d.isDirectory() ? walk(path.join(dir, d.name), `${base}/${d.name}`) : [`${base}/${d.name}`]
    ));
    const disk = walk(path.join(ROOT, 'public'), '').filter((f) => f !== '/sw.js' && f !== '/index.html');
    const missed = disk.filter((f) => !listed.includes(f));
    check(missed.length === 0, `not precached, so unusable offline: ${missed.join(', ')}`);
    check(/\/api\//.test(sw) && /pathname === '\/unlock'/.test(sw), 'the worker would serve the ledger or the PIN page from a cache');
    return `${listed.length} files in the shell`;
  });

  test('T6 The manifest, the certificate route and the tile are all real', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.webmanifest'), 'utf8'));
    check(manifest.display === 'standalone', `display is ${manifest.display}`);
    check(manifest.start_url === '/' && manifest.scope === '/', 'the app would open outside its own scope');
    const icons = manifest.icons || [];
    check(icons.some((i) => i.sizes === '192x192') && icons.some((i) => i.purpose === 'maskable'), 'no 192 or maskable icon');
    for (const icon of icons) {
      const file = path.join(ROOT, 'public', icon.src.slice(1));
      check(fs.existsSync(file), `${icon.src} is missing from disk`);
      const head = fs.readFileSync(file).subarray(0, 8);
      check(head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG', `${icon.src} is not a PNG`);
      const px = Number(String(icon.sizes).split('x')[0]);
      check(px >= 144, `${icon.src} declares ${icon.sizes}, too small for a launcher`);
    }
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    for (const hook of ['rel="manifest"', 'name="theme-color"', 'viewport-fit=cover', 'apple-touch-icon']) {
      check(html.includes(hook), `index.html never declares ${hook}`);
    }
    const res = await fetch(`${BASE}/phone-ca.pem`);
    check(res.status === 200 || res.status === 404, `the certificate route answered ${res.status}`);
    const text = await res.text();
    if (res.status === 200) check(/BEGIN CERTIFICATE/.test(text), 'the CA route served something that is not a certificate');
    else check(/make-phone-cert\.ps1/.test(text), 'a machine with no certificate does not say how to get one');
    const pair = tlsLib.material();
    if (pair) check(pair.key && pair.cert && /BEGIN (PRIVATE KEY|.*KEY)/.test(String(pair.key)), 'a half key pair was handed to the server');
    return `install list honest, ${icons.length} icons`;
  });

  test('T7 The stylesheet actually has a phone in it', async () => {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'styles.css'), 'utf8');
    const strip = (sel) => {
      const at = css.indexOf(sel);
      check(at >= 0, `${sel} is missing entirely`);
      const end = css.indexOf('\n}', at);
      return css.slice(at, end < 0 ? css.length : end);
    };
    const tablet = strip('@media (max-width: 980px)');
    check(/\.nav\s*\{[^}]*overflow-x:\s*auto/.test(tablet), 'the eleven nav items cannot wrap - the strip has to scroll');
    check(/position:\s*sticky/.test(tablet) && /z-index/.test(tablet), 'the header would scroll away under a phone thumb');
    check(/\.sidebar\s*\{[^}]*flex:\s*0 0 auto/.test(tablet), 'the sidebar keeps its desktop flex-basis, which becomes a 240px header on a phone');
    const phone = strip('@media (max-width: 640px)');
    check(/grid-template-columns:\s*1fr/.test(phone), 'the card grids stay two-column on a phone');
    check(/\.brand-sub\s*\{\s*display:\s*none/.test(phone), 'the brand tagline wraps to three lines and sets the whole header height');
    check(/env\(safe-area-inset-top\)/.test(phone) && /env\(safe-area-inset-bottom\)/.test(phone), 'no notch or gesture-bar padding on a phone');
    check(/\.modal\[hidden\]\s*\{\s*display:\s*none/.test(phone), 'the phone sheet rule overrides .modal[hidden] - a closed editor would show');
    check(/font-size:\s*16px/.test(phone), 'form text small enough that a phone zooms in on it');
    check(/\.toast\.is-warn\s*\{/.test(css), 'the offline warning has no style, so it reads as a success');
    const view = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    check(/matchMedia\('\(max-width: 980px\)'\)/.test(view), 'a phone never scrolls the nav strip to the chosen tab');
    return 'one column, sticky strip, sheet editor';
  });

  test('T8 A device with no laptop to talk to shows its last reading, marked as one', async () => {
    const o = await loadOffline();
    fakeStorage();
    check(o.loadSnapshot() === null && o.hasSnapshot() === false && o.snapshotStamp() === null, 'a reading appeared on a device that never had one');
    check(o.saveSnapshot({ meta: {} }) === false, 'a document with no holdings was stored as a ledger');
    check(o.hasSnapshot() === false, 'the refused document reached storage');
    const stored = o.saveSnapshot({ holdings: [{ id: 'h' }], summary: { netWorthINR: 5 }, meta: {} });
    check(stored === true, 'the reading was refused storage');
    const back = o.loadSnapshot();
    check(back.meta.offline === true && back.meta.offlineAt, 'the reading is not marked offline');
    check(back.holdings.length === 1, 'the reading came back with different rows');
    const at = Date.parse(back.meta.offlineAt);
    check(o.loadSnapshot({ now: at + 73 * 3600_000 }) === null, 'a three-day-old reading was still served');
    check(o.loadSnapshot({ now: at + 71 * 3600_000 }) !== null, 'a fresh reading was refused');
    check(o.snapshotStamp() === back.meta.offlineAt, 'the stamp does not match the saved reading');
    global.window.localStorage.setItem('wealth-ledger-offline-snapshot', '{ this is not json');
    check(o.loadSnapshot() === null && o.hasSnapshot() === false, 'corrupt storage was neither cleared nor thrown');
    return `${o.ageLabel(new Date(Date.now() - 45 * 60_000).toISOString())} ago reads fine`;
  });

  test('T9 The phone can read while offline but cannot write while offline', async () => {
    const view = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    check(/Offline copy - edits are disabled/.test(view), 'an offline device would accept an edit nobody can store');
    check(/saveSnapshot\(/.test(view), 'writes are not kept as the offline reading');
    check(/data\.meta\.offline/.test(view), 'the guard does not look at the offline mark the reader sets');
    check(/'fix-offline'/.test(view) && /warn/.test(view), 'the offline banner offers no way back to live figures');
    check(/isSecureContext/.test(view), 'a worker was registered on an origin that cannot install it');
    const api = fs.readFileSync(path.join(ROOT, 'public', 'js', 'api.js'), 'utf8');
    check(/savePhoneAccess/.test(api) && /revokePhones/.test(api), 'the settings card has no route to talk to');
    const settings = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'settings.js'), 'utf8');
    check(/Phone access/.test(settings) && /pa-pin/.test(settings) && /phone-ca\.pem/.test(settings), 'no card to turn the feature on');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check(/access: accessView\(\)/.test(serverSrc) && /https\.createServer/.test(serverSrc), 'the server never tells the page what a phone can reach');
    return 'read-only away from the laptop';
  });

  test('T10 The firewall helper opens the ports where the laptop actually is', async () => {
    const file = path.join(ROOT, 'phone-setup.ps1');
    check(fs.existsSync(file), 'phone-setup.ps1 is missing, so no phone can reach the laptop');
    const ps = fs.readFileSync(file, 'utf8');

    const parsed = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `$e = $null; $t = $null; [System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/\\/g, '\\\\')}', [ref]$t, [ref]$e) | Out-Null; $e.Count`,
    ], { encoding: 'utf8', timeout: 30_000 });
    if (!parsed.error) {
      const count = Number(String(parsed.stdout).trim());
      check(count === 0, `phone-setup.ps1 does not parse (${count} syntax errors) — the owner would meet a red window`);
    }

    check(/-Profile\s+\$target/.test(ps), 'the rule profile is hard-coded again, so it opens a network you are not on or none you are');
    check(/Get-NetConnectionProfile/.test(ps) && /NetworkCategory/.test(ps), 'the helper never asks which network this laptop is on');
    check(/0\.0\.0\.0\/0/.test(ps), 'it picks a category from some interface rather than the one carrying the default route');
    check(/\$target -eq 'Public'/.test(ps) && /PIN/.test(ps), 'a Public network gets these ports opened without a word of warning');
    check(/ValidateSet\([^)]*Private/.test(ps), 'there is no way to insist on a stricter profile');

    const removals = ps.match(/Remove-NetFirewallRule/g) || [];
    check(removals.length === 1, `-Remove deletes in ${removals.length} places, so it reaches past the rules this script made`);
    check(/-DisplayName \$name[^\n]*\|[^\n]*Remove-NetFirewallRule/.test(ps), '-Remove does not go through the names this script created');
    check(!/Stop-Process|taskkill/.test(ps), 'the firewall helper kills processes');
    check(!/server\.js/.test(ps), 'the firewall helper also starts or stops the ledger itself');
    return 'profile follows the network, undo is scoped';
  });

  test('T11 The signing key a phone reads is the one declared here, and nothing more', async () => {
    // A Trusted Web Activity only opens the site full screen when the origin
    // publishes this package name plus this key hash. Two things can therefore
    // go wrong: nothing published, or something published that leaks the ledger.
    await reset();
    const before = await state();
    check(before.meta.access.apk === null, 'a fresh fixture already vouches for an APK');
    check(before.meta.access.linkPath === '/.well-known/assetlinks.json', 'the page does not say where Chrome looks');

    const undeclared = await fetch(`${BASE}/.well-known/assetlinks.json`);
    check(undeclared.status === 404, `an undeclared ledger answered ${undeclared.status} instead of refusing`);

    const hex = crypto.createHash('sha256').update('wealth-ledger-keystore').digest('hex');
    const colon = (hex.match(/../g) || []).join(':').toUpperCase();

    const set = await api('PUT', '/api/settings', { phoneAccess: { apk: { package: 'com.example.ledger', fingerprints: [hex] } } });
    check(set.status === 200, `declaring an APK was refused with ${set.status}`);
    check(set.body.meta.access.apk.package === 'com.example.ledger', 'the package name did not come back');
    check(set.body.meta.access.apk.fingerprints[0] === colon, `the key was not normalized to what Chrome expects: ${set.body.meta.access.apk.fingerprints[0]}`);

    const file = await fetch(`${BASE}/.well-known/assetlinks.json`);
    check(file.status === 200, `the declared file answered ${file.status}`);
    check(/application\/json/.test(file.headers.get('content-type') || ''), 'assetlinks was not served as JSON');
    const doc = await file.json();
    check(Array.isArray(doc) && doc.length === 1, 'the file is not the one-entry array the verifier reads');
    check(doc[0].relation.join('|') === 'delegate_permission/common.handle_all_urls', 'the relation is wrong, so the APK opens a browser tab');
    check(doc[0].target.namespace === 'android_app' && doc[0].target.platform === 'android_app', 'the target does not name an Android app');
    check(doc[0].target.package_name === 'com.example.ledger', 'the file announces a different app than was declared');
    check(doc[0].target.sha256_cert_fingerprints.join('|') === colon, 'the file rewrites the key hash');
    const sent = JSON.stringify(doc);
    check(!/holdings|netWorthINR|pinHash|"salt"|4321/.test(sent), 'the file a stranger can read carries ledger data');

    const stored = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'wealth-data.json'), 'utf8')).settings.phoneAccess;
    check(stored.apk.package === 'com.example.ledger', 'the declaration was not written to the ledger file');

    const kept = store.merge(store.blankDb(), { settings: { phoneAccess: { apk: { package: 'com.a.b', fingerprints: [hex] } } } });
    check(access.normalizeApk(kept.settings.phoneAccess.apk) !== null, 'a merge threw the declaration away');

    const badName = await api('PUT', '/api/settings', { phoneAccess: { apk: { package: 'ledger', fingerprints: [hex] } } });
    check(badName.status === 400 && /com\.you\.ledger/.test(badName.body.error), `an app id with no dot got ${badName.status}`);
    const badKey = await api('PUT', '/api/settings', { phoneAccess: { apk: { package: 'com.example.ledger', fingerprints: ['nonsense'] } } });
    check(badKey.status === 400, 'a key hash that is not 64 hex digits was stored');
    const noKey = await api('PUT', '/api/settings', { phoneAccess: { apk: { package: 'com.example.ledger' } } });
    check(noKey.status === 400, 'a declaration with no signing key was accepted');
    const still = await state();
    check(still.meta.access.apk.fingerprints[0] === colon, 'a refused declaration wiped the one that worked');

    check(access.normalizeFingerprint('  ' + hex + ' ') === colon, 'spaces were not trimmed before normalizing');
    check(access.normalizeFingerprint(colon) === colon, 'an already-normalized key was rejected');
    check(access.normalizeFingerprint(hex.slice(0, 62)) === null, 'a short key hash became a declaration');
    check(access.assetLinksDoc(null) === null, 'an empty declaration produced a document');

    const cleared = await api('PUT', '/api/settings', { phoneAccess: { apk: null } });
    check(cleared.status === 200 && cleared.body.meta.access.apk === null, `removing the declaration got ${cleared.status}`);
    const gone = await fetch(`${BASE}/.well-known/assetlinks.json`);
    check(gone.status === 404, 'a withdrawn key is still published');

    // The verifier is a phone that has not entered a PIN, so this route has to
    // sit ahead of the gate - and only ahead of it for this one path.
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const linkAt = serverSrc.indexOf("app.get('/.well-known/assetlinks.json'");
    check(linkAt > 0, 'server.js has no assetlinks route');
    check(linkAt < serverSrc.indexOf('access.gate('), 'the assetlinks route sits behind the PIN, so no app can ever verify');
    check(serverSrc.indexOf('app.get("/phone-ca.pem"') < linkAt || serverSrc.indexOf("app.get('/phone-ca.pem'") < linkAt, 'the certificate download moved behind the gate');
    const view = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'settings.js'), 'utf8');
    check(/apkBlock\(a\)/.test(view) && /pa-apk-package/.test(view) && /pa-apk-fingerprint/.test(view), 'the settings page cannot record a signing key');
    check(/savePhoneAccess\(\{ apk: \{ package: packageName/.test(view), 'the declaration is not saved through the phone access route');
    check(/apk: null/.test(view), 'nothing on the page can withdraw a declaration once it is right');
    return 'one key hash published, no ledger field, ahead of the gate';
  });

  test('T12 The APK builder leaves the ledger alone and keeps its signing key', async () => {
    const file = path.join(ROOT, 'make-apk.ps1');
    // The published copy ships the web app and not the Android builder, so that copy's own
    // suite says there is nothing to inspect rather than calling the absence a failure.
    if (!fs.existsSync(file)) return 'the Android builder is not part of this copy, so nothing to check';
    const ps = fs.readFileSync(file, 'utf8');

    const parsed = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `$e = $null; $t = $null; [System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/\\/g, '\\\\')}', [ref]$t, [ref]$e) | Out-Null; $e.Count`,
    ], { encoding: 'utf8', timeout: 30_000 });
    if (!parsed.error) {
      const count = Number(String(parsed.stdout).trim());
      check(count === 0, `make-apk.ps1 does not parse (${count} syntax errors) - the build would die on a typo`);
    }

    check(!/wealth-data\.json|WEALTH_DATA_DIR/.test(ps), 'the builder writes to or points at the live ledger file');
    check(/-package-id', \$PackageId/.test(ps), 'the Android package name is left to a tool that derives it from an IP address');
    check(/NODE_EXTRA_CA_CERTS\s*=\s*\$CA/.test(ps), 'Node was not told to trust this laptop certificate, so the manifest fetch fails');
    check(/\$ErrorActionPreference = 'Continue'/.test(ps), "a npm or java note on stderr ends the build: a merged 2>&1 pipe is a terminating error under 'Stop'");
    check(/WindowsApps\\winget\.exe/.test(ps), 'the script assumes winget is on PATH - on this PC it is installed and is not');
    check(/Find-Choco/.test(ps) && /chocolatey/.test(ps), 'the script offers no second installer for a machine winget cannot reach');
    check(/-not \$keytool -and \$Bootstrap -and \$winget/.test(ps), 'the script installs a JDK without being asked to');
    check(/-genkeypair/.test(ps) && /'-validity', '10950'/.test(ps), 'the signing key is short-lived, so the app stops updating in place');
    check(/if \(Test-Path \$KEYFILE\)/.test(ps), 'every rebuild makes a new signing key, and Android then refuses the update');
    check(/Test-Path \$pemPath[\s\S]{0,90}Remove-Item \$pemPath/.test(ps), 'keytool will not overwrite the exported certificate, so a retried build dies at that step');
    check(/node_modules\\\.bin\\bubblewrap\.cmd/.test(ps) && /npm install/.test(ps), 'the tool is fetched through npx alone, whose shared cache can be broken by an unrelated half-download');
    const uploads = ps.match(/@\('--no-tidelift-upload'\)/g) || [];
    check(uploads.length >= 2, `a build run without the flag could hand a finance APK to a third party (${uploads.length} build calls carry it)`);
    check(/Read-Host/.test(ps) && /api\/settings/.test(ps), 'the script records the key in the ledger without asking first');
    check(/Get-ChildItem[\s\S]*LastWriteTime -gt \$Started/.test(ps), 'an APK from a previous run would be passed off as the new build');
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    check(/^apk\/$/m.test(gitignore), 'the keystore and its passwords are not ignored, so a commit would leak the signing key');
    return 'builds offline of the data, reuses one key, uploads nothing';
  });

  // ---- U. Backup copies and restore ----------------------------------------
  group('U. Backup copies and restore');

  const COPIES = path.join(SANDBOX, 'backups');
  const lib = require('../server/lib/backups');
  const ledgerFile = () => JSON.parse(fs.readFileSync(path.join(SANDBOX, 'wealth-data.json'), 'utf8'));
  const ledgerHash = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(SANDBOX, 'wealth-data.json'))).digest('hex');
  const readCopy = (name) => fs.readFileSync(path.join(COPIES, name), 'utf8');
  // Only the fields a restore has to bring back untouched. Valuation extras are
  // recomputed on every read, so asserting them would test the arithmetic instead
  // of the copy.
  const shape = (rows) => JSON.stringify(rows.map((h) => [h.id, h.name, h.category, h.currency, h.valueNative, h.units, h.pricePerUnit]));

  test('U1 A copy holds the whole ledger and is written exactly as it stood', async () => {
    await reset();
    const stored = ledgerFile();
    const r = await api('POST', '/api/backups');
    check(r.status === 200, `taking a copy failed with ${r.status}`);
    const name = r.body.backup.name;
    check(lib.NAME_SHAPE.test(name), `"${name}" is not a dated copy name`);
    check(fs.existsSync(path.join(COPIES, name)), `the list says ${name} exists but the folder has no such file`);
    check(r.body.backup.reason === 'manual', `the row is labelled "${r.body.backup.reason}" for a copy the owner asked for`);
    check(r.body.backup.holdings === stored.holdings.length, `the row counts ${r.body.backup.holdings}, the ledger has ${stored.holdings.length}`);
    check(r.body.backup.takenAt && r.body.backup.bytes > 0, 'a copy row carries no time or no size');
    const doc = JSON.parse(readCopy(name));
    check(shape(doc.holdings) === shape(stored.holdings), 'the copy is not the ledger it was taken from');
    check(doc.profile && doc.settings && Array.isArray(doc.goals) && Array.isArray(doc.snapshots),
      'the copy left part of the ledger out - a restore would come back half-filled');
    check(String(doc.backup.takenAt) === String(r.body.backup.takenAt), 'the file and its row disagree about when it was taken');
    return `${name}: ${doc.holdings.length} rows, whole document`;
  });

  test('U2 Downloading a copy hands over the stored bytes, not a re-serialisation', async () => {
    await reset();
    const name = (await api('POST', '/api/backups')).body.backup.name;
    const res = await fetch(`${BASE}/api/backups/${name}`);
    const text = await res.text();
    check(res.status === 200, `the download failed with ${res.status}`);
    check(text === readCopy(name), 'what downloaded is not what is on disk, so the two cannot be the same restore');
    const disp = res.headers.get('content-disposition') || '';
    check(/attachment/.test(disp), 'the file opens in the tab instead of being saved');
    check(disp.includes(name), `the saved file is not named after the copy ("${disp}")`);
    check((res.headers.get('content-type') || '').includes('application/json'), 'a ledger arrives as text/plain');
    const absent = await fetch(`${BASE}/api/backups/wealth-backup-2000-01-01-000000-0000.json`);
    check(absent.status === 404, `a copy that does not exist answered with ${absent.status}`);
    return `${name} downloaded byte-for-byte (${text.length} chars)`;
  });

  test('U3 A wipe followed by a restore returns the same rows, ids and figures', async () => {
    await reset();
    const before = shape(ledgerFile().holdings);
    const count = JSON.parse(readCopy((await api('POST', '/api/backups')).body.backup.name)).holdings.length;
    const wiped = await api('POST', '/api/reset');
    check(wiped.status === 200 && wiped.body.holdings.length === 0, `the wipe left ${wiped.body.holdings.length} rows behind`);
    const back = await api('PUT', `/api/backups/${(await api('GET', '/api/backups')).body.backups.find((b) => b.reason === 'manual').name}/restore`);
    check(back.status === 200, `restore answered ${back.status}: ${back.text.slice(0, 140)}`);
    check(back.body.holdings.length === count, `restored ${back.body.holdings.length} rows, the copy held ${count}`);
    check(shape(ledgerFile().holdings) === before, 'the restored ledger is not the ledger that was copied');
    check(back.body.backup && back.body.backup.reason === 'before-restore',
      'restoring replaced the state on screen without keeping it, so a wrong choice is final');
    const emptied = ledgerFile();
    check(emptied.holdings.length === count, 'the file on disk and the answer disagree about the restore');
    return `${count} rows back byte for byte, displaced state kept as a copy`;
  });

  test('U4 Wipe, sample reload and import each keep a dated copy of what they destroy', async () => {
    await reset();
    const seeded = await api('POST', '/api/seed');
    check(seeded.status === 200, `sample reload failed with ${seeded.status}`);
    check(seeded.body.backup && seeded.body.backup.reason === 'before-sample', 'sample data replaced the ledger with nothing kept');
    check(seeded.body.backup.holdings === 11, `the copy holds ${seeded.body.backup.holdings} rows, the fixture has 11`);
    check(seeded.body.holdings.length > 0, 'the seeded ledger came back empty');

    const oneRow = fixtureDoc({ holdings: [holding({ id: 'h_only', name: 'Single Row', category: 'bank_account', country: 'IN', currency: 'INR', valueNative: 1 })] });
    const imported = await api('PUT', '/api/import', oneRow);
    check(imported.status === 200, `import failed with ${imported.status}`);
    check(imported.body.backup && imported.body.backup.reason === 'before-import', 'an import overwrote the ledger with no way back');
    check(imported.body.backup.holdings === seeded.body.holdings.length,
      `the copy holds ${imported.body.backup.holdings} rows but the seeded portfolio had ${seeded.body.holdings.length}`);

    const wiped = await api('POST', '/api/reset');
    check(wiped.body.backup.reason === 'before-wipe', 'the wipe did not say which copy holds what it deleted');
    check(wiped.body.backup.holdings === 1, `the wipe kept a copy of ${wiped.body.backup.holdings} rows, not the one row that was there`);
    check(wiped.body.holdings.length === 0 && wiped.body.profile.fullName === '', 'the wipe left ledger contents behind');

    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    for (const reason of ['before-wipe', 'before-sample', 'before-import', 'before-restore']) {
      check(new RegExp(`backups\\.take\\(store\\.DATA_DIR, db, '${reason}'\\)`).test(server),
        `no dated copy is taken for ${reason} - the rolling backup is overwritten by the very save that destroys it`);
    }
    await reset();
    return 'four destructive routes, four restorable before-states';
  });

  test('U5 A torn copy is listed as unreadable and refused, never half-restored', async () => {
    await reset();
    fs.mkdirSync(COPIES, { recursive: true });
    const torn = 'wealth-backup-2026-01-01-010101-aaaa.json';
    const wrong = 'wealth-backup-2026-01-01-010102-bbbb.json';
    fs.writeFileSync(path.join(COPIES, torn), '{"schemaVersion": 1, "holdings": [ {"id"');
    fs.writeFileSync(path.join(COPIES, wrong), JSON.stringify({ schemaVersion: 1, shopping: ['milk'] }));
    const untouched = ledgerHash();

    const listed = await api('GET', '/api/backups');
    check(listed.status === 200, `one unreadable file broke the listing (${listed.status})`);
    const row = listed.body.backups.find((b) => b.name === torn);
    check(row && row.corrupt === true, 'a torn copy was not flagged as unreadable in the list');
    check(row && row.holdings === 0 && row.bytes > 0, 'the row for a torn copy has no size but claims contents');

    const r1 = await api('PUT', `/api/backups/${torn}/restore`);
    check(r1.status === 400 && /not readable JSON/.test(String(r1.body.error)), `a torn copy was answered with ${r1.status}`);
    const r2 = await api('PUT', `/api/backups/${wrong}/restore`);
    check(r2.status === 400 && /no holdings array/.test(String(r2.body.error)), `a non-ledger file was answered with ${r2.status}`);
    check(ledgerHash() === untouched, 'a refused restore still wrote the ledger');

    const gone = await api('DELETE', `/api/backups/${torn}`);
    check(gone.status === 200 && !fs.existsSync(path.join(COPIES, torn)), 'an unreadable copy cannot be thrown away');
    check(!gone.body.backups.some((b) => b.name === torn), 'the deleted copy is still in the list it returns');
    const delAgain = await api('DELETE', `/api/backups/${torn}`);
    check(delAgain.status === 404, 'deleting a copy that is already gone answered ' + delAgain.status);
    await api('DELETE', `/api/backups/${wrong}`);
    check(ledgerHash() === untouched, 'deleting a copy touched the ledger');
    return 'torn file listed and refused, throwaway works, nothing half-written';
  });

  test('U6 A copy name out of a URL can only ever be a copy name', async () => {
    await reset();
    const attempts = [
      '..%2Fwealth-data.json',
      '%2e%2e%2f%2e%2e%2fserver.js',
      'wealth-backup-2026-10-10-101010-abcd.json%2f..%2f..%2fwealth-data.json',
      'wealth-backup-2026-13-45-999999-zzzz.json',
      'notes.txt',
    ];
    for (const a of attempts) {
      const res = await fetch(`${BASE}/api/backups/${a}`);
      const text = await res.text();
      check(res.status === 404, `"${a}" was answered with ${res.status}`);
      check(!/"holdings"/.test(text), `"${a}" handed over a ledger`);
    }
    const restore = await api('PUT', '/api/backups/..%2Fwealth-data.json/restore');
    check(restore.status === 404, `a restore out of the folder answered ${restore.status}`);
    const del = await api('DELETE', '/api/backups/%2e%2e%2fwealth-data.json');
    check(del.status === 404, `a delete out of the folder answered ${del.status}`);
    check(fs.existsSync(path.join(SANDBOX, 'wealth-data.json')), 'a refused delete removed the ledger anyway');

    check(lib.resolve(SANDBOX, '../wealth-data.json') === null, 'resolve() accepts a name that walks out of the folder');
    check(lib.resolve(SANDBOX, 'wealth-backup-2026-10-10-101010-abcd.json') === null, 'resolve() points at a copy that is not there');
    check(lib.resolve(SANDBOX, 'wealth-backup-2026-10-10-1010-abcd.json') === null, 'a name missing two digits of time is treated as a copy');
    check(lib.NAME_SHAPE.test('wealth-backup-2026-10-10-101010-abcd.json') === true, 'a real copy name is not recognised');
    return `${attempts.length} ways out, none of them open`;
  });

  test('U7 The copy folder stays bounded and two copies in one second can coexist', async () => {
    const scratch = path.join(__dirname, '.sandbox-copies');
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    const doc = { schemaVersion: 1, holdings: [holding({ id: 'x', name: 'X', category: 'bank_account', country: 'IN', currency: 'INR', valueNative: 1 })], goals: [] };
    const names = [];
    for (let i = 0; i < lib.KEEP + 8; i += 1) names.push(lib.take(scratch, doc, 'manual').name);
    check(new Set(names).size === names.length, 'two copies taken in the same second landed on one name, so one overwrote the other');
    const files = fs.readdirSync(lib.folderFor(scratch));
    check(files.length === lib.KEEP, `${files.length} copies left in a folder that keeps ${lib.KEEP}`);
    const kept = lib.list(scratch).map((r) => r.name);
    check(!kept.includes(names[0]) && kept.includes(names[names.length - 1]), 'the folder pruned the wrong end of the history');
    const stamps = lib.list(scratch).map((r) => r.takenAt);
    check(stamps.every((s, i) => i === 0 || stamps[i - 1] >= s), 'the copies are not listed newest first - the card shows the wrong one on top');
    check(lib.prune(scratch) === lib.KEEP, 'pruning a full folder reported a different size');
    fs.rmSync(scratch, { recursive: true, force: true });
    return `${names.length} taken, ${lib.KEEP} kept, no name collisions`;
  });

  test('U8 A device that has not entered the PIN cannot list, fetch or restore a copy', async () => {
    const acc = phonePin('3141');
    const mw = access.gate({ getAccess: () => acc });
    const routes = [
      ['GET', '/api/backups'],
      ['POST', '/api/backups'],
      ['GET', '/api/backups/wealth-backup-2026-10-10-101010-abcd.json'],
      ['PUT', '/api/backups/wealth-backup-2026-10-10-101010-abcd.json/restore'],
      ['DELETE', '/api/backups/wealth-backup-2026-10-10-101010-abcd.json'],
    ];
    for (const [method, p] of routes) {
      const r = reply();
      mw(peer({ method, path: p }), r.res, r.next);
      check(!r.out.next, `${method} ${p} reached the copies without the PIN`);
      check(r.out.status >= 400 && r.out.status < 500, `${method} ${p} answered ${r.out.status} instead of demanding the PIN`);
      check(!/"holdings"|"pinHash"/.test(r.out.sent), `${method} ${p} leaked contents into the lock answer`);
    }
    const signedIn = reply();
    mw(peer({ path: '/api/backups', headers: { cookie: `${access.COOKIE}=${access.mintToken(acc)}` } }), signedIn.res, signedIn.next);
    check(signedIn.out.next, 'a phone holding a good cookie was locked out of its own backups');

    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const gate = server.indexOf('access.gate(');
    check(gate !== -1, 'the PIN gate is no longer mounted, so every route is public');
    for (const route of ["/api/backups'", "/api/backups/:name'"]) {
      const at = server.indexOf(`'${route}`);
      check(at > gate, `a copy route (${route}) sits ahead of the gate - any device on the Wi-Fi could read a whole ledger`);
    }
    return `${routes.length} copy routes, all behind the PIN`;
  });

  test('U9 The copy list describes the files without printing the money in them', async () => {
    await reset();
    await api('POST', '/api/backups');
    const r = await api('GET', '/api/backups');
    check(r.status === 200 && Array.isArray(r.body.backups), `the listing failed with ${r.status}`);
    check(r.body.keep === lib.KEEP, `the card was told the folder keeps ${r.body.keep}, the module keeps ${lib.KEEP}`);
    check(r.body.backups.length >= 1, 'the copy just taken is not in the list');
    const text = JSON.stringify(r.body);
    for (const leak of ['"holdings":[', '"pinHash"', '"salt"', '"netWorthINR"', '"valueNative"', 'Reliance', 'Demo Nagar Flat', '1996-06-15']) {
      check(!text.includes(leak), `the list carries "${leak}" - describing a folder should not have to show its contents`);
    }
    const row = r.body.backups[0];
    check(typeof row.holdings === 'number' && typeof row.goals === 'number', 'a copy row does not count what it holds');
    check(row.bytes > 0 && row.takenAt && row.name && row.reason, 'a copy row is missing the fields the card prints');
    const names = r.body.backups.map((b) => b.name);
    check(new Set(names).size === names.length, 'two rows claim the same copy name');
    return `rows carry counts only: ${row.holdings} holdings, ${row.goals} goals, ${row.bytes} bytes`;
  });

  test('U10 The Settings page wires the whole loop: copy, download, erase, restore', async () => {
    const page = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'settings.js'), 'utf8');
    const client = fs.readFileSync(path.join(ROOT, 'public', 'js', 'api.js'), 'utf8');
    for (const m of ['listBackups', 'createBackup', 'restoreBackup', 'deleteBackup']) {
      check(client.includes(`${m}: () =>`) || client.includes(`${m}: (`), `api.js has no ${m}`);
    }
    check(/id="btn-backup-now"/.test(page) && /api\.createBackup\(\)/.test(page), 'nothing in the page takes a copy');
    check(/id="bk-list"/.test(page) && /loadBackups\(ctx\)/.test(page), 'the copy list is never read into the card');
    check(/data-copy-restore=/.test(page) && /api\.restoreBackup\(/.test(page), 'a listed copy cannot be put back');
    check(/data-copy-forget=/.test(page) && /api\.deleteBackup\(/.test(page), 'a copy cannot be thrown away');
    check(/href="\/api\/backups\/\$\{encodeURIComponent\(r\.name\)\}" download=/.test(page),
      'a copy cannot be downloaded, so the ledger has no copy that leaves the laptop');
    check(/api\.listBackups\(\)/.test(page), 'the card never asks the server what is in the folder');
    check(/ctx\.mutate\(\(\) => api\.restoreBackup/.test(page), 'a restore repaints nothing - the screens would still show the ledger it replaced');

    // The whole-ledger download and its import partner are the original ask.
    check(/href="\/api\/export" download="wealth-data\.json"/.test(page), 'the plain download-everything button is gone');
    check(/<input[^>]*type="file"[^>]*id="import-file"/.test(page) && /api\.import\(/.test(page), 'a downloaded JSON file can no longer be imported back');
    check(/getElementById\('btn-wipe'\)[\s\S]{0,900}next\.backup/.test(page), 'the wipe still says there is no undo instead of naming the copy');
    check(/getElementById\('btn-reseed'\)[\s\S]{0,900}next\.backup/.test(page), 'the sample reload does not say where the real entries went');
    check(/getElementById\('import-file'\)[\s\S]{0,900}api\.import|fileInput\.onchange[\s\S]{0,600}next\.backup/.test(page),
      'importing a file does not report the copy of what it displaced');
    check(!/there is no undo/.test(page), 'the page still claims destructive actions cannot be undone');

    const list = await api('GET', '/api/backups');
    check(list.status === 200, 'the route the card loads from is not answering');
    return 'copy, list, download, restore, delete wired; both destructive buttons name the copy';
  });
}

// ------------------------------------------------------------------- main ---

let LIVE_HASH_BEFORE = '';
// Swapped by scenarios that need the rate site to answer differently.
let metalPage = METAL_PAGE;
let bondPage = BOND_PAGE;
let metalServer = null;

function startMetalSite() {
  return new Promise((resolve) => {
    metalServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(String(req.url).startsWith('/bonds') ? bondPage : metalPage);
    });
    metalServer.listen(METAL_PORT, '127.0.0.1', resolve);
  });
}

// A scripted SMTP peer. It answers just enough of RFC 5321 for the real client to
// complete a dialogue, and records what it was handed so the scenarios can assert
// on the transcript instead of trusting the client's own account of it.
let smtpServer = null;
let smtpMode = 'ok';
let smtpLog = { lines: [], data: '', user: '', pass: '' };

function smtpReset(mode = 'ok') {
  smtpMode = mode;
  smtpLog = { lines: [], data: '', user: '', pass: '' };
}

function startSmtpSite() {
  return new Promise((resolve) => {
    smtpServer = net.createServer((sock) => {
      sock.on('error', () => { /* a client that hangs up first is not a test failure */ });
      let buf = '';
      let awaiting = null;
      let inData = false;
      sock.write('220 smtp.test ESMTP ready\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        let nl;
        while ((nl = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              sock.write('250 2.0.0 message queued\r\n');
            } else {
              smtpLog.data += `${line}\r\n`;
            }
            continue;
          }
          smtpLog.lines.push(line);
          if (awaiting === 'user') {
            smtpLog.user = line;
            awaiting = 'pass';
            sock.write('334 UGFzc3dvcmQ6\r\n');
            continue;
          }
          if (awaiting === 'pass') {
            smtpLog.pass = line;
            awaiting = null;
            sock.write(smtpMode === 'authfail' ? '535 5.7.8 Username and Password not accepted\r\n' : '235 2.7.0 accepted\r\n');
            continue;
          }
          if (smtpMode === 'drop') { sock.end(); return; }
          const up = line.toUpperCase();
          if (up.startsWith('EHLO')) sock.write('250-smtp.test\r\n250 AUTH LOGIN PLAIN\r\n');
          else if (up.startsWith('HELO')) sock.write('250 smtp.test\r\n');
          else if (up === 'AUTH LOGIN') { awaiting = 'user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
          else if (up.startsWith('MAIL FROM')) sock.write('250 sender ok\r\n');
          else if (up.startsWith('RCPT TO')) sock.write(smtpMode === 'norelay' ? '550 5.7.1 relay denied\r\n' : '250 recipient ok\r\n');
          else if (up === 'DATA') { inData = true; smtpLog.data = ''; sock.write('354 send body\r\n'); }
          else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 ok\r\n');
        }
      });
    });
    smtpServer.listen(SMTP_PORT, '127.0.0.1', resolve);
  });
}

async function waitForServer(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  if (!fs.existsSync(LIVE_FILE)) throw new Error(`live ledger not found at ${LIVE_FILE}`);
  LIVE_HASH_BEFORE = crypto.createHash('sha256').update(fs.readFileSync(LIVE_FILE)).digest('hex');

  fs.mkdirSync(SANDBOX, { recursive: true });
  // Every fixture import now keeps a dated copy, so the folder has to start empty
  // or the second run of this suite inherits the first run's history.
  fs.rmSync(path.join(SANDBOX, 'backups'), { recursive: true, force: true });
  fs.rmSync(path.join(__dirname, '.sandbox-copies'), { recursive: true, force: true });
  fs.writeFileSync(path.join(SANDBOX, 'wealth-data.json'), JSON.stringify(fixtureDoc(), null, 2));
  await startMetalSite();
  await startSmtpSite();

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      WEALTH_TLS_PORT: String(PORT + 43),
      WEALTH_DATA_DIR: SANDBOX,
      WEALTH_METAL_RATES_URL: `http://127.0.0.1:${METAL_PORT}/rates`,
      WEALTH_BOND_DIRECTORY_URL: `http://127.0.0.1:${METAL_PORT}/bonds`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  let exitCode = 0;
  try {
    if (!(await waitForServer(20000))) {
      console.error('Test server never became ready.\n' + serverLog);
      process.exit(1);
    }
    defineScenarios();
    for (const t of results) {
      try {
        t.detail = (await t.fn()) || 'passed';
        t.ok = true;
      } catch (err) {
        t.ok = false;
        t.detail = err instanceof Fail ? err.message : `${err.name}: ${err.message}`;
      }
      console.log(`${t.ok ? 'PASS' : 'FAIL'}  ${t.name}\n      ${t.detail}`);
    }
  } finally {
    server.kill();
    metalServer?.close();
    smtpServer?.close();
    fs.rmSync(PLANNING_SHIM, { force: true });
    fs.rmSync(FORMAT_SHIM, { force: true });
    fs.rmSync(CORRUPT, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} scenarios passed, ${failed} failed.`);
  writeReport(results, passed, failed, serverLog);
  exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(exitCode), 300);
}

function writeReport(rows, passed, failed, serverLog) {
  const lines = [
    '# Functional test results',
    '',
    `Run ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC — ${passed}/${rows.length} passed, ${failed} failed.`,
    '',
    'Every scenario ran against `test/.sandbox/wealth-data.json`, a synthetic ledger with a',
    'known portfolio, on a private port. The live `data/wealth-data.json` was hashed before',
    'and after (scenario I9) and is byte-identical.',
    '',
    '| Scenario | Result | What it proved |',
    '| --- | --- | --- |',
  ];
  rows.forEach((r) => {
    lines.push(`| **${r.group}** — ${r.name.replace(/^\w+\d+\s+/, '')} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail.replace(/\|/g, '/')} |`);
  });
  if (failed) {
    lines.push('', '## Failures', '');
    rows.filter((r) => !r.ok).forEach((r) => lines.push(`- **${r.name}** — ${r.detail}`));
  }
  lines.push('', '## Sandbox server log', '', '```', serverLog.trim().split('\n').slice(-12).join('\n'), '```', '');
  fs.writeFileSync(path.join(__dirname, 'results.md'), lines.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
