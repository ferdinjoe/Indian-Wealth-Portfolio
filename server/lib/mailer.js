// A small SMTP client: enough of RFC 5321 to hand one PDF to a mail provider,
// with no dependency to vendor and nothing that can change what leaves the
// machine behind the owner's back.
//
// Every step keeps the server's own reply text, because "the mail failed" is
// useless next to "535 5.7.8 Username and Password not accepted".

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 20_000;

class SmtpError extends Error {
  constructor(step, detail, replies) {
    super(`${step}: ${detail}`);
    this.name = 'SmtpError';
    this.step = step;
    this.replies = replies.slice(-8);
  }
}

function lastReply(replies) {
  for (let i = replies.length - 1; i >= 0; i -= 1) {
    if (/^\d{3} /.test(replies[i])) return replies[i];
  }
  return replies.length ? replies[replies.length - 1] : 'the mail server said nothing';
}

// One SMTP conversation over one socket. The same object survives a STARTTLS
// upgrade by moving its listeners onto the encrypted wrapper.
class Conn {
  constructor(socket, replies) {
    this.sock = socket;
    this.replies = replies;
    this.buf = '';
    this.waiters = [];
    this.done = [];
    this.attach();
  }

  attach() {
    this.handlers = {
      data: (chunk) => { this.buf += chunk.toString('latin1'); this.pump(); },
      end: () => this.fail('the mail server closed the connection early'),
      error: (err) => this.fail(err.message),
      timeout: () => this.fail('timed out waiting for a reply'),
    };
    this.sock.on('data', this.handlers.data);
    this.sock.on('end', this.handlers.end);
    this.sock.on('error', this.handlers.error);
    this.sock.on('timeout', this.handlers.timeout);
  }

  detach() {
    this.sock.off('data', this.handlers.data);
    this.sock.off('end', this.handlers.end);
    this.sock.off('error', this.handlers.error);
    this.sock.off('timeout', this.handlers.timeout);
  }

  pump() {
    for (;;) {
      const idx = this.buf.indexOf('\r\n');
      if (idx < 0) return;
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      // A multi-line reply puts every line in the log; only the last one, which
      // carries a space rather than a hyphen, ends the turn.
      this.replies.push(line);
      if (!/^\d{3} /.test(line)) continue;
      const code = line.slice(0, 3);
      const w = this.waiters.shift();
      if (w) w(code);
      else this.done.push(code);
    }
  }

  fail(message) {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w.reject(new SmtpError('connection', message, this.replies));
  }

  expect(codes, timeoutMs) {
    if (this.done.length) {
      const code = this.done.shift();
      return codes.length && !codes.includes(code)
        ? Promise.reject(new SmtpError('reply', lastReply(this.replies), this.replies))
        : Promise.resolve(code);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(settle);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new SmtpError('reply', `no reply within ${timeoutMs / 1000}s (wanted ${codes.join(' or ')})`, this.replies));
      }, timeoutMs);
      const settle = (code) => {
        clearTimeout(timer);
        if (codes.length && !codes.includes(code)) {
          reject(new SmtpError('reply', lastReply(this.replies), this.replies));
          return;
        }
        resolve(code);
      };
      const w = settle;
      w.reject = reject;
      this.waiters.push(w);
    });
  }

  send(line) { this.sock.write(`${line}\r\n`); }

  async command(line, ...codes) {
    this.send(line);
    return this.expect(codes, this.timeoutMs);
  }

  upgrade(host) {
    this.detach();
    return new Promise((resolve, reject) => {
      const secure = tls.connect({ socket: this.sock, servername: host, rejectUnauthorized: true });
      secure.once('secureConnect', () => {
        secure.setTimeout(this.timeoutMs);
        const next = new Conn(secure, this.replies);
        next.timeoutMs = this.timeoutMs;
        this.done = next.done = this.done;
        resolve(next);
      });
      secure.once('error', (err) => reject(new SmtpError('starttls', err.message, this.replies)));
    });
  }

  destroy() { try { this.sock.destroy(); } catch { /* already gone */ } }
}

function open({ host, port, security }, timeoutMs) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, servername: host };
    const socket = security === 'tls' ? tls.connect(opts) : net.connect(opts);
    const onErr = (err) => { socket.destroy(); reject(new SmtpError('connect', err.message, [])); };
    socket.once('error', onErr);
    socket.setTimeout(timeoutMs);
    const settle = () => {
      socket.removeListener('error', onErr);
      socket.setTimeout(timeoutMs);
      const conn = new Conn(socket, []);
      conn.timeoutMs = timeoutMs;
      resolve(conn);
    };
    if (security === 'tls') socket.once('secureConnect', settle);
    else socket.once('connect', settle);
  });
}

function headerEncode(value) {
  const s = String(value ?? '');
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function dotStuff(text) {
  return String(text ?? '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

function chunk64(buffer) {
  const b64 = buffer.toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\r\n');
}

function safeName(name) {
  return String(name || 'report.pdf').replace(/["\\\r\n]/g, '').slice(0, 120);
}

// Split out from the socket work so the MIME can be read without a server.
function buildMessage({ from, to, subject, text, attachment }) {
  const recipients = (Array.isArray(to) ? to : [to]).map((a) => String(a || '').trim()).filter(Boolean);
  const base = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${headerEncode(from)}`,
    `To: ${recipients.map(headerEncode).join(', ')}`,
    `Subject: ${headerEncode(subject)}`,
    `Message-ID: <${crypto.randomBytes(10).toString('hex')}@wealth-ledger.local>`,
    'MIME-Version: 1.0',
  ];

  if (!attachment) {
    return { raw: `${base.join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${dotStuff(text)}\r\n`, recipients };
  }

  const boundary = `----=_WealthLedger_${crypto.randomBytes(8).toString('hex')}`;
  const name = safeName(attachment.fileName);
  const raw = [
    base.join('\r\n'),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    dotStuff(text),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    chunk64(attachment.buffer),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { raw, recipients };
}

// config: { host, port, security: 'starttls'|'tls'|'none', user, pass, from }
async function sendMail(config, message, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const port = Number(config.port) || (config.security === 'tls' ? 465 : 587);
  const security = config.security || (port === 465 ? 'tls' : 'starttls');
  if (!config.host) throw new SmtpError('config', 'no mail server host is saved', []);
  const { raw, recipients } = buildMessage(message);
  if (!recipients.length) throw new SmtpError('recipient', 'no address to send to', []);
  if (!message.from) throw new SmtpError('sender', 'no sending address is saved', []);

  let conn = await open({ host: config.host, port, security }, timeoutMs);
  try {
    await conn.expect(['220'], timeoutMs);
    await conn.command(`EHLO wealth-ledger.local`, '250');

    if (security === 'starttls') {
      await conn.command('STARTTLS', '220');
      conn = await conn.upgrade(config.host);
      await conn.command(`EHLO wealth-ledger.local`, '250');
    }

    const caps = conn.replies.slice(-8).join(' ');
    if (config.user && config.pass) {
      await conn.command('AUTH LOGIN', '334');
      await conn.command(Buffer.from(String(config.user), 'utf8').toString('base64'), '334');
      await conn.command(Buffer.from(String(config.pass), 'utf8').toString('base64'), '235');
    } else if (/\bAUTH\b/i.test(caps)) {
      throw new SmtpError('auth', 'the mail server wants a username and password, and none is saved on the report tab', conn.replies);
    }

    await conn.command(`MAIL FROM:<${message.from}>`, '250');
    for (const to of recipients) await conn.command(`RCPT TO:<${to}>`, '250', '251');
    await conn.command('DATA', '354');
    conn.send(raw);
    conn.send('.');
    await conn.expect(['250'], timeoutMs);
    await conn.command('QUIT', '221').catch(() => { /* a server that hangs up first is fine */ });
    return { ok: true, recipients, bytes: Buffer.byteLength(raw, 'latin1'), security, host: config.host, port };
  } finally {
    conn.destroy();
  }
}

module.exports = { sendMail, buildMessage, SmtpError, Conn, DEFAULT_TIMEOUT_MS };
