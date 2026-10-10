const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const access = require('./access');

// WEALTH_DATA_DIR lets an isolated instance run against its own folder, so a
// test run can never reach the live ledger.
const DATA_DIR = process.env.WEALTH_DATA_DIR
  ? path.resolve(process.env.WEALTH_DATA_DIR)
  : path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'wealth-data.json');
const BACKUP_FILE = path.join(DATA_DIR, 'wealth-data.backup.json');

const CATEGORIES = [
  'bank_account',
  'fixed_deposit',
  'equity',
  'bond',
  'policy',
  'gold_commodity',
  'real_estate',
  'retirement_scheme',
  'other_asset',
  'liability',
];

const CATEGORY_LABELS = {
  bank_account: 'Bank accounts',
  fixed_deposit: 'Fixed deposits',
  equity: 'Equity',
  bond: 'Bonds',
  policy: 'Investment policies',
  gold_commodity: 'Gold & commodities',
  real_estate: 'Real estate',
  retirement_scheme: 'Pension schemes (EPF/NPS/PPF)',
  other_asset: 'Other assets',
  liability: 'Liabilities',
};

// Opt-in per-gram bullion rates for a gold_commodity row. Absent means the
// owner values the row by hand, which is what SGBs and gold ETFs need.
const METAL_RATES = ['gold22', 'gold24', 'silver'];

// Assets that a retiree can realistically draw on inside a year without a
// discount haircut. Used by the dashboard liquidity gauge.
const LIQUID_CATEGORIES = new Set(['bank_account', 'fixed_deposit', 'equity', 'bond', 'retirement_scheme', 'other_asset']);

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function blankDb() {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    profile: {
      salutation: '',
      fullName: '',
      dateOfBirth: '',
      nationality: 'Indian',
      residenceCountry: 'IN',
      email: '',
      phone: '',
      maritalStatus: '',
      dependants: 0,
      plannedRetirementAge: 60,
      lifeExpectancy: 90,
      monthlyExpensesNowINR: 0,
      monthlyExpensesInRetirementINR: 0,
      monthlyIncomeINR: 0,
      monthlyInvestableSurplusINR: 0,
      monthlyEmiINR: 0,
      riskProfile: 'moderate',
      notes: '',
    },
    settings: {
      baseCurrency: 'INR',
      fx: {},
      targetAllocation: {},
      assumptions: {
        preRetirementReturnPct: 11,
        postRetirementReturnPct: 7,
        inflationPct: 6,
        salaryGrowthPct: 6,
        corpusBufferPct: 10,
      },
      // Opt-in only. Sending a report takes the whole portfolio off this machine
      // and through a mail provider, so nothing here is pre-filled and the
      // report tab never sends unless it is told to.
      email: {
        host: '',
        port: 587,
        security: 'starttls',
        user: '',
        pass: '',
        from: '',
        to: '',
        autoSend: false,
      },
      // IndiaBonds and the banks deduct TDS at these rates; the owner can move
      // any of them when a DTAA rate or a senior-citizen slab applies.
      tax: {
        bankInterestTdsPct: 20,
        bondInterestTdsPct: 20,
        govtBondTdsPct: 0,
        dividendTdsPct: 20,
        otherTaxableIncomeINR: 0,
        salaryTdsCreditedINR: 0,
        oldRegimeDeductionsINR: 0,
        seniorCitizen: null,
      },
      // Opt-in only. The app has no accounts, so opening this ledger to the Wi-Fi
      // network means requiring a PIN: nothing here is pre-filled, and with
      // enabled false every non-loopback request is refused before it reaches a
      // route. Only the salt and the hash are stored, never the PIN itself.
      phoneAccess: {
        enabled: false,
        salt: '',
        pinHash: '',
        tokenEpoch: 1,
        setAt: '',
        lastUnlockedAt: '',
      },
    },
    holdings: [],
    goals: [],
    snapshots: [],
  };
}

// Fields a holding must carry; anything else on input is dropped so the file
// never accumulates keys we do not understand.
//
// `input` may legitimately be empty (normalizeHolding({}, existing) runs on
// every read to repair stored records), so a key that is absent from input
// keeps its existing value, while an explicit null clears it.
function normalizeHolding(input, existing) {
  const h = existing ? { ...existing } : { id: newId() };
  if (!h.id) h.id = newId();
  const pick = (key, parse) => (key in input ? parse(input[key]) : (existing ? existing[key] ?? null : null));

  h.category = CATEGORIES.includes(input.category) ? input.category : (h.category || 'other_asset');
  h.name = String(input.name ?? h.name ?? '').trim();
  h.instrument = String(input.instrument ?? h.instrument ?? '').trim();
  h.institution = String(input.institution ?? h.institution ?? '').trim();
  h.country = String(input.country ?? h.country ?? '').trim().toUpperCase();
  h.currency = String(input.currency ?? h.currency ?? 'INR').trim().toUpperCase();

  const units = pick('units', numOrNull);
  const price = pick('pricePerUnit', numOrNull);
  h.units = units;
  h.pricePerUnit = price;
  if (units !== null && price !== null && price !== 0) {
    h.valueNative = round2(units * price);
  } else {
    const v = 'valueNative' in input ? numOrNull(input.valueNative) : null;
    h.valueNative = v === null ? (h.valueNative ?? 0) : v;
  }

  // false means the owner pinned the price, so the quote feed leaves the row alone.
  h.priceAuto = pick('priceAuto', boolOrNull);
  h.priceSymbol = pick('priceSymbol', (v) => (v ? String(v).trim().toUpperCase().slice(0, 16) : null));
  h.priceAsOf = pick('priceAsOf', dateOrNull);
  h.metalRate = pick('metalRate', metalRateOrNull);
  // Written by the IndiaBonds feed, never typed: the face value its price is
  // quoted against, and the yield to maturity it showed on the day of the pull.
  h.bondFaceINR = pick('bondFaceINR', numOrNull);
  h.bondYieldPct = pick('bondYieldPct', numOrNull);

  h.acquiredOn = pick('acquiredOn', dateOrNull);
  h.maturityDate = pick('maturityDate', dateOrNull);
  h.interestRatePct = pick('interestRatePct', numOrNull);
  h.termMonths = pick('termMonths', termOrNull);
  // A bank renews a matured FD on its own; this says the owner wants the ledger
  // to behave as if that happened, term after term, interest going back in. Only
  // a deposit can do it, so a yes on any other class is dropped here rather than
  // trusted to the form that hides the box.
  h.fdAutoRenew = h.category === 'fixed_deposit' ? pick('fdAutoRenew', boolOrNull) === true : false;
  h.costNative = pick('costNative', numOrNull);
  // Dividends are the one equity return the tax view can accrue without a
  // corporate-actions feed, so the owner states the yield per holding.
  h.dividendYieldPct = pick('dividendYieldPct', numOrNull);
  h.liquidityOverride = pick('liquidityOverride', (v) => (['liquid', 'illiquid'].includes(v) ? v : null));
  // 'auto' lets the income engine read NRE/FCNR/NRO off the row's own text.
  h.indianTax = pick('indianTax', (v) => (['taxable', 'exempt'].includes(String(v ?? '').trim().toLowerCase()) ? String(v).trim().toLowerCase() : 'auto')) || 'auto';
  h.notes = String(input.notes ?? h.notes ?? '').trim();

  // An FD's maturity is the deposit date plus its term, so deriving it here
  // keeps the Maturity column, its sort and the accrual cap fed by one input.
  if (h.category === 'fixed_deposit' && h.termMonths && h.acquiredOn) {
    h.maturityDate = currentMaturity(h.acquiredOn, h.termMonths, h.fdAutoRenew, todayISO());
  }
  return h;
}

// The maturity a deposit is actually at: the first term's end, or - once it
// renews - the end of whichever term is running today. A renewing deposit that
// stopped six months ago would otherwise read as an overdue one, and the accrual
// horizon would clamp at a date the bank has already rolled past. ISO dates sort
// left to right, so the walk is a string compare.
function currentMaturity(acquiredOn, termMonths, autoRenew, today) {
  let maturity = addMonths(acquiredOn, termMonths);
  if (!autoRenew) return maturity;
  // A one-month term from a decade ago is 120 steps, so the cap is for junk
  // input, not for a real ledger.
  for (let terms = 0; maturity < today && terms < 1200; terms += 1) {
    maturity = addMonths(maturity, termMonths);
  }
  return maturity;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeGoal(input, existing) {
  const g = existing ? { ...existing } : { id: newId() };
  if (!g.id) g.id = newId();
  const pick = (key, parse) => (key in input ? parse(input[key]) : (existing ? existing[key] ?? null : null));

  g.name = String(input.name ?? g.name ?? '').trim();
  g.purpose = String(input.purpose ?? g.purpose ?? '').trim();
  g.targetAmountINR = pick('targetAmountINR', (v) => Math.max(0, numOrNull(v) ?? 0)) ?? 0;
  g.targetDate = pick('targetDate', dateOrNull);
  g.horizonYears = pick('horizonYears', (v) => {
    const n = numOrNull(v);
    return n === null ? null : Math.min(80, Math.max(0, Math.round(n)));
  });
  g.expectedReturnPct = pick('expectedReturnPct', numOrNull) ?? 11;
  g.inflationPct = pick('inflationPct', numOrNull) ?? 6;
  g.monthlyContributionINR = pick('monthlyContributionINR', (v) => Math.max(0, numOrNull(v) ?? 0)) ?? 0;
  g.linkedHoldingIds = Array.isArray(input.linkedHoldingIds)
    ? input.linkedHoldingIds.map(String)
    : (existing?.linkedHoldingIds ?? []);
  g.notes = String(input.notes ?? g.notes ?? '').trim();
  return g;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// null means "unstated" and must not collapse into false, which is a deliberate
// pin that keeps the quote feed away from the row.
function boolOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return null;
}

function metalRateOrNull(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return METAL_RATES.includes(s) ? s : null;
}

function termOrNull(v) {
  const n = numOrNull(v);
  return n === null ? null : Math.min(600, Math.max(1, Math.round(n)));
}

// Calendar months, clamped to the month's last day: 31 Jan plus one month is
// 28 or 29 Feb, never 2 Mar.
function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const pad = (v) => String(v).padStart(2, '0');
  return `${year}-${pad(month + 1)}-${pad(Math.min(d, lastDay))}`;
}

function dateOrNull(v) {
  if (!v) return null;
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function read() {
  if (!fs.existsSync(DB_FILE)) return null;
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  return merge(blankDb(), parsed);
}

// Keep the DB usable across schema tweaks: fill any missing top-level key or
// profile/settings field from defaults, and repair each holding record.
function merge(base, incoming) {
  const out = { ...base, ...incoming };
  out.profile = { ...base.profile, ...(incoming.profile || {}) };
  out.settings = { ...base.settings, ...(incoming.settings || {}) };
  out.settings.assumptions = { ...base.settings.assumptions, ...(incoming.settings?.assumptions || {}) };
  out.settings.tax = normalizeTax(base.settings.tax, incoming.settings?.tax);
  out.settings.email = normalizeEmail(base.settings.email, incoming.settings?.email);
  out.settings.phoneAccess = normalizePhoneAccess(base.settings.phoneAccess, incoming.settings?.phoneAccess);
  out.settings.fx = incoming.settings?.fx || {};
  const targets = incoming.settings?.targetAllocation || {};
  out.settings.targetAllocation = Object.fromEntries(
    Object.entries(targets)
      .filter(([k]) => CATEGORIES.includes(k))
      .map(([k, v]) => [k, Math.min(100, Math.max(0, Number(v) || 0))])
  );
  out.holdings = Array.isArray(incoming.holdings) ? incoming.holdings.map((h) => normalizeHolding({}, h)) : [];
  out.goals = Array.isArray(incoming.goals) ? incoming.goals.map((g) => normalizeGoal({}, g)) : [];
  out.snapshots = Array.isArray(incoming.snapshots) ? incoming.snapshots : [];
  return out;
}

// A hand-edited or older file must never end up "enabled" without a PIN to
// check, so enabled is derived from the stored pair rather than trusted.
function normalizePhoneAccess(base, incoming) {
  const src = incoming || {};
  const salt = /^[0-9a-f]{16,64}$/.test(String(src.salt || '')) ? String(src.salt) : (src.salt === undefined ? base.salt : '');
  const pinHash = /^[0-9a-f]{64}$/.test(String(src.pinHash || '')) ? String(src.pinHash) : (src.pinHash === undefined ? base.pinHash : '');
  const epoch = Number(src.tokenEpoch ?? base.tokenEpoch);
  const stamp = (key) => String(src[key] ?? base[key] ?? '').slice(0, 40);
  return {
    enabled: (src.enabled ?? base.enabled) === true && Boolean(salt) && Boolean(pinHash),
    salt,
    pinHash,
    tokenEpoch: Number.isFinite(epoch) && epoch >= 1 ? Math.floor(epoch) : 1,
    setAt: stamp('setAt'),
    lastUnlockedAt: stamp('lastUnlockedAt'),
    apk: 'apk' in src ? access.normalizeApk(src.apk) : access.normalizeApk(base.apk),
  };
}

// The SMTP password is write-only over the API - /api/state never sends it back -
// so an edit that posts an empty pass means "leave the stored one alone" and only
// an explicit null clears it.
function normalizeEmail(base, incoming) {
  const src = incoming || {};
  const text = (key, max) => (key in src ? String(src[key] ?? '').trim().slice(0, max) : base[key]);
  const port = numOrNull(src.port);
  const security = ['tls', 'starttls', 'none'].includes(String(src.security || '').trim())
    ? String(src.security).trim()
    : base.security;
  return {
    host: text('host', 200),
    port: port === null ? base.port : Math.min(65535, Math.max(1, Math.round(port))),
    security,
    user: text('user', 200),
    pass: 'pass' in src ? (src.pass === null ? '' : String(src.pass).slice(0, 200) || base.pass) : base.pass,
    from: text('from', 200),
    to: text('to', 200),
    autoSend: 'autoSend' in src ? boolOrNull(src.autoSend) === true : base.autoSend === true,
  };
}

// Percent keys are editable against a bank's or IndiaBonds' actual deduction, so
// they are clamped to a plausible band instead of being trusted verbatim.
function normalizeTax(base, incoming) {
  const src = incoming || {};
  const pct = (key) => {
    const n = numOrNull(src[key]);
    return n === null ? base[key] : Math.min(50, Math.max(0, n));
  };
  const money = (key) => {
    const n = numOrNull(src[key]);
    return n === null ? base[key] : Math.max(0, n);
  };
  return {
    bankInterestTdsPct: pct('bankInterestTdsPct'),
    bondInterestTdsPct: pct('bondInterestTdsPct'),
    govtBondTdsPct: pct('govtBondTdsPct'),
    dividendTdsPct: pct('dividendTdsPct'),
    otherTaxableIncomeINR: money('otherTaxableIncomeINR'),
    salaryTdsCreditedINR: money('salaryTdsCreditedINR'),
    oldRegimeDeductionsINR: money('oldRegimeDeductionsINR'),
    seniorCitizen: boolOrNull(src.seniorCitizen),
  };
}

function write(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  db.updatedAt = new Date().toISOString();
  const json = JSON.stringify(db, null, 2);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  if (fs.existsSync(DB_FILE)) {
    try { fs.copyFileSync(DB_FILE, BACKUP_FILE); } catch { /* backup is best-effort */ }
  }
  fs.renameSync(tmp, DB_FILE);
  return db;
}

module.exports = {
  DB_FILE,
  BACKUP_FILE,
  DATA_DIR,
  CATEGORIES,
  CATEGORY_LABELS,
  METAL_RATES,
  LIQUID_CATEGORIES,
  blankDb,
  normalizeHolding,
  currentMaturity,
  normalizeGoal,
  normalizeEmail,
  normalizePhoneAccess,
  read,
  write,
  merge,
  newId,
  round2,
};
