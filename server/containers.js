import { all, get, run, tx, nowIso, today, logEvent, HttpError } from './db.js';
import { barcodeTaken, itemSelect, getItem } from './items.js';
import { normalizeBarcode } from './catalog.js';
import { contentsLines } from './label.js';

const str = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

export const getContainer = (id) => get('SELECT * FROM containers WHERE id = ?', id);

// permanent = a case you always use (part of your kit); temporary = a one-off box made for a job
const kindOf = (v) => (v === 'temporary' ? 'temporary' : 'permanent');

// Temporary boxes get their barcode automatically: T0001, T0002, ...
function nextTempBarcode() {
  for (let n = 1; n < 100000; n++) {
    const code = `T${String(n).padStart(4, '0')}`;
    if (!barcodeTaken(code)) return code;
  }
  throw new HttpError(500, 'Could not find a free temporary barcode');
}

// Scalar subquery: column `col` of the active rental this case is currently on (if any); `idExpr` is the case's id (a column or ?)
const onRental = (col, idExpr) => `(SELECT r.${col} FROM rental_cases rc JOIN rentals r ON r.id = rc.rental_id
  WHERE rc.container_id = ${idExpr} AND rc.returned_at IS NULL AND r.status = 'active' ORDER BY rc.id DESC LIMIT 1)`;

export function listContainers(q, kind) {
  const where = [];
  const args = [];
  if (kind === 'permanent' || kind === 'temporary') { where.push('c.kind = ?'); args.push(kind); }
  for (const term of String(q || '').trim().split(/\s+/).filter(Boolean)) {
    const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    where.push(`(c.name LIKE ? ESCAPE '\\' OR c.barcode LIKE ? ESCAPE '\\' OR c.location LIKE ? ESCAPE '\\' OR c.notes LIKE ? ESCAPE '\\')`);
    args.push(like, like, like, like);
  }
  return all(
    `SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.container_id = c.id) AS item_count,
       ${onRental('id', 'c.id')} AS out_rental_id, ${onRental('name', 'c.id')} AS out_rental_name
     FROM containers c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY c.name COLLATE NOCASE`,
    ...args
  );
}

export function containerDetail(id) {
  const container = getContainer(id);
  if (!container) throw new HttpError(404, 'Container not found');
  const items = all(`${itemSelect()} WHERE i.container_id = ? ORDER BY i.category, i.type, i.barcode COLLATE NOCASE`, id);
  const rental = get(`SELECT ${onRental('id', '?')} AS id, ${onRental('name', '?')} AS name`, id, id);
  return { container, items, onRental: rental?.id ? rental : null };
}

export function createContainer(data) {
  const kind = kindOf(data.kind);
  let barcode = str(normalizeBarcode(data.barcode));
  if (!barcode && kind === 'temporary') barcode = nextTempBarcode(); // one-off boxes only need a name
  let name = str(data.name);
  if (!name && kind === 'temporary') name = `Temp box ${barcode}`;
  if (!barcode) throw new HttpError(400, 'Barcode is required');
  if (!name) throw new HttpError(400, 'Name is required');
  const clash = barcodeTaken(barcode);
  if (clash) throw new HttpError(409, `Barcode ${barcode} is already used by a ${clash}`);
  const res = run('INSERT INTO containers (barcode, name, location, notes, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    barcode, name, str(data.location), str(data.notes), kind, nowIso());
  const container = getContainer(Number(res.lastInsertRowid));
  logEvent({ action: 'container_created', container, detail: `${kind === 'temporary' ? 'Temporary box' : 'Container'} "${name}" created` });
  return container;
}

export function updateContainer(id, data) {
  const existing = getContainer(id);
  if (!existing) throw new HttpError(404, 'Container not found');
  const merged = { ...existing, ...data };
  const barcode = str(normalizeBarcode(merged.barcode));
  const name = str(merged.name);
  if (!barcode || !name) throw new HttpError(400, 'Barcode and name are required');
  if (barcode.toLowerCase() !== existing.barcode.toLowerCase()) {
    const clash = barcodeTaken(barcode);
    if (clash) throw new HttpError(409, `Barcode ${barcode} is already used by a ${clash}`);
  }
  run('UPDATE containers SET barcode=?, name=?, location=?, notes=?, kind=? WHERE id=?',
    barcode, name, str(merged.location), str(merged.notes), kindOf(merged.kind), id);
  return getContainer(id);
}

export function deleteContainer(id) {
  const container = getContainer(id);
  if (!container) throw new HttpError(404, 'Container not found');
  tx(() => {
    run('UPDATE items SET container_id = NULL WHERE container_id = ?', id); // contents go back to loose stock
    run('UPDATE rental_items SET case_id = NULL WHERE case_id = ?', id);
    run('DELETE FROM rental_cases WHERE container_id = ?', id);
    run('DELETE FROM containers WHERE id = ?', id);
    logEvent({ action: 'container_deleted', detail: `Container "${container.name}" deleted` });
  });
}

export function unstoreItem(itemId) {
  const item = getItem(itemId);
  if (!item) throw new HttpError(404, 'Item not found');
  if (!item.container_id) throw new HttpError(409, 'Item is not in a container');
  run('UPDATE items SET container_id = NULL, updated_at = ? WHERE id = ?', nowIso(), itemId);
  logEvent({ action: 'unstored', item, container: { id: item.container_id }, detail: `Removed from ${item.container_name}` });
  return getItem(itemId);
}

export function emptyContainer(id) {
  const container = getContainer(id);
  if (!container) throw new HttpError(404, 'Container not found');
  const res = run('UPDATE items SET container_id = NULL, updated_at = ? WHERE container_id = ?', nowIso(), id);
  logEvent({ action: 'unstored', container, detail: `Emptied ${container.name} (${res.changes} items)` });
  return res.changes;
}

// Temporary boxes that have done their job: they were on at least one rental, are empty, and are not on an active rental now.
export function clearFinishedTemporary() {
  const done = all(
    `SELECT c.id, c.name FROM containers c
     WHERE c.kind = 'temporary'
       AND EXISTS (SELECT 1 FROM rental_cases rc WHERE rc.container_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM items i WHERE i.container_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM rental_cases rc JOIN rentals r ON r.id = rc.rental_id
                       WHERE rc.container_id = c.id AND r.status = 'active' AND rc.returned_at IS NULL)`
  );
  for (const c of done) deleteContainer(c.id);
  return done.length;
}

// What goes on a case label. If the case is packed for an active rental, the contents are the lines packed into it
// on that rental (and client / event / start date / "2 of 3" come from that rental). Otherwise it is whatever is in the case.
export function labelData(id) {
  const { container, items } = containerDetail(id);
  const active = get(
    `SELECT rc.rental_id, r.name AS rental_name, r.customer, r.start_date FROM rental_cases rc JOIN rentals r ON r.id = rc.rental_id
     WHERE rc.container_id = ? AND rc.returned_at IS NULL AND r.status = 'active' ORDER BY rc.id DESC LIMIT 1`, id);
  if (active) {
    const packed = all(`${itemSelect()} JOIN rental_items ri ON ri.item_id = i.id
                        WHERE ri.rental_id = ? AND ri.case_id = ? AND ri.outcome IS NULL`, active.rental_id, id);
    const cases = all('SELECT container_id FROM rental_cases WHERE rental_id = ? ORDER BY id', active.rental_id);
    const pos = cases.findIndex((c) => c.container_id === id);
    return {
      container, contents: packed,
      client: active.customer || '', event: active.rental_name, date: active.start_date || today(),
      box: pos >= 0 ? `${pos + 1} of ${cases.length}` : '',
    };
  }
  // older data (case scanned out before rentals tracked cases): if everything from the case is out on one rental, use that one
  const rentalIds = [...new Set(items.filter((i) => i.status === 'on_rental' && i.rental_id).map((i) => i.rental_id))];
  const rental = rentalIds.length === 1 ? get('SELECT * FROM rentals WHERE id = ?', rentalIds[0]) : null;
  return { container, contents: items, client: rental?.customer || '', event: rental?.name || '', date: rental?.start_date || today(), box: '' };
}

// Starting values for the "print label" form
export function labelDefaults(id) {
  const d = labelData(id);
  return {
    client: d.client, event: d.event, date: d.date, box: d.box,
    contents: contentsLines(d.contents).join('\n'),
    name: d.container.name, barcode: d.container.barcode,
  };
}
