/* Public hire site: the data behind the customer-facing catalogue on port 90.
   Everything here is derived from the inventory, so there is no second catalogue to keep up to date:
   sub-categories are the category/type pairs that have stock, and an "item type" is a group of
   identical items (the same grouping the Stock overview uses). The only things stored are the
   pictures and about-text an admin adds, and the hire requests customers send in. */
import crypto from 'node:crypto';
import { all, get, run, tx, db, nowIso, today, logEvent, HttpError } from './db.js';
import { cap, formatOutputs } from './catalog.js';

db.exec(`
-- Picture, about text and optional display name for a sub-category ('subcategory') or an item type ('type').
CREATE TABLE IF NOT EXISTS hire_meta (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT,
  about TEXT,
  image BLOB,
  image_mime TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS hire_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  client TEXT NOT NULL,
  event TEXT NOT NULL,
  renter_name TEXT NOT NULL,
  renter_email TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  rental_id INTEGER REFERENCES rentals(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hire_req_status ON hire_requests(status);

CREATE TABLE IF NOT EXISTS hire_request_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES hire_requests(id) ON DELETE CASCADE,
  type_key TEXT NOT NULL,
  label TEXT NOT NULL,
  details TEXT,
  qty INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hire_lines_req ON hire_request_lines(request_id);
`);

export const IMAGE_MIMES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const SCOPES = new Set(['subcategory', 'type']);

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));

/* ---------- keys ---------- */

// A sub-category is a category/type pair: "power-cable", "lighting-light".
export const subSlug = (category, type) =>
  `${String(category).toLowerCase()}-${String(type).toLowerCase()}`.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Short, stable id for a group of identical items. Built from the same fields the Stock overview groups
// on, so it survives restarts and rebuilds, but it changes if that kit's details are edited.
const typeKey = (r) =>
  crypto.createHash('sha1')
    .update([r.category, r.type, norm(r.name), norm(r.male_connector), norm(r.female_connector), norm(r.input_connector), r.outputs ?? '', r.length_m ?? ''].join('\u0001'))
    .digest('hex').slice(0, 16);

/* ---------- availability ---------- */

// Items that cannot go out at all, plus (when dates are given) items already promised to an active
// rental whose window overlaps the one asked for. With no dates, "available" just means in stock now.
//
// A rental with no end date, or one that is physically still out past its end date, counts as
// overlapping everything: nobody can say when that kit is coming back, so it is not offered.
function stockRows(startDate, endDate) {
  if (isDate(startDate) && isDate(endDate)) {
    const t = today(); // generated here, never user input, so it is safe to inline
    return all(
      `SELECT i.category, i.type, i.name, i.male_connector, i.female_connector, i.input_connector, i.outputs, i.length_m,
         (i.status IN ('lost','disassembled','repair')
          OR EXISTS (SELECT 1 FROM rental_items ri JOIN rentals r ON r.id = ri.rental_id
                     WHERE ri.item_id = i.id AND ri.outcome IS NULL AND r.status = 'active'
                       AND (r.start_date IS NULL OR r.start_date <= ?)
                       AND (r.end_date IS NULL OR r.end_date >= ?
                            OR (r.end_date < '${t}' AND i.status = 'on_rental')))) AS busy
       FROM items i WHERE i.status != 'sold' ORDER BY i.id`,
      endDate, startDate
    );
  }
  return all(
    `SELECT category, type, name, male_connector, female_connector, input_connector, outputs, length_m,
       (status != 'in_stock') AS busy
     FROM items WHERE status != 'sold' ORDER BY id`
  );
}

/* ---------- the catalogue ---------- */

// One line describing the kit, for the grids, the request and the admin list
export function detailLine(g) {
  const parts = [];
  if (g.input_connector || g.outputs) {
    const outs = formatOutputs(g.outputs);
    parts.push(`${g.input_connector || '?'} in${outs ? ` to ${outs} out` : ''}`);
  } else if (g.male_connector || g.female_connector) {
    parts.push(`${g.male_connector || '?'} to ${g.female_connector || '?'}`);
  }
  if (g.length_m != null) parts.push(`${g.length_m} m`);
  return parts.join(' / ') || null;
}

// Every item type with stock, grouped like the Stock overview and labelled with its commonest spelling.
function groupTypes(startDate, endDate) {
  const groups = new Map();
  for (const r of stockRows(startDate, endDate)) {
    const key = typeKey(r);
    let g = groups.get(key);
    if (!g) {
      g = {
        key, category: r.category, type: r.type, subcategory: subSlug(r.category, r.type),
        outputs: r.outputs, length_m: r.length_m, total: 0, available: 0, spellings: {},
      };
      groups.set(key, g);
    }
    g.total++;
    if (!r.busy) g.available++;
    for (const f of ['name', 'male_connector', 'female_connector', 'input_connector']) {
      const v = String(r[f] ?? '').trim();
      if (v) { g.spellings[f] ??= new Map(); g.spellings[f].set(v, (g.spellings[f].get(v) || 0) + 1); }
    }
  }
  const commonest = (m) => (m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : null);
  const metaByKey = new Map(all(`SELECT key, label, about, image IS NOT NULL AS has_image FROM hire_meta WHERE scope = 'type'`).map((m) => [m.key, m]));
  const list = [...groups.values()].map(({ spellings, ...g }) => {
    const out = {
      ...g,
      name: commonest(spellings.name),
      male_connector: commonest(spellings.male_connector),
      female_connector: commonest(spellings.female_connector),
      input_connector: commonest(spellings.input_connector),
    };
    const meta = metaByKey.get(g.key);
    out.label = (meta?.label || out.name || `${cap(g.category)} ${g.type}`).trim();
    out.about = meta?.about || null;
    out.image = !!meta?.has_image;
    out.details = detailLine(out);
    return out;
  });
  const cmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true, sensitivity: 'base' });
  list.sort((a, b) => cmp(a.label, b.label) || (a.length_m ?? 0) - (b.length_m ?? 0));
  return list;
}

// The sub-category tiles on the hire home page.
export function catalogue({ start, end } = {}) {
  const types = groupTypes(start, end);
  const metaBySlug = new Map(all(`SELECT key, label, about, image IS NOT NULL AS has_image FROM hire_meta WHERE scope = 'subcategory'`).map((m) => [m.key, m]));
  const subs = new Map();
  for (const t of types) {
    let s = subs.get(t.subcategory);
    if (!s) {
      const meta = metaBySlug.get(t.subcategory);
      s = {
        slug: t.subcategory, category: t.category, type: t.type,
        label: (meta?.label || `${cap(t.category)} ${t.type}`).trim(),
        about: meta?.about || null, image: !!meta?.has_image,
        kinds: 0, total: 0, available: 0,
      };
      subs.set(t.subcategory, s);
    }
    s.kinds++;
    s.total += t.total;
    s.available += t.available;
  }
  const order = ['POWER', 'LIGHTING', 'SOUND'];
  const rank = (c) => { const i = order.indexOf(c); return i < 0 ? order.length : i; };
  const list = [...subs.values()].sort((a, b) => rank(a.category) - rank(b.category) || a.label.localeCompare(b.label));
  return { subcategories: list, types, dated: isDate(start) && isDate(end), today: today() };
}

export function subcategoryPage(slug, { start, end } = {}) {
  const c = catalogue({ start, end });
  const sub = c.subcategories.find((s) => s.slug === slug);
  if (!sub) throw new HttpError(404, 'Not found');
  return { subcategory: sub, types: c.types.filter((t) => t.subcategory === slug), dated: c.dated };
}

export function typePage(key, { start, end } = {}) {
  const c = catalogue({ start, end });
  const item = c.types.find((g) => g.key === key);
  if (!item) throw new HttpError(404, 'Not found');
  return { item, subcategory: c.subcategories.find((s) => s.slug === item.subcategory) || null, dated: c.dated };
}

// Everything the admin "Hire site" page needs: each tile and item type with whatever has been filled in for it.
export function adminCatalogue() {
  const c = catalogue();
  const meta = all('SELECT scope, key, label, about, image IS NOT NULL AS has_image, updated_at FROM hire_meta');
  const bySub = new Map(meta.filter((m) => m.scope === 'subcategory').map((m) => [m.key, m]));
  const byType = new Map(meta.filter((m) => m.scope === 'type').map((m) => [m.key, m]));
  return {
    subcategories: c.subcategories.map((s) => ({ ...s, custom_label: bySub.get(s.slug)?.label || null, updated_at: bySub.get(s.slug)?.updated_at || null })),
    types: c.types.map((t) => ({ ...t, custom_label: byType.get(t.key)?.label || null, updated_at: byType.get(t.key)?.updated_at || null })),
  };
}

/* ---------- pictures and about text (written from the admin app) ---------- */

export const getImage = (scope, key) =>
  get('SELECT image, image_mime, updated_at FROM hire_meta WHERE scope = ? AND key = ? AND image IS NOT NULL', scope, key);

export function saveMeta(scope, key, { label, about, image, imageMime, clearImage } = {}) {
  if (!SCOPES.has(scope)) throw new HttpError(400, 'Unknown scope');
  if (!/^[a-z0-9-]{1,80}$/.test(String(key))) throw new HttpError(400, 'Invalid key');
  const existing = get('SELECT * FROM hire_meta WHERE scope = ? AND key = ?', scope, key);
  const clean = (v, max) => {
    const s = String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
    return s || null;
  };
  const row = {
    label: label === undefined ? existing?.label ?? null : clean(label, 120),
    about: about === undefined ? existing?.about ?? null : clean(about, 4000),
    image: existing?.image ?? null,
    image_mime: existing?.image_mime ?? null,
  };
  if (clearImage) {
    row.image = null;
    row.image_mime = null;
  } else if (image) {
    if (!IMAGE_MIMES[imageMime]) throw new HttpError(400, 'Pictures must be PNG, JPEG or WebP');
    if (image.length > 2_000_000) throw new HttpError(413, 'Picture is too big (2 MB max)');
    row.image = image;
    row.image_mime = imageMime;
  }
  run(
    `INSERT INTO hire_meta (scope, key, label, about, image, image_mime, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (scope, key) DO UPDATE SET label=excluded.label, about=excluded.about, image=excluded.image,
       image_mime=excluded.image_mime, updated_at=excluded.updated_at`,
    scope, key, row.label, row.about, row.image, row.image_mime, nowIso()
  );
  return { ok: true, scope, key, label: row.label, about: row.about, image: !!row.image };
}

/* ---------- hire requests ---------- */

const REFERENCE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679'; // no look-alike characters
const makeReference = () =>
  'FC-' + Array.from(crypto.randomFillSync(new Uint8Array(6)), (b) => REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length]).join('');

const text = (v, max, what) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new HttpError(400, `${what} is required`);
  return s.slice(0, max);
};

// Deliberately lenient: this only has to stop obvious nonsense, the reply itself proves the address works.
const EMAIL = /^[^\s@,;:<>"']{1,64}@[^\s@,;:<>"']{1,128}\.[a-z]{2,24}$/i;

export function createRequest(body = {}) {
  const client = text(body.client, 120, 'Client');
  const event = text(body.event, 120, 'Event');
  const renterName = text(body.renter_name, 120, 'Your name');
  const renterEmail = text(body.renter_email, 160, 'Email address');
  if (!EMAIL.test(renterEmail)) throw new HttpError(400, 'That email address does not look right');
  const start = String(body.start_date ?? '').trim();
  const end = String(body.end_date ?? '').trim();
  if (!isDate(start) || !isDate(end)) throw new HttpError(400, 'Pick a start and an end date');
  if (end < start) throw new HttpError(400, 'The end date is before the start date');
  const notes = String(body.notes ?? '').replace(/\r\n/g, '\n').trim().slice(0, 2000) || null;

  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw new HttpError(400, 'Your flight case is empty');
  if (lines.length > 100) throw new HttpError(400, 'Too many different items in one request');

  const current = new Map(groupTypes(start, end).map((t) => [t.key, t]));
  const short = [];
  const clean = [];
  for (const l of lines) {
    const t = current.get(String(l?.key ?? ''));
    if (!t) throw new HttpError(409, 'Something in your flight case is no longer listed. Please remove it and try again');
    const qty = Math.floor(Number(l?.qty));
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new HttpError(400, `Invalid quantity for ${t.label}`);
    if (qty > t.available) short.push({ key: t.key, label: t.label, wanted: qty, available: t.available });
    clean.push({ key: t.key, label: t.label, details: t.details, qty });
  }
  if (short.length) {
    const err = new HttpError(409, 'Some of it is no longer available for those dates');
    err.short = short;
    throw err;
  }

  return tx(() => {
    let reference = makeReference();
    for (let i = 0; i < 5 && get('SELECT 1 FROM hire_requests WHERE reference = ?', reference); i++) reference = makeReference();
    const res = run(
      `INSERT INTO hire_requests (reference, client, event, renter_name, renter_email, start_date, end_date, notes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
      reference, client, event, renterName, renterEmail, start, end, notes, nowIso()
    );
    const requestId = Number(res.lastInsertRowid);
    for (const l of clean) {
      run('INSERT INTO hire_request_lines (request_id, type_key, label, details, qty) VALUES (?, ?, ?, ?, ?)', requestId, l.key, l.label, l.details, l.qty);
    }
    logEvent({ action: 'hire_request', detail: `Hire request ${reference} from ${renterName} (${client}, ${event}): ${clean.reduce((s, l) => s + l.qty, 0)} items` });
    return { reference, id: requestId };
  });
}

export function listRequests({ status } = {}) {
  const filtered = ['new', 'accepted', 'declined'].includes(status);
  return all(
    `SELECT q.*, (SELECT SUM(qty) FROM hire_request_lines l WHERE l.request_id = q.id) AS item_count,
       (SELECT COUNT(*) FROM hire_request_lines l WHERE l.request_id = q.id) AS line_count,
       r.name AS rental_name
     FROM hire_requests q LEFT JOIN rentals r ON r.id = q.rental_id
     ${filtered ? 'WHERE q.status = ?' : ''}
     ORDER BY (q.status = 'new') DESC, q.id DESC LIMIT 300`,
    ...(filtered ? [status] : [])
  ).map((q) => ({ ...q, item_count: q.item_count || 0 }));
}

export function requestDetail(id) {
  const request = get('SELECT q.*, r.name AS rental_name FROM hire_requests q LEFT JOIN rentals r ON r.id = q.rental_id WHERE q.id = ?', id);
  if (!request) throw new HttpError(404, 'Request not found');
  // Availability may have moved on since the request came in, so re-check it for whoever is reading
  const now = new Map(groupTypes(request.start_date, request.end_date).map((t) => [t.key, t]));
  const lines = all('SELECT * FROM hire_request_lines WHERE request_id = ? ORDER BY id', id)
    .map((l) => ({ ...l, available: now.get(l.type_key)?.available ?? null }));
  return { request, lines };
}

export function setRequestStatus(id, status) {
  if (!['new', 'accepted', 'declined'].includes(status)) throw new HttpError(400, 'Unknown status');
  const { request } = requestDetail(id);
  run('UPDATE hire_requests SET status = ? WHERE id = ?', status, request.id);
  return requestDetail(request.id);
}

// Turns an accepted request into a rental, pre-filled with the client, event, dates and what was asked for.
// The items themselves still have to be picked or scanned onto it, because a request names kinds, not barcodes.
export function createRentalFromRequest(id, createRental) {
  const { request, lines } = requestDetail(id);
  if (request.rental_id) throw new HttpError(409, 'A rental has already been made from this request');
  return tx(() => {
    const rental = createRental({
      name: `${request.event} (${request.reference})`,
      customer: request.client,
      start_date: request.start_date,
      end_date: request.end_date,
      notes: [
        `From hire request ${request.reference}`,
        `Requested by ${request.renter_name} <${request.renter_email}>`,
        '',
        'Asked for:',
        ...lines.map((l) => `${l.qty} x ${l.label}${l.details ? ` (${l.details})` : ''}`),
        ...(request.notes ? ['', `Their notes: ${request.notes}`] : []),
      ].join('\n'),
    });
    run(`UPDATE hire_requests SET rental_id = ?, status = 'accepted' WHERE id = ?`, rental.id, request.id);
    return { rental, request: requestDetail(request.id).request };
  });
}

export function deleteRequest(id) {
  const { request } = requestDetail(id);
  run('DELETE FROM hire_requests WHERE id = ?', request.id);
  return { ok: true };
}
