// The detailed diagnostics behind the Portfolio health tab.
//
// healthScore in analysis.js answers "what grade is this portfolio" with six
// components. This answers the follow-up - *why*, and what to do about it - by
// running a wider set of plain rules over the same valued rows and reporting the
// number that produced each verdict next to the verdict.
//
// Every rule reads the ledger as it stands. Nothing is inferred about the owner's
// intentions beyond the targets, profile figures and rates they have entered, and
// a rule with no input to work from reports `unknown` instead of guessing.

const analysis = require('./analysis');
const prices = require('./prices');
const metals = require('./metals');
const bonds = require('./bonds');

// DICGC insures deposits held with an Indian bank, per depositor, per bank.
const DEPOSIT_INSURANCE_LIMIT = 500_000;
const DEPOSIT_CATEGORIES = new Set(['bank_account', 'fixed_deposit']);

// Categories whose interestRatePct means income. real_estate is absent on purpose:
// rent belongs in the profile's other income, not on an asset row.
const RATE_CATEGORIES = new Set(['bank_account', 'fixed_deposit', 'bond', 'policy', 'retirement_scheme', 'other_asset']);

const THEMES = [
  { key: 'concentration', label: 'Concentration', note: 'how much rests on any one holding' },
  { key: 'access', label: 'Access & lock-in', note: 'money you can reach, and money you cannot' },
  { key: 'earning', label: 'Earning power', note: 'what the portfolio pays against what it costs' },
  { key: 'structure', label: 'Plan discipline', note: 'what you own against the plan you recorded' },
  { key: 'counterparty', label: 'Counterparty', note: 'how much sits with any one bank or broker' },
  { key: 'records', label: 'Ledger trust', note: 'what these numbers can honestly show' },
];

// These are diagnostic figures, not headlines, so they carry full digits: the
// point of the line is the exact amount sitting uninsured or frozen.
const inrGroup = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

function inr(n) {
  const v = Math.round(Number(n) || 0);
  return `${v < 0 ? '-' : ''}₹${inrGroup.format(Math.abs(v))}`;
}

function pctText(n) {
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '-' : ''}${Math.abs(n).toFixed(1)}%`;
}

// Ten years of cover reads as noise in months, so long horizons switch to years.
function coverText(months) {
  if (!Number.isFinite(months)) return 'no measurable cover';
  return months >= 120
    ? `${(months / 12).toFixed(1)} years of spending`
    : `${months.toFixed(1)} months of spending`;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function assetsOf(rows) {
  return rows.filter((r) => r.category !== 'liability' && (r.valueINR || 0) > 0);
}

function sum(list) {
  return list.reduce((a, r) => a + (r.valueINR || 0), 0);
}

function todayISO(today) {
  return today.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ income ---

// Contractual income the ledger can actually see: a rate on a deposit, bond,
// policy, pension or savings row, and a stated dividend yield on a share. Growth
// assets without a stated yield are counted as silent rather than as zero - the
// distinction is what the earning-versus-silent split reports.
function earning(rows) {
  const assets = assetsOf(rows);
  const totalAssets = sum(assets);
  let interestIncomeINR = 0;
  let dividendIncomeINR = 0;
  let earningValueINR = 0;
  let silentValueINR = 0;
  let silentCount = 0;

  for (const h of assets) {
    const rate = Number(h.interestRatePct);
    const dividend = Number(h.dividendYieldPct);
    const hasRate = RATE_CATEGORIES.has(h.category) && Number.isFinite(rate) && rate > 0;
    const hasDividend = h.category === 'equity' && Number.isFinite(dividend) && dividend > 0;
    if (!hasRate && !hasDividend) {
      silentValueINR += h.valueINR;
      silentCount += 1;
      continue;
    }
    earningValueINR += h.valueINR;
    if (hasRate) interestIncomeINR += (h.valueINR * rate) / 100;
    if (hasDividend) dividendIncomeINR += (h.valueINR * dividend) / 100;
  }

  const annualIncomeINR = interestIncomeINR + dividendIncomeINR;

  const debt = rows.filter((r) => r.category === 'liability' && (r.valueINR || 0) > 0);
  const debtValueINR = sum(debt);
  // A liability with no rate entered is not free money: it is left out of the
  // blended cost rather than counted at zero, which would flatter the spread.
  const costed = debt.filter((r) => Number(r.interestRatePct) > 0);
  const costedValue = sum(costed);

  return {
    annualIncomeINR: round(annualIncomeINR),
    interestIncomeINR: round(interestIncomeINR),
    dividendIncomeINR: round(dividendIncomeINR),
    earningValueINR: round(earningValueINR),
    earningCount: assets.length - silentCount,
    silentValueINR: round(silentValueINR),
    silentCount,
    // Two different questions, so two numbers: what the earning part of the
    // portfolio returns, and what the whole of it throws off.
    blendedYieldPct: earningValueINR ? round((annualIncomeINR / earningValueINR) * 100) : null,
    portfolioYieldPct: totalAssets ? round((annualIncomeINR / totalAssets) * 100) : null,
    debtValueINR: round(debtValueINR),
    // The value-weighted mean of the rates themselves, not of the rupee interest:
    // dividing interest by value would give a fraction where a percent is claimed.
    debtCostPct: costedValue
      ? round(costed.reduce((a, r) => a + r.valueINR * Number(r.interestRatePct), 0) / costedValue)
      : null,
    uncostedDebtINR: round(debtValueINR - costedValue),
  };
}

// ----------------------------------------------------------------- ladder ----

// Assets by the year they free up. A deposit that renews has already been rolled
// forward when the store read it, so its maturity is the term now running - which
// is what makes this a picture of the next decade rather than a list of overdue
// rows.
function maturityLadder(rows, today) {
  const buckets = new Map();
  let undatedINR = 0;
  for (const h of assetsOf(rows)) {
    // Number('') is 0, which would park every undated row in a phantom year 0
    // bucket, so the date has to be present before its year is read.
    const year = h.maturityDate ? Number(String(h.maturityDate).slice(0, 4)) : NaN;
    if (!Number.isFinite(year)) {
      undatedINR += h.valueINR;
      continue;
    }
    const b = buckets.get(year) || { year, valueINR: 0, count: 0, names: [] };
    b.valueINR += h.valueINR;
    b.count += 1;
    if (b.names.length < 4) b.names.push(h.name || 'Unnamed');
    buckets.set(year, b);
  }
  const ladder = [...buckets.values()]
    .sort((a, b) => a.year - b.year)
    .map((b) => ({ ...b, valueINR: round(b.valueINR), overdue: b.year < today.getUTCFullYear() }));
  const datedINR = ladder.reduce((a, b) => a + b.valueINR, 0);
  const future = ladder.filter((b) => b.year >= today.getUTCFullYear());
  const biggest = future.reduce((a, b) => (!a || b.valueINR > a.valueINR ? b : a), null);
  return {
    ladder,
    undatedINR: round(undatedINR),
    datedINR: round(datedINR),
    // One year holding most of the dated money is a reinvestment decision taken
    // on a single day, at whatever rate the market offers that day.
    cliff: datedINR && biggest ? { year: biggest.year, valueINR: biggest.valueINR, pct: round((biggest.valueINR / datedINR) * 100) } : null,
  };
}

// ------------------------------------------------------------ counterparty ---

// Grouped by the text the owner typed as the bank or broker, because that is the
// counterparty a deposit-insurance limit or a platform outage applies to.
function institutionExposure(rows) {
  const assets = assetsOf(rows);
  const total = sum(assets) || 1;
  const groups = new Map();
  let unnamedINR = 0;
  let unnamedCount = 0;
  for (const h of assets) {
    const name = String(h.institution || '').trim();
    if (!name) {
      unnamedINR += h.valueINR;
      unnamedCount += 1;
      continue;
    }
    const g = groups.get(name) || { name, valueINR: 0, count: 0, categories: new Set() };
    g.valueINR += h.valueINR;
    g.count += 1;
    g.categories.add(h.category);
    groups.set(name, g);
  }
  const list = [...groups.values()]
    .map((g) => ({
      name: g.name,
      valueINR: round(g.valueINR),
      count: g.count,
      categories: [...g.categories],
      pct: round((g.valueINR / total) * 100),
    }))
    .sort((a, b) => b.valueINR - a.valueINR);

  // Indian deposit money against the insurance limit, bank by bank: cover is per
  // depositor per bank, so two banks at ₹4 lakh each are both fully covered while
  // one at ₹8 lakh is not.
  const deposits = new Map();
  for (const h of assets) {
    if (!DEPOSIT_CATEGORIES.has(h.category) || (h.country || '').toUpperCase() !== 'IN') continue;
    const name = String(h.institution || '').trim() || 'Bank not recorded';
    const d = deposits.get(name) || { name, valueINR: 0, count: 0 };
    d.valueINR += h.valueINR;
    d.count += 1;
    deposits.set(name, d);
  }
  const depositBanks = [...deposits.values()]
    .map((d) => ({
      name: d.name,
      count: d.count,
      valueINR: round(d.valueINR),
      insuredINR: round(Math.min(d.valueINR, DEPOSIT_INSURANCE_LIMIT)),
      uncoveredINR: round(Math.max(0, d.valueINR - DEPOSIT_INSURANCE_LIMIT)),
    }))
    .sort((a, b) => b.valueINR - a.valueINR);

  return {
    list,
    unnamedINR: round(unnamedINR),
    unnamedCount,
    deposits: depositBanks,
    depositsINR: round(depositBanks.reduce((a, d) => a + d.valueINR, 0)),
    uncoveredINR: round(depositBanks.reduce((a, d) => a + d.uncoveredINR, 0)),
  };
}

// --------------------------------------------------------------- data gaps ---

// The rows the refresh batch would attempt to price. A row in that set with no
// quote date has been asked for and never answered, which is a data gap; a row
// the owner pinned is a choice, so it is counted separately and not criticised.
function pricingGaps(rows) {
  const feedable = rows.filter((h) => prices.isTrackable(h) || metals.isTrackable(h) || bonds.isTrackable(h));
  const blind = feedable.filter((h) => !h.priceAsOf);
  const pinned = rows.filter((h) => h.priceAuto === false && (prices.AUTO_CATEGORIES.has(h.category) || h.category === 'bond'));
  return {
    feedableCount: feedable.length,
    pricedCount: feedable.length - blind.length,
    blindCount: blind.length,
    blindNames: blind.map((h) => h.name || 'Unnamed'),
    blindValueINR: round(sum(blind)),
    pinnedCount: pinned.length,
    pinnedValueINR: round(sum(pinned)),
  };
}

// ------------------------------------------------------------------ checks ---

// A check states its own number so the page can show verdict and evidence in one
// line, with no figure the reader has to go and find elsewhere.
function makeCheck(key, theme, label, verdict, detail, remedy, view) {
  const needsAction = verdict === 'risk' || verdict === 'watch' || verdict === 'unknown';
  return { key, theme, label, verdict, detail, remedy: needsAction ? remedy : null, view: needsAction ? view : null };
}

function buildChecks({ rows, profile, assumptions, age, goals, allocation, concentration, geography, health, income, ladder, institutions, pricing, unconverted, today }) {
  const checks = [];
  const assets = assetsOf(rows);
  // With nothing valued, every ratio below is a zero over a placeholder one, and
  // the page would read as a portfolio in trouble rather than an empty ledger.
  if (!assets.length) {
    return [makeCheck(
      'nothing-to-measure', 'records', 'Nothing to measure', 'unknown',
      'No holding on the ledger carries a value, so there is no portfolio to judge',
      'Add a holding, or give an existing row a value, and every check on this page starts working.',
      'holdings',
    )];
  }
  const totalAssets = sum(assets);
  const liabilitiesINR = sum(rows.filter((r) => r.category === 'liability'));
  const monthlySpend = Number(profile.monthlyExpensesNowINR) || 0;
  const annualSpend = monthlySpend * 12;
  const inflation = Number(assumptions.inflationPct) || 0;
  const todayText = todayISO(today);

  // ---- Concentration ------------------------------------------------------
  const largest = [...assets].sort((a, b) => b.valueINR - a.valueINR)[0];
  const top1 = concentration.top1Pct;
  checks.push(makeCheck(
    'single-name', 'concentration', 'Largest single holding',
    top1 < 20 ? 'good' : top1 < 35 ? 'watch' : 'risk',
    `${concentration.largest || '—'} is ${pctText(top1)} of gross assets${largest ? ` (${inr(largest.valueINR)})` : ''}`,
    'Route new money into something else until it falls below a third of the portfolio.',
    'holdings',
  ));

  const top5 = concentration.top5Pct;
  const top5Note = top5 >= 75 ? 'three quarters or more of your worth moves with five prices'
    : top5 > 50 ? 'more than half your worth moves with five prices'
      : 'half your worth moves with five prices';
  checks.push(makeCheck(
    'top-five', 'concentration', 'Five largest together',
    top5 < 50 ? 'good' : top5 < 70 ? 'watch' : 'risk',
    `The five largest holdings are ${pctText(top5)} of assets${top5 >= 50 ? ` — ${top5Note}` : ''}`,
    'Broaden the tail: an index fund or a further deposit pulls the fifth-name share down.',
    'holdings',
  ));

  const heaviest = allocation.rows.reduce((a, r) => (!a || r.actualPct > a.actualPct ? r : a), null);
  const heaviestRows = heaviest ? assets.filter((r) => r.category === heaviest.key).length : 0;
  checks.push(makeCheck(
    'class-weight', 'concentration', 'Heaviest asset class',
    !heaviest || heaviest.actualPct < 50 ? 'good' : heaviest.actualPct < 70 ? 'watch' : 'risk',
    heaviest
      ? `${heaviest.label}: ${pctText(heaviest.actualPct)} of assets, in ${heaviestRows} ${heaviestRows === 1 ? 'row' : 'rows'}`
      : 'Nothing is valued yet',
    'One class dominating is a decision rather than a fault — the point is to know which class you are deciding.',
    'allocation',
  ));

  const classCount = new Set(assets.map((r) => r.category)).size;
  checks.push(makeCheck(
    'spread-count', 'concentration', 'How thinly it is spread',
    assets.length >= 12 ? 'good' : assets.length >= 6 ? 'watch' : 'risk',
    `${assets.length} valued ${assets.length === 1 ? 'holding' : 'holdings'} across ${classCount} asset ${classCount === 1 ? 'class' : 'classes'}`,
    'More, smaller positions are what turn a handful of bets into a portfolio.',
    'holdings',
  ));

  // ---- Access -------------------------------------------------------------
  const liquidINR = sum(assets.filter((r) => r.liquid));
  const months = monthlySpend > 0 ? liquidINR / monthlySpend : null;
  checks.push(makeCheck(
    'emergency-cover', 'access', 'Emergency cover',
    months === null ? 'unknown' : months >= 6 ? 'good' : months >= 3 ? 'watch' : 'risk',
    months === null
      ? 'Monthly spending is not in Profile, so cover cannot be measured'
      : `${coverText(months)} — ${inr(liquidINR)} liquid against ${inr(monthlySpend)} a month`,
    months === null
      ? 'Enter your monthly spending on the Profile tab and this becomes a number.'
      : 'Hold six months of spending in savings or a deposit you can break.',
    months === null ? 'profile' : 'holdings',
  ));

  const illiquidPct = ((totalAssets - liquidINR) / totalAssets) * 100;
  checks.push(makeCheck(
    'illiquid-share', 'access', 'Money you cannot reach quickly',
    illiquidPct < 40 ? 'good' : illiquidPct < 65 ? 'watch' : 'risk',
    `${pctText(illiquidPct)} of assets sit in property, gold, policies or rows marked illiquid (${inr(totalAssets - liquidINR)})`,
    'Illiquid is fine as a plan. The test is whether a year of living could be funded without selling any of it.',
    'holdings',
  ));

  const cliff = ladder.cliff;
  checks.push(makeCheck(
    'maturity-cliff', 'access', 'Dated money landing at once',
    !cliff ? 'unknown' : cliff.pct < 25 ? 'good' : cliff.pct < 45 ? 'watch' : 'risk',
    cliff
      ? `${pctText(cliff.pct)} of dated assets (${inr(cliff.valueINR)}) come due in ${cliff.year}, across ${ladder.ladder.length} year${ladder.ladder.length === 1 ? '' : 's'} on the ladder`
      : 'Nothing in the ledger carries a maturity date',
    'Spread deposits and bonds over the calendar so one renewal day does not set your rate for the decade.',
    'holdings',
  ));

  const frozen = assets.filter((h) => h.category === 'fixed_deposit' && !h.fdAutoRenew && h.maturityDate && h.maturityDate < todayText);
  checks.push(makeCheck(
    'frozen-deposits', 'access', 'Deposits past their term',
    frozen.length ? 'risk' : 'good',
    frozen.length
      ? `${inr(sum(frozen))} across ${frozen.length} deposit${frozen.length === 1 ? '' : 's'} matured${frozen.length === 1 ? ` on ${frozen[0].maturityDate}` : ''} and is not set to renew, so its value has stopped growing`
      : 'Every deposit is inside its term or set to renew at the end of it',
    'Turn on Renew at maturity, or re-book the deposit and update its rate.',
    'holdings',
  ));

  const termless = assets.filter((h) => h.category === 'fixed_deposit' && !h.termMonths);
  checks.push(makeCheck(
    'termless-deposits', 'access', 'Deposits with no term',
    termless.length ? 'watch' : 'good',
    termless.length
      ? `${termless.map((h) => h.name || 'Unnamed').join(', ')} ${termless.length === 1 ? 'has' : 'have'} no term in months, so nothing accrues on ${termless.length === 1 ? 'it' : 'them'} and ${termless.length === 1 ? 'it cannot' : 'they cannot'} renew — ${inr(sum(termless))} held this way`
      : 'Every deposit carries a term, so each one accrues and can roll over',
    'Enter the term in months on the deposit row.',
    'holdings',
  ));

  // ---- Earning power ------------------------------------------------------
  const yieldPct = income.blendedYieldPct;
  const yieldKnown = yieldPct !== null && inflation > 0;
  checks.push(makeCheck(
    'yield-vs-inflation', 'earning', 'Yield against inflation',
    yieldPct === null ? 'unknown' : !inflation ? 'unknown'
      : yieldPct > inflation + 1 ? 'good' : yieldPct >= inflation - 1 ? 'watch' : 'risk',
    yieldPct === null
      ? `No row states a rate, so there is no yield to compare — ${inr(income.silentValueINR)} sits in assets carrying none`
      : !inflation
        ? `Earning assets return ${pctText(yieldPct)} but the inflation assumption is zero, so there is nothing to compare it with`
        : `Earning assets return ${pctText(yieldPct)} against ${pctText(inflation)} assumed inflation — ${yieldPct >= inflation ? 'ahead of' : 'behind'} ${pctText(Math.abs(yieldPct - inflation))} a year`,
    inflation
      ? 'A yield under inflation is a slow loss booked as safety: lift the rate mix or hold assets whose return is not a fixed coupon.'
      : 'Set the inflation assumption on the Retirement tab.',
    inflation ? 'holdings' : 'planner',
  ));

  const coverPct = annualSpend > 0 ? (income.annualIncomeINR / annualSpend) * 100 : null;
  checks.push(makeCheck(
    'passive-cover', 'earning', 'Spending covered by income',
    coverPct === null ? 'unknown' : coverPct >= 50 ? 'good' : coverPct >= 20 ? 'watch' : 'risk',
    coverPct === null
      ? 'Recording monthly spending in Profile turns this into a percentage'
      : `${inr(income.annualIncomeINR)} a year of contractual income covers ${pctText(coverPct)} of the ${inr(annualSpend)} you spend`,
    'Income you need no asset sale to realise is the part that survives a bad year in markets.',
    'holdings',
  ));

  const spread = yieldPct !== null && income.debtCostPct !== null ? yieldPct - income.debtCostPct : null;
  const debtVerdict = income.debtValueINR === 0
    ? 'good'
    : income.debtCostPct === null || spread === null ? 'unknown'
      : spread > 2 ? 'good' : spread > 0.5 ? 'watch' : 'risk';
  checks.push(makeCheck(
    'debt-cost', 'earning', 'Cost of borrowed money',
    debtVerdict,
    income.debtValueINR === 0
      ? 'No liabilities on the ledger'
      : income.debtCostPct === null
        ? `${inr(income.debtValueINR)} of debt carries no rate on its row, so its cost is unknown`
        : yieldPct === null
          ? `Debt costs ${pctText(income.debtCostPct)} but no asset states a rate, so there is nothing here to earn against it`
          : `Debt costs ${pctText(income.debtCostPct)} while earning assets return ${pctText(yieldPct)} — a spread of ${pctText(spread)}${income.uncostedDebtINR ? `, with ${inr(income.uncostedDebtINR)} of it carrying no rate` : ''}`,
    'Anything borrowing above what it earns is shrinking, and it is where rupees work hardest.',
    'holdings',
  ));

  const debtRatio = (liabilitiesINR / totalAssets) * 100;
  checks.push(makeCheck(
    'debt-load', 'earning', 'Debt against assets',
    debtRatio < 20 ? 'good' : debtRatio < 50 ? 'watch' : 'risk',
    `Liabilities are ${pctText(debtRatio)} of gross assets, so ${pctText(100 - debtRatio)} of the balance sheet is owned outright`,
    'Leverage is a bet that your income holds up. Under a fifth of assets is where that bet stops needing attention.',
    'holdings',
  ));

  // ---- Plan discipline ----------------------------------------------------
  const absDrift = allocation.targetsComplete
    ? allocation.rows.reduce((a, r) => a + Math.abs(r.driftPct), 0) / 2
    : null;
  checks.push(makeCheck(
    'drift', 'structure', 'Distance from your targets',
    absDrift === null ? 'unknown' : absDrift < 5 ? 'good' : absDrift < 15 ? 'watch' : 'risk',
    absDrift === null
      ? 'No target allocation saved, so nothing here can measure drift'
      : `The portfolio sits ${pctText(absDrift)} away from the weights you set, which is about ${inr(allocation.rows.reduce((a, r) => a + Math.abs(r.deltaINR), 0) / 2)} of moving`,
    'Rebalancing sells what ran ahead and funds what lagged. The Rebalancing plan on the Allocation tab lists the rupees.',
    'allocation',
  ));

  // Same bucket the health score reads, so the two pages cannot disagree about
  // what a growth asset is.
  const growthPct = allocation.rows
    .filter((r) => analysis.RISK_BUCKETS[r.key] === 'growth')
    .reduce((a, r) => a + r.actualPct, 0);
  const idealGrowth = Number.isFinite(age) ? Math.max(20, 100 - age) : null;
  const growthGap = idealGrowth === null ? null : Math.abs(growthPct - idealGrowth);
  checks.push(makeCheck(
    'glide-path', 'structure', 'Growth assets for your age',
    growthGap === null ? 'unknown' : growthGap <= 10 ? 'good' : growthGap <= 20 ? 'watch' : 'risk',
    growthGap === null
      ? 'A date of birth in Profile unlocks the age-based growth rule'
      : `${pctText(growthPct)} growth assets against a ${idealGrowth}% rule of thumb for age ${age}`,
    'The rule of thumb is a starting point, not a law. What matters is whether the gap is a decision or a drift.',
    'allocation',
  ));

  const abandoned = allocation.rows.filter((r) => r.hasTarget && !r.heldINR);
  checks.push(makeCheck(
    'abandoned-targets', 'structure', 'Targets with nothing behind them',
    !allocation.targetsComplete ? 'unknown' : abandoned.length ? 'watch' : 'good',
    abandoned.length
      ? `Target weights with nothing held against them: ${abandoned.map((r) => r.label).join(', ')}`
      : 'Every class you set a weight for is funded',
    'Fund the class or drop its weight: a target you never buy is drift accepted in advance.',
    'allocation',
  ));

  const short = (goals || []).filter((g) => ['at-risk', 'behind', 'urgent'].includes(g.status));
  const shortfallINR = short.reduce((a, g) => a + (g.shortfallINR || 0), 0);
  checks.push(makeCheck(
    'goal-coverage', 'structure', 'Goals still short of target',
    !(goals || []).length ? 'unknown' : short.some((g) => g.status === 'urgent' || g.status === 'at-risk') ? 'risk' : short.length ? 'watch' : 'good',
    !(goals || []).length
      ? 'No goals recorded, so nothing measures intent against the portfolio'
      : short.length
        ? `${short.length} of ${goals.length} ${goals.length === 1 ? 'goal falls' : 'goals fall'} short, by ${inr(shortfallINR)} in today's prices at the rates recorded`
        : `All ${goals.length} recorded ${goals.length === 1 ? 'goal is' : 'goals are'} projected to reach their target`,
    'The Goals tab states the extra monthly amount that closes each gap on its own.',
    'goals',
  ));

  // ---- Counterparty -------------------------------------------------------
  const overBank = institutions.deposits.reduce(
    (a, d) => (!a || d.uncoveredINR > a.uncoveredINR ? d : a),
    null,
  );
  checks.push(makeCheck(
    'deposit-cover', 'counterparty', 'Deposits over the insurance limit',
    !institutions.deposits.length ? 'unknown' : institutions.uncoveredINR > 0 ? 'risk' : 'good',
    !institutions.deposits.length
      ? 'No Indian bank or deposit rows to measure against the DICGC limit'
      : institutions.uncoveredINR > 0
        ? `${inr(institutions.uncoveredINR)} of the ${inr(institutions.depositsINR)} held with Indian banks is above the ${inr(DEPOSIT_INSURANCE_LIMIT)} per-bank cover${overBank && overBank.uncoveredINR > 0 ? ` — the largest single gap is ${inr(overBank.uncoveredINR)} at ${overBank.name}` : ''}`
        : `All ${inr(institutions.depositsINR)} across ${institutions.deposits.length} Indian bank${institutions.deposits.length === 1 ? '' : 's'} is inside the per-bank cover`,
    'Splitting the same money across two banks doubles the cover for no change in risk or return.',
    'holdings',
  ));

  const biggestBank = institutions.list[0];
  checks.push(makeCheck(
    'institution-weight', 'counterparty', 'Weight on one bank or broker',
    !biggestBank ? 'unknown' : biggestBank.pct < 30 ? 'good' : biggestBank.pct < 50 ? 'watch' : 'risk',
    biggestBank
      ? `${biggestBank.name} holds ${pctText(biggestBank.pct)} of assets — ${inr(biggestBank.valueINR)} across ${biggestBank.count} row${biggestBank.count === 1 ? '' : 's'}`
      : 'No holding records an institution',
    'This measures an outage, a frozen KYC or a platform exit — access to the money, not its value.',
    'holdings',
  ));

  checks.push(makeCheck(
    'country-weight', 'counterparty', 'Country concentration',
    geography.countryCount < 2 ? 'watch' : geography.largestCountryPct < 60 ? 'good' : geography.largestCountryPct < 85 ? 'watch' : 'risk',
    `${geography.largestCountry || '—'} is ${pctText(geography.largestCountryPct)} of assets, across ${geography.countryCount} ${geography.countryCount === 1 ? 'country' : 'countries'} · ${pctText(geography.foreignPct)} held outside rupees`,
    'Country and currency risk travel together; the foreign share is the part that offsets a weak rupee.',
    'holdings',
  ));

  // ---- Ledger trust -------------------------------------------------------
  checks.push(makeCheck(
    'unconverted', 'records', 'Holdings excluded from net worth',
    unconverted.length ? 'risk' : 'good',
    unconverted.length
      ? `${unconverted.length} row${unconverted.length === 1 ? '' : 's'} use a currency the app has no rate for (${unconverted.map((h) => h.currency).join(', ')}) and count for nothing in net worth`
      : 'Every row converts to rupees at a rate the app holds',
    'Pin a rate for that currency in Settings, or move the row to a currency you hold a rate for.',
    'settings',
  ));

  checks.push(makeCheck(
    'feed-blind', 'records', 'Rows the price feed cannot read',
    pricing.blindCount ? 'watch' : 'good',
    pricing.blindCount
      ? `${pricing.blindCount} feedable row${pricing.blindCount === 1 ? ' has' : 's have'} no quote date yet — ${pricing.blindNames.slice(0, 3).join(', ')}${pricing.blindNames.length > 3 ? ' …' : ''} (${inr(pricing.blindValueINR)} at whatever was typed)`
      : `Every row the feeds can price has a quote date (${pricing.pricedCount} of them)`,
    'Check the ticker box: it needs a listing the feed knows, such as RELIANCE.BO or BSE:RELIANCE, or an ISIN for a bond.',
    'holdings',
  ));

  const coverage = health.costBasisCoveragePct || 0;
  checks.push(makeCheck(
    'cost-basis', 'records', 'Purchase cost recorded',
    coverage >= 80 ? 'good' : coverage >= 40 ? 'watch' : 'risk',
    `${pctText(coverage)} of assets carry a purchase cost and an acquisition date, so returns and tax buckets are measured on that share only`,
    'Without a cost there is no real return — the value shown is the last number typed, not what it grew from.',
    'holdings',
  ));

  const missingIdentity = assets.filter((h) => !(h.country || '').trim() || !String(h.institution || '').trim());
  checks.push(makeCheck(
    'identity', 'records', 'Rows missing a country or institution',
    missingIdentity.length ? 'watch' : 'good',
    missingIdentity.length
      ? `${missingIdentity.length} asset row${missingIdentity.length === 1 ? '' : 's'} (${inr(sum(missingIdentity))}) cannot be placed by country or counterparty, so those tables understate`
      : 'Every asset names a country and an institution',
    'Country drives the geography and India tax views, and the institution is what the counterparty and cover checks read.',
    'holdings',
  ));

  const excludedIds = new Set(unconverted.map((h) => h.id));
  const zeroRows = rows.filter((h) => !(h.valueINR > 0) && !excludedIds.has(h.id));
  checks.push(makeCheck(
    'zero-value', 'records', 'Rows worth nothing',
    zeroRows.length ? 'watch' : 'good',
    zeroRows.length
      ? zeroRows.length === 1
        ? `One row holds no value (${zeroRows[0].name || 'Unnamed'}) — it inflates the counts and dilutes every share on this page`
        : `${zeroRows.length} rows hold no value (${zeroRows.slice(0, 3).map((h) => h.name || 'Unnamed').join(', ')}${zeroRows.length > 3 ? ' …' : ''}) — they inflate the counts and dilute every share on this page`
      : 'Every row on the ledger holds a value',
    'Enter its value, or delete the row if the account is closed.',
    'holdings',
  ));

  return checks;
}

const VERDICT_RANK = { risk: 0, watch: 1, unknown: 2, good: 3 };

function rollUpThemes(checks) {
  return THEMES.map((theme) => {
    const own = checks.filter((c) => c.theme === theme.key);
    const counts = { good: 0, watch: 0, risk: 0, unknown: 0 };
    for (const c of own) counts[c.verdict] += 1;
    const verdict = [...own].sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict])[0]?.verdict || 'unknown';
    return { ...theme, verdict, counts, checks: own.length };
  });
}

// risk before watch, and within those the theme order the reader already sees, so
// the action list and the cards never disagree about what to fix first.
function rankActions(checks) {
  return checks
    .filter((c) => c.verdict === 'risk' || c.verdict === 'watch')
    .sort((a, b) => (VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict])
      || (THEMES.findIndex((t) => t.key === a.theme) - THEMES.findIndex((t) => t.key === b.theme)))
    .slice(0, 6)
    .map((c) => ({
      key: c.key, label: c.label, detail: c.detail, remedy: c.remedy, view: c.view,
      theme: c.theme, verdict: c.verdict,
    }));
}

function portfolioHealth({
  rows, profile, settings, age, goals, allocation, concentration, geography, health, unconverted = [], today = new Date(),
}) {
  const income = earning(rows);
  const ladder = maturityLadder(rows, today);
  const institutions = institutionExposure(rows);
  const pricing = pricingGaps(rows);
  const assets = assetsOf(rows);

  const checks = buildChecks({
    rows,
    profile: profile || {},
    assumptions: settings?.assumptions || {},
    age,
    goals: goals || [],
    allocation,
    concentration,
    geography,
    health,
    income,
    ladder,
    institutions,
    pricing,
    unconverted,
    today,
  });

  const totalAssets = sum(assets);
  const sorted = [...assets].sort((a, b) => b.valueINR - a.valueINR);

  return {
    asOf: todayISO(today),
    themes: rollUpThemes(checks),
    checks,
    actions: rankActions(checks),
    topRows: sorted.slice(0, 10).map((h, i) => ({
      id: h.id,
      name: h.name,
      category: h.category,
      country: h.country,
      institution: h.institution,
      valueINR: round(h.valueINR),
      pct: totalAssets ? round((h.valueINR / totalAssets) * 100) : 0,
      cumulativePct: totalAssets
        ? round(sorted.slice(0, i + 1).reduce((a, r) => a + r.valueINR, 0) / totalAssets * 100)
        : 0,
      overTenPct: totalAssets ? h.valueINR / totalAssets > 0.1 : false,
    })),
    institutions,
    ladder: { ...ladder, totalAssetsINR: round(totalAssets) },
    income,
    pricing,
    counts: {
      assets: assets.length,
      liabilities: rows.filter((r) => r.category === 'liability').length,
      risk: checks.filter((c) => c.verdict === 'risk').length,
      watch: checks.filter((c) => c.verdict === 'watch').length,
      good: checks.filter((c) => c.verdict === 'good').length,
      unknown: checks.filter((c) => c.verdict === 'unknown').length,
    },
    depositInsuranceLimitINR: DEPOSIT_INSURANCE_LIMIT,
  };
}

module.exports = { portfolioHealth, THEMES, DEPOSIT_INSURANCE_LIMIT, inr };
