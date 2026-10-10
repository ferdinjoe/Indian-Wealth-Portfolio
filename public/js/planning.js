// All money is nominal INR. Inflation and salary growth are applied inside the
// engine, so the caller always supplies figures in today's rupees.

function q(x) {
  return Math.max(0, Number(x) || 0) / 100;
}

function yearsBetween(a, b) {
  return Math.max(0, (b || 0) - (a || 0));
}

// Nominal rupees contributed across the year at `index` years from now, with
// the monthly amount escalating alongside salary.
function annualContribution(monthlySurplus, index, growthPct) {
  return (monthlySurplus || 0) * 12 * Math.pow(1 + growthPct, index);
}

function compoundSum(years, rate, growth) {
  // Σ (1+growth)^n * (1+rate)^(years-1-n), n = 0..years-1
  if (years <= 0) return 0;
  const u = (1 + growth) / (1 + rate);
  const s = Math.abs(u - 1) < 1e-9 ? years : (1 - Math.pow(u, years)) / (1 - u);
  return Math.pow(1 + rate, years - 1) * s;
}

// Corpus required on the day you stop working, such that inflation-linked
// withdrawals last until life expectancy and the balance ends at ~zero.
export function requiredCorpus({ monthlyExpensesAtRetirementToday, retireAge, lifeAge, preInflation, postReturn, bufferPct, yearsToRetirement }) {
  const firstYear = (monthlyExpensesAtRetirementToday || 0) * 12 * Math.pow(1 + q(preInflation), yearsToRetirement);
  const span = yearsBetween(retireAge, lifeAge);
  if (span <= 0) return { requiredINR: 0, spanYears: 0, firstYearWithdrawalINR: firstYear, annualWithdrawalAtRetirementINR: firstYear };
  const ratio = (1 + q(preInflation)) / (1 + q(postReturn));
  const multiple = Math.abs(ratio - 1) < 1e-9 ? span : (1 - Math.pow(ratio, span)) / (1 - ratio);
  const base = firstYear * multiple;
  return {
    requiredINR: base * (1 + q(bufferPct)),
    baseCorpusINR: base,
    spanYears: span,
    firstYearWithdrawalINR: firstYear,
    annualWithdrawalAtRetirementINR: firstYear,
    withdrawalMultiple: multiple,
  };
}

// Walks age by age from today to life expectancy: compounds while working,
// then draws inflation-indexed expenses after retirement.
export function project({ netWorthINR, currentAge, retireAge, lifeAge, preReturnPct, postReturnPct, inflationPct, monthlySurplusINR, salaryGrowthPct, annualExpenseAtRetirementINR }) {
  const r = q(preReturnPct);
  const p = q(postReturnPct);
  const i = q(inflationPct);
  const g = q(salaryGrowthPct);
  const endAge = Math.max(lifeAge || 0, retireAge || 0, currentAge + 1);

  let balance = Number(netWorthINR) || 0;
  const series = [{ age: currentAge, balanceINR: round(balance), phase: 'accumulation' }];
  let runsOutAge = null;
  let balanceAtRetirementINR = null;

  for (let age = currentAge; age < endAge; age += 1) {
    const n = age - currentAge;
    if (age < retireAge) {
      balance = balance * (1 + r) + annualContribution(monthlySurplusINR, n, g);
    } else {
      const withdrawal = (annualExpenseAtRetirementINR || 0) * Math.pow(1 + i, age - retireAge);
      balance = balance * (1 + p) - withdrawal;
    }
    if (balanceAtRetirementINR === null && age + 1 >= retireAge) balanceAtRetirementINR = round(balance);
    if (runsOutAge === null && balance < 0) runsOutAge = age + 1;
    series.push({
      age: age + 1,
      balanceINR: round(balance),
      phase: age + 1 <= retireAge && age >= retireAge - 1 ? 'transition' : age + 1 > retireAge ? 'drawdown' : 'accumulation',
    });
  }

  return { series, runsOutAge, balanceAtRetirementINR: balanceAtRetirementINR ?? round(netWorthINR), finalBalanceINR: round(balance) };
}

// One step of the accumulation walk, repeated: the balance compounds at the
// assumed pre-retirement return and gains that year's escalating contributions.
// `financiallyFreeAge`, the FIRE figures and the wealth-band ladder all come
// through here, so a projected year means the same thing everywhere.
export function accumulationCurve({ netWorthINR, years, preReturnPct, monthlySurplusINR, salaryGrowthPct, startAge = 0, startYear = new Date().getFullYear() }) {
  const r = q(preReturnPct);
  const g = q(salaryGrowthPct);
  const span = Math.max(0, Math.floor(Number(years) || 0));
  const baseAge = startAge === null || startAge === undefined || !Number.isFinite(Number(startAge)) ? null : Number(startAge);
  let balance = Number(netWorthINR) || 0;
  const points = [{ index: 0, age: baseAge, year: startYear, balanceINR: round(balance) }];
  for (let n = 0; n < span; n += 1) {
    balance = balance * (1 + r) + annualContribution(monthlySurplusINR, n, g);
    points.push({ index: n + 1, age: baseAge === null ? null : baseAge + n + 1, year: startYear + n + 1, balanceINR: round(balance) });
  }
  return points;
}

// First age at which the accumulation curve alone clears the target corpus.
export function financiallyFreeAge({ netWorthINR, currentAge, preReturnPct, monthlySurplusINR, salaryGrowthPct, targetINR, horizonAge = 100 }) {
  const points = accumulationCurve({
    netWorthINR, years: Math.max(0, horizonAge - currentAge),
    preReturnPct, monthlySurplusINR, salaryGrowthPct, startAge: currentAge,
  });
  const hit = points.find((p) => p.balanceINR >= targetINR);
  return hit ? hit.age : null;
}

// Extra monthly investment, escalating with salary, whose future value equals
// the shortfall.
export function monthlyTopUpFor(gapINR, yearsToRetirement, preReturnPct, salaryGrowthPct) {
  if (gapINR <= 0 || yearsToRetirement <= 0) return 0;
  const factor = compoundSum(yearsToRetirement, q(preReturnPct), q(salaryGrowthPct));
  if (factor <= 0) return 0;
  // compoundSum scales a year's contribution, and a year is 12 months.
  return Math.ceil(gapINR / (12 * factor) / 100) * 100;
}

export function buildPlan({ profile, assumptions, netWorthINR, liquidAssetsINR, currentAge }) {
  const dobAge = Number.isFinite(currentAge) ? currentAge : (profile.plannedRetirementAge || 60);
  const retireAge = profile.plannedRetirementAge || 60;
  const lifeAge = profile.lifeExpectancy || 90;
  const yearsToRetirement = yearsBetween(dobAge, retireAge);

  const preReturnPct = assumptions.preRetirementReturnPct;
  const postReturnPct = assumptions.postRetirementReturnPct;
  const inflationPct = assumptions.inflationPct;
  const salaryGrowthPct = assumptions.salaryGrowthPct;
  const surplus = profile.monthlyInvestableSurplusINR || 0;
  const expenseToday = profile.monthlyExpensesInRetirementINR || 0;

  const corpus = requiredCorpus({
    monthlyExpensesAtRetirementToday: expenseToday,
    retireAge,
    lifeAge,
    preInflation: inflationPct,
    postReturn: postReturnPct,
    bufferPct: assumptions.corpusBufferPct,
    yearsToRetirement,
  });

  const baseline = project({
    netWorthINR, currentAge: dobAge, retireAge, lifeAge,
    preReturnPct, postReturnPct, inflationPct,
    monthlySurplusINR: surplus, salaryGrowthPct,
    annualExpenseAtRetirementINR: corpus.annualWithdrawalAtRetirementINR,
  });

  const gap = Math.max(0, corpus.requiredINR - (baseline.balanceAtRetirementINR || 0));
  const topUp = monthlyTopUpFor(gap, yearsToRetirement, preReturnPct, salaryGrowthPct);

  const funded = project({
    netWorthINR, currentAge: dobAge, retireAge, lifeAge,
    preReturnPct, postReturnPct, inflationPct,
    monthlySurplusINR: surplus + topUp, salaryGrowthPct,
    annualExpenseAtRetirementINR: corpus.annualWithdrawalAtRetirementINR,
  });

  const freeAge = financiallyFreeAge({
    netWorthINR, currentAge: dobAge, preReturnPct,
    monthlySurplusINR: surplus + topUp, salaryGrowthPct, targetINR: corpus.requiredINR,
  });

  return {
    currentAge: dobAge,
    retireAge,
    lifeAge,
    yearsToRetirement,
    corpus,
    gapINR: gap,
    gapTodayValueINR: yearsToRetirement > 0 ? gap / Math.pow(1 + q(inflationPct), yearsToRetirement) : gap,
    additionalMonthlyTopUpINR: topUp,
    progressPct: corpus.requiredINR > 0 ? Math.min(100, (baseline.balanceAtRetirementINR / corpus.requiredINR) * 100) : 100,
    fundedProgressPct: corpus.requiredINR > 0 ? Math.min(140, (funded.balanceAtRetirementINR / corpus.requiredINR) * 100) : 100,
    baseline,
    funded,
    financiallyFreeAge: freeAge,
    liquidMonthsCover: expenseToday > 0 ? (liquidAssetsINR || 0) / expenseToday : null,
    projectedNominalNetWorthINR: baseline.balanceAtRetirementINR,
    warnings: buildWarnings({ profile, baseline, corpus, gap, yearsToRetirement, retireAge, lifeAge, assumptions }),
  };
}

// Cash-flow health and financial-independence maths. Everything is monthly
// rupees as stored on the profile; the 4%-rule multiple is 25x annual spend.
export function cashFlow({ profile, netWorthINR, totalLiabilitiesINR, currentAge, assumptions }) {
  const income = Number(profile.monthlyIncomeINR) || 0;
  const spending = Number(profile.monthlyExpensesNowINR) || 0;
  const emi = Number(profile.monthlyEmiINR) || 0;
  const surplus = Number(profile.monthlyInvestableSurplusINR) || 0;
  const committed = spending + emi;
  const uninvested = income - committed;
  const netWorth = Number(netWorthINR) || 0;

  const yearsToRetirement = Math.max(0, (Number(profile.plannedRetirementAge) || 60) - currentAge);
  const returnPct = Number(assumptions.preRetirementReturnPct) || 0;
  const fireNumberINR = committed * 12 * 25;
  // Corpus that, left untouched at the assumed return, becomes the FIRE number
  // by the planned retirement age: above it, contributions can stop.
  const coastFireINR = fireNumberINR / Math.pow(1 + returnPct / 100, yearsToRetirement);

  const fireAge = fireNumberINR > 0
    ? financiallyFreeAge({
      netWorthINR: netWorth,
      currentAge,
      preReturnPct: returnPct,
      monthlySurplusINR: surplus,
      salaryGrowthPct: assumptions.salaryGrowthPct,
      targetINR: fireNumberINR,
      horizonAge: 100,
    })
    : null;

  return {
    monthlyIncomeINR: income,
    monthlySpendingINR: spending,
    monthlyEmiINR: emi,
    monthlyCommittedINR: committed,
    monthlyInvestedINR: surplus,
    monthlyUnallocatedINR: uninvested,
    // What actually accumulates is what gets invested, so the headline savings
    // rate uses committed outflow; the gap between that and the invested amount
    // is cash neither spent nor put to work.
    savingsRatePct: income > 0 ? (uninvested / income) * 100 : null,
    investedRatePct: income > 0 ? (surplus / income) * 100 : null,
    leakINR: income > 0 ? Math.max(0, uninvested - surplus) : 0,
    fireNumberINR,
    fireProgressPct: fireNumberINR > 0 ? (netWorth / fireNumberINR) * 100 : null,
    coastFireINR,
    coastProgressPct: coastFireINR > 0 ? (netWorth / coastFireINR) * 100 : null,
    fireAge,
    yearsToFire: fireAge === null ? null : Math.max(0, fireAge - currentAge),
    emiBurdenPct: income > 0 ? (emi / income) * 100 : null,
    debtToIncomeYears: income > 0 ? (Number(totalLiabilitiesINR) || 0) / (income * 12) : null,
  };
}

// ---------- wealth bands ----------
// The Indian private-bank bands. A balance belongs to the highest floor it
// clears, and the number measured against them is net worth in rupees - the same
// figure the dashboard headline prints, so the label cannot disagree with it.
export const WEALTH_TIERS = [
  { key: 'below', label: 'Below Mass Affluent', floorINR: 0 },
  { key: 'mass', label: 'Mass Affluent', floorINR: 25e5 },
  { key: 'emerging', label: 'Emerging HNI', floorINR: 5e6 },
  { key: 'hni', label: 'HNI', floorINR: 5e7 },
  { key: 'vhni', label: 'Very HNI (VHNI)', floorINR: 25e7 },
  { key: 'uhni', label: 'Ultra HNI (UHNI)', floorINR: 1e9 },
];

export function tierFor(netWorthINR) {
  const net = Number(netWorthINR) || 0;
  let index = 0;
  for (let i = 0; i < WEALTH_TIERS.length; i += 1) if (net >= WEALTH_TIERS[i].floorINR) index = i;
  const tier = WEALTH_TIERS[index];
  const next = WEALTH_TIERS[index + 1] || null;
  return {
    index,
    tier,
    next,
    isTop: next === null,
    ahead: WEALTH_TIERS.slice(index + 1),
    // How far through the current band the balance already is, so the label can
    // say "83% of the way to the next one" without the view doing arithmetic.
    bandProgressPct: next ? Math.max(0, Math.min(100, ((net - tier.floorINR) / (next.floorINR - tier.floorINR)) * 100)) : 100,
  };
}

// The first curve point that clears `floorINR`, or null within the horizon.
function crossing(points, floorINR) {
  const hit = points.find((p) => p.balanceINR >= floorINR);
  return hit ? { years: hit.index, age: hit.age, year: hit.year, balanceINR: hit.balanceINR } : null;
}

// What it takes to reach the next bands: the gap in rupees, how long the current
// trajectory needs, and what a fixed five- or ten-year deadline would cost.
export function tierLadder({ netWorthINR, currentAge, assumptions, profile, horizonYears = 30, startYear = new Date().getFullYear() }) {
  const net = Number(netWorthINR) || 0;
  const preReturnPct = Number(assumptions && assumptions.preRetirementReturnPct) || 0;
  const salaryGrowthPct = Number(assumptions && assumptions.salaryGrowthPct) || 0;
  const monthlySurplusINR = Number(profile && profile.monthlyInvestableSurplusINR) || 0;
  const walk = { years: horizonYears, preReturnPct, salaryGrowthPct, startAge: currentAge, startYear };
  const curve = accumulationCurve({ ...walk, netWorthINR: net, monthlySurplusINR });
  // The same walk with no new money, to show how much of the climb is compounding
  // and how much of it is yours to fund.
  const growthOnlyCurve = accumulationCurve({ ...walk, netWorthINR: net, monthlySurplusINR: 0 });
  const current = tierFor(net);

  const monthlyInvestingFor = (floorINR, years) => {
    const grown = net * Math.pow(1 + q(preReturnPct), years);
    return monthlyTopUpFor(Math.max(0, floorINR - grown), years, preReturnPct, salaryGrowthPct);
  };

  return {
    netWorthINR: net,
    currentAge: currentAge === null || currentAge === undefined || !Number.isFinite(Number(currentAge)) ? null : Number(currentAge),
    horizonYears,
    current,
    inputs: { preReturnPct, salaryGrowthPct, monthlySurplusINR },
    curve,
    endBalanceINR: curve[curve.length - 1].balanceINR,
    // Every band still ahead of the balance, with the year the trajectory enters it.
    crossings: current.ahead.map((t) => ({ tier: t, at: crossing(curve, t.floorINR) })),
    targets: current.ahead.slice(0, 2).map((t) => ({
      tier: t,
      gapINR: Math.max(0, t.floorINR - net),
      multipleNeeded: net > 0 ? t.floorINR / net : null,
      atPace: crossing(curve, t.floorINR),
      growthOnly: crossing(growthOnlyCurve, t.floorINR),
      // The TOTAL monthly investing that lands the band inside five or ten years -
      // what today's balance becomes is already credited, so this is the investing
      // level to hold, not an amount added to the one already recorded.
      investMonthlyINR: { five: monthlyInvestingFor(t.floorINR, 5), ten: monthlyInvestingFor(t.floorINR, 10) },
    })),
  };
}

// ---------- per-asset wealth projection ----------

// Fifteen year-end balances, which is also the "next 5 / 10 / 15 years" the
// milestone columns answer.
export const PROJECTION_YEARS = 15;

// A measured return is history, not a promise. One good year on a volatile lot
// must not be extrapolated into a permanent 60% clip, so a measured rate is only
// trusted once the lot has a year of history, and only ever inside this band.
export const MEASURED_RATE = { minPct: -15, maxPct: 30, minYearsHeld: 1 };

export const RATE_WHY = {
  measured: 'its own measured return',
  coupon: 'the rate it pays',
  assumed: 'the Settings assumption',
  override: 'the rate you set',
  flat: 'held flat',
};

// Which growth rate a row gets, and why. Liabilities are held flat by the
// caller: a home loan balance does not compound like an equity holding.
export function assetGrowthRate(row, { assumptionPct = 0, overridePct = null } = {}) {
  if (overridePct !== null && overridePct !== '' && Number.isFinite(Number(overridePct))) {
    return { ratePct: Number(overridePct), why: 'override', capped: false };
  }
  const measured = Number(row.annualisedPct);
  const held = Number(row.yearsHeld);
  if (Number.isFinite(measured) && Number.isFinite(held) && held >= MEASURED_RATE.minYearsHeld) {
    const capped = Math.min(MEASURED_RATE.maxPct, Math.max(MEASURED_RATE.minPct, measured));
    return { ratePct: Math.round(capped * 100) / 100, why: 'measured', capped: capped !== measured, rawPct: measured };
  }
  const coupon = Number(row.interestRatePct);
  if (Number.isFinite(coupon) && coupon > 0) return { ratePct: coupon, why: 'coupon', capped: false };
  return { ratePct: Number(assumptionPct) || 0, why: 'assumed', capped: false };
}

// Compounding alone: nothing new goes in and nothing comes out. A rate at or
// below -100% wipes the balance rather than producing a complex number.
export function projectValue(valueINR, ratePct, years) {
  const v = Number(valueINR) || 0;
  const n = Math.max(0, Math.floor(Number(years) || 0));
  if (v === 0 || n === 0) return round(v);
  const factor = Math.max(0, 1 + (Number(ratePct) || 0) / 100);
  return round(v * Math.pow(factor, n));
}

export function wealthProjection({
  holdings = [], assumptionPct = 0, overridePct = null,
  years = PROJECTION_YEARS, startYear = new Date().getFullYear(),
}) {
  const span = Math.max(1, Math.floor(Number(years) || PROJECTION_YEARS));
  const at = (series, n) => (n <= span ? series[n - 1] : null);
  const milestonesOf = (series) => ({ five: at(series, 5), ten: at(series, 10), fifteen: at(series, 15) });

  const rows = holdings
    .filter((h) => h.category !== 'liability')
    .map((h) => {
      const g = assetGrowthRate(h, { assumptionPct, overridePct });
      const today = h.valueINR || 0;
      const series = [];
      for (let n = 1; n <= span; n += 1) series.push(projectValue(today, g.ratePct, n));
      return {
        id: h.id,
        name: h.name,
        category: h.category,
        country: h.country,
        currency: h.currency,
        todayINR: round(today),
        priced: h.valueINR !== null && h.valueINR !== undefined,
        ratePct: g.ratePct,
        why: g.why,
        capped: g.capped,
        rawPct: g.rawPct ?? null,
        series,
        milestones: milestonesOf(series),
      };
    })
    .sort((a, b) => b.todayINR - a.todayINR);

  const sumSeries = (list) => {
    const out = [];
    for (let n = 0; n < span; n += 1) out.push(list.reduce((a, r) => a + r.series[n], 0));
    return out;
  };

  const assetSeries = sumSeries(rows);
  const assetToday = rows.reduce((a, r) => a + r.todayINR, 0);
  // Debts are held flat rather than grown: the balance you owe falls as you pay
  // it down, and the ledger has no idea what the repayments will be.
  const debtToday = holdings
    .filter((h) => h.category === 'liability')
    .reduce((a, h) => a + (h.valueINR || 0), 0);
  const netSeries = assetSeries.map((v) => round(v - debtToday));

  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.category) || [];
    g.push(r);
    groups.set(r.category, g);
  }
  const byCategory = [...groups.entries()]
    .map(([key, list]) => {
      const series = sumSeries(list);
      return {
        key,
        count: list.length,
        todayINR: list.reduce((a, r) => a + r.todayINR, 0),
        series,
        milestones: milestonesOf(series),
      };
    })
    .sort((a, b) => b.todayINR - a.todayINR);

  const netToday = round(assetToday - debtToday);
  const endNet = netSeries[netSeries.length - 1];
  const yearsOut = span;
  return {
    years: span,
    startYear,
    // Column headers: 2027 … startYear + span.
    yearLabels: Array.from({ length: span }, (_, i) => startYear + i + 1),
    inputs: { assumptionPct: Number(assumptionPct) || 0, overridePct: overridePct === null || overridePct === '' ? null : Number(overridePct) },
    rows,
    byCategory,
    totals: {
      todayINR: round(assetToday),
      series: assetSeries,
      milestones: milestonesOf(assetSeries),
      debtINR: round(debtToday),
      liabilityCount: holdings.filter((h) => h.category === 'liability').length,
      netTodayINR: netToday,
      netSeries,
      netMilestones: { five: at(netSeries, 5), ten: at(netSeries, 10), fifteen: at(netSeries, 15) },
      // The single rate that turns today's net worth into the projected one, so
      // the headline has a growth number that survives adding and removing rows.
      blendedPct: netToday > 0 && endNet > 0
        ? Math.round((Math.pow(endNet / netToday, 1 / yearsOut) - 1) * 10000) / 100
        : null,
    },
  };
}

function buildWarnings({ profile, baseline, corpus, gap, yearsToRetirement, retireAge, lifeAge, assumptions }) {
  const out = [];
  if (!profile.dateOfBirth) out.push({ level: 'bad', text: 'No date of birth on the Profile tab, so age-driven projections assume you retire immediately.' });
  if (!(profile.monthlyExpensesInRetirementINR > 0)) out.push({ level: 'bad', text: 'Set your expected monthly retirement spending to size the target corpus.' });
  if (corpus.requiredINR > 0 && baseline.balanceAtRetirementINR >= corpus.requiredINR && gap <= 0) out.push({ level: 'ok', text: 'Current trajectory already covers the target corpus.' });
  if (baseline.runsOutAge && baseline.runsOutAge <= lifeAge) out.push({ level: 'bad', text: `Funds run out at age ${baseline.runsOutAge} on today's saving rate.` });
  if (yearsToRetirement === 0 && profile.dateOfBirth) out.push({ level: 'warn', text: 'Retirement age is at or before your current age, so the plan is in drawdown now.' });
  if (assumptions.postRetirementReturnPct <= assumptions.inflationPct) out.push({ level: 'warn', text: 'Post-retirement return is at or below inflation, so purchasing power erodes while you draw down.' });
  if (retireAge >= lifeAge) out.push({ level: 'bad', text: 'Retirement age must be earlier than life expectancy.' });
  return out;
}

function round(n) {
  return Math.round(n);
}
