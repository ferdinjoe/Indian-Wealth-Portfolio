import { escapeHtml, money, shortINR, ageFrom } from '../format.js';
import { api } from '../api.js';
import { field, input, select, toast } from '../ui.js';
import { buildPlan, cashFlow } from '../planning.js';

const SECURITY = [
  { value: 'starttls', label: 'STARTTLS - port 587, what most providers use' },
  { value: 'tls', label: 'TLS - implicit, port 465' },
  { value: 'none', label: 'None - a relay on this machine only' },
];

const CONTENTS = [
  ['Cover', 'Net worth, the spread across countries, real return and the tax year'],
  ['What you hold', 'Worth by asset class and by country'],
  ['Positions', 'Every row: quantity, valuation date, value in rupees, unrealised gain'],
  ['Allocation', 'Actual against your targets, with the drift and the rebalancing amounts'],
  ['Health', 'Every rule the ledger can apply, its verdict and its reading'],
  ['Income & tax', 'Indian income for the financial year, TDS and both regimes'],
  ['Goals', 'Each goal, what it will cost and what funds it'],
  ['Retirement', 'The corpus you need, the gap, the top-up and the FIRE milestones'],
  ['Sources', 'Where each price came from, its vintage and the net worth history'],
];

// Kept between repaints so the last run survives a ledger reload.
let lastRun = null;

export function render(root, ctx) {
  const d = ctx.data;
  const email = d.settings.email || {};
  const status = d.meta.email || { ready: false, problems: ['the running server has no report engine yet - restart the app'], autoSend: false, to: '' };

  root.innerHTML = `
    <div class="grid">
      ${d.holdings.length ? '' : `<div class="callout is-warn">Nothing is recorded yet, so the report would be a stack of zeros.
        <button class="btn btn-sm" id="r-empty-add" style="margin-left:8px">Add a holding</button></div>`}

      <div class="hero">
        <div>
          <span class="kpi-label">Report on ${d.holdings.length} recorded position${d.holdings.length === 1 ? '' : 's'}</span>
          <div class="hero-figure">${shortINR(d.summary.netWorthINR)}</div>
          <div class="hero-eta">Built from the ledger on this machine, in rupees at the rate dated ${escapeHtml(d.fxDate || 'unknown')}. Nothing is fetched to make it.</div>
        </div>
        <div class="hero-stats">
          <div class="hero-stat"><span class="kpi-label">Gross assets</span><div class="kpi-value is-gold">${shortINR(d.summary.totalAssetsINR)}</div>
            <div class="kpi-sub">${money(d.summary.totalAssetsINR)}</div></div>
          <div class="hero-stat"><span class="kpi-label">Liabilities</span><div class="kpi-value ${d.summary.totalLiabilitiesINR > 0 ? 'is-red' : ''}">${shortINR(d.summary.totalLiabilitiesINR)}</div>
            <div class="kpi-sub">${money(d.summary.totalLiabilitiesINR)}</div></div>
          <div class="hero-stat"><span class="kpi-label">Health rules failing</span><div class="kpi-value ${d.portfolioHealth.counts.risk ? 'is-red' : 'is-accent'}">${d.portfolioHealth.counts.risk}</div>
            <div class="kpi-sub">of ${d.portfolioHealth.checks.length} judged</div></div>
        </div>
      </div>

      <div class="card span-2">
        <div class="card-head">
          <span class="card-title">Generate and download</span>
          <span class="card-note">saved to your browser's download folder</span>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-primary" id="btn-report">${status.autoSend && status.ready ? 'Download and email' : 'Download PDF report'}</button>
          <button class="btn btn-ghost" id="btn-report-email"${status.ready ? '' : ' disabled'}>Email a copy now</button>
          <span class="card-note" id="r-busy"></span>
        </div>
        <p class="card-note" style="margin-top:12px">
          ${status.ready
            ? `Emailing goes to <code>${escapeHtml(status.to)}</code>${status.autoSend ? ' automatically after every download' : ''}.`
            : `Download works on its own. Emailing still needs: ${escapeHtml(status.problems.join('; '))}.`}
        </p>
        <div class="callout is-warn" style="margin-top:14px">
          A report leaves this machine only if you ask it to. Emailing attaches your whole portfolio - every position,
          balance and tax figure - and sends it through a mail provider's servers, which keep a copy of it. The SMTP
          password lives in the same JSON file as the ledger, so use a revocable app password rather than your main one.
        </div>
        <div id="r-result">${lastRun ? runCard(lastRun) : ''}</div>
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">What is inside</span><span class="card-note">${CONTENTS.length} sections</span></div>
        <div class="source-list">
          ${CONTENTS.map(([k, v]) => `<div><code>${escapeHtml(k)}</code> ${escapeHtml(v)}</div>`).join('')}
        </div>
        <p class="card-note" style="margin-top:12px">
          The retirement block is the arithmetic the Retirement tab is showing right now, sent with the request, so the
          PDF and that page can never disagree. Every other figure is re-read from the ledger on the server.
        </p>
      </div>

      <div class="card">
        <form id="email-form">
          <div class="card-head">
            <span class="card-title">Email settings</span>
            <span class="card-note">${email.hasPass ? 'an app password is saved' : 'no password saved'}</span>
          </div>
          <div class="section-label">Mail server</div>
          <div class="field-set">
            ${field('SMTP host', input('host', email.host, 'text', 'smtp.gmail.com'))}
            ${field('Port', input('port', email.port, 'number', '587'))}
            ${field('Connection', select('security', SECURITY, email.security))}
            ${field('Username', input('user', email.user, 'text', 'you@gmail.com'))}
            ${field('App password', `<input name="pass" type="password" autocomplete="new-password" placeholder="${email.hasPass ? 'saved - leave blank to keep it' : 'an app password, not your main one'}">`,
              'Write-only: the server never sends it back, so no page, log or export can carry it away')}
            ${field('Send from', input('from', email.from, 'text', 'blank uses the username'))}
          </div>
          <div class="section-label">Recipient</div>
          <div class="field-set">
            ${field('Send to', input('to', email.to, 'text', d.profile.email || 'blank uses the email on the Profile tab'),
              'Separate more than one address with a comma')}
          </div>
          <label class="pick" style="margin-top:14px">
            <input type="checkbox" name="autoSend"${email.autoSend ? ' checked' : ''}>
            Email a copy automatically after every download
          </label>
          <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
            <button class="btn btn-primary" type="submit">Save email settings</button>
            ${email.hasPass ? '<button class="btn btn-ghost" type="button" id="btn-forget-pass">Forget password</button>' : ''}
          </div>
        </form>
      </div>
    </div>`;

  const busy = (text) => { document.getElementById('r-busy').textContent = text || ''; };
  const addBtn = document.getElementById('r-empty-add');
  if (addBtn) addBtn.onclick = () => ctx.go('holdings');

  document.getElementById('email-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const patch = {
      host: f.host.value.trim(),
      port: Number(f.port.value) || 587,
      security: f.security.value,
      user: f.user.value.trim(),
      from: f.from.value.trim(),
      to: f.to.value.trim(),
      autoSend: f.autoSend.checked,
    };
    // A blank box means "keep the stored one"; only an explicit null clears it.
    if (f.pass.value) patch.pass = f.pass.value;
    ctx.mutate(() => api.saveEmail(patch), 'Email settings saved.');
  });

  const forget = document.getElementById('btn-forget-pass');
  if (forget) forget.onclick = () => ctx.mutate(() => api.saveEmail({ pass: null }), 'Saved password cleared; the rest of the settings are untouched.');

  document.getElementById('btn-report').onclick = async () => {
    busy('Building the PDF…');
    try {
      const payload = reportPayload(ctx.data);
      const file = await api.reportDownload(payload);
      saveToDisk(file);
      lastRun = { ...summaryOf(file), at: new Date() };
      toast(`Report saved as ${file.fileName} - ${file.pages} pages, ${kb(file.bytes)}.`);
      if (ctx.data.meta.email.autoSend && ctx.data.meta.email.ready) {
        busy('Handing the PDF to the mail server…');
        const sent = await api.reportEmail(payload);
        lastRun.email = { to: sent.to, host: `${sent.host}:${sent.port} ${sent.security}` };
        toast(`Emailed to ${sent.to}.`);
      }
    } catch (err) {
      lastRun = { fileName: null, error: err.message, at: new Date() };
      toast(err.message, 'bad', 8000);
    } finally {
      busy('');
      paintResult(root);
    }
  };

  document.getElementById('btn-report-email').onclick = async () => {
    busy('Building and sending…');
    try {
      const sent = await api.reportEmail(reportPayload(ctx.data));
      lastRun = { fileName: sent.fileName, pages: sent.pages, bytes: sent.bytes, sections: null, email: { to: sent.to, host: `${sent.host}:${sent.port} ${sent.security}` }, at: new Date() };
      toast(`Emailed to ${sent.to} via ${sent.host}:${sent.port}.`);
    } catch (err) {
      lastRun = { ...(lastRun || {}), error: err.message, at: new Date() };
      toast(err.message, 'bad', 8000);
    } finally {
      busy('');
      paintResult(root);
    }
  };
}

// The server returns the PDF as bytes; this hands them to the browser's own
// download, so the file lands in the download folder with no dialog detour.
function saveToDisk(file) {
  const a = document.createElement('a');
  a.href = file.url;
  a.download = file.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(file.url), 4000);
}

// The retirement projection lives in planning.js on this side of the wire, so the
// PDF is built from the same numbers the Retirement tab shows rather than a
// second implementation that could drift from it.
function reportPayload(d) {
  const assumptions = d.settings.assumptions;
  const currentAge = ageFrom(d.profile.dateOfBirth) ?? d.profile.plannedRetirementAge ?? 60;
  const plan = buildPlan({
    profile: d.profile,
    assumptions,
    netWorthINR: d.summary.netWorthINR,
    liquidAssetsINR: d.summary.liquidAssetsINR,
    currentAge,
  });
  const cash = cashFlow({
    profile: d.profile,
    netWorthINR: d.summary.netWorthINR,
    totalLiabilitiesINR: d.summary.totalLiabilitiesINR,
    currentAge: plan.currentAge,
    assumptions,
  });
  return { plan, cash };
}

function summaryOf(file) {
  return { fileName: file.fileName, pages: file.pages, bytes: file.bytes, sections: file.sections, at: new Date() };
}

function kb(bytes) {
  return `${(Number(bytes) / 1024).toFixed(0)} KB`;
}

function runCard(r) {
  return `<div class="source-list" style="margin-top:16px">
    <div>Last run: <code>${escapeHtml((r.at.toISOString?.() || '').slice(11, 19))} UTC</code></div>
    ${r.fileName ? `<div>Downloaded: <code>${escapeHtml(r.fileName)}</code>${r.pages ? ` · ${r.pages} pages · ${kb(r.bytes)}${r.sections ? ` · ${r.sections} sections` : ''}` : ''}</div>` : ''}
    ${r.email ? `<div>Emailed: <code>to ${escapeHtml(r.email.to)}</code> via <code>${escapeHtml(r.email.host)}</code></div>` : ''}
    ${r.error ? `<div><span class="neg">Failed:</span> <span class="neg">${escapeHtml(r.error)}</span></div>` : ''}
  </div>`;
}

// Only the result block is redrawn after a run - re-rendering the page would throw
// away half-typed answers in the SMTP form.
function paintResult(root) {
  const slot = root.querySelector('#r-result');
  if (slot) slot.innerHTML = lastRun ? runCard(lastRun) : '';
}
