// The portfolio report: one document assembled from exactly what /api/state
// already publishes, so the PDF cannot disagree with the screen.
//
// `retirement` is the one block the browser hands over. The corpus projection
// lives in public/js/planning.js and is used live by the Retirement tab; the
// server has no second copy of that arithmetic, and a copy would be a number
// waiting to drift. Without it the section says so instead of guessing.

const { Pdf, colors } = require('./pdf');

const group = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const group2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function rs(n, { decimals = false, sign = false } = {}) {
  const v = Number(n) || 0;
  const body = `${decimals ? group2.format(Math.abs(v)) : group.format(Math.abs(v))}`;
  const prefix = v < 0 ? '-' : sign && v > 0 ? '+' : '';
  return `${prefix}Rs ${body}`;
}

function pct(n, digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '-';
  return `${Number(n).toFixed(digits)}%`;
}

function dash(v) {
  return v === null || v === undefined || v === '' ? '-' : String(v);
}

function titleCase(v) {
  return String(v || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function shortDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fileNameFor(date) {
  return `wealth-report-${date.toISOString().slice(0, 10)}.pdf`;
}

function buildReport({ state, plan = null, cash = null, now = new Date() }) {
  const { profile, summary, holdings, goals, analysis, portfolioHealth, indiaTax, meta, age, settings } = state;
  const sections = [];
  const warnings = [];

  const doc = new Pdf({
    title: `Wealth Ledger portfolio report - ${now.toISOString().slice(0, 10)}`,
    author: [profile.salutation, profile.fullName].filter(Boolean).join(' '),
    footer: `Wealth Ledger - generated locally on ${shortDate(now)} - net worth figures in Indian rupees`,
  });
  doc.stampDate = now;

  cover(doc, { profile, summary, indiaTax, state, age, now, sections });
  position(doc, { summary, analysis, sections });
  positionsTable(doc, { holdings, summary, sections });
  allocationSection(doc, { analysis, portfolioHealth, settings, sections });
  healthSection(doc, { analysis, portfolioHealth, sections });
  incomeSection(doc, { indiaTax, sections });
  goalsSection(doc, { goals, sections });
  retirementSection(doc, { plan, cash, summary, profile, settings, sections, warnings });
  methodSection(doc, { state, sections, warnings });

  const buffer = doc.build();
  return {
    buffer,
    fileName: fileNameFor(now),
    pages: doc.pages.length,
    bytes: buffer.length,
    sections,
    warnings,
    netWorthINR: summary.netWorthINR,
    holdingCount: holdings.length,
  };
}

function cover(doc, { profile, summary, indiaTax, state, age, now, sections }) {
  sections.push('Cover');
  doc.text('Wealth Ledger', { size: 22, bold: true, color: colors.ACCENT, gap: 1 });
  doc.text('Portfolio report', { size: 13, color: colors.MUTED, gap: 2 });
  doc.rule(colors.ACCENT, 1, 6);
  doc.space(6);
  const who = [profile.salutation, profile.fullName].filter(Boolean).join(' ');
  doc.kv('Prepared for', who || 'No name recorded in Profile');
  doc.kv('Age', age === null ? 'Not recorded - add a date of birth in Profile' : `${age}`);
  doc.kv('Generated', `${shortDate(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
  doc.kv('Currency', 'Indian rupee (INR)');
  doc.kv('Exchange rates', state.fxDate ? `ECB reference, dated ${shortDate(state.fxDate)}` : 'Bundled defaults, no live pull yet');
  doc.space(10);

  doc.text('Net worth', { size: 10, bold: true, color: colors.MUTED, gap: 1 });
  doc.text(rs(summary.netWorthINR), { size: 26, bold: true, color: colors.ACCENT, gap: 2 });
  doc.text(`${crora(summary.netWorthINR)} across ${summary.assetCount} asset ${summary.assetCount === 1 ? 'row' : 'rows'} and `
    + `${summary.liabilityCount} liabilit${summary.liabilityCount === 1 ? 'y' : 'ies'}`, { size: 9, color: colors.MUTED, gap: 6 });
  doc.space(4);

  const cols = [
    ['Gross assets', rs(summary.totalAssetsINR)],
    ['Liabilities', rs(-summary.totalLiabilitiesINR, { sign: false })],
    ['Liquid assets', `${rs(summary.liquidAssetsINR)}`],
    ['Illiquid assets', rs(summary.illiquidAssetsINR)],
    ['Cost basis recorded', rs(summary.performance.costedINR)],
    ['Unrealised gain', summary.performance.unrealisedGainPct === null ? 'No cost basis yet' : rs(summary.performance.unrealisedGainINR, { sign: true })],
    ['Portfolio XIRR', summary.performance.xirrPct === null ? 'Needs 2 dated lots' : pct(summary.performance.xirrPct)],
    ['India income this FY', indiaTax.totals.holdingCount
      ? `${rs(indiaTax.totals.accruedYtdINR)} accrued, ${rs(indiaTax.totals.projectedFullFYINR)} projected`
      : 'No Indian-source income rows'],
  ];
  doc.space(2);
  cols.forEach(([label, value]) => doc.kv(label, value, { size: 9.2 }));
}

function crora(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e7) return `${(v / 1e7).toFixed(2)} crore`;
  if (abs >= 1e5) return `${(v / 1e5).toFixed(2)} lakh`;
  return `${group.format(v)} rupees`;
}

function position(doc, { summary, analysis, sections }) {
  sections.push('What you hold');
  doc.heading('What you hold, by asset class');
  const rows = Object.values(summary.byCategory).map((c) => [
    c.label,
    `${c.count}`,
    rs(c.valueINR),
    c.key === 'liability' ? '-' : pct(c.shareOfAssetsPct, 0),
  ]);
  doc.table({
    columns: [{ label: 'Class', width: 34 }, { label: 'Rows', width: 10, align: 'right' },
      { label: 'Value', width: 30, align: 'right' }, { label: 'Share of assets', width: 26, align: 'right' }],
    rows,
  });

  doc.subheading('By country');
  const countries = Object.values(summary.byCountry).sort((a, b) => b.netContributionINR - a.netContributionINR);
  doc.table({
    columns: [{ label: 'Country', width: 22 }, { label: 'Rows', width: 10, align: 'right' },
      { label: 'Assets', width: 26, align: 'right' }, { label: 'Liabilities', width: 24, align: 'right' },
      { label: 'Net', width: 24, align: 'right' }],
    rows: countries.map((c) => [countryName(c.key), `${c.count}`, rs(c.valueINR), c.liabilitiesINR ? rs(-c.liabilitiesINR) : '-', rs(c.netContributionINR)]),
  });
  doc.paragraph(`Largest country is ${pct(analysis.geography.largestCountryPct)} of assets across ${analysis.geography.countryCount} `
    + `territor${analysis.geography.countryCount === 1 ? 'y' : 'ies'}; ${pct(analysis.geography.foreignPct)} of the portfolio is denominated outside the rupee.`);
}

const COUNTRIES = {
  IN: 'India', TH: 'Thailand', SG: 'Singapore', US: 'United States', GB: 'United Kingdom',
  AE: 'United Arab Emirates', AU: 'Australia', CH: 'Switzerland', HK: 'Hong Kong', MY: 'Malaysia',
  CA: 'Canada', DE: 'Germany', ZZ: 'Country not recorded',
};

function countryName(code) {
  return COUNTRIES[code] || code || 'Not recorded';
}

function positionsTable(doc, { holdings, summary, sections }) {
  sections.push('Positions');
  doc.heading('Every position on the ledger');
  const rows = [...holdings].sort((a, b) => (b.valueINR || 0) - (a.valueINR || 0));
  const total = summary.totalAssetsINR || 1;
  doc.table({
    columns: [{ label: 'Name', width: 30 }, { label: 'Class', width: 16 }, { label: 'Where', width: 18 },
      { label: 'Rate', width: 9, align: 'right' }, { label: 'Matures', width: 13 },
      { label: 'Value', width: 18, align: 'right', bold: true }],
    rows: rows.map((h) => [
      h.name || '(unnamed)',
      titleCase(h.category),
      [h.institution, countryName(h.country)].filter(Boolean).join(' · ') || '-',
      h.interestRatePct ? pct(h.interestRatePct, 1) : h.bondYieldPct ? pct(h.bondYieldPct, 1) : '-',
      h.maturityDate ? shortDate(h.maturityDate) : '-',
      h.category === 'liability' ? `-${rs(h.valueINR)}` : rs(h.valueINR),
    ]),
  });
  const share = rows.slice(0, 5).reduce((a, h) => a + (h.valueINR || 0), 0) / total * 100;
  doc.paragraph(`Sorted by value. The five largest positions are ${pct(share)} of gross assets; `
    + `${rows.filter((h) => h.priceAsOf).length} of ${rows.length} ${rows.length === 1 ? 'row carries' : 'rows carry'} a live quote date.`);
}

function allocationSection(doc, { analysis, portfolioHealth, settings, sections }) {
  sections.push('Allocation');
  doc.heading('Allocation against target');
  const alloc = analysis.allocation;
  if (!alloc.rows.length) {
    doc.paragraph('Nothing is valued yet, so there is no mix to measure.');
    return;
  }
  doc.table({
    columns: [{ label: 'Class', width: 30 }, { label: 'Held', width: 20, align: 'right' },
      { label: 'Actual', width: 14, align: 'right' }, { label: 'Target', width: 14, align: 'right' },
      { label: 'Drift', width: 14, align: 'right' }, { label: 'Move needed', width: 18, align: 'right' }, { label: 'Action', width: 14 }],
    rows: alloc.rows.map((r) => [r.label, rs(r.heldINR), pct(r.actualPct), r.hasTarget ? pct(r.targetPct) : '-',
      r.hasTarget ? `${r.driftPct > 0 ? '+' : ''}${pct(r.driftPct)}` : '-',
      r.hasTarget ? `${r.deltaINR > 0 ? '+' : r.deltaINR < 0 ? '-' : ''}${rs(Math.abs(r.deltaINR))}` : '-',
      r.hasTarget ? (Math.abs(r.driftPct) < 1 ? 'in line' : r.action === 'buy' ? 'add' : 'trim') : 'no target']),
  });
  doc.paragraph(alloc.targetsComplete
    ? 'Targets total 100%, so the move column is a full rebalancing plan. Trimming one class is assumed to fund another.'
    : 'No complete target set is saved, so the drift and move columns are switched off. Set weights on the Allocation tab.');

  const risk = analysis.riskMix;
  doc.subheading('Risk mix');
  doc.table({
    columns: [{ label: 'Bucket', width: 30 }, { label: 'Value', width: 30, align: 'right' }, { label: 'Share', width: 20, align: 'right' }],
    rows: risk.map((r) => [titleCase(r.label), rs(r.valueINR), pct(r.pct)]),
  });

  doc.subheading('Concentration');
  doc.kv('Largest holding', `${analysis.concentration.largest || '-'} at ${pct(analysis.concentration.top1Pct)}`);
  doc.kv('Top five combined', pct(analysis.concentration.top5Pct));
  doc.kv('Names held', `${analysis.concentration.count}`);
  doc.kv('Herfindahl index', analysis.concentration.hhi ? `${analysis.concentration.hhi} - ${hhiWord(analysis.concentration.hhi)}` : '-');
  const top = portfolioHealth.topRows.slice(0, 10);
  if (top.length) {
    doc.space(4);
    doc.table({
      columns: [{ label: 'Rank', width: 8, align: 'right' }, { label: 'Position', width: 34 },
        { label: 'Value', width: 20, align: 'right' }, { label: 'Share', width: 12, align: 'right' },
        { label: 'Cumulative', width: 16, align: 'right' }],
      rows: top.map((r, i) => [`${i + 1}`, r.name, rs(r.valueINR), pct(r.pct), pct(r.cumulativePct)]),
    });
  }
}

function hhiWord(hhi) {
  if (hhi > 2500) return 'concentrated';
  if (hhi > 1500) return 'moderately concentrated';
  return 'well spread';
}

function healthSection(doc, { analysis, portfolioHealth, sections }) {
  sections.push('Health');
  doc.heading('Portfolio health');
  const score = analysis.health;
  if (score.score === null) {
    doc.paragraph('Nothing is held, so there is no score. Add holdings to the ledger and this section fills in.');
  } else {
    doc.kv('Composite score', `${score.score} / 100 - ${score.grade}`, { boldValue: true });
    doc.space(2);
    doc.table({
      columns: [{ label: 'Component', width: 30 }, { label: 'Score', width: 12, align: 'right' }, { label: 'What it measures', width: 58 }],
      rows: score.components.map((c) => [c.label, `${c.score}`, c.detail]),
    });
  }

  const failing = portfolioHealth.checks.filter((c) => c.verdict === 'risk' || c.verdict === 'watch');
  const counts = portfolioHealth.counts;
  doc.subheading(`${counts.risk} rule${counts.risk === 1 ? '' : 's'} failing, ${counts.watch} to watch, `
    + `${counts.good} clear, ${counts.unknown} waiting on data`);
  if (!failing.length) {
    doc.paragraph('Every rule the ledger can apply passes on the recorded data.');
    return;
  }
  doc.table({
    columns: [{ label: 'Verdict', width: 12 }, { label: 'Rule', width: 26 }, { label: 'Reading', width: 62 }],
    rows: failing.map((c) => [c.verdict === 'risk' ? 'address' : 'watch', c.label, c.detail]),
  });
  const remedies = failing.filter((c) => c.remedy).slice(0, 6);
  if (remedies.length) {
    doc.subheading('What to do first');
    remedies.forEach((c, i) => doc.text(`${i + 1}. ${c.label}: ${c.remedy}`, { size: 8.8, color: colors.INK }));
  }
}

function incomeSection(doc, { indiaTax, sections }) {
  sections.push('Income & tax');
  doc.heading('India income and tax');
  if (!indiaTax || !indiaTax.totals.holdingCount) {
    doc.paragraph('No Indian-source income rows were found, so there is nothing to accrue. Bank deposits, bonds, '
      + 'equity dividends and policy interest all feed this section.');
    return;
  }
  const fy = indiaTax.financialYear;
  const t = indiaTax.totals;
  doc.kv('Financial year', `${fy.label} (${fy.elapsedPct}% elapsed as at this report)`);
  doc.kv('Income accrued so far', rs(t.accruedYtdINR, { decimals: true }));
  doc.kv('Projected for the full year', rs(t.projectedFullFYINR, { decimals: true }), { boldValue: true });
  doc.kv('Taxable of that', rs(t.taxableProjectedINR, { decimals: true }));
  doc.kv('Exempt / taxed on receipt', `${rs(t.exemptProjectedINR)} exempt, ${rs(t.deferredProjectedINR)} deferred`);
  doc.kv('TDS deducted to date', rs(t.tdsYtdINR, { decimals: true }));
  doc.kv('TDS projected for the year', rs(t.tdsProjectedINR, { decimals: true }));

  if (indiaTax.bonds.count) {
    doc.subheading(`Bonds: ${indiaTax.bonds.count} ${indiaTax.bonds.count === 1 ? 'row' : 'rows'}`);
    doc.table({
      columns: [{ label: 'Bond', width: 32 }, { label: 'Issuer', width: 22 }, { label: 'Coupon', width: 12, align: 'right' },
        { label: 'Payable', width: 16, align: 'right' }, { label: 'TDS', width: 12, align: 'right' },
        { label: 'Net', width: 16, align: 'right' }],
      rows: indiaTax.bonds.rows.map((b) => [b.name, b.institution || '-', b.couponPct ? pct(b.couponPct) : '-',
        b.payableINR ? rs(b.payableINR, { decimals: true }) : '-',
        b.tdsINR ? `${rs(b.tdsINR, { decimals: true })} (${pct(b.tdsPct, 0)})` : 'none',
        b.netReceivableINR ? rs(b.netReceivableINR, { decimals: true }) : '-']),
    });
  }

  doc.subheading('Which regime you should file under');
  doc.table({
    columns: [{ label: 'Regime', width: 20 }, { label: 'Gross', width: 18, align: 'right' },
      { label: 'Taxable', width: 18, align: 'right' }, { label: 'Liability', width: 18, align: 'right' },
      { label: 'Effective', width: 14, align: 'right' }, { label: 'Verdict', width: 14 }],
    rows: indiaTax.regimes.map((r) => [r.label, rs(r.grossTotalINR), rs(r.taxableIncomeINR), rs(r.liabilityINR),
      pct(r.effectiveRatePct), r.key === indiaTax.preferred ? 'better' : '-']),
  });
  const settle = indiaTax.settlement?.find((s) => s.key === indiaTax.preferred);
  if (settle) {
    doc.paragraph(`On the ${settle.key === 'new' ? 'new' : 'old'} regime the year's liability is ${rs(settle.liabilityINR)} against `
      + `${rs(settle.tdsCreditedINR)} already credited as TDS, leaving ${rs(Math.abs(settle.balanceINR))} `
      + `${settle.balanceINR >= 0 ? 'still to pay' : 'recoverable'}.`);
  }
}

function goalsSection(doc, { goals, sections }) {
  sections.push('Goals');
  doc.heading('Goals and what they still need');
  if (!goals.length) {
    doc.paragraph('No goals recorded. Each goal on the Goals tab is measured against the holdings linked to it, '
      + 'inflation-indexed to its own date.');
    return;
  }
  doc.table({
    columns: [{ label: 'Goal', width: 24 }, { label: 'Target today', width: 16, align: 'right' },
      { label: 'At date', width: 16, align: 'right' }, { label: 'Projected', width: 16, align: 'right' },
      { label: 'Shortfall', width: 16, align: 'right' }, { label: 'Extra / month', width: 14, align: 'right' },
      { label: 'Status', width: 12 }],
    rows: goals.map((g) => [g.name, rs(g.targetTodayINR), rs(g.targetAtDateINR), rs(g.projectedINR),
      g.shortfallINR ? rs(g.shortfallINR) : '-', g.extraMonthlyINR ? rs(g.extraMonthlyINR) : '-', g.status]),
  });
  const short = goals.filter((g) => g.shortfallINR > 0);
  doc.paragraph(short.length
    ? `${short.length} of ${goals.length} ${goals.length === 1 ? 'goal is' : 'goals are'} short of target on the rates recorded, `
      + `by ${rs(short.reduce((a, g) => a + g.shortfallINR, 0))} in total in today's prices.`
    : `All ${goals.length} recorded ${goals.length === 1 ? 'goal is' : 'goals are'} projected to reach their target.`);
}

function retirementSection(doc, { plan, cash, summary, profile, settings, sections, warnings }) {
  sections.push('Retirement');
  doc.heading('Retirement and financial independence');
  if (!plan && !cash) {
    warnings.push('No retirement projection was supplied with this request.');
    doc.paragraph('The corpus projection is computed in the app rather than duplicated on the server, so a report '
      + 'generated outside the app carries the inputs below without the outcome. Generate it from the '
      + 'Generate PDF Report tab to include the projection.');
  }

  if (plan) {
    const corpus = plan.corpus || {};
    const base = plan.baseline || {};
    doc.kv('Retiring at', `${dash(plan.retireAge)}, planning the money to last to ${dash(plan.lifeAge)}`
      + `${plan.yearsToRetirement ? ` - ${plan.yearsToRetirement} year${plan.yearsToRetirement === 1 ? '' : 's'} of saving left` : ''}`);
    doc.kv('Corpus the plan needs', rs(corpus.requiredINR), { boldValue: true });
    doc.kv('Projected corpus at retirement', rs(base.balanceAtRetirementINR), {
      valueColor: (plan.gapINR || 0) > 0 ? colors.WARN : colors.ACCENT, boldValue: true });
    doc.kv('Progress to target', `${pct(plan.progressPct)} of the corpus needed`);
    if ((plan.gapINR || 0) > 0) {
      doc.kv('Gap', `${rs(plan.gapINR)} - ${rs(plan.gapTodayValueINR)} in today's rupees`);
      doc.kv('Closes with', `${rs(plan.additionalMonthlyTopUpINR)} a month more, escalating with salary`);
    } else {
      doc.kv('Gap', 'None on these assumptions');
    }
    if (base.runsOutAge) {
      doc.kv('Funds run out at', `age ${base.runsOutAge}${plan.lifeAge ? `, ${plan.lifeAge - base.runsOutAge} before the plan ends` : ''}`,
        { valueColor: colors.BAD, boldValue: true });
    }
    if (plan.financiallyFreeAge) doc.kv('Corpus reached at', `age ${plan.financiallyFreeAge}`);
    if (plan.liquidMonthsCover) doc.kv('Liquid cover at retirement spending', `${plan.liquidMonthsCover.toFixed(1)} months`);
    if (Array.isArray(plan.warnings) && plan.warnings.length) {
      doc.subheading('What the plan flags');
      plan.warnings.forEach((w) => doc.text(`- ${w.text || w}`, { size: 8.8, color: w.level === 'bad' ? colors.BAD : colors.INK }));
    }
  }

  if (cash) {
    doc.subheading('Cash flow and financial independence');
    doc.kv('Monthly income against committed outflow', `${rs(cash.monthlyIncomeINR)} in, ${rs(cash.monthlyCommittedINR)} committed, `
      + `${rs(cash.monthlyInvestedINR)} invested`);
    if (cash.investedRatePct !== null) doc.kv('Invested share of income', `${pct(cash.investedRatePct)} invested, ${pct(cash.savingsRatePct)} unallocated`);
    if (cash.leakINR) doc.kv('Cash neither spent nor invested', `${rs(cash.leakINR)} a month`);
    doc.kv('FIRE number at 25x committed spend', rs(cash.fireNumberINR));
    if (cash.fireProgressPct !== null) doc.kv('Progress to it', `${pct(cash.fireProgressPct)} of the FIRE number`);
    if (cash.fireAge) doc.kv('FIRE age on this path', `${cash.fireAge}${cash.yearsToFire !== null ? ` - ${cash.yearsToFire} year${cash.yearsToFire === 1 ? '' : 's'} away` : ''}`);
    doc.kv('Coast FIRE target', `${rs(cash.coastFireINR)} now reaches the FIRE number by the planned retirement age`);
    if (cash.emiBurdenPct !== null) doc.kv('Loan payments as a share of income', pct(cash.emiBurdenPct));
  }

  doc.subheading('Inputs behind these numbers');
  doc.kv('Monthly spending now', rs(profile.monthlyExpensesNowINR));
  doc.kv('Monthly spending in retirement', rs(profile.monthlyExpensesInRetirementINR));
  doc.kv('Monthly investable surplus', rs(profile.monthlyInvestableSurplusINR));
  doc.kv('Assumed returns', `${pct(settings.assumptions.preRetirementReturnPct, 0)} before retirement, `
    + `${pct(settings.assumptions.postRetirementReturnPct, 0)} after, inflation ${pct(settings.assumptions.inflationPct, 0)}`);
  doc.kv('Net worth today', rs(summary.netWorthINR));
}

function methodSection(doc, { state, sections, warnings }) {
  sections.push('Sources');
  doc.heading('How this document was produced');
  const { meta, rates, snapshots } = state;
  doc.paragraph(`Built on this machine by Wealth Ledger from ${meta.dataFile}. No portfolio figure was sent anywhere to `
    + 'produce it, and every number on these pages is the same one the app shows on screen.');
  doc.space(4);
  doc.subheading('Valuation sources and their vintage');
  const rows = Object.entries(rates).map(([code, r]) => [`${code} to INR`, r.rate ? r.rate.toFixed(4) : '-', r.source, dash(r.asOf)]);
  const metal = meta.metalRates;
  if (metal) {
    const stamp = (metal.fetchedAt || '').slice(0, 10);
    for (const key of (meta.metalCard ? meta.metalCard.keys : [])) {
      rows.push([`Bullion: ${key}`, metal[key] ? rs(metal[key], { decimals: true }) : '-', 'per gram, scraped', dash(stamp)]);
    }
  }
  doc.table({
    columns: [{ label: 'Rate', width: 26 }, { label: 'Value', width: 20, align: 'right' }, { label: 'Source', width: 26 }, { label: 'Dated', width: 20 }],
    rows,
  });
  doc.subheading('What this report cannot show');
  doc.text('- Values are as at the dates above. A row with no quote date is whatever was last typed into it.', { size: 8.8 });
  doc.text('- Realised and unrealised returns only cover positions with a purchase cost recorded: '
    + `${pct(state.analysis.health.costBasisCoveragePct)} of assets.`, { size: 8.8 });
  if (meta.unconverted.length) {
    doc.text(`- ${meta.unconverted.length} ${meta.unconverted.length === 1 ? 'row is' : 'rows are'} held in a currency the app has no rate for `
      + `(${meta.unconverted.map((u) => u.currency).join(', ')}) and are excluded from net worth.`, { size: 8.8, color: colors.BAD });
  }
  doc.text('- The tax figures are an accrual estimate on the rates recorded in Settings, not a computation of a return.', { size: 8.8 });
  if (snapshots.length) {
    doc.subheading('Net worth history');
    doc.table({
      columns: [{ label: 'Month', width: 22 }, { label: 'Gross assets', width: 26, align: 'right' },
        { label: 'Liabilities', width: 24, align: 'right' }, { label: 'Net worth', width: 26, align: 'right' }],
      rows: snapshots.slice(-18).map((s) => [s.period, rs(s.totalAssetsINR), rs(s.totalLiabilitiesINR), rs(s.netWorthINR)]),
    });
  }
  if (warnings.length) {
    doc.note(`This document is a reading of the ledger, not a valuation, a tax opinion or an investment recommendation. `
      + `${warnings.join(' ')}`);
  } else {
    doc.note('This document is a reading of the ledger, not a valuation, a tax opinion or an investment recommendation.');
  }
}

module.exports = { buildReport, fileNameFor, rs, pct, crora };
