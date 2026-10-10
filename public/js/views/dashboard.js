import { shortINR, money, native, converted, num, countryShort, escapeHtml, titleCase } from '../format.js';
import { doughnut, barChart, lineChart, groupedBar, dataset, PALETTE } from '../charts.js';
import { WEALTH_TIERS, tierFor, tierLadder } from '../planning.js';

function barSet(label, values, color) {
  return { label, data: values, backgroundColor: color, borderRadius: 4, borderSkipped: false, maxBarThickness: 22 };
}

function kpi(label, value, sub, cls = '') {
  return `<div class="card kpi">
    <span class="kpi-label">${label}</span>
    <div class="kpi-value ${cls}">${value}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
  </div>`;
}

function card(title, note, inner, extraClass = '') {
  return `<div class="card ${extraClass}">
    <div class="card-head"><span class="card-title">${title}</span>${note ? `<span class="card-note">${note}</span>` : ''}</div>
    <div class="card-body">${inner}</div>
  </div>`;
}

export function render(root, ctx) {
  const { summary, holdings, profile, snapshots } = ctx.data;
  if (!holdings.length) {
    root.innerHTML = `<div class="card empty"><h3>Nothing recorded yet</h3>
      <p>Add your first holding to see net worth and charts.</p>
      <p style="margin-top:18px"><button class="btn btn-primary" id="d-empty-add">Add holding</button></p></div>`;
    document.getElementById('d-empty-add').onclick = () => ctx.go('holdings');
    return;
  }

  const assets = holdings.filter((h) => h.category !== 'liability');
  const top = [...assets].sort((a, b) => (b.valueINR || 0) - (a.valueINR || 0)).slice(0, 10);
  const passive = passiveIncome(holdings);
  const monthlyBurn = profile.monthlyExpensesNowINR || 0;
  const runway = monthlyBurn > 0 ? summary.liquidAssetsINR / monthlyBurn : null;

  const netGrowth = netWorthGrowth(snapshots);

  const perf = summary.performance || {};
  const healthScore = ctx.data.analysis?.health || { score: null, costBasisCoveragePct: 0 };
  const coveragePct = healthScore.costBasisCoveragePct ?? 0;
  const ladder = tierLadder({
    netWorthINR: summary.netWorthINR,
    currentAge: ctx.data.age,
    assumptions: ctx.data.settings?.assumptions || {},
    profile,
  });

  root.innerHTML = `
  <div class="grid span-2" style="grid-template-columns:1fr">
    <div class="hero">
      <div>
        <span class="kpi-label">Total net worth · INR equivalent
          <span class="tag is-tier" title="Net worth against the Indian wealth bands">${escapeHtml(ladder.current.tier.label)}</span>
        </span>
        <div class="hero-figure" style="color:var(--accent)">${money(summary.netWorthINR)}</div>
        <div class="hero-eta">${shortINR(summary.netWorthINR)} across ${summary.assetCount} assets &middot; ${summary.liabilityCount} liabilities &middot; ${Object.keys(summary.byCountry).length} countries</div>
        <div class="hero-eta">${bandLine(ladder)}</div>
        ${currencyStrip(summary.netWorthByCurrency, ctx.data.fxDate)}
      </div>
      <div class="hero-stats">
        <div class="hero-stat"><span class="kpi-label">Gross assets</span><div class="kpi-value">${shortINR(summary.totalAssetsINR)}</div></div>
        <div class="hero-stat"><span class="kpi-label">Liabilities</span><div class="kpi-value is-red">-${shortINR(summary.totalLiabilitiesINR)}</div></div>
        <div class="hero-stat"><span class="kpi-label">Liquid share</span><div class="kpi-value is-blue">${pct(summary.liquidAssetsINR / summary.totalAssetsINR * 100)}</div></div>
        <div class="hero-stat"><span class="kpi-label">Debt / assets</span><div class="kpi-value is-gold">${pct(summary.totalLiabilitiesINR / summary.totalAssetsINR * 100)}</div></div>
        <div class="hero-stat"><span class="kpi-label">Portfolio health</span><div class="kpi-value ${healthScore.score === null ? '' : healthScore.score >= 70 ? 'is-accent' : healthScore.score >= 55 ? 'is-gold' : 'is-red'}">${healthScore.score ?? '—'}</div></div>
      </div>
    </div>
  </div>

  <div class="grid grid-kpis" style="margin-top:16px">
    ${kpi('Net worth trend', netGrowth.value, netGrowth.sub, netGrowth.cls)}
    ${kpi('Money-weighted return', Number.isFinite(perf.xirrPct) ? `${perf.xirrPct >= 0 ? '+' : '-'}${Math.abs(perf.xirrPct).toFixed(1)}%` : '—', perf.coveredCount ? `XIRR over ${perf.coveredCount} asset${perf.coveredCount === 1 ? '' : 's'} with a cost basis` : 'Record purchase costs on Holdings', perf.xirrPct > 0 ? 'is-accent' : perf.xirrPct < 0 ? 'is-red' : '')}
    ${kpi('Unrealised gain', perf.totalCostINR ? `${perf.unrealisedGainINR >= 0 ? '+' : '-'}${shortINR(Math.abs(perf.unrealisedGainINR))}` : '—', Number.isFinite(perf.unrealisedGainPct) ? `${perf.unrealisedGainPct.toFixed(1)}% on ${shortINR(perf.totalCostINR)} invested` : 'no cost basis yet', perf.unrealisedGainINR > 0 ? 'is-accent' : perf.unrealisedGainINR < 0 ? 'is-red' : '')}
    ${kpi('Passive income', shortINR(passive.annual), `${pct(passive.yieldPct)} blended yield on interest-bearing assets`, 'is-accent')}
    ${kpi('Liquid assets', shortINR(summary.liquidAssetsINR), 'Cash, deposits, marketable securities')}
    ${kpi('Illiquid assets', shortINR(summary.illiquidAssetsINR), 'Property, lock-ins, protection policies')}
    ${kpi('Cash runway', runway ? `${runway.toFixed(0)} mo` : '—', runway ? 'of current spending, from liquid assets only' : 'Set monthly spending in Profile')}
  </div>

  <div class="grid grid-2" style="margin-top:16px">
    ${card(`Wealth band · ${escapeHtml(ladder.current.tier.label)}`, 'net worth against the Indian wealth bands', bandCard(ladder), 'span-2')}
  </div>

  <div class="grid grid-2" style="margin-top:16px">
    ${card('The climb, projected', `${ladder.horizonYears} years at ${ladder.inputs.preReturnPct}% a year`, `<div class="chart-box"><canvas id="c-tier"></canvas></div>`)}
    ${card('Where the trajectory lands', 'every three years, in the band it reaches', trajectoryTable(ladder))}
  </div>

  <div class="grid grid-2" style="margin-top:16px">
    ${card('Net worth over time', `${snapshots.length} monthly record${snapshots.length === 1 ? '' : 's'}`, `<div class="chart-box"><canvas id="c-trend"></canvas></div>`, 'span-2')}
    ${card('Allocation by asset class', 'share of gross assets', `<div class="chart-box is-tall"><canvas id="c-category"></canvas></div>`)}
    ${card('Where your money lives', 'INR equivalent by country', `<div class="chart-box is-tall"><canvas id="c-country"></canvas></div>`)}
    ${card('Assets versus debt by country', 'bars below the axis reduce net worth', `<div class="chart-box"><canvas id="c-netbycountry"></canvas></div>`)}
    ${card('Currency exposure', 'native-currency value, converted at the rates in Settings', `<div class="chart-box"><canvas id="c-currency"></canvas></div>`)}
  </div>

  <div class="grid grid-2" style="margin-top:16px">
    ${card('Largest holdings', 'top 10 assets', topHoldingsTable(top))}
    ${card('How the money has worked', 'measured in each asset’s own currency', performanceCard(perf, coveragePct))}
    ${card('Category breakdown', 'net contribution to worth', breakdownTable(summary))}
  </div>`;

  drawCharts(summary, snapshots);
  drawTierChart(ladder);
}

function pct(n) {
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '-' : ''}${Math.abs(n).toFixed(n < 0 ? 1 : 0)}%`;
}

// Net worth in five units is one number shown five ways, so it sits under the
// headline figure rather than in a card of its own. Each chip carries its rate in
// the tooltip because a dollar amount means nothing without the rate behind it,
// and a currency with no rate shows a dash rather than an invented number.
function currencyStrip(currencies, fxDate) {
  const items = currencies.map((c) => `
    <span class="fx-item${c.amount === null ? ' is-missing' : ''}" title="${escapeHtml(rateNote(c))}">
      <span class="fx-code">${escapeHtml(c.code)}</span>
      <span class="fx-amt">${c.amount === null ? '—' : converted(c.amount, c.code)}</span>
    </span>`).join('');
  return `<div class="fx-strip">${items}</div>
    <div class="fx-note">Same net worth at the rates on the Settings tab${fxDate ? ` · ${escapeHtml(fxDate)}` : ''}</div>`;
}

const RATE_SOURCE = {
  base: 'reporting base',
  live: 'live feed',
  cached: 'live feed',
  manual: 'pinned in Settings',
  fallback: 'bundled default',
  unknown: 'no rate',
};

function rateNote(c) {
  if (c.code === 'INR') return 'The reporting base currency';
  if (c.rateToINR === null) return `No ${c.code} rate resolved - set one in Settings`;
  const source = RATE_SOURCE[c.source] || c.source;
  return `1 ${c.code} = ₹${num(c.rateToINR)} · ${source}${c.asOf ? ` · ${c.asOf}` : ''}`;
}

// The line under the headline figure: which band range the balance sits in and
// how much of that range it has already covered.
function bandLine(ladder) {
  const c = ladder.current;
  if (c.isTop) return `Top band · ${shortINR(c.tier.floorINR)} and above`;
  const range = c.index === 0
    ? `under ${shortINR(c.next.floorINR)}`
    : `${shortINR(c.tier.floorINR)} → ${shortINR(c.next.floorINR)}`;
  const progress = c.bandProgressPct >= 99.5
    ? `on the edge of ${escapeHtml(c.next.label)}`
    : `${c.bandProgressPct.toFixed(0)}% of the way to ${escapeHtml(c.next.label)}`;
  return `${range} band · ${progress}`;
}

function bandCard(ladder) {
  const c = ladder.current;
  const strip = WEALTH_TIERS.map((t, i) => {
    const state = i < c.index ? 'is-passed' : i === c.index ? 'is-current' : i <= c.index + 2 ? 'is-next' : '';
    const cross = ladder.crossings.find((x) => x.tier.key === t.key);
    const when = i <= c.index
      ? (i === c.index ? 'you are here' : 'cleared')
      : cross && cross.at ? `in ${cross.at.years} yr${cross.at.years === 1 ? '' : 's'} · ${cross.at.year}` : `not within ${ladder.horizonYears} yr`;
    return `<div class="tier ${state}">
      <span class="tier-name">${escapeHtml(t.label)}</span>
      <span class="tier-floor">${shortINR(t.floorINR)}${t.floorINR === 0 ? ' net worth' : '+'}</span>
      <span class="tier-when">${when}</span>
    </div>`;
  }).join('');

  const meter = c.isTop ? '' : `<div class="band-meter"><i style="width:${c.bandProgressPct.toFixed(1)}%"></i></div>`;
  const levels = ladder.targets.length
    ? ladder.targets.map((t) => levelBlock(ladder, t)).join('')
    : `<div class="callout" style="margin-top:12px">You are in the top band, so there is no next level to price. ${shortINR(ladder.endBalanceINR)} is where this trajectory lands in ${ladder.horizonYears} years.</div>`;
  const pace = ladder.inputs.monthlySurplusINR > 0
    ? `Built on ${ladder.inputs.preReturnPct}% a year on the balance plus ${money(ladder.inputs.monthlySurplusINR)} invested a month, rising ${ladder.inputs.salaryGrowthPct}% a year — all three are yours to change in Settings and Profile.`
    : `Built on ${ladder.inputs.preReturnPct}% a year on the balance with nothing new invested, because no monthly surplus is recorded on the Profile tab. Set one and every figure below shortens.`;
  return `<div class="tier-strip">${strip}</div>${meter}${levels}
    <p class="card-note" style="margin-top:12px">${pace} Bands are the usual Indian wealth-class ones, measured on <em>net worth</em> (assets minus liabilities) rather than investable assets alone.</p>`;
}

function levelBlock(ladder, t) {
  const from = escapeHtml(ladder.current.tier.label);
  const to = escapeHtml(t.tier.label);
  const ageText = (x) => (x.age === null || x.age === undefined ? '' : `, age ${x.age}`);
  const pace = t.atPace
    ? `<span class="fact"><i>at this pace</i>${t.atPace.years} yr${t.atPace.years === 1 ? '' : 's'} · ${t.atPace.year}${ageText(t.atPace)}</span>`
    : `<span class="fact"><i>at this pace</i>not within ${ladder.horizonYears} years</span>`;
  // With nothing new invested the two readings are the same number, and repeating
  // it reads like a second calculation that happens to agree.
  const growth = !t.growthOnly
    ? '<span class="fact"><i>growth alone</i>never</span>'
    : (!t.atPace || t.growthOnly.years !== t.atPace.years)
      ? `<span class="fact"><i>growth alone</i>${t.growthOnly.years} yr${t.growthOnly.years === 1 ? '' : 's'}</span>`
      : '';
  const deadline = t.investMonthlyINR.five > 0
    ? `<span class="fact"><i>to reach it in 5 yrs</i>invest ${shortINR(t.investMonthlyINR.five)}/mo${t.investMonthlyINR.ten > 0 ? ` · in 10 yrs ${shortINR(t.investMonthlyINR.ten)}/mo` : ''}</span>`
    : '';
  const multiple = t.multipleNeeded && t.multipleNeeded > 1
    ? `<span class="fact"><i>needs</i>${t.multipleNeeded.toFixed(2)}× today's net worth</span>`
    : '';
  return `<div class="level">
    <div class="level-top">
      <span class="level-name">${from} &rarr; <strong>${to}</strong> <span class="muted">from ${shortINR(t.tier.floorINR)}</span></span>
      <span class="level-gap" title="${escapeHtml(money(t.gapINR))}">+${shortINR(t.gapINR)} to earn</span>
    </div>
    <div class="level-facts">${pace}${growth}${deadline}${multiple}</div>
  </div>`;
}

function trajectoryTable(ladder) {
  const rows = ladder.curve.filter((p) => p.index === 0 || p.index % 3 === 0);
  // The trailing empty column is not decoration: the last cell of every table is
  // pinned to the right edge with an opaque background, which would otherwise
  // slide over the projected value as the card narrows.
  return `<div class="table-wrap"><table>
    <thead><tr><th>After</th><th class="num">Age</th><th class="num">Projected</th><th>Band</th><th></th></tr></thead>
    <tbody>${rows.map((p) => `<tr>
      <td>${p.index === 0 ? 'today' : `${p.index} yr`} <span class="muted">${p.year}</span></td>
      <td class="num">${p.age ?? '—'}</td>
      <td class="num" title="${escapeHtml(money(p.balanceINR))}">${shortINR(p.balanceINR)}</td>
      <td>${escapeHtml(tierFor(p.balanceINR).tier.label)}</td>
      <td></td>
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="card-note" style="margin-top:10px">Compounding plus the surplus on the Profile tab, at the assumptions in Settings. No new holdings, no withdrawals — unlike the Retirement tab, which draws the corpus down after your planned retirement age.</p>`;
}

function drawTierChart(ladder) {
  const labels = ladder.curve.map((p) => String(p.year));
  const sets = [dataset('Projected net worth', ladder.curve.map((p) => p.balanceINR), PALETTE[0])];
  ladder.targets.forEach((t, i) => sets.push(dataset(
    `${t.tier.label} · ${shortINR(t.tier.floorINR)}`,
    ladder.curve.map(() => t.tier.floorINR),
    i === 0 ? PALETTE[2] : PALETTE[3],
    { fill: false, dash: [6, 4], pointRadius: 0 },
  )));
  lineChart('c-tier', labels, sets);
}

function topHoldingsTable(rows) {
  const max = Math.max(...rows.map((r) => r.valueINR || 0), 1);
  return `<div class="bar-row">${rows.map((r) => `
    <div class="bar-item">
      <span><span class="cell-name">${escapeHtml(r.name)}</span> <span class="muted">${countryShort(r.country)}</span></span>
      <span style="font-family:var(--mono)">${shortINR(r.valueINR)}</span>
      <span class="muted" style="font-size:11px;grid-column:1">${titleCase(r.category)} · ${native(r.nativeValue, r.currency)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(r.valueINR / max * 100).toFixed(1)}%;background:var(--accent)"></span></span>
    </div>`).join('')}</div>`;
}

function performanceCard(perf, coveragePct) {
  if (!perf.coveredCount) {
    return `<p class="card-note">Nothing is tracked yet. Record a purchase cost and acquisition date on an asset and this card starts working out what it has actually returned, in its own currency.</p>`;
  }
  const gain = perf.unrealisedGainINR || 0;
  const cov = coverageText(coveragePct);
  const showWorst = perf.worst && (!perf.best || perf.worst.name !== perf.best.name);
  return `<div class="stat-list">
    <div class="stat-line"><span>Invested (cost of what is tracked)</span><strong>${shortINR(perf.totalCostINR)}</strong></div>
    <div class="stat-line"><span>Worth now</span><strong>${shortINR(perf.costedValueINR)}</strong></div>
    <div class="stat-line"><span>Unrealised gain</span><strong class="${gain < 0 ? 'neg' : ''}" style="${gain >= 0 ? 'color:var(--accent)' : ''}">${gain >= 0 ? '+' : '-'}${shortINR(Math.abs(gain))} · ${Number.isFinite(perf.unrealisedGainPct) ? perf.unrealisedGainPct.toFixed(1) : '0.0'}%</strong></div>
    ${perf.best ? `<div class="stat-line"><span>Best tracked</span><strong>${escapeHtml(perf.best.name)} <span style="color:var(--accent)">${perf.best.gainPct >= 0 ? '+' : '-'}${Math.abs(perf.best.gainPct).toFixed(0)}%</span></strong></div>` : ''}
    ${showWorst ? `<div class="stat-line"><span>Worst tracked</span><strong>${escapeHtml(perf.worst.name)} <span class="${perf.worst.gainPct < 0 ? 'neg' : ''}">${perf.worst.gainPct >= 0 ? '+' : '-'}${Math.abs(perf.worst.gainPct).toFixed(0)}%</span></strong></div>` : ''}
    <div class="stat-line"><span>Cost basis recorded</span><strong>${cov} of assets</strong></div>
  </div>
  ${coveragePct < 60 ? `<div class="callout is-warn" style="margin-top:12px">${(perf.uncoveredCount || 0)} assets have no purchase cost, so this covers ${cov} of what you own. Add costs on the Holdings tab to widen it.</div>` : ''}
  <p class="card-note" style="margin-top:10px">Gain is measured against cost at today’s exchange rate, so a currency move changes net worth without being counted as a return here.</p>`;
}

// A value-weighted share rounds to 0% long before it is actually empty, which
// reads as a broken feature rather than missing data entry.
function coverageText(pctValue) {
  if (!(pctValue > 0)) return '0%';
  if (pctValue < 1) return '<1%';
  return `${pctValue.toFixed(0)}%`;
}


function breakdownTable(summary) {
  const rows = Object.values(summary.byCategory).sort((a, b) => Math.abs(b.valueINR) - Math.abs(a.valueINR));
  return `<div class="stat-list">${rows.map((r) => `
    <div class="stat-line">
      <span>${escapeHtml(r.label)} <span class="muted">· ${r.count}</span></span>
      <strong style="color:${r.key === 'liability' ? 'var(--red)' : 'inherit'}">${r.key === 'liability' ? '-' : ''}${shortINR(r.valueINR)}
        ${r.shareOfAssetsPct ? `<span class="muted" style="font-family:inherit;font-size:11px"> (${r.shareOfAssetsPct.toFixed(0)}%)</span>` : ''}</strong>
    </div>`).join('')}</div>`;
}

function passiveIncome(holdings) {
  let income = 0;
  let base = 0;
  for (const h of holdings) {
    if (h.category === 'liability' || h.interestRatePct === null || !h.valueINR) continue;
    income += h.valueINR * (h.interestRatePct / 100);
    base += h.valueINR;
  }
  return { annual: income, yieldPct: base ? income / base * 100 : 0, base };
}

function netWorthGrowth(snapshots) {
  if (snapshots.length < 2) return { value: '—', sub: 'needs two monthly records', cls: '' };
  const first = snapshots[0].netWorthINR;
  const last = snapshots[snapshots.length - 1].netWorthINR;
  const months = Math.max(1, snapshots.length - 1);
  const changePct = ((last - first) / Math.abs(first || 1)) * 100;
  const perMonth = changePct / months;
  return {
    value: `${changePct >= 0 ? '+' : '-'}${Math.abs(changePct).toFixed(1)}%`,
    sub: `${shortINR(last - first)} over ${months} recorded month${months === 1 ? '' : 's'} · ${perMonth >= 0 ? '+' : '-'}${Math.abs(perMonth).toFixed(1)}%/mo`,
    cls: changePct >= 0 ? 'is-accent' : 'is-red',
  };
}

function drawCharts(summary, snapshots) {
  const cats = Object.values(summary.byCategory)
    .filter((c) => c.key !== 'liability' && c.valueINR > 0)
    .sort((a, b) => b.valueINR - a.valueINR);
  doughnut('c-category', cats.map((c) => c.label), cats.map((c) => c.valueINR));

  const countries = Object.values(summary.byCountry).sort((a, b) => b.valueINR - a.valueINR);
  barChart('c-country', countries.map((c) => countryShort(c.key)), countries.map((c) => c.valueINR), { horizontal: true, label: 'Assets' });

  groupedBar('c-netbycountry', countries.map((c) => countryShort(c.key)), [
    barSet('Assets', countries.map((c) => c.valueINR), PALETTE[0]),
    barSet('Liabilities', countries.map((c) => -c.liabilitiesINR), PALETTE[5]),
  ]);

  const currencies = Object.values(summary.byCurrency).sort((a, b) => b.valueINR - a.valueINR);
  doughnut('c-currency', currencies.map((c) => c.key), currencies.map((c) => c.valueINR), { cutout: '55%' });

  const trend = [...snapshots];
  lineChart('c-trend',
    trend.map((s) => s.period),
    [
      dataset('Net worth', trend.map((s) => s.netWorthINR), PALETTE[0]),
      dataset('Liquid assets', trend.map((s) => s.liquidAssetsINR), PALETTE[2], { fill: false, dash: [5, 4] }),
    ]);
}
