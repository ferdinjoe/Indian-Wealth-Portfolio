import { escapeHtml, ageFrom, countryLabel, money, shortINR } from '../format.js';
import { api } from '../api.js';
import { field, input, select, toast } from '../ui.js';

const COUNTRIES = ['IN', 'TH', 'SG', 'US', 'AE', 'GB', 'AU', 'CA', 'CH', 'JP', 'MY', 'HK'];
const RISK = [
  { value: 'conservative', label: 'Conservative — capital protection first' },
  { value: 'moderate', label: 'Moderate — balanced growth and safety' },
  { value: 'balanced-growth', label: 'Balanced growth — mostly equities' },
  { value: 'aggressive', label: 'Aggressive — heavy equity and alternatives' },
];

const TEXT_FIELDS = [
  ['salutation', 'Salutation'],
  ['fullName', 'Full name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['maritalStatus', 'Marital status'],
];

const MONEY_FIELDS = [
  ['monthlyExpensesNowINR', 'Current monthly spending ₹'],
  ['monthlyIncomeINR', 'Monthly income (take-home) ₹'],
  ['monthlyEmiINR', 'Loan EMIs per month ₹'],
];

export function render(root, ctx) {
  const p = ctx.data.profile;
  const age = ageFrom(p.dateOfBirth);
  const yearsToRetire = age !== null ? (p.plannedRetirementAge || 60) - age : null;

  root.innerHTML = `
    <div class="grid grid-2">
      <div class="card span-2" style="display:flex;gap:34px;flex-wrap:wrap;align-items:center">
        <div><span class="kpi-label">Age</span><div class="kpi-value ${age === null ? '' : 'is-accent'}">${age === null ? 'not set' : `${age} years`}</div>
          <div class="kpi-sub">${age === null ? 'Add a date of birth below' : `born ${escapeHtml(p.dateOfBirth)}`}</div></div>
        <div><span class="kpi-label">Time to retirement</span><div class="kpi-value is-blue">${yearsToRetire === null ? '—' : yearsToRetire > 0 ? `${yearsToRetire} years` : 'retired'}</div>
          <div class="kpi-sub">target age ${p.plannedRetirementAge || 60}</div></div>
        <div><span class="kpi-label">Planning horizon</span><div class="kpi-value">${p.lifeExpectancy ? `${(p.lifeExpectancy - (p.plannedRetirementAge || 60))} yrs` : '—'}</div>
          <div class="kpi-sub">of funded drawdown to age ${p.lifeExpectancy || 90}</div></div>
        <div><span class="kpi-label">Net worth</span><div class="kpi-value is-gold">${shortINR(ctx.data.summary.netWorthINR)}</div>
          <div class="kpi-sub">${money(ctx.data.summary.netWorthINR)}</div></div>
      </div>

      <div class="card span-2">
        <form id="profile-form">
          <div class="section-label">Identity</div>
          <div class="field-set">
            ${TEXT_FIELDS.map(([k, label]) => field(label, input(k, p[k], k === 'email' ? 'email' : 'text'))).join('')}
            ${field('Date of birth *', input('dateOfBirth', p.dateOfBirth, 'date'), 'Drives every age-based projection')}
            ${field('Nationality', input('nationality', p.nationality))}
          </div>

          <div class="section-label">Residence &amp; family</div>
          <div class="field-set">
            ${field('Country of residence', select('residenceCountry', COUNTRIES.map((c) => ({ value: c, label: countryLabel(c) })), p.residenceCountry))}
            ${field('Dependants', input('dependants', p.dependants, 'number'))}
            ${field('Risk profile', select('riskProfile', RISK, p.riskProfile))}
          </div>

          <div class="section-label">Retirement inputs</div>
          <div class="field-set">
            ${field('Planned retirement age', input('plannedRetirementAge', p.plannedRetirementAge, 'number'))}
            ${field('Plan to age (life expectancy)', input('lifeExpectancy', p.lifeExpectancy, 'number'))}
            ${MONEY_FIELDS.map(([k, label]) => field(label, input(k, p[k], 'number'), k === 'monthlyEmiINR' ? 'Add on top of spending — EMIs are excluded from the spending figure above' : '')).join('')}
            ${field('Investable surplus per month ₹', input('monthlyInvestableSurplusINR', p.monthlyInvestableSurplusINR, 'number'), 'What you actually put to work each month')}
            ${field('Monthly spending in retirement ₹', input('monthlyExpensesInRetirementINR', p.monthlyExpensesInRetirementINR, 'number'), "In today's prices — the model inflates it")}
          </div>

          <div class="section-label">Notes</div>
          ${field('Anything the ledger should remember', `<textarea name="notes" placeholder="Estate plans, dependants' education, relocation intent…">${escapeHtml(p.notes || '')}</textarea>`)}

          <div style="display:flex;gap:10px;margin-top:18px;align-items:center">
            <button class="btn btn-primary" type="submit">Save profile</button>
            <span class="card-note">Writes to data/wealth-data.json</span>
          </div>
        </form>
      </div>
    </div>`;

  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const patch = Object.fromEntries(form.entries());
    for (const k of ['dependants', 'plannedRetirementAge', 'lifeExpectancy', 'monthlyExpensesNowINR', 'monthlyIncomeINR', 'monthlyEmiINR', 'monthlyInvestableSurplusINR', 'monthlyExpensesInRetirementINR']) {
      patch[k] = Number(patch[k]) || 0;
    }
    try {
      await api.saveProfile(patch);
      await ctx.reload();
      toast('Profile saved.');
    } catch (err) {
      toast(err.message, 'bad', 5000);
    }
  });
}
