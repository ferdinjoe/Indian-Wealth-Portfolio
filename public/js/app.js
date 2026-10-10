import { api } from './api.js';
import { toast, setBanner, registerBannerAction } from './ui.js';
import { shortINR, money } from './format.js';
import { destroyCharts } from './charts.js';
import { saveSnapshot, loadSnapshot, ageLabel } from './offline.js';
import * as dashboard from './views/dashboard.js';
import * as holdings from './views/holdings.js';
import * as analytics from './views/analytics.js';
import * as allocation from './views/allocation.js';
import * as health from './views/health.js';
import * as goals from './views/goals.js';
import * as planner from './views/planner.js';
import * as tax from './views/tax.js';
import * as profile from './views/profile.js';
import * as settings from './views/settings.js';
import * as report from './views/report.js';

const VIEWS = {
  dashboard: { title: 'Dashboard', sub: 'Your consolidated position, restated in Indian Rupees.', render: dashboard.render },
  holdings: { title: 'Holdings', sub: 'Every account, instrument and policy across your countries.', render: holdings.render },
  analytics: { title: 'Wealth Analytics', sub: 'What each asset compounds to over the next five, ten and fifteen years, year by year.', render: analytics.render },
  allocation: { title: 'Allocation & risk', sub: 'How the money is spread, how far it has drifted, and how healthy that leaves you.', render: allocation.render },
  health: { title: 'Portfolio health', sub: 'Every rule the ledger can apply to what you own, one verdict per rule and the fixes ranked.', render: health.render },
  goals: { title: 'Goals', sub: 'Each intention you are saving for, measured against what it will cost when it falls due.', render: goals.render },
  planner: { title: 'Retirement', sub: 'Where your wealth takes you, and what it would take to be enough.', render: planner.render },
  tax: { title: 'India income & tax', sub: 'What your Indian holdings have earned this financial year, and the tax that follows.', render: tax.render },
  profile: { title: 'Profile', sub: 'Personal details the retirement model depends on.', render: profile.render },
  settings: { title: 'Settings', sub: 'Exchange rates, model assumptions and data management.', render: settings.render },
  report: { title: 'Generate PDF Report', sub: 'One PDF of the whole ledger, written on this machine; a copy is emailed only if you set it up and ask.', render: report.render },
};

let data = null;
let current = 'dashboard';
// True between posting a write and getting the valued ledger back, during which
// a re-read would show the pre-write numbers.
let writing = false;

const ctx = {
  get data() { return data; },
  go: (view) => show(view),
  reload: () => refresh(),
  mutate: runMutation,
};

async function refresh() {
  try {
    data = await api.state();
    saveSnapshot(data);
    paint();
  } catch (err) {
    const saved = loadSnapshot();
    if (saved) {
      data = saved;
      paint();
      toast(`Laptop not reachable (${err.message}). Showing the copy saved on this device.`, 'warn', 6000);
    } else {
      toast(`Could not load ledger: ${err.message}`, 'bad', 6000);
    }
  }
}

// Wraps a write so every mutation returns to a freshly valued ledger.
async function runMutation(fn, successMessage) {
  if (data && data.meta && data.meta.offline) {
    toast('This is a saved copy from when the PC was last reachable. Reconnect to edit the ledger.', 'warn', 6000);
    throw new Error('Offline copy - edits are disabled.');
  }
  writing = true;
  try {
    const next = await fn();
    data = next;
    saveSnapshot(next);
    paint();
    if (successMessage) toast(successMessage);
    return next;
  } catch (err) {
    toast(err.message, 'bad', 5000);
    throw err;
  } finally {
    writing = false;
  }
}

function paint() {
  if (!data) return;
  document.getElementById('topbar-networth').textContent = shortINR(data.summary.netWorthINR);
  document.getElementById('topbar-networth').title = money(data.summary.netWorthINR);
  document.getElementById('data-file').textContent = data.meta.dataFile;
  paintFxChip();
  paintBanners();
  VIEWS[current].render(document.getElementById(`view-${current}`), ctx);
}

function paintFxChip() {
  const dot = document.getElementById('fx-dot');
  const label = document.getElementById('fx-status');
  dot.className = 'fx-dot';
  const usd = data.rates.USD;
  const sources = new Set(Object.values(data.rates).map((r) => r.source));
  if (sources.has('live') || sources.has('cached')) {
    dot.classList.add(sources.has('manual') ? 'is-muted' : 'is-live');
    label.textContent = `1 USD = ${usd.rate?.toFixed(2) ?? '—'} ₹ · ${data.fxDate || usd.asOf || 'cached'}`;
  } else {
    dot.classList.add('is-bad');
    label.textContent = 'FX rates: bundled defaults — refresh';
  }
  label.title = `Rates dated ${data.fxDate || 'unknown'}. Click to open Settings.`;
  label.onclick = () => show('settings');
}

function paintBanners() {
  if (!data) return;
  const banners = [];
  if (data.meta.offline) {
    banners.push({
      kind: 'warn',
      text: `This is the copy saved on this device ${ageLabel(data.meta.offlineAt)} ago. The PC is not reachable, so nothing here can be edited or is freshly priced.`,
      action: { id: 'fix-offline', label: 'Try the PC again' },
    });
  }
  if (data.meta.unconverted.length) {
    banners.push({
      kind: 'error',
      text: `${data.meta.unconverted.length} holding(s) use a currency we have no rate for, so they are excluded from net worth.`,
      action: { id: 'fix-fx' },
    });
    banners[0].action.label = 'Open rate settings';
  }
  if (!data.profile.dateOfBirth) {
    banners.push({ kind: 'warn', text: 'Add your date of birth to unlock age-based retirement projections.', action: { id: 'fix-dob', label: 'Add now' } });
  }
  if (!data.holdings.length) {
    banners.push({ kind: 'warn', text: 'No holdings recorded yet.', action: { id: 'fix-add', label: 'Add first holding' } });
  }
  if (data.holdings.length && !Object.keys(data.settings.targetAllocation || {}).length) {
    banners.push({ kind: 'warn', text: 'No target allocation set, so the ledger cannot tell you what to rebalance or score your discipline.', action: { id: 'fix-targets', label: 'Set targets' } });
  }
  setBanner(banners);
}

function show(view) {
  if (!VIEWS[view]) return;
  if (view !== current) destroyCharts();
  current = view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('is-hidden', s.id !== `view-${view}`));
  document.getElementById('view-title').textContent = VIEWS[view].title;
  document.getElementById('view-sub').textContent = VIEWS[view].sub;
  if (data) {
    paintBanners();
    VIEWS[view].render(document.getElementById(`view-${view}`), ctx);
  }
  window.scrollTo({ top: 0 });
  history.replaceState(null, '', `#${view}`);
  // On a phone the nav is one scrolling strip of eleven items, so the tab just
  // chosen has to be dragged back into sight.
  if (window.matchMedia('(max-width: 980px)').matches) {
    document.querySelector('.nav-item.is-active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}

registerBannerAction('fix-fx', () => show('settings'));
registerBannerAction('fix-dob', () => show('profile'));
registerBannerAction('fix-add', () => show('holdings'));
registerBannerAction('fix-targets', () => show('allocation'));
registerBannerAction('fix-offline', () => refresh());

// The worker is what turns "a page on my PC" into an icon in the app drawer with
// no browser around it. It caches the shell only - the ledger still comes from
// this laptop every time, which is the point of a single shared data file.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (btn) show(btn.dataset.view);
});

document.getElementById('btn-refresh-fx').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  try {
    const next = await api.refreshFx();
    data = next;
    paint();
    toast(`Rates updated (ECB reference, ${next.fxDate || 'today'}).`);
  } catch (err) {
    toast(err.message, 'bad', 6000);
    paint();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh rates';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('modal').hidden) {
    document.querySelector('.modal [data-close]').click();
  }
});

// The ledger is read at load and after this tab's own writes, so a window left
// open on the desktop shortcut keeps showing last hour's net worth after an edit
// in another one. Coming back into view re-reads it - but never over an open
// form, which would throw away half-typed answers.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || writing) return;
  if (!document.getElementById('modal').hidden) return;
  refresh();
});

const initial = location.hash.replace('#', '');
show(VIEWS[initial] ? initial : 'dashboard');
refresh();
