const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const store = require('./server/lib/store');
const access = require('./server/lib/access');
const backups = require('./server/lib/backups');
const tls = require('./server/lib/tls');
const fx = require('./server/lib/fx');
const prices = require('./server/lib/prices');
const metals = require('./server/lib/metals');
const bonds = require('./server/lib/bonds');
const valuation = require('./server/lib/valuation');
const income = require('./server/lib/income');
const analysis = require('./server/lib/analysis');
const healthEngine = require('./server/lib/health');
const report = require('./server/lib/report');
const mailer = require('./server/lib/mailer');
const { seed } = require('./server/lib/seed');

const PORT = Number(process.env.PORT) || 3000;
// Chrome only lets a page be installed as an app from a secure origin, and a LAN
// http address does not qualify, so the phone-facing listener is https.
const TLS_PORT = Number(process.env.WEALTH_TLS_PORT) || 3443;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Set once the secure socket has actually opened; null means phones get http only.
let secureServer = null;

let db = loadOrCreate();
let lastFxRefresh = { ok: null, error: null, at: null };
let lastPriceRefresh = { ok: null, error: null, at: null, updated: 0, skipped: [] };

function loadOrCreate() {
  let loaded = null;
  try {
    loaded = store.read();
  } catch (err) {
    console.error(`[store] Could not parse ${store.DB_FILE}: ${err.message}`);
    console.error('[store] Refusing to overwrite. Fix or move the file, then restart.');
    process.exit(1);
  }
  if (loaded) {
    console.log(`[store] Loaded ${loaded.holdings.length} holdings from ${store.DB_FILE}`);
    return loaded;
  }
  console.log('[store] No data file found - creating an empty ledger.');
  const fresh = store.blankDb();
  return store.write(fresh);
}

function save() {
  const { holdings } = valuation.enrich(db);
  const summary = valuation.summarize(holdings);
  const { snapshots, created, period } = valuation.upsertSnapshot(db.snapshots, summary);
  db.snapshots = snapshots;
  db = store.write(db);
  if (created) console.log(`[snapshot] Recorded net worth for ${period}.`);
  return summary;
}

// Seeding replaces the portfolio, so it must also replace the goals and target
// weights that reference it - otherwise a reseed leaves orphaned links behind.
function installSeed(target, s) {
  target.profile = { ...target.profile, ...s.profile };
  target.holdings = s.holdings.map((h) => store.normalizeHolding(h));
  target.goals = s.goals.map((g) => store.normalizeGoal(g));
  target.settings.targetAllocation = { ...s.settings.targetAllocation };
  return target;
}

async function refreshRates({ force = false } = {}) {
  try {
    const live = await fx.fetchLiveRates();
    fx.applyLiveRates(db.settings.fx, live);
    db.fxDate = Object.values(live)[0]?.asOf || null;
    lastFxRefresh = { ok: true, error: null, at: new Date().toISOString() };
    save();
    console.log(`[fx] Refreshed ${Object.keys(live).length} rates (as of ${db.fxDate}).`);
    return { ok: true, count: Object.keys(live).length, asOf: db.fxDate };
  } catch (err) {
    lastFxRefresh = { ok: false, error: err.message, at: new Date().toISOString() };
    console.warn(`[fx] Refresh failed${force ? '' : ' (expected offline)'}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// One write for the whole batch: pricing twelve positions with twelve saves
// would rotate the backup twelve times and leave a half-priced ledger if it
// stopped part way.
async function refreshPrices({ ids = null } = {}) {
  const wanted = ids ? new Set(ids.map(String)) : null;
  const pool = wanted ? db.holdings.filter((h) => wanted.has(h.id)) : db.holdings;
  const equity = pool.filter(prices.isTrackable);
  const metal = pool.filter(metals.isTrackable);
  const bond = pool.filter(bonds.isTrackable);
  if (!equity.length && !metal.length && !bond.length) {
    return { ok: true, updated: [], skipped: [], note: nothingToPriceNote(pool) };
  }

  // Settled, not all: the three feeds are unrelated sites, and a dead one must
  // not hold the other's prices back.
  const settled = await Promise.allSettled([
    equity.length ? prices.fetchQuotes(equity.map(prices.resolveSymbol), { alternates: prices.alternatesFor(equity) }) : null,
    metal.length ? metals.fetchRates() : null,
    bond.length ? bonds.fetchQuotes() : null,
  ]);
  const errors = settled.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  const feed = settled[0].status === 'fulfilled' ? settled[0].value : null;
  let rates = db.metalRates || null;
  if (settled[1].status === 'fulfilled' && settled[1].value) {
    rates = settled[1].value;
    db.metalRates = { ...rates, fetchedAt: new Date().toISOString() };
  }
  const bondFeed = settled[2].status === 'fulfilled' ? settled[2].value : null;

  const updated = [];
  const skipped = [];
  for (const part of [
    feed ? prices.applyQuotes(pool, feed) : null,
    metal.length && rates ? metals.applyRates(pool, rates) : null,
    bond.length && bondFeed ? bonds.applyQuotes(pool, bondFeed) : null,
  ]) {
    if (!part) continue;
    updated.push(...part.updated);
    skipped.push(...part.skipped);
  }

  const fetches = (equity.length ? 1 : 0) + (metal.length ? 1 : 0) + (bond.length ? 1 : 0);
  const requested = equity.length + metal.length + bond.length;
  const answered = errors.length < fetches;
  if (answered) {
    db.priceRefreshedAt = new Date().toISOString();
    lastPriceRefresh = {
      ok: !errors.length,
      error: errors.join('; ') || null,
      at: db.priceRefreshedAt,
      updated: updated.length,
      skipped,
    };
    save();
    console.log(`[prices] ${updated.length} of ${requested} tracked holdings repriced${skipped.length ? `, ${skipped.length} skipped` : ''}${errors.length ? `, feeds failed: ${errors.join('; ')}` : ''}.`);
  } else {
    lastPriceRefresh = { ok: false, error: errors.join('; '), at: new Date().toISOString(), updated: 0, skipped: [] };
    console.warn(`[prices] Refresh failed: ${errors.join('; ')}`);
  }
  // ok means "something was written", not "every feed answered" - a dead Yahoo
  // must not turn a successful bullion reprice into a client-side error.
  return { ok: answered, updated, skipped, requested, errors, metals: rates, bonds: bondFeed ? { count: bondFeed.count, asOf: bondFeed.asOf } : null };
}

// Pinned rows and blank tickers both leave a batch empty, and saying the wrong
// one would send the owner looking for a field they already filled in.
function nothingToPriceNote(pool) {
  const pinned = pool.filter((h) => h.category === 'equity' && h.priceAuto === false && prices.resolveSymbol(h)).length;
  if (pinned) {
    return `Nothing to price - ${pinned} ${pinned === 1 ? 'holding is' : 'holdings are'} pinned, so the feed leaves ${pinned === 1 ? 'it' : 'them'} alone.`;
  }
  const bondless = pool.filter((h) => h.category === 'bond' && !bonds.findIsin(h)).length;
  if (bondless) {
    return `Nothing to price - ${bondless} bond ${bondless === 1 ? 'row has' : 'rows have'} no ISIN in the ticker box to look up.`;
  }
  return 'Nothing to price - no holding has a ticker, a metal rate or a bond ISIN yet.';
}

const app = express();
app.use(express.json({ limit: '4mb' }));

// A phone has to trust this certificate before it can open the address that
// hands it the certificate, so the route deliberately sits ahead of the gate.
// Safe because a CA certificate is public: the private key never leaves this
// machine, and the ledger itself still needs the PIN either way.
app.get('/phone-ca.pem', (_req, res) => {
  const m = tls.material();
  if (!m || !m.caPath) {
    return res.status(404).type('text/plain').send('No local certificate authority yet. Run make-phone-cert.ps1 on the laptop.\n');
  }
  res.set('Cache-Control', 'no-store');
  res.set('Content-Disposition', 'attachment; filename="wealth-ledger-ca.pem"');
  res.type('application/x-x509-ca-cert').sendFile(m.caPath);
});

// Chrome reads this file before it lets a signed APK (a Trusted Web Activity)
// open the site without a browser bar, and it reads it from the phone - a peer
// behind the gate. Safe to sit ahead of the PIN because the document is an
// application id and a public key hash; no amount, holding or name is in it.
app.get('/.well-known/assetlinks.json', (_req, res) => {
  const declared = db.settings.phoneAccess && db.settings.phoneAccess.apk;
  const doc = access.assetLinksDoc(declared);
  if (!doc) return res.status(404).json({ error: 'No signing certificate has been declared for an APK.' });
  res.set('Cache-Control', 'no-store');
  res.type('application/json').send(JSON.stringify(doc));
});

// Ahead of the static files and every route: a peer on the Wi-Fi that has not
// unlocked with the PIN never sees the app, only the lock or unlock page.
app.use(access.gate({
  getAccess: () => db.settings.phoneAccess,
  onUnlock: () => {
    db.settings.phoneAccess.lastUnlockedAt = new Date().toISOString();
    save();
  },
}));
// Without this, browsers apply heuristic freshness to index.html and the JS
// modules, so an update stays invisible until the cache happens to expire.
// no-cache still gets a cheap 304 back from the ETag express sends.
app.use(express.static(PUBLIC_DIR, {
  extensions: ['.html'],
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));

// A cached /api/state response would silently misreport net worth after an edit.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// The SMTP password is write-only: the browser posts it once and never sees it
// again, so a page, a log or an exported state blob cannot carry it away.
// The PIN's salt and hash get the same rule - only "is a PIN set" travels.
function publicSettings(settings) {
  const e = settings.email || {};
  const { pass, ...rest } = e;
  const { salt, pinHash, ...phoneAccess } = settings.phoneAccess || {};
  return { ...settings, email: { ...rest, hasPass: Boolean(pass) }, phoneAccess: { ...phoneAccess, hasPin: Boolean(pinHash) } };
}

// The addresses a phone can actually reach: skipped loopback, internal
// interfaces and the link-local range a machine falls back to with no DHCP.
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.internal || net.family !== 'IPv4') continue;
      if (net.address.startsWith('169.254.')) continue;
      out.push(net.address);
    }
  }
  return out.sort();
}

function accessView() {
  const a = db.settings.phoneAccess || {};
  const cert = tls.describe();
  const port = secureServer ? TLS_PORT : PORT;
  const scheme = secureServer ? 'https' : 'http';
  return {
    enabled: a.enabled === true,
    hasPin: Boolean(a.pinHash),
    setAt: a.setAt || null,
    lastUnlockedAt: a.lastUnlockedAt || null,
    port: PORT,
    urls: lanAddresses().map((ip) => `http://${ip}:${PORT}`),
    secure: Boolean(secureServer),
    securePort: secureServer ? TLS_PORT : null,
    secureUrls: secureServer ? lanAddresses().map((ip) => `https://${ip}:${TLS_PORT}`) : [],
    // What to type on the phone: the secure address whenever it is open, since
    // that is the only origin Chrome will install from.
    phoneUrls: lanAddresses().map((ip) => `${scheme}://${ip}:${port}`),
    tokenDays: access.TOKEN_DAYS,
    // What a built APK declared against this origin, and where Chrome checks it.
    apk: a.apk ? { package: a.apk.package, fingerprints: a.apk.fingerprints, declaredAt: a.apk.declaredAt || null } : null,
    linkPath: '/.well-known/assetlinks.json',
    cert: cert ? { addresses: cert.addresses, daysLeft: cert.daysLeft, expired: cert.expired, hasCa: cert.hasCa } : null,
  };
}

function emailPlan(override) {
  const e = db.settings.email || {};
  const to = String(override || e.to || db.profile.email || '').trim();
  const problems = [];
  if (!e.host) problems.push('no mail server host');
  if (!e.from && !e.user) problems.push('no sending address');
  if (e.security !== 'none' && (!e.user || !e.pass)) problems.push('no username and app password');
  if (!to) problems.push('no recipient - put an address on the Profile tab or type one in');
  const addresses = to.split(/[,\s]+/).filter(Boolean);
  const malformed = addresses.filter((a) => !/^[^\s@]+@[^\s@,]+\.[^\s@,]+$/.test(a));
  if (malformed.length) problems.push(`"${malformed[0]}" is not an email address`);
  return { to: addresses.join(', '), addresses, problems, ready: !problems.length, config: { ...e, from: e.from || e.user } };
}

function reportMessage(built, to) {
  const e = db.settings.email;
  const name = [db.profile.salutation, db.profile.fullName].filter(Boolean).join(' ');
  const failing = built.healthFailing || 0;
  const lines = [
    `${name || 'Your'} portfolio report, generated locally on this machine at ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    '',
    `Net worth: ${report.rs(built.netWorthINR)}`,
    `Gross assets: ${report.rs(built.totalAssetsINR)} across ${built.holdingCount} ${built.holdingCount === 1 ? 'position' : 'positions'}`,
    `Liabilities: ${report.rs(built.totalLiabilitiesINR)}`,
    `Liquid: ${report.rs(built.liquidAssetsINR)}`,
    '',
    `The attached PDF (${built.pages} pages) carries every position, the allocation against your targets,`,
    `the health rules with their readings, India income and tax, your goals and the retirement projection.`,
    failing ? `${failing} health ${failing === 1 ? 'rule is' : 'rules are'} failing on the recorded data - the list is on the health page of the report.`
      : 'Every portfolio health rule the ledger can apply passes on the recorded data.',
    '',
    'Figures are as at the valuation dates listed in the report. This is a reading of the ledger, not a valuation',
    'or a tax computation.',
  ];
  return {
    from: e.from || e.user,
    to,
    subject: `Portfolio report - ${report.rs(built.netWorthINR)} net worth - ${new Date().toISOString().slice(0, 10)}`,
    text: lines.join('\r\n'),
    attachment: { fileName: built.fileName, buffer: built.buffer },
  };
}

function buildPortfolioReport(body) {
  const s = state();
  const built = report.buildReport({
    state: s,
    plan: body && body.plan ? body.plan : null,
    cash: body && body.cash ? body.cash : null,
  });
  built.totalAssetsINR = s.summary.totalAssetsINR;
  built.totalLiabilitiesINR = s.summary.totalLiabilitiesINR;
  built.liquidAssetsINR = s.summary.liquidAssetsINR;
  built.healthFailing = s.portfolioHealth.counts.risk;
  return built;
}

function state() {
  const today = new Date();
  const { holdings, rates, unconverted } = valuation.enrich(db, today);
  // Lets the form show the exact symbol a row would be priced under, rather than
  // duplicating the suffix rules in the browser. Only the classes the equity feed
  // reads get one: a bond's ticker box holds an ISIN and a bullion row's a metal,
  // so a Yahoo listing for those advertises a source that prices neither.
  const priced = holdings.map((h) => ({
    ...h,
    trackedSymbol: prices.AUTO_CATEGORIES.has(h.category) ? prices.resolveSymbol(h) : null,
    altSymbol: prices.AUTO_CATEGORIES.has(h.category) ? prices.alternateSymbol(h) : null,
  }));
  const summary = valuation.summarize(priced);
  // Needs the resolved rate map, which summarize does not take: net worth stated
  // once in rupees and again in the currencies the money sits in.
  summary.netWorthByCurrency = analysis.netWorthByCurrency(summary.netWorthINR, rates);
  const age = ageFrom(db.profile.dateOfBirth, today);
  const targets = db.settings.targetAllocation;
  // Computed once and handed to both the analysis block and the health report:
  // two pages that disagree about what the portfolio weighs would be worse than
  // either one being wrong.
  const goals = analysis.goalProgress(db.goals, holdings, today);
  const allocation = analysis.allocation(holdings, targets);
  const concentration = analysis.concentration(holdings);
  const geography = analysis.geography(holdings);
  const healthScore = analysis.healthScore({ rows: holdings, profile: db.profile, targets, age });
  const plan = emailPlan();
  const emailStatus = {
    ready: plan.ready,
    problems: plan.problems,
    to: plan.to,
    autoSend: Boolean(db.settings.email.autoSend),
    host: db.settings.email.host || null,
  };
  return {
    profile: db.profile,
    settings: publicSettings(db.settings),
    holdings: priced,
    goals,
    rates,
    fxDate: db.fxDate || null,
    summary,
    snapshots: db.snapshots,
    analysis: {
      allocation,
      riskMix: analysis.riskMix(holdings),
      concentration,
      geography,
      health: healthScore,
    },
    portfolioHealth: healthEngine.portfolioHealth({
      rows: priced, profile: db.profile, settings: db.settings, age, goals,
      allocation, concentration, geography, health: healthScore, unconverted, today,
    }),
    age,
    indiaTax: income.summarise({ holdings: priced, profile: db.profile, settings: db.settings, today }),
    meta: {
      categories: store.CATEGORIES,
      categoryLabels: store.CATEGORY_LABELS,
      currencies: fx.SUPPORTED,
      fallbackRates: fx.FALLBACK_RATES,
      unconverted: unconverted.map((h) => ({ id: h.id, name: h.name, currency: h.currency })),
      dataFile: path.relative(__dirname, store.DB_FILE).replace(/\\/g, '/'),
      lastFxRefresh,
      lastPriceRefresh,
      priceRefreshedAt: db.priceRefreshedAt || null,
      metalRates: db.metalRates || null,
      metalCard: { keys: store.METAL_RATES, labels: metals.LABELS, source: metals.SOURCE_NAME },
      bondSource: bonds.SOURCE_NAME,
      email: emailStatus,
      access: accessView(),
      updatedAt: db.updatedAt,
    },
  };
}

function ageFrom(dob, on) {
  if (!dob) return null;
  const b = new Date(dob);
  if (Number.isNaN(b.getTime())) return null;
  let age = on.getFullYear() - b.getFullYear();
  const m = on.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && on.getDate() < b.getDate())) age -= 1;
  return age;
}

app.get('/api/state', (_req, res) => res.json(state()));

app.get('/api/export', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="wealth-data.json"');
  res.json(db);
});

app.put('/api/profile', (req, res) => {
  const p = req.body || {};
  const next = { ...db.profile };
  for (const key of Object.keys(next)) {
    if (!(key in p)) continue;
    if (key === 'dateOfBirth') next[key] = /^\d{4}-\d{2}-\d{2}$/.test(String(p[key] || '')) ? p[key] : '';
    else if (['dependants'].includes(key)) next[key] = clampInt(p[key], 0, 20);
    else if (key.endsWith('INR')) next[key] = clampNum(p[key], 0, 1e12);
    else if (['plannedRetirementAge', 'lifeExpectancy'].includes(key)) next[key] = clampInt(p[key], 18, 120);
    else next[key] = String(p[key] ?? '').slice(0, 400);
  }
  if (next.plannedRetirementAge > next.lifeExpectancy) {
    return res.status(400).json({ error: 'Planned retirement age must be below life expectancy.' });
  }
  db.profile = next;
  save();
  res.json(state());
});

app.put('/api/settings', (req, res) => {
  const a = req.body?.assumptions;
  if (a) {
    for (const [k, v] of Object.entries(a)) {
      if (k in db.settings.assumptions) db.settings.assumptions[k] = clampNum(v, -50, 60);
    }
  }
  if (req.body?.tax && typeof req.body.tax === 'object') {
    const t = req.body.tax;
    for (const k of Object.keys(db.settings.tax)) {
      if (!(k in t)) continue;
      if (k === 'seniorCitizen') db.settings.tax[k] = t[k] === null || t[k] === '' ? null : Boolean(t[k]);
      else if (k.endsWith('Pct')) db.settings.tax[k] = clampNum(t[k], 0, 50);
      else db.settings.tax[k] = clampNum(t[k], 0, 1e12);
    }
  }
  if (req.body?.targetAllocation && typeof req.body.targetAllocation === 'object') {
    const next = {};
    for (const [k, v] of Object.entries(req.body.targetAllocation)) {
      if (!store.CATEGORIES.includes(k)) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      next[k] = Math.min(100, Math.round(n * 10) / 10);
    }
    db.settings.targetAllocation = next;
  }
  if (typeof req.body?.baseCurrency === 'string') db.settings.baseCurrency = 'INR';
  if (req.body?.email && typeof req.body.email === 'object') {
    db.settings.email = store.normalizeEmail(db.settings.email, req.body.email);
  }
  if (req.body?.phoneAccess && typeof req.body.phoneAccess === 'object') {
    const p = req.body.phoneAccess;
    const next = { ...db.settings.phoneAccess };
    if (p.pin === null) {
      next.salt = '';
      next.pinHash = '';
      next.setAt = '';
      next.enabled = false;
    } else if (typeof p.pin === 'string' && p.pin !== '') {
      if (!access.PIN_SHAPE.test(p.pin.trim())) {
        return res.status(400).json({ error: 'A PIN has to be 4 to 12 digits.' });
      }
      next.salt = access.newSalt();
      next.pinHash = access.hashPin(p.pin.trim(), next.salt);
      next.setAt = new Date().toISOString();
      // A new PIN also retires every token minted under the old one.
      next.tokenEpoch = (next.tokenEpoch || 1) + 1;
    }
    if ('enabled' in p) next.enabled = p.enabled === true;
    if ('apk' in p) {
      const declared = access.normalizeApk(p.apk);
      if (p.apk && !declared) {
        return res.status(400).json({
          error: 'An APK declaration needs a package name like com.you.ledger and the signing certificate as 64 hex digits.',
        });
      }
      next.apk = declared;
    }
    if (next.enabled && !next.pinHash) {
      return res.status(400).json({ error: 'Set a PIN before turning phone access on.' });
    }
    db.settings.phoneAccess = store.normalizePhoneAccess(db.settings.phoneAccess, next);
  }
  save();
  res.json(state());
});

// Rotating the signing epoch retires every device cookie issued so far without
// touching the PIN, so a lost phone can be signed out from the laptop.
app.post('/api/access/revoke', (req, res) => {
  db.settings.phoneAccess.tokenEpoch = (db.settings.phoneAccess.tokenEpoch || 1) + 1;
  save();
  res.json(state());
});

app.post('/api/holdings', (req, res) => {
  const h = store.normalizeHolding(req.body || {});
  if (!h.name) return res.status(400).json({ error: 'Name is required.' });
  db.holdings.push(h);
  save();
  res.status(201).json(state());
});

app.put('/api/holdings/:id', (req, res) => {
  const idx = db.holdings.findIndex((h) => h.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Holding not found.' });
  db.holdings[idx] = store.normalizeHolding(req.body || {}, db.holdings[idx]);
  save();
  res.json(state());
});

app.delete('/api/holdings/:id', (req, res) => {
  const before = db.holdings.length;
  db.holdings = db.holdings.filter((h) => h.id !== req.params.id);
  if (db.holdings.length === before) return res.status(404).json({ error: 'Holding not found.' });
  save();
  res.json(state());
});

// One write for many rows. Ten separate deletes would rotate the backup ten
// times and could stop half way through, leaving a part-applied batch.
app.post('/api/holdings/bulk-delete', (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Send an ids array to delete.' });
  }
  const wanted = new Set(ids.map(String));
  const remaining = db.holdings.filter((h) => !wanted.has(h.id));
  const removed = db.holdings.length - remaining.length;
  if (!removed) return res.status(404).json({ error: 'None of those holdings exist.' });
  db.holdings = remaining;
  save();
  res.json({ ...state(), bulkResult: { removed, requested: wanted.size } });
});

app.post('/api/goals', (req, res) => {
  const g = store.normalizeGoal(req.body || {});
  if (!g.name) return res.status(400).json({ error: 'Goal name is required.' });
  if (!(g.targetAmountINR > 0)) return res.status(400).json({ error: 'Set a corpus target above zero.' });
  db.goals.push(g);
  save();
  res.status(201).json(state());
});

app.put('/api/goals/:id', (req, res) => {
  const idx = db.goals.findIndex((g) => g.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Goal not found.' });
  db.goals[idx] = store.normalizeGoal(req.body || {}, db.goals[idx]);
  if (!db.goals[idx].name) return res.status(400).json({ error: 'Goal name is required.' });
  save();
  res.json(state());
});

app.delete('/api/goals/:id', (req, res) => {
  const before = db.goals.length;
  db.goals = db.goals.filter((g) => g.id !== req.params.id);
  if (db.goals.length === before) return res.status(404).json({ error: 'Goal not found.' });
  save();
  res.json(state());
});

app.post('/api/fx/refresh', async (_req, res) => {
  const result = await refreshRates({ force: true });
  res.status(result.ok ? 200 : 502).json({ ...state(), fxResult: result });
});

// Optional ids lets the toolbar reprice just the ticked rows; with no body it
// covers every tickered equity and every opted-in metal row.
app.post('/api/prices/refresh', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) && req.body.ids.length ? req.body.ids : null;
  const result = await refreshPrices({ ids });
  res.status(result.ok ? 200 : 502).json({ ...state(), priceResult: result });
});

// Pinning a rate makes it authoritative until it is cleared back to null.
app.put('/api/fx/:code', (req, res) => {
  const code = String(req.params.code).toUpperCase();
  if (!fx.SUPPORTED.includes(code)) return res.status(400).json({ error: `Unsupported currency ${code}.` });
  const entry = db.settings.fx[code] || {};
  const raw = req.body?.manualRate;
  if (raw === null || raw === '' || raw === undefined) {
    delete entry.manualRate;
    delete entry.pinnedOn;
  } else {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'Rate must be a positive number.' });
    entry.manualRate = n;
    entry.pinnedOn = new Date().toISOString().slice(0, 10);
  }
  db.settings.fx[code] = entry;
  save();
  res.json(state());
});

app.post('/api/snapshot', (_req, res) => {
  const { holdings } = valuation.enrich(db);
  const summary = valuation.summarize(holdings);
  const period = new Date().toISOString().slice(0, 7);
  db.snapshots = valuation.upsertSnapshot(db.snapshots, summary).snapshots.map((s) =>
    s.period === period ? { ...s, recordedAt: new Date().toISOString() } : s
  );
  save();
  res.json({ ...state(), snapshotResult: { period, netWorthINR: summary.netWorthINR } });
});

app.post('/api/seed', (_req, res) => {
  // Replacing the ledger with samples is as destructive as wiping it, so the real
  // state goes into a dated copy first and the route names that copy back.
  const kept = backups.take(store.DATA_DIR, db, 'before-sample');
  const fresh = store.blankDb();
  fresh.settings.fx = db.settings.fx;
  db = installSeed(fresh, seed());
  save();
  res.json({ ...state(), backup: kept });
});

app.post('/api/reset', (_req, res) => {
  // The rolling backup file is overwritten by the save that performs this wipe,
  // so it holds nothing worth recovering. A dated copy is taken first and its
  // name is sent back, because "what did I just delete?" needs an answer.
  const kept = backups.take(store.DATA_DIR, db, 'before-wipe');
  const fresh = store.blankDb();
  fresh.settings.fx = db.settings.fx;
  db = fresh;
  save();
  res.json({ ...state(), backup: kept });
});

// A backup restore path: paste the full exported document back in.
app.put('/api/import', (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.holdings)) {
    return res.status(400).json({ error: 'Expected a full exported document with a holdings array.' });
  }
  try {
    const kept = backups.take(store.DATA_DIR, db, 'before-import');
    db = store.merge(store.blankDb(), JSON.parse(JSON.stringify(incoming)));
    save();
    res.json({ ...state(), backup: kept });
  } catch (err) {
    return res.status(400).json({ error: `Import failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------- backups ---
// A stored copy is the entire ledger, PIN hash included, so these stay behind the
// phone gate with every other /api route: a device that has not unlocked the
// ledger cannot list, fetch or restore one.

app.get('/api/backups', (_req, res) => res.json({ backups: backups.list(store.DATA_DIR), keep: backups.KEEP }));

app.post('/api/backups', (_req, res) => {
  const row = backups.take(store.DATA_DIR, db, 'manual');
  res.json({ backup: row, backups: backups.list(store.DATA_DIR), keep: backups.KEEP });
});

app.get('/api/backups/:name', (req, res) => {
  const body = backups.raw(store.DATA_DIR, req.params.name);
  if (body === null) return res.status(404).json({ error: 'There is no backup copy with that name.' });
  res.set({
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="${req.params.name}"`,
  });
  res.send(body);
});

app.put('/api/backups/:name/restore', (req, res) => {
  const body = backups.raw(store.DATA_DIR, req.params.name);
  if (body === null) return res.status(404).json({ error: 'There is no backup copy with that name.' });
  let doc;
  try {
    doc = JSON.parse(body);
  } catch (err) {
    return res.status(400).json({ error: `That copy is not readable JSON: ${err.message}` });
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.holdings)) {
    return res.status(400).json({ error: 'That copy has no holdings array, so it is not a ledger and will not be restored.' });
  }
  // Restoring replaces everything, including the copy being restored from if it is
  // the wrong one, so the state it displaces is kept first.
  const safety = backups.take(store.DATA_DIR, db, 'before-restore');
  db = store.merge(store.blankDb(), doc);
  save();
  res.json({ ...state(), backup: safety });
});

app.delete('/api/backups/:name', (req, res) => {
  if (!backups.remove(store.DATA_DIR, req.params.name)) {
    return res.status(404).json({ error: 'There is no backup copy with that name.' });
  }
  res.json({ backups: backups.list(store.DATA_DIR), keep: backups.KEEP });
});

// Downloading stays local; the retirement block arrives from the browser because
// planning.js owns that arithmetic and a second copy here could disagree with the
// Retirement tab the user is looking at.
app.post('/api/report/pdf', (req, res) => {
  let built;
  try {
    built = buildPortfolioReport(req.body);
  } catch (err) {
    return res.status(500).json({ error: `Could not build the report: ${err.message}` });
  }
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${built.fileName}"`,
    'Content-Length': String(built.buffer.length),
    'X-Report-Pages': String(built.pages),
    'X-Report-Sections': String(built.sections.length),
  });
  res.send(built.buffer);
});

// Sent only when the owner asks. The full portfolio leaves this machine through a
// mail provider, so a half-configured SMTP block answers with what is missing
// instead of failing quietly after a download the user already waited for.
app.post('/api/report/email', async (req, res) => {
  const plan = emailPlan(req.body && req.body.to ? req.body.to : null);
  if (!plan.ready) {
    return res.status(400).json({ error: `Emailing is not set up yet - ${plan.problems.join('; ')}.`, problems: plan.problems });
  }
  let built;
  try {
    built = buildPortfolioReport(req.body);
  } catch (err) {
    return res.status(500).json({ error: `Could not build the report: ${err.message}` });
  }
  try {
    const sent = await mailer.sendMail(plan.config, reportMessage(built, plan.to));
    res.json({
      ok: true,
      to: plan.to,
      fileName: built.fileName,
      pages: built.pages,
      bytes: built.buffer.length,
      sentBytes: sent.bytes,
      host: sent.host,
      port: sent.port,
      security: sent.security,
    });
  } catch (err) {
    const replies = (err.replies || []).slice(-2).join(' / ');
    const reason = err.message || 'the mail server did not answer';
    res.status(502).json({
      error: `The mail server refused the report: ${reason}${replies ? ` (its last replies: ${replies})` : ''}`,
      step: err.step || 'send',
    });
  }
});

function clampNum(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function clampInt(v, lo, hi) {
  return Math.round(clampNum(v, lo, hi));
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));
app.get('*', (_req, res) => {
  const index = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(500).send('public/index.html is missing.');
});

const REFRESH_HOURS = 12;
const PRICE_REFRESH_HOURS = 6;

function pricesStale() {
  return Date.now() - Date.parse(db.priceRefreshedAt || 0) > PRICE_REFRESH_HOURS * 3600_000;
}

// A missing certificate or a taken port must never stop the ledger from
// booting, so this resolves to null instead of throwing.
function openSecure() {
  const m = tls.material();
  if (!m) {
    console.log('[tls] No certs/ certificate - the phone can browse but cannot install the app. Run make-phone-cert.ps1.');
    return Promise.resolve(null);
  }
  const server = https.createServer({ key: m.key, cert: m.cert }, app);
  return new Promise((resolve) => {
    server.once('error', (err) => {
      console.warn(`[tls] Port ${TLS_PORT} stayed shut (${err.code || err.message}); the http address still works.`);
      resolve(null);
    });
    server.once('listening', () => resolve(server));
    server.listen(TLS_PORT);
  });
}

(async function start() {
  const stale = !db.fxDate || Date.now() - Date.parse(db.settings.fx?.USD?.fetchedAt || 0) > REFRESH_HOURS * 3600_000;
  if (stale) await refreshRates();
  else console.log(`[fx] Using cached rates from ${db.fxDate}.`);

  if (!db.holdings.length && !process.argv.includes('--keep-empty')) {
    console.log('[store] Ledger is empty - seeding the sample portfolio. Edit or reset from Settings.');
    installSeed(db, seed());
    save();
  }

  secureServer = await openSecure();

  app.listen(PORT, () => {
    const view = accessView();
    const open = db.settings.phoneAccess?.enabled;
    console.log(`\n  Wealth Ledger  ->  http://localhost:${PORT}\n  Data file      ->  ${store.DB_FILE}`
      + `\n  On your phone  ->  ${view.phoneUrls.join('  or  ')}`
      + `${open ? '' : '  (phone access off: it asks for a PIN)'}\n`
      + `${view.secure ? '  Install as an app from the https address above.\n' : '  No https listener, so the phone can browse but not install.\n'}`);
    // Deliberately after the port opens: the desktop launcher polls it before
    // it opens the browser, so a slow quote feed must not delay boot.
    if (pricesStale()) refreshPrices();
  });
})();

setInterval(() => refreshRates(), REFRESH_HOURS * 3600_000).unref();
setInterval(() => refreshPrices(), PRICE_REFRESH_HOURS * 3600_000).unref();
