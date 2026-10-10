// Money-weighted return maths. Returns are computed in the holding's own
// currency, and the portfolio aggregate converts cost at today's rate, so the
// figure answers "how did the assets perform" and deliberately excludes FX
// movement — a rupee that weakens against the dollar raises INR net worth
// without being an investment return.

const DAY = 86400000;

function yearsBetween(a, b) {
  return (b - a) / (365 * DAY);
}

function npv(rate, flows, t0) {
  let sum = 0;
  for (const f of flows) {
    const t = yearsBetween(t0, f.date);
    sum += f.amount / Math.pow(1 + rate, t);
  }
  return sum;
}

// Solves for the annual rate where the discounted flows net to zero. Newton
// first for speed, then bisection across a wide bracket because XIRR is not
// guaranteed to have a well-behaved single root.
function xirr(flows, guess = 0.1) {
  const clean = (flows || []).filter((f) => Number.isFinite(f.amount) && f.amount !== 0 && f.date);
  if (clean.length < 2) return null;
  const t0 = new Date(Math.min(...clean.map((f) => f.date.getTime())));
  const sorted = [...clean].sort((a, b) => a.date - b.date);

  const hasOutflow = sorted.some((f) => f.amount < 0);
  const hasInflow = sorted.some((f) => f.amount > 0);
  if (!hasOutflow || !hasInflow) return null;

  const f = (rate) => npv(rate, sorted, t0);
  const df = (rate) => {
    let sum = 0;
    for (const f2 of sorted) {
      const t = yearsBetween(t0, f2.date);
      sum -= (t * f2.amount) / Math.pow(1 + rate, t + 1);
    }
    return sum;
  };

  let rate = guess;
  for (let i = 0; i < 60; i += 1) {
    const value = f(rate);
    const slope = df(rate);
    if (!Number.isFinite(value) || !Number.isFinite(slope) || Math.abs(slope) < 1e-12) break;
    const next = rate - value / slope;
    if (!Number.isFinite(next) || next <= -0.999) break;
    if (Math.abs(next - rate) < 1e-9) return round6(next);
    rate = next;
  }

  let lo = -0.9989;
  let hi = 10;
  let flo = f(lo);
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (!Number.isFinite(fm)) break;
    if (Math.abs(fm) < 1e-6) return round6(mid);
    if (flo * fm < 0) hi = mid;
    else { lo = mid; flo = fm; }
  }
  return null;
}

// Single-lot annualised return: cost today, one value at the end.
function annualised(cost, value, from, to) {
  if (!(cost > 0) || value <= 0 || !from) return null;
  const years = yearsBetween(new Date(from), to);
  if (years <= 0) return null;
  return Math.pow(value / cost, 1 / years) - 1;
}

function holdingReturns(h, today) {
  const value = h.nativeValue ?? 0;
  const cost = h.costNative;
  if (cost === null || cost === undefined || cost === 0) {
    return { costNative: null, costINR: null, gainNative: null, gainINR: null, gainPct: null, annualisedPct: null, yearsHeld: null, taxStatus: null };
  }
  const rate = h.rate ?? 1;
  const years = h.acquiredOn ? yearsBetween(new Date(h.acquiredOn), today) : null;
  return {
    costNative: round2(cost),
    costINR: round2(cost * rate),
    gainNative: round2(value - cost),
    gainINR: round2((value - cost) * rate),
    gainPct: cost !== 0 ? round2(((value - cost) / Math.abs(cost)) * 100) : null,
    annualisedPct: years && years > 0.02 ? round6(annualised(cost, value, h.acquiredOn, today) * 100) : null,
    yearsHeld: years === null ? null : Math.round(years * 10) / 10,
    taxStatus: taxStatus(h, years),
  };
}

// Indian equity/debt holding-period classification. Only meaningful for
// India-country holdings; everything else is reported as n/a.
function taxStatus(h, years) {
  if (!years && years !== 0) return null;
  if (h.country !== 'IN') return 'n/a';
  const equityish = ['equity', 'gold_commodity', 'policy'].includes(h.category);
  if (equityish) return years >= 1 ? 'LTCG' : 'STCG';
  return years >= 24 / 12 ? 'LTCG' : 'STCG';
}

// Attaches return fields to already-enriched holdings.
function applyReturns(holdings, today = new Date()) {
  return holdings.map((h) => ({ ...h, ...holdingReturns(h, today) }));
}

// Portfolio money-weighted return from every lot that carries a cost basis.
function portfolioXirr(holdings, today = new Date()) {
  const costed = holdings.filter((h) => h.costINR !== null && h.acquiredOn && h.category !== 'liability');
  const flows = [];
  let costINR = 0;
  let valueINR = 0;
  for (const h of costed) {
    const rate = h.rate ?? 1;
    flows.push({ date: new Date(h.acquiredOn), amount: -(h.costNative * rate) });
    flows.push({ date: today, amount: h.nativeValue * rate });
    costINR += h.costINR;
    valueINR += h.nativeValue * rate;
  }
  const base = {
    costedINR: round2(costINR),
    costedValueINR: round2(valueINR),
    coveredCount: costed.length,
    uncoveredCount: holdings.filter((h) => h.costINR === null && h.category !== 'liability').length,
  };
  // Two flows is one lot: cost in, value out, which already has a rate.
  if (flows.length < 2) return { xirrPct: null, ...base };
  const rate = xirr(flows, 0.1);
  return {
    xirrPct: rate === null ? null : Math.round(rate * 10000) / 100,
    ...base,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

module.exports = { xirr, applyReturns, portfolioXirr, holdingReturns, taxStatus };
