/* The customer-facing hire site, on its own port (90 by default) so it can be exposed to the internet
   while the admin app on port 80 stays private. It is a separate Express app in the same process: it
   shares the database, but none of the admin routes and none of the admin login exist on it.

   What it will serve: sub-categories, kinds of item and how many are free. What it will never serve:
   barcodes, item ids, costs, owners, PAT records, rentals, containers or the activity log. The only
   thing it writes is a hire request — which becomes a real, active rental immediately. */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError, today } from './db.js';
import * as hire from './hire.js';
import { writeRentalPdf, safeFilename } from './pdf.js';

const hireDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hire');

// Shown until an admin uploads a logo of their own (Hire site → Pictures & wording → Logo), so the
// site never has to launch with just a text wordmark. The hire site is light, so this wants the
// black-on-transparent logo rather than the white one the (dark) PDF header uses. Override with
// HIRE_LOGO_PATH, or set it to an empty string to start with no logo at all.
const DEFAULT_LOGO_PATH = process.env.HIRE_LOGO_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'FaderUp-Logo-black.png');
let defaultLogo = null;
if (DEFAULT_LOGO_PATH) {
  try { defaultLogo = { data: fs.readFileSync(DEFAULT_LOGO_PATH), mime: DEFAULT_LOGO_PATH.endsWith('.png') ? 'image/png' : 'image/jpeg' }; }
  catch { /* no bundled logo file: falls back to the text wordmark until one is uploaded */ }
}

// Dates from the query string: only ever a plain YYYY-MM-DD, anything else is ignored.
const dateRange = (req) => {
  const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : undefined);
  const start = d(req.query.start);
  const end = d(req.query.end);
  return start && end && end >= start ? { start, end } : {};
};

/* A plain in-memory limiter for the routes that write or that could be probed. It is per-process and
   resets on restart, which is all that is needed here: it exists to stop a stuck script or a bored
   visitor, not to survive a determined attack. Put the site behind a proper proxy for that. */
function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v[0] > windowMs) hits.delete(k);
    const key = req.ip || 'unknown';
    const entry = hits.get(key);
    if (!entry || now - entry[0] > windowMs) hits.set(key, [now, 1]);
    else if (++entry[1] > max) {
      res.set('Retry-After', String(Math.ceil((windowMs - (now - entry[0])) / 1000)));
      return res.status(429).json({ error: 'Too many requests from here. Please try again later.' });
    }
    next();
  };
}

export function createHireApp() {
  const app = express();
  const COMPANY = process.env.COMPANY_NAME || 'FaderUp';
  const CONTACT_EMAIL = process.env.HIRE_CONTACT_EMAIL || '';
  const CONTACT_PHONE = process.env.HIRE_CONTACT_PHONE || '';

  app.disable('x-powered-by');
  app.set('etag', 'strong');
  // Behind a reverse proxy, set HIRE_TRUST_PROXY=1 so the rate limiter sees the real client address.
  if (process.env.HIRE_TRUST_PROXY) app.set('trust proxy', process.env.HIRE_TRUST_PROXY === '1' ? 1 : process.env.HIRE_TRUST_PROXY);

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
        "font-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    });
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.use('/api', express.json({ limit: '64kb' }));

  /* ---------- browsing (read-only, no details needed) ---------- */
  app.get('/api/meta', (_req, res) =>
    res.json({ company: COMPANY, contactEmail: CONTACT_EMAIL, contactPhone: CONTACT_PHONE, today: today() }));

  app.get('/api/catalogue', (req, res) => res.json(hire.catalogue(dateRange(req))));
  app.get('/api/subcategories/:slug', (req, res) => res.json(hire.subcategoryPage(String(req.params.slug), dateRange(req))));
  app.get('/api/items/:key', (req, res) => res.json(hire.typePage(String(req.params.key), dateRange(req))));

  // Square (or, for the site logo, scale-to-fit) pictures, straight out of the database. Keys are
  // validated so nothing here can touch the filesystem.
  app.get('/img/:scope/:key', (req, res) => {
    const { scope, key } = req.params;
    if (!hire.SCOPES.has(scope) || !/^[a-z0-9-]{1,80}$/.test(key)) throw new HttpError(404, 'Not found');
    const row = hire.getImage(scope, key);
    if (!row) {
      if (scope === 'site' && key === 'logo' && defaultLogo) {
        res.set({ 'Content-Type': defaultLogo.mime, 'Cache-Control': 'public, max-age=300' });
        return res.send(defaultLogo.data);
      }
      throw new HttpError(404, 'No picture');
    }
    res.set({ 'Content-Type': row.image_mime, 'Cache-Control': 'public, max-age=60', ETag: `"${scope}-${key}-${row.updated_at}"` });
    if (req.headers['if-none-match'] === res.get('ETag')) return res.status(304).end();
    res.send(Buffer.from(row.image));
  });

  /* ---------- sending a flight case in: this creates a real, active rental straight away ---------- */
  app.post('/api/requests', rateLimiter({ max: 12, windowMs: 60 * 60 * 1000 }), (req, res) => {
    const { reference, jobNumber } = hire.createRequest(req.body || {});
    res.status(201).json({ reference, jobNumber });
  });

  // The booking's hire sheet, keyed by the request's own unguessable reference (never by job number —
  // that's sequential, and walking it must not let someone pull a different customer's PDF).
  app.get('/api/requests/:reference/pdf', rateLimiter({ max: 30, windowMs: 60 * 60 * 1000 }), (req, res) => {
    const { rental, items } = hire.requestPdfData(req.params.reference);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="hire-sheet-${safeFilename(rental.job_number)}.pdf"`,
    });
    writeRentalPdf(res, { rental, items, company: COMPANY, mode: 'client' });
  });

  /* ---------- static site ---------- */
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use(express.static(hireDir, { etag: true, maxAge: 0, index: 'index.html' }));
  app.get('*', (_req, res) => res.sendFile(path.join(hireDir, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, short: err.short });
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') return res.status(400).json({ error: 'Bad request' });
    console.error('[hire]', err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
