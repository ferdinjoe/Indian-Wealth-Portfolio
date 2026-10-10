const { get } = require('./httpget');
const { METAL_RATES } = require('./store');

// Chennai retail bullion card, published once a day and rebuilt by hand-written
// tables. The gold table is the only place that separates 22K from 24K per
// gram, so the parse leans on its structure rather than on a lucky regex.
const SOURCE_URL = process.env.WEALTH_METAL_RATES_URL
  || 'https://www.livechennai.com/gold_silverrate.asp';
const SOURCE_NAME = 'LiveChennai (Chennai retail, INR per gram)';

const LABELS = {
  gold22: { tag: '22K GOLD/G', text: '22K gold per gram' },
  gold24: { tag: '24K GOLD/G', text: '24K gold per gram' },
  silver: { tag: 'SILVER/G', text: 'silver per gram' },
};

// Gold barely stirs day to day, so a quarter off the last price means the page
// changed shape or a column was read from the wrong table - never apply it.
const MAX_MOVE = 0.25;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function text(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The first number in the cell, so a trailing "(0)" day-change annotation
// cannot be swallowed into the rate.
function parseMoney(cell) {
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(cell);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseDate(cell) {
  const m = /^(\d{1,2})\/([A-Za-z]{3})[a-z]*\/(\d{4})$/.exec(cell);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const pad = (v) => String(v).padStart(2, '0');
  return `${m[3]}-${pad(month)}-${pad(m[1])}`;
}

function tableBody(html, className) {
  const table = new RegExp(`<table[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/table>`, 'i').exec(html);
  if (!table) return null;
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(table[1]);
  if (!body) return null;
  for (const row of body[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => text(c[1]));
    if (cells.length) return cells;
  }
  return null;
}

// The per-gram and per-8-gram (and per-gram and per-kg) columns must agree. If
// they do not, the table was reordered or restyled, and guessing would price a
// person's gold off the wrong column.
function agrees(perUnit, bulk, times) {
  return perUnit !== null && bulk !== null && Math.abs(perUnit * times - bulk) <= bulk * 0.01;
}

function parseRates(html) {
  const rates = { gold22: null, gold24: null, silver: null, asOf: null };

  const gold = tableBody(html, 'gold-rates');
  if (!gold) throw new Error('metal rate page has no gold rate table');
  // Columns: date, 24K per gram, 24K per 8 gram, 22K per gram, 22K per 8 gram.
  const [gDate, g24, g24x8, g22, g22x8] = gold;
  rates.asOf = parseDate(gDate || '');
  const pure = parseMoney(g24 || '');
  const std = parseMoney(g22 || '');
  if (!agrees(pure, parseMoney(g24x8 || ''), 8) || !agrees(std, parseMoney(g22x8 || ''), 8)) {
    throw new Error('unexpected gold rate table layout');
  }
  rates.gold24 = pure;
  rates.gold22 = std;

  const silverRow = tableBody(html, 'silver-rates');
  if (silverRow) {
    const perGram = parseMoney(silverRow[1] || '');
    if (agrees(perGram, parseMoney(silverRow[2] || ''), 1000)) rates.silver = perGram;
    if (!rates.asOf) rates.asOf = parseDate(silverRow[0] || '');
  }

  if (!rates.gold22 && !rates.gold24 && !rates.silver) throw new Error('no usable rates on the metal rate page');
  return rates;
}

async function fetchRates() {
  const html = await get(SOURCE_URL, { label: 'metal rate page', expect: 'text', timeoutMs: 10000 });
  return parseRates(html);
}

// Only the bullion class, so a metalRate left behind when a row is switched to
// another class cannot keep re-pricing it from the gold card.
const METAL_CATEGORY = 'gold_commodity';

function isTrackable(holding) {
  return holding.category === METAL_CATEGORY && !!holding.metalRate;
}

// Same shape as prices.applyQuotes: pure, annotates the rows it is handed, and
// leaves persistence to the caller so the whole batch lands in one write.
function applyRates(holdings, rates) {
  const updated = [];
  const skipped = [];
  for (const h of holdings) {
    const key = h.category === METAL_CATEGORY && METAL_RATES.includes(h.metalRate) ? h.metalRate : null;
    if (!key) continue;
    const label = LABELS[key];
    if (h.currency && h.currency !== 'INR') {
      skipped.push({ id: h.id, name: h.name, symbol: label.tag, reason: `Chennai rates are INR per gram, holding is ${h.currency}` });
      continue;
    }
    if (!(Number.isFinite(h.units) && h.units > 0)) {
      skipped.push({ id: h.id, name: h.name, symbol: label.tag, reason: 'no grams recorded in Units' });
      continue;
    }
    const price = rates[key];
    if (!price) {
      skipped.push({ id: h.id, name: h.name, symbol: label.tag, reason: `no ${label.text} rate on the page` });
      continue;
    }
    // A price tagged with a different metal is not a market move: switching a
    // row from 22K gold to silver is deliberate, so it must not trip the guard.
    // An untagged hand-typed price, or one tagged with this same metal, still
    // guards - that is how a redesigned page gets caught.
    const previous = Number.isFinite(h.pricePerUnit) && h.pricePerUnit > 0
      && (h.priceSymbol === null || h.priceSymbol === label.tag)
      ? h.pricePerUnit : null;
    if (previous !== null && Math.abs(price / previous - 1) > MAX_MOVE) {
      skipped.push({ id: h.id, name: h.name, symbol: label.tag, reason: `implausible move ${previous} -> ${price}`, needsReview: true });
      continue;
    }
    if (price === previous && rates.asOf === h.priceAsOf) continue; // nothing moved

    h.pricePerUnit = price;
    h.valueNative = Math.round(h.units * price * 100) / 100;
    h.priceSymbol = label.tag;
    h.priceAsOf = rates.asOf;
    updated.push({ id: h.id, name: h.name, symbol: label.tag, from: previous, to: price, asOf: rates.asOf });
  }
  return { updated, skipped };
}

module.exports = { SOURCE_URL, SOURCE_NAME, LABELS, MAX_MOVE, parseRates, fetchRates, isTrackable, applyRates };
