import { money, shortINR, pct, escapeHtml, titleCase, countryShort } from '../format.js';
import { barChart, PALETTE } from '../charts.js';

const VERDICT_TAG = { good: 'is-ok', watch: 'is-warn', risk: 'is-bad', unknown: 'is-hold' };
const VERDICT_LABEL = { good: 'clear', watch: 'watch', risk: 'address', unknown: 'no data' };

export function render(root, ctx) {
  const data = ctx.data;
  const { summary, holdings, analysis } = data;
  const report = data.portfolioHealth;

  if (!holdings.length) {
    root.innerHTML = `<div class="card empty"><h3>Nothing to judge yet</h3>
      <p>This page runs its rules over the values, dates and rates on your holdings, so it needs a ledger first.</p>
      <p style="margin-top:18px"><button class="btn btn-primary" id="h-empty-add">Add holding</button></p></div>`;
    root.querySelector('#h-empty-add').onclick = () => ctx.go('holdings');
    return;
  }

  if (!report) {
    root.innerHTML = '<div class="card"><p class="card-note">The running server has no health engine yet — restart the app to load it.</p></div>';
    return;
  }

  root.innerHTML = `
    <div class="grid">
      ${verdictHero(analysis.health, report, summary)}
      ${actionCard(report)}
    </div>

    <div class="grid grid-2" style="margin-top:16px">
      ${scoreCard(analysis.health)}
      ${earningCard(report.income, data.settings.assumptions)}
    </div>

    <div class="grid grid-2" style="margin-top:16px">
      ${report.themes.map((t) => themeCard(t, report.checks)).join('')}
    </div>

    <div class="grid grid-2" style="margin-top:16px">
      ${topRowsCard(report, analysis)}
    </div>

    <div class="grid grid-2" style="margin-top:16px">
      ${ladderCard(report.ladder)}
      ${trustCard(report, data)}
    </div>

    <div class="grid grid-2" style="margin-top:16px">
      ${counterpartyCard(report)}
      ${methodCard(report)}
    </div>`;

  // Assigned per element rather than delegated on root: root survives every
  // re-render, and a delegated listener there would stack one per repaint.
  root.querySelectorAll('[data-goto]').forEach((btn) => { btn.onclick = () => ctx.go(btn.dataset.goto); });
  drawLadder(report.ladder);
}

// ------------------------------------------------------------------- hero ----

function verdictHero(health, report, summary) {
  const score = health.score ?? 0;
  const color = health.score === null ? 'var(--text-faint)' : score >= 70 ? 'var(--accent)' : score >= 55 ? 'var(--gold)' : 'var(--red)';
  return `<div class="hero">
    <div style="display:flex;gap:26px;align-items:center;flex-wrap:wrap">
      <div class="score-ring" style="--p:${score};--ring:${color}">
        <div class="score-core"><div>
          <div class="score-num" style="color:${color}">${health.score ?? '—'}</div>
          <div class="score-grade">${escapeHtml(health.grade)}</div>
        </div></div>
      </div>
      <div>
        <span class="kpi-label">Portfolio health as of ${escapeHtml(report.asOf)}</span>
        <div class="hero-figure" style="color:${color};font-size:30px">${report.counts.risk} to address · ${report.counts.watch} to watch</div>
        <div class="hero-eta">${report.checks.length} rules run over ${report.counts.assets} valued ${report.counts.assets === 1 ? 'asset' : 'assets'} and ${report.counts.liabilities} ${report.counts.liabilities === 1 ? 'liability' : 'liabilities'} · ${shortINR(summary.totalAssetsINR)} gross</div>
      </div>
    </div>
    <div class="hero-stats">
      ${stat('Address', String(report.counts.risk), report.counts.risk ? 'is-red' : '', 'rules failing outright')}
      ${stat('Watch', String(report.counts.watch), report.counts.watch ? 'is-gold' : '', 'worth a decision')}
      ${stat('Clear', String(report.counts.good), 'is-accent', 'rules the ledger passes')}
      ${stat('No data', String(report.counts.unknown), '', 'what your own entries hide')}
    </div>
  </div>`;
}

function stat(label, value, cls, sub) {
  return `<div class="hero-stat"><span class="kpi-label">${label}</span><div class="kpi-value ${cls}">${value}</div><div class="kpi-sub">${sub}</div></div>`;
}

// ----------------------------------------------------------------- actions ---

function actionCard(report) {
  if (!report.actions.length) {
    return `<div class="card"><div class="card-head"><span class="card-title">Nothing to act on</span></div>
      <p class="card-note">No rule on this page is failing or waiting for a decision. That is a reading of the ledger you entered, not a forecast about your money.</p></div>`;
  }
  return `<div class="card">
    <div class="card-head"><span class="card-title">Where to start</span><span class="card-note">ranked by verdict, then by the order of the cards below</span></div>
    <div class="check-list">${report.actions.map((a, i) => `
      <div class="check-row">
        <span class="check-label">${i + 1}. ${escapeHtml(a.label)}</span>
        <span class="tag ${VERDICT_TAG[a.verdict]}">${VERDICT_LABEL[a.verdict]}</span>
        <span class="check-detail">${escapeHtml(a.detail)}</span>
        <span class="check-remedy">${escapeHtml(a.remedy || '')} <button class="btn btn-ghost btn-sm" data-goto="${escapeHtml(a.view)}">${gotoLabel(a.view)}</button></span>
      </div>`).join('')}
    </div>
  </div>`;
}

function gotoLabel(view) {
  return { holdings: 'Open holdings', allocation: 'Allocation tab', goals: 'Goals tab', profile: 'Profile tab', planner: 'Retirement tab', settings: 'Settings tab' }[view] || 'Open';
}

// ------------------------------------------------------------------ themes ---

function themeCard(theme, checks) {
  const own = checks.filter((c) => c.theme === theme.key);
  const counts = ['risk', 'watch', 'good', 'unknown'].filter((v) => theme.counts[v]).map((v) => `${theme.counts[v]} ${VERDICT_LABEL[v]}`);
  return `<div class="card${theme.counts.risk ? ' is-alert' : ''}">
    <div class="card-head">
      <span class="card-title">${escapeHtml(theme.label)} <span class="tag ${VERDICT_TAG[theme.verdict]}">${VERDICT_LABEL[theme.verdict]}</span></span>
      <span class="card-note">${escapeHtml(theme.note)}</span>
    </div>
    <div class="check-list">${own.map(checkRow).join('')}</div>
    <p class="card-note" style="margin-top:12px">${counts.length ? counts.join(' · ') : 'nothing measured'}</p>
  </div>`;
}

function checkRow(c) {
  return `<div class="check-row">
    <span class="check-label">${escapeHtml(c.label)}</span>
    <span class="tag ${VERDICT_TAG[c.verdict]}">${VERDICT_LABEL[c.verdict]}</span>
    <span class="check-detail">${escapeHtml(c.detail)}</span>
    ${c.remedy ? `<span class="check-remedy">${escapeHtml(c.remedy)}${c.view ? ` <button class="btn btn-ghost btn-sm" data-goto="${escapeHtml(c.view)}">${gotoLabel(c.view)}</button>` : ''}</span>` : ''}
  </div>`;
}

// ------------------------------------------------------------ score parts ----

function scoreCard(health) {
  if (!health.components.length) {
    return `<div class="card"><div class="card-head"><span class="card-title">The six scored components</span><span class="card-note">what the ring averages</span></div>
      <p class="card-note">Nothing is scored yet. The components switch on as their own inputs arrive: targets and monthly spending in Profile, a date of birth, and a spread of holdings to judge.</p></div>`;
  }
  return `<div class="card">
    <div class="card-head"><span class="card-title">The six scored components</span><span class="card-note">each states the number behind it</span></div>
    <div class="component-list">${health.components.map(componentRow).join('')}</div>
    <p class="card-note" style="margin-top:12px">The ring is the unweighted mean of these, weakest first. A missing cost basis is deliberately absent from them — it is a bookkeeping gap, so it is reported under Ledger trust instead.</p>
  </div>`;
}

function componentRow(c) {
  const color = c.score >= 70 ? 'var(--accent)' : c.score >= 55 ? 'var(--gold)' : 'var(--red)';
  return `<div class="component">
    <span class="component-name">${escapeHtml(c.label)}</span>
    <span class="component-score" style="color:${color}">${c.score}</span>
    <span class="component-detail">${escapeHtml(c.detail)}</span>
    <span class="bar-track"><span class="bar-fill" style="width:${c.score}%;background:${color}"></span></span>
  </div>`;
}

// ------------------------------------------------------------- big numbers ---

function topRowsCard(report, analysis) {
  const { concentration, geography } = analysis;
  if (!report.topRows.length) return '<div class="card span-2"><p class="card-note">No valued rows to rank.</p></div>';
  const max = Math.max(...report.topRows.map((r) => r.valueINR), 1);
  return `<div class="card span-2">
    <div class="card-head"><span class="card-title">What the portfolio rests on</span><span class="card-note">share of gross assets, cumulative down the list</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Holding</th><th>Class · place · counterparty</th><th class="num">Value</th><th class="num">Share</th><th class="num">Running total</th><th></th></tr></thead>
      <tbody>${report.topRows.map((r) => `<tr>
        <td><span class="cell-name">${escapeHtml(r.name || '—')}</span>${r.overTenPct ? ' <span class="tag is-warn">over 10%</span>' : ''}</td>
        <td><span class="muted" style="font-size:12px">${escapeHtml(titleCase(r.category))} · ${countryShort(r.country)}${r.institution ? ` · ${escapeHtml(r.institution)}` : ''}</span></td>
        <td class="num" title="${escapeHtml(money(r.valueINR))}">${shortINR(r.valueINR)}</td>
        <td class="num">${pct(r.pct)}</td>
        <td class="num muted">${pct(r.cumulativePct)}</td>
        <td><span class="drift-track"><i class="is-over" style="width:${(r.valueINR / max * 50).toFixed(1)}%"></i></span></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="stat-chips" style="margin-top:14px">
      <span class="stat-chip">Names <strong>${concentration.count}</strong></span>
      <span class="stat-chip">Largest <strong>${pct(concentration.top1Pct, 0)}</strong> ${escapeHtml(concentration.largest || '')}</span>
      <span class="stat-chip">Top 5 <strong>${pct(concentration.top5Pct, 0)}</strong></span>
      <span class="stat-chip">Herfindahl <strong>${concentration.hhi ? concentration.hhi.toFixed(0) : '—'}</strong> ${hhiNote(concentration.hhi)}</span>
      <span class="stat-chip">Largest country <strong>${pct(geography.largestCountryPct, 0)}</strong> ${countryShort(geography.largestCountry)}</span>
      <span class="stat-chip">Outside rupees <strong>${pct(geography.foreignPct, 0)}</strong></span>
    </div>
  </div>`;
}

function hhiNote(hhi) {
  if (!hhi) return '';
  if (hhi > 2500) return 'concentrated';
  if (hhi > 1500) return 'moderately concentrated';
  return 'well spread';
}

function ladderCard(ladder) {
  if (!ladder.ladder.length) {
    return `<div class="card"><div class="card-head"><span class="card-title">Maturity ladder</span><span class="card-note">when dated money lands</span></div>
      <p class="card-note">Nothing on the ledger carries a maturity date. Deposits and dated bonds put their rows here, year by year, so a single year arriving with too much money to reinvest becomes visible.</p></div>`;
  }
  const upcoming = ladder.ladder.filter((b) => !b.overdue);
  const overdue = ladder.ladder.filter((b) => b.overdue);
  return `<div class="card">
    <div class="card-head"><span class="card-title">Maturity ladder</span><span class="card-note">${shortINR(ladder.datedINR)} dated · ${shortINR(ladder.undatedINR)} without a date</span></div>
    <div class="chart-box"><canvas id="c-ladder"></canvas></div>
    <div class="stat-list" style="margin-top:12px">
      ${upcoming.map((b) => `<div class="stat-line"><span>${b.year} · ${b.count} ${b.count === 1 ? 'row' : 'rows'}<div class="muted" style="font-size:11.5px">${b.names.map(escapeHtml).join(', ')}${b.names.length < b.count ? ' …' : ''}</div></span><strong>${shortINR(b.valueINR)} <span class="muted" style="font-family:inherit;font-size:11.5px">${pct(ladder.datedINR ? (b.valueINR / ladder.datedINR) * 100 : 0, 0)}</span></strong></div>`).join('')}
      ${overdue.length ? `<div class="stat-line"><span>Past their date<div class="muted" style="font-size:11.5px">${overdue.map((b) => `${b.year}: ${b.names.map(escapeHtml).join(', ')}`).join(' · ')}</div></span><strong class="neg">${shortINR(overdue.reduce((a, b) => a + b.valueINR, 0))}</strong></div>` : ''}
      <div class="stat-line"><span>No maturity date</span><strong class="muted">${shortINR(ladder.undatedINR)}</strong></div>
    </div>
    <p class="card-note" style="margin-top:10px">A deposit set to renew is shown at the term it is running now, so its bar walks forward on its own as each term ends.</p>
  </div>`;
}

function earningCard(income, assumptions) {
  const line = (label, value, cls = '', sub = '') => `<div class="stat-line"><span>${label}${sub ? `<div class="muted" style="font-size:11.5px">${sub}</div>` : ''}</span><strong class="${cls}">${value}</strong></div>`;
  const inflation = Number(assumptions.inflationPct) || 0;
  const totalRows = income.earningCount + income.silentCount;
  const spread = income.blendedYieldPct !== null && income.debtCostPct !== null ? income.blendedYieldPct - income.debtCostPct : null;
  return `<div class="card">
    <div class="card-head"><span class="card-title">Earning power</span><span class="card-note">the rates on your own rows, not a forecast</span></div>
    <div class="stat-list">
      ${line('Contractual income a year', money(income.annualIncomeINR), 'is-accent', `${income.earningCount} of ${totalRows} rows state a rate`)}
      ${income.interestIncomeINR ? line('Interest', money(income.interestIncomeINR)) : ''}
      ${income.dividendIncomeINR ? line('Stated dividends', money(income.dividendIncomeINR)) : ''}
      ${line('Earned on', money(income.earningValueINR))}
      ${line('Blended yield', income.blendedYieldPct === null ? '—' : pct(income.blendedYieldPct), income.blendedYieldPct !== null && income.blendedYieldPct < inflation ? 'is-red' : 'is-accent', inflation ? `against ${pct(inflation, 0)} assumed inflation` : 'no inflation assumption set')}
      ${line('Income yield on everything', income.portfolioYieldPct === null ? '—' : pct(income.portfolioYieldPct), '', 'silent assets pull this down by design')}
      ${line('Assets carrying no rate', money(income.silentValueINR), '', `${income.silentCount} row(s): growth, property, gold, or a rate not entered`)}
      ${income.debtValueINR ? line('Debt', money(income.debtValueINR), 'neg', income.debtCostPct === null ? `${money(income.uncostedDebtINR)} of it has no rate on the row` : `costs ${pct(income.debtCostPct)} blended`) : ''}
      ${spread === null ? '' : line('Spread, earning against borrowing', pct(spread), spread > 0 ? 'is-accent' : 'neg', spread > 0 ? 'borrowing is cheaper than holding' : 'every borrowed rupee loses ground')}
    </div>
  </div>`;
}

// -------------------------------------------------------------- counterparty --

function counterpartyCard(report) {
  const { institutions } = report;
  const limit = money(report.depositInsuranceLimitINR);
  const insuredTotal = institutions.deposits.reduce((a, d) => a + d.insuredINR, 0);
  return `<div class="card span-2">
    <div class="card-head"><span class="card-title">Counterparty exposure</span><span class="card-note">who holds the money, and how much of it is insured</span></div>
    <div class="grid grid-2">
      <div>
        <div class="section-label">By bank or broker</div>
        ${institutions.list.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Institution</th><th class="num">Rows</th><th class="num">Value</th><th class="num">Share</th></tr></thead>
          <tbody>${institutions.list.slice(0, 12).map((i) => `<tr>
            <td><span class="cell-name">${escapeHtml(i.name)}</span><div class="muted" style="font-size:11.5px">${i.categories.map((c) => escapeHtml(titleCase(c))).join(', ')}</div></td>
            <td class="num">${i.count}</td>
            <td class="num">${shortINR(i.valueINR)}</td>
            <td class="num" style="color:${i.pct >= 50 ? 'var(--red)' : i.pct >= 30 ? 'var(--gold)' : 'inherit'}">${pct(i.pct)}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : '<p class="card-note">No holding records an institution, so this cannot be measured.</p>'}
        ${institutions.unnamedCount ? `<p class="card-note" style="margin-top:8px">${institutions.unnamedCount} ${institutions.unnamedCount === 1 ? 'row' : 'rows'} worth ${shortINR(institutions.unnamedINR)} name no institution and are absent from this table.</p>` : ''}
      </div>
      <div>
        <div class="section-label">Indian deposits against DICGC cover</div>
        ${institutions.deposits.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Bank</th><th class="num">Deposits</th><th class="num">Inside cover</th><th class="num">Uninsured</th></tr></thead>
          <tbody>${institutions.deposits.map((d) => `<tr>
            <td><span class="cell-name">${escapeHtml(d.name)}</span><div class="muted" style="font-size:11.5px">${d.count} ${d.count === 1 ? 'row' : 'rows'}</div></td>
            <td class="num">${money(d.valueINR)}</td>
            <td class="num">${money(d.insuredINR)}</td>
            <td class="num" style="color:${d.uncoveredINR ? 'var(--red)' : 'var(--text-faint)'}">${d.uncoveredINR ? money(d.uncoveredINR) : '—'}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr><td><strong>Total</strong></td><td class="num"><strong>${money(institutions.depositsINR)}</strong></td><td class="num">${money(insuredTotal)}</td><td class="num" style="color:${institutions.uncoveredINR ? 'var(--red)' : 'var(--text-faint)'}"><strong>${institutions.uncoveredINR ? money(institutions.uncoveredINR) : '—'}</strong></td></tr></tfoot>
        </table></div>` : '<p class="card-note">No Indian bank or deposit rows to measure against the limit.</p>'}
        <p class="card-note" style="margin-top:8px">DICGC insures ${limit} per depositor per bank in India, and savings balances count toward the same limit as the deposits at that bank. Joint holdings, a bank's exact cover status and non-Indian banks are outside this table — check those with the depositor insurer rather than with this page.</p>
      </div>
    </div>
  </div>`;
}

// --------------------------------------------------------------- bookkeeping ---

function trustCard(report, data) {
  const p = report.pricing;
  const unconverted = data.meta.unconverted || [];
  const line = (label, value, sub = '') => `<div class="stat-line"><span>${label}${sub ? `<div class="muted" style="font-size:11.5px">${sub}</div>` : ''}</span><strong>${value}</strong></div>`;
  const noIdentity = data.holdings.filter((h) => h.category !== 'liability' && (h.valueINR || 0) > 0 && (!(h.country || '').trim() || !String(h.institution || '').trim())).length;
  const zeroRows = data.holdings.filter((h) => !(h.valueINR > 0) && !unconverted.some((u) => u.id === h.id)).length;
  return `<div class="card">
    <div class="card-head"><span class="card-title">What these numbers rest on</span><span class="card-note">the ledger's own bookkeeping</span></div>
    <div class="stat-list">
      ${line('Cost basis recorded', `${pct(data.analysis.health.costBasisCoveragePct || 0, 0)} of assets`, 'returns and tax buckets reach that far')}
      ${line('Rows a price feed answers for', `${p.pricedCount} of ${p.feedableCount}`, p.blindCount ? `${p.blindCount} carry no quote date: ${p.blindNames.slice(0, 3).join(', ')}${p.blindNames.length > 3 ? ' …' : ''}` : 'every one has a date on it')}
      ${line('Valued by hand', String(p.pinnedCount), p.pinnedValueINR ? `${shortINR(p.pinnedValueINR)} pinned, so the feed leaves them alone` : 'nothing pinned')}
      ${line('Currency with no rate', String(unconverted.length), unconverted.length ? `${unconverted.map((u) => u.currency).join(', ')} — excluded from net worth` : 'every row converts')}
      ${line('Missing a country or counterparty', String(noIdentity), 'the geography and cover tables skip these')}
      ${line('Rows holding no value', String(zeroRows), zeroRows ? 'they still count in every share above' : 'none')}
      ${line('Last ledger write', escapeHtml((data.meta.updatedAt || '').slice(0, 10) || '—'), `prices fetched ${escapeHtml((data.meta.priceRefreshedAt || '').slice(0, 10) || 'never')}`)}
    </div>
  </div>`;
}

function methodCard(report) {
  return `<div class="card span-2">
    <div class="card-head"><span class="card-title">How this page reaches its verdicts</span><span class="card-note">${report.checks.length} fixed rules over the ledger</span></div>
    <p class="card-note">Each rule compares a number the ledger already holds against a threshold, and the number is printed inside the rule's own sentence so you can disagree with it. Nothing here is a forecast, an order, or advice on your tax position: a portfolio can clear every rule and still lose money, and one that trips several may be exactly the plan you intended. Where a rule has no input to work on — no monthly spending in Profile, no targets, no date of birth — it reports <em>no data</em> rather than guessing at a verdict.</p>
    <div class="stat-chips" style="margin-top:14px">
      ${report.themes.map((t) => `<span class="stat-chip">${escapeHtml(t.label)} <strong>${t.checks}</strong> ${t.checks === 1 ? 'rule' : 'rules'}</span>`).join('')}
      <span class="stat-chip">Empty ledger <strong>${report.counts.assets ? 'no' : 'yes'}</strong></span>
    </div>
  </div>`;
}

// ------------------------------------------------------------------- chart ---

function drawLadder(ladder) {
  if (!ladder.ladder.length) return;
  const bars = [...ladder.ladder];
  if (ladder.undatedINR > 0) bars.push({ yearLabel: 'No date', valueINR: ladder.undatedINR, overdue: false });
  barChart('c-ladder', bars.map((b) => b.yearLabel || String(b.year)), bars.map((b) => b.valueINR), {
    label: 'Coming due',
    colors: bars.map((b) => (b.overdue ? '#f87171' : b.yearLabel ? 'rgba(148,163,184,.35)' : PALETTE[1])),
  });
}
