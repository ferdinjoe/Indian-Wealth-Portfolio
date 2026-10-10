import { shortINR, money, pct, countryShort, escapeHtml, titleCase } from '../format.js';
import { lineChart, groupedBar, dataset, PALETTE } from '../charts.js';
import { wealthProjection, PROJECTION_YEARS, RATE_WHY, MEASURED_RATE } from '../planning.js';

// Chosen here rather than in Settings: this tab is a what-if view, and the
// ledger should not change because someone wondered what a flat 9% looks like.
const view = { mode: 'own', customPct: '' };

// The 5/10/15-year columns, as indexes into a year series.
const MILESTONE_IDX = new Set([5, 10, 15].map((n) => n - 1));

function kpi(label, value, sub, cls = '') {
  return `<div class="card"><span class="kpi-label">${label}</span>
    <div class="kpi-value ${cls}" style="font-size:21px">${value}</div>
    <div class="kpi-sub">${sub}</div></div>`;
}

function card(title, note, inner, extraClass = '') {
  return `<div class="card ${extraClass}">
    <div class="card-head"><span class="card-title">${title}</span>${note ? `<span class="card-note">${note}</span>` : ''}</div>
    <div class="card-body">${inner}</div>
  </div>`;
}

export function render(root, ctx) {
  const holdings = ctx.data.holdings;
  if (!holdings.length) {
    root.innerHTML = `<div class="card empty"><h3>Nothing to project yet</h3>
      <p>Add holdings and this tab will compound them year by year.</p>
      <p style="margin-top:18px"><button class="btn btn-primary" id="wa-empty-add">Add holding</button></p></div>`;
    document.getElementById('wa-empty-add').onclick = () => ctx.go('holdings');
    return;
  }

  const assumption = Number(ctx.data.settings?.assumptions?.preRetirementReturnPct) || 0;
  const wanted = view.mode === 'assumption' ? assumption
    : view.mode === 'custom' && view.customPct !== '' ? Number(view.customPct) : null;
  const overridePct = Number.isFinite(wanted) ? wanted : null;
  const proj = wealthProjection({
    holdings,
    assumptionPct: assumption,
    overridePct,
    years: PROJECTION_YEARS,
  });

  const t = proj.totals;
  const labels = ctx.data.meta.categoryLabels || {};
  const lastYear = proj.yearLabels[proj.yearLabels.length - 1];
  const measuredCount = proj.rows.filter((r) => r.why === 'measured').length;
  const couponCount = proj.rows.filter((r) => r.why === 'coupon').length;
  const assumedCount = proj.rows.filter((r) => r.why === 'assumed').length;
  const modeNote = view.mode === 'own' ? ''
    : overridePct === null ? ' · nothing typed yet, so each asset keeps its own rate'
    : ` · ${pct(overridePct)} a year for everything`;

  root.innerHTML = `
  <div class="toolbar">
    <div style="position:relative;min-width:260px">
      <select id="wa-mode" style="padding-left:10px" title="Where each asset's growth rate comes from">
        <option value="own"${view.mode === 'own' ? ' selected' : ''}>Growth: each asset's own rate</option>
        <option value="assumption"${view.mode === 'assumption' ? ' selected' : ''}>Growth: ${assumption}% for everything (Settings)</option>
        <option value="custom"${view.mode === 'custom' ? ' selected' : ''}>Growth: a rate I choose</option>
      </select>
    </div>
    <input id="wa-custom" class="filter-input" type="number" step="0.5" style="max-width:120px${view.mode === 'custom' ? '' : ';display:none'}"
      placeholder="% a year" value="${escapeHtml(view.customPct)}" aria-label="Growth rate for every asset">
    <span class="spacer"></span>
    <span class="muted" style="font-size:12px">${proj.rows.length} assets · ${proj.years} years · nothing added, nothing withdrawn</span>
  </div>

  <div class="grid grid-kpis" style="margin-bottom:16px">
    ${kpi('Net worth today', shortINR(t.netTodayINR), t.liabilityCount ? `${shortINR(t.todayINR)} assets less ${shortINR(t.debtINR)} debt` : `${shortINR(t.todayINR)} of assets, nothing owed`)}
    ${kpi(`${proj.startYear + 5} · in five years`, shortINR(t.netMilestones.five), growthLine(t, 'five'), 'is-accent')}
    ${kpi(`${proj.startYear + 10} · in ten years`, shortINR(t.netMilestones.ten), growthLine(t, 'ten'), 'is-accent')}
    ${kpi(`${lastYear} · in fifteen`, shortINR(t.netMilestones.fifteen), growthLine(t, 'fifteen'), 'is-accent')}
    ${kpi('Blended growth', t.blendedPct === null ? '—' : `${pct(t.blendedPct)} a year`, t.blendedPct === null ? 'needs a positive balance at both ends' : 'the single rate behind these figures')}
    ${kpi('Debts', t.debtINR > 0 ? `-${shortINR(t.debtINR)}` : shortINR(0), t.liabilityCount ? 'held flat: a loan falls as you pay it down, not as markets move' : 'no liabilities recorded', t.debtINR > 0 ? 'is-red' : '')}
  </div>

  <div class="grid span-2" style="grid-template-columns:1fr">
    ${card(`How the wealth compounds${modeNote}`, 'net worth at each year-end, against the same balance left untouched',
      `<div class="chart-box"><canvas id="c-proj"></canvas></div>`, 'span-2')}
  </div>

  <div class="grid grid-2" style="margin-top:16px">
    ${card('Where it lands by asset class', `today against ${lastYear}`, `<div class="chart-box is-tall"><canvas id="c-class"></canvas></div>`)}
    ${card('The next 5, 10 and 15 years', 'every asset at each milestone', milestoneTable(proj, labels))}
  </div>

  <div class="grid span-2" style="grid-template-columns:1fr;margin-top:16px">
    ${card(`Year by year · ${proj.yearLabels[0]} to ${lastYear}`, 'hover any figure for the exact rupees; shaded columns are the 5, 10 and 15 year marks',
      yearTable(proj, labels), 'span-2')}
  </div>

  <p class="card-note" style="margin-top:14px">
    Growth rates come from ${measuredCount} asset${measuredCount === 1 ? '' : 's'}' own measured return
    (a lot needs ${MEASURED_RATE.minYearsHeld} year of history, and a measured rate is never projected past
    ${MEASURED_RATE.minPct}% to ${MEASURED_RATE.maxPct}% a year however good the run was),
    ${couponCount} instrument${couponCount === 1 ? '' : 's'} paying a known rate, and
    ${assumedCount} using the ${assumption}% assumption from Settings.
    These are compounded balances with no new money going in and nothing taken out, in today's rupees —
    inflation is not deducted, so a figure fifteen years away buys less than the same number today.
    The Retirement tab is where salaries, spending and drawdown are modelled.
  </p>`;

  drawCharts(proj, t, labels);
  wireToolbar(root, ctx);
}

function growthLine(t, key) {
  const value = t.netMilestones[key];
  if (value === null || !(t.netTodayINR > 0)) return '—';
  const gain = value - t.netTodayINR;
  return `${gain >= 0 ? '+' : '-'}${shortINR(Math.abs(gain))} · ${(value / t.netTodayINR).toFixed(2)}× today`;
}

function rateCell(r) {
  const why = RATE_WHY[r.why] || r.why;
  const cap = r.capped ? ` · capped from ${pct(r.rawPct)} actual` : '';
  // A deposit paying 0.05% must not be shown as 0.1%: below a percent the chip
  // carries the decimals it is actually compounding at.
  const label = pct(r.ratePct, Math.abs(r.ratePct) < 1 ? 2 : 1);
  return `<span class="rate-chip" title="Grown at ${why}${cap}">${label}</span>`;
}

function milestoneTable(proj, labels) {
  const rows = proj.rows.slice(0, 12).map((r) => `<tr>
    <td class="cell-name">${escapeHtml(r.name)} <span class="muted">${countryShort(r.country)}</span></td>
    <td class="muted" style="font-size:12px">${escapeHtml(labels[r.category] || titleCase(r.category))}</td>
    <td class="num">${r.priced ? shortINR(r.todayINR) : '—'}</td>
    <td class="num">${shortINR(r.milestones.five)}</td>
    <td class="num">${shortINR(r.milestones.ten)}</td>
    <td class="num">${shortINR(r.milestones.fifteen)}</td>
    <td></td>
  </tr>`).join('');
  const more = proj.rows.length > 12
    ? `<p class="card-note" style="margin-top:10px">Top 12 by value. Every asset is in the year-by-year table below.</p>` : '';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Asset</th><th>Class</th><th class="num">Today</th><th class="num">${proj.startYear + 5}</th>
      <th class="num">${proj.startYear + 10}</th><th class="num">${proj.startYear + 15}</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>${more}`;
}

// The table the tab exists for: one row per asset, one column per year, with the
// 5/10/15-year columns shaded so the milestones read first.
function yearTable(proj, labels) {
  const t = proj.totals;
  const head = proj.yearLabels.map((y, i) => {
    const on = MILESTONE_IDX.has(i);
    return `<th class="num${on ? ' is-milestone' : ''}">${y}${on ? ` <span class="wa-plus">+${i + 1}y</span>` : ''}</th>`;
  }).join('');
  const cells = (series, cls = '', owed = false) => series.map((v, i) => `<td class="num${MILESTONE_IDX.has(i) ? ' is-milestone' : ''}${cls}"
      title="${escapeHtml(owed ? `owed ${money(v)}` : money(v))}">${owed ? '-' : ''}${shortINR(v)}</td>`).join('');

  const rows = proj.rows.map((r) => `<tr>
    <td class="sticky-name cell-name">${escapeHtml(r.name)} <span class="muted">${countryShort(r.country)}</span></td>
    <td class="muted" style="font-size:12px">${escapeHtml(labels[r.category] || titleCase(r.category))}</td>
    <td class="num">${r.priced ? shortINR(r.todayINR) : '—'}</td>
    <td class="num">${rateCell(r)}</td>
    ${cells(r.series)}
    <td></td>
  </tr>`).join('');

  const debtSeries = proj.yearLabels.map(() => t.debtINR);
  // With nothing owed, the asset subtotal equals the net worth row, so the table
  // keeps one total rather than three near-identical ones.
  const subtotals = t.liabilityCount ? `
      <tr class="row-total"><td class="sticky-name">All assets</td><td></td><td class="num">${shortINR(t.todayINR)}</td><td></td>${cells(t.series)}<td></td></tr>
      <tr class="row-total"><td class="sticky-name">Less debts <span class="muted">held flat</span></td><td></td>
        <td class="num neg">-${shortINR(t.debtINR)}</td><td></td>
        ${cells(debtSeries, ' neg', true)}<td></td></tr>` : '';
  return `<div class="table-wrap"><table>
    <thead><tr><th class="sticky-name">Asset</th><th>Class</th><th class="num">Today</th><th class="num">Growth</th>${head}<th></th></tr></thead>
    <tbody>
      ${rows}
      ${subtotals}
      <tr class="row-total row-net"><td class="sticky-name">Projected net worth</td><td></td>
        <td class="num">${shortINR(t.netTodayINR)}</td>
        <td class="num">${t.blendedPct === null ? '' : `<span class="rate-chip">${pct(t.blendedPct)}</span>`}</td>
        ${cells(t.netSeries)}<td></td></tr>
    </tbody>
  </table></div>`;
}

function drawCharts(proj, t, labels) {
  lineChart('c-proj', [proj.startYear, ...proj.yearLabels], [
    dataset('Projected net worth', [t.netTodayINR, ...t.netSeries], PALETTE[0]),
    dataset('Left untouched', [t.netTodayINR, ...proj.yearLabels.map(() => t.netTodayINR)], PALETTE[1], { fill: false, dash: [5, 4] }),
  ]);

  const cats = proj.byCategory.slice(0, 8);
  const last = proj.yearLabels.length - 1;
  const set = (label, values, color) => ({
    label, data: values, backgroundColor: color, borderRadius: 4, borderSkipped: false, maxBarThickness: 22,
  });
  groupedBar('c-class', cats.map((c) => labels[c.key] || titleCase(c.key)), [
    set('Today', cats.map((c) => c.todayINR), PALETTE[2]),
    set(`In ${proj.years} years`, cats.map((c) => c.series[last]), PALETTE[0]),
  ], { horizontal: true });
}

function wireToolbar(root, ctx) {
  const mode = document.getElementById('wa-mode');
  const custom = document.getElementById('wa-custom');
  mode.onchange = () => {
    view.mode = mode.value;
    render(root, ctx);
  };
  custom.onchange = () => {
    view.customPct = custom.value;
    view.mode = 'custom';
    render(root, ctx);
  };
}
