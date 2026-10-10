import { money, shortINR, escapeHtml, ageFrom } from '../format.js';
import { lineChart, dataset, PALETTE } from '../charts.js';
import { buildPlan, cashFlow } from '../planning.js';
import { api } from '../api.js';
import { field, input, toast } from '../ui.js';

export function render(root, ctx) {
  const { profile, summary } = ctx.data;
  const assumptions = ctx.data.settings.assumptions;
  const currentAge = ageFrom(profile.dateOfBirth);
  const plan = buildPlan({
    profile,
    assumptions,
    netWorthINR: summary.netWorthINR,
    liquidAssetsINR: summary.liquidAssetsINR,
    currentAge: currentAge ?? profile.plannedRetirementAge,
  });

  const shortfall = plan.gapINR > 0;
  const cf = cashFlow({
    profile,
    netWorthINR: summary.netWorthINR,
    totalLiabilitiesINR: summary.totalLiabilitiesINR,
    currentAge: plan.currentAge,
    assumptions,
  });

  root.innerHTML = `
    ${plan.warnings.length ? plan.warnings.map((w) => `<div class="callout ${w.level === 'bad' ? 'is-bad' : w.level === 'warn' ? 'is-warn' : ''}" style="margin-bottom:10px">${escapeHtml(w.text)}</div>`).join('') : ''}

    <div class="hero" style="margin-bottom:16px">
      <div>
        <span class="kpi-label">Retirement corpus you need at age ${plan.retireAge}</span>
        <div class="hero-figure" style="color:${shortfall ? 'var(--gold)' : 'var(--accent)'}">${money(plan.corpus.requiredINR)}</div>
        <div class="hero-eta">Funds a ${plan.corpus.spanYears}-year drawdown starting at ${shortINR(plan.corpus.firstYearWithdrawalINR)} a year, indexed to ${assumptions.inflationPct}% inflation${assumptions.corpusBufferPct > 0 ? `, with a ${assumptions.corpusBufferPct}% safety buffer` : ''}.</div>
      </div>
      <div class="hero-stats">
        <div class="hero-stat"><span class="kpi-label">Projected at ${plan.retireAge}</span><div class="kpi-value ${shortfall ? 'is-red' : 'is-accent'}">${shortINR(plan.baseline.balanceAtRetirementINR)}</div><div class="kpi-sub">on current saving</div></div>
        <div class="hero-stat"><span class="kpi-label">Gap to close</span><div class="kpi-value ${shortfall ? 'is-gold' : 'is-accent'}">${shortfall ? shortINR(plan.gapINR) : 'None'}</div><div class="kpi-sub">${shortfall ? `${shortINR(plan.gapTodayValueINR)} in today's purchasing power` : 'target already met'}</div></div>
        <div class="hero-stat"><span class="kpi-label">Extra to invest</span><div class="kpi-value ${shortfall ? 'is-blue' : ''}">${shortfall ? `${shortINR(plan.additionalMonthlyTopUpINR)}/mo` : '—'}</div><div class="kpi-sub">top-up from today</div></div>
        <div class="hero-stat"><span class="kpi-label">Financially free</span><div class="kpi-value">${plan.financiallyFreeAge ?? '—'}</div><div class="kpi-sub">age corpus target is reached</div></div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card span-2">
        <div class="card-head">
          <span class="card-title">Wealth path from age ${plan.currentAge} to ${plan.lifeAge}</span>
          <span class="card-note">nominal INR · the dashed line is money you would still need</span>
        </div>
        <div class="chart-box is-tall"><canvas id="c-path"></canvas></div>
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">Plan A — keep saving as today</span><span class="card-note">${escapeHtml(profile.monthlyInvestableSurplusINR ? `${shortINR(profile.monthlyInvestableSurplusINR)}/mo invested` : 'no surplus set')}</span></div>
        <div class="stat-list">
          ${line('Net worth today', money(summary.netWorthINR))}
          ${line(`Corpus at ${plan.retireAge}`, money(plan.baseline.balanceAtRetirementINR))}
          ${line('Corpus at ' + plan.lifeAge, money(plan.baseline.finalBalanceINR), plan.baseline.finalBalanceINR < 0 ? 'neg' : '')}
          ${line('Money runs out', plan.baseline.runsOutAge ? `at age ${plan.baseline.runsOutAge}` : 'Never — lasts to life expectancy', plan.baseline.runsOutAge ? 'neg' : '')}
          ${line('Target progress', `${plan.progressPct.toFixed(0)}%`)}
        </div>
        ${plan.baseline.runsOutAge ? `<div class="callout is-bad" style="margin-top:12px">On this path you exhaust your savings at age ${plan.baseline.runsOutAge}, ${plan.baseline.runsOutAge < plan.lifeAge ? `${plan.lifeAge - plan.baseline.runsOutAge} years before your planning horizon ends.` : 'before your planning horizon.'}</div>` : ''}
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">Plan B — close the gap</span><span class="card-note">${shortfall ? `adds ${shortINR(plan.additionalMonthlyTopUpINR)}/mo` : 'nothing to add'}</span></div>
        <div class="stat-list">
          ${line('Monthly investing', profile.monthlyInvestableSurplusINR ? `${shortINR(profile.monthlyInvestableSurplusINR)} + ${shortINR(plan.additionalMonthlyTopUpINR)} = ${shortINR(profile.monthlyInvestableSurplusINR + plan.additionalMonthlyTopUpINR)}` : shortINR(plan.additionalMonthlyTopUpINR))}
          ${line('Income share', shareOfIncome(profile, plan))}
          ${line(`Corpus at ${plan.retireAge}`, money(plan.funded.balanceAtRetirementINR))}
          ${line('Corpus at ' + plan.lifeAge, money(plan.funded.finalBalanceINR))}
          ${line('Beats the target', plan.funded.balanceAtRetirementINR >= plan.corpus.requiredINR ? 'Yes' : 'No', plan.funded.balanceAtRetirementINR >= plan.corpus.requiredINR ? '' : 'neg')}
        </div>
        ${shortfall
          ? `<div class="callout" style="margin-top:12px">To fund this, redirect ${shortINR(plan.additionalMonthlyTopUpINR)} a month — ${gapToIncomePct(profile, plan)} of your current monthly income.</div>`
          : `<div class="callout" style="margin-top:12px">Your existing trajectory already clears the target by ${shortINR(Math.max(0, plan.baseline.balanceAtRetirementINR - plan.corpus.requiredINR))}.</div>`}
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">Assumptions</span><span class="card-note">saved to the data file</span></div>
        <form class="assumptions-form" id="assumptions-form">
          <div class="field-set is-dense">
            ${field('Pre-retirement return %', input('preRetirementReturnPct', assumptions.preRetirementReturnPct, 'number'))}
            ${field('Post-retirement return %', input('postRetirementReturnPct', assumptions.postRetirementReturnPct, 'number'))}
            ${field('Inflation %', input('inflationPct', assumptions.inflationPct, 'number'))}
            ${field('Salary growth %', input('salaryGrowthPct', assumptions.salaryGrowthPct, 'number'))}
            ${field('Corpus buffer %', input('corpusBufferPct', assumptions.corpusBufferPct, 'number'))}
          </div>
          <div class="section-label">Your numbers</div>
          <div class="field-set is-dense">
            ${field('Retirement age', input('plannedRetirementAge', profile.plannedRetirementAge, 'number'))}
            ${field('Plan to age', input('lifeExpectancy', profile.lifeExpectancy, 'number'))}
            ${field('Monthly spending in retirement (today ₹)', input('monthlyExpensesInRetirementINR', profile.monthlyExpensesInRetirementINR, 'number'))}
            ${field('Investing per month now ₹', input('monthlyInvestableSurplusINR', profile.monthlyInvestableSurplusINR, 'number'))}
          </div>
          <div style="display:flex;gap:10px;align-items:center">
            <button class="btn btn-primary" type="submit">Recalculate</button>
            <span class="card-note">Presets: ${['conservative', 'moderate', 'aggressive'].map((p) => `<button type="button" class="btn btn-ghost btn-sm" data-preset="${p}">${p}</button>`).join(' ')}</span>
          </div>
        </form>
      </div>

      <div class="card span-2">
        <div class="card-head"><span class="card-title">Cash flow &amp; financial independence</span><span class="card-note">what leaves, what is invested, and when that buys freedom</span></div>
        ${cashFlowCard(cf)}
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">Matures within 18 months</span><span class="card-note">cash you can plan around</span></div>
        ${maturityList(ctx.data.holdings)}
      </div>
    </div>`;

  drawPath(plan);
  wireForm(root, ctx);
}

function line(label, value, cls = '') {
  return `<div class="stat-line"><span>${label}</span><strong class="${cls}">${value}</strong></div>`;
}

function cashFlowCard(cf) {
  if (!cf.monthlyIncomeINR) {
    return `<p class="card-note">Fill in monthly income, spending and any EMIs on the Profile tab and this card works out your savings rate, the corpus that makes you financially independent, and when current habits reach it.</p>`;
  }
  const pct1 = (n) => (n === null || n === undefined ? '—' : `${n.toFixed(0)}%`);
  return `
    <div class="hero-stats" style="margin-bottom:16px">
      <div class="hero-stat"><span class="kpi-label">Savings rate</span><div class="kpi-value ${cf.savingsRatePct >= 50 ? 'is-accent' : cf.savingsRatePct >= 25 ? 'is-gold' : 'is-red'}">${pct1(cf.savingsRatePct)}</div><div class="kpi-sub">of income after ${shortINR(cf.monthlyCommittedINR)} of spending and EMIs</div></div>
      <div class="hero-stat"><span class="kpi-label">Actually invested</span><div class="kpi-value is-blue">${pct1(cf.investedRatePct)}</div><div class="kpi-sub">${shortINR(cf.monthlyInvestedINR)} a month</div></div>
      <div class="hero-stat"><span class="kpi-label">FIRE number</span><div class="kpi-value is-gold">${shortINR(cf.fireNumberINR)}</div><div class="kpi-sub">25× annual committed outflow</div></div>
      <div class="hero-stat"><span class="kpi-label">Independent at</span><div class="kpi-value">${cf.fireAge ?? 'not on this path'}</div><div class="kpi-sub">${cf.yearsToFire === null ? 'raise the surplus or cut committed spend' : cf.yearsToFire <= 0 ? `already reached — ${pct1(cf.fireProgressPct)} of the number today` : `in ${cf.yearsToFire} year${cf.yearsToFire === 1 ? '' : 's'}, at ${pct1(cf.fireProgressPct)} there now`}</div></div>
    </div>

    <div style="display:grid;gap:14px">
      ${meter('Progress to the FIRE number', cf.fireProgressPct, 'stop working entirely')}
      ${meter('Progress to coast FIRE', cf.coastProgressPct, `stop adding money — ${shortINR(cf.coastFireINR)} grows into the FIRE number by your planned retirement age on its own`)}
    </div>

    <div class="stat-list" style="margin-top:16px">
      ${line('EMI burden', cf.monthlyEmiINR ? `${pct1(cf.emiBurdenPct)} of income · ${shortINR(cf.monthlyEmiINR)}/mo` : 'none recorded', cf.emiBurdenPct > 40 ? 'neg' : '')}
      ${line('Debt against income', cf.debtToIncomeYears === null ? '—' : `${cf.debtToIncomeYears.toFixed(1)} years of gross income`, cf.debtToIncomeYears > 4 ? 'neg' : '')}
      ${line('Committed outflow', `${shortINR(cf.monthlyCommittedINR)}/mo — spending ${shortINR(cf.monthlySpendingINR)} plus EMI ${shortINR(cf.monthlyEmiINR)}`)}
    </div>
    ${cf.emiBurdenPct > 40 ? `<div class="callout is-bad" style="margin-top:12px">EMIs take ${pct1(cf.emiBurdenPct)} of income. Lenders treat 40–50% as the stress line, and it is the single fastest way to raise a savings rate to clear the ${shortINR(cf.fireNumberINR)} target sooner.</div>` : ''}
    ${cf.leakINR > cf.monthlyIncomeINR * 0.15 ? `<div class="callout is-warn" style="margin-top:12px">Income less committed spending leaves ${shortINR(cf.monthlyUnallocatedINR)} a month, but only ${shortINR(cf.monthlyInvestedINR)} is recorded as invested — ${shortINR(cf.leakINR)} is unaccounted for. Either the surplus figure on Profile is stale or that cash is sitting in savings accounts earning nothing.</div>` : ''}
    <p class="card-note" style="margin-top:12px">FIRE uses the 4% rule: a corpus 25 times your committed annual outflow withdraws indefinitely at the assumed return. It is a rule of thumb, not a guarantee — the retirement corpus above is the one modelled against your own life expectancy.</p>`;
}

function meter(label, progressPct, note) {
  if (progressPct === null || progressPct === undefined) return '';
  const clamped = Math.max(0, Math.min(100, progressPct));
  const color = progressPct >= 100 ? 'var(--accent)' : progressPct >= 55 ? 'var(--blue)' : progressPct >= 25 ? 'var(--gold)' : 'var(--red)';
  return `<div class="progress-row">
    <span>${label}</span>
    <span>${progressPct >= 100 ? `${(progressPct / 100).toFixed(1)}× there` : `${progressPct.toFixed(0)}%`}</span>
    <span class="bar-track"><span class="bar-fill" style="width:${clamped}%;background:${color}"></span></span>
    <span class="muted" style="font-size:11.5px">${note}</span>
  </div>`;
}


const PRESETS = {
  conservative: { preRetirementReturnPct: 9, postRetirementReturnPct: 6, inflationPct: 6, salaryGrowthPct: 5, corpusBufferPct: 15 },
  moderate: { preRetirementReturnPct: 11, postRetirementReturnPct: 7, inflationPct: 6, salaryGrowthPct: 6, corpusBufferPct: 10 },
  aggressive: { preRetirementReturnPct: 13, postRetirementReturnPct: 8, inflationPct: 6, salaryGrowthPct: 8, corpusBufferPct: 5 },
};

function shareOfIncome(profile, plan) {
  if (!profile.monthlyIncomeINR) return 'set income in Profile';
  const total = (profile.monthlyInvestableSurplusINR || 0) + plan.additionalMonthlyTopUpINR;
  return `${(total / profile.monthlyIncomeINR * 100).toFixed(0)}% of income`;
}

function gapToIncomePct(profile, plan) {
  if (!profile.monthlyIncomeINR) return shortINR(plan.additionalMonthlyTopUpINR);
  return `${(plan.additionalMonthlyTopUpINR / profile.monthlyIncomeINR * 100).toFixed(1)}%`;
}

function maturityList(holdings) {
  const now = new Date();
  const horizon = new Date(now.getFullYear() + 1.5, now.getMonth(), now.getDate());
  const rows = holdings
    .filter((h) => h.maturityDate && h.category !== 'liability')
    .map((h) => ({ h, d: new Date(h.maturityDate) }))
    .filter((x) => x.d >= now && x.d <= horizon)
    .sort((a, b) => a.d - b.d);
  if (!rows.length) return `<p class="card-note">Nothing maturing in the next 18 months. Add maturity dates on deposits, bonds and policies to see this.</p>`;
  return `<div class="stat-list">${rows.map(({ h, d }) =>
    `<div class="stat-line"><span>${escapeHtml(h.name)} <span class="muted">${h.maturityDate}</span></span><strong>${shortINR(h.valueINR || 0)}</strong></div>`).join('')}</div>`;
}

function drawPath(plan) {
  const labels = plan.baseline.series.map((p) => p.age);
  const required = plan.corpus.requiredINR;
  lineChart('c-path', labels, [
    dataset('Plan A — current saving', plan.baseline.series.map((p) => Math.max(0, p.balanceINR)), PALETTE[3], { fill: false, dash: [6, 4] }),
    dataset('Plan B — with top-up', plan.funded.series.map((p) => Math.max(0, p.balanceINR)), PALETTE[0]),
    {
      label: `Corpus needed at ${plan.retireAge}`,
      data: labels.map((age) => (age <= plan.retireAge ? required : null)),
      borderColor: PALETTE[2],
      backgroundColor: 'rgba(251, 191, 36, .08)',
      borderDash: [2, 3],
      fill: 'origin',
      pointRadius: 0,
      borderWidth: 1.5,
    },
  ], { includeNegative: false });
}

function wireForm(root, ctx) {
  const form = document.getElementById('assumptions-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const assumptionKeys = ['preRetirementReturnPct', 'postRetirementReturnPct', 'inflationPct', 'salaryGrowthPct', 'corpusBufferPct'];
    const assumptionPatch = Object.fromEntries(assumptionKeys.map((k) => [k, Number(values[k]) || 0]));
    const profilePatch = {
      plannedRetirementAge: Number(values.plannedRetirementAge),
      lifeExpectancy: Number(values.lifeExpectancy),
      monthlyExpensesInRetirementINR: Number(values.monthlyExpensesInRetirementINR) || 0,
      monthlyInvestableSurplusINR: Number(values.monthlyInvestableSurplusINR) || 0,
    };
    try {
      await api.saveAssumptions(assumptionPatch);
      await api.saveProfile(profilePatch);
    } catch (err) {
      toast(err.message, 'bad', 5000);
      return;
    }
    await ctx.reload();
    toast('Retirement plan recalculated.');
  });

  form.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.onclick = () => {
      const p = PRESETS[btn.dataset.preset];
      for (const [k, v] of Object.entries(p)) {
        const el = form.querySelector(`[name="${k}"]`);
        if (el) el.value = v;
      }
      toast(`Loaded the ${btn.dataset.preset} preset — press Recalculate to save.`);
    };
  });
}
