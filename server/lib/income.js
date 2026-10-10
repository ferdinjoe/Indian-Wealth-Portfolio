// India income accrual and a financial-year tax estimate.
//
// Only Indian-side rows are read here: an NRI is taxed in India on income that
// arises in India, so a Bangkok savings account or a Nasdaq holding is out of
// scope, and every figure reported is in INR.

const DAY_MS = 86_400_000;
const COMPOUND_DAYS = 365.25 * DAY_MS;

// Rows whose interestRatePct means "this earns income". real_estate is absent on
// purpose: rent belongs in other taxable income, not on an asset row.
const INTEREST_CATEGORIES = new Set(['bank_account', 'fixed_deposit', 'bond', 'policy', 'retirement_scheme', 'other_asset']);

// Section 194A pools these before a bank may deduct.
const DEPOSIT_CATEGORIES = new Set(['bank_account', 'fixed_deposit']);

const TDS_THRESHOLD_NON_SENIOR = 50_000;
const TDS_THRESHOLD_SENIOR = 100_000;
const TTB_LIMIT = 50_000;

const STANDARD_DEDUCTION = { new: 75_000, old: 50_000 };
const REBATE_LIMIT = { new: 1_200_000, old: 500_000 };
const REBATE_CAP_OLD = 12_500;
const CESS_PCT = 4;

// [band ceiling, rate] - marginal, so a slab only taxes the money inside it.
const NEW_SLABS = [[400_000, 0], [800_000, 0.05], [1_200_000, 0.1], [1_600_000, 0.15], [2_000_000, 0.2], [2_400_000, 0.25], [Infinity, 0.3]];
const OLD_SLABS = [[250_000, 0], [500_000, 0.05], [1_000_000, 0.2], [Infinity, 0.3]];
const OLD_SLABS_SENIOR = [[300_000, 0], [500_000, 0.05], [1_000_000, 0.2], [Infinity, 0.3]];
const OLD_SLABS_SUPER_SENIOR = [[500_000, 0], [1_000_000, 0.2], [Infinity, 0.3]];

// [income above, surcharge] for both regimes.
const SURCHARGE = [[5_000_000, 0.1], [10_000_000, 0.15], [20_000_000, 0.25], [50_000_000, 0.3]];

const EXEMPT_TEXT = /\bNRE\b|\bFCNR(?:B)?\b/i;
const NRO_TEXT = /\bNRO\b/i;
const ISIN_SHAPE = /IN[0-9A-Z]{10}/;

function financialYear(today = new Date()) {
  const now = today.getTime();
  const year = new Date(now).getUTCFullYear();
  // The year is named for the April that opens it: FY 2026-27 runs 1 Apr 2026
  // to 31 Mar 2027.
  const startYear = new Date(now).getUTCMonth() >= 3 ? year : year - 1;
  const start = Date.UTC(startYear, 3, 1);
  const end = Date.UTC(startYear + 1, 2, 31);
  const totalDays = Math.round((end - start) / DAY_MS) + 1;
  const elapsedDays = Math.min(totalDays, Math.max(1, Math.floor((now - start) / DAY_MS) + 1));
  return {
    label: `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
    startYear,
    startISO: iso(start),
    endISO: iso(end),
    start,
    end,
    totalDays,
    elapsedDays,
    fraction: elapsedDays / totalDays,
  };
}

function iso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Quarterly compounding, the Indian cumulative-deposit convention, evaluated at
// an absolute instant rather than "today".
function balanceAt(principal, ratePct, startMs, at) {
  const years = Math.max(0, (at - startMs) / COMPOUND_DAYS);
  return principal * (1 + ratePct / 400) ** (4 * years);
}

// Interest an accruing deposit earns between two points of the calendar. A
// deposit maturing inside the year is assumed to roll over at the same rate for
// the rest of it; one that matured before the year opened earns nothing here,
// because its renewal terms are not in the ledger.
function depositWindow(h, principal, fy, now) {
  const rate = Number(h.interestRatePct);
  const startMs = Date.parse(`${h.acquiredOn}T00:00:00Z`);
  if (!Number.isFinite(startMs)) return null;
  const from = Math.max(fy.start, startMs);
  const maturity = h.maturityDate ? Date.parse(`${h.maturityDate}T00:00:00Z`) : NaN;
  if (Number.isFinite(maturity) && maturity < fy.start) return { full: 0, ytd: 0, maturedBeforeYear: true };

  const ytdTo = Math.min(now, Number.isFinite(maturity) ? maturity : Infinity, fy.end);
  const ytd = ytdTo > from ? balanceAt(principal, rate, startMs, ytdTo) - balanceAt(principal, rate, startMs, from) : 0;
  const full = fy.end > from ? balanceAt(principal, rate, startMs, fy.end) - balanceAt(principal, rate, startMs, from) : 0;
  return { full, ytd, maturesISO: Number.isFinite(maturity) ? h.maturityDate : null };
}

// Straight annualised income on the value in view, with the year-to-date figure
// pro-rated by the part of the year already run.
function simpleWindow(valueNative, ratePct, fy) {
  const full = (valueNative * ratePct) / 100;
  return { full, ytd: full * fy.fraction };
}

// ISIN families: IN0 central government, IN1-IN3 state development loans,
// INE/IN9 corporate debt. The first two carry no TDS under section 193.
function bondKind(h) {
  const found = `${h.priceSymbol || ''} ${h.instrument || ''} ${h.name || ''}`.toUpperCase().match(ISIN_SHAPE);
  const isin = found ? found[0] : '';
  if (/^IN0/.test(isin)) return 'government';
  if (/^IN[123]/.test(isin)) return 'state';
  if (/^(INE|IN9)/.test(isin)) return 'corporate';
  return 'unlisted';
}

function taxTreatment(h, category) {
  const stated = String(h.indianTax || 'auto');
  if (stated === 'exempt') return 'exempt';
  if (stated === 'taxable') return 'taxable';
  // EPF/NPS/PPF and policy accruals are taxed on receipt, not in the year they
  // grow, so they are listed but kept out of the slab base.
  if (category === 'retirement_scheme' || category === 'policy') return 'deferred';
  const text = `${h.name} ${h.instrument} ${h.institution} ${h.notes}`;
  if (EXEMPT_TEXT.test(text)) return 'exempt';
  return 'taxable';
}

function rateToINR(h) {
  return Number.isFinite(h.rate) && h.rate > 0 ? h.rate : null;
}

function pushLine(h, kind, window, tax, ratePct) {
  const category = h.category;
  const bond = category === 'bond' ? bondKind(h) : null;
  const treatment = taxTreatment(h, category);
  const rate = rateToINR(h);
  let tdsPct;
  if (treatment !== 'taxable') tdsPct = 0;
  else if (kind === 'dividend') tdsPct = tax.dividendTdsPct;
  else if (category === 'bond') tdsPct = bond === 'government' || bond === 'state' ? tax.govtBondTdsPct : tax.bondInterestTdsPct;
  else if (category === 'retirement_scheme' || category === 'policy') tdsPct = 0;
  else tdsPct = tax.bankInterestTdsPct;

  return {
    id: h.id,
    name: h.name || h.instrument,
    category,
    institution: h.institution,
    currency: h.currency,
    kind,
    ratePct: kind === 'dividend' ? Number(h.dividendYieldPct) : ratePct,
    treatment,
    bondKind: bond,
    valueINR: h.valueINR ?? null,
    incomeNative: { full: round2(window.full), ytd: round2(window.ytd) },
    incomeINR: rate === null ? null : { full: round2(window.full * rate), ytd: round2(window.ytd * rate) },
    tdsPct,
    // Deposit TDS is settled after the section 194A pool, so it starts at zero.
    tdsINR: rate === null ? null : { full: 0, ytd: 0 },
    tdsBasis: '',
    maturedBeforeYear: window.maturedBeforeYear === true,
    maturesISO: window.maturesISO || null,
    unconverted: rate === null,
  };
}

// Build the per-holding income lines for the year in view.
function incomeLines(holdings, fy, now, tax) {
  const lines = [];
  const skipped = [];
  for (const h of holdings) {
    if ((h.country || '').toUpperCase() !== 'IN') continue;
    if (h.category === 'equity') {
      const y = Number(h.dividendYieldPct);
      if (!Number.isFinite(y) || y <= 0 || !(h.nativeValue > 0)) continue;
      lines.push(pushLine(h, 'dividend', simpleWindow(h.nativeValue, y, fy), tax, y));
      continue;
    }
    if (!INTEREST_CATEGORIES.has(h.category)) continue;
    const rate = Number(h.interestRatePct);
    if (!(rate > 0)) continue;
    if (!(h.nativeValue > 0)) {
      skipped.push({ id: h.id, name: h.name, reason: 'no value recorded' });
      continue;
    }
    // An accruing FD has its own curve; a bond coupon is annualised on the value
    // the feed last put on the row.
    const window = h.category === 'fixed_deposit' && h.fdPrincipal != null
      ? (depositWindow(h, h.fdPrincipal, fy, now) ?? simpleWindow(h.nativeValue, rate, fy))
      : simpleWindow(h.nativeValue, rate, fy);
    lines.push(pushLine(h, 'interest', window, tax, rate));
  }
  return { lines, skipped };
}

// Deposit interest is pooled before the threshold test because a bank deducts on
// the holder's total with it, not row by row.
function applyTds(lines, tax, senior) {
  const threshold = senior ? TDS_THRESHOLD_SENIOR : TDS_THRESHOLD_NON_SENIOR;
  const deposits = lines.filter((l) => l.treatment === 'taxable' && DEPOSIT_CATEGORIES.has(l.category) && l.incomeINR);
  const depositTotal = deposits.reduce((a, l) => a + l.incomeINR.full, 0);
  const tdsed = depositTotal > threshold;
  for (const l of deposits) {
    l.tdsPct = tdsed ? tax.bankInterestTdsPct : 0;
    l.tdsBasis = tdsed
      ? `section 194A threshold of ${inr(threshold)} crossed`
      : `no TDS while bank interest stays under ${inr(threshold)}`;
    l.tdsINR = { full: round2(l.incomeINR.full * l.tdsPct / 100), ytd: round2(l.incomeINR.ytd * l.tdsPct / 100) };
  }
  for (const l of lines) {
    if (!l.incomeINR || DEPOSIT_CATEGORIES.has(l.category)) continue;
    if (!(l.tdsPct > 0)) continue;
    l.tdsBasis = l.kind === 'dividend' ? 'dividend withheld for a non-resident'
      : l.category === 'bond' ? (l.bondKind === 'unlisted'
        ? 'no ISIN recorded, so taxed as a corporate coupon'
        : `coupon on a ${l.bondKind} issue`)
        : 'deducted at this rate';
    l.tdsINR = { full: round2(l.incomeINR.full * l.tdsPct / 100), ytd: round2(l.incomeINR.ytd * l.tdsPct / 100) };
  }
  for (const l of lines) {
    if (l.tdsBasis) continue;
    l.tdsBasis = l.treatment === 'exempt' ? 'NRE / FCNR interest is not taxed in India'
      : l.treatment === 'deferred' ? 'taxed when drawn, not in the year it grows'
        : l.category === 'bond' ? 'section 193 spares this security'
          : 'no deduction expected';
  }
  return {
    depositInterestINR: round2(depositTotal),
    depositTdsThresholdINR: threshold,
    depositTdsApplied: tdsed,
  };
}

function slabTax(taxable, slabs) {
  let tax = 0;
  let floor = 0;
  for (const [ceiling, rate] of slabs) {
    if (taxable > floor) tax += (Math.min(taxable, ceiling) - floor) * rate;
    floor = ceiling;
    if (taxable <= ceiling) break;
  }
  return tax;
}

function surchargeRate(taxableIncome) {
  let rate = 0;
  for (const [above, r] of SURCHARGE) if (taxableIncome > above) rate = r;
  return rate;
}

// One regime, start to finish: deductions, slabs, rebate 87A, surcharge, cess.
function regimeTax(cfg) {
  const standardDeduction = Math.min(cfg.standardDeductionCap, cfg.salary);
  const grossTotal = cfg.salary + cfg.investmentIncome + cfg.otherIncome;
  const deductions = standardDeduction + cfg.ttb + cfg.claimed;
  const taxableIncome = Math.max(0, grossTotal - deductions);
  const slab = slabTax(taxableIncome, cfg.slabs);
  const rebate = taxableIncome <= cfg.rebateLimit
    ? (cfg.rebateCap === null ? slab : Math.min(slab, cfg.rebateCap))
    : 0;
  const afterRebate = Math.max(0, slab - rebate);
  const surchargePct = surchargeRate(taxableIncome);
  const surcharge = afterRebate * surchargePct;
  const cess = (afterRebate + surcharge) * (CESS_PCT / 100);
  const liability = afterRebate + surcharge + cess;
  return {
    key: cfg.key,
    label: cfg.label,
    note: cfg.note,
    grossTotalINR: round2(grossTotal),
    salaryGrossINR: round2(cfg.salary),
    salaryTaxableINR: round2(Math.max(0, cfg.salary - standardDeduction)),
    investmentIncomeINR: round2(cfg.investmentIncome),
    otherIncomeINR: round2(cfg.otherIncome),
    deductions: {
      standardDeductionINR: round2(standardDeduction),
      section80ttbINR: round2(cfg.ttb),
      claimedINR: round2(cfg.claimed),
      totalINR: round2(deductions),
    },
    taxableIncomeINR: round2(taxableIncome),
    slabTaxINR: round2(slab),
    rebateINR: round2(rebate),
    surchargePct: round2(surchargePct * 100),
    surchargeINR: round2(surcharge),
    cessINR: round2(cess),
    effectiveRatePct: grossTotal > 0 ? round2(liability / grossTotal * 100) : 0,
    liabilityINR: round2(liability),
  };
}

// Age at the close of the financial year, since a senior citizen gets a higher
// basic exemption and 80TTB on interest.
function ageAt(dobISO, atMs) {
  if (!dobISO) return null;
  const t = Date.parse(`${dobISO}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor((atMs - t) / COMPOUND_DAYS) : null;
}

function summarise({ holdings, profile, settings, today = new Date() }) {
  const tax = settings.tax || {};
  const fy = financialYear(today);
  const now = today.getTime();
  const { lines, skipped } = incomeLines(holdings, fy, now, tax);

  const age = ageAt(profile.dateOfBirth, fy.end);
  const senior = tax.seniorCitizen === null ? (age === null ? false : age >= 60) : Boolean(tax.seniorCitizen);
  const superSenior = age !== null && age >= 80;

  const depositTds = applyTds(lines, tax, senior);
  const inINR = lines.filter((l) => l.incomeINR);
  const sum = (pred, key = 'full') => round2(inINR.filter(pred).reduce((a, l) => a + l.incomeINR[key], 0));
  const taxable = (l) => l.treatment === 'taxable';

  const totals = {
    holdingCount: lines.length,
    accruedYtdINR: round2(inINR.reduce((a, l) => a + l.incomeINR.ytd, 0)),
    projectedFullFYINR: round2(inINR.reduce((a, l) => a + l.incomeINR.full, 0)),
    taxableProjectedINR: sum(taxable),
    taxableAccruedYtdINR: sum(taxable, 'ytd'),
    exemptProjectedINR: sum((l) => l.treatment === 'exempt'),
    deferredProjectedINR: sum((l) => l.treatment === 'deferred'),
    interestProjectedINR: sum((l) => taxable(l) && l.kind === 'interest'),
    dividendProjectedINR: sum((l) => taxable(l) && l.kind === 'dividend'),
    tdsYtdINR: round2(inINR.reduce((a, l) => a + l.tdsINR.ytd, 0)),
    tdsProjectedINR: round2(inINR.reduce((a, l) => a + l.tdsINR.full, 0)),
  };

  const bonds = lines.filter((l) => l.category === 'bond');
  const bondSum = (pick) => round2(bonds.reduce((a, l) => a + (pick(l) || 0), 0));
  const bondsBlock = {
    count: bonds.length,
    payableProjectedINR: bondSum((l) => l.incomeINR?.full),
    payableAccruedINR: bondSum((l) => l.incomeINR?.ytd),
    tdsProjectedINR: bondSum((l) => l.tdsINR?.full),
    tdsAccruedINR: bondSum((l) => l.tdsINR?.ytd),
    rows: bonds.map((l) => ({
      id: l.id,
      name: l.name,
      institution: l.institution,
      couponPct: l.ratePct,
      kind: l.bondKind,
      valueINR: l.valueINR,
      payableINR: l.incomeINR?.full ?? null,
      payableAccruedINR: l.incomeINR?.ytd ?? null,
      tdsPct: l.tdsPct,
      tdsINR: l.tdsINR?.full ?? null,
      netReceivableINR: l.incomeINR && l.tdsINR ? round2(l.incomeINR.full - l.tdsINR.full) : null,
      basis: l.tdsBasis,
    })).sort((a, b) => (b.payableINR || 0) - (a.payableINR || 0)),
  };

  const salary = Math.max(0, Number(profile.monthlyIncomeINR) || 0) * 12;
  const other = Math.max(0, Number(tax.otherTaxableIncomeINR) || 0);
  const claimed = Math.max(0, Number(tax.oldRegimeDeductionsINR) || 0);
  const ttb = senior ? Math.min(TTB_LIMIT, totals.interestProjectedINR) : 0;

  const newRegime = regimeTax({
    key: 'new',
    label: 'New regime',
    note: 'The default. No 80C, 80D or HRA relief, but the slabs are wider.',
    slabs: NEW_SLABS,
    rebateLimit: REBATE_LIMIT.new,
    rebateCap: null,
    standardDeductionCap: STANDARD_DEDUCTION.new,
    salary,
    investmentIncome: totals.taxableProjectedINR,
    otherIncome: other,
    ttb: 0,
    claimed: 0,
  });
  const oldRegime = regimeTax({
    key: 'old',
    label: 'Old regime',
    note: 'Only worth it once your 80C, 80D and HRA claims beat the wider new slabs.',
    slabs: superSenior ? OLD_SLABS_SUPER_SENIOR : senior ? OLD_SLABS_SENIOR : OLD_SLABS,
    rebateLimit: REBATE_LIMIT.old,
    rebateCap: REBATE_CAP_OLD,
    standardDeductionCap: STANDARD_DEDUCTION.old,
    salary,
    investmentIncome: totals.taxableProjectedINR,
    otherIncome: other,
    ttb,
    claimed,
  });
  const regimes = [newRegime, oldRegime];
  const preferred = regimes.reduce((a, b) => (b.liabilityINR < a.liabilityINR ? b : a));
  const salaryTds = Math.max(0, Number(tax.salaryTdsCreditedINR) || 0);

  return {
    financialYear: {
      label: fy.label,
      startYear: fy.startYear,
      startISO: fy.startISO,
      endISO: fy.endISO,
      totalDays: fy.totalDays,
      elapsedDays: fy.elapsedDays,
      elapsedPct: Math.round(fy.fraction * 100),
    },
    residence: {
      scope: 'Indian-source income only',
      salaryProjectedINR: round2(salary),
      salarySource: 'profile.monthlyIncomeINR x 12',
      seniorCitizen: senior,
      superSenior,
      ageAtYearEnd: age,
      seniorSource: tax.seniorCitizen !== null ? 'stated under Settings'
        : age === null ? 'assumed below 60 - a date of birth in Profile decides it' : 'from the date of birth',
    },
    lines: lines.sort((a, b) => (b.incomeINR?.full || 0) - (a.incomeINR?.full || 0)),
    totals,
    depositTds,
    bonds: bondsBlock,
    regimes,
    preferred: preferred.key,
    savingFromBetterRegimeINR: round2(Math.abs(newRegime.liabilityINR - oldRegime.liabilityINR)),
    settlement: regimes.map((r) => ({
      key: r.key,
      liabilityINR: r.liabilityINR,
      tdsCreditedINR: round2(salaryTds + totals.tdsProjectedINR),
      balanceINR: round2(r.liabilityINR - salaryTds - totals.tdsProjectedINR),
    })),
    salaryTdsCreditedINR: round2(salaryTds),
    caveats: [
      'Gains on anything you sold this year are not here - add them to other taxable income.',
      'Bond coupons are annualised on the value in view, not on face value.',
      'TDS shown is what these rates should deduct - reconcile it with Form 26AS.',
      'An estimate to plan with, not a return to file. A CA settles the last rupee.',
    ],
    unconverted: lines.filter((l) => !l.incomeINR).map((l) => ({ id: l.id, name: l.name, currency: l.currency })),
    skipped: skipped.slice(0, 8),
  };
}

function inr(n) {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = { financialYear, bondKind, taxTreatment, depositWindow, incomeLines, applyTds, slabTax, surchargeRate, regimeTax, summarise };
