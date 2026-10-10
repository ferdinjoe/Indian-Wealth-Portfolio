import { escapeHtml, money, num } from '../format.js';
import { api } from '../api.js';
import { toast } from '../ui.js';
import { snapshotStamp, clearSnapshot, ageLabel } from '../offline.js';

export function render(root, ctx) {
  const { rates, meta, holdings, snapshots, settings } = ctx.data;
  const fx = ctx.data.settings.fx;
  const codes = meta.currencies.filter((c) => c !== 'INR');

  root.innerHTML = `
    <div class="grid grid-2">
      <div class="card span-2">
        <div class="card-head">
          <span class="card-title">Exchange rates into INR</span>
          <span class="card-note">source: European Central Bank reference rates${ctx.data.fxDate ? `, dated ${escapeHtml(ctx.data.fxDate)}` : ''}</span>
        </div>
        <div class="rate-grid">
          ${codes.map((code) => rateCell(code, rates[code], fx[code] || {})).join('')}
        </div>
        <p class="card-note" style="margin-top:14px">
          Priority: a pinned rate you enter, then the last live ECB pull, then the bundled default.
          A currency with no rate at all is excluded from net worth and flagged at the top of the page.
        </p>
      </div>

      ${phoneCard(meta, ctx.data.settings)}

      <div class="card">
        <div class="card-head"><span class="card-title">Data &amp; backup</span></div>
        <div class="source-list">
          <div>Live ledger file: <code>${escapeHtml(meta.dataFile)}</code></div>
          <div>Dated copies folder: <code>data/backups/</code></div>
          <div>Records: <code>${holdings.length}</code> holdings · <code>${snapshots.length}</code> monthly snapshots</div>
          <div>Price feeds: <code>${escapeHtml(priceNote(meta))}</code></div>
          <div>Last saved: <code>${escapeHtml((meta.updatedAt || '').slice(0, 19).replace('T', ' '))}</code></div>
          <div>Net worth today: <code>${escapeHtml(money(ctx.data.summary.netWorthINR))}</code></div>
        </div>
        <div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:16px">
          <button class="btn" id="btn-snapshot">Record snapshot now</button>
          <a class="btn btn-ghost" href="/api/export" download="wealth-data.json">Download JSON</a>
          <button class="btn btn-ghost" id="btn-import">Import from file</button>
          <button class="btn btn-danger" id="btn-reseed">Reload sample data</button>
          <button class="btn btn-danger" id="btn-wipe">Wipe everything</button>
        </div>
        <input type="file" id="import-file" accept="application/json" hidden>
        <p class="card-note" style="margin-top:12px">Import replaces the whole ledger, so make a copy first. Wipe and sample reload also act immediately &mdash; each one keeps a dated copy of what it is about to destroy, named in the message that follows, and those copies are listed below.</p>
      </div>

      <div class="card span-2">
        <div class="card-head">
          <span class="card-title">Backup copies</span>
          <span class="card-note">full ledger snapshots, never overwritten</span>
        </div>
        <div style="display:flex;gap:9px;flex-wrap:wrap">
          <button class="btn btn-primary" id="btn-backup-now">Make a safe copy now</button>
          <button class="btn btn-ghost" id="btn-backup-refresh">Check again</button>
        </div>
        <div id="bk-list"><p class="card-note">Reading the backup folder&hellip;</p></div>
        <p class="card-note">Each copy is the entire ledger &mdash; holdings, goals, profile, rates and the phone PIN &mdash; written out exactly as it stood, so restoring one puts the figures and ids back unchanged. Download a copy and you hold a file that survives the laptop. Only the most recent copies are kept on this machine, which is why a copy worth keeping should be downloaded and stored somewhere else.</p>
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">Model defaults</span><span class="card-note">used by the Retirement tab</span></div>
        <div class="source-list">
          ${Object.entries(settings.assumptions).map(([k, v]) => `<div>${escapeHtml(labelFor(k))}: <code>${num(v)}%</code></div>`).join('')}
        </div>
        <p class="card-note" style="margin-top:12px">Edit these on the Retirement tab, where they are applied live to the projection.</p>
        <div class="section-label">Reporting</div>
        <div class="source-list">
          <div>Base currency: <code>INR (₹)</code></div>
          <div>Headline scale: lakh (L) and crore (Cr)</div>
          <div>Asset classes tracked: <code>${meta.categories.length}</code></div>
        </div>
      </div>

      <div class="card span-2">
        <div class="card-head"><span class="card-title">Monthly snapshots</span><span class="card-note">written automatically whenever net worth changes</span></div>
        ${snapshots.length
          ? `<div class="table-wrap"><table><thead><tr><th>Month</th><th class="num">Gross assets</th><th class="num">Liabilities</th><th class="num">Net worth</th><th class="num">Liquid</th><th>Recorded</th></tr></thead>
             <tbody>${[...snapshots].reverse().map((s) => `<tr><td>${escapeHtml(s.period)}</td><td class="num">${money(s.totalAssetsINR)}</td><td class="num neg">${money(s.totalLiabilitiesINR)}</td><td class="num"><strong>${money(s.netWorthINR)}</strong></td><td class="num">${money(s.liquidAssetsINR)}</td><td class="muted">${escapeHtml((s.recordedAt || '').slice(0, 16).replace('T', ' '))}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="card-note">No snapshots yet.</p>'}
      </div>
    </div>`;

  wire(root, ctx, codes);
}

// priceRefreshedAt survives a restart; lastPriceRefresh only knows this process.
function priceNote(meta) {
  const r = meta.lastPriceRefresh;
  const stamp = (iso) => (iso || '').slice(0, 16).replace('T', ' ');
  if (r && r.ok === false) return `last attempt failed ${stamp(r.at)} UTC - ${r.error}`;
  const at = stamp(meta.priceRefreshedAt);
  if (!at) return 'never fetched - give an equity row a ticker, or a gold row a bullion rate';
  const n = (r && r.updated) || 0;
  return `last pulled ${at} UTC${n ? `, ${n} ${n === 1 ? 'row' : 'rows'} repriced this session` : ''}`;
}

// One ledger, two screens: the phone reads and writes this same file over the
// Wi-Fi, so there is nothing to sync and no second copy to fall out of step.
function phoneCard(meta, settings) {
  const a = meta.access || {};
  const urls = a.phoneUrls || [];
  const cert = a.cert;
  const pinSet = Boolean(settings.phoneAccess && settings.phoneAccess.hasPin);
  const snapAt = snapshotStamp();
  const copyLabel = snapAt
    ? `${escapeHtml(String(snapAt).slice(0, 16).replace('T', ' '))} UTC, ${ageLabel(snapAt)} ago`
    : 'none yet - this device has not loaded the ledger while the laptop was reachable';

  const addressBlock = urls.length
    ? `${urls.map((u) => `<div class="pa-url"><input type="text" readonly value="${escapeHtml(u)}" data-pa-address><button class="btn btn-sm" data-pa-copy>Copy</button></div>`).join('')}
       <p class="card-note">${a.secure
        ? 'Type or paste this into Chrome on the phone. It is https, so Chrome will also offer <em>Add to Home screen</em> and the app then opens with no browser around it.'
        : 'This is an http address, so a phone can browse the ledger but Chrome will not let it be installed as an app - install needs a secure origin. Run <code>make-phone-cert.ps1</code> once and the address becomes https.'}</p>`
    : '<p class="card-note">No network address found - the laptop has to be on Wi-Fi or Ethernet for a phone to reach it.</p>';

  const certBlock = !cert
    ? '<p class="card-note">No certificate on this machine yet. Run <code>make-phone-cert.ps1</code> on the laptop once, then restart it - the phone keeps working without one, it just cannot be installed.</p>'
    : `<div class="source-list">
        <div>Accepted addresses: <code>${escapeHtml((cert.addresses || []).join(', '))}</code></div>
        <div>${cert.expired
          ? `<span class="neg">Expired</span> - run <code>make-phone-cert.ps1 -Force</code> again`
          : `Valid for another <code>${cert.daysLeft}</code> days`}</div>
        <div><a class="btn btn-sm" href="/phone-ca.pem" download>Download the certificate to install on the phone</a></div>
      </div>
      <p class="card-note">Android has to be told to trust this file before it will open the https address without complaining. The private half never leaves this laptop; this file is only the public half.</p>`;

  return `
      <div class="card span-2">
        <div class="card-head">
          <span class="card-title">Phone access</span>
          <span class="card-note">${a.enabled ? 'on - a phone on this Wi-Fi signs in with the PIN' : 'off - this ledger answers the laptop only'}</span>
        </div>
        <p class="pa-lede">
          Open the ledger on your phone and it reads and writes <strong>this same file</strong> on this laptop, so an
          edit on either screen shows on the other the moment it is saved. Nothing is uploaded anywhere, there is no
          sync step to go wrong, and the phone has to be on the same Wi-Fi as this machine.
        </p>

        <div class="section-label">Address to open on the phone</div>
        ${addressBlock}

        <div class="section-label">Signing PIN</div>
        <div class="pa-pin">
          <input type="tel" id="pa-pin" inputmode="numeric" maxlength="12" placeholder="${pinSet ? 'new PIN (4-12 digits)' : 'choose a PIN (4-12 digits)'}" autocomplete="off">
          <button class="btn btn-primary" id="pa-save">${pinSet ? 'Change PIN' : 'Set PIN and turn on'}</button>
          ${a.enabled
            ? '<button class="btn" id="pa-off">Turn access off</button>'
            : (pinSet ? '<button class="btn" id="pa-on">Turn access on</button>' : '')}
          ${pinSet ? '<button class="btn btn-danger" id="pa-clear">Remove the PIN</button>' : ''}
          ${pinSet ? '<button class="btn btn-ghost" id="pa-revoke">Sign every phone out</button>' : ''}
        </div>
        <p class="card-note">A phone that has not entered the PIN sees a lock page and no figures at all. Each phone stays signed in for ${a.tokenDays || 180} days; changing the PIN or signing out ends every one of those sessions.</p>

        <div class="section-label">Certificate, for installing as an app</div>
        ${certBlock}

        <div class="section-label">Android app (APK)</div>
        ${apkBlock(a)}

        <div class="section-label">Putting it on an Android home screen</div>
        <ol class="pa-steps">
          <li>On the phone, download the certificate file above - it lands in Downloads.</li>
          <li>Open the phone's Settings, search for <em>CA certificate</em>, and choose <em>Install a CA certificate</em>, then pick that file. Android asks you to confirm; Xiaomi, Samsung and Pixel word the menu differently but the search finds it.</li>
          <li>Open the address above in Chrome on the phone and enter the PIN once.</li>
          <li>Chrome menu &rarr; <em>Add to Home screen</em> or <em>Install app</em>. The icon then opens the ledger with no browser bars around it.</li>
        </ol>
        <div class="section-label">Copy stored on this device</div>
        <div class="source-list">
          <div>Offline reading: <code>${copyLabel}</code></div>
          ${snapAt ? '<div><button class="btn btn-ghost btn-sm" id="pa-forget">Forget it</button></div>' : ''}
        </div>
        <p class="card-note">Off the Wi-Fi, the installed app still opens and shows that last reading, marked offline and read-only, for up to three days. Your money lives in one file on this laptop; the phone only ever holds a copy of what it saw.</p>
      </div>`;
}

function apkBlock(a) {
  const apk = a.apk;
  const link = a.linkPath || '/.well-known/assetlinks.json';
  if (apk) {
    return `<div class="source-list">
        <div>Declared app: <code>${escapeHtml(apk.package)}</code></div>
        <div>Signing key: <code>${escapeHtml((apk.fingerprints || []).join(' '))}</code></div>
        ${apk.declaredAt ? `<div>Declared: <code>${escapeHtml(String(apk.declaredAt).slice(0, 16).replace('T', ' '))} UTC</code></div>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn btn-sm" href="${escapeHtml(link)}" target="_blank" rel="noopener">Open the file Chrome reads</a>
          <button class="btn btn-ghost btn-sm" id="pa-apk-clear">Remove the declaration</button>
        </div>
      </div>
      <p class="card-note">With this in place the app opens full screen and never mentions being unverified. A rebuild signed with a
      different key has to be pasted in again, or that app stops opening until it is.</p>`;
  }
  return `<p class="card-note">Wrapping this page as an installable Android app is a separate, optional tool and is not part of this repository. The two boxes below only matter for a build made that way: they record a public key hash and an app name.</p>
    <div class="pa-apk">
      <input type="text" id="pa-apk-package" placeholder="app name, e.g. com.example.ledger" autocomplete="off" spellcheck="false">
      <input type="text" id="pa-apk-fingerprint" placeholder="signing fingerprint - 64 hex digits, colons optional" autocomplete="off" spellcheck="false">
      <button class="btn btn-primary" id="pa-apk-save">Declare this build</button>
    </div>
    <p class="card-note">Skip it and the APK still works, but Chrome leaves a browser bar across the top and warns that the app is not
    verified. Typing it in declares nothing beyond this laptop - it is a public key hash and an app name.</p>`;
}

// A copy is listed by when it was taken and what it was taken for. "Kept before a
// wipe" is the line that says which of these files holds the ledger from this
// morning, so the slugs the routes write are turned into sentences here.
const COPY_REASONS = {
  manual: 'made by hand',
  'before-wipe': 'kept before a wipe',
  'before-sample': 'kept before sample data',
  'before-import': 'kept before an import',
  'before-restore': 'kept before a restore',
};

const copyStamp = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');
const copySize = (bytes) => (bytes > 2048 ? `${Math.round(bytes / 1024)} KB` : `${bytes || 0} B`);

function paintCopies(host, rows, keep, ctx) {
  if (!rows.length) {
    host.innerHTML = '<p class="card-note">No copies on this machine yet. "Make a safe copy now" writes one, and the ledger copies itself here before every wipe, sample reload, import and restore.</p>';
    return;
  }
  host.innerHTML = `<p class="card-note">${rows.length} ${rows.length === 1 ? 'copy' : 'copies'}, newest first${keep ? `, of the ${keep} most recent this folder keeps` : ''}.</p>
    <div class="table-wrap"><table><thead><tr><th>Taken (UTC)</th><th>Why</th><th class="num">Holdings</th><th class="num">Goals</th><th class="num">Size</th><th>Use</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${escapeHtml(copyStamp(r.takenAt))}${r.corrupt ? ' <span class="neg">unreadable</span>' : ''}</td>
      <td>${escapeHtml(COPY_REASONS[r.reason] || r.reason || 'copy')}</td>
      <td class="num">${r.holdings}</td>
      <td class="num">${r.goals}</td>
      <td class="num">${copySize(r.bytes)}</td>
      <td style="white-space:nowrap">
        <a class="btn btn-sm" href="/api/backups/${encodeURIComponent(r.name)}" download="${escapeHtml(r.name)}">Download</a>
        ${r.corrupt ? '' : `<button class="btn btn-sm" data-copy-restore="${escapeHtml(r.name)}">Restore</button>`}
        <button class="btn btn-ghost btn-sm" data-copy-forget="${escapeHtml(r.name)}">Delete</button>
      </td></tr>`).join('')}</tbody></table></div>`;

  host.querySelectorAll('[data-copy-restore]').forEach((btn) => {
    btn.onclick = async () => {
      const row = rows.find((r) => r.name === btn.dataset.copyRestore);
      if (!confirm(`Put the ledger back to how it stood at ${copyStamp(row.takenAt)} UTC, with ${row.holdings} holdings? What is on screen now is copied first, so this too can be undone.`)) return;
      try {
        const next = await ctx.mutate(() => api.restoreBackup(row.name), null);
        toast(`Restored ${next.holdings.length} holdings. The state it displaced is the newest copy in this list.`, '', 8000);
      } catch { /* mutate already said what failed */ }
    };
  });
  host.querySelectorAll('[data-copy-forget]').forEach((btn) => {
    btn.onclick = async () => {
      const row = rows.find((r) => r.name === btn.dataset.copyForget);
      if (!confirm(`Delete the copy from ${copyStamp(row.takenAt)}? It holds ${row.holdings} holdings, and nothing else on this machine has them.`)) return;
      try {
        const res = await api.deleteBackup(row.name);
        paintCopies(host, res.backups, res.keep, ctx);
        toast('That copy is gone.');
      } catch (err) {
        toast(err.message, 'bad', 6000);
      }
    };
  });
}

// The copy list is not part of /api/state: it is a folder read, and asking for it
// only when this card is on screen keeps it off every other page's load.
async function loadBackups(ctx) {
  const host = document.getElementById('bk-list');
  if (!host) return;
  try {
    const res = await api.listBackups();
    paintCopies(host, res.backups, res.keep, ctx);
  } catch (err) {
    host.innerHTML = `<p class="card-note neg">${escapeHtml(err.message)}</p>`;
  }
}

function labelFor(key) {
  return key.replace(/Pct$/, '').replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function rateCell(code, resolved, stored) {
  const source = resolved.source;
  return `<div class="rate-cell" data-code="${code}">
    <header><span class="rate-code">${code} &rarr; INR</span><span class="rate-src ${source}">${source}</span></header>
    <div class="rate-value">${resolved.rate ? resolved.rate.toFixed(4) : '—'}</div>
    <div class="rate-meta">${escapeHtml(source === 'manual' ? `pinned ${resolved.asOf || ''}` : source === 'cached' ? `ECB ${resolved.asOf || 'unknown'}` : source === 'fallback' ? 'bundled default — stale' : 'no data')}</div>
    <div style="display:flex;gap:6px">
      <input type="number" step="0.0001" placeholder="${resolved.rate ? resolved.rate.toFixed(4) : 'rate'}" data-pin-input style="flex:1">
      <button class="btn btn-sm" data-pin-action>Pin</button>
    </div>
    ${stored.manualRate ? `<button class="btn btn-ghost btn-sm" style="margin-top:7px;width:100%" data-unpin>Unpin (₹${stored.manualRate})</button>` : ''}
  </div>`;
}

function wire(root, ctx, codes) {
  root.querySelectorAll('.rate-cell').forEach((cell) => {
    const code = cell.dataset.code;
    cell.querySelector('[data-pin-action]').onclick = async () => {
      const v = cell.querySelector('[data-pin-input]').value;
      if (!v) return toast('Enter a rate first, or use Unpin to go back to live rates.', 'bad');
      await ctx.mutate(() => api.pinRate(code, Number(v)), `Pinned ${code} at ₹${v}`);
    };
    const unpin = cell.querySelector('[data-unpin]');
    if (unpin) unpin.onclick = () => ctx.mutate(() => api.pinRate(code, null), `Cleared the ${code} pin.`);
  });

  document.getElementById('btn-snapshot').onclick = () => ctx.mutate(() => api.snapshot(), 'Snapshot recorded for this month.');

  const fileInput = document.getElementById('import-file');
  document.getElementById('btn-import').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const doc = JSON.parse(await file.text());
      const next = await ctx.mutate(() => api.import(doc), null);
      const b = next.backup || {};
      toast(`Imported ${next.holdings.length} holdings from ${file.name}. The ledger it replaced is the copy taken ${copyStamp(b.takenAt)}.`, '', 9000);
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'bad', 6000);
    } finally {
      fileInput.value = '';
    }
  };

  document.getElementById('btn-reseed').onclick = () => {
    if (!confirm('Replace the current ledger with the sample portfolio? A dated copy of what is here now is kept first, so you can put your own entries back from Backup copies below.')) return;
    ctx.mutate(() => api.seed(), null).then((next) => {
      const b = next.backup || {};
      toast(`Sample portfolio loaded. Your ${b.holdings || 0} entries are in the copy taken ${copyStamp(b.takenAt)}, listed below.`, '', 9000);
    }).catch(() => {});
  };

  document.getElementById('btn-wipe').onclick = () => {
    if (!confirm('Delete every holding and profile detail? Rates are kept, and a dated copy of everything as it stands now is taken first - restore it from Backup copies below.')) return;
    ctx.mutate(() => api.reset(), null).then((next) => {
      const b = next.backup || {};
      toast(`Ledger emptied. The ${b.holdings || 0} holdings and ${b.goals || 0} goals are safe in the copy taken ${copyStamp(b.takenAt)}.`, '', 9000);
    }).catch(() => {});
  };

  loadBackups(ctx);
  const copyNow = document.getElementById('btn-backup-now');
  copyNow.onclick = async () => {
    copyNow.disabled = true;
    try {
      const res = await api.createBackup();
      const host = document.getElementById('bk-list');
      if (host) paintCopies(host, res.backups, res.keep, ctx);
      toast(`Safe copy made: ${res.backup.holdings} holdings, at the top of the list.`, '', 7000);
    } catch (err) {
      toast(err.message, 'bad', 6000);
    } finally {
      copyNow.disabled = false;
    }
  };
  document.getElementById('btn-backup-refresh').onclick = () => loadBackups(ctx);

  root.querySelectorAll('[data-pa-copy]').forEach((btn) => {
    btn.onclick = async () => {
      const value = btn.parentElement.querySelector('[data-pa-address]').value;
      try {
        await navigator.clipboard.writeText(value);
        toast('Address copied. Paste it into Chrome on the phone.');
      } catch {
        toast('Copying needs a https or localhost page - tap the box and select it by hand.', 'warn', 5000);
      }
    };
  });

  const pinBox = document.getElementById('pa-save');
  if (pinBox) {
    pinBox.onclick = () => {
      const pin = document.getElementById('pa-pin').value.trim();
      if (!/^\d{4,12}$/.test(pin)) return toast('A PIN has to be 4 to 12 digits.', 'bad');
      ctx.mutate(() => api.savePhoneAccess({ pin, enabled: true }), 'Phone access is on. Use that PIN on the phone.');
    };
  }
  const toggle = (id, enabled, message) => {
    const btn = document.getElementById(id);
    if (btn) btn.onclick = () => ctx.mutate(() => api.savePhoneAccess({ enabled }), message);
  };
  toggle('pa-on', true, 'Phone access turned on.');
  toggle('pa-off', false, 'Phone access turned off - no phone can open the ledger now.');

  const clearBtn = document.getElementById('pa-clear');
  if (clearBtn) {
    clearBtn.onclick = () => {
      if (!confirm('Remove the PIN? Phone access switches off with it, and every phone is signed out.')) return;
      ctx.mutate(() => api.savePhoneAccess({ pin: null }), 'PIN removed; phone access is off.');
    };
  }
  const revoke = document.getElementById('pa-revoke');
  if (revoke) {
    revoke.onclick = () => {
      if (!confirm('Sign every phone out? Each one has to type the PIN again, including the one you are holding.')) return;
      ctx.mutate(() => api.revokePhones(), 'Every phone has to enter the PIN again.');
    };
  }
  const declare = document.getElementById('pa-apk-save');
  if (declare) {
    declare.onclick = () => {
      const packageName = document.getElementById('pa-apk-package').value.trim();
      const fingerprint = document.getElementById('pa-apk-fingerprint').value.trim();
      if (!packageName || !fingerprint) return toast('The app name and the fingerprint both have to be filled in.', 'bad');
      ctx.mutate(
        () => api.savePhoneAccess({ apk: { package: packageName, fingerprints: [fingerprint], declaredAt: new Date().toISOString() } }),
        'Declared. The app on the phone now opens without a browser bar.',
      );
    };
  }
  const dropApk = document.getElementById('pa-apk-clear');
  if (dropApk) {
    dropApk.onclick = () => {
      if (!confirm('Stop declaring this APK? The app on the phone goes back to opening with a browser bar and a warning.')) return;
      ctx.mutate(() => api.savePhoneAccess({ apk: null }), 'Declaration removed.');
    };
  }
  const forget = document.getElementById('pa-forget');
  if (forget) {
    forget.onclick = () => {
      clearSnapshot();
      toast('This device has no stored reading now.');
      render(root, ctx);
    };
  }
}
