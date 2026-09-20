import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { all, db, DATA_DIR, HttpError, today } from './db.js';
import { CATALOG, CONNECTOR_SUGGESTIONS, CONNECTOR_TYPES, OUTPUT_TYPES, STATUSES, STATUS_LABEL, PAT_STATUSES, BARCODE_DIGITS, formatOutputs } from './catalog.js';
import * as items from './items.js';
import * as rentals from './rentals.js';
import * as containers from './containers.js';
import { handleScan } from './scan.js';
import { dashboard } from './dashboard.js';
import { writeRentalPdf, safeFilename } from './pdf.js';
import { writeLabelPdf, code128B } from './label.js';

const app = express();
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COMPANY = process.env.COMPANY_NAME || 'FaderUp';
const id = (req) => {
  const n = parseInt(req.params.id, 10);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Invalid id');
  return n;
};

app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* Optional basic-auth: set AUTH_USER and AUTH_PASS */
if (process.env.AUTH_USER && process.env.AUTH_PASS) {
  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
  app.use((req, res, next) => {
    const [scheme, b64] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && b64) {
      const decoded = Buffer.from(b64, 'base64').toString();
      const i = decoded.indexOf(':');
      if (i >= 0 && same(decoded.slice(0, i), process.env.AUTH_USER) && same(decoded.slice(i + 1), process.env.AUTH_PASS)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Inventory"').status(401).send('Authentication required');
  });
}

app.use(express.json({ limit: '5mb' }));

/* ---------- meta ---------- */
app.get('/api/meta', (_req, res) => {
  const seen = new Set(CONNECTOR_SUGGESTIONS.map((c) => c.toLowerCase()));
  const connectors = [...CONNECTOR_SUGGESTIONS];
  for (const r of all(`SELECT male_connector AS c FROM items WHERE male_connector IS NOT NULL
                       UNION SELECT female_connector FROM items WHERE female_connector IS NOT NULL
                       UNION SELECT input_connector FROM items WHERE input_connector IS NOT NULL
                       UNION SELECT json_extract(o.value, '$.connector') FROM items, json_each(items.outputs) o
                         WHERE items.outputs IS NOT NULL AND json_valid(items.outputs)
                       ORDER BY 1`)) {
    if (!seen.has(r.c.toLowerCase())) { seen.add(r.c.toLowerCase()); connectors.push(r.c); }
  }
  res.json({
    catalog: CATALOG,
    connectorTypes: [...CONNECTOR_TYPES],
    outputTypes: [...OUTPUT_TYPES],
    statuses: STATUSES,
    statusLabels: STATUS_LABEL,
    patStatuses: PAT_STATUSES,
    connectors,
    barcodeDigits: BARCODE_DIGITS,
    company: COMPANY,
    today: today(),
  });
});

app.get('/api/dashboard', (_req, res) => res.json(dashboard()));

/* ---------- scanning ---------- */
app.post('/api/scan', (req, res) => res.json(handleScan(req.body)));

/* ---------- items ---------- */
app.get('/api/items', (req, res) => res.json(items.listItems(req.query)));

app.get('/api/items/export.csv', (req, res) => {
  const { items: rows } = items.listItems({ ...req.query, limit: 1000, offset: 0 });
  const total = items.listItems({ ...req.query, limit: 1 }).total;
  let list = rows;
  for (let off = 1000; off < total; off += 1000) list = list.concat(items.listItems({ ...req.query, limit: 1000, offset: off }).items);
  const cols = ['barcode', 'category', 'type', 'name', 'male_connector', 'female_connector', 'input_connector', 'outputs', 'length_m', 'status',
    'rental_name', 'container_name', 'pat_required', 'pat_status', 'last_pat_date', 'next_pat_due'];
  // Guard against spreadsheet formula injection in text cells
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...list.map((r) => cols.map((c) => cell(c === 'outputs' ? formatOutputs(r.outputs, '; ') : r[c])).join(','))].join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="inventory-${today()}.csv"` });
  res.send('﻿' + csv);
});

app.post('/api/items/bulk', (req, res) => res.json(items.bulkCreate(req.body?.items)));
app.post('/api/items', (req, res) => res.status(201).json(items.createItem(req.body || {})));
// null (not a 404) when the barcode is unknown, so the UI can check without a console error
app.get('/api/items/lookup/:barcode', (req, res) => res.json(items.getItemByBarcode(req.params.barcode) || null));
app.get('/api/items/:id', (req, res) => res.json(items.itemDetail(id(req))));
app.put('/api/items/:id', (req, res) => res.json(items.updateItem(id(req), req.body || {})));
app.delete('/api/items/:id', (req, res) => { items.deleteItem(id(req)); res.json({ ok: true }); });
app.post('/api/items/:id/marker', (req, res) => res.json(items.setMarker(id(req), req.body?.status, req.body?.note)));
app.post('/api/items/:id/comments', (req, res) => res.status(201).json(items.addComment(id(req), req.body?.text)));
app.post('/api/items/:id/pat', (req, res) => res.status(201).json(items.recordPat(id(req), req.body || {})));
app.delete('/api/items/:id/pat/:testId', (req, res) => res.json(items.deletePatTest(id(req), parseInt(req.params.testId, 10))));
app.post('/api/items/:id/unstore', (req, res) => res.json(containers.unstoreItem(id(req))));
app.post('/api/items/:id/return', (req, res) => {
  const item = items.getItem(id(req));
  if (!item) throw new HttpError(404, 'Item not found');
  if (item.status === 'sold') throw new HttpError(409, 'Item is SOLD — undo the sale from its item page first');
  res.json(items.returnItem(item));
});
app.delete('/api/comments/:id', (req, res) => { items.deleteComment(id(req)); res.json({ ok: true }); });

/* ---------- rentals ---------- */
app.get('/api/rentals', (req, res) => res.json(rentals.listRentals(req.query)));
app.post('/api/rentals', (req, res) => res.status(201).json(rentals.createRental(req.body || {})));
app.get('/api/rentals/:id', (req, res) => res.json(rentals.rentalDetail(id(req))));
app.put('/api/rentals/:id', (req, res) => res.json(rentals.updateRental(id(req), req.body || {})));
app.delete('/api/rentals/:id', (req, res) => { rentals.deleteRental(id(req)); res.json({ ok: true }); });
app.post('/api/rentals/:id/complete', (req, res) => res.json(rentals.completeRental(id(req), !!req.body?.markLost)));
app.post('/api/rentals/:id/reopen', (req, res) => res.json(rentals.reopenRental(id(req))));
// Manual picker: add the chosen items to the rental in one go (same rules as scanning them OUT)
app.post('/api/rentals/:id/items', (req, res) => res.json(rentals.addItemsToRental(id(req), req.body?.itemIds, req.body?.caseId)));
// Shipment: which cases are on the rental, and which case each line is packed in (caseId null/"" = no case)
app.put('/api/rentals/:id/case', (req, res) => res.json(rentals.assignCase(id(req), req.body?.itemIds, req.body?.caseId)));
app.post('/api/rentals/:id/cases', (req, res) => res.status(201).json(rentals.addCaseToRental(id(req), req.body?.caseId)));
app.delete('/api/rentals/:id/cases/:caseId', (req, res) => res.json(rentals.removeCaseFromRental(id(req), parseInt(req.params.caseId, 10))));
app.delete('/api/rentals/:id/items/:itemId', (req, res) => {
  res.json(rentals.removeFromRental(id(req), parseInt(req.params.itemId, 10)));
});
// Two PDFs per rental: the internal hire sheet (barcodes, PAT, return boxes) and the client copy (quantities only).
const sendRentalPdf = (mode, prefix) => (req, res) => {
  const { rental, items: rows } = rentals.rentalDetail(id(req));
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${prefix}-${safeFilename(rental.name)}.pdf"`,
  });
  // Upright A4 by default; ?orientation=landscape gives the wide layout
  writeRentalPdf(res, { rental, items: rows, company: COMPANY, mode, orientation: req.query.orientation === 'landscape' ? 'landscape' : 'portrait' });
};
app.get('/api/rentals/:id/pdf', sendRentalPdf('internal', 'internal-hire-sheet'));
app.get('/api/rentals/:id/client-pdf', sendRentalPdf('client', 'client-hire-list'));

/* ---------- containers ---------- */
app.get('/api/containers', (req, res) => res.json(containers.listContainers(req.query.q, req.query.kind)));
app.post('/api/containers', (req, res) => res.status(201).json(containers.createContainer(req.body || {})));
app.get('/api/containers/:id', (req, res) => res.json(containers.containerDetail(id(req))));
app.put('/api/containers/:id', (req, res) => res.json(containers.updateContainer(id(req), req.body || {})));
app.delete('/api/containers/:id', (req, res) => { containers.deleteContainer(id(req)); res.json({ ok: true }); });
// 4" x 6" case label. Query: client, event, date (YYYY-MM-DD), box, contents (one line per row), download=1 to save instead of
// opening. Any of those left out is filled in from the case (its contents, and the rental it is packed for), like the form does.
app.get('/api/containers/:id/label-defaults', (req, res) => res.json(containers.labelDefaults(id(req))));
app.get('/api/containers/:id/label.pdf', (req, res) => {
  const defaults = containers.labelDefaults(id(req)); // 404 for an unknown container
  try { code128B(defaults.barcode); } catch (err) { throw new HttpError(400, `${err.message} (container ${defaults.barcode})`); }
  const q = req.query;
  const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const field = (key, max) => clean(typeof q[key] === 'string' ? q[key] : defaults[key], max);
  const contents = (typeof q.contents === 'string' ? q.contents : defaults.contents)
    .split(/\r?\n/).map((l) => clean(l, 120)).filter(Boolean).slice(0, 80);
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${q.download === '1' ? 'attachment' : 'inline'}; filename="label-${safeFilename(defaults.name)}.pdf"`,
  });
  writeLabelPdf(res, {
    company: COMPANY, barcode: defaults.barcode, name: defaults.name,
    client: field('client', 60), event: field('event', 60), date: field('date', 20), box: field('box', 20), contents,
  });
});
// Deletes temporary boxes that have finished their job (used on a rental, now empty and not on an active rental)
app.post('/api/containers/clear-temporary', (_req, res) => res.json({ removed: containers.clearFinishedTemporary() }));
app.post('/api/containers/:id/empty', (req, res) => res.json({ removed: containers.emptyContainer(id(req)) }));

/* ---------- activity + backup ---------- */
app.get('/api/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  res.json(all('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit));
});

app.get('/api/backup', (_req, res, next) => {
  const file = path.join(DATA_DIR, `backup-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } catch (err) { return next(err); }
  res.download(file, `inventory-backup-${today()}.db`, () => fs.rm(file, { force: true }, () => {}));
});

/* ---------- static frontend ---------- */
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
app.use(express.static(publicDir, { etag: true, maxAge: 0 }));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

/* ---------- errors ---------- */
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err?.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = parseInt(process.env.PORT, 10) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Inventory tracker listening on :${port} (data in ${DATA_DIR})`));
