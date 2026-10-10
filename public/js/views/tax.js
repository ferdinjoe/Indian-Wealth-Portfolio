import { money, shortINR, escapeHtml, titleCase } from '../format.js';
import { field, input, select, toast } from '../ui.js';
import { api } from '../api.js';

const TREATMENT_LABEL = {
  taxable: 'Taxable',
  exempt: 'Exempt',
  deferred: 'Deferred',
};

const BOND_KIND_LABEL = {
  government: 'Central G-Sec',
  state: 'State SDL',
  corporate: 'Corporate NCD',
  unlisted: 'No ISIN',
};

// [month index, day, share of the year's tax due by then] - Indian advance tax.
const INSTALMENTS = [[5, 15, 0.15, '15 Jun'], [8, 15, 0.45, '15 Sep'], [11, 15, 0.75, '15 Dec'], [2, 15, 1, '15 Mar']];

export function render(root, ctx) {
  const t = ctx.data.indiaTax;
  if (!t) {
    root.innerHTML = '<div class="card"><p class="card-note">The running server has no income engine yet — restart the app to load it.</p></div>';
    return;
  }
  const fy = t.financialYear;
  const best = t.settlement.find((s) => s.key === t.preferred) || t.settlement[0];

  root.innerHTML = `
    <div class="grid">
      ${hero(t, best)}
      ${t.lines.length ? incomeTable(t) : emptyState(ctx)}
      ${bondsCard(t)}
      <div class="grid grid-2">${t.regimes.map((r) => regimeCard(r, t)).join('')}</div>
      ${settlementCard(t, best)}
      ${assumptionsCard(t, ctx.data.settings.tax)}
    </div>`;

  wireForm(root, ctx);
}

function hero(t, best) {
  const payable = best.balanceINR > 0;
  return `<div class="hero">
    <div>
      <span class="kpi-label">${escapeHtml(fyLabel(t))}</span>
      <div class="hero-figure">${shortINR(t.totals.accruedYtdINR)}</div>
      <div class="hero-eta">earned in ${t.financialYear.elapsedDays} of ${t.financialYear.totalDays} days run · ${money(t.totals.projectedFullFYINR)} a full year at these rates</div>
    </div>
    <div class="hero-stats">
      ${stat('Taxable in India', shortINR(t.totals.taxableProjectedINR), '', `${t.totals.holdingCount} Indian earning ${t.totals.holdingCount === 1 ? 'row' : 'rows'}`)}
      ${stat('Exempt / deferred', shortINR(t.totals.exemptProjectedINR + t.totals.deferredProjectedINR), '', t.totals.exemptProjectedINR ? 'NRE & FCNR interest is tax-free' : 'nothing outside the slab base')}
      ${stat('TDS expected', shortINR(t.totals.tdsProjectedINR), 'is-gold', 'deducted before the money reaches you')}
      ${stat(payable ? 'Balance to pay' : 'Refund due', shortINR(Math.abs(best.balanceINR)), payable ? 'is-red' : 'is-accent', `${labelOf(t.preferred)} regime`)}
    </div>
  </div>`;
}

function fyLabel(t) {
  return `${t.financialYear.label} income · ${t.financialYear.startISO} to ${t.financialYear.endISO}`;
}

function stat(label, value, cls, sub) {
  return `<div class="hero-stat"><span class="kpi-label">${label}</span><div class="kpi-value ${cls}">${value}</div><div class="kpi-sub">${sub}</div></div>`;
}

function labelOf(key) {
  return key === 'new' ? 'New' : 'Old';
}

function incomeTable(t) {
  const rows = t.lines.map((l) => `<tr>
    <td><strong>${escapeHtml(l.name || '—')}</strong><div class="muted" style="font-size:11.5px">${escapeHtml(titleCase(l.category))}${l.institution ? ` · ${escapeHtml(l.institution)}` : ''}</div></td>
    <td class="num">${l.ratePct === null ? '—' : `${l.ratePct}%`}<div class="muted" style="font-size:11px">${l.kind === 'dividend' ? 'dividend yield' : 'p.a.'}</div></td>
    <td class="num">${l.incomeINR ? money(l.incomeINR.ytd) : '—'}</td>
    <td class="num"><strong>${l.incomeINR ? money(l.incomeINR.full) : '—'}</strong></td>
    <td><span class="tag ${l.treatment === 'taxable' ? '' : l.treatment === 'exempt' ? 'is-ok' : 'is-warn'}">${TREATMENT_LABEL[l.treatment]}</span></td>
    <td class="num">${l.tdsPct ? `${l.tdsPct}%` : '—'}<div class="muted" style="font-size:11.5px;white-space:normal">${escapeHtml(l.tdsBasis || '')}</div></td>
    <td class="num ${l.tdsINR && l.tdsINR.full ? 'neg' : ''}">${l.tdsINR && l.tdsINR.full ? money(l.tdsINR.full) : '—'}</td>
  </tr>`).join('');
  return `<div class="card span-2">
    <div class="card-head"><span class="card-title">What each Indian holding earns this year</span><span class="card-note">interest accrues on the value in view; deposits use their own compounding curve</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Holding</th><th class="num">Rate</th><th class="num">To date</th><th class="num">Full year</th><th>Taxed as</th><th class="num">TDS</th><th class="num">TDS amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${t.unconverted.length ? `<p class="card-note" style="margin-top:10px">${t.unconverted.length} row(s) could not be converted to rupees, so their income is missing from the totals.</p>` : ''}
    ${t.depositTds.depositTdsApplied ? '' : `<p class="card-note" style="margin-top:10px">Bank and deposit interest of ${money(t.depositTds.depositInterestINR)} is under the ${money(t.depositTds.depositTdsThresholdINR)} section 194A limit, so no TDS is expected on it — the tax is still owed at your slab.</p>`}
  </div>`;
}

function bondsCard(t) {
  const b = t.bonds;
  if (!b.count) {
    return `<div class="card span-2"><div class="card-head"><span class="card-title">Bonds — amount payable and TDS</span></div>
      <p class="card-note">No bond with a coupon rate is recorded. Give a bond row its coupon in percent and its ISIN in the price-symbol box, and the year's payable amount and the tax withheld on it appear here.</p></div>`;
  }
  const rows = b.rows.map((r) => `<tr>
    <td><strong>${escapeHtml(r.name || '—')}</strong>${r.institution ? `<div class="muted" style="font-size:11.5px">${escapeHtml(r.institution)}</div>` : ''}</td>
    <td><span class="tag ${r.kind === 'corporate' ? 'is-warn' : r.kind === 'unlisted' ? 'is-warn' : 'is-ok'}">${BOND_KIND_LABEL[r.kind]}</span></td>
    <td class="num">${r.couponPct === null ? '—' : `${r.couponPct}%`}</td>
    <td class="num">${r.valueINR === null ? '—' : money(r.valueINR)}</td>
    <td class="num"><strong>${r.payableINR === null ? '—' : money(r.payableINR)}</strong><div class="muted" style="font-size:11px">${r.payableAccruedINR === null ? '' : `${money(r.payableAccruedINR)} so far`}</div></td>
    <td class="num ${r.tdsINR ? 'neg' : ''}">${r.tdsINR ? `${money(r.tdsINR)} <span class="muted" style="font-size:11px">@ ${r.tdsPct}%</span>` : '—'}</td>
    <td class="num">${r.netReceivableINR === null ? '—' : money(r.netReceivableINR)}</td>
  </tr>`).join('');
  return `<div class="card span-2">
    <div class="card-head"><span class="card-title">Bonds — amount payable and TDS taken</span><span class="card-note">coupon for ${escapeHtml(t.financialYear.label)} on the ${b.count} ${b.count === 1 ? 'issue' : 'issues'} held</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Bond</th><th>ISIN family</th><th class="num">Coupon</th><th class="num">Value</th><th class="num">Payable this FY</th><th class="num">TDS</th><th class="num">Net to you</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="4"><strong>Totals</strong></td><td class="num"><strong>${money(b.payableProjectedINR)}</strong></td><td class="num neg"><strong>${money(b.tdsProjectedINR)}</strong></td><td class="num"><strong>${money(b.payableProjectedINR - b.tdsProjectedINR)}</strong></td></tr></tfoot>
    </table></div>
    <p class="card-note" style="margin-top:10px">Interest on central and state securities carries no TDS under section 193 but is still taxed at your slab. A corporate NCD has TDS deducted at source; the amount net of it is what reaches your account.</p>
  </div>`;
}

function regimeCard(r, t) {
  const isBest = r.key === t.preferred;
  const d = r.deductions;
  const line = (label, value, cls = '') => `<div class="stat-line"><span>${label}</span><strong class="${cls}">${value}</strong></div>`;
  return `<div class="card${isBest ? ' is-flagged' : ''}">
    <div class="card-head">
      <span class="card-title">${r.label}${isBest ? ' <span class="tag is-ok">cheaper</span>' : ''}</span>
      <span class="card-note">${escapeHtml(r.note)}</span>
    </div>
    <div class="stat-list">
      ${line('Salary from your profile', money(r.salaryGrossINR))}
      ${line('Indian investment income', money(r.investmentIncomeINR))}
      ${line('Other taxable income', money(r.otherIncomeINR))}
      ${line('Standard deduction', `- ${money(d.standardDeductionINR)}`, 'is-accent')}
      ${d.section80ttbINR ? line('80TTB on senior interest', `- ${money(d.section80ttbINR)}`, 'is-accent') : ''}
      ${d.claimedINR ? line('Your 80C / 80D / HRA claims', `- ${money(d.claimedINR)}`, 'is-accent') : ''}
      ${line('Taxable income', money(r.taxableIncomeINR))}
      ${line('Slab tax', money(r.slabTaxINR))}
      ${r.rebateINR ? line('Rebate 87A', `- ${money(r.rebateINR)}`, 'is-accent') : ''}
      ${r.surchargeINR ? line(`Surcharge @ ${r.surchargePct}%`, money(r.surchargeINR)) : ''}
      ${line('Health & education cess', money(r.cessINR))}
    </div>
    <div class="stat-line" style="margin-top:10px;border-top:1px solid var(--line);padding-top:12px">
      <span><strong>Liability for ${escapeHtml(t.financialYear.label)}</strong></span>
      <strong class="${r.liabilityINR ? 'is-red' : 'is-accent'}" style="font-size:17px">${money(r.liabilityINR)}</strong>
    </div>
    <p class="card-note" style="margin-top:8px">Effective rate on the total: ${r.effectiveRatePct}%${isBest && t.savingFromBetterRegimeINR ? ` · ${money(t.savingFromBetterRegimeINR)} less than the ${labelOf(r.key === 'new' ? 'old' : 'new')} regime` : ''}</p>
  </div>`;
}

function settlementCard(t, best) {
  const payable = best.balanceINR > 0;
  return `<div class="card span-2">
    <div class="card-head"><span class="card-title">Settling up</span><span class="card-note">under the ${t.regimes.map((r) => `${r.label} at ${money(r.liabilityINR)}`).join(' · ')}</span></div>
    <div class="stat-list">
      ${settleLine('Tax for the year', money(best.liabilityINR))}
      ${settleLine('TDS on investment income', `- ${money(t.totals.tdsProjectedINR)}`, 'is-accent')}
      ${t.salaryTdsCreditedINR ? settleLine('TDS already on salary', `- ${money(t.salaryTdsCreditedINR)}`, 'is-accent') : ''}
      ${settleLine(payable ? 'Still to pay' : 'Refund due', `<strong class="${payable ? 'is-red' : 'is-accent'}">${money(Math.abs(best.balanceINR))}</strong>`)}
    </div>
    ${advanceNote(t, best)}
  </div>`;
}

function settleLine(label, value, cls = '') {
  return `<div class="stat-line"><span>${label}</span><strong class="${cls}">${value}</strong></div>`;
}

// Advance tax is owed once more than ₹10,000 remains after TDS, in four
// instalments — showing which ones the calendar has already passed is the part
// people discover too late.
function advanceNote(t, best) {
  if (best.balanceINR <= 10_000) {
    return `<p class="card-note" style="margin-top:10px">Under ${money(10_000)} still outstanding after TDS, so no advance tax instalments fall due — settle the balance with the return.</p>`;
  }
  const now = Date.now();
  const startYear = t.financialYear.startYear;
  const credited = best.tdsCreditedINR;
  const cells = INSTALMENTS.map(([month, day, share, name]) => {
    const due = Date.UTC(month >= 3 ? startYear : startYear + 1, month, day);
    const required = Math.max(0, best.liabilityINR * share - credited);
    const past = due < now;
    return `<div class="stat-line"><span>${name} ${new Date(due).getUTCFullYear()} · ${Math.round(share * 100)}% of the tax${past ? ' <span class="tag is-hold">passed</span>' : ''}</span><strong class="${past && required > 0 ? 'is-red' : ''}">${money(required)}</strong></div>`;
  }).join('');
  return `<div class="section-label" style="margin-top:14px">Advance tax instalments still to fund</div>
    <div class="stat-list">${cells}</div>
    <p class="card-note" style="margin-top:10px">Each instalment shown after its date, if unpaid, draws interest under sections 234B and 234C. The TDS already credited counts toward every instalment.</p>`;
}

const TAX_FIELDS = [
  ['bankInterestTdsPct', 'Bank & deposit interest TDS %', 'section 194A, once a year of Indian deposit interest crosses the limit.'],
  ['bondInterestTdsPct', 'Bond coupon TDS %', 'corporate NCD interest.'],
  ['govtBondTdsPct', 'G-Sec / SDL coupon TDS %', 'zero for government and state securities.'],
  ['dividendTdsPct', 'Dividend TDS %', 'withheld on Indian equity dividends for a non-resident.'],
  ['otherTaxableIncomeINR', 'Other Indian taxable income ₹', 'rent, capital gains, anything the ledger does not know about.'],
  ['salaryTdsCreditedINR', 'TDS already on salary ₹', 'from Form 16 — credited against the liability.'],
  ['oldRegimeDeductionsINR', 'Old-regime claims ₹', '80C, 80D, HRA, 80TTA you would actually claim.'],
];

function assumptionsCard(t, tax) {
  return `<div class="card span-2">
    <div class="card-head"><span class="card-title">Tax assumptions</span><span class="card-note">saved to the data file · only Indian rows feed this</span></div>
    <form id="tax-form">
      <div class="field-set is-dense">
        ${TAX_FIELDS.map(([key, label, hint]) => field(label, input(key, tax[key], 'number', '0'), hint)).join('')}
        ${field('Senior citizen', select('seniorCitizen', [{ value: 'auto', label: 'auto (from date of birth)' }, { value: 'yes', label: 'yes, 60 to 79' }, { value: 'no', label: 'no' }], tax.seniorCitizen === null ? 'auto' : tax.seniorCitizen ? 'yes' : 'no'), `age at year end: ${t.residence.ageAtYearEnd === null ? 'unknown - a date of birth in Profile decides it' : t.residence.ageAtYearEnd}`)}
      </div>
      <button class="btn btn-primary" type="submit">Recalculate tax</button>
    </form>
    <div class="callout" style="margin-top:16px">
      <p style="font-size:12.5px;color:var(--text-dim)">Scope: ${escapeHtml(t.residence.scope)}. Salary is counted from your Profile at ${money(t.residence.salaryProjectedINR)} a year — set it to zero there if your salary is taxed outside India. Senior status: ${escapeHtml(t.residence.seniorSource)}.</p>
      ${t.caveats.map((c) => `<p style="font-size:12.5px;color:var(--text-dim);margin-top:6px">· ${escapeHtml(c)}</p>`).join('')}
    </div>
  </div>`;
}

function emptyState(ctx) {
  return `<div class="card span-2"><div class="card-head"><span class="card-title">No Indian income to accrue yet</span></div>
    <p class="card-note">This page reads Indian rows only, and needs a rate on each: a savings or deposit interest percent, a bond coupon percent, or a dividend yield on an Indian share holding. The ledger holds ${ctx.data.holdings.filter((h) => (h.country || '').toUpperCase() === 'IN').length} Indian row(s), none of them carrying a rate to accrue on.</p></div>`;
}

function wireForm(root, ctx) {
  const form = root.querySelector('#tax-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const patch = {};
    for (const [key] of TAX_FIELDS) patch[key] = Number(values[key]) || 0;
    patch.seniorCitizen = values.seniorCitizen === 'auto' ? null : values.seniorCitizen === 'yes';
    try {
      await api.saveTax(patch);
      await ctx.reload();
      toast('Tax estimate recalculated.');
    } catch (err) {
      toast(err.message, 'bad', 5000);
    }
  });
}
