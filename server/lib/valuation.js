const { CATEGORIES, CATEGORY_LABELS, LIQUID_CATEGORIES, currentMaturity } = require('./store');
const { resolve, rateMap } = require('./fx');
const returns = require('./returns');

function nativeValue(h) {
  if (h.units !== null && h.pricePerUnit !== null && h.pricePerUnit !== 0) {
    return h.units * h.pricePerUnit;
  }
  return Number(h.valueNative) || 0;
}

const DAY_MS = 86400000;

// Indian cumulative FDs compound quarterly, so a deposit whose owner knows only
// the principal and the rate is worth what it has accrued since the deposit
// date, capped at maturity - after that the money just sits until renewal.
// A renewing deposit has no such end: the bank starts the same term again on the
// maturity date with the interest inside the principal, so the cap is the term
// now running. Compounding on from the deposit date to that date is the same sum
// as rolling term after term, because each term's balance is the next one's
// principal - so no per-term walk is needed here, only the right horizon.
function fdAccrued(h, today = new Date()) {
  if (h.category !== 'fixed_deposit') return null;
  if ((h.units ?? null) !== null || (h.pricePerUnit ?? null) !== null) return null;
  const rate = Number(h.interestRatePct);
  if (!Number.isFinite(rate) || rate <= 0 || !h.termMonths || !h.acquiredOn) return null;
  const start = Date.parse(`${h.acquiredOn}T00:00:00Z`);
  if (!Number.isFinite(start)) return null;
  const maturity = h.fdAutoRenew
    ? currentMaturity(h.acquiredOn, h.termMonths, true, today.toISOString().slice(0, 10))
    : h.maturityDate;
  const end = maturity ? Date.parse(`${maturity}T00:00:00Z`) : NaN;
  const horizon = Math.min(today.getTime(), Number.isFinite(end) ? end : Infinity);
  const years = Math.max(0, horizon - start) / (365.25 * DAY_MS);
  const principal = Number(h.valueNative) || 0;
  return round(principal * (1 + rate / 400) ** (4 * years));
}

// Converts into INR. An unknown currency yields null rather than a silent 0,
// so the UI can warn instead of understating net worth.
function toINR(amount, currency, fxTable) {
  const { rate } = resolve(fxTable, currency);
  if (rate === null) return null;
  return amount * rate;
}

function isLiquid(h) {
  if (h.liquidityOverride) return h.liquidityOverride === 'liquid';
  return LIQUID_CATEGORIES.has(h.category);
}

function enrich(db, today = new Date()) {
  const rates = rateMap(db.settings.fx);
  const unconverted = [];
  let holdings = db.holdings.map((h) => {
    const accrued = fdAccrued(h, today);
    const valueNative = accrued ?? nativeValue(h);
    const valueINR = toINR(valueNative, h.currency, db.settings.fx);
    if (valueINR === null) unconverted.push(h);
    return {
      ...h,
      nativeValue: Math.round(valueNative * 100) / 100,
      ...(accrued === null ? {} : { fdPrincipal: Math.round((Number(h.valueNative) || 0) * 100) / 100 }),
      valueINR: valueINR === null ? null : Math.round(valueINR * 100) / 100,
      rate: resolve(db.settings.fx, h.currency).rate,
      rateSource: resolve(db.settings.fx, h.currency).source,
      liquid: isLiquid(h),
    };
  });
  holdings = returns.applyReturns(holdings, today);
  return { holdings, rates, unconverted };
}

function summarize(rows) {
  const assets = rows.filter((r) => r.category !== 'liability');
  const liabilities = rows.filter((r) => r.category === 'liability');

  const sumOf = (list) => list.reduce((acc, r) => acc + (r.valueINR || 0), 0);
  const totalAssets = sumOf(assets);
  const totalLiabilities = sumOf(liabilities);

  const byCategory = {};
  for (const cat of CATEGORIES) {
    const list = rows.filter((r) => r.category === cat);
    if (!list.length && cat !== 'liability') continue;
    const gross = list.reduce((a, r) => a + (r.valueINR || 0), 0);
    byCategory[cat] = {
      key: cat,
      label: CATEGORY_LABELS[cat],
      valueINR: round(gross),
      netContributionINR: round(cat === 'liability' ? -gross : gross),
      count: list.length,
      shareOfAssetsPct: totalAssets ? round((cat === 'liability' ? 0 : gross) / totalAssets * 100) : 0,
    };
  }

  const byCountry = {};
  for (const r of rows) {
    const k = r.country || 'ZZ';
    byCountry[k] = byCountry[k] || { key: k, valueINR: 0, liabilitiesINR: 0, netContributionINR: 0, count: 0 };
    const v = r.valueINR || 0;
    if (r.category === 'liability') {
      byCountry[k].liabilitiesINR += v;
      byCountry[k].netContributionINR -= v;
    } else {
      byCountry[k].valueINR += v;
      byCountry[k].netContributionINR += v;
    }
    byCountry[k].count += 1;
  }
  Object.values(byCountry).forEach((x) => {
    x.valueINR = round(x.valueINR);
    x.liabilitiesINR = round(x.liabilitiesINR);
    x.netContributionINR = round(x.netContributionINR);
  });

  const byCurrency = {};
  for (const r of rows) {
    const k = r.currency;
    byCurrency[k] = byCurrency[k] || { key: k, nativeAmount: 0, valueINR: 0, count: 0 };
    byCurrency[k].nativeAmount += r.nativeValue;
    byCurrency[k].valueINR += r.valueINR || 0;
    byCurrency[k].count += 1;
  }
  Object.values(byCurrency).forEach((x) => { x.valueINR = round(x.valueINR); x.nativeAmount = round(x.nativeAmount); });

  const liquid = assets.filter(isLiquid).reduce((a, r) => a + (r.valueINR || 0), 0);
  const illiquid = totalAssets - liquid;

  const costed = rows.filter((r) => r.costINR !== null && r.category !== 'liability');
  const totalCostINR = costed.reduce((a, r) => a + r.costINR, 0);
  const costedValueINR = costed.reduce((a, r) => a + (r.valueINR || 0), 0);

  const performance = {
    ...returns.portfolioXirr(rows),
    totalCostINR: round(totalCostINR),
    costedValueINR: round(costedValueINR),
    unrealisedGainINR: round(costedValueINR - totalCostINR),
    unrealisedGainPct: totalCostINR ? round(((costedValueINR - totalCostINR) / Math.abs(totalCostINR)) * 100) : null,
    best: topPerformer(costed),
    worst: topPerformer(costed, true),
  };

  return {
    totalAssetsINR: round(totalAssets),
    totalLiabilitiesINR: round(totalLiabilities),
    netWorthINR: round(totalAssets - totalLiabilities),
    liquidAssetsINR: round(liquid),
    illiquidAssetsINR: round(illiquid),
    holdingCount: rows.length,
    assetCount: assets.length,
    liabilityCount: liabilities.length,
    byCategory,
    byCountry,
    byCurrency,
    performance,
  };
}

function topPerformer(costed, lowest = false) {
  const eligible = costed.filter((r) => r.gainPct !== null && (r.yearsHeld ?? 0) >= 0.5);
  if (!eligible.length) return null;
  const pick = eligible.reduce((a, b) => (lowest ? (b.gainPct < a.gainPct ? b : a) : (b.gainPct > a.gainPct ? b : a)));
  return { name: pick.name, gainPct: pick.gainPct, category: pick.category };
}

// Keeps one row per calendar month so the trend chart stays readable even if
// the ledger is touched daily.
function upsertSnapshot(snapshots, summary, today = new Date()) {
  const period = today.toISOString().slice(0, 7);
  const entry = {
    period,
    recordedAt: today.toISOString(),
    totalAssetsINR: summary.totalAssetsINR,
    totalLiabilitiesINR: summary.totalLiabilitiesINR,
    netWorthINR: summary.netWorthINR,
    liquidAssetsINR: summary.liquidAssetsINR,
  };
  const idx = snapshots.findIndex((s) => s.period === period);
  const next = idx >= 0 ? snapshots.map((s, i) => (i === idx ? entry : s)) : [...snapshots, entry];
  return { snapshots: next.sort((a, b) => a.period.localeCompare(b.period)), created: idx < 0, period };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { nativeValue, fdAccrued, toINR, isLiquid, enrich, summarize, upsertSnapshot };
