import { api } from '../api.js';
import { money, native, shortINR, pct, countryLabel, countryShort, escapeHtml, titleCase } from '../format.js';
import { openModal, field, input, select, readForm, toast } from '../ui.js';

const filters = { q: '', category: '', country: '', currency: '', sort: 'value' };

// Ticked row ids. Kept outside the render cycle so a filter change cannot drop
// a half-finished selection, and pruned to surviving ids whenever the ledger
// is repainted.
const selected = new Set();

const COUNTRY_CODES = ['IN', 'TH', 'SG', 'US', 'AE', 'GB', 'AU', 'CA', 'CH', 'JP', 'MY', 'HK'];

export function render(root, ctx) {
  const { meta, summary } = ctx.data;

  const perf = summary.performance || {};

  root.innerHTML = `
    <div class="toolbar">
      <input class="filter-input" id="f-q" type="text" placeholder="Search name, ticker, institution…" value="${escapeHtml(filters.q)}">
      ${selectize('f-country', 'All countries', COUNTRY_CODES.map((c) => ({ value: c, label: countryShort(c) })), filters.country)}
      ${selectize('f-currency', 'All currencies', meta.currencies.map((c) => ({ value: c, label: c })), filters.currency)}
      ${selectize('f-sort', 'Sort: highest value', [{ value: 'value', label: 'Sort: highest value' }, { value: 'name', label: 'Sort: name A–Z' }, { value: 'gain', label: 'Sort: best return' }, { value: 'maturity', label: 'Sort: maturity date' }], filters.sort)}
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" id="refresh-prices" title="Pull the latest exchange price for every equity holding with a ticker, and the Chennai 22K/24K gold and silver rate per gram for every metal row. Ticked rows only, if any are ticked.">↻ Live prices</button>
      <button class="btn btn-ghost btn-sm" id="f-clear">Clear filters</button>
      <button class="btn btn-primary" id="add-holding">+ Add holding</button>
    </div>

    <div class="tabs" id="type-tabs" role="tablist" aria-label="Asset type"></div>

    <div class="sel-bar" id="sel-bar" hidden></div>

    <div class="grid grid-kpis" style="margin-bottom:16px">
      ${filteredKpi()}
      ${miniKpi('Gross assets', shortINR(summary.totalAssetsINR), `${summary.assetCount} holdings`)}
      ${miniKpi('Total debt', shortINR(summary.totalLiabilitiesINR), `${summary.liabilityCount} liabilities`, 'is-red')}
      ${miniKpi('Net worth', shortINR(summary.netWorthINR), 'assets minus liabilities', 'is-accent')}
      ${miniKpi('Money-weighted return', perf.xirrPct === null || perf.xirrPct === undefined ? '—' : pct(perf.xirrPct), perf.coveredCount ? `${perf.coveredCount} assets track a cost basis` : 'no purchase costs recorded yet', perf.xirrPct > 0 ? 'is-accent' : '')}
    </div>

    <div id="holdings-table"></div>`;

  drawTable(root, ctx);
  wireToolbar(root, ctx);
  document.getElementById('add-holding').onclick = () => openForm(null, ctx);
}

function miniKpi(label, value, sub, cls = '') {
  return `<div class="card"><span class="kpi-label">${label}</span><div class="kpi-value ${cls}" style="font-size:21px">${value}</div><div class="kpi-sub">${sub}</div></div>`;
}

// The only KPI that follows the filters, so it has hooks drawTable can refresh
// on each keystroke instead of waiting for a full re-render.
function filteredKpi() {
  return `<div class="card"><span class="kpi-label">Filtered net value</span><div class="kpi-value" id="kpi-filtered-value" style="font-size:21px"></div><div class="kpi-sub" id="kpi-filtered-sub"></div></div>`;
}

function paintFilteredKpi(shown, total) {
  const value = document.getElementById('kpi-filtered-value');
  const sub = document.getElementById('kpi-filtered-sub');
  if (!value || !sub) return;
  const net = netINR(shown);
  value.textContent = shortINR(net);
  value.title = money(net);
  value.classList.toggle('is-red', net < 0);
  sub.textContent = `${shown.length} of ${total} records`;
}

function selectize(id, placeholder, options, value) {
  const opts = [`<option value="">${placeholder}</option>`, ...options.map((o) => `<option value="${o.value}"${o.value === value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`)].join('');
  return `<div style="position:relative;min-width:150px"><select id="${id}" style="padding-left:10px">${opts}</select></div>`;
}

function filtered(list, skipCategory = false) {
  const q = filters.q.trim().toLowerCase();
  return list.filter((h) => {
    if (!skipCategory && filters.category && h.category !== filters.category) return false;
    if (filters.country && h.country !== filters.country) return false;
    if (filters.currency && h.currency !== filters.currency) return false;
    if (!q) return true;
    return [h.name, h.instrument, h.institution, h.notes, h.currency, h.country]
      .some((f) => String(f || '').toLowerCase().includes(q));
  });
}

// Liabilities count against the total here exactly as they do in the filtered
// KPI, so the All tab and the card underneath it can never disagree.
const netINR = (list) => list.reduce((a, h) => a + (h.category === 'liability' ? -(h.valueINR || 0) : (h.valueINR || 0)), 0);

// Written for a dropdown, where the bracket spells out what the scheme is. On a
// pill the same label would just eat width.
const tabLabel = (s) => s.replace(/\s*\([^)]*\)/, '').trim();

function sorted(list) {
  const by = {
    value: (a, b) => (b.valueINR || 0) - (a.valueINR || 0),
    name: (a, b) => a.name.localeCompare(b.name),
    gain: (a, b) => (b.annualisedPct ?? b.gainPct ?? -1e9) - (a.annualisedPct ?? a.gainPct ?? -1e9),
    maturity: (a, b) => String(a.maturityDate || '9999').localeCompare(String(b.maturityDate || '9999')),
  }[filters.sort] || ((a, b) => (b.valueINR || 0) - (a.valueINR || 0));
  return [...list].sort(by);
}

// One pill per asset type, so the table shows a single section at a time rather
// than every class interleaved. Counts ignore the class filter on purpose - they
// answer "how many of what is currently searched would this tab show".
function paintTabs(holdings, meta) {
  const host = document.getElementById('type-tabs');
  if (!host) return;
  const pool = filtered(holdings, true);
  const groups = new Map();
  for (const h of pool) {
    const g = groups.get(h.category) || { count: 0, rows: [] };
    g.count += 1;
    g.rows.push(h);
    groups.set(h.category, g);
  }
  const keys = meta.categories.filter((c) => groups.has(c));
  if (filters.category && !keys.includes(filters.category)) keys.push(filters.category);

  const pill = (key, label, rows) => {
    const active = filters.category === key;
    const count = rows.length;
    const net = netINR(rows);
    return `<button type="button" class="tab${active ? ' is-active' : ''}" role="tab" aria-selected="${active}"
      data-tab="${escapeHtml(key)}" title="${escapeHtml(shortINR(net))} across ${count} ${count === 1 ? 'holding' : 'holdings'}">${escapeHtml(label)}<span class="tab-count">${count}</span></button>`;
  };

  host.innerHTML = [
    pill('', 'All types', pool),
    ...keys.map((c) => pill(c, tabLabel(meta.categoryLabels[c] || titleCase(c)), groups.get(c)?.rows || [])),
  ].join('');
}

// A broker is only meaningful on the two classes that are bought through one:
// a deposit's institution is a bank and a metal row's is a jeweller, so grouping
// every class this way would dress a savings account up as a trading account.
const BROKER_CLASSES = new Set(['equity', 'bond']);
const NO_BROKER = 'No broker recorded';

// Rows reach this already sorted by filters.sort, so each bucket keeps that
// order; only the buckets themselves are ranked, by rupee subtotal.
function groupByBroker(rows) {
  const buckets = new Map();
  for (const h of rows) {
    const name = String(h.institution || '').trim();
    const key = name.toLowerCase();
    if (!buckets.has(key)) buckets.set(key, { name: name || NO_BROKER, listed: Boolean(name), rows: [] });
    buckets.get(key).rows.push(h);
  }
  const list = [...buckets.values()];
  list.sort((a, b) => {
    if (a.listed !== b.listed) return a.listed ? -1 : 1;
    return netINR(b.rows) - netINR(a.rows) || a.name.localeCompare(b.name);
  });
  return list.map((g) => ({
    ...g,
    netINR: netINR(g.rows),
    currencies: [...new Set(g.rows.map((h) => h.currency))].join(', '),
  }));
}

function drawTable(root, ctx) {
  const alive = new Set(ctx.data.holdings.map((h) => h.id));
  [...selected].forEach((id) => { if (!alive.has(id)) selected.delete(id); });
  paintSelBar(root, ctx);
  paintTabs(ctx.data.holdings, ctx.data.meta);
  document.querySelectorAll('#type-tabs [data-tab]').forEach((tab) => {
    tab.onclick = () => { filters.category = tab.dataset.tab; drawTable(root, ctx); };
  });

  const rows = sorted(filtered(ctx.data.holdings));
  paintFilteredKpi(rows, ctx.data.holdings.length);
  const host = document.getElementById('holdings-table');
  if (!rows.length) {
    host.innerHTML = `<div class="card empty"><h3>No matching holdings</h3><p>Loosen the filters above, or add a holding.</p></div>`;
    return;
  }

  const oneType = Boolean(filters.category);
  // Broker sections only ever appear on a single-class tab, where the Class
  // column is already gone - but the colspan still follows oneType so the two
  // cannot drift apart if a future tab groups as well.
  const brokers = BROKER_CLASSES.has(filters.category) ? groupByBroker(rows) : null;
  const cols = oneType ? 12 : 13;
  const head = (g) => `<tr class="group-row"><td colspan="${cols}"><div class="group-head">
      <span class="group-name">${escapeHtml(g.name)}</span>
      <span class="group-meta">${g.rows.length} ${g.rows.length === 1 ? 'holding' : 'holdings'} · ${escapeHtml(g.currencies)}</span>
      <span class="group-total" title="${escapeHtml(money(g.netINR))}">${money(g.netINR)}</span>
    </div></td></tr>`;
  const body = brokers
    ? brokers.map((g) => head(g) + g.rows.map((h) => row(h, ctx, true)).join('')).join('')
    : rows.map((h) => row(h, ctx)).join('');

  const shownIds = rows.map((h) => h.id);
  const allChecked = shownIds.every((id) => selected.has(id));

  host.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th class="chk"><input type="checkbox" id="sel-all" title="Select all shown rows"${allChecked ? ' checked' : ''}></th>
      <th>Holding</th>${oneType ? '' : '<th>Class</th>'}<th>Country</th><th class="num">Units</th><th class="num">Price</th>
      <th class="num">Value (native)</th><th class="num">Rate</th><th class="num">Value (INR)</th><th class="num">Cost (INR)</th><th class="num">Returns</th><th>Maturity</th><th></th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  <p class="card-note" style="margin-top:10px">${brokers ? 'Equity and bond rows are sectioned by the broker in their Institution field, highest-value broker first; a header is the rupee subtotal of the rows under it, so it follows every filter and the live prices. ' : ''}Click a holding's name — or double-click anywhere on its row — to edit it; the Edit and × buttons stay pinned on the right while the table scrolls. Value (INR) is the native amount multiplied by that currency's rate, which you can refresh or pin in Settings. Liabilities count against net worth. Returns are worked out in the holding's own currency against its purchase cost, so a move in the rupee shows up in net worth but not here. Tick the boxes on the left to delete several records in one go.</p>`;

  document.getElementById('sel-all').onclick = () => {
    const checked = document.getElementById('sel-all').checked;
    shownIds.forEach((id) => { if (checked) selected.add(id); else selected.delete(id); });
    drawTable(root, ctx);
  };
  host.querySelectorAll('[data-sel]').forEach((box) => {
    box.onclick = () => {
      if (box.checked) selected.add(box.dataset.sel); else selected.delete(box.dataset.sel);
      paintSelBar(root, ctx);
      document.getElementById('sel-all').checked = shownIds.every((id) => selected.has(id));
    };
  });

  host.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => openForm(ctx.data.holdings.find((h) => h.id === b.dataset.edit), ctx);
  });
  host.querySelectorAll('tbody tr[data-row]').forEach((tr) => {
    tr.ondblclick = (ev) => {
      if (ev.target.closest('button, input, a, select')) return;
      openForm(ctx.data.holdings.find((h) => h.id === tr.dataset.row), ctx);
    };
  });
  host.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const h = ctx.data.holdings.find((x) => x.id === b.dataset.del);
      if (!confirm(`Delete “${h.name}${h.instrument ? ` (${h.instrument})` : ''}”?`)) return;
      await ctx.mutate(() => api.deleteHolding(h.id), `Removed ${h.name}`).catch(() => {});
      selected.delete(h.id);
      render(root, ctx);
    };
  });
}

function paintSelBar(root, ctx) {
  const bar = document.getElementById('sel-bar');
  if (!bar) return;
  const rows = ctx.data.holdings.filter((h) => selected.has(h.id));
  bar.hidden = rows.length === 0;
  if (!rows.length) return;
  const worth = rows.reduce((a, h) => a + (h.valueINR || 0), 0);
  const debt = rows.filter((h) => h.category === 'liability').length;
  bar.innerHTML = `
    <strong>${rows.length}</strong> selected · ${money(worth)} of value${debt ? ` · <span class="tag is-liability">${debt} ${debt === 1 ? 'liability' : 'liabilities'}</span>` : ''}
    <span class="spacer"></span>
    <button class="btn btn-ghost btn-sm" id="sel-clear">Clear selection</button>
    <button class="btn btn-danger btn-sm" id="sel-delete">Delete selected</button>`;
  document.getElementById('sel-clear').onclick = () => { selected.clear(); drawTable(root, ctx); };
  document.getElementById('sel-delete').onclick = () => { deleteSelected(root, ctx).catch(() => {}); };
}

async function deleteSelected(root, ctx) {
  const rows = ctx.data.holdings.filter((h) => selected.has(h.id));
  if (!rows.length) return;
  const worth = rows.reduce((a, h) => a + (h.valueINR || 0), 0);
  const debt = rows.filter((h) => h.category === 'liability').length;
  const label = rows.length === 1 ? `“${rows[0].name}”` : `${rows.length} holdings`;
  const extra = debt ? ` ${debt} of them ${debt === 1 ? 'is a liability' : 'are liabilities'}, which would raise net worth.` : '';
  if (!confirm(`Delete ${label} (${money(worth)} of value)?${extra} This cannot be undone from the app — the previous ledger becomes the backup file.`)) return;
  const ids = rows.map((h) => h.id);
  await ctx.mutate(() => api.bulkDeleteHoldings(ids), `Deleted ${ids.length} ${ids.length === 1 ? 'holding' : 'holdings'}`);
  selected.clear();
}

function row(h, ctx, grouped = false) {
  const rate = ctx.data.rates[h.currency];
  const isDebt = h.category === 'liability';
  const metal = h.category === 'gold_commodity' && h.metalRate
    ? (ctx.data.meta.metalCard?.labels?.[h.metalRate]?.text || h.metalRate) : null;
  // The bullion feed needs grams to multiply, so a metal row without a quantity
  // is not going to price itself however it is flagged.
  const trackable = metal ? Number(h.units) > 0 : (h.category === 'equity' && !!h.trackedSymbol && h.priceAuto !== false);
  const willFetch = metal || [h.trackedSymbol, h.altSymbol && `or ${h.altSymbol} if that board prints nothing`].filter(Boolean).join(' ');
  const missingPrice = h.units !== null && h.pricePerUnit === null && !h.nativeValue;
  const priceTag = !missingPrice ? '' : trackable
    ? ` <span class="tag is-ok" title="The next refresh fetches ${escapeHtml(willFetch)}">will auto-price</span>`
    : ' <span class="tag is-warn">needs price</span>';
  return `<tr data-row="${h.id}">
    <td class="chk"><input type="checkbox" data-sel="${h.id}"${selected.has(h.id) ? ' checked' : ''} aria-label="Select ${escapeHtml(h.name)}"></td>
    <td>
      <div class="cell-name"><button class="row-edit" data-edit="${h.id}" title="Edit ${escapeHtml(h.name)}">${escapeHtml(h.name)}</button>${isDebt ? ' <span class="tag is-liability">debt</span>' : ''}${priceTag}</div>
      <div class="cell-sub">${escapeHtml([h.instrument, grouped ? '' : h.institution].filter(Boolean).join(' · '))}${h.notes ? ` · ${escapeHtml(h.notes.slice(0, 60))}` : ''}</div>
    </td>
    ${filters.category ? '' : `<td><span class="tag">${escapeHtml(titleCase(h.category))}</span></td>`}
    <td>${countryShort(h.country)}</td>
    <td class="num">${h.units !== null ? escapeHtml(new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(h.units)) : '<span class="muted">—</span>'}</td>
    <td class="num">${priceCell(h)}</td>
    <td class="num">${native(h.nativeValue, h.currency)}${fdTag(h)}</td>
    <td class="num muted">${rate?.rate ? rate.rate.toFixed(rate.rate > 10 ? 2 : 4) : '<span class="neg">no rate</span>'}</td>
    <td class="num" title="${escapeHtml(money(h.valueINR || 0))}"><strong class="${isDebt ? 'neg' : ''}">${isDebt ? '-' : ''}${h.valueINR === null ? '<span class="neg">—</span>' : money(h.valueINR)}</strong></td>
    <td class="num muted">${costCell(h, isDebt)}</td>
    <td class="num">${returnsCell(h, isDebt)}</td>
    <td class="muted">${h.maturityDate ? escapeHtml(h.maturityDate) : '<span class="muted">—</span>'}</td>
    <td style="white-space:nowrap">
      <button class="btn btn-ghost btn-sm" data-edit="${h.id}">Edit</button>
      <button class="btn btn-danger btn-sm" data-del="${h.id}" title="Delete">&times;</button>
    </td>
  </tr>`;
}

function fdTag(h) {
  if (h.fdPrincipal === undefined || h.fdPrincipal === null) return '';
  return `<br><span class="price-tag" title="Principal ${escapeHtml(money(h.fdPrincipal))} at ${escapeHtml(String(h.interestRatePct))}% p.a., compounded quarterly">${h.fdAutoRenew ? 'renewing · next' : 'accrued · matures'} ${escapeHtml(h.maturityDate || '—')}</span>`;
}

function priceCell(h) {
  if (h.pricePerUnit === null) return '<span class="muted">—</span>';
  const price = native(h.pricePerUnit, h.currency);
  if (h.priceAuto === false) return `${price}<br><span class="price-tag muted" title="You pinned this price; the quote feed leaves it alone">pinned</span>`;
  if (h.priceAsOf) {
    return `${price}<br><span class="price-tag is-live" title="Fetched from the price feed on ${escapeHtml(h.priceAsOf)}">live ${escapeHtml(h.priceSymbol || '')} · ${escapeHtml(h.priceAsOf)}</span>`;
  }
  return price;
}

function costCell(h, isDebt) {
  if (isDebt || h.costINR === null || h.costINR === undefined) return '<span class="muted" title="No purchase cost recorded — add one in Edit to see returns">—</span>';
  return `<span title="${escapeHtml(money(h.costINR))}">${shortINR(h.costINR)}</span>`;
}

function returnsCell(h, isDebt) {
  if (isDebt || h.gainPct === null || h.gainPct === undefined) return '<span class="muted">—</span>';
  const cls = h.gainPct >= 0 ? '' : 'neg';
  const annual = h.annualisedPct === null || h.annualisedPct === undefined
    ? ''
    : `<span class="muted" style="font-size:11px">${pct(h.annualisedPct)}/yr · ${h.yearsHeld ?? 0}y held</span>`;
  const tax = h.taxStatus && h.taxStatus !== 'n/a'
    ? ` <span class="tag ${h.taxStatus === 'LTCG' ? 'is-ok' : 'is-warn'}" title="${h.taxStatus === 'LTCG' ? 'Held over the long-term threshold' : 'Still inside the short-term tax window'}">${h.taxStatus}</span>`
    : '';
  return `<span class="${cls}" style="font-weight:560" title="Gain of ${escapeHtml(money(h.gainINR || 0))} on cost">${pct(h.gainPct)}${tax}</span>${annual ? `<br>${annual}` : ''}`;
}

function wireToolbar(root, ctx) {
  const rerender = () => drawTable(root, ctx);
  const bind = (id, key, isInput) => {
    const el = document.getElementById(id);
    el.addEventListener(isInput ? 'input' : 'change', () => { filters[key] = el.value; if (!isInput) el.blur(); rerender(); });
  };
  bind('f-q', 'q', true);
  bind('f-country', 'country');
  bind('f-currency', 'currency');
  bind('f-sort', 'sort');
  document.getElementById('f-clear').onclick = () => {
    Object.assign(filters, { q: '', category: '', country: '', currency: '', sort: 'value' });
    render(root, ctx);
  };
  document.getElementById('refresh-prices').onclick = () => refreshPrices(ctx);
}

async function refreshPrices(ctx) {
  const btn = document.getElementById('refresh-prices');
  const ids = [...selected];
  const scope = ids.length ? 'ticked' : 'tracked';
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '↻ fetching…';
  try {
    const next = await ctx.mutate(() => api.refreshPrices(ids));
    const r = next?.priceResult || {};
    if (r.note) return toast(r.note, 'ok', 5000);
    const updated = r.updated || [];
    const skipped = r.skipped || [];
    const noun = (r.requested ?? 0) === 1 ? 'holding' : 'holdings';
    let message = `${updated.length} of ${r.requested ?? 0} ${scope} ${noun} repriced`;
    if (skipped.length) message += ` · ${skipped.length} skipped: ${skipped[0].name || skipped[0].symbol} (${skipped[0].reason})`;
    if (updated.length === 1) message += ` · ${updated[0].name} ${updated[0].from ?? '—'} → ${updated[0].to}`;
    if (r.errors?.length) message += ` · ${r.errors.length === 1 ? 'one feed failed' : `${r.errors.length} feeds failed`}: ${r.errors[0]}`;
    toast(message, 'ok', 6500);
  } catch {
    // mutate() already raised the toast; the repaint never happened, so undo the label.
    btn.disabled = false;
    btn.textContent = label;
  }
}

function feedHint(rec) {
  if (rec.priceAuto === false) return 'Pinned rows are skipped by every refresh, so this price stays until you switch it back.';
  if (rec.category === 'gold_commodity') return 'A gold or silver row is priced from the bullion card below, not from an exchange ticker.';
  if (rec.category === 'bond') {
    const quote = rec.bondFaceINR
      ? ` Last quote: ₹${Number(rec.pricePerUnit || 0).toLocaleString('en-IN')} for one bond of ₹${Number(rec.bondFaceINR).toLocaleString('en-IN')} face`
        + (rec.bondYieldPct ? ` at ${rec.bondYieldPct}% yield to maturity` : '')
        + (rec.priceAsOf ? `, fetched ${escapeHtml(rec.priceAsOf)}.` : '.')
      : '';
    return 'Put the bond’s ISIN in the ticker box and how many bonds you own in Units — IndiaBonds quotes the price of one bond, so value is count × price.'
      + quote;
  }
  if (rec.category && rec.category !== 'equity') {
    return `Only equity, bullion and bond rows are priced automatically - a ${escapeHtml(titleCase(rec.category))} keeps whatever you enter.`;
  }
  if (!rec.trackedSymbol) return 'Add a ticker above to enable live pricing.';
  const fallback = rec.altSymbol ? ` If ${escapeHtml(rec.trackedSymbol)} prints nothing, ${escapeHtml(rec.altSymbol)} is tried.` : '';
  // Their own text already names the board, as a suffix or a tag, so there is no
  // guess left here to tell them how to override.
  const typed = String(rec.instrument || '').trim().toUpperCase();
  const guessed = !/[.]/.test(typed) && !/^(?:BSE|NSE)\s*:/.test(typed);
  return `Prices from ${escapeHtml(rec.trackedSymbol)}${rec.priceAsOf ? `, last fetched ${escapeHtml(rec.priceAsOf)}` : ''}.${fallback}${guessed ? ' Write the board into the ticker (RELIANCE.BO or BSE:RELIANCE) to pick it yourself.' : ''}`;
}

// The option list and the wording both come from the server, so adding a rate
// to the scraped card cannot leave the browser holding a stale copy.
function metalOptions(meta) {
  const card = meta.metalCard || { keys: [], labels: {} };
  return [
    { value: '', label: 'Manual - I value this row myself' },
    ...card.keys.map((k) => ({ value: k, label: `${card.labels[k]?.text || k} - ${card.source}` })),
  ];
}

function metalHint(rec, meta) {
  const card = meta.metalRates;
  if (!card) return 'Units are grams. Saving pulls the per-gram price from the bullion card straight away.';
  const per = (v) => (v ? `₹${Number(v).toLocaleString('en-IN')}` : '—');
  const mine = rec.metalRate ? card[rec.metalRate] : null;
  return `Units are grams. Card of ${escapeHtml(card.asOf || 'unknown date')}: 22K ${per(card.gold22)}, 24K ${per(card.gold24)}, silver ${per(card.silver)} per gram.`
    + (mine ? ` This row is priced at ${per(mine)} per gram.` : '');
}

function fdHint(rec) {
  if (rec.termMonths && rec.maturityDate) {
    return `${rec.fdAutoRenew ? `This term runs to ${escapeHtml(rec.maturityDate)}` : `Matures ${escapeHtml(rec.maturityDate)}`}. The value accrues quarterly at the rate above, from the deposit date.`;
  }
  return 'Months from the deposit date. With a rate entered, the value accrues quarterly until maturity instead of sitting at the principal.';
}

// Renewal is the bank's decision, not the ledger's: a matured FD is rolled into
// the same term on the same rate unless the owner walks in and breaks it. This
// switch says which of the two the row should behave like.
function fdRenewalHint(rec) {
  if (!rec.termMonths || !rec.acquiredOn) {
    return 'Needs a term and a deposit date first. Nothing is written to the ledger at maturity - the same term simply starts again on top of the interest already earned.';
  }
  if (!rec.fdAutoRenew) {
    return `Left off at ${escapeHtml(rec.maturityDate)}: the deposit keeps the value it reached and waits for you to renew it by hand.`;
  }
  return `Renews on ${escapeHtml(rec.maturityDate)} at the rate above, and again after that. Edit the rate when your bank gives you a new one for the fresh term.`;
}

// Shared by the first render and by a later class change, so picking "Fixed
// deposits" on a row that was not one still asks for the deposit details.
const FD_HINTS = {
  valueNative: 'What you put in — the app works out today’s value from the rate and term',
  interestRatePct: 'Compounded quarterly, the Indian bank convention',
  acquiredOn: 'The day the deposit started — the term counts from here',
  maturityDate: 'Deposit date plus the term, rolled forward term by term if the deposit renews — the app works it out when you save',
};
const PLAIN_HINTS = {
  valueNative: 'Used when units are blank',
  interestRatePct: 'Drives the passive-income KPI',
  acquiredOn: 'Needed for the annualised figure',
  maturityDate: '',
};
const FD_LABELS = { valueNative: 'Principal deposited', acquiredOn: 'Date of deposit' };
const PLAIN_LABELS = { valueNative: 'Or total value', acquiredOn: 'Acquired on' };
// A bank deposit has no ticker, no units and no exchange quote, so the fields
// that ask for one come out of the FD form rather than sitting there optional.
const FD_SKIP = ['instrument', 'units', 'pricePerUnit', 'priceAuto'];

function formHtml(h, meta) {
  const rec = h || {};
  const isFd = rec.category === 'fixed_deposit';
  const fdDerived = isFd && rec.termMonths && rec.acquiredOn;
  const hints = isFd ? FD_HINTS : PLAIN_HINTS;
  const labels = isFd ? FD_LABELS : PLAIN_LABELS;
  return `
    <div class="field-row">
      ${field('Class *', select('category', meta.categories.map((c) => ({ value: c, label: meta.categoryLabels[c] })), rec.category || 'bank_account'))}
      ${field('Name *', input('name', rec.name, 'text', 'e.g. Sample Bank Savings'), 'Free-text label shown on the dashboard')}
    </div>
    <div class="field-row">
      ${field('Ticker / instrument', input('instrument', rec.instrument, 'text', 'e.g. NVDA, or a bond ISIN like IN0202310483'))}
      ${field('Institution / broker', input('institution', rec.institution))}
    </div>
    <div class="field-row">
      ${field('Country', select('country', COUNTRY_CODES.map((c) => ({ value: c, label: countryLabel(c) })), rec.country || 'IN'))}
      ${field('Currency the asset is held in', select('currency', meta.currencies, rec.currency || 'INR'))}
    </div>

    <div class="section-label">Valuation</div>
    <div class="field-set is-dense">
      ${field('Units / quantity', input('units', rec.units ?? '', 'number'), 'Leave blank for lump-sum deposits')}
      ${field('Price per unit', input('pricePerUnit', rec.pricePerUnit ?? '', 'number'), 'In the holding currency')}
      ${field(labels.valueNative, input('valueNative', rec.fdPrincipal ?? rec.nativeValue ?? rec.valueNative ?? '', 'number'), hints.valueNative)}
      ${field('Interest / coupon % p.a.', input('interestRatePct', rec.interestRatePct ?? '', 'number'), hints.interestRatePct)}
    </div>
    <p class="card-note" data-units-note>If both units and price are filled, value is computed as units × price and the total-value box is ignored.</p>

    <div class="field-set" data-fd-fields${isFd ? '' : ' hidden'}>
      ${field('Term (months)', input('termMonths', rec.termMonths ?? '', 'number'), fdHint(rec))}
      ${field('Renew at maturity', select('fdAutoRenew', [
        { value: '0', label: 'No — the deposit ends and its value stops growing' },
        { value: '1', label: 'Yes — start the same term again with the interest inside it' },
      ], rec.fdAutoRenew ? '1' : '0'), fdRenewalHint(rec))}
    </div>

    <div class="field-set">
      ${field('Live price feed', select('priceAuto', [
        { value: '1', label: 'Live — pull the latest exchange price' },
        { value: '0', label: 'Pinned — keep the price I type' },
      ], rec.priceAuto === false ? '0' : '1'), feedHint(rec))}
    </div>

    <div class="field-set" data-metal-fields${rec.category === 'gold_commodity' ? '' : ' hidden'}>
      ${field('Bullion rate', select('metalRate', metalOptions(meta), rec.metalRate || ''), metalHint(rec, meta))}
    </div>

    <div class="field-set">
      ${field(labels.acquiredOn, input('acquiredOn', rec.acquiredOn ?? '', 'date'), hints.acquiredOn)}
      ${field('Purchase cost', input('costNative', rec.costNative ?? '', 'number'), 'What you paid in total, in the holding currency')}
      ${field('Matures / redeems', fdDerived
        ? `<input name="maturityDate" type="date" value="${escapeHtml(rec.maturityDate || '')}" disabled>`
        : input('maturityDate', rec.maturityDate ?? '', 'date'),
        hints.maturityDate)}
      ${field('Liquidity', select('liquidityOverride', [
        { value: '', label: 'Auto (from class)' },
        { value: 'liquid', label: 'Liquid — reachable within a year' },
        { value: 'illiquid', label: 'Illiquid — locked or slow to sell' },
      ], rec.liquidityOverride ?? ''))}
    </div>

    <div data-india-fields${rec.country === 'IN' && rec.category !== 'liability' ? '' : ' hidden'}>
      <div class="section-label">India income and tax</div>
      <div class="field-set is-dense">
        <div data-dividend-field${rec.category === 'equity' ? '' : ' hidden'}>
          ${field('Dividend yield % p.a.', input('dividendYieldPct', rec.dividendYieldPct ?? '', 'number'), 'The tax page accrues dividends from this times the value in view')}
        </div>
        ${field('Tax treatment', select('indianTax', [
          { value: 'auto', label: 'Auto — an NRE or FCNR row is exempt, anything else is taxable' },
          { value: 'taxable', label: 'Taxable in India' },
          { value: 'exempt', label: 'Exempt — not taxed in India' },
        ], rec.indianTax || 'auto'), 'Overrides what the row\'s own name tells the tax page')}
      </div>
    </div>
    <p class="card-note">Cost and date together produce the gain, the per-annum rate and the Indian holding-period tax bucket shown on the table. Leave the cost blank for a lump-sum deposit you do not track that way.</p>
    ${field('Notes', `<textarea name="notes" placeholder="Nominee, lock-in terms, tax status…">${escapeHtml(rec.notes || '')}</textarea>`)}
  `;
}

function openForm(holding, ctx) {
  const meta = ctx.data.meta;
  openModal({
    title: holding ? `Edit — ${holding.name}` : 'Add holding',
    body: formHtml(holding, meta),
    hint: holding ? `Last valued at ${money(holding.valueINR || 0)}` : 'Stores into data/wealth-data.json',
    onSave: async (body) => {
      const form = readForm(body);
      if (!String(form.name || '').trim()) throw new Error('Name is required.');
      // A deposit is valued as a lump sum. Per-unit figures carried over from
      // another class would sit invisibly in hidden boxes and switch the
      // accrual off, so they are cleared on save.
      if (form.category === 'fixed_deposit') { form.units = null; form.pricePerUnit = null; }
      const hasUnits = form.units !== null && Number(form.units) > 0;
      const hasPrice = form.pricePerUnit !== null && Number(form.pricePerUnit) > 0;
      const hasValue = form.valueNative !== null;
      // Must match what server/lib/prices.js and metals.js accept, or a fund name
      // typed as a ticker would save as a ₹0 row the feed refuses to price. The
      // board comes off the front first: a quote site writes "BSE:<ticker>" and
      // an owner pastes that straight in.
      const bareTicker = String(form.instrument || '').trim().toUpperCase().replace(/^[A-Z]{2,3}\s*:\s*/, '');
      const tickerOk = /^[A-Z0-9][A-Z0-9._-]{1,14}$/.test(bareTicker);
      const willAutoPrice = (form.category === 'equity' && tickerOk && form.priceAuto !== '0')
        || (form.category === 'gold_commodity' && !!form.metalRate);
      if (hasUnits && !hasPrice && !hasValue && !willAutoPrice) {
        throw new Error('Units without a price leaves this holding worth ₹0 — enter a price per unit, add a ticker or pick a bullion rate, or put the total value in the "Or total value" box.');
      }
      const payload = { ...form };
      const saved = holding
        ? await ctx.mutate(() => api.updateHolding(holding.id, payload), `Updated ${form.name}`)
        : await ctx.mutate(() => api.createHolding(payload), `Added ${form.name}`);
      // Picking a bullion type should price the row there and then rather than
      // waiting for the next refresh: one card fetch, one write.
      const metalId = form.category === 'gold_commodity' && form.metalRate
        ? holding?.id || (saved?.holdings || []).find((h) => h.name === form.name)?.id
        : null;
      if (metalId) {
        try {
          const priced = await ctx.mutate(() => api.refreshPrices([metalId]));
          const r = priced?.priceResult || {};
          const hit = (r.updated || []).find((u) => u.id === metalId);
          const miss = (r.skipped || []).find((s) => s.id === metalId);
          if (hit) toast(`${form.name} priced at ₹${Number(hit.to).toLocaleString('en-IN')} per gram`, 'ok', 5000);
          else if (miss) toast(`Saved, but the price stayed yours: ${miss.reason}`, 'bad', 6000);
        } catch { /* mutate already toasted */ }
      }
      render(document.getElementById('view-holdings'), ctx);
    },
  });
  // The form is static markup, so the bullion selector, the FD term box and the
  // deposit wording are all swapped by hand when the class changes.
  const category = document.querySelector('#modal [name=category]');
  const country = document.querySelector('#modal [name=country]');
  const metalFields = document.querySelector('#modal [data-metal-fields]');
  const fdFields = document.querySelector('#modal [data-fd-fields]');
  const indiaFields = document.querySelector('#modal [data-india-fields]');
  const dividendField = document.querySelector('#modal [data-dividend-field]');
  const setHint = (name, text) => {
    const wrap = document.querySelector(`#modal [name="${name}"]`)?.closest('.field');
    if (!wrap) return;
    const hint = wrap.querySelector('.hint');
    if (!text) { if (hint) hint.remove(); return; }
    if (hint) hint.textContent = text;
    else wrap.insertAdjacentHTML('beforeend', `<span class="hint">${escapeHtml(text)}</span>`);
  };
  const setLabel = (name, text) => {
    const el = document.querySelector(`#modal [name="${name}"]`)?.closest('.field')?.querySelector('label');
    if (el) el.textContent = text;
  };
  const unitsNote = document.querySelector('#modal [data-units-note]');
  const syncFields = () => {
    const fd = category.value === 'fixed_deposit';
    metalFields.hidden = category.value !== 'gold_commodity';
    fdFields.hidden = !fd;
    const hints = fd ? FD_HINTS : PLAIN_HINTS;
    const labels = fd ? FD_LABELS : PLAIN_LABELS;
    for (const name of Object.keys(hints)) setHint(name, hints[name]);
    for (const name of Object.keys(labels)) setLabel(name, labels[name]);
    // A deposit has no ticker and no price per unit, so on this class those
    // boxes are not merely optional - they are not shown at all.
    for (const name of FD_SKIP) {
      const wrap = document.querySelector(`#modal [name="${name}"]`)?.closest('.field');
      if (wrap) wrap.hidden = fd;
    }
    if (unitsNote) unitsNote.hidden = fd;
    // The income fields the tax page reads only concern an Indian row, and a
    // dividend yield only an equity one.
    indiaFields.hidden = country.value !== 'IN' || category.value === 'liability';
    dividendField.hidden = category.value !== 'equity';
  };
  category.addEventListener('change', syncFields);
  country.addEventListener('change', syncFields);
  syncFields();
}
