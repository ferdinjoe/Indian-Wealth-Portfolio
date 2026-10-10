const { get } = require('./httpget');

// Only classes where an exchange prints a per-unit price. Deposits, bonds,
// policies and physical gold stay owner-valued - feeding a ticker into those
// would silently replace a real number with an unrelated one.
const AUTO_CATEGORIES = new Set(['equity']);

// The listing currency picks the exchange, not the country field: a US stock
// held through a Singapore broker is still quoted in USD on the NYSE, and
// suffixing it .SI would price it off the wrong board. An unmapped currency
// falls back to the bare ticker, where applyQuotes' currency check rejects a
// mismatched feed instead of mispricing the row.
const SUFFIX = { USD: '', SGD: '.SI', INR: '.NS', THB: '.BK' };

// A jump this large is far more likely to be a wrong symbol or an unadjusted
// split than a real move, so it gets flagged for a human instead of applied.
const MAX_MOVE = 0.5;

// India prints most listings on both boards, and the BSE-only ones - small firms
// quoted on no other market - have no NSE quote at all. So a rupee row tries NSE
// first, where the market's depth is, and only a miss there is retried on BSE. A
// ticker whose own text names a board is never second-guessed.
const ALTERNATES = { INR: '.BO' };

// The same board named the other way round: "BSE:<ticker>" is how a quote site
// writes a listing, and an owner copying from there pastes the tag in. A tag we
// don't know (MCX:, NFO:) only costs its own text - the ticker part is
// still priced off the currency guess.
const PREFIX = { BSE: '.BO', NSE: '.NS' };

const BATCH = 5;

// The ticker as its owner wrote it, with any board tag peeled off the front.
function parseTicker(holding) {
  // Trim only the ends. A real symbol has no interior space, so leaving them in
  // makes "Nifty 50 Index" fail the guard below instead of becoming NIFTY50INDEX.
  const raw = String(holding.instrument || '').trim().toUpperCase();
  const tag = /^([A-Z]{2,3})\s*:\s*(.+)$/.exec(raw);
  const ticker = (tag ? tag[2] : raw).trim();
  // Two characters minimum: a stray "0" is junk, not a listing, and the feed
  // would happily return some unrelated symbol for it.
  if (!/^[A-Z0-9][A-Z0-9._-]{1,14}$/.test(ticker)) return null;
  return { ticker, board: tag ? PREFIX[tag[1]] || null : null };
}

// Whichever way they wrote it, a ticker that names its own board is their call:
// neither the currency guess nor the second-board retry overrides it.
function namesBoard(parsed) {
  return Boolean(parsed.board) || parsed.ticker.includes('.');
}

function resolveSymbol(holding) {
  const parsed = parseTicker(holding);
  if (!parsed) return null;
  if (parsed.board) return parsed.ticker + parsed.board;
  if (parsed.ticker.includes('.')) return parsed.ticker; // already qualified
  return withCurrency(parsed.ticker, holding);
}

function withCurrency(ticker, holding) {
  const suffix = SUFFIX[String(holding.currency || '').toUpperCase()];
  return suffix === undefined ? ticker : ticker + suffix;
}

// The second board to try for this row, or null when there is none.
function alternateSymbol(holding) {
  const parsed = parseTicker(holding);
  // Junk ticker, nothing to fall back on; or their own text already said BSE or
  // NSE, and a second guess would contradict them.
  if (!parsed || namesBoard(parsed)) return null;
  const alt = ALTERNATES[String(holding.currency || '').toUpperCase()];
  // Suffix the bare ticker, never the resolved symbol - putting .BO on a symbol
  // that already reads <ticker>.NS would ask Yahoo for a listing on no board.
  return alt ? parsed.ticker + alt : null;
}

function alternatesFor(holdings) {
  const map = new Map();
  for (const h of holdings) {
    const alt = alternateSymbol(h);
    if (alt) map.set(resolveSymbol(h), alt);
  }
  return map;
}

function isTrackable(holding) {
  return AUTO_CATEGORIES.has(holding.category) && holding.priceAuto !== false && !!resolveSymbol(holding);
}

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const data = await get(url);
  const meta = data?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`no usable price for ${symbol}`);
  const stamp = Number(meta.regularMarketTime);
  return {
    symbol,
    price,
    currency: String(meta.currency || '').toUpperCase() || null,
    asOf: Number.isFinite(stamp) ? new Date(stamp * 1000).toISOString().slice(0, 10) : null,
  };
}

// Fetches one quote per distinct symbol, in small batches so a ledger with a
// dozen positions does not take a dozen round trips serially. A failed symbol
// is reported, never guessed at - except a rupee row's second board, which is
// the same company on the other exchange and so is worth the retry.
async function fetchQuotes(symbols, { alternates = null, fetchOne = fetchQuote } = {}) {
  const quotes = new Map();
  const errors = {};
  const run = async (list) => {
    for (let i = 0; i < list.length; i += BATCH) {
      const settled = await Promise.allSettled(list.slice(i, i + BATCH).map(fetchOne));
      settled.forEach((r, j) => {
        const symbol = list[i + j];
        if (r.status === 'fulfilled') quotes.set(symbol, r.value);
        else errors[symbol] = r.reason.message;
      });
    }
  };

  const unique = [...new Set(symbols)];
  await run(unique);
  const asked = new Set(unique);

  // Only the misses are re-asked, so a normal Indian ledger costs exactly the
  // requests it always did.
  const retry = unique.filter((s) => errors[s] && alternates?.has(s));
  if (!retry.length) return { quotes, errors };
  const second = new Map(retry.map((s) => [alternates.get(s), s]));
  await run([...second.keys()]);
  for (const [alt, primary] of second) {
    const q = quotes.get(alt);
    // Another row may have asked for that board by name, so its own entry stays.
    if (!asked.has(alt)) quotes.delete(alt);
    if (q) {
      quotes.set(primary, q); // q.symbol still names the board that printed it
      delete errors[primary];
    } else {
      errors[primary] = `${errors[primary]}; ${alt} too: ${errors[alt]}`;
    }
    delete errors[alt];
  }
  return { quotes, errors };
}

// Decides, per holding, whether a fetched quote may be written in. Pure: it
// only annotates the rows it is handed, so the caller controls persistence and
// the whole batch lands in one write.
function applyQuotes(holdings, feed) {
  const { quotes, errors = {} } = feed;
  const updated = [];
  const skipped = [];
  for (const h of holdings) {
    if (!AUTO_CATEGORIES.has(h.category)) continue;
    const symbol = resolveSymbol(h);
    if (!symbol) continue;
    if (h.priceAuto === false) {
      skipped.push({ id: h.id, name: h.name, symbol, reason: 'pinned' });
      continue;
    }
    const q = quotes.get(symbol);
    if (!q) {
      skipped.push({ id: h.id, name: h.name, symbol, reason: errors[symbol] || 'no quote' });
      continue;
    }
    if (q.currency && h.currency && q.currency !== h.currency) {
      skipped.push({ id: h.id, name: h.name, symbol, reason: `feed says ${q.currency}, holding is ${h.currency}` });
      continue;
    }
    const previous = Number.isFinite(h.pricePerUnit) && h.pricePerUnit > 0 ? h.pricePerUnit : null;
    if (previous !== null && Math.abs(q.price / previous - 1) > MAX_MOVE) {
      skipped.push({ id: h.id, name: h.name, symbol, reason: `implausible move ${previous} -> ${q.price}`, needsReview: true });
      continue;
    }
    if (q.price === previous && q.asOf === h.priceAsOf) continue; // nothing moved

    h.pricePerUnit = q.price;
    // Multiplying an absent unit count would zero out a hand-entered total.
    if (Number.isFinite(h.units) && h.units > 0) h.valueNative = round2(h.units * q.price);
    // Whichever board answered is the one worth naming on the row.
    h.priceSymbol = q.symbol || symbol;
    h.priceAsOf = q.asOf;
    updated.push({ id: h.id, name: h.name, symbol: h.priceSymbol, from: previous, to: q.price, asOf: q.asOf });
  }
  return { updated, skipped };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  AUTO_CATEGORIES, SUFFIX, ALTERNATES, MAX_MOVE,
  resolveSymbol, alternateSymbol, alternatesFor, isTrackable, fetchQuotes, applyQuotes,
};
