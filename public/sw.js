// The phone's own copy of the app shell. It exists so the installed icon opens
// something even when the PC is asleep - the ledger data itself is deliberately
// not cached here, because a stale balance on a phone is worse than a spinner.
const VERSION = 'wealth-ledger-v1';

// Everything the page needs to paint. test/scenarios.js checks this list against
// the files on disk, so a new view cannot quietly miss the install.
const SHELL = [
  '/',
  '/css/styles.css',
  '/js/app.js',
  '/js/api.js',
  '/js/charts.js',
  '/js/format.js',
  '/js/offline.js',
  '/js/planning.js',
  '/js/ui.js',
  '/js/views/allocation.js',
  '/js/views/analytics.js',
  '/js/views/dashboard.js',
  '/js/views/goals.js',
  '/js/views/health.js',
  '/js/views/holdings.js',
  '/js/views/planner.js',
  '/js/views/profile.js',
  '/js/views/report.js',
  '/js/views/settings.js',
  '/js/views/tax.js',
  '/vendor/chart.umd.min.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/apple-touch-icon-152.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Reads, exports and the report PDF all go to the live server, as does the
  // unlock page, which must never be shown from a cache after a PIN changes.
  if (url.pathname.startsWith('/api/') || url.pathname === '/unlock') return;
  event.respondWith(networkFirst(req, url.pathname));
});

async function networkFirst(req, pathname) {
  try {
    const res = await fetch(req);
    if (res && res.ok && SHELL.includes(pathname)) {
      const cache = await caches.open(VERSION);
      await cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const shell = await caches.match('/');
      if (shell) return shell;
    }
    throw err;
  }
}
