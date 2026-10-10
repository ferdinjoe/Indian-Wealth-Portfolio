import { escapeHtml } from './format.js';

export function toast(message, kind = 'ok', ms = 3200) {
  const host = document.getElementById('toasts');
  const node = document.createElement('div');
  node.className = `toast is-${kind}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

export function html(strings, ...values) {
  return strings.reduce((out, str, i) => {
    const v = values[i - 1];
    if (i === 0) return str;
    if (v === null || v === undefined) return out + str;
    if (typeof v === 'object' && v.__raw) return out + v.value + str;
    if (Array.isArray(v)) return out + v.join('') + str;
    return out + escapeHtml(String(v)) + str;
  }, '');
}

export function raw(value) {
  return { __raw: true, value };
}

export function openModal({ title, body, onSave, saveLabel = 'Save', hint }) {
  const modal = document.getElementById('modal');
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-hint').textContent = hint || '';
  const save = document.getElementById('modal-save');
  save.textContent = saveLabel;
  modal.hidden = false;

  const close = () => {
    modal.hidden = true;
    save.onclick = null;
  };
  modal.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  save.onclick = async () => {
    save.disabled = true;
    try {
      await onSave?.(document.getElementById('modal-body'));
      close();
    } catch (err) {
      toast(err.message, 'bad', 5000);
    } finally {
      save.disabled = false;
    }
  };
  const first = modal.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 40);
  return { close };
}

export function field(label, control, hint) {
  return `<div class="field"><label>${label}</label>${control}${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
}

export function input(name, value, type = 'text', placeholder = '') {
  return `<input name="${name}" type="${type}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(placeholder)}">`;
}

export function select(name, options, selected) {
  const opts = options.map((o) => {
    const val = typeof o === 'string' ? o : o.value;
    const text = typeof o === 'string' ? o : o.label;
    return `<option value="${val}"${String(val) === String(selected ?? '') ? ' selected' : ''}>${text}</option>`;
  }).join('');
  return `<select name="${name}">${opts}</select>`;
}

export function readForm(root) {
  const out = {};
  root.querySelectorAll('[name]').forEach((el) => {
    if (el.type === 'checkbox') {
      const list = out[el.name] || (out[el.name] = []);
      if (el.checked) list.push(el.value);
      return;
    }
    out[el.name] = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
  });
  return out;
}

export function setBanner(list) {
  const host = document.getElementById('banner-zone');
  host.innerHTML = list.map((b) => `
    <div class="banner ${b.kind === 'error' ? 'is-error' : ''}">
      <span>${escapeHtml(b.text)}</span>
      ${b.action ? `<button class="btn btn-sm" data-banner-action="${b.action.id}">${escapeHtml(b.action.label)}</button>` : ''}
    </div>`).join('');
  host.querySelectorAll('[data-banner-action]').forEach((btn) => {
    btn.onclick = () => b_action(btn.dataset.bannerAction, host);
  });
}

// Banner actions are registered by app.js so views can stay declarative.
const actions = new Map();
export function registerBannerAction(id, fn) {
  actions.set(id, fn);
}
function b_action(id, host) {
  host.querySelectorAll('[data-banner-action]').forEach((b) => { b.disabled = true; });
  actions.get(id)?.();
}
