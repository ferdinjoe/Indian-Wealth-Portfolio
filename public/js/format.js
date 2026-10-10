const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const west = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const west2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', SGD: 'S$', THB: '฿', EUR: '€', GBP: '£', AED: 'AED ', AUD: 'A$', CAD: 'C$', CHF: 'CHF', JPY: '¥', MYR: 'RM ', HKD: 'HK$' };

export const COUNTRY_FLAGS = { IN: '🇮🇳', TH: '🇹🇭', SG: '🇸🇬', US: '🇺🇸', AE: '🇦🇪', GB: '🇬🇧', EU: '🇪🇺', AU: '🇦🇺', CA: '🇨🇦', CH: '🇨🇭', JP: '🇯🇵', MY: '🇲🇾', HK: '🇭🇰' };
export const COUNTRY_NAMES = { IN: 'India', TH: 'Thailand', SG: 'Singapore', US: 'United States', AE: 'UAE', GB: 'United Kingdom', AU: 'Australia', CA: 'Canada', CH: 'Switzerland', JP: 'Japan', MY: 'Malaysia', HK: 'Hong Kong' };

export function money(value) {
  return `₹${inr.format(Math.round(Number(value) || 0))}`;
}

export function money2(value) {
  return `₹${inr2.format(Number(value) || 0)}`;
}

export function native(value, currency) {
  const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${sym}${plain.format(Number(value) || 0)}`;
}

// An INR figure restated in another currency. Lakh-style grouping belongs on
// rupees only - "$12,34,567" is unreadable - and paise-level decimals on a
// crore-sized amount are noise, so they appear only under a thousand.
export function converted(value, code) {
  const n = Number(value) || 0;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (code === 'INR') return `${sign}₹${inr.format(Math.round(a))}`;
  const sym = CURRENCY_SYMBOLS[code] ?? `${code} `;
  return `${sign}${sym}${a >= 1000 ? west.format(a) : west2.format(a)}`;
}

// Indian readers think in lakh/crore, so headline figures use that scale while
// table cells keep the full grouped number.
export function shortINR(value) {
  const n = Number(value) || 0;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e7) return `${sign}₹${trim(a / 1e7)} Cr`;
  if (a >= 1e5) return `${sign}₹${trim(a / 1e5)} L`;
  if (a >= 1e3) return `${sign}₹${trim(a / 1e3)} K`;
  return `${sign}₹${Math.round(a)}`;
}

function trim(n) {
  return Number(n.toFixed(2)).toString();
}

export function pct(value, digits = 1) {
  const n = Number(value) || 0;
  return `${n >= 0 ? '' : '-'}${Math.abs(n).toFixed(digits)}%`;
}

export function num(value) {
  return plain.format(Number(value) || 0);
}

export function countryLabel(code) {
  const flag = COUNTRY_FLAGS[code] || '🏳️';
  return `${flag} ${COUNTRY_NAMES[code] || code || '—'}`;
}

export function countryShort(code) {
  return `${COUNTRY_FLAGS[code] || ''} ${code}`.trim();
}

export function ageFrom(dob, on = new Date()) {
  if (!dob) return null;
  const b = new Date(dob);
  if (Number.isNaN(b.getTime())) return null;
  let age = on.getFullYear() - b.getFullYear();
  const m = on.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && on.getDate() < b.getDate())) age -= 1;
  return age;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function titleCase(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
