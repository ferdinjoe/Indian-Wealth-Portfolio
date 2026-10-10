const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// data/wealth-data.backup.json is one rolling slot, rewritten by every save, so
// an hour of editing destroys the state worth recovering. This folder holds dated
// copies that are never overwritten, which is the only thing that makes "restore
// Tuesday" possible - and the only safe thing to leave behind before a wipe.
const KEEP = 24;
// The random tail is what lets two copies taken in the same second both exist.
const NAME_SHAPE = /^wealth-backup-\d{4}-\d{2}-\d{2}-\d{6}-[0-9a-f]{4}\.json$/;

function folderFor(dataDir) {
  return path.join(dataDir, 'backups');
}

function newName() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `wealth-backup-${stamp}-${crypto.randomBytes(2).toString('hex')}.json`;
}

// Every entry point to a filename goes through here: a route that took a name
// straight from the URL could be walked out of the backup folder with `..`.
function resolve(dataDir, name) {
  if (!NAME_SHAPE.test(String(name || ''))) return null;
  const file = path.join(folderFor(dataDir), String(name));
  return fs.existsSync(file) ? file : null;
}

function summarise(file, name) {
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* a torn file still gets listed */ }
  const stat = fs.statSync(file);
  return {
    name,
    bytes: stat.size,
    takenAt: (doc && doc.backup && doc.backup.takenAt) || stat.mtime.toISOString(),
    reason: (doc && doc.backup && doc.backup.reason) || 'copy',
    corrupt: !doc,
    holdings: doc && Array.isArray(doc.holdings) ? doc.holdings.length : 0,
    goals: doc && Array.isArray(doc.goals) ? doc.goals.length : 0,
    savedAt: (doc && doc.updatedAt) || null,
  };
}

function list(dataDir) {
  const folder = folderFor(dataDir);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder)
    .filter((n) => NAME_SHAPE.test(n))
    .map((n) => summarise(path.join(folder, n), n))
    .sort((a, b) => (a.takenAt < b.takenAt ? 1 : -1));
}

// The document is written exactly as the app holds it, so a restore is a round
// trip rather than a re-derivation: figures, ids and dates come back unchanged.
function take(dataDir, doc, reason = 'manual') {
  const folder = folderFor(dataDir);
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  const name = newName();
  const copy = JSON.parse(JSON.stringify(doc || {}));
  copy.backup = { takenAt: new Date().toISOString(), reason: String(reason).slice(0, 40) };
  const tmp = path.join(folder, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(copy, null, 2), 'utf8');
  fs.renameSync(tmp, path.join(folder, name));
  prune(dataDir);
  return summarise(path.join(folder, name), name);
}

function prune(dataDir) {
  const rows = list(dataDir);
  if (rows.length <= KEEP) return rows.length;
  for (const row of rows.slice(KEEP)) {
    try { fs.rmSync(path.join(folderFor(dataDir), row.name)); } catch { /* one stale file is not a failure */ }
  }
  return KEEP;
}

function remove(dataDir, name) {
  const file = resolve(dataDir, name);
  if (!file) return false;
  fs.rmSync(file);
  return true;
}

// The download route sends the stored bytes rather than re-serialising, so what a
// person downloads is bit-for-bit what a restore would put back.
function raw(dataDir, name) {
  const file = resolve(dataDir, name);
  return file ? fs.readFileSync(file, 'utf8') : null;
}

module.exports = { KEEP, NAME_SHAPE, folderFor, resolve, list, take, prune, remove, raw };
