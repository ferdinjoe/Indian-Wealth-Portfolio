# Wealth Ledger

**Your whole net worth, in one JSON file, on your own machine.**

A local web app that consolidates a scattered portfolio — bank accounts and fixed deposits in one
country, shares in another, gold, a pension scheme, a mortgage — into a single figure, and then
answers the questions that figure exists to answer: what has this money actually returned, is it
allocated the way I intend, how far is it from the corpus I need, and what does this financial
year's tax look like?

No database, no accounts, no sync service, no build step. The state of the application is one
readable file in this folder, and the entire calculation is plain JavaScript you can open in an
editor.

## Run it

**Windows: double-click `start-wealth-ledger.bat`.** No terminal, nothing to install by hand. It finds
Node, runs `npm install` the one time a freshly unzipped folder needs it, starts the server if nothing
is already answering on the port, waits for it to come up, and opens the app in your default browser.
The small minimized window titled **Wealth Ledger** is the server: leave it alone while you work and
close it to stop the app. Double-clicking again while it runs just opens the tab, rather than starting
a second server over the same data file.

On any system, from a terminal:

```bash
npm install
npm start        # http://localhost:3000
```

Node 20 or newer (developed on 24). Works on Windows, macOS and Linux; the phone and launcher
sections are Windows-specific.

Open `http://localhost:3000` and every tab has numbers in it: this copy ships a **generated sample
portfolio** — 44 positions across India, Thailand, Singapore and the US, in INR, THB, SGD and USD,
with goals and target weights attached to them. It is produced by `server/lib/seed.js`, and every
bank, broker, insurer, jeweller, property, loan, amount and date in it is made up for that file —
none of it is anybody's real money, anonymised or otherwise. The only real-world names left are
publicly listed tickers (NVIDIA, Apple, TCS) and statutory scheme names (EPF, PPF, NPS, CPF), which
the price feeds and the India tax engine need in order to have something to chew on.
**Settings → Wipe everything** is the expected first click once you want your own ledger. Wiping and
reseeding both keep a dated copy of the state they destroy, so even that is reversible.

---

## What it does

| Tab | The question it answers |
| --- | --- |
| **Dashboard** | What is my net worth, in five currencies, and which direction is it moving? |
| **Holdings** | Every position: add, edit, delete, price, and section by asset type or broker |
| **Wealth Analytics** | What does each asset become if I compound it, year by year, to 2041? |
| **Allocation & risk** | How far am I from my target weights, and in rupees? |
| **Portfolio health** | Everything in the book that is thin, as a scored rule list |
| **Goals** | Will this money be there on the date I need it? |
| **Retirement** | What corpus do I need, where am I heading, and what closes the gap? |
| **India Tax** | Interest and dividends accrued this financial year, TDS, both regimes |
| **Profile** | Age, income, spending, EMIs, surplus — the inputs the models read |
| **Settings** | Assumptions, targets, FX pins, phone access, and your data |
| **Generate PDF Report** | The whole ledger as one A4 PDF, optionally emailed |

It is deliberately India-first on the currencies (INR is the reporting base, with lakh and crore
grouping) and country-agnostic on the assets: a holding carries its own country and currency, and
rates resolve per row.

## Tracking a position

Ten asset classes: bank accounts, fixed deposits, equity, bonds, investment policies, gold &
commodities, real estate, pension schemes, other assets, and liabilities. A liability subtracts
from net worth rather than being a note somewhere else.

A holding is valued three ways, and the app is explicit about which one it used:

- a **lump sum** you type;
- **units × price per unit** — fill both and the product wins, which is what shares and gold want;
- a **fixed deposit**, where you enter principal, rate, deposit date and term, and the worth
  accrues quarterly from the date of deposit, caps at maturity, and can renew itself term after
  term with the interest reinvested.

Recording a **purchase cost** and **acquired on** date switches on the returns columns: total gain,
gain percentage, the annualised rate that implies, and the Indian holding-period bucket (LTCG/STCG)
the gain would fall in. Across the portfolio those lots aggregate into a money-weighted return
(XIRR), solved with Newton's method and a bisection fallback. Returns are computed in each asset's
own currency and cost is converted at today's rate, so a rupee that weakens against the dollar
raises net worth without being reported as an investment return.

## Live prices, without handing anyone your portfolio

Three public sources, each on its own path, each cached:

- **Exchange rates** from the ECB reference list, on startup and every 12 hours.
- **Equity quotes** from Yahoo Finance, for any equity row carrying a ticker — on demand from the
  holdings toolbar, on startup if the last pull is older than six hours, and every six hours while
  the app is open. Indian tickers fall back onto the BSE board when the NSE one has no quote.
- **Bullion** per-gram rates for 22K, 24K and silver, and **bond** prices by ISIN, both from public
  listing pages that are parsed on your machine.

Resolution order is *manual pin → cached live rate → bundled default*, and the UI names which one is
in effect, because a fallback rate is stale by definition. A currency with no rate at all is
**excluded** from net worth and flagged in a red banner rather than quietly counted as zero. The
quote paths carry guards: implausible moves are refused not written, a currency mismatch is skipped,
a pinned row is left alone, and a dead rate site costs the other feeds nothing, because the three
fetches are settled independently.

What those requests reveal is the honest question for a financial tool, so it is stated here: the FX
call sees only standard currency codes, the equity call sees only the tickers you typed into your
own holdings, and the bullion and bond calls see nothing but a request for the site's public page.
**No amount, name or portfolio detail ever leaves the machine.** There is no analytics, no
background send, and the app works fully offline on cached values. The one exception is a switch you
have to throw: the PDF report's SMTP card, which posts the report through a mail server *you*
configured, only when you click email.

## Back up, erase, restore

Everything under **Settings**, and the reason this section exists is that wiping a ledger you have
not exported is unrecoverable:

- **Download JSON** hands over the exact bytes the server is running on.
- **Import from file** replaces the ledger with a file, after taking a dated copy of what it is
  about to displace.
- **Make a safe copy now** writes a dated, never-overwritten full snapshot into `data/backups/`.
- **Wipe everything** and **Reload sample data** are both destructive, so both keep a copy of the
  state they are about to destroy first, and the message that follows names the copy it kept.

The list renders newest-first with the holdings and goal counts, the reason, and the time each copy
was taken, and any copy can be **restored** or **forgotten** from there. The newest 24 are kept,
which the server reports rather than the front end assuming. A copy that fails to parse is listed
and marked, then refused rather than half-restored.

## Where your data lives

```
data/wealth-data.json          the ledger — holdings, profile, rates, snapshots
data/wealth-data.backup.json   the previous state, rewritten on every save
data/backups/                  dated full copies, never overwritten
```

All three are git-ignored, because a real ledger must never reach a repository. This copy still
opens populated: the archive ships `data/wealth-data.json` as the generated sample portfolio, and the
same bytes are committed as `sample-data.json` for anyone reading the repository rather than running
it — that file goes through **Settings → Import from file** like any other export. Delete
`data/wealth-data.json` and you have an empty ledger of your own. The ledger is written atomically (temp file, then rename) and the prior
version is copied to the backup first, so a crash mid-write cannot leave a half-written file. If the
JSON is unparseable the app **refuses to start** and tells you where the file is, rather than
overwriting it.

## Planning maths

**Retirement** answers the two questions side by side: the corpus you need (monthly retirement
spending inflated to your retirement age, discounted across the drawdown years, plus a buffer), and
where you are heading (current net worth at the pre-retirement return, with the monthly surplus
escalated by salary growth). The difference is the gap in nominal rupees and in today's purchasing
power, with the extra monthly top-up that closes it and the age at which you would be financially
free. Plan A and Plan B are plotted together, so a shortfall is the curve crossing below zero.

**Cash flow & financial independence** works from income, spending and EMIs instead of a retirement
date: the savings rate against the rate actually recorded as invested (the difference is cash
sitting idle), the FIRE number at 25× committed annual outflow, the age your current habits reach
it, and coast FIRE — the smaller corpus that, left untouched, still grows into the FIRE number by
your planned retirement age.

**Portfolio health** scores six components — growth assets against your age, allocation discipline,
debt load, diversification, emergency cover, country spread — each stating the number behind it.
Missing cost-basis data is kept *out* of the score, because that is a bookkeeping gap rather than a
portfolio problem, and reported separately as a coverage figure.

**Wealth Analytics** projects each holding rather than one total: a grid of asset × year from 2027 to
2041, each row growing at the best rate the ledger actually knows (measured, then the rate the row
pays, then the assumed rate), with the chip naming which it used and admitting it when a measured
rate had to be clamped — history is never extrapolated past −15% to +30% a year, so a one-off 140%
run cannot be compounded for fifteen years. Liabilities are held flat, because debt falls as you pay
it down and not as markets move. No contributions, no withdrawals, no inflation: the page says all
three.

**The wealth bands** put the conventional Indian private-bank ladder on the headline figure — Mass
Affluent ₹25 L–₹50 L, Emerging HNI to ₹5 Cr, HNI to ₹25 Cr, VHNI to ₹100 Cr, UHNI above — and price
the next two levels rather than describing them: rupees still to earn, the year and age the current
pace arrives, what market growth alone would take, and the monthly investing that would land it
inside five or ten years. A trajectory that never arrives inside the horizon says *not within 30
years* rather than inventing a year. The bands are measured on **net worth** where a bank would
quote *investable* assets, so the comparison is indicative, not official.

**India income and tax** reads the Indian-side rows and ignores everything else, on the current
financial year (1 April → 31 March), and reports per holding both the interest or dividends accrued
*to date* and the full-year projection — which is why a deposit opened in June counts for eight
months, not twelve. NRE and FCNR(B) interest is booked exempt on the strength of the row's own name,
institution or notes; savings and FD interest is pooled against one section 194A threshold
(₹50,000, ₹1,00,000 for a senior citizen) the way the law looks at deposits in aggregate; bond TDS is
read off the ISIN family, so a G-Sec or SDL is spared and a corporate bond or NCD is taxed at the
rate you set. Slab tax computes under both regimes with the surcharge ladder, the 4% cess, the
standard deduction, the 87A rebate and 80TTB, and flags the cheaper one with the rupees it saves. TDS
already deducted counts as tax paid, so the page reports a balance due or a refund rather than a
fresh demand. Every rate is editable. It is an estimate built from your own numbers, not tax advice:
it cannot see your residential status, Form 16, capital gains or a DTAA rate, and the page lists
those limits rather than hiding them.

## On your phone

The app runs on the machine holding the file and the phone opens the **same ledger over your
network** — no second copy, no sync engine, so an edit saved on either screen is on the other the
moment it saves. That is what makes two devices honest about one net worth.

**Settings → Phone access** is off by default, and everything below is decided by that one switch:

- Requests from the machine itself (`127.0.0.1`, `::1`) go straight through, so the laptop is never
  locked out. `server/lib/access.js` gates every other peer and is mounted ahead of the static files
  and every route, so an unverified address fetches no JS module, no `/api/state`, no figure.
- A phone enters the PIN once and then holds an HttpOnly cookie for 180 days: an HMAC over its
  expiry keyed by `sha256(pinHash + epoch)` — never the PIN. Changing the PIN or signing every phone
  out rotates the epoch and invalidates every earlier cookie. Wrong attempts are counted per address;
  six and that address waits 60 seconds, because the most likely author of the sixth is a thumb.
- The PIN is stored salted and hashed, and neither value ever leaves the server: `/api/state`
  reports `hasPin: true` and nothing else.
- Installing it as an app needs https, and `http://192.168.x.x` is insecure however local it is.
  `make-phone-cert.ps1` mints a private CA and a certificate for the machine's own LAN addresses into
  `certs/` (git-ignored, keys and all), and the server then listens on **3443** beside 3000 with the
  same Express app and the same gate.
- Offline, the phone shows a reading rather than a second ledger. Every successful load is also kept
  on the device; when the machine is asleep the app opens on that copy with a banner naming its age,
  and **edits are refused instead of queued** — a write the phone holds while the laptop moves on is
  exactly the disagreement this design exists to avoid. A copy older than 72 hours is not shown at all.
- The service worker caches the shell only (HTML, CSS, modules, icons, manifest) and never `/api/*`,
  so no cache can hand back a stale balance. The test suite fails if a file under `public/` is
  missing from that precache list.

`phone-setup.ps1` opens ports 3000 and 3443 in Windows Firewall, scoped to **the network category
you are connected to right now**, so the machine does not arrive at a cafe with the ledger exposed.

**This repository is the web app.** Wrapping the page as a Trusted Web Activity `.apk` needs a JDK 17
and the Android SDK, so the builder script that does it is deliberately not published here, and the
phone path ends at the https home-screen install. The server does keep answering
`/.well-known/assetlinks.json` — the statement a wrapped build would present to Chrome — and
**Settings → Phone access** still has the box to record one, because anyone who does build a wrapper
against their own copy needs both.

## Tests

```bash
npm test        # 212 critical-path scenarios, ~7 seconds
```

The suite boots its own server on port 3100 against a synthetic ledger in `test/.sandbox/`. It never
reads or writes `data/wealth-data.json` for anything but a checksum: the file is hashed before and
after and a scenario fails if one byte moved. The fixture portfolio has known arithmetic (₹73.83 L
gross, ₹30 L debt, ₹43.84 L net worth), so a wrong total is a failure rather than a plausible-looking
number.

Coverage is where the maths is: atomic writes and the corrupt-file guard, the FX resolution chain,
all three price feeds including a dead site costing the others nothing, valuation and aggregation,
fixed-deposit accrual and renewal, holdings CRUD and bulk delete, the type tabs and broker sections,
XIRR and tax buckets, allocation and health scoring, goals, the retirement and FIRE maths, the India
income engine (financial-year windows, pro-rata rows, the pooled 194A threshold, both slabs), the
wealth bands, the five-currency restatement, the per-asset projection, the phone half (a peer that is
not this machine reaching nothing but a lock page, the PIN throttle, the cookie binding, the precache
list, the stylesheet keeping one column at 390px), the backup and restore paths (a copy being
byte-faithful, the four automatic before-copies, traversal attempts on every filename, retention
actually pruning, and the copy routes staying behind the gate), and the HTTP contract the views
depend on.

The report document is checked as a file rather than as a claim: xref entries, page count and every
stream length are verified against the bytes they point at, all nine sections must appear carrying
the ledger's own rupee figures, an empty portfolio has to print no `NaN`, a 120-row table has to
redraw its header after a page break, and no UTF-8 rupee sign may reach the bytes. Emailing is
checked the same way — the password never comes back over the API, an incomplete sender is refused
before a socket opens, and a full EHLO-to-QUIT dialogue runs against a scripted SMTP peer with the
base64 attachment decoded and re-inspected as a PDF.

Set `TEST_PORT` if 3100 is taken; the two peers move with it and the sandbox's secure listener takes
`TEST_PORT + 43`. The suite serves a captured copy of the bullion page on `TEST_PORT + 1` and answers
SMTP itself on `TEST_PORT + 2`, so no scenario depends on a third-party site being up. Each run
rewrites `test/results.md` with the pass list.

## Layout

```
server.js                 Express app, API routes, startup FX and price refresh, listeners
server/lib/store.js       schema, field normalisation, atomic JSON writes
server/lib/access.js      the PIN gate: loopback passes, device cookie, per-address throttle
server/lib/tls.js         reads the local certificate this machine mints
server/lib/fx.js          ECB rate fetch, resolution order, caching
server/lib/prices.js      Yahoo quote fetch, ticker-to-exchange mapping, price guards
server/lib/metals.js      bullion card scrape, per-gram rate guards
server/lib/bonds.js       bond directory scrape, ISIN lookup, lot and price guards
server/lib/httpget.js     the one shared GET all three price feeds fail through
server/lib/valuation.js   INR conversion, FD accrual, aggregation, monthly snapshots
server/lib/returns.js     per-lot returns, holding-period tax buckets, portfolio XIRR
server/lib/income.js      India income accrual, TDS rules, the financial-year tax estimate
server/lib/analysis.js    allocation and drift, risk mix, concentration, health score, goals
server/lib/health.js      the Portfolio health rules: earning power, ladder, cover, verdicts
server/lib/backups.js     dated full copies: names, retention, prune, read
server/lib/pdf.js         the PDF 1.4 writer: WinAnsi, base-14 fonts, page breaks, zebra tables
server/lib/report.js      composes the report document from the valued state
server/lib/mailer.js      the SMTP client: EHLO, STARTTLS, AUTH LOGIN, one multipart message
server/lib/seed.js        sample portfolio, goals and target weights — what a clone starts on
sample-data.json          those same weights and rows as an importable file, committed at the root
public/                   vanilla ES modules + vendored Chart.js, manifest, worker, icons
public/js/planning.js     retirement, projection, top-up, FIRE, wealth bands, per-asset growth
public/js/offline.js      the read-only copy a device keeps when the server is asleep
public/js/views/          one module per tab
test/scenarios.js         212 scenarios, run against test/.sandbox/
start-wealth-ledger.bat   double-click start: finds Node, installs, opens the browser
launcher/WealthLedger.cs  native launcher: start the server if needed, open a browser tab
install-shortcut.ps1      draws the icon, builds the exe, writes the Desktop shortcut
make-phone-icons.ps1      the rupee tile at every size the manifest asks for
make-phone-cert.ps1       a local CA and a certificate for this machine's LAN addresses
phone-setup.ps1           opens the ports on the network category the machine is actually on
```

## How it is put together

- **Two runtime dependencies: `express` and `chart.js`.** Chart.js is vendored under `public/` so
  the UI works with no CDN and no network. There is no bundler, no transpiler, no framework: the
  browser loads ES modules directly, and each tab is one view module that paints from one state
  object.
- **Features are hand-written rather than installed.** The PDF writer, the SMTP client, the XIRR
  solver, the FX chain and the zip used by this repository's own packaging script are all code in
  this tree. That is a trade, and it is a deliberate one: a feature adds a file rather than a
  dependency, and every calculation stays readable.
- **The PDF prints `Rs 12,34,567`.** The rupee sign has no byte in WinAnsi encoding and no glyph in
  Helvetica, so a literal `₹` would arrive in the file as `?`; money is spelled the way a bank
  statement does, and content streams are left uncompressed on purpose so the tests can read the
  printed figures back out of the document instead of trusting the bytes they were handed.
- **Destructive writes say what they kept.** Every route that can destroy the ledger takes a dated
  copy first and returns it, and the UI names the timestamp in the confirmation.
- **Errors surface in the page, not the console.** A failed fetch or a refused write becomes a
  message stating what failed and what was not written.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | The http listener, and the address the launcher opens. |
| `WEALTH_TLS_PORT` | `3443` | The https listener, started only when `certs/` holds a certificate. |
| `WEALTH_DATA_DIR` | `data/` | Where the ledger lives — this is what lets the test suite run in a sandbox. |
| `WEALTH_METAL_RATES_URL` | the live page | Bullion source override; the tests point it at a captured copy. |
| `WEALTH_BOND_DIRECTORY_URL` | the live page | Bond directory override, same reason. |
| `TEST_PORT` | `3100` | The suite's server; peers move to `+1`, `+2`, and TLS to `+43`. |

## Limitations, stated plainly

- **Single-user by design.** There are no accounts and no locking; two server processes pointed at
  one `data/` directory will overwrite each other.
- **The file is plaintext.** `data/wealth-data.json` holds your financial position with no
  encryption at rest — that is the price of the whole thing being inspectable. Keep it on your own
  disk and out of any repository, which is why it is git-ignored here. Nothing should be
  port-forwarded; the PIN gate protects the network path, not the file.
- **Projections are deterministic arithmetic on your assumptions**, not advice, and no model here
  accounts for inflation.
- **No corporate-actions feed.** Dividends accrue from a yield you enter on the row, because there
  is nothing in the app that can read a payout history.
- **The tax engine is India-only.** Foreign holdings are excluded from it deliberately, and their
  taxation is your own country's rules, not this page's.

## License

No license file is included yet, so the default applies: all rights reserved. Add a `LICENSE` (MIT is
the usual choice for a tool like this) before you want anyone else to use or fork it.
