import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cap, formatOutputs } from './catalog.js';

/*
 * Case / container labels: 4" x 6" portrait, black on white (for a thermal label printer).
 * Layout follows the hand-made "Burghfest" label: logo + Date across the top, Client | Event | Box No.,
 * then a big Contents box. The bottom strip carries a Code 128 barcode of the container's barcode so the case
 * can be scanned out / returned like anything else.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// Dark logo on white. Replace server/assets/FaderUp-Logo-black.png (or set LABEL_LOGO_PATH) to change it.
const LOGO_PATH = process.env.LABEL_LOGO_PATH || path.join(here, 'assets', 'FaderUp-Logo-black.png');
let logo = null;
try { logo = fs.readFileSync(LOGO_PATH); } catch { /* no logo file: the header falls back to the company name */ }

/* ---------- Code 128 (subset B: every printable ASCII character) ---------- */

// The 107 symbols: 103 data, 3 start codes (A / B / C) and the stop. '1' = bar module, '0' = space module.
const PATTERNS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100',
  '10011001000', '10011000100', '10001100100', '11001001000', '11001000100', '11000100100',
  '10110011100', '10011011100', '10011001110', '10111001100', '10011101100', '10011100110',
  '11001110010', '11001011100', '11001001110', '11011100100', '11001110100', '11101101110',
  '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000', '10001000110',
  '10110001000', '10001101000', '10001100010', '11010001000', '11000101000', '11000100010',
  '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110',
  '11101110110', '11010001110', '11000101110', '11011101000', '11011100010', '11011101110',
  '11101011000', '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100', '10010110000',
  '10010000110', '10000101100', '10000100110', '10110010000', '10110000100', '10011010000',
  '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010',
  '11000010100', '10001111010', '10100111100', '10010111100', '10010011110', '10111100100',
  '10011110100', '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000',
  '10111100010', '11110101000', '11110100010', '10111011110', '10111101110', '11101011110',
  '11110101110', '11010000100', '11010010000', '11010011100', '1100011101011',
];
const START_B = 104;
const STOP = 106;

// Returns the barcode as a string of modules, e.g. "11010010000…", including start, checksum and stop.
export function code128B(text) {
  const s = String(text ?? '');
  if (!s.length) throw new Error('Nothing to encode');
  let sum = START_B;
  let out = PATTERNS[START_B];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 32 || code > 126) throw new Error(`The character "${s[i]}" cannot be printed in a barcode`);
    const value = code - 32;
    sum += value * (i + 1);
    out += PATTERNS[value];
  }
  return out + PATTERNS[sum % 103] + PATTERNS[STOP];
}

/* ---------- contents text ---------- */

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// What one item is called on the label: its description, or (if it has none) built from type / ends / length
function itemText(it) {
  if (clean(it.name)) return clean(it.name);
  const parts = [`${cap(it.category)} ${it.type}`];
  if (it.male_connector || it.female_connector) parts.push(`${it.male_connector || '?'} to ${it.female_connector || '?'}`);
  if (it.input_connector || it.outputs) {
    const outs = formatOutputs(it.outputs);
    parts.push(`${it.input_connector || '?'} in${outs ? `, ${outs} out` : ''}`);
  }
  if (it.length_m != null) parts.push(`${it.length_m}m`);
  return parts.join(' ');
}

// "8 X 16A to 13A 4 way": identical items are counted together
export function contentsLines(items) {
  const groups = new Map();
  for (const it of items) {
    const text = itemText(it);
    const key = text.toLowerCase();
    const g = groups.get(key) || { text, qty: 0, sort: `${it.category}|${it.type}|${key}` };
    g.qty++;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => a.sort.localeCompare(b.sort, 'en', { numeric: true, sensitivity: 'base' }))
    .map((g) => `${g.qty} X ${g.text}`);
}

// 2026-09-24 -> 24/09/26 (like the old labels); anything else is printed as typed
export function labelDate(v) {
  const s = clean(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : s.slice(0, 20);
}

/* ---------- the label ---------- */

const W = 288; // 4 in, in PDF points
const H = 432; // 6 in

export function writeLabelPdf(res, { company = 'FaderUp', barcode, name, client, event, date, box, contents = [] }) {
  const bits = code128B(barcode); // throws before anything is written if the barcode can't be printed
  const doc = new PDFDocument({ size: [W, H], margin: 0, info: { Title: `Box label ${barcode}`, Author: company } });
  doc.pipe(res);

  const M = 8;
  const left = M;
  const right = W - M;
  const top = M;
  const bottom = H - M;
  const headH = 64;
  const rowH = 60;
  const stripH = 94;
  const y1 = top + headH;
  const y2 = y1 + rowH;
  const y3 = bottom - stripH;
  const x1 = 104;
  const x2 = 196;
  const INK = '#000000';

  // frame + grid
  doc.lineWidth(1.6).strokeColor(INK);
  doc.roundedRect(left, top, right - left, bottom - top, 12).stroke();
  for (const y of [y1, y2, y3]) doc.moveTo(left, y).lineTo(right, y).stroke();
  doc.moveTo(x2, top).lineTo(x2, y1).stroke();
  doc.moveTo(x1, y1).lineTo(x1, y2).stroke();
  doc.moveTo(x2, y1).lineTo(x2, y2).stroke();

  // largest font size (max..min) at which `text` fits in `lines` lines of `width`
  const fitSize = (text, font, width, lines, max, min) => {
    for (let size = max; size >= min; size -= 0.5) {
      doc.font(font).fontSize(size);
      if (doc.heightOfString(text, { width }) <= doc.currentLineHeight(true) * lines + 0.5) return size;
    }
    return min;
  };

  // header: logo (or the company name) + date
  if (logo) {
    const lw = 172;
    const lh = (lw * 648) / 2048;
    doc.image(logo, left + 8, top + (headH - lh) / 2, { width: lw });
  } else {
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text(company, left + 10, top + 20, { width: x2 - left - 20, lineBreak: false });
  }

  const cell = (label, value, x, y, w, lines) => {
    doc.fillColor(INK).font('Helvetica').fontSize(10).text(label, x + 8, y + 5, { width: w - 12, lineBreak: false });
    const text = clean(value);
    if (!text) return;
    const size = fitSize(text, 'Helvetica-Bold', w - 14, lines, 15, 8);
    doc.font('Helvetica-Bold').fontSize(size);
    doc.text(text, x + 8, y + 19, { width: w - 14, height: doc.currentLineHeight(true) * lines, ellipsis: true });
  };
  cell('Date', labelDate(date), x2, top, right - x2, 1);
  cell('Client', client, left, y1, x1 - left, 2);
  cell('Event', event, x1, y1, x2 - x1, 2);
  cell('Box No.', box, x2, y1, right - x2, 2);

  // contents: as large as fits (13pt down to 7pt); if it still doesn't fit, cut it off with a "+ N more" line
  doc.fillColor(INK).font('Helvetica').fontSize(10).text('Contents', left + 8, y2 + 5, { lineBreak: false });
  const cx = left + 12;
  const cy = y2 + 24;
  const cw = right - left - 24;
  const ch = y3 - cy - 6;
  const lines = contents.map(clean).filter(Boolean);
  if (lines.length) {
    const opts = (size) => ({ width: cw, lineGap: size * 0.18 });
    let size = 13;
    let shown = lines;
    for (; size >= 7; size -= 0.5) {
      doc.font('Helvetica').fontSize(size);
      if (doc.heightOfString(lines.join('\n'), opts(size)) <= ch) break;
    }
    if (size < 7) {
      size = 7;
      doc.font('Helvetica').fontSize(size);
      let used = 0;
      let n = 0;
      const moreH = doc.currentLineHeight(true) + size * 0.18; // room kept for the "+ N more" line
      while (n < lines.length) {
        const h = doc.heightOfString(lines[n], opts(size)); // includes the line gap
        if (used + h + moreH > ch) break;
        used += h;
        n++;
      }
      shown = [...lines.slice(0, n), `… + ${lines.length - n} more`];
    }
    doc.fillColor(INK).font('Helvetica').fontSize(size).text(shown.join('\n'), cx, cy, opts(size));
  }

  // barcode strip
  const avail = right - left - 24;
  const mod = Math.min(2.4, avail / bits.length);
  const bx = (W - bits.length * mod) / 2;
  const by = y3 + 10;
  const bh = 44;
  doc.fillColor(INK);
  for (let i = 0; i < bits.length;) {
    if (bits[i] !== '1') { i++; continue; }
    let j = i;
    while (j < bits.length && bits[j] === '1') j++;
    doc.rect(bx + i * mod, by, (j - i) * mod, bh).fill();
    i = j;
  }
  doc.font('Helvetica-Bold').fontSize(13).text(String(barcode), left, by + bh + 5, { width: right - left, align: 'center', lineBreak: false });
  if (clean(name)) {
    doc.font('Helvetica').fontSize(9).text(clean(name), left + 12, by + bh + 22, { width: right - left - 24, align: 'center', height: 11, ellipsis: true });
  }

  doc.end();
}
