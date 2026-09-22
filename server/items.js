import {
  all, get, run, tx, today, addDays, addMonths, nowIso, logEvent, HttpError,
} from './db.js';
import { CATALOG, CONNECTOR_TYPES, OUTPUT_TYPES, STATUS_LABEL, cap, normalizeBarcode, parseOutputs, formatOutputs, parseOwner } from './catalog.js';

/* ---------- SQL fragments ---------- */

// PAT state derived from the item's last test. Dates are generated internally, never user input.
export function patCase() {
  const t = today();
  const soon = addDays(t, 30);
  return `CASE
    WHEN i.status = 'sold' THEN 'na'
    WHEN i.pat_required = 0 THEN 'na'
    WHEN i.last_pat_date IS NULL THEN 'never'
    WHEN i.last_pat_result = 'fail' THEN 'failed'
    WHEN i.next_pat_due < '${t}' THEN 'overdue'
    WHEN i.next_pat_due <= '${soon}' THEN 'due_soon'
    ELSE 'ok' END`;
}

export function itemSelect(extraCols = '') {
  return `SELECT i.*,
      r.name AS rental_name,
      c.name AS container_name, c.barcode AS container_barcode,
      ${patCase()} AS pat_status
      ${extraCols ? ',' + extraCols : ''}
    FROM items i
    LEFT JOIN rentals r ON r.id = i.rental_id
    LEFT JOIN containers c ON c.id = i.container_id`;
}

export const getItem = (id) => get(`${itemSelect()} WHERE i.id = ?`, id);
export const getItemByBarcode = (barcode) => get(`${itemSelect()} WHERE i.barcode = ?`, normalizeBarcode(barcode));
export const getContainerByBarcode = (barcode) => get('SELECT * FROM containers WHERE barcode = ?', normalizeBarcode(barcode));

export function describeItem(item) {
  const parts = [`${cap(item.category)} ${item.type}`];
  if (item.name) parts.push(item.name);
  if (item.male_connector || item.female_connector) {
    parts.push(`${item.male_connector || '?'} → ${item.female_connector || '?'}`);
  }
  if (item.input_connector || item.outputs) {
    const outs = formatOutputs(item.outputs);
    parts.push(`${item.input_connector || '?'} in${outs ? ` → ${outs} out` : ''}`);
  }
  return parts.join(' · ');
}

/* ---------- listing / search / sort ---------- */

const SORTS = {
  barcode: { expr: 'i.barcode', text: true },
  category: { expr: 'i.category', text: true },
  type: { expr: 'i.type', text: true },
  name: { expr: 'i.name', text: true },
  male: { expr: 'i.male_connector', text: true },
  female: { expr: 'i.female_connector', text: true },
  length: { expr: 'i.length_m', text: false },
  status: { expr: 'i.status', text: true },
  owner: { expr: 'i.owner', text: true },
  rental: { expr: 'r.name', text: true },
  container: { expr: 'c.name', text: true },
  location: { expr: 'i.location', text: true },
  pat: { expr: () => patCase(), text: true },
  last_pat: { expr: 'i.last_pat_date', text: true },
  next_pat: { expr: 'i.next_pat_due', text: true },
  created: { expr: 'i.created_at', text: true },
};

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export function listItems(query = {}) {
  const where = [];
  const args = [];
  const exact = { category: 'i.category', type: 'i.type', status: 'i.status', owner: 'i.owner', rental_id: 'i.rental_id', container_id: 'i.container_id' };
  for (const [key, col] of Object.entries(exact)) {
    if (query[key] !== undefined && query[key] !== '') {
      where.push(`${col} = ?`);
      args.push(key === 'category' ? String(query[key]).toUpperCase() : key === 'owner' ? (parseOwner(query[key]) ?? query[key]) : query[key]);
    }
  }
  if (query.male) { where.push('i.male_connector = ? COLLATE NOCASE'); args.push(query.male); }
  if (query.female) { where.push('i.female_connector = ? COLLATE NOCASE'); args.push(query.female); }
  if (query.pat) where.push("i.status != 'sold'"); // sold items are out of PAT altogether
  if (query.pat === 'required') where.push('i.pat_required = 1');
  else if (query.pat) { where.push(`${patCase()} = ?`); args.push(query.pat); }
  if (query.unassigned === '1') where.push('i.container_id IS NULL');

  const pat = patCase();
  // Status and PAT status are turned into space-separated phrases for searching (e.g. 'in_stock' -> 'in stock').
  // Matched as substrings like everything else, a short query word can accidentally land inside one of those words
  // instead of matching it as a whole word — e.g. "to" is a substring of "stock", so any multi-word search containing
  // "to" would match nearly every in-stock item regardless of what the rest of the query said. These two columns are
  // matched as whole words (padded with spaces) to close that off; free-text columns keep ordinary substring matching.
  const wordCols = new Set(["replace(i.status, '_', ' ')", `replace(${pat}, '_', ' ')`]);
  const rawQ = String(query.q || '').trim();
  const terms = rawQ.split(/\s+/).filter(Boolean);

  // The flexible search: every word must appear *somewhere*, each independently in any of these columns.
  // A single field can satisfy more than one word on its own — e.g. a male connector logged as "PowerCON TRUE1
  // Old" contains both "PowerCon" and "TRUE1" — so a query naming two different connectors (one per end) can
  // match an item that only actually has one of them, with the other end being something else entirely.
  function looseSearchClause() {
    const w = [];
    const a = [];
    for (const term of terms) {
      const like = `%${escapeLike(term)}%`;
      const wordLike = ` ${escapeLike(term)} `;
      const cols = [
        'i.barcode', 'i.category', 'i.type', 'i.name', 'i.male_connector', 'i.female_connector', 'i.input_connector', 'i.outputs',
        'i.location', "(CASE i.owner WHEN 'personal' THEN 'personal mine me' ELSE 'company' END)",
        "replace(i.status, '_', ' ')", 'r.name', 'c.name', 'c.barcode', 'c.location', 'CAST(i.length_m AS TEXT)',
        'i.last_pat_date', 'i.next_pat_due', `replace(${pat}, '_', ' ')`,
      ];
      w.push('(' + cols.map((c) => (wordCols.has(c) ? `(' ' || ${c} || ' ') LIKE ? ESCAPE '\\'` : `${c} LIKE ? ESCAPE '\\'`)).join(' OR ') + ')');
      a.push(...cols.map((c) => (wordCols.has(c) ? wordLike : like)));
    }
    return { where: w, args: a };
  }

  // For a search of more than one word, try an exact-phrase match against the item's own barcode or description
  // first — that's the most precise thing a multi-word query can mean, and it's how you'd naturally search for an
  // item using the description you gave it yourself (e.g. "True1 To PowerCon Blue"). Only fall back to the
  // word-by-word search above when nothing's own text literally contains that phrase; otherwise a shared word
  // (like "PowerCon" above) can pull in a different, unrelated item that merely matches every word individually.
  const baseWhere = where.slice();
  const baseArgs = args.slice();
  const countAndFetch = (extraWhere, extraArgs, orderSql, limit, offset) => {
    const whereSql = [...baseWhere, ...extraWhere].length ? 'WHERE ' + [...baseWhere, ...extraWhere].join(' AND ') : '';
    const allArgs = [...baseArgs, ...extraArgs];
    const total = get(
      `SELECT COUNT(*) AS n FROM items i
       LEFT JOIN rentals r ON r.id = i.rental_id
       LEFT JOIN containers c ON c.id = i.container_id ${whereSql}`,
      ...allArgs
    ).n;
    const items = all(`${itemSelect()} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`, ...allArgs, limit, offset);
    return { items, total, whereSql, args: allArgs };
  };

  const sort = SORTS[query.sort] || SORTS.barcode;
  const expr = typeof sort.expr === 'function' ? sort.expr() : sort.expr;
  const dir = String(query.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderSql = `ORDER BY (${expr}) IS NULL, ${expr} ${sort.text ? 'COLLATE NOCASE' : ''} ${dir}, i.barcode COLLATE NOCASE ASC`;

  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 1000);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);

  if (terms.length > 1) {
    const phraseLike = `%${escapeLike(rawQ)}%`;
    const phraseWhere = [`(i.barcode LIKE ? ESCAPE '\\' OR i.name LIKE ? ESCAPE '\\')`];
    const phraseArgs = [phraseLike, phraseLike];
    const strict = countAndFetch(phraseWhere, phraseArgs, orderSql, limit, offset);
    if (strict.total > 0) return { items: strict.items, total: strict.total };
    // Nothing has that exact phrase — fall back to the flexible word-by-word search.
  }

  const loose = terms.length ? looseSearchClause() : { where: [], args: [] };
  const result = countAndFetch(loose.where, loose.args, orderSql, limit, offset);
  return { items: result.items, total: result.total };
}

/* ---------- validation ---------- */

const str = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const truthy = (v) => v === true || v === 1 || ['1', 'true', 'yes', 'y'].includes(String(v).trim().toLowerCase());
const falsy = (v) => v === false || v === 0 || ['0', 'false', 'no', 'n'].includes(String(v).trim().toLowerCase());

export function barcodeTaken(barcode, exceptItemId = null) {
  const it = get('SELECT id FROM items WHERE barcode = ?', barcode);
  if (it && it.id !== exceptItemId) return 'item';
  if (get('SELECT id FROM containers WHERE barcode = ?', barcode)) return 'container';
  return null;
}

// Accepts [{connector, qty}], the stored JSON, or CSV-style text such as "6x 16A Cee (blue); 2x 13A (BS1363)".
export function cleanOutputs(value) {
  let list = value;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.startsWith('[')) list = parseOutputs(s);
    else {
      list = s.split(/[;\n]+/).map((part) => part.trim()).filter(Boolean).map((part) => {
        const m = part.match(/^(\d+)\s*[x×]\s*(.+)$/i);
        return m ? { qty: Number(m[1]), connector: m[2].trim() } : { qty: 1, connector: part };
      });
    }
  }
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(list)) throw new HttpError(400, 'Outputs must be a list of connectors');
  const merged = new Map();
  for (const o of list) {
    const connector = str(o?.connector);
    if (!connector) continue; // blank rows from the form are ignored
    if (connector.length > 60) throw new HttpError(400, `Output connector "${connector.slice(0, 20)}…" is too long`);
    const qty = o.qty === undefined || o.qty === '' ? 1 : Number(o.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new HttpError(400, `Invalid quantity "${o.qty}" for output ${connector} (use 1–99)`);
    const key = connector.toLowerCase();
    const cur = merged.get(key);
    if (cur) cur.qty += qty; else merged.set(key, { connector, qty });
  }
  if (merged.size > 20) throw new HttpError(400, 'Too many different output connectors (max 20)');
  return [...merged.values()].map((o) => ({ connector: o.connector, qty: Math.min(o.qty, 99) }));
}

export function cleanItem(d) {
  const barcode = str(normalizeBarcode(d.barcode));
  if (!barcode) throw new HttpError(400, 'Barcode is required');
  const category = String(d.category || '').trim().toUpperCase();
  const type = String(d.type || '').trim().toLowerCase();
  if (!CATALOG[category]) throw new HttpError(400, `Invalid category "${d.category}" (use ${Object.keys(CATALOG).join(', ')})`);
  if (!CATALOG[category].includes(type)) {
    throw new HttpError(400, `Invalid type "${d.type}" for ${category} (use ${CATALOG[category].join(', ')})`);
  }
  const hasConnectors = CONNECTOR_TYPES.has(type);
  const isDistro = OUTPUT_TYPES.has(type);
  const owner = parseOwner(d.owner);
  if (!owner) throw new HttpError(400, `Invalid owner "${d.owner}" (use company or me)`);
  const outputs = isDistro ? cleanOutputs(d.outputs) : [];
  const length = str(d.length_m);
  if (length !== null && !Number.isFinite(Number(length))) throw new HttpError(400, `Invalid length "${d.length_m}"`);
  const cost = str(d.cost);
  if (cost !== null && (!Number.isFinite(Number(cost)) || Number(cost) < 0)) throw new HttpError(400, `Invalid cost "${d.cost}"`);
  let patRequired;
  if (d.pat_required === undefined || d.pat_required === null || d.pat_required === '') {
    patRequired = !(category === 'SOUND' && type === 'cable') ? 1 : 0; // signal cables don't need PAT
  } else if (truthy(d.pat_required)) patRequired = 1;
  else if (falsy(d.pat_required)) patRequired = 0;
  else throw new HttpError(400, `Invalid PAT required value "${d.pat_required}"`);
  const interval = parseInt(d.pat_interval_months, 10);
  const containerId = d.container_id ? parseInt(d.container_id, 10) : null;
  if (containerId && !get('SELECT id FROM containers WHERE id = ?', containerId)) {
    throw new HttpError(400, 'Container not found');
  }
  return {
    barcode, category, type,
    name: str(d.name),
    male_connector: hasConnectors ? str(d.male_connector) : null,
    female_connector: hasConnectors ? str(d.female_connector) : null,
    owner,
    input_connector: isDistro ? str(d.input_connector) : null,
    outputs: outputs.length ? JSON.stringify(outputs) : null,
    length_m: length === null ? null : Number(length),
    pat_required: patRequired,
    pat_interval_months: interval > 0 ? interval : 12,
    container_id: containerId,
    location: str(d.location),
    cost: cost === null ? null : Number(cost),
  };
}

/* ---------- create / update / delete ---------- */

function insertItem(c) {
  const ts = nowIso();
  const res = run(
    `INSERT INTO items (barcode, category, type, name, male_connector, female_connector, input_connector, outputs, length_m,
       pat_required, pat_interval_months, container_id, owner, location, cost, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.barcode, c.category, c.type, c.name, c.male_connector, c.female_connector, c.input_connector, c.outputs, c.length_m,
    c.pat_required, c.pat_interval_months, c.container_id, c.owner, c.location, c.cost, ts, ts
  );
  return getItem(Number(res.lastInsertRowid));
}

export function createItem(data) {
  const c = cleanItem(data);
  const clash = barcodeTaken(c.barcode);
  if (clash) throw new HttpError(409, `Barcode ${c.barcode} is already used by a ${clash}`);
  return tx(() => {
    const item = insertItem(c);
    logEvent({ action: 'created', item, detail: `Added to inventory: ${describeItem(item)}` });
    return item;
  });
}

export function bulkCreate(list) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'No items supplied');
  if (list.length > 5000) throw new HttpError(400, 'Too many items in one go (max 5000)');
  const created = [];
  const skipped = [];
  const seen = new Set();
  tx(() => {
    list.forEach((d, idx) => {
      const label = str(normalizeBarcode(d?.barcode)) || `row ${idx + 1}`;
      try {
        const c = cleanItem(d || {});
        const key = c.barcode.toLowerCase();
        if (seen.has(key)) throw new HttpError(409, 'Duplicate barcode in this batch');
        const clash = barcodeTaken(c.barcode);
        if (clash) throw new HttpError(409, `Barcode already used by a ${clash}`);
        seen.add(key);
        created.push(insertItem(c).id);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        skipped.push({ barcode: label, reason: err.message });
      }
    });
    if (created.length) {
      logEvent({ action: 'bulk_created', detail: `Bulk added ${created.length} item(s)` });
    }
  });
  return { created: created.length, skipped };
}

export function updateItem(id, data) {
  const existing = getItem(id);
  if (!existing) throw new HttpError(404, 'Item not found');
  const c = cleanItem({ ...existing, ...data });
  const clash = barcodeTaken(c.barcode, id);
  if (clash) throw new HttpError(409, `Barcode ${c.barcode} is already used by a ${clash}`);
  if (existing.status === 'sold' && c.container_id) throw new HttpError(409, 'Sold items cannot be stored in a container');
  run(
    `UPDATE items SET barcode=?, category=?, type=?, name=?, male_connector=?, female_connector=?, input_connector=?, outputs=?, length_m=?,
       pat_required=?, pat_interval_months=?, container_id=?, owner=?, location=?, cost=?, updated_at=? WHERE id=?`,
    c.barcode, c.category, c.type, c.name, c.male_connector, c.female_connector, c.input_connector, c.outputs, c.length_m,
    c.pat_required, c.pat_interval_months, c.container_id, c.owner, c.location, c.cost, nowIso(), id
  );
  const item = getItem(id);
  logEvent({ action: 'edited', item, detail: 'Details edited' });
  return item;
}

// Sets the owner of many items at once (e.g. everything you personally own). Unknown ids are ignored.
export function setOwner(itemIds, ownerValue) {
  const owner = parseOwner(ownerValue);
  if (!owner || String(ownerValue ?? '').trim() === '') throw new HttpError(400, `Invalid owner "${ownerValue}" (use company or me)`);
  if (!Array.isArray(itemIds) || !itemIds.length) throw new HttpError(400, 'No items selected');
  if (itemIds.length > 5000) throw new HttpError(400, 'Too many items at once (max 5000)');
  const ids = [...new Set(itemIds.map(Number).filter(Number.isInteger))];
  let updated = 0;
  tx(() => {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      updated += run(`UPDATE items SET owner = ?, updated_at = ? WHERE owner != ? AND id IN (${chunk.map(() => '?').join(',')})`,
        owner, nowIso(), owner, ...chunk).changes;
    }
    if (updated) logEvent({ action: 'owner', detail: `Owner of ${updated} item(s) set to ${owner === 'personal' ? 'me (personal)' : 'the company'}` });
  });
  return { updated, matched: ids.length, owner };
}

// Sets the cost of many items at once (e.g. a batch bought together). Unknown ids are ignored.
export function setCost(itemIds, costValue) {
  const raw = str(costValue);
  if (raw === null || !Number.isFinite(Number(raw)) || Number(raw) < 0) throw new HttpError(400, `Invalid cost "${costValue}"`);
  if (!Array.isArray(itemIds) || !itemIds.length) throw new HttpError(400, 'No items selected');
  if (itemIds.length > 5000) throw new HttpError(400, 'Too many items at once (max 5000)');
  const ids = [...new Set(itemIds.map(Number).filter(Number.isInteger))];
  const cost = Number(raw);
  let updated = 0;
  tx(() => {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      updated += run(
        `UPDATE items SET cost = ?, updated_at = ? WHERE (cost IS NULL OR cost != ?) AND id IN (${chunk.map(() => '?').join(',')})`,
        cost, nowIso(), cost, ...chunk
      ).changes;
    }
    if (updated) logEvent({ action: 'cost', detail: `Cost of ${updated} item(s) set to £${cost.toFixed(2)}` });
  });
  return { updated, matched: ids.length, cost };
}

export function deleteItem(id) {
  const item = getItem(id);
  if (!item) throw new HttpError(404, 'Item not found');
  if (item.rental_id) throw new HttpError(409, `Item is out on "${item.rental_name}" — return it before deleting`);
  tx(() => {
    run('DELETE FROM rental_items WHERE item_id = ?', id);
    run('DELETE FROM items WHERE id = ?', id);
    logEvent({ action: 'deleted', barcode: item.barcode, detail: `Deleted ${describeItem(item)}` });
  });
}

/* ---------- state changes shared by the scanner and the UI ---------- */

// Item comes back to active inventory (from a rental, or from lost / disassembled / repair)
export function returnItem(item, detail, note) {
  tx(() => {
    run(`UPDATE rental_items SET returned_at = ?, outcome = 'returned' WHERE item_id = ? AND outcome IS NULL`, nowIso(), item.id);
    run(`UPDATE items SET status = 'in_stock', rental_id = NULL, updated_at = ? WHERE id = ?`, nowIso(), item.id);
    if (item.status !== 'on_rental') {
      // Leave a trail in the item's comments: it was flagged, now it's back.
      run(`INSERT INTO comments (item_id, kind, text, created_at) VALUES (?, 'marker', ?, ?)`,
        item.id, `Restored to stock (was ${STATUS_LABEL[item.status].toUpperCase()})${note ? ': ' + note : ''}`, nowIso());
    }
    logEvent({
      action: item.status === 'on_rental' ? 'returned' : 'restored',
      item,
      rental: item.rental_id ? { id: item.rental_id } : null,
      detail: detail || (item.rental_name ? `Returned from "${item.rental_name}"` : `Restored to stock (was ${STATUS_LABEL[item.status]})`),
    });
  });
  return getItem(item.id);
}

// Marker: lost / disassembled / repair / sold, or in_stock to clear one. `note` becomes a marker comment.
// Sold items stay on the register but are inert: no scanning, rentals, containers or PAT. Only "in_stock" (undo the sale) moves them.
export function setMarker(id, status, note) {
  const item = getItem(id);
  if (!item) throw new HttpError(404, 'Item not found');
  if (!['in_stock', 'lost', 'disassembled', 'repair', 'sold'].includes(status)) throw new HttpError(400, 'Invalid status');
  if (status === item.status) throw new HttpError(409, `Already marked ${STATUS_LABEL[status]}`);
  if (item.status === 'sold' && status !== 'in_stock') throw new HttpError(409, 'Item is SOLD — undo the sale first');
  if (status === 'sold' && item.status === 'lost') throw new HttpError(409, 'Item is marked LOST — restore it to stock before marking it sold');

  if (status === 'in_stock') {
    if (item.status === 'on_rental') throw new HttpError(409, 'Item is on a rental — return it instead');
    return returnItem(item, undefined, note);
  }

  if (item.status === 'on_rental' && status !== 'lost') {
    throw new HttpError(409, `Item is on "${item.rental_name}" — return it before marking it ${STATUS_LABEL[status]}`);
  }
  tx(() => {
    // Lost items stay linked to their rental so you can see where they went missing.
    run(`UPDATE items SET status = ?, container_id = NULL, updated_at = ? WHERE id = ?`, status, nowIso(), id);
    run(`INSERT INTO comments (item_id, kind, text, created_at) VALUES (?, 'marker', ?, ?)`,
      id, `Marked ${STATUS_LABEL[status].toUpperCase()}${note ? ': ' + note : ''}`, nowIso());
    logEvent({ action: status, item, rental: item.rental_id ? { id: item.rental_id } : null,
      detail: `Marked ${STATUS_LABEL[status]}${note ? ': ' + note : ''}` });
  });
  return getItem(id);
}

export function addComment(itemId, text) {
  const item = getItem(itemId);
  if (!item) throw new HttpError(404, 'Item not found');
  const t = str(text);
  if (!t) throw new HttpError(400, 'Comment is empty');
  const res = run(`INSERT INTO comments (item_id, kind, text, created_at) VALUES (?, 'comment', ?, ?)`, itemId, t, nowIso());
  logEvent({ action: 'comment', item, detail: t.length > 80 ? t.slice(0, 80) + '…' : t });
  return get('SELECT * FROM comments WHERE id = ?', Number(res.lastInsertRowid));
}

export function deleteComment(id) {
  const res = run('DELETE FROM comments WHERE id = ?', id);
  if (!res.changes) throw new HttpError(404, 'Comment not found');
}

export function setContainer(item, containerId) {
  run('UPDATE items SET container_id = ?, updated_at = ? WHERE id = ?', containerId, nowIso(), item.id);
}

/* ---------- PAT ---------- */

export function recordPat(itemId, { result, tester, notes, date } = {}) {
  const item = getItem(itemId);
  if (!item) throw new HttpError(404, 'Item not found');
  if (item.status === 'sold') throw new HttpError(409, 'Item is SOLD — it cannot be PAT tested');
  const res = result === 'fail' ? 'fail' : 'pass';
  const tested = str(date) || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tested)) throw new HttpError(400, 'Invalid date');
  const nextDue = res === 'pass' ? addMonths(tested, item.pat_interval_months || 12) : null;
  tx(() => {
    run(`INSERT INTO pat_tests (item_id, tested_at, result, tester, notes, next_due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      itemId, tested, res, str(tester), str(notes), nextDue, nowIso());
    // Record the most recent test only if this one is at least as new as what we already hold
    if (!item.last_pat_date || tested >= item.last_pat_date) {
      run(`UPDATE items SET last_pat_date = ?, last_pat_result = ?, next_pat_due = ?, pat_required = 1, updated_at = ? WHERE id = ?`,
        tested, res, nextDue, nowIso(), itemId);
    }
    if (res === 'fail' && item.status === 'in_stock') {
      run(`UPDATE items SET status = 'repair', container_id = NULL WHERE id = ?`, itemId);
      run(`INSERT INTO comments (item_id, kind, text, created_at) VALUES (?, 'marker', ?, ?)`,
        itemId, `PAT FAILED${notes ? ': ' + notes : ''} — moved to repair`, nowIso());
    } else if (res === 'pass' && item.status === 'repair') {
      run(`UPDATE items SET status = 'in_stock' WHERE id = ?`, itemId);
      run(`INSERT INTO comments (item_id, kind, text, created_at) VALUES (?, 'marker', ?, ?)`,
        itemId, 'PAT passed after repair — back in stock', nowIso());
    }
    logEvent({ action: res === 'pass' ? 'pat_pass' : 'pat_fail', item, detail: `PAT ${res.toUpperCase()}${tester ? ' by ' + tester : ''}` });
  });
  return getItem(itemId);
}

// Removes one PAT test (a mistaken click, a wrong date...). The item's "last test / next due" are worked out again from the
// tests that remain (none left = never tested). Its status is left alone: if a deleted FAIL had put it in Repair, restore it yourself.
export function deletePatTest(itemId, testId) {
  const item = getItem(itemId);
  if (!item) throw new HttpError(404, 'Item not found');
  const test = get('SELECT * FROM pat_tests WHERE id = ? AND item_id = ?', testId, itemId);
  if (!test) throw new HttpError(404, 'PAT test not found');
  tx(() => {
    run('DELETE FROM pat_tests WHERE id = ?', testId);
    const latest = get('SELECT * FROM pat_tests WHERE item_id = ? ORDER BY tested_at DESC, id DESC LIMIT 1', itemId);
    run('UPDATE items SET last_pat_date = ?, last_pat_result = ?, next_pat_due = ?, updated_at = ? WHERE id = ?',
      latest?.tested_at ?? null, latest?.result ?? null, latest?.next_due ?? null, nowIso(), itemId);
    logEvent({ action: 'pat_deleted', item, detail: `Deleted the PAT ${test.result.toUpperCase()} test from ${test.tested_at}` });
  });
  return getItem(itemId);
}

export function itemDetail(id) {
  const item = getItem(id);
  if (!item) throw new HttpError(404, 'Item not found');
  return {
    item,
    comments: all('SELECT * FROM comments WHERE item_id = ? ORDER BY id DESC', id),
    pat_tests: all('SELECT * FROM pat_tests WHERE item_id = ? ORDER BY tested_at DESC, id DESC', id),
    rentals: all(
      `SELECT ri.*, r.name AS rental_name, r.customer FROM rental_items ri
       JOIN rentals r ON r.id = ri.rental_id WHERE ri.item_id = ? ORDER BY ri.added_at DESC`, id),
    events: all('SELECT * FROM events WHERE item_id = ? ORDER BY id DESC LIMIT 50', id),
  };
}
