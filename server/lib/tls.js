const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A phone can open this ledger over http and work perfectly - but Chrome will
// not let it be *installed* as an app from an insecure origin, and the whole
// point was an icon that opens without a browser around it. That is what these
// files are for: a private CA minted on this machine, and a certificate for the
// laptop's own LAN address, signed by it.
const CERT_DIR = path.join(__dirname, '..', '..', 'certs');
const LEAF_KEY = 'phone-key.pem';
const LEAF_CERT = 'phone-cert.pem';
const CA_CERT = 'phone-ca.pem';

function fileIn(dir, name) {
  return path.join(dir || CERT_DIR, name);
}

// Returns nothing rather than half a key pair, because a missing leaf is the
// normal state before the certificate script has ever been run.
function material(dir) {
  const key = fileIn(dir, LEAF_KEY);
  const cert = fileIn(dir, LEAF_CERT);
  if (!fs.existsSync(key) || !fs.existsSync(cert)) return null;
  const ca = fileIn(dir, CA_CERT);
  return {
    key: fs.readFileSync(key),
    cert: fs.readFileSync(cert),
    ca: fs.existsSync(ca) ? fs.readFileSync(ca) : null,
    caPath: fs.existsSync(ca) ? ca : null,
  };
}

// What the Settings card needs to say about the certificate instead of guessing:
// which addresses it will be accepted for, and when it stops being true.
function describe(dir) {
  const m = material(dir);
  if (!m) return null;
  let leaf = null;
  try {
    leaf = new crypto.X509Certificate(m.cert);
  } catch {
    return null;
  }
  const listed = String(leaf.subjectAltName || '');
  return {
    addresses: listed.split(',').map((s) => s.trim().replace(/^(IP Address|DNS):/, '')).filter(Boolean),
    notAfter: leaf.validTo,
    expired: new Date(leaf.validTo).getTime() <= Date.now(),
    daysLeft: Math.max(0, Math.round((new Date(leaf.validTo).getTime() - Date.now()) / 86400_000)),
    hasCa: Boolean(m.ca),
    issuedBy: leaf.issuer.replace(/[\r\n]+/g, ' ').trim(),
  };
}

module.exports = {
  CERT_DIR,
  LEAF_KEY,
  LEAF_CERT,
  CA_CERT,
  fileIn,
  material,
  describe,
};
