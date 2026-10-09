/* Public hire site: the data behind the customer-facing catalogue on port 90.
   Everything here is derived from the inventory, so there is no second catalogue to keep up to date:
   sub-categories are the category/type pairs that have stock, and an "item type" is a group of
   identical items (the same grouping the Stock overview uses). The only things stored are the
   pictures and about-text an admin adds, and the hire requests customers send in. */
import crypto from 'node:crypto';
import { all, get, run, tx, db, nowIso, today, logEvent, HttpError, ensureColumn } from './db.js';
import { cap, formatOutputs, kindKey } from './catalog.js';
import { createRental as createRentalRow } from './rentals.js';
import { categoryOrder } from './categories.js';

db.exec(`
-- Picture, about text, display order and (for an item type) a section label like "16A" or "32A", for a
-- sub-category ('subcategory'), an item type ('type'), or the site itself ('site', key 'logo').
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

-- Combined items: several kinds listed on the site as one (e.g. 0.5 m and 1 m IEC leads as "Short IEC leads").
-- A customer books a quantity of the combined item and any mix of its kinds can be packed for it. Its
-- picture, wording, order and section live in hire_meta like any other item, under the key "g-<id>".
CREATE TABLE IF NOT EXISTS hire_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hire_group_members (
  kind_key TEXT PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES hire_groups(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hire_group_members ON hire_group_members(group_id);
`);
ensureColumn('hire_meta', 'section', 'TEXT'); // only meaningful for scope='type': groups it under a heading within its sub-category
ensureColumn('hire_meta', 'hide_secondary', 'INTEGER NOT NULL DEFAULT 0'); // scope='type': 1 = list it under its main sub-category only, not its second one
ensureColumn('hire_meta', 'sort_order', 'INTEGER'); // manual display order; NULL sorts after everything that has been arranged

export const IMAGE_MIMES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const SCOPES = new Set(['subcategory', 'type', 'site']);

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));
const cmpStr = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true, sensitivity: 'base' });

// A manual sort_order (set from the admin's Reorder control) wins; anything not yet arranged (NULL)
// sorts after everything that has been, falling back to `fallback` so new stock lands somewhere sensible.
const bySortOrder = (fallback) => (a, b) => {
  if (a.sort_order == null && b.sort_order == null) return fallback(a, b);
  if (a.sort_order == null) return 1;
  if (b.sort_order == null) return -1;
  return a.sort_order - b.sort_order || fallback(a, b);
};

/* ---------- keys ---------- */

// A combined item's key: "g-12". Ordinary kinds are 16 hex characters (catalog.js kindKey).
export const groupKey = (id) => `g-${id}`;
const groupIdOf = (key) => (/^g-\d{1,9}$/.test(String(key)) ? Number(String(key).slice(2)) : null);
const ITEM_KEY = /^(?:[a-f0-9]{16}|g-\d{1,9})$/;

// A sub-category is a category/type pair: "power-cable", "lighting-light".
export const subSlug = (category, type) =>
  `${String(category).toLowerCase()}-${String(type).toLowerCase()}`.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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
      `SELECT i.category, i.type, i.category2, i.type2, i.name, i.male_connector, i.female_connector, i.input_connector, i.outputs, i.length_m,
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
    `SELECT category, type, category2, type2, name, male_connector, female_connector, input_connector, outputs, length_m,
       (status != 'in_stock') AS busy
     FROM items WHERE status != 'sold' ORDER BY id`
  );
}

// Outstanding (not-yet-packed) quantity on OTHER active rentals whose dates overlap the window being
// checked, per kind. A hire request becomes a real active rental the moment it is submitted, but it
// names kinds and quantities, not barcodes — until someone actually packs it, nothing else would stop
// a second booking being offered the same stock unless this is subtracted too. Only matters when dates
// are given: an unpacked future booking shouldn't affect "what's in stock right now" browsing.
function reservedByKind(startDate, endDate) {
  const reserved = new Map();
  const reqRows = all(
    `SELECT rq.rental_id, rq.kind_key, rq.member_keys, rq.qty
     FROM rental_requirements rq JOIN rentals r ON r.id = rq.rental_id
     WHERE r.status = 'active' AND (r.start_date IS NULL OR r.start_date <= ?) AND (r.end_date IS NULL OR r.end_date >= ?)`,
    endDate, startDate
  );
  if (!reqRows.length) return reserved;
  const packedRows = all(
    `SELECT ri.rental_id, i.category, i.type, i.name, i.male_connector, i.female_connector, i.input_connector, i.outputs, i.length_m
     FROM rental_items ri JOIN items i ON i.id = ri.item_id JOIN rentals r ON r.id = ri.rental_id
     WHERE ri.outcome IS NULL AND r.status = 'active' AND (r.start_date IS NULL OR r.start_date <= ?) AND (r.end_date IS NULL OR r.end_date >= ?)`,
    endDate, startDate
  );
  const packedByRental = new Map(); // rental_id -> Map<kind_key, count>
  for (const row of packedRows) {
    let m = packedByRental.get(row.rental_id);
    if (!m) packedByRental.set(row.rental_id, (m = new Map()));
    const k = kindKey(row);
    m.set(k, (m.get(k) || 0) + 1);
  }
  for (const rq of reqRows) {
    // a combined item's requirement is filled by any of its kinds, and is reserved against the combined item
    const packed = requirementKeys(rq).reduce((n, k) => n + (packedByRental.get(rq.rental_id)?.get(k) || 0), 0);
    const outstanding = Math.max(0, rq.qty - packed);
    if (outstanding) reserved.set(rq.kind_key, (reserved.get(rq.kind_key) || 0) + outstanding);
  }
  return reserved;
}

// The kinds that fill a requirement: its own kind, or every kind of the combined item it was booked as
export function requirementKeys(rq) {
  if (rq.member_keys) {
    try { const keys = JSON.parse(rq.member_keys); if (Array.isArray(keys) && keys.length) return keys.map(String); } catch { /* fall through */ }
  }
  return [rq.kind_key];
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
  const dated = isDate(startDate) && isDate(endDate);
  const groups = new Map();
  for (const r of stockRows(startDate, endDate)) {
    const key = kindKey(r);
    let g = groups.get(key);
    if (!g) {
      g = {
        key, category: r.category, type: r.type, subcategory: subSlug(r.category, r.type),
        outputs: r.outputs, length_m: r.length_m, total: 0, available: 0, spellings: {}, also: new Map(),
      };
      groups.set(key, g);
    }
    // A second category/type on any of its items lists the whole kind there too. It stays one kind with one
    // key, so the picture, wording and bookings are the same ones wherever it is shown.
    if (r.category2 && r.type2) {
      const slug = subSlug(r.category2, r.type2);
      if (slug !== g.subcategory) g.also.set(slug, { slug, category: r.category2, type: r.type2 });
    }
    g.total++;
    if (!r.busy) g.available++;
    for (const f of ['name', 'male_connector', 'female_connector', 'input_connector']) {
      const v = String(r[f] ?? '').trim();
      if (v) { g.spellings[f] ??= new Map(); g.spellings[f].set(v, (g.spellings[f].get(v) || 0) + 1); }
    }
  }
  const reservedKinds = dated ? reservedByKind(startDate, endDate) : null;
  if (reservedKinds) for (const g of groups.values()) g.available = Math.max(0, g.available - (reservedKinds.get(g.key) || 0));
  const commonest = (m) => (m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : null);
  const metaByKey = new Map(all(`SELECT key, label, about, section, sort_order, hide_secondary, image IS NOT NULL AS has_image FROM hire_meta WHERE scope = 'type'`).map((m) => [m.key, m]));
  const list = [...groups.values()].map(({ spellings, also, ...g }) => {
    const out = {
      ...g,
      also: [...also.values()],
      name: commonest(spellings.name),
      male_connector: commonest(spellings.male_connector),
      female_connector: commonest(spellings.female_connector),
      input_connector: commonest(spellings.input_connector),
    };
    const meta = metaByKey.get(g.key);
    out.label = (meta?.label || out.name || `${cap(g.category)} ${g.type}`).trim();
    out.about = meta?.about || null;
    out.section = meta?.section || null;
    out.sort_order = meta?.sort_order ?? null;
    out.hide_secondary = !!meta?.hide_secondary;
    out.image = !!meta?.has_image;
    out.details = detailLine(out);
    return out;
  });
  list.push(...combinedItems(list, metaByKey, reservedKinds || new Map()));
  list.sort(bySortOrder((a, b) => cmpStr(a.label, b.label) || (a.length_m ?? 0) - (b.length_m ?? 0)));
  return list;
}

// Builds a combined item from its kinds (each kind is tagged with `group`, so the listing can leave it out).
// Its total and free count are the sum of its kinds', less any bookings made against the combined item
// that have not been packed yet. Connectors / length show only when every kind has the same one.
function combinedItems(kinds, metaByKey, reserved) {
  const byKey = new Map(kinds.map((k) => [k.key, k]));
  const groups = new Map();
  for (const m of all(`SELECT m.kind_key, g.id, g.name FROM hire_group_members m JOIN hire_groups g ON g.id = m.group_id ORDER BY m.added_at, m.rowid`)) {
    const kind = byKey.get(m.kind_key);
    if (!kind) continue; // nothing of that kind in stock any more
    let g = groups.get(m.id);
    if (!g) groups.set(m.id, (g = { id: m.id, name: m.name, kinds: [] }));
    g.kinds.push(kind);
  }
  const out = [];
  for (const g of groups.values()) {
    const key = groupKey(g.id);
    const ks = [...g.kinds].sort((a, b) => cmpStr(a.label, b.label) || (a.length_m ?? 0) - (b.length_m ?? 0));
    for (const k of ks) k.group = key;
    const same = (f) => (ks.every((k) => String(k[f] ?? '') === String(ks[0][f] ?? '')) ? ks[0][f] ?? null : null);
    // listed under the sub-category most of its kinds are in, and also under every other one they are in
    const counts = new Map();
    for (const k of ks) counts.set(k.subcategory, (counts.get(k.subcategory) || 0) + 1);
    const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const home = ks.find((k) => k.subcategory === main);
    const also = new Map();
    for (const k of ks) {
      if (k.subcategory !== main) also.set(k.subcategory, { slug: k.subcategory, category: k.category, type: k.type });
      for (const a of k.also) if (a.slug !== main) also.set(a.slug, a);
    }
    const common = {
      male_connector: same('male_connector'), female_connector: same('female_connector'),
      input_connector: same('input_connector'), outputs: same('outputs'), length_m: same('length_m'),
    };
    const lengths = [...new Set(ks.map((k) => k.length_m).filter((v) => v != null))].sort((a, b) => a - b);
    const ends = detailLine({ ...common, length_m: null });
    const details = [ends, lengths.length ? lengths.map((l) => `${l} m`).join(', ') : null].filter(Boolean).join(' / ') || null;
    const meta = metaByKey.get(key);
    const available = ks.reduce((n, k) => n + k.available, 0) - (reserved.get(key) || 0);
    out.push({
      key, combined: true, category: home.category, type: home.type, subcategory: main,
      ...common, name: g.name, also: [...also.values()],
      total: ks.reduce((n, k) => n + k.total, 0), available: Math.max(0, available),
      label: (meta?.label || g.name).trim(), about: meta?.about || null, section: meta?.section || null,
      sort_order: meta?.sort_order ?? null, hide_secondary: !!meta?.hide_secondary, image: !!meta?.has_image,
      details,
      members: ks.map((k) => ({ key: k.key, label: k.label, details: k.details, length_m: k.length_m, total: k.total, available: k.available })),
    });
  }
  return out;
}

// The sub-category tiles on the hire home page.
// `admin` keeps every kind's second sub-category and its on/off switch; the public site only ever gets
// the ones that are switched on.
export function catalogue({ start, end, admin = false, withGrouped = admin } = {}) {
  const everything = groupTypes(start, end);
  // kinds that are part of a combined item are listed only through it; the admin also gets them (tagged `group`)
  const types = everything.filter((t) => !t.group);
  const metaBySlug = new Map(all(`SELECT key, label, about, sort_order, image IS NOT NULL AS has_image FROM hire_meta WHERE scope = 'subcategory'`).map((m) => [m.key, m]));
  const subs = new Map();
  for (const t of types) {
    const shownIn = t.hide_secondary ? [] : t.also;
    if (!admin) { t.also = shownIn; delete t.hide_secondary; }
    for (const place of [{ slug: t.subcategory, category: t.category, type: t.type }, ...shownIn]) {
      let s = subs.get(place.slug);
      if (!s) {
        const meta = metaBySlug.get(place.slug);
        s = {
          slug: place.slug, category: place.category, type: place.type,
          label: (meta?.label || `${cap(place.category)} ${place.type}`).trim(),
          about: meta?.about || null, image: !!meta?.has_image, sort_order: meta?.sort_order ?? null,
          kinds: 0, total: 0, available: 0,
        };
        subs.set(place.slug, s);
      }
      s.kinds++;
      s.total += t.total;
      s.available += t.available;
    }
  }
  const order = categoryOrder();
  const rank = (c) => { const i = order.indexOf(c); return i < 0 ? order.length : i; };
  const list = [...subs.values()].sort(bySortOrder((a, b) => rank(a.category) - rank(b.category) || cmpStr(a.label, b.label)));
  return { subcategories: list, types: withGrouped ? everything : types, dated: isDate(start) && isDate(end), today: today() };
}

export function subcategoryPage(slug, { start, end } = {}) {
  const c = catalogue({ start, end });
  const sub = c.subcategories.find((s) => s.slug === slug);
  if (!sub) throw new HttpError(404, 'Not found');
  return { subcategory: sub, types: c.types.filter((t) => !t.group && (t.subcategory === slug || t.also.some((a) => a.slug === slug))), dated: c.dated };
}

export function typePage(key, { start, end } = {}) {
  const c = catalogue({ start, end, withGrouped: true });
  let item = c.types.find((g) => g.key === key);
  if (item?.group) item = c.types.find((g) => g.key === item.group); // an old link to a kind that is now combined
  if (!item) throw new HttpError(404, 'Not found');
  return { item, subcategory: c.subcategories.find((s) => s.slug === item.subcategory) || null, dated: c.dated };
}

// Everything the admin "Hire site" page needs: each tile and item type with whatever has been filled in for it.
export function adminCatalogue() {
  const c = catalogue({ admin: true });
  const meta = all('SELECT scope, key, label, about, section, sort_order, image IS NOT NULL AS has_image, updated_at FROM hire_meta');
  const bySub = new Map(meta.filter((m) => m.scope === 'subcategory').map((m) => [m.key, m]));
  const byType = new Map(meta.filter((m) => m.scope === 'type').map((m) => [m.key, m]));
  return {
    subcategories: c.subcategories.map((s) => ({ ...s, custom_label: bySub.get(s.slug)?.label || null, updated_at: bySub.get(s.slug)?.updated_at || null })),
    types: c.types.map((t) => ({ ...t, custom_label: byType.get(t.key)?.label || null, updated_at: byType.get(t.key)?.updated_at || null })),
  };
}

// Batch reorder / re-section: [{ scope, key, sortOrder, section? }, …], all under one transaction.
// `section` is only applied when the entry is for scope='type' and the field is present.
export function reorder(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new HttpError(400, 'Nothing to reorder');
  if (entries.length > 2000) throw new HttpError(400, 'Too many rows at once');
  const now = nowIso();
  tx(() => {
    for (const e of entries) {
      const scope = e?.scope;
      const key = e?.key;
      if (!SCOPES.has(scope) || !/^[a-z0-9-]{1,80}$/.test(String(key))) throw new HttpError(400, 'Invalid row');
      const sortOrder = Number.isInteger(e?.sortOrder) ? e.sortOrder : null;
      const section = scope === 'type' && e?.section !== undefined ? (String(e.section).trim().slice(0, 60) || null) : undefined;
      const existing = get('SELECT * FROM hire_meta WHERE scope = ? AND key = ?', scope, key);
      run(
        `INSERT INTO hire_meta (scope, key, label, about, section, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, key) DO UPDATE SET sort_order=excluded.sort_order,
           section=CASE WHEN ? THEN excluded.section ELSE hire_meta.section END, updated_at=excluded.updated_at`,
        scope, key, existing?.label ?? null, existing?.about ?? null, section ?? existing?.section ?? null, sortOrder, now,
        section !== undefined ? 1 : 0
      );
    }
  });
  return adminCatalogue();
}

/* ---------- pictures and about text (written from the admin app) ---------- */

export const getImage = (scope, key) =>
  get('SELECT image, image_mime, updated_at FROM hire_meta WHERE scope = ? AND key = ? AND image IS NOT NULL', scope, key);

export function saveMeta(scope, key, { label, about, image, imageMime, clearImage, hideSecondary } = {}) {
  if (!SCOPES.has(scope)) throw new HttpError(400, 'Unknown scope');
  if (!/^[a-z0-9-]{1,80}$/.test(String(key))) throw new HttpError(400, 'Invalid key');
  // A combined item's name is the combined item's own name, not an override on top of one
  const gid = scope === 'type' ? groupIdOf(key) : null;
  if (gid && label !== undefined) {
    const name = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (name) run('UPDATE hire_groups SET name = ? WHERE id = ?', name, gid);
    label = null;
  }
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
    hide_secondary: hideSecondary === undefined ? existing?.hide_secondary ?? 0 : hideSecondary ? 1 : 0,
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
    `INSERT INTO hire_meta (scope, key, label, about, image, image_mime, hide_secondary, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (scope, key) DO UPDATE SET label=excluded.label, about=excluded.about, image=excluded.image,
       image_mime=excluded.image_mime, hide_secondary=excluded.hide_secondary, updated_at=excluded.updated_at`,
    scope, key, row.label, row.about, row.image, row.image_mime, row.hide_secondary, nowIso()
  );
  return { ok: true, scope, key, label: row.label, about: row.about, image: !!row.image };
}

/* ---------- combined items (written from the admin app) ---------- */

const dropGroup = (id) => {
  run('DELETE FROM hire_group_members WHERE group_id = ?', id);
  run('DELETE FROM hire_groups WHERE id = ?', id);
  run(`DELETE FROM hire_meta WHERE scope = 'type' AND key = ?`, groupKey(id));
};

// Combines the ticked items into one. Ticking a combined item along with others adds them to it (it keeps its
// picture and wording); ticking two combined items merges them into the first. A brand-new combined item takes
// its place in the list, section and (if it has one) picture and wording from the first ticked kind.
export function combineKinds(name, keys) {
  if (!Array.isArray(keys)) throw new HttpError(400, 'Tick the items to combine');
  const list = [...new Set(keys.map(String))];
  if (list.length < 2) throw new HttpError(400, 'Tick at least two items to combine');
  if (list.length > 200 || list.some((k) => !ITEM_KEY.test(k))) throw new HttpError(400, 'Invalid item');
  const nm = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const now = nowIso();
  tx(() => {
    const groupIds = list.map(groupIdOf).filter((id) => id && get('SELECT 1 FROM hire_groups WHERE id = ?', id));
    let gid = groupIds[0];
    if (!gid) {
      if (!nm) throw new HttpError(400, 'Give the combined item a name');
      gid = Number(run('INSERT INTO hire_groups (name, created_at) VALUES (?, ?)', nm, now).lastInsertRowid);
      const first = list.map((k) => get(`SELECT * FROM hire_meta WHERE scope = 'type' AND key = ?`, k)).find(Boolean);
      const withPicture = list.map((k) => get(`SELECT * FROM hire_meta WHERE scope = 'type' AND key = ? AND image IS NOT NULL`, k)).find(Boolean);
      run(`INSERT INTO hire_meta (scope, key, about, image, image_mime, section, sort_order, updated_at) VALUES ('type', ?, ?, ?, ?, ?, ?, ?)`,
        groupKey(gid), withPicture?.about ?? first?.about ?? null, withPicture?.image ?? null, withPicture?.image_mime ?? null,
        first?.section ?? null, first?.sort_order ?? null, now);
    } else if (nm) run('UPDATE hire_groups SET name = ? WHERE id = ?', nm, gid);
    for (const other of groupIds.slice(1)) {
      run('UPDATE hire_group_members SET group_id = ? WHERE group_id = ?', gid, other);
      dropGroup(other);
    }
    for (const k of list.filter((key) => !groupIdOf(key))) {
      run(`INSERT INTO hire_group_members (kind_key, group_id, added_at) VALUES (?, ?, ?)
           ON CONFLICT (kind_key) DO UPDATE SET group_id = excluded.group_id, added_at = excluded.added_at`, k, gid, now);
    }
    // a kind taken from another combined item can leave that one empty
    for (const g of all('SELECT id FROM hire_groups g WHERE NOT EXISTS (SELECT 1 FROM hire_group_members m WHERE m.group_id = g.id)')) dropGroup(g.id);
  });
  return adminCatalogue();
}

// Splits a combined item back into its kinds, which are listed on their own again (with their own pictures)
export function splitGroup(id) {
  if (!get('SELECT 1 FROM hire_groups WHERE id = ?', id)) throw new HttpError(404, 'Combined item not found');
  tx(() => dropGroup(id));
  return adminCatalogue();
}

// Takes one kind out of a combined item; a combined item left with nothing in it goes too
export function removeFromGroup(id, kindKey) {
  const res = run('DELETE FROM hire_group_members WHERE group_id = ? AND kind_key = ?', id, String(kindKey));
  if (!res.changes) throw new HttpError(404, 'That item is not part of this combined item');
  if (!get('SELECT 1 FROM hire_group_members WHERE group_id = ?', id)) dropGroup(id);
  return adminCatalogue();
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

// A hire request becomes a real, active rental the moment it is validated — there is no separate
// acceptance step. Its `reference` stays as the unguessable lookup token for the PDF download link
// (sequential job numbers must not be walkable to pull someone else's hire sheet); the number shown to
// the customer everywhere else is the rental's own `job_number`.
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
  const byKey = new Map();
  for (const l of lines) {
    let t = current.get(String(l?.key ?? ''));
    if (t?.group) t = current.get(t.group); // put in the case before it was combined: book the combined item
    if (!t) throw new HttpError(409, 'Something in your flight case is no longer listed. Please remove it and try again');
    const qty = Math.floor(Number(l?.qty));
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new HttpError(400, `Invalid quantity for ${t.label}`);
    const line = byKey.get(t.key);
    if (line) { line.qty = Math.min(999, line.qty + qty); continue; }
    byKey.set(t.key, {
      key: t.key, label: t.label, details: t.details, qty, available: t.available,
      // a combined item is printed on the hire sheet under its own name
      category: t.category, type: t.type, name: t.combined ? t.label : t.name,
      male_connector: t.male_connector, female_connector: t.female_connector,
      input_connector: t.input_connector, outputs: t.outputs, length_m: t.length_m,
      member_keys: t.combined ? JSON.stringify(t.members.map((m) => m.key)) : null,
    });
  }
  const clean = [...byKey.values()];
  for (const l of clean) if (l.qty > l.available) short.push({ key: l.key, label: l.label, wanted: l.qty, available: l.available });
  if (short.length) {
    const err = new HttpError(409, 'Some of it is no longer available for those dates');
    err.short = short;
    throw err;
  }

  return tx(() => {
    let reference = makeReference();
    for (let i = 0; i < 5 && get('SELECT 1 FROM hire_requests WHERE reference = ?', reference); i++) reference = makeReference();

    const totalQty = clean.reduce((s, l) => s + l.qty, 0);
    const rental = createRentalRow({
      name: event,
      customer: client,
      start_date: start,
      end_date: end,
      notes: [
        `From the hire site, booking reference ${reference}`,
        `Booked by ${renterName} <${renterEmail}>`,
        '',
        'Asked for:',
        ...clean.map((l) => `${l.qty} x ${l.label}${l.details ? ` (${l.details})` : ''}`),
        ...(notes ? ['', `Their notes: ${notes}`] : []),
      ].join('\n'),
    });
    for (const l of clean) {
      run(
        `INSERT INTO rental_requirements (rental_id, kind_key, label, details, qty, category, type, name,
           male_connector, female_connector, input_connector, outputs, length_m, member_keys, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rental.id, l.key, l.label, l.details, l.qty, l.category, l.type, l.name,
        l.male_connector, l.female_connector, l.input_connector, l.outputs, l.length_m ?? null, l.member_keys, nowIso()
      );
    }

    const res = run(
      `INSERT INTO hire_requests (reference, client, event, renter_name, renter_email, start_date, end_date, notes, status, rental_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
      reference, client, event, renterName, renterEmail, start, end, notes, rental.id, nowIso()
    );
    const requestId = Number(res.lastInsertRowid);
    for (const l of clean) {
      run('INSERT INTO hire_request_lines (request_id, type_key, label, details, qty) VALUES (?, ?, ?, ?, ?)', requestId, l.key, l.label, l.details, l.qty);
    }
    logEvent({ action: 'hire_request', rental, detail: `Hire booking from ${renterName} (${client}, ${event}): ${totalQty} item(s), now ${rental.job_number}` });
    return { reference, id: requestId, jobNumber: rental.job_number, rentalId: rental.id };
  });
}

export function listRequests() {
  return all(
    `SELECT q.*, (SELECT SUM(qty) FROM hire_request_lines l WHERE l.request_id = q.id) AS item_count,
       (SELECT COUNT(*) FROM hire_request_lines l WHERE l.request_id = q.id) AS line_count,
       r.name AS rental_name, r.job_number
     FROM hire_requests q LEFT JOIN rentals r ON r.id = q.rental_id
     ORDER BY q.id DESC LIMIT 300`
  ).map((q) => ({ ...q, item_count: q.item_count || 0 }));
}

export function requestDetail(id) {
  const request = get('SELECT q.*, r.name AS rental_name, r.job_number FROM hire_requests q LEFT JOIN rentals r ON r.id = q.rental_id WHERE q.id = ?', id);
  if (!request) throw new HttpError(404, 'Request not found');
  // Availability may have moved on since the request came in, so re-check it for whoever is reading
  const now = new Map(groupTypes(request.start_date, request.end_date).map((t) => [t.key, t]));
  const lines = all('SELECT * FROM hire_request_lines WHERE request_id = ? ORDER BY id', id)
    .map((l) => ({ ...l, available: now.get(l.type_key)?.available ?? null }));
  return { request, lines };
}

// Looks a request up by its unguessable `reference` (never by job number — that's sequential and must
// not be walkable to pull someone else's hire sheet). Used only by the public PDF-download route.
//
// The hire sheet this produces always reflects what was BOOKED (the requirement snapshots), not
// whatever has or hasn't been packed yet — packing progress is an internal concern. writeRentalPdf's
// client layout counts rows to get a quantity per line, so each requirement is expanded into `qty`
// identical synthetic rows for it to count back up again; this keeps requestPdfData a plain data
// lookup and reuses pdf.js completely unmodified.
export function requestPdfData(reference) {
  const request = get('SELECT * FROM hire_requests WHERE reference = ?', String(reference ?? ''));
  if (!request?.rental_id) throw new HttpError(404, 'Not found');
  const rental = get('SELECT * FROM rentals WHERE id = ?', request.rental_id);
  if (!rental) throw new HttpError(404, 'Not found');
  const reqRows = all('SELECT * FROM rental_requirements WHERE rental_id = ?', rental.id);
  const items = [];
  for (const r of reqRows) {
    for (let i = 0; i < r.qty; i++) {
      items.push({
        category: r.category, type: r.type, name: r.name,
        male_connector: r.male_connector, female_connector: r.female_connector,
        input_connector: r.input_connector, outputs: r.outputs, length_m: r.length_m,
      });
    }
  }
  return { rental, items };
}
