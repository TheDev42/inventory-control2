import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cap, formatOutputs } from './catalog.js';

// Company logo shown on the PDF header. It sits directly on the dark blue band, so use a white logo with a
// transparent background. Override with LOGO_PATH.
const LOGO_PATH = process.env.LOGO_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'FaderUp-Logo-white.png');
let logoData = null;
try { logoData = fs.readFileSync(LOGO_PATH); } catch { /* no logo file: the header is text only */ }

const INK = '#1a1a19';
const MUTED = '#6b6a66';
const BRAND = '#1f3a5f';
const BAND = '#e6ebf2';
const ZEBRA = '#f6f7f9';
const LINE = '#d5d7dc';
const RED = '#b3261e';

/* ---------- ordering & grouping (pure, exported for tests) ---------- */

const cmpStr = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true, sensitivity: 'base' });
const cmpNum = (a, b) => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
};

// Category, then type, then anything that makes two items "the same kit": male end, female end, length,
// description. Barcode is only the last tie-break, so identical items sit next to each other.
export function sortForSheet(items) {
  return [...items].sort((a, b) =>
    cmpStr(a.category, b.category) || cmpStr(a.type, b.type) ||
    cmpStr(a.male_connector, b.male_connector) || cmpStr(a.female_connector, b.female_connector) ||
    cmpStr(a.input_connector, b.input_connector) || cmpStr(a.outputs, b.outputs) ||
    cmpNum(a.length_m, b.length_m) || cmpStr(a.name, b.name) || cmpStr(a.barcode, b.barcode));
}

// Client copy: identical items collapse into one line with a quantity. Description is part of "identical"
// so that two different things (e.g. a 12" and a 15" speaker) are never merged just because they have no connectors.
export function groupForClient(items) {
  const groups = new Map();
  for (const it of items) {
    const key = [it.category, it.type, it.name, it.male_connector, it.female_connector, it.input_connector, it.outputs, it.length_m]
      .map((v) => String(v ?? '').trim().toLowerCase()).join('|');
    let g = groups.get(key);
    if (!g) {
      g = {
        category: it.category, type: it.type, name: it.name,
        male_connector: it.male_connector, female_connector: it.female_connector,
        input_connector: it.input_connector, outputs: it.outputs, length_m: it.length_m, qty: 0,
      };
      groups.set(key, g);
    }
    g.qty++;
  }
  return sortForSheet([...groups.values()]);
}

/* ---------- formatting ---------- */

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
// Compact numeric date for narrow columns, e.g. 20/09/2026
const fmtShort = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

export function safeFilename(name) {
  return String(name || 'rental').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'rental';
}

/* ---------- the two layouts ---------- */

const INTERNAL = {
  subtitle: 'Equipment hire sheet',
  rowH: 19,
  fontSize: 8.5,
  columns: [
    { key: 'n', title: '#', w: 24, align: 'right' },
    { key: 'barcode', title: 'Barcode', w: 92, bold: true },
    { key: 'type', title: 'Type', w: 84 },
    { key: 'name', title: 'Description', w: 186 },
    { key: 'male', title: 'Male end', w: 96 },
    { key: 'female', title: 'Female end', w: 96 },
    { key: 'len', title: 'Length', w: 40, align: 'right' },
    { key: 'pat', title: 'PAT tested', w: 70 },
    { key: 'ret', title: 'Returned', w: 82 },
  ],
};

const CLIENT = {
  subtitle: 'Equipment hire list',
  rowH: 21,
  fontSize: 9.5,
  columns: [
    { key: 'qty', title: 'Qty', w: 50, align: 'right', bold: true },
    { key: 'type', title: 'Type', w: 100 },
    { key: 'name', title: 'Description', w: 270 },
    { key: 'male', title: 'Male end', w: 130 },
    { key: 'female', title: 'Female end', w: 130 },
    { key: 'len', title: 'Length', w: 90, align: 'right' },
  ],
};

const lenText = (v) => (v != null ? `${v} m` : '');

// A distro has no male/female end: its input and outputs are printed together, wrapped across the connector columns.
const distroText = (it) => {
  const outs = formatOutputs(it.outputs);
  return [it.input_connector ? `In: ${it.input_connector}` : '', outs ? `Out: ${outs}` : ''].filter(Boolean).join('\n');
};

// Turns rental rows into printable lines: { category, weight, cells, lost?, returned_at?, box? }
function internalLines(items) {
  return sortForSheet(items).map((it, i) => ({
    category: it.category,
    type: it.type,
    weight: 1,
    lost: it.outcome === 'lost' || (it.outcome === null && it.status === 'lost'),
    returned_at: it.returned_at,
    span: distroText(it),
    cells: {
      n: String(i + 1),
      barcode: it.barcode,
      type: cap(it.type),
      name: it.name || '',
      male: it.male_connector || '',
      female: it.female_connector || '',
      len: lenText(it.length_m),
      pat: it.pat_required ? (it.last_pat_date ? fmtShort(it.last_pat_date) : 'never') : 'n/a',
    },
  }));
}

function clientLines(items) {
  return groupForClient(items).map((g) => ({
    category: g.category,
    type: g.type,
    weight: g.qty,
    span: distroText(g),
    cells: {
      qty: String(g.qty),
      type: cap(g.type),
      name: g.name || '',
      male: g.male_connector || '',
      female: g.female_connector || '',
      len: lenText(g.length_m),
    },
  }));
}

export const sheetLines = { internal: internalLines, client: clientLines };

/* ---------- renderer ---------- */

export function writeRentalPdf(res, { rental, items, company, mode = 'internal' }) {
  const layout = mode === 'client' ? CLIENT : INTERNAL;
  const lines = sheetLines[mode === 'client' ? 'client' : 'internal'](items);
  const totalUnits = lines.reduce((s, l) => s + l.weight, 0);
  const { columns, rowH: ROW_H } = layout;

  const doc = new PDFDocument({
    size: 'A4', layout: 'landscape', margin: 36, bufferPages: true,
    info: { Title: `${layout.subtitle} - ${rental.name}`, Author: company },
  });
  doc.pipe(res);

  const left = doc.page.margins.left;
  const tableW = columns.reduce((s, c) => s + c.w, 0);
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24; // leave room for footer

  const fit = (text, width) => {
    let s = String(text ?? '');
    if (doc.widthOfString(s) <= width) return s;
    while (s.length > 1 && doc.widthOfString(s + '…') > width) s = s.slice(0, -1);
    return s + '…';
  };
  const textY = (size) => (ROW_H - size) / 2 - 0.5; // vertically centre text in a row

  /* ----- header block ----- */
  doc.rect(0, 0, doc.page.width, 64).fill(BRAND);
  let headX = left;
  if (logoData) {
    const img = doc.openImage(logoData);
    const scale = Math.min(150 / img.width, 46 / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    doc.image(img, left, (64 - h) / 2, { width: w, height: h });
    headX = left + w + 18;
  }
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text(company, headX, 18, { lineBreak: false });
  doc.font('Helvetica').fontSize(11).text(layout.subtitle, headX, 41, { lineBreak: false });
  doc.font('Helvetica').fontSize(9).text(`Generated ${fmtDate(new Date().toISOString())}`,
    left, 26, { width: tableW, align: 'right', lineBreak: false });

  let y = 82;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(rental.name, left, y, { width: tableW, lineBreak: false });
  y += 24;

  const dates = rental.start_date || rental.end_date
    ? `${fmtDate(rental.start_date) || '?'}  to  ${fmtDate(rental.end_date) || '?'}` : '—';
  const meta = mode === 'client'
    ? [['Customer', rental.customer || '—'], ['Hire dates', dates], ['Total items', String(totalUnits)]]
    : [['Customer', rental.customer || '—'], ['Hire dates', dates],
      ['Status', rental.status === 'completed' ? 'Completed' : 'Active'], ['Items', String(totalUnits)]];
  const metaW = tableW / meta.length;
  meta.forEach(([label, value], i) => {
    const x = left + i * metaW;
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label.toUpperCase(), x, y, { width: metaW - 8, lineBreak: false });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(fit(value, metaW - 8), x, y + 11, { width: metaW - 8, lineBreak: false });
  });
  y += 34;

  // Notes are internal (delivery details, contacts, etc.), so they stay off the client copy.
  if (mode !== 'client' && rental.notes) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('NOTES', left, y, { lineBreak: false });
    doc.fillColor(INK).font('Helvetica').fontSize(9.5).text(rental.notes, left, y + 11, { width: tableW, height: 36, ellipsis: true });
    y += 11 + Math.min(36, doc.heightOfString(rental.notes, { width: tableW })) + 8;
  }

  /* ----- summary by type ----- */
  const counts = new Map();
  for (const l of lines) {
    const key = `${l.category}|${l.type}`;
    counts.set(key, (counts.get(key) || 0) + l.weight);
  }
  if (counts.size) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('SUMMARY', left, y, { lineBreak: false });
    y += 11;
    let x = left;
    doc.font('Helvetica').fontSize(9);
    for (const [key, n] of [...counts].sort()) {
      const [category, type] = key.split('|');
      const label = `${cap(category)} / ${type}: ${n}`;
      const w = doc.widthOfString(label) + 14;
      if (x + w > left + tableW) { x = left; y += 20; }
      doc.roundedRect(x, y, w, 16, 3).fill(BAND);
      doc.fillColor(INK).text(label, x + 7, y + 4, { lineBreak: false });
      x += w + 6;
    }
    y += 26;
  }

  /* ----- table ----- */
  const drawHead = () => {
    doc.rect(left, y, tableW, 19).fill(BRAND);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    let x = left;
    for (const c of columns) {
      doc.text(c.title, x + 4, y + 6, { width: c.w - 8, align: c.align || 'left', lineBreak: false });
      x += c.w;
    }
    y += 19;
  };

  const ensure = (needed) => {
    if (y + needed > bottom()) { doc.addPage(); y = doc.page.margins.top; drawHead(); return true; }
    return false;
  };

  if (!lines.length) {
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(11).text('No items have been scanned onto this rental yet.', left, y);
  } else {
    drawHead();
    let lastCat = null;
    let zebra = false;
    const fs = layout.fontSize;
    for (const l of lines) {
      if (l.category !== lastCat) {
        ensure(ROW_H * 2);
        const catCount = lines.filter((x) => x.category === l.category).reduce((s, x) => s + x.weight, 0);
        doc.rect(left, y, tableW, ROW_H).fill(BAND);
        doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(9)
          .text(`${l.category}  ·  ${catCount} item${catCount === 1 ? '' : 's'}`, left + 4, y + textY(9), { lineBreak: false });
        y += ROW_H;
        lastCat = l.category;
        zebra = false;
      }
      // Distros print "In: … / Out: …" wrapped across the male + female (+ length, when empty) columns, so their row grows to fit.
      const spanKeys = l.span ? ['male', 'female', ...(l.cells.len ? [] : ['len'])] : [];
      const spanW = columns.filter((c) => spanKeys.includes(c.key)).reduce((s, c) => s + c.w, 0) - 8;
      let rh = ROW_H;
      if (l.span) {
        doc.font('Helvetica').fontSize(fs);
        rh = Math.max(ROW_H, Math.ceil(doc.heightOfString(l.span, { width: spanW, lineGap: 1 })) + 8);
      }
      const ty = rh === ROW_H ? textY(fs) : 4; // tall rows are top-aligned so every cell lines up with the first text line
      ensure(rh);
      if (zebra) doc.rect(left, y, tableW, rh).fill(ZEBRA);
      zebra = !zebra;

      let x = left;
      for (const c of columns) {
        if (l.span && spanKeys.includes(c.key)) {
          if (c.key === 'male') doc.fillColor(INK).font('Helvetica').fontSize(fs).text(l.span, x + 4, y + ty, { width: spanW, lineGap: 1 });
        } else if (c.key === 'ret') {
          if (l.lost) {
            doc.fillColor(RED).font('Helvetica-Bold').fontSize(fs).text('LOST', x + 4, y + ty, { width: c.w - 8, lineBreak: false });
          } else if (l.returned_at) {
            doc.fillColor(INK).font('Helvetica').fontSize(fs).text(fmtShort(l.returned_at), x + 4, y + ty, { width: c.w - 8, lineBreak: false });
          } else {
            doc.lineWidth(0.8).strokeColor(MUTED).rect(x + 6, y + (rh === ROW_H ? (ROW_H - 10) / 2 : 4), 10, 10).stroke();
          }
        } else {
          doc.fillColor(INK).font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs);
          doc.text(fit(l.cells[c.key], c.w - 8), x + 4, y + ty, { width: c.w - 8, align: c.align || 'left', lineBreak: false });
        }
        x += c.w;
      }
      doc.moveTo(left, y + rh).lineTo(left + tableW, y + rh).lineWidth(0.4).strokeColor(LINE).stroke();
      y += rh;
    }

    /* ----- sign-off ----- */
    y += 26;
    if (y + 90 > bottom()) { doc.addPage(); y = doc.page.margins.top; } // new page, without repeating the table header
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    const colW = (tableW - 40) / 2;
    [['Issued by', left], ['Received by', left + colW + 40]].forEach(([label, x]) => {
      doc.strokeColor(MUTED).lineWidth(0.6).moveTo(x, y + 28).lineTo(x + colW, y + 28).stroke();
      doc.text(`${label} (name & signature)`, x, y + 32, { width: colW, lineBreak: false });
      doc.strokeColor(MUTED).moveTo(x, y + 62).lineTo(x + 140, y + 62).stroke();
      doc.text('Date', x, y + 66, { lineBreak: false });
    });
  }

  /* ----- footers ----- */
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // otherwise text this low triggers an automatic new page
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    doc.text(`${company}  ·  ${rental.name}`, left, doc.page.height - 26, { width: tableW / 2, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + tableW / 2, doc.page.height - 26,
      { width: tableW / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = oldBottom;
  }
  doc.end();
}
