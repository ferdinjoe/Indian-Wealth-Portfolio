import { api } from '../api.js';
import { money, shortINR, pct, escapeHtml, titleCase } from '../format.js';
import { openModal, field, input, readForm } from '../ui.js';

const STATUS = {
  'on-track': { label: 'On track', cls: 'is-ok' },
  close: { label: 'Nearly there', cls: 'is-ok' },
  behind: { label: 'Behind', cls: 'is-warn' },
  'at-risk': { label: 'At risk', cls: 'is-bad' },
  urgent: { label: 'Due now, short', cls: 'is-bad' },
  funded: { label: 'Funded', cls: 'is-ok' },
  'no-target': { label: 'No amount set', cls: 'is-hold' },
};

export function render(root, ctx) {
  const goals = ctx.data.goals;
  const totalTarget = goals.reduce((a, g) => a + (g.targetAtDateINR || 0), 0);
  const totalProjected = goals.reduce((a, g) => a + (g.projectedINR || 0), 0);
  const extraMonthly = goals.reduce((a, g) => a + (g.extraMonthlyINR || 0), 0);
  const short = goals.filter((g) => g.shortfallINR > 0).length;

  root.innerHTML = `
    <div class="hero" style="margin-bottom:16px">
      <div>
        <span class="kpi-label">What your goals need on their dates</span>
        <div class="hero-figure" style="color:${totalTarget && totalProjected < totalTarget ? 'var(--gold)' : 'var(--accent)'}">${money(totalTarget)}</div>
        <div class="hero-eta">Inflation-adjusted across ${goals.length} goal${goals.length === 1 ? '' : 's'} · linked assets are projected to reach ${shortINR(totalProjected)}${goals.length ? ` (${pct(totalTarget ? totalProjected / totalTarget * 100 : 0, 0)} of the need)` : ''}</div>
      </div>
      <div class="hero-stats">
        <div class="hero-stat"><span class="kpi-label">Short of target</span><div class="kpi-value ${short ? 'is-gold' : 'is-accent'}">${short}</div><div class="kpi-sub">goal(s) needing more</div></div>
        <div class="hero-stat"><span class="kpi-label">Extra to invest</span><div class="kpi-value ${extraMonthly ? 'is-blue' : ''}">${extraMonthly ? `${shortINR(extraMonthly)}/mo` : '—'}</div><div class="kpi-sub">across all shortfalls</div></div>
        <div class="hero-stat"><span class="kpi-label">Tracked pot</span><div class="kpi-value">${shortINR(goals.reduce((a, g) => a + (g.currentINR || 0), 0))}</div><div class="kpi-sub">in linked holdings</div></div>
      </div>
    </div>

    <div class="toolbar">
      <span class="card-note">A goal measures the holdings you earmark for it against what that goal will cost on the day it falls due.</span>
      <span class="spacer"></span>
      <button class="btn btn-primary" id="add-goal">+ Add goal</button>
    </div>

    ${goals.length ? `<div class="grid grid-2">${goals.map((g) => goalCard(g, ctx)).join('')}</div>`
      : `<div class="card empty"><h3>No goals yet</h3>
         <p>Education, a house, a car, a travel fund — give each a target amount and date, link the holdings that fund it, and the ledger tracks whether that money gets there in time.</p>
         <p style="margin-top:18px"><button class="btn btn-primary" id="add-goal-empty">Add your first goal</button></p></div>`}`;

  root.querySelectorAll('#add-goal, #add-goal-empty').forEach((b) => { b.onclick = () => openForm(null, ctx, root); });
  root.querySelectorAll('[data-edit-goal]').forEach((b) => {
    b.onclick = () => openForm(ctx.data.goals.find((g) => g.id === b.dataset.editGoal), ctx, root);
  });
  root.querySelectorAll('[data-del-goal]').forEach((b) => {
    b.onclick = async () => {
      const g = ctx.data.goals.find((x) => x.id === b.dataset.delGoal);
      if (!confirm(`Delete the goal “${g.name}”? The linked holdings themselves are untouched.`)) return;
      await ctx.mutate(() => api.deleteGoal(g.id), `Removed ${g.name}`).catch(() => {});
      render(root, ctx);
    };
  });
}

function goalCard(g, ctx) {
  const status = STATUS[g.status] || STATUS['no-target'];
  const progress = Math.max(0, Math.min(100, g.progressPct || 0));
  const barColor = g.status === 'on-track' || g.status === 'funded' ? 'var(--accent)' : g.status === 'close' ? 'var(--blue)' : g.status === 'behind' ? 'var(--gold)' : 'var(--red)';
  const links = g.linked.length
    ? g.linked.map((l) => `<span class="tag" title="${escapeHtml(money(l.valueINR || 0))}">${escapeHtml(l.name)}</span>`).join('')
    : '<span class="tag is-hold">nothing linked</span>';

  return `<div class="card goal-card">
    <div class="goal-head">
      <div>
        <div class="goal-name">${escapeHtml(g.name)}</div>
        <div class="goal-purpose">${escapeHtml(g.purpose || '')}${g.purpose ? ' · ' : ''}${whenText(g)}</div>
      </div>
      <span class="tag ${status.cls}">${status.label}</span>
    </div>

    <div class="progress-row">
      <span>Projected ${shortINR(g.projectedINR)} of ${shortINR(g.targetAtDateINR)} needed</span>
      <span>${pct(g.progressPct, 0)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${progress}%;background:${barColor}"></span></span>
    </div>

    <div class="goal-figures">
      <div><span class="kpi-label">Linked today</span><div class="kpi-value">${shortINR(g.currentINR)}</div></div>
      <div><span class="kpi-label">Target now</span><div class="kpi-value">${shortINR(g.targetTodayINR)}</div></div>
      <div><span class="kpi-label">Shortfall</span><div class="kpi-value ${g.shortfallINR ? 'is-gold' : 'is-accent'}">${g.shortfallINR ? shortINR(g.shortfallINR) : 'None'}</div></div>
      <div><span class="kpi-label">Per month</span><div class="kpi-value ${g.extraMonthlyINR ? 'is-blue' : ''}">${g.monthlyContributionINR ? shortINR(g.monthlyContributionINR) : '—'}${g.extraMonthlyINR ? `<span class="muted" style="font-size:12px"> +${shortINR(g.extraMonthlyINR)}</span>` : ''}</div></div>
    </div>

    ${g.shortfallINR
      ? `<div class="callout ${g.status === 'at-risk' || g.status === 'urgent' ? 'is-bad' : 'is-warn'}">Investing ${shortINR(g.neededMonthlyINR)} a month for the next ${yearsText(g)} at ${pct(g.expectedReturnPct, 1)} reaches the goal — that is ${g.extraMonthlyINR ? `${shortINR(g.extraMonthlyINR)} more than you plan now` : 'what you already planned'}.</div>`
      : `<div class="callout">Already funded: ${shortINR(g.projectedINR)} projected against ${shortINR(g.targetAtDateINR)} needed${g.monthlyContributionINR ? ` on ${shortINR(g.monthlyContributionINR)}/mo` : ''}.</div>`}

    <div class="goal-links">${links}${g.missingLinkCount ? `<span class="tag is-warn" title="These holdings were deleted since the goal was linked">${g.missingLinkCount} link lost</span>` : ''}</div>

    <div class="stat-chips">
      <span class="stat-chip">Return <strong>${pct(g.expectedReturnPct, 1)}</strong></span>
      <span class="stat-chip">Inflation <strong>${pct(g.inflationPct, 1)}</strong></span>
      <span class="stat-chip">Horizon <strong>${yearsText(g)}</strong></span>
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-ghost btn-sm" data-edit-goal="${g.id}">Edit</button>
      <button class="btn btn-danger btn-sm" data-del-goal="${g.id}">Delete</button>
    </div>
    ${g.notes ? `<p class="card-note">${escapeHtml(g.notes)}</p>` : ''}
  </div>`;
}

function whenText(g) {
  if (g.targetDate) return `due ${g.targetDate}`;
  return `due in ${yearsText(g)}`;
}

function yearsText(g) {
  const y = Number(g.years) || 0;
  if (y < 1) return `${Math.round(y * 12)} months`;
  return `${y.toFixed(y < 10 ? 1 : 0)} years`;
}

function formHtml(goal, ctx) {
  const rec = goal || {};
  const linked = new Set(rec.linkedHoldingIds || []);
  const assets = ctx.data.holdings.filter((h) => h.category !== 'liability');
  const byCat = new Map();
  for (const h of assets) {
    if (!byCat.has(h.category)) byCat.set(h.category, []);
    byCat.get(h.category).push(h);
  }
  const labels = ctx.data.meta.categoryLabels;

  const picker = [...byCat.entries()].map(([cat, list]) => `
    <div class="section-label">${escapeHtml(labels[cat] || titleCase(cat))}</div>
    ${list.sort((a, b) => (b.valueINR || 0) - (a.valueINR || 0)).map((h) => `
      <label class="pick"><input type="checkbox" name="linkedHoldingIds" value="${h.id}"${linked.has(h.id) ? ' checked' : ''}>
        <span>${escapeHtml(h.name)}</span><span class="pick-amt">${shortINR(h.valueINR || 0)}</span></label>`).join('')}
  `).join('');

  return `
    <div class="field-row">
      ${field('Goal name *', input('name', rec.name, 'text', 'e.g. Child higher education'))}
      ${field('Purpose', input('purpose', rec.purpose, 'text', 'one line on what it is for'))}
    </div>
    <div class="field-row">
      ${field('Target amount ₹ (today’s prices) *', input('targetAmountINR', rec.targetAmountINR ?? '', 'number'), 'The cost as you would pay it now')}
      ${field('Needed by', input('targetDate', rec.targetDate ?? '', 'date'), 'Left blank, the horizon below is used')}
    </div>
    <div class="field-row">
      ${field('Horizon in years', input('horizonYears', rec.horizonYears ?? '', 'number'), 'Only read when no date is given')}
      ${field('Invested per month ₹', input('monthlyContributionINR', rec.monthlyContributionINR ?? '', 'number'), 'New money aimed only at this goal')}
    </div>
    <div class="field-row">
      ${field('Expected return % p.a.', input('expectedReturnPct', rec.expectedReturnPct ?? 11, 'number'))}
      ${field('Goal inflation % p.a.', input('inflationPct', rec.inflationPct ?? 6, 'number'), 'Escalates the target to its due date')}
    </div>
    <p class="card-note">Education inflates closer to 8–10% in India; a domestic trip closer to 5%. The higher you set it, the larger the corpus the goal will demand.</p>

    <div class="section-label">Holdings earmarked for this goal</div>
    <div class="pick-list">${picker || '<p class="card-note">Add holdings first — a goal with nothing linked starts from zero.</p>'}</div>

    ${field('Notes', `<textarea name="notes" placeholder="Assumptions, who it is for, what to revisit…">${escapeHtml(rec.notes || '')}</textarea>`)}
  `;
}

function openForm(goal, ctx, root) {
  openModal({
    title: goal ? `Edit goal — ${goal.name}` : 'Add goal',
    body: formHtml(goal, ctx),
    hint: goal ? `Currently projected at ${shortINR(goal.projectedINR)}` : 'Targets are inflation-indexed to the date you set',
    saveLabel: goal ? 'Save goal' : 'Add goal',
    onSave: async (body) => {
      const form = readForm(body);
      if (!String(form.name || '').trim()) throw new Error('Goal name is required.');
      if (!(Number(form.targetAmountINR) > 0)) throw new Error('Set a target amount above zero — that is what progress is measured against.');
      const payload = {
        ...form,
        targetAmountINR: Number(form.targetAmountINR),
        monthlyContributionINR: Number(form.monthlyContributionINR) || 0,
        expectedReturnPct: form.expectedReturnPct === null ? 11 : Number(form.expectedReturnPct),
        inflationPct: form.inflationPct === null ? 6 : Number(form.inflationPct),
      };
      if (goal) await ctx.mutate(() => api.updateGoal(goal.id, payload), `Updated ${payload.name}`);
      else await ctx.mutate(() => api.createGoal(payload), `Added ${payload.name}`);
      render(root, ctx);
    },
  });
}
