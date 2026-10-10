const { CATEGORY_LABELS } = require('./store');

// Buckets that answer "how much can this fall?" rather than "what is the
// instrument called", which is what risk mix and glide-path checks need.
const RISK_BUCKETS = {
  equity: 'growth',
  policy: 'growth',
  bond: 'income',
  fixed_deposit: 'income',
  retirement_scheme: 'income',
  bank_account: 'liquid',
  real_estate: 'real_assets',
  gold_commodity: 'real_assets',
  other_asset: 'other',
  liability: 'debt',
};

const BUCKET_LABELS = {
  growth: 'Growth (equity & linked policies)',
  income: 'Income (bonds, deposits, pension)',
  liquid: 'Cash & equivalents',
  real_assets: 'Real assets (property & gold)',
  other: 'Other',
};

function assetsOnly(rows) {
  return rows.filter((r) => r.category !== 'liability' && (r.valueINR || 0) > 0);
}

// Actual versus target split, and the rupees needed to pull each class back to
// target. Only classes with a nonzero target or a nonzero holding appear.
function allocation(rows, targets = {}) {
  const assets = assetsOnly(rows);
  const total = assets.reduce((a, r) => a + r.valueINR, 0);
  const keys = new Set([...Object.keys(targets || {}), ...assets.map((r) => r.category)]);
  const out = [];
  for (const key of keys) {
    if (key === 'liability') continue;
    const held = assets.filter((r) => r.category === key).reduce((a, r) => a + r.valueINR, 0);
    const actualPct = total ? (held / total) * 100 : 0;
    const targetPct = Number(targets?.[key]) || 0;
    const targetINR = (total * targetPct) / 100;
    out.push({
      key,
      label: CATEGORY_LABELS[key] || key,
      heldINR: round(held),
      actualPct: round(actualPct),
      targetPct: round(targetPct),
      driftPct: round(actualPct - targetPct),
      deltaINR: round(targetINR - held),
      hasTarget: targetPct > 0,
      action: targetPct > 0 ? (targetINR - held > 0 ? 'buy' : 'trim') : 'unassigned',
    });
  }
  out.sort((a, b) => b.actualPct - a.actualPct);
  const targetSum = out.reduce((a, x) => a + x.targetPct, 0);
  return { rows: out, totalINR: round(total), targetSumPct: round(targetSum), targetsComplete: Math.abs(targetSum - 100) < 0.5 };
}

function riskMix(rows) {
  const assets = assetsOnly(rows);
  const total = assets.reduce((a, r) => a + r.valueINR, 0) || 1;
  const buckets = {};
  for (const r of assets) {
    const b = RISK_BUCKETS[r.category] || 'other';
    buckets[b] = (buckets[b] || 0) + r.valueINR;
  }
  return Object.entries(buckets)
    .map(([k, v]) => ({ key: k, label: BUCKET_LABELS[k] || k, valueINR: round(v), pct: round((v / total) * 100) }))
    .sort((a, b) => b.valueINR - a.valueINR);
}

function concentration(rows) {
  const assets = assetsOnly(rows).sort((a, b) => b.valueINR - a.valueINR);
  const total = assets.reduce((a, r) => a + r.valueINR, 0);
  if (!total) return { top1Pct: 0, top5Pct: 0, hhi: 0, largest: null, count: 0 };
  const shares = assets.map((r) => r.valueINR / total);
  const top5 = shares.slice(0, 5).reduce((a, s) => a + s, 0);
  return {
    top1Pct: round(shares[0] * 100),
    top5Pct: round(top5 * 100),
    hhi: round(shares.reduce((a, s) => a + s * s, 0) * 10000),
    largest: assets[0].name,
    largestInstrument: assets[0].instrument || null,
    count: assets.length,
  };
}

function geography(rows) {
  const assets = assetsOnly(rows);
  const total = assets.reduce((a, r) => a + r.valueINR, 0) || 1;
  const byCountry = {};
  const byCurrency = {};
  for (const r of assets) {
    byCountry[r.country || 'ZZ'] = (byCountry[r.country || 'ZZ'] || 0) + r.valueINR;
    if (r.currency !== 'INR') byCurrency[r.currency] = (byCurrency[r.currency] || 0) + r.valueINR;
  }
  const largestCountryShare = Math.max(0, ...Object.values(byCountry)) / total;
  return {
    countryCount: Object.keys(byCountry).length,
    largestCountryPct: round(largestCountryShare * 100),
    largestCountry: Object.entries(byCountry).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    foreignPct: round((Object.values(byCurrency).reduce((a, v) => a + v, 0) / total) * 100),
  };
}

// Goal-based investing: what each saved goal needs, and whether the holdings
// linked to it get there. Targets are inflation-indexed to the goal date, so a
// corpus fixed in today's rupees five years ago reads as behind, which it is.
function goalProgress(goals, rows, today = new Date()) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (goals || []).map((g) => {
    const linked = (g.linkedHoldingIds || []).map((id) => byId.get(id)).filter(Boolean);
    const currentINR = round(linked.reduce((a, r) => a + (r.valueINR || 0), 0));

    const years = horizonYears(g, today);
    const inflation = Number(g.inflationPct) || 0;
    const ret = Number(g.expectedReturnPct) || 0;
    const monthly = Number(g.monthlyContributionINR) || 0;

    const targetTodayINR = round(g.targetAmountINR || 0);
    const targetAtDateINR = round(targetTodayINR * Math.pow(1 + inflation / 100, years));
    const potFromExisting = currentINR * Math.pow(1 + ret / 100, years);
    const potFromContribs = futureValueOfContributions(monthly, ret, years);
    const projectedINR = round(potFromExisting + potFromContribs);
    const shortfallINR = round(Math.max(0, targetAtDateINR - projectedINR));
    // The annuity solve returns what the gap itself demands, which is money on
    // top of the plan already recorded against the goal.
    const extraMonthly = round(monthlyRequiredFor(shortfallINR, ret, years));

    return {
      ...g,
      linked: linked.map((r) => ({ id: r.id, name: r.name, category: r.category, valueINR: r.valueINR })),
      linkedCount: linked.length,
      missingLinkCount: (g.linkedHoldingIds || []).length - linked.length,
      currentINR,
      years: round(years),
      targetTodayINR,
      targetAtDateINR,
      projectedINR,
      shortfallINR,
      neededMonthlyINR: round(monthly + extraMonthly),
      extraMonthlyINR: extraMonthly,
      progressPct: targetAtDateINR > 0 ? round((projectedINR / targetAtDateINR) * 100) : 0,
      status: statusFor(targetAtDateINR, projectedINR, years),
    };
  }).sort((a, b) => a.years - b.years);
}

function horizonYears(g, today) {
  if (g.targetDate) {
    const t = new Date(g.targetDate);
    if (!Number.isNaN(t.getTime())) return Math.max(0, (t.getTime() - today.getTime()) / (365.25 * 86400_000));
  }
  return Math.max(0, Number(g.horizonYears) || 0);
}

// Growing-end-of-month annuity: each month's contribution also compounds.
function futureValueOfContributions(monthly, annualPct, years) {
  if (monthly <= 0 || years <= 0) return 0;
  const i = annualPct / 100 / 12;
  const n = Math.round(years * 12);
  if (n <= 0) return 0;
  if (i === 0) return monthly * n;
  return monthly * ((Math.pow(1 + i, n) - 1) / i);
}

function monthlyRequiredFor(goalINR, annualPct, years) {
  const n = Math.round(years * 12);
  if (n <= 0) return goalINR;
  const i = annualPct / 100 / 12;
  if (i === 0) return goalINR / n;
  return (goalINR * i) / (Math.pow(1 + i, n) - 1);
}

function statusFor(target, projected, years) {
  if (!target) return 'no-target';
  const ratio = projected / target;
  if (years <= 0.25) return ratio >= 1 ? 'funded' : 'urgent';
  if (ratio >= 1) return 'on-track';
  if (ratio >= 0.85) return 'close';
  if (ratio >= 0.6) return 'behind';
  return 'at-risk';
}

// Composite 0-100. Each component is a plain, explainable rule so the UI can
// show why the number is what it is rather than presenting a black-box grade.
function healthScore({ rows, profile, targets, age }) {
  const assets = assetsOnly(rows);
  const totalAssets = assets.reduce((a, r) => a + r.valueINR, 0);
  const liabilities = rows.filter((r) => r.category === 'liability').reduce((a, r) => a + (r.valueINR || 0), 0);
  const components = [];

  // "Perfectly diversified" and "debt free" are both vacuously true with
  // nothing held, which would hand an empty ledger a mid-range grade.
  if (!assets.length) return { score: null, grade: '—', components: [], costBasisCoveragePct: 0 };

  const push = (key, label, score, detail) => {
    if (score === null) return;
    components.push({ key, label, score: Math.round(clamp(score)), detail });
  };

  const conc = concentration(rows);
  push('diversification', 'Diversification',
    100 - ((conc.top5Pct - 40) / 40) * 100,
    `Top 5 holdings are ${conc.top5Pct.toFixed(0)}% of assets`);

  const debtRatio = totalAssets ? (liabilities / totalAssets) * 100 : 0;
  push('debt', 'Debt load', 100 - (debtRatio / 50) * 100, `Debt is ${debtRatio.toFixed(0)}% of assets`);

  const liquid = assets.filter((r) => r.liquid).reduce((a, r) => a + r.valueINR, 0);
  const monthlyNeed = profile.monthlyExpensesNowINR || 0;
  if (monthlyNeed > 0) {
    const months = liquid / monthlyNeed;
    const cover = months >= 120 ? `${(months / 12).toFixed(1)} years` : `${months.toFixed(0)} months`;
    push('liquidity', 'Emergency cover', ((months - 1) / 5) * 100, `${cover} of spending in liquid assets (target 6 months)`);
  }

  const alloc = allocation(rows, targets);
  if (alloc.targetsComplete) {
    const absDrift = alloc.rows.reduce((a, r) => a + Math.abs(r.driftPct), 0) / 2;
    push('discipline', 'Allocation discipline', 100 - (absDrift / 20) * 100, `Portfolio is ${absDrift.toFixed(1)} points away from target`);
  }

  if (Number.isFinite(age)) {
    const growth = alloc.rows.filter((r) => RISK_BUCKETS[r.key] === 'growth').reduce((a, r) => a + r.actualPct, 0);
    const ideal = Math.max(20, 100 - age);
    const gap = Math.abs(growth - ideal);
    push('glidepath', 'Growth vs age', 100 - (gap / 40) * 100, `${growth.toFixed(0)}% growth assets against a ~${ideal}% rule of thumb for age ${age}`);
  }

  const geo = geography(rows);
  if (geo.countryCount > 1) {
    push('geography', 'Country spread', 100 - ((geo.largestCountryPct - 60) / 35) * 100, `Largest country is ${geo.largestCountryPct.toFixed(0)}% of assets`);
  }

  // Not a component: entering a cost basis is a data-entry task, not a
  // portfolio-quality problem, so it must not drag the composite score down.
  const costedValue = assets.filter((r) => r.costINR !== null).reduce((a, r) => a + r.valueINR, 0);
  const coverage = totalAssets ? Math.round((costedValue / totalAssets) * 10000) / 100 : 0;

  const score = components.length ? components.reduce((a, c) => a + c.score, 0) / components.length : null;
  return {
    score: score === null ? null : Math.round(score),
    grade: score === null ? '—' : gradeFor(score),
    components: components.sort((a, b) => a.score - b.score),
    costBasisCoveragePct: coverage,
  };
}

function gradeFor(score) {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Healthy';
  if (score >= 55) return 'Adequate';
  if (score >= 40) return 'Needs attention';
  return 'Fragile';
}

// The fixed set the dashboard displays: the reporting base plus the currencies
// money in this ledger is actually held in.
const REPORT_CURRENCIES = ['INR', 'USD', 'SGD', 'THB', 'MYR'];

// One number in five units, not five balances: each amount is the same net worth
// divided by that currency's resolved INR rate, so it can never disagree with
// the headline figure or with the row-level pricing in Holdings.
function netWorthByCurrency(netWorthINR, rates, codes = REPORT_CURRENCIES) {
  const value = Number(netWorthINR) || 0;
  return codes.map((code) => {
    const entry = rates?.[code] || {};
    const rate = Number(entry.rate);
    const usable = Number.isFinite(rate) && rate > 0;
    return {
      code,
      rateToINR: usable ? round(rate) : null,
      source: entry.source || 'unknown',
      asOf: entry.asOf ?? null,
      amount: usable ? round(code === 'INR' ? value : value / rate) : null,
    };
  });
}

function clamp(n) {
  return Math.max(0, Math.min(100, n));
}

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  allocation, riskMix, concentration, geography, healthScore, goalProgress,
  netWorthByCurrency, RISK_BUCKETS, BUCKET_LABELS, REPORT_CURRENCIES,
};
