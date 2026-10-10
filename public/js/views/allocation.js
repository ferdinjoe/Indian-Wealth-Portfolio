import { api } from '../api.js';
import { money, shortINR, pct, escapeHtml, titleCase } from '../format.js';
import { doughnut, groupedBar, PALETTE } from '../charts.js';
import { field, input, readForm } from '../ui.js';

export function render(root, ctx) {
  const { analysis, holdings, meta } = ctx.data;
  const { allocation, riskMix } = analysis;

  if (!holdings.length) {
    root.innerHTML = `<div class="card empty"><h3>Nothing to analyse yet</h3><p>Add holdings first — allocation, risk and scoring all read from the ledger.</p></div>`;
    return;
  }

  const assetCats = meta.categories.filter((c) => c !== 'liability');
  const ruleCount = ctx.data.portfolioHealth?.checks.length;

  root.innerHTML = `
    <div class="card" style="margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <span class="card-note">The health score, what it is made of, and the single-name and country risk figures moved to their own tab${ruleCount ? ` with ${ruleCount} further rules` : ''}.</span>
      <button class="btn btn-ghost btn-sm" id="a-open-health">Portfolio health</button>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><span class="card-title">Actual versus target</span><span class="card-note">% of gross assets</span></div>
        <div class="chart-box is-tall"><canvas id="c-drift"></canvas></div>
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">Target allocation</span><span class="card-note">saved with the ledger</span></div>
        <form id="target-form">
          <div class="field-set is-dense">
            ${assetCats.map((c) => field(meta.categoryLabels[c], input(`t_${c}`, allocation.rows.find((r) => r.key === c)?.targetPct || '', 'number'))).join('')}
          </div>
          <div style="display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap">
            <button class="btn btn-primary" type="submit">Save targets</button>
            <button class="btn btn-ghost btn-sm" type="button" id="t-copy">Copy current mix</button>
            <button class="btn btn-ghost btn-sm" type="button" id="t-clear">Clear</button>
            <span class="card-note" id="t-sum">${sumNote(allocation)}</span>
          </div>
        </form>
        ${allocation.targetsComplete ? '' : `<div class="callout is-warn" style="margin-top:13px">Targets are incomplete, so buy/trim advice and the discipline score are switched off. The weights need to total 100%.</div>`}
      </div>

      <div class="card span-2">
        <div class="card-head">
          <span class="card-title">Rebalancing plan</span>
          <span class="card-note">${allocation.targetsComplete ? 'rupees to move each class back to target' : 'set targets above to unlock'}</span>
        </div>
        ${driftTable(allocation)}
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">Risk mix</span><span class="card-note">what can fall, not what it is called</span></div>
        <div class="chart-box"><canvas id="c-risk"></canvas></div>
      </div>
    </div>`;

  root.querySelector('#a-open-health').onclick = () => ctx.go('health');
  wireTargets(root, ctx, assetCats, allocation);
  drawAnalysis(allocation, riskMix);
}

function sumNote(allocation) {
  return allocation.targetSumPct
    ? `Targets currently total ${pct(allocation.targetSumPct, 0)}.`
    : 'No targets saved yet.';
}

function driftTable(allocation) {
  const rows = allocation.rows;
  if (!rows.length) return '<p class="card-note">No assets recorded.</p>';
  const maxDrift = Math.max(5, ...rows.map((r) => Math.abs(r.driftPct)));
  return `<div class="table-wrap"><table>
    <thead><tr><th>Class</th><th class="num">Held</th><th class="num">Actual</th><th class="num">Target</th><th class="num">Drift</th><th class="num">Move needed</th><th>Action</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><span class="cell-name">${escapeHtml(r.label)}</span></td>
      <td class="num" title="${escapeHtml(money(r.heldINR))}">${shortINR(r.heldINR)}</td>
      <td class="num">${pct(r.actualPct)}</td>
      <td class="num muted">${r.hasTarget ? pct(r.targetPct) : '—'}</td>
      <td class="num"><span class="drift-cell">${driftBar(r, maxDrift)}</span></td>
      <td class="num" style="color:${r.deltaINR > 0 ? 'var(--blue)' : r.deltaINR < 0 ? 'var(--gold)' : 'var(--text-faint)'}">${r.hasTarget ? `${r.deltaINR > 0 ? '+' : '-'}${shortINR(Math.abs(r.deltaINR))}` : '—'}</td>
      <td><span class="tag ${actionClass(r)}">${actionLabel(r)}</span></td>
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="card-note" style="margin-top:10px">Drift is measured against the total portfolio, so trimming one class assumes the proceeds fund another. Nothing here places an order — it is a reading of the ledger.</p>`;
}

function driftBar(r, maxDrift) {
  const width = Math.min(50, (Math.abs(r.driftPct) / maxDrift) * 50);
  if (!r.hasTarget) return `<span class="drift-track" title="no target set"></span><span class="muted">${pct(r.actualPct)}</span>`;
  const over = r.driftPct > 0;
  return `<span class="drift-track" title="${pct(r.driftPct)} away from a ${pct(r.targetPct)} target">
      <i class="${over ? 'is-over' : 'is-under'}" style="width:${width}%"></i>
    </span><span>${over ? '+' : '-'}${pct(Math.abs(r.driftPct))}</span>`;
}

function actionClass(r) {
  return r.action === 'buy' ? 'is-buy' : r.action === 'trim' ? 'is-trim' : 'is-hold';
}

function actionLabel(r) {
  if (r.action === 'unassigned') return 'no target';
  return Math.abs(r.driftPct) < 1 ? 'in line' : r.action === 'buy' ? 'add' : 'trim';
}

function wireTargets(root, ctx, assetCats, allocation) {
  const form = root.querySelector('#target-form');
  const sumLabel = form.querySelector('#t-sum');

  form.addEventListener('input', () => {
    const total = [...form.querySelectorAll('[name^="t_"]')].reduce((a, el) => a + (Number(el.value) || 0), 0);
    if (!total) {
      sumLabel.textContent = 'Leave every box blank to switch targets off.';
    } else {
      sumLabel.textContent = `Weights total ${total.toFixed(1)}%${Math.abs(total - 100) > 0.5 ? ' — they need to reach 100%.' : ' — ready to save.'}`;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = readForm(form);
    const targets = {};
    for (const c of assetCats) {
      const n = Number(values[`t_${c}`]);
      if (Number.isFinite(n) && n > 0) targets[c] = n;
    }
    const total = Object.values(targets).reduce((a, b) => a + b, 0);
    if (total && Math.abs(total - 100) > 0.5) {
      if (!confirm(`These weights total ${total.toFixed(1)}%, not 100%. Save anyway?`)) return;
    }
    try {
      await ctx.mutate(() => api.saveTargetAllocation(targets), 'Target allocation saved.');
      render(root, ctx);
    } catch { /* mutate already toasted */ }
  });

  form.querySelector('#t-copy').onclick = () => {
    for (const r of allocation.rows) {
      const el = form.querySelector(`[name="t_${r.key}"]`);
      if (el) el.value = Number(r.actualPct.toFixed(1));
    }
    sumLabel.textContent = 'Ready to save the current mix as your target.';
  };

  form.querySelector('#t-clear').onclick = async () => {
    if (!confirm('Clear all target weights? Buy/trim advice and discipline scoring switch off until you set them again.')) return;
    await ctx.mutate(() => api.saveTargetAllocation({}), 'Targets cleared.').catch(() => {});
    render(root, ctx);
  };
}

function drawAnalysis(allocation, riskMix) {
  const rows = allocation.rows.filter((r) => r.actualPct > 0 || r.targetPct > 0);
  groupedBar('c-drift', rows.map((r) => titleCase(r.key)), [
    { label: 'Actual %', data: rows.map((r) => r.actualPct), backgroundColor: PALETTE[0], borderRadius: 4, maxBarThickness: 16 },
    { label: 'Target %', data: rows.map((r) => r.targetPct || null), backgroundColor: PALETTE[1], borderRadius: 4, maxBarThickness: 16 },
  ], { horizontal: true, percent: true });

  doughnut('c-risk', riskMix.map((r) => r.label), riskMix.map((r) => r.valueINR), { cutout: '58%' });
}
