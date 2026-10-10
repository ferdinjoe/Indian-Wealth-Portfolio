const { get } = require('./httpget');

// IndiaBonds publishes its whole current offering as one server-rendered
// directory page: one card per listed lot, each carrying its ISIN, coupon,
// maturity, yield and the price of a single bond. There is no quote endpoint,
// so the card markup is the API - which means a redesign has to fail loudly
// rather than price someone's bonds off the wrong column.
const SOURCE_URL = process.env.WEALTH_BOND_DIRECTORY_URL
  || 'https://www.indiabonds.com/bond-directory/';
const SOURCE_NAME = 'IndiaBonds (listed bond directory, INR per bond)';

// A bond moves a few points over its life, so a quarter off the last price means
// the page changed shape or a card was read from the wrong field.
const MAX_MOVE = 0.25;

// Retail bond lots in India are a power of ten apart, so a price sitting within
// 30% of one of them identifies the denomination it is quoted against.
const FACE_LOTS = [1_000, 10_000, 1_00_000, 10_00_000];

const ISIN_SHAPE = /\bIN[0-9A-Z]{10}\b/;
const CARD_TAG = '<div class="container bond-card-wrapper company-block">';

function span(seg, name) {
  const m = new RegExp(`class="${name}"[^>]*>([\\s\\S]*?)<\\/span>`).exec(seg);
  return m ? m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
}

function number(text) {
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(String(text || '').replace(/\s/g, ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function priceOf(seg) {
  const block = /<p class="info-title[^"]*">\s*Price\s*<\/p>\s*<p class="info-value[^"]*">([\s\S]*?)<\/p>/.exec(seg);
  return block ? number(block[1].replace(/<[^>]*>/g, ' ')) : null;
}

// A bond trades close to par, so the lot whose size sits within 30% of the price
// is the one the price is quoted against.
function inferFace(price) {
  for (const lot of FACE_LOTS) {
    const ratio = price / lot;
    if (ratio >= 0.7 && ratio <= 1.3) return lot;
  }
  return null;
}

function parseCards(html) {
  const cards = [];
  for (const seg of String(html).split(CARD_TAG).slice(1)) {
    const isin = span(seg, 'bondISIN');
    if (!ISIN_SHAPE.test(isin)) continue;
    const price = priceOf(seg);
    if (!price) continue;
    cards.push({
      isin: ISIN_SHAPE.exec(isin)[0],
      issuer: span(seg, 'bondIssuer') || null,
      couponPct: number(span(seg, 'bondCoupon')),
      yieldPct: number(span(seg, 'bondYield')),
      maturityLabel: span(seg, 'bondMaturity') || null,
      vendorId: span(seg, 'bondVendorId') || null,
      priceINR: price,
      faceINR: inferFace(price),
    });
  }
  return cards;
}

// One quote per ISIN. The same issue is often listed at several lot sizes, and
// the smallest is the one a holder can actually count in, so it wins.
function byIsin(cards) {
  const map = new Map();
  for (const card of cards) {
    const keep = map.get(card.isin);
    if (!keep) { map.set(card.isin, card); continue; }
    if (card.faceINR && (!keep.faceINR || card.faceINR < keep.faceINR)) map.set(card.isin, card);
  }
  return map;
}

function parseQuotes(html) {
  const cards = parseCards(html);
  if (!cards.length) throw new Error('bond directory page has no readable bond cards');
  const quotes = byIsin(cards);
  // Every card priced at an implausible distance from par means the price column
  // was read from somewhere else on the page, not that the market moved.
  const offPar = [...quotes.values()].filter((q) => !q.faceINR).length;
  if (offPar === quotes.size) throw new Error('bond directory prices are not near par');
  return { quotes, count: quotes.size, cards: cards.length };
}

async function fetchQuotes() {
  const html = await get(SOURCE_URL, {
    label: 'bond directory page',
    expect: 'text',
    timeoutMs: 20000,
    maxBytes: 4e6,
  });
  const parsed = parseQuotes(html);
  return { ...parsed, asOf: new Date().toISOString().slice(0, 10) };
}

function findIsin(holding) {
  const text = `${holding.priceSymbol || ''} ${holding.instrument || ''} ${holding.name || ''}`;
  const m = ISIN_SHAPE.exec(text.toUpperCase());
  return m ? m[0] : null;
}

// Only the bond class, so an ISIN left behind when a row becomes something else
// cannot keep re-pricing it from the bond card.
function isTrackable(holding) {
  return holding.category === 'bond' && holding.priceAuto !== false && !!findIsin(holding);
}

// Same shape as prices.applyQuotes and metals.applyRates: pure, annotates the
// rows it is handed, and leaves persistence to the caller.
function applyQuotes(holdings, result) {
  const updated = [];
  const skipped = [];
  for (const h of holdings) {
    if (h.category !== 'bond') continue;
    const isin = findIsin(h);
    if (!isin) continue;
    if (h.priceAuto === false) {
      skipped.push({ id: h.id, name: h.name, symbol: isin, reason: 'automatic pricing is switched off on this row' });
      continue;
    }
    if (h.currency && h.currency !== 'INR') {
      skipped.push({ id: h.id, name: h.name, symbol: isin, reason: `IndiaBonds quotes in rupees, holding is ${h.currency}` });
      continue;
    }
    const quote = result.quotes.get(isin);
    if (!quote) {
      skipped.push({ id: h.id, name: h.name, symbol: isin, reason: `not among the ${result.count} issues IndiaBonds lists today` });
      continue;
    }
    // Units are how many bonds the holder owns, and the card prices one bond of
    // a stated face - without the count there is nothing to multiply.
    if (!(Number.isFinite(h.units) && h.units > 0)) {
      skipped.push({ id: h.id, name: h.name, symbol: isin, reason: 'no bond count recorded in Units' });
      continue;
    }
    const price = quote.priceINR;
    // A row tagged with another ISIN, or with no tag at all, is a hand-typed
    // price; a row already tagged with this ISIN is a real previous quote.
    const previous = Number.isFinite(h.pricePerUnit) && h.pricePerUnit > 0
      && (h.priceSymbol === null || h.priceSymbol === quote.isin)
      ? h.pricePerUnit : null;
    if (previous !== null && Math.abs(price / previous - 1) > MAX_MOVE) {
      skipped.push({ id: h.id, name: h.name, symbol: quote.isin, reason: `implausible move ${previous} -> ${price}`, needsReview: true });
      continue;
    }
    if (price === previous && result.asOf === h.priceAsOf && quote.couponPct === h.interestRatePct) continue;

    h.pricePerUnit = price;
    h.valueNative = Math.round(h.units * price * 100) / 100;
    h.priceSymbol = quote.isin;
    h.priceAsOf = result.asOf;
    h.bondFaceINR = quote.faceINR;
    h.bondYieldPct = quote.yieldPct;
    // A row with no coupon has no income line on the tax page; the directory's
    // is the issuer's own rate, so it fills the gap without overwriting a stated
    // one.
    const couponFilled = !(Number(h.interestRatePct) > 0) && quote.couponPct > 0;
    if (couponFilled) h.interestRatePct = quote.couponPct;
    updated.push({
      id: h.id, name: h.name, symbol: quote.isin, from: previous, to: price,
      asOf: result.asOf, issuer: quote.issuer, couponFilled,
    });
  }
  return { updated, skipped };
}

module.exports = {
  SOURCE_URL, SOURCE_NAME, MAX_MOVE, FACE_LOTS, ISIN_SHAPE,
  parseQuotes, fetchQuotes, findIsin, isTrackable, applyQuotes,
};
