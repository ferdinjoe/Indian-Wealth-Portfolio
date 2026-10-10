const crypto = require('crypto');

// The ledger holds real positions and the app has no user accounts, so opening
// the port to a home Wi-Fi network is only safe behind a secret. Everything a
// non-loopback client asks for goes through this file first.
const COOKIE = 'wl_device';
const TOKEN_DAYS = 180;
const LOCK_SECONDS = 60;
const ATTEMPTS_BEFORE_LOCK = 6;
const PIN_SHAPE = /^\d{4,12}$/;

const LOOPBACK = new Set(['::1', '::ffff:127.0.0.1', 'localhost']);

function normalizeIp(address) {
  const raw = String(address || '').trim();
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

// Node reports an IPv4 peer as ::ffff:a.b.c.d when the port is bound to ::, so
// both spellings of 127.0.0.1 have to count, and so does the machine's own
// address family preference.
function isLoopback(address) {
  const ip = normalizeIp(address);
  if (!ip) return false;
  if (LOOPBACK.has(ip)) return true;
  if (ip.startsWith('127.')) return true;
  return ip.startsWith('::ffff:127.');
}

function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(`${salt}:${pin}`).digest('hex');
}

// The signing key is derived from the PIN hash, never from the PIN: rotating or
// clearing the PIN therefore logs every phone out, and a leaked settings blob
// still does not carry the secret itself.
function tokenKey(access) {
  return crypto
    .createHash('sha256')
    .update(`token|${access.pinHash || ''}|${access.tokenEpoch || 1}`)
    .digest();
}

function mintToken(access) {
  const epoch = access.tokenEpoch || 1;
  const expires = Date.now() + TOKEN_DAYS * 86400_000;
  const payload = `${epoch}.${expires}`;
  const sig = crypto.createHmac('sha256', tokenKey(access)).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyToken(value, access) {
  if (!value || !access || !access.pinHash) return false;
  const parts = String(value).split('.');
  if (parts.length !== 3) return false;
  const [epoch, expires, sig] = parts;
  if (!/^\d+$/.test(epoch) || !/^\d+$/.test(expires)) return false;
  if (Number(expires) <= Date.now()) return false;
  const expected = crypto.createHmac('sha256', tokenKey(access)).update(`${epoch}.${expires}`).digest('hex');
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// A six-digit PIN is guessable in seconds on a home network, so failures are
// counted per address and the address is cooled down rather than locked out
// forever - the owner's own phone is the likely victim of a typo.
const failures = new Map();

function lockSecondsLeft(ip) {
  const entry = failures.get(ip);
  if (!entry || !entry.until || entry.until <= Date.now()) return 0;
  return Math.ceil((entry.until - Date.now()) / 1000);
}

function noteFailure(ip) {
  const entry = failures.get(ip) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= ATTEMPTS_BEFORE_LOCK) {
    entry.count = 0;
    entry.until = Date.now() + LOCK_SECONDS * 1000;
  }
  failures.set(ip, entry);
}

function clearFailures(ip) {
  failures.delete(ip);
}

const PAGE_CSS = `
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#0f1620; color:#e6edf3; font:15px/1.55 "Segoe UI", system-ui, sans-serif; padding:24px; }
  .card { width:100%; max-width:420px; background:#171e28; border:1px solid #26303f;
    border-radius:16px; padding:26px 24px; }
  .mark { width:44px; height:44px; border-radius:12px; display:flex; align-items:center; justify-content:center;
    font-size:24px; font-weight:700; color:#fff; background:linear-gradient(135deg,#22c55e,#15803d);
    margin-bottom:16px; }
  h1 { font-size:19px; margin:0 0 6px; }
  p { margin:0 0 14px; color:#97a5b6; font-size:14px; }
  ol { margin:0 0 16px; padding-left:20px; color:#97a5b6; font-size:14px; }
  li { margin-bottom:6px; }
  input { width:100%; padding:14px 16px; font-size:20px; letter-spacing:.3em; text-align:center;
    font-family:ui-monospace, Consolas, monospace; background:#0f1620; color:#e6edf3;
    border:1px solid #2b3646; border-radius:11px; }
  button { width:100%; margin-top:12px; padding:14px; font-size:15px; font-weight:600; color:#08130c;
    background:#4ade80; border:0; border-radius:11px; }
  .err { color:#f87171; font-size:13.5px; margin-top:12px; min-height:18px; }
  code { font-family:ui-monospace, Consolas, monospace; color:#e6edf3; }
`;

function shell(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${title}</title><style>${PAGE_CSS}</style></head>
<body><div class="card"><div class="mark">&#8377;</div>${body}</div></body></html>`;
}

function lockedPage() {
  return shell('Wealth Ledger is closed to this device', `
    <h1>Phone access is off</h1>
    <p>This ledger is served from a Windows PC and is not open on the network until you say so.</p>
    <ol>
      <li>On the PC, open the <strong>Wealth Ledger</strong> app.</li>
      <li>Go to <strong>Settings &rarr; Phone access</strong>.</li>
      <li>Turn it on and set a PIN, then reload this page.</li>
    </ol>
    <p style="margin:0">Nothing here is sent anywhere except that PC.</p>`);
}

function unlockPage(lockedSeconds) {
  return shell('Wealth Ledger &mdash; enter your PIN', `
    <h1>Unlock your ledger</h1>
    <p>Type the PIN you set under <strong>Settings &rarr; Phone access</strong> on the PC. This device
    stays unlocked for six months, so it is a one-time step.</p>
    <form id="f" autocomplete="off">
      <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="one-time-code"
        maxlength="12" placeholder="PIN" aria-label="PIN">
      <button type="submit">Unlock</button>
    </form>
    <div class="err" id="e">${lockedSeconds ? `Too many attempts. Wait ${lockedSeconds}s.` : ''}</div>
    <script>
    const f = document.getElementById('f'), e = document.getElementById('e');
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      e.textContent = '';
      try {
        const res = await fetch('/api/unlock', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: document.getElementById('pin').value }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Wrong PIN'); }
        location.href = '/';
      } catch (err) { e.textContent = err.message; }
    });
    </script>`);
}

// Mounted before the static files and the API, so an unauthenticated peer never
// reaches a route, a ledger field or a JS module - it only ever sees one of the
// two pages above.
function gate({ getAccess, onUnlock }) {
  return (req, res, next) => {
    if (isLoopback(req.socket.remoteAddress)) return next();

    const access = getAccess() || {};
    const ip = normalizeIp(req.socket.remoteAddress);
    const isApi = req.path.startsWith('/api/');
    const json = (code, body) => res.status(code).json(body);

    if (isApi && req.method === 'POST' && req.path === '/api/unlock') {
      const wait = lockSecondsLeft(ip);
      if (wait) return json(429, { error: `Too many attempts. Wait ${wait} seconds.` });
      const pin = String((req.body && req.body.pin) || '');
      if (!PIN_SHAPE.test(pin)) return json(400, { error: 'A PIN is 4 to 12 digits.' });
      if (!access.enabled || !access.pinHash || !verifyPin(pin, access)) {
        noteFailure(ip);
        const left = access.enabled ? 'That PIN is not the one on this ledger.' : 'Phone access is off on this ledger.';
        return json(401, { error: left });
      }
      clearFailures(ip);
      res.setHeader('Set-Cookie', `${COOKIE}=${mintToken(access)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_DAYS * 86400}`);
      if (onUnlock) onUnlock();
      return json(200, { ok: true });
    }

    if (verifyToken(readCookie(req, COOKIE), access)) return next();

    if (!access.enabled) {
      if (isApi) return json(403, { error: 'Phone access is off. Turn it on under Settings - Phone access on the PC.' });
      return res.status(403).type('html').send(lockedPage());
    }
    if (req.path === '/unlock') {
      return res.status(200).type('html').send(unlockPage(lockSecondsLeft(ip)));
    }
    if (isApi) return json(401, { error: 'This device is locked. Open the app again and enter your PIN.' });
    return res.redirect(303, '/unlock');
  };
}

function verifyPin(pin, access) {
  const candidate = Buffer.from(hashPin(pin, access.salt), 'hex');
  const stored = Buffer.from(String(access.pinHash || ''), 'hex');
  if (stored.length !== candidate.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

// A Trusted Web Activity - the APK shape of this app - only opens full screen if
// Chrome can check that the APK and the site declared each other. The site's half
// of that is this one JSON file, so it is served ahead of the gate: it carries a
// public key hash and an application id, and no figure from the ledger.
const PACKAGE_SHAPE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

// 64 hex digits, colons optional - keytool prints them colon-separated, the
// Play Console and every guide paste them either way, and the spec wants colons.
function normalizeFingerprint(value) {
  const hex = String(value || '').replace(/[:\s-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return (hex.match(/../g) || []).join(':').toUpperCase();
}

// Either a complete declaration or none at all: an entry with a key hash but no
// package name would be served as a broken assetlinks file.
function normalizeApk(value) {
  const a = value && typeof value === 'object' ? value : null;
  if (!a) return null;
  const packageName = String(a.package || '').trim();
  const fingerprints = [...new Set((Array.isArray(a.fingerprints) ? a.fingerprints : [])
    .map(normalizeFingerprint).filter(Boolean))];
  if (!PACKAGE_SHAPE.test(packageName) || packageName.length > 200 || !fingerprints.length) return null;
  return { package: packageName, fingerprints, declaredAt: String(a.declaredAt || '').slice(0, 40) };
}

function assetLinksDoc(apk) {
  const a = normalizeApk(apk);
  if (!a) return null;
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      platform: 'android_app',
      package_name: a.package,
      sha256_cert_fingerprints: a.fingerprints,
    },
  }];
}

module.exports = {
  COOKIE,
  PIN_SHAPE,
  PACKAGE_SHAPE,
  TOKEN_DAYS,
  ATTEMPTS_BEFORE_LOCK,
  LOCK_SECONDS,
  isLoopback,
  normalizeIp,
  newSalt,
  hashPin,
  verifyPin,
  normalizeFingerprint,
  normalizeApk,
  assetLinksDoc,
  mintToken,
  verifyToken,
  lockSecondsLeft,
  noteFailure,
  clearFailures,
  lockedPage,
  unlockPage,
  gate,
};
