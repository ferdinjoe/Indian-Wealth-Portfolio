// The one copy of the ledger that lives on a device that is not the PC. It is
// written on every successful read so the installed phone app can still open
// when the laptop is asleep - and it is clearly marked as a reading, never a
// second ledger, because two files that both claim to hold your money is how
// accounts start to disagree.
const KEY = 'wealth-ledger-offline-snapshot';
const MAX_AGE_HOURS = 72;

function storage() {
  try {
    const s = window.localStorage;
    s.setItem('wl-probe', '1');
    s.removeItem('wl-probe');
    return s;
  } catch {
    return null;
  }
}

export function saveSnapshot(data) {
  if (!data || !Array.isArray(data.holdings)) return false;
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(KEY, JSON.stringify({ at: new Date().toISOString(), data }));
    return true;
  } catch {
    // A ledger too large for the device's quota is worth saying out loud: the
    // phone would otherwise open next time with no copy at all and no reason.
    return false;
  }
}

export function loadSnapshot({ now = Date.now(), maxAgeHours = MAX_AGE_HOURS } = {}) {
  const s = storage();
  if (!s) return null;
  let raw = null;
  try {
    raw = s.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    s.removeItem(KEY);
    return null;
  }
  const at = Date.parse(parsed && parsed.at);
  if (!Number.isFinite(at) || !parsed.data || !Array.isArray(parsed.data.holdings)) {
    s.removeItem(KEY);
    return null;
  }
  // A three-week-old net worth is not a fallback, it is a wrong answer.
  if (now - at > maxAgeHours * 3600_000) return null;
  const data = parsed.data;
  data.meta = { ...(data.meta || {}), offlineAt: parsed.at, offline: true };
  return data;
}

export function clearSnapshot() {
  const s = storage();
  if (!s) return false;
  s.removeItem(KEY);
  return true;
}

export function hasSnapshot() {
  const s = storage();
  if (!s) return false;
  return Boolean(s.getItem(KEY));
}

// When this device last saw the live ledger, even if that reading has since
// aged out of use - a stale copy is worth naming, not reporting as none.
export function snapshotStamp() {
  const s = storage();
  if (!s) return null;
  try {
    return JSON.parse(s.getItem(KEY)).at || null;
  } catch {
    return null;
  }
}

// "19 minutes", "3 hours", "2 days" - the banner has to say how stale the
// reading is, not just that it is stale.
export function ageLabel(iso, now = Date.now()) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return 'an unknown time';
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
