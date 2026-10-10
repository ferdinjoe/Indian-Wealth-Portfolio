// A minimal PDF 1.4 writer with no dependency: the base-14 Helvetica pair, text
// runs, rules, rectangles and tables, assembled into an xref-correct buffer.
//
// Streams are written uncompressed on purpose. A report has to be readable by
// the test suite byte for byte, and flate would hide every figure inside it.
//
// The rupee sign is not in WinAnsiEncoding, so core fonts cannot draw it: money
// in this document reads "Rs 1,23,456" and moneyInet() does that substitution.

const PAGE_W = 595.28;
const PAGE_H = 841.89;

const W_NORMAL = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833,
  n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
};

const W_BOLD = {
  ' ': 278, '!': 333, '"': 474, '#': 556, '$': 556, '%': 889, '&': 722, "'": 238,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  ':': 333, ';': 333, '<': 584, '=': 584, '>': 584, '?': 611, '@': 975,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 333, '\\': 278, ']': 333, '^': 584, _: 556, '`': 333,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278, m: 889,
  n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
  '{': 389, '|': 280, '}': 389, '~': 584,
};

// Only the punctuation the app actually prints. Anything else falls to '?',
// which is visible and honest rather than a missing glyph that looks like a gap.
const UNICODE_TO_WINANSI = {
  0x20AC: 0x80, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94,
  0x2013: 0x96, 0x2014: 0x97, 0x2022: 0x95, 0x2026: 0x85, 0x2030: 0x89,
  0x00A0: 0xA0,
};

// The rupee sign has no byte in WinAnsi and no glyph in Helvetica, so it becomes
// the word traders use in a plain-text document rather than being dropped.
const RUPEE = 'Rs';

function encode(str) {
  let out = '';
  for (const ch of String(str ?? '')) {
    const c = ch.codePointAt(0);
    if (ch === '₹') { out += RUPEE; continue; }
    if (c === 0x20) { out += ' '; continue; }
    if (c >= 0x21 && c <= 0x7e) { out += ch; continue; }
    if (c >= 0xa1 && c <= 0xff) { out += ch; continue; }
    const mapped = UNICODE_TO_WINANSI[c];
    if (mapped) { out += String.fromCharCode(mapped); continue; }
    out += '?';
  }
  return out;
}

function escapeText(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function widthOf(text, size, bold) {
  const table = bold ? W_BOLD : W_NORMAL;
  let total = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 0xa1 && c <= 0xff) { total += 556; continue; }
    const w = table[ch];
    total += w === undefined ? 556 : w;
  }
  return total * size / 1000;
}

const INK = [0.13, 0.16, 0.20];
const MUTED = [0.42, 0.46, 0.52];
const ACCENT = [0.11, 0.46, 0.42];
const WARN = [0.72, 0.36, 0.10];
const BAD = [0.70, 0.20, 0.22];

class Pdf {
  constructor({ title = 'Report', footer = '', author = '' } = {}) {
    this.title = title;
    this.footer = footer;
    this.author = author;
    this.left = 46;
    this.right = PAGE_W - 46;
    this.bottom = 54;
    this.top = PAGE_H - 56;
    this.cursor = this.top;
    this.pages = [];
    this.newPage();
  }

  newPage() {
    this.page = [];
    this.pages.push(this.page);
    this.cursor = this.top;
  }

  ensure(height) {
    if (this.cursor - height < this.bottom) {
      this.newPage();
      return true;
    }
    return false;
  }

  space(h) { this.cursor -= h; }

  rule(color = MUTED, width = 0.6, gap = 4) {
    this.cursor -= gap;
    const y = this.cursor.toFixed(2);
    this.page.push(`${color.map((v) => v.toFixed(3)).join(' ')} RG ${width} w ${this.left} ${y} m ${this.right} ${y} l S`);
    this.cursor -= gap;
  }

  // One run of text at the current cursor, wrapped to maxWidth. The cursor ends
  // below the last line, so callers never have to know how many lines happened.
  text(str, { size = 9.5, bold = false, color = INK, maxWidth, indent = 0, align = 'left', gap = 3, leading = 1.35 } = {}) {
    const x0 = this.left + indent;
    const avail = (maxWidth || (this.right - x0));
    const lines = wrap(encode(str), size, bold, avail);
    const lineHeight = size * leading;
    for (const line of lines) {
      this.cursor -= lineHeight;
      const w = widthOf(line, size, bold);
      let x = x0;
      if (align === 'right') x = this.right - indent - w;
      else if (align === 'center') x = x0 + (avail - w) / 2;
      if (x < this.left) x = this.left;
      this.page.push('BT', `/${bold ? 'TB' : 'TR'} ${size} Tf`, `${color.join(' ')} rg`,
        `1 0 0 1 ${x.toFixed(2)} ${this.cursor.toFixed(2)} Tm`, `(${escapeText(line)}) Tj`, 'ET');
    }
    this.cursor -= gap;
    return lines.length;
  }

  heading(str, { size = 13, color = ACCENT } = {}) {
    this.ensure(size * 2.6 + 20);
    this.space(8);
    this.text(str, { size, bold: true, color, gap: 2 });
    this.rule(ACCENT, 0.8, 3);
  }

  subheading(str) {
    this.space(4);
    this.text(str, { size: 10, bold: true, color: INK, gap: 2 });
  }

  paragraph(str, { color = MUTED, size = 8.6 } = {}) {
    this.text(str, { size, color, maxWidth: this.right - this.left });
  }

  // label on the left, value on the right of the same line.
  kv(label, value, { size = 9.5, color = INK, valueColor = INK, boldValue = false } = {}) {
    this.ensure(size * 1.5 + 4);
    const y = this.cursor - size * 1.15;
    this.page.push('BT', `/TR ${size} Tf`, `${MUTED.join(' ')} rg`, `1 0 0 1 ${this.left} ${y.toFixed(2)} Tm`,
      `(${escapeText(encode(label))}) Tj`, 'ET');
    // The value must not run into the label: a long one is clipped rather than
    // overlapping, because an unreadable figure is worse than a truncated one.
    const room = this.right - this.left - widthOf(encode(label), size, false) - 14;
    const text = fit(encode(value), room, size, boldValue);
    const x = this.right - widthOf(text, size, boldValue);
    this.page.push('BT', `/${boldValue ? 'TB' : 'TR'} ${size} Tf`, `${valueColor.join(' ')} rg`,
      `1 0 0 1 ${Math.max(this.left, x).toFixed(2)} ${y.toFixed(2)} Tm`, `(${escapeText(text)}) Tj`, 'ET');
    this.cursor -= size * 1.5 + 1;
  }

  table({ columns, rows, size = 8.6, header = true, zebra = true }) {
    const total = columns.reduce((a, c) => a + c.width, 0);
    const scale = (this.right - this.left) / total;
    const xs = [];
    let acc = this.left;
    for (const c of columns) { xs.push(acc); acc += c.width * scale; }
    const rowH = size * 1.85;

    const drawHeader = () => {
      if (!header) return;
      this.ensure(rowH * 2);
      const baseline = this.cursor - size * 1.3;
      columns.forEach((c, i) => {
        const text = encode(c.label);
        const w = widthOf(text, size, true);
        const x = c.align === 'right' ? xs[i] + c.width * scale - w - 3 : xs[i] + 3;
        this.page.push('BT', `/TB ${size} Tf`, `${MUTED.join(' ')} rg`, `1 0 0 1 ${x.toFixed(2)} ${baseline.toFixed(2)} Tm`,
          `(${escapeText(text)}) Tj`, 'ET');
      });
      this.cursor -= rowH * 0.75;
      this.page.push(`${MUTED.join(' ')} RG 0.6 w ${this.left} ${this.cursor.toFixed(2)} m ${this.right} ${this.cursor.toFixed(2)} l S`);
      this.cursor -= rowH * 0.55;
    };

    drawHeader();
    rows.forEach((row, n) => {
      if (this.ensure(rowH)) drawHeader();
      const baseline = this.cursor - size * 1.3;
      if (zebra && n % 2 === 1) {
        this.page.push('0.962 0.972 0.978 rg', `${this.left} ${baseline - 2.5} m`,
          `${this.right} ${baseline - 2.5} l`, `${this.right} ${baseline + size * 1.4} l`,
          `${this.left} ${baseline + size * 1.4} l`, 'f');
      }
      columns.forEach((c, i) => {
        const text = encode(row[i]);
        const w = widthOf(text, size, c.bold);
        const clipped = fit(text, c.width * scale - 8, size, c.bold);
        const x = c.align === 'right' ? xs[i] + c.width * scale - widthOf(clipped, size, c.bold) - 3 : xs[i] + 3;
        this.page.push('BT', `/${c.bold ? 'TB' : 'TR'} ${size} Tf`,
          `${(c.color ? c.color(row[i], n) : INK).join(' ')} rg`,
          `1 0 0 1 ${x.toFixed(2)} ${baseline.toFixed(2)} Tm`, `(${escapeText(clipped)}) Tj`, 'ET');
      });
      this.cursor -= rowH;
    });
    this.space(6);
  }

  // A boxed note: the report has a few sentences that must not read as data.
  note(str, { color = WARN } = {}) {
    const lines = wrap(encode(str), 8.6, false, this.right - this.left - 18);
    const h = lines.length * 11.6 + 12;
    if (this.ensure(h + 8)) this.space(6);
    const top = this.cursor - 4;
    const bottom = top - h;
    this.page.push('0.985 0.976 0.955 rg', `${this.left} ${bottom} m`, `${this.right} ${bottom} l`,
      `${this.right} ${top} l`, `${this.left} ${top} l`, 'f');
    this.page.push(`${color.map((v) => v.toFixed(3)).join(' ')} RG 2 w`,
      `${this.left} ${bottom} m`, `${this.left} ${top} l`, 'S');
    let y = top - 15;
    for (const line of lines) {
      this.page.push('BT', `/TR 8.6 Tf`, `${INK.join(' ')} rg`, `1 0 0 1 ${this.left + 11} ${y.toFixed(2)} Tm`,
        `(${escapeText(line)}) Tj`, 'ET');
      y -= 11.6;
    }
    this.cursor = bottom - 12;
  }

  build() {
    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };

    const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const resources = `<< /Font << /TR ${fontRegular} 0 R /TB ${fontBold} 0 R >> >>`;

    const pageIndexes = [];
    const contentIndexes = [];
    for (let i = 0; i < this.pages.length; i += 1) {
      contentIndexes.push(add(null));
      pageIndexes.push(add(null));
    }

    const kids = pageIndexes.map((n) => `${n} 0 R`).join(' ');
    const pagesObj = add(null);
    const catalogObj = add(null);
    const infoObj = add(null);

    const stamp = pdfDate(this.stampDate || new Date());
    objects[pagesObj - 1] = `<< /Type /Pages /Count ${this.pages.length} /Kids [ ${kids} ] >>`;
    objects[catalogObj - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[infoObj - 1] = `<< /Title (${escapeText(encode(this.title))}) /Producer (Wealth Ledger) /Author (${escapeText(encode(this.author))}) /CreationDate (${stamp}) >>`;

    this.pages.forEach((page, i) => {
      const stream = [...page, ...footerOps(this, i, this.pages.length)].join('\n');
      objects[contentIndexes[i] - 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
      objects[pageIndexes[i] - 1] = `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}] `
        + `/Resources ${resources} /Contents ${contentIndexes[i]} 0 R >>`;
    });

    const chunks = [];
    let offset = 0;
    const push = (str) => {
      const buf = Buffer.from(str, 'latin1');
      chunks.push(buf);
      offset += buf.length;
      return offset - buf.length;
    };

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const offsets = [];
    objects.forEach((body, i) => {
      offsets[i] = push(`${i + 1} 0 obj\n${body}\nendobj\n`);
    });
    const xrefAt = push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \r\n`);
    for (const at of offsets) push(`${String(at).padStart(10, '0')} 00000 n \r\n`);
    push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogObj} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

    return Buffer.concat(chunks);
  }
}

function footerOps(doc, index, total) {
  const y = 34;
  const ops = [];
  ops.push(`${MUTED.join(' ')} RG 0.5 w ${doc.left} ${y + 12} m ${doc.right} ${y + 12} l S`);
  if (doc.footer) {
    ops.push('BT', `/TR 7.6 Tf`, `${MUTED.join(' ')} rg`, `1 0 0 1 ${doc.left} ${y} Tm`,
      `(${escapeText(encode(doc.footer))}) Tj`, 'ET');
  }
  const label = encode(`Page ${index + 1} of ${total}`);
  const x = doc.right - widthOf(label, 7.6, false);
  ops.push('BT', `/TR 7.6 Tf`, `${MUTED.join(' ')} rg`, `1 0 0 1 ${x.toFixed(2)} ${y} Tm`,
    `(${escapeText(label)}) Tj`, 'ET');
  return ops;
}

function wrap(encoded, size, bold, maxWidth) {
  const words = encoded.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    const trial = line ? `${line} ${word}` : word;
    if (widthOf(trial, size, bold) <= maxWidth || !line) {
      line = trial;
      // A single word longer than the column gets broken so it cannot run off
      // the page: the alternative is an invisible tail.
      while (widthOf(line, size, bold) > maxWidth && line.length > 8) {
        let cut = line.length;
        while (cut > 1 && widthOf(line.slice(0, cut), size, bold) > maxWidth) cut -= 1;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fit(text, maxWidth, size, bold) {
  if (widthOf(text, size, bold) <= maxWidth) return text;
  let cut = text.length;
  while (cut > 1 && widthOf(`${text.slice(0, cut)}...`, size, bold) > maxWidth) cut -= 1;
  return `${text.slice(0, cut)}...`;
}

function pdfDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}'${pad(abs % 60)}'`;
}

module.exports = { Pdf, PAGE_W, PAGE_H, encode, widthOf, colors: { INK, MUTED, ACCENT, WARN, BAD } };
