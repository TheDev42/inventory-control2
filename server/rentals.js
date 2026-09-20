import { all, get, run, tx, nowIso, logEvent, HttpError } from './db.js';
import { STATUS_LABEL } from './catalog.js';
import { itemSelect, getItem, returnItem } from './items.js';

const str = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const isDate = (s) => s === null || /^\d{4}-\d{2}-\d{2}$/.test(s);

export const getRental = (id) => get('SELECT * FROM rentals WHERE id = ?', id);

function cleanRental(d) {
  const name = str(d.name);
  if (!name) throw new HttpError(400, 'Rental name is required');
  const start = str(d.start_date);
  const end = str(d.end_date);
  if (!isDate(start) || !isDate(end)) throw new HttpError(400, 'Invalid date');
  if (start && end && end < start) throw new HttpError(400, 'End date is before start date');
  return { name, customer: str(d.customer), start_date: start, end_date: end, notes: str(d.notes) };
}

export function listRentals({ status, q } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('r.status = ?'); args.push(status); }
  for (const term of String(q || '').trim().split(/\s+/).filter(Boolean)) {
    const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    where.push(`(r.name LIKE ? ESCAPE '\\' OR r.customer LIKE ? ESCAPE '\\' OR r.notes LIKE ? ESCAPE '\\')`);
    args.push(like, like, like);
  }
  return all(
    `SELECT r.*,
       (SELECT COUNT(*) FROM rental_items ri WHERE ri.rental_id = r.id) AS total_count,
       (SELECT COUNT(*) FROM rental_items ri JOIN items i ON i.id = ri.item_id
          WHERE ri.rental_id = r.id AND ri.outcome IS NULL AND i.status = 'on_rental') AS out_count,
       (SELECT COUNT(*) FROM rental_items ri WHERE ri.rental_id = r.id AND ri.outcome = 'returned') AS returned_count,
       (SELECT COUNT(*) FROM rental_items ri JOIN items i ON i.id = ri.item_id
          WHERE ri.rental_id = r.id AND (ri.outcome = 'lost' OR (ri.outcome IS NULL AND i.status = 'lost'))) AS lost_count
     FROM rentals r ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (r.status = 'active') DESC, COALESCE(r.start_date, r.created_at) DESC, r.id DESC`,
    ...args
  );
}

export function rentalItems(rentalId) {
  return all(
    `${itemSelect('ri.id AS row_id, ri.added_at, ri.returned_at, ri.outcome, ri.case_id, cc.name AS case_name, cc.barcode AS case_barcode, cc.kind AS case_kind')}
     JOIN rental_items ri ON ri.item_id = i.id
     LEFT JOIN containers cc ON cc.id = ri.case_id
     WHERE ri.rental_id = ?
     ORDER BY i.category, i.type, i.barcode COLLATE NOCASE, ri.added_at`,
    rentalId
  );
}

// The cases on this rental, in the order they were added (that order gives the "1 of 3" box numbers on labels)
export function rentalCases(rentalId) {
  return all(
    `SELECT rc.id, rc.container_id, rc.added_at, rc.returned_at, c.name, c.barcode, c.kind,
       (SELECT COUNT(*) FROM rental_items ri WHERE ri.rental_id = rc.rental_id AND ri.case_id = rc.container_id AND ri.outcome IS NULL) AS packed_count
     FROM rental_cases rc JOIN containers c ON c.id = rc.container_id
     WHERE rc.rental_id = ? ORDER BY rc.id`,
    rentalId
  );
}

export function rentalDetail(id) {
  const rental = getRental(id);
  if (!rental) throw new HttpError(404, 'Rental not found');
  return { rental, items: rentalItems(id), cases: rentalCases(id) };
}

export function createRental(data) {
  const c = cleanRental(data);
  const res = run(
    `INSERT INTO rentals (name, customer, start_date, end_date, notes, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    c.name, c.customer, c.start_date, c.end_date, c.notes, nowIso()
  );
  const rental = getRental(Number(res.lastInsertRowid));
  logEvent({ action: 'rental_created', rental, detail: `Rental "${rental.name}" created` });
  return rental;
}

export function updateRental(id, data) {
  const existing = getRental(id);
  if (!existing) throw new HttpError(404, 'Rental not found');
  const c = cleanRental({ ...existing, ...data });
  run('UPDATE rentals SET name=?, customer=?, start_date=?, end_date=?, notes=? WHERE id=?',
    c.name, c.customer, c.start_date, c.end_date, c.notes, id);
  return getRental(id);
}

// Completing a rental closes it off: every item that has not been returned is marked LOST (it stays flagged LOST in
// inventory, with a note, until it is found and restored). `markLost` must be passed when items are still out, as the confirmation.
export function completeRental(id, markLost) {
  const rental = getRental(id);
  if (!rental) throw new HttpError(404, 'Rental not found');
  if (rental.status !== 'active') throw new HttpError(409, 'Rental is already completed');
  const stillOut = all(`${itemSelect()} WHERE i.rental_id = ? AND i.status = 'on_rental'`, id);
  if (stillOut.length && !markLost) {
    throw new HttpError(409, `${stillOut.length} item(s) have not been returned — completing this rental would mark them LOST`);
  }
  tx(() => {
    for (const item of stillOut) {
      run(`UPDATE items SET status = 'lost', container_id = NULL, updated_at = ? WHERE id = ?`, nowIso(), item.id);
      run(`INSERT INTO comments (item_id, kind, text, created_at) VALUES (?, 'marker', ?, ?)`,
        item.id, `Marked LOST: not returned when "${rental.name}" was completed`, nowIso());
      logEvent({ action: 'lost', item, rental, detail: `Not returned when "${rental.name}" was completed: marked lost` });
    }
    // Anything lost on this job is closed off as lost; the item itself stays flagged LOST in inventory.
    run(`UPDATE rental_items SET outcome = 'lost' WHERE rental_id = ? AND outcome IS NULL`, id);
    run(`UPDATE items SET rental_id = NULL WHERE rental_id = ? AND status = 'lost'`, id);
    run(`UPDATE rental_cases SET returned_at = ? WHERE rental_id = ? AND returned_at IS NULL`, nowIso(), id);
    run(`UPDATE rentals SET status = 'completed', completed_at = ? WHERE id = ?`, nowIso(), id);
    logEvent({ action: 'rental_completed', rental, detail: `Rental "${rental.name}" completed${stillOut.length ? `, ${stillOut.length} item(s) not returned were marked lost` : ''}` });
  });
  return { ...getRental(id), marked_lost: stillOut.length };
}

export function reopenRental(id) {
  const rental = getRental(id);
  if (!rental) throw new HttpError(404, 'Rental not found');
  run(`UPDATE rentals SET status = 'active', completed_at = NULL WHERE id = ?`, id);
  logEvent({ action: 'rental_reopened', rental, detail: `Rental "${rental.name}" reopened` });
  return getRental(id);
}

export function deleteRental(id) {
  const rental = getRental(id);
  if (!rental) throw new HttpError(404, 'Rental not found');
  const open = get(`SELECT COUNT(*) AS n FROM rental_items WHERE rental_id = ? AND outcome IS NULL`, id).n;
  if (open) throw new HttpError(409, `${open} item(s) are still out on this rental — return them first`);
  tx(() => {
    run('DELETE FROM rental_items WHERE rental_id = ?', id);
    run('DELETE FROM rental_cases WHERE rental_id = ?', id);
    run('DELETE FROM rentals WHERE id = ?', id);
    logEvent({ action: 'rental_deleted', detail: `Rental "${rental.name}" deleted` });
  });
}

/* ---------- check out (add to rental): shared by the scanner and the manual picker ---------- */

const PAT_WARN = { never: 'never PAT tested', overdue: 'PAT overdue' };

export function checkout(item, rental, viaContainer) {
  if (item.status === 'sold') return { state: 'blocked', text: 'SOLD — it cannot go out on a rental' };
  if (item.status === 'on_rental') {
    if (item.rental_id === rental.id) return { state: 'duplicate', text: 'already on this rental' };
    return { state: 'blocked', text: `already out on "${item.rental_name}" — return it first` };
  }
  if (item.status === 'lost' || item.status === 'disassembled') {
    return { state: 'blocked', text: `marked ${STATUS_LABEL[item.status].toUpperCase()} — scan it in Return mode to restore it first` };
  }
  if (item.status === 'repair') return { state: 'blocked', text: 'marked REPAIR — cannot go out' };
  if (item.pat_status === 'failed') return { state: 'blocked', text: 'PAT FAILED — cannot go out' };

  tx(() => {
    run('INSERT INTO rental_items (rental_id, item_id, added_at) VALUES (?, ?, ?)', rental.id, item.id, nowIso());
    // Scanned individually = physically pulled out of its container; via a container it stays packed in it.
    run(`UPDATE items SET status = 'on_rental', rental_id = ?, container_id = ${viaContainer ? 'container_id' : 'NULL'}, updated_at = ? WHERE id = ?`,
      rental.id, nowIso(), item.id);
    logEvent({
      action: 'out', item, rental,
      detail: `Out on "${rental.name}"${viaContainer ? ` (in ${item.container_name})` : ''}`,
    });
  });
  return { state: 'added', warning: PAT_WARN[item.pat_status] };
}

/* ---------- cases: which cases are on a rental, and which case each line is packed in ---------- */

const getContainerRow = (id) => get('SELECT * FROM containers WHERE id = ?', id);

// Puts a case on the rental (or back on it, if it had been marked returned)
export function attachCase(rentalId, containerId) {
  const row = get('SELECT * FROM rental_cases WHERE rental_id = ? AND container_id = ?', rentalId, containerId);
  if (!row) run('INSERT INTO rental_cases (rental_id, container_id, added_at) VALUES (?, ?, ?)', rentalId, containerId, nowIso());
  else if (row.returned_at) run('UPDATE rental_cases SET returned_at = NULL WHERE id = ?', row.id);
}

// Packs lines into a case (caseId null = take them out of any case). Only lines still out on this rental can be packed.
export function packItems(rentalId, itemIds, caseId) {
  let assigned = 0;
  const skipped = [];
  tx(() => {
    for (const raw of new Set(itemIds.map(Number))) {
      const row = Number.isInteger(raw)
        ? get('SELECT id FROM rental_items WHERE rental_id = ? AND item_id = ? AND outcome IS NULL', rentalId, raw) : null;
      if (!row) { skipped.push({ id: raw, reason: 'not out on this rental' }); continue; }
      run('UPDATE rental_items SET case_id = ? WHERE id = ?', caseId, row.id);
      assigned++;
    }
    if (caseId && assigned) attachCase(rentalId, caseId);
  });
  return { assigned, skipped };
}

function caseIdOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const id = Number(v);
  if (!Number.isInteger(id) || !getContainerRow(id)) throw new HttpError(404, 'Case not found');
  return id;
}

function activeRental(rentalId) {
  const rental = getRental(rentalId);
  if (!rental) throw new HttpError(404, 'Rental not found');
  if (rental.status !== 'active') throw new HttpError(409, `"${rental.name}" is completed — reopen it to change its cases`);
  return rental;
}

export function assignCase(rentalId, itemIds, caseId) {
  const rental = activeRental(rentalId);
  if (!Array.isArray(itemIds) || !itemIds.length) throw new HttpError(400, 'No items selected');
  if (itemIds.length > 1000) throw new HttpError(400, 'Too many items selected at once (max 1000)');
  const cid = caseIdOrNull(caseId);
  const res = packItems(rentalId, itemIds, cid);
  if (res.assigned) {
    const box = cid ? getContainerRow(cid) : null;
    logEvent({ action: 'packed', rental, container: box, detail: box
      ? `${res.assigned} item(s) packed into ${box.name} for "${rental.name}"`
      : `${res.assigned} item(s) taken out of their case on "${rental.name}"` });
  }
  return res;
}

export function addCaseToRental(rentalId, caseId) {
  const rental = activeRental(rentalId);
  const cid = caseIdOrNull(caseId);
  if (!cid) throw new HttpError(400, 'No case chosen');
  attachCase(rentalId, cid);
  const box = getContainerRow(cid);
  logEvent({ action: 'case_added', rental, container: box, detail: `${box.name} added to "${rental.name}"` });
  return rentalCases(rentalId);
}

// Takes the case off the rental; its lines stay on the rental, just no longer packed in it
export function removeCaseFromRental(rentalId, caseId) {
  const rental = activeRental(rentalId);
  const box = getContainerRow(caseId);
  if (!box) throw new HttpError(404, 'Case not found');
  tx(() => {
    run('UPDATE rental_items SET case_id = NULL WHERE rental_id = ? AND case_id = ?', rentalId, caseId);
    run('DELETE FROM rental_cases WHERE rental_id = ? AND container_id = ?', rentalId, caseId);
    logEvent({ action: 'case_removed', rental, container: box, detail: `${box.name} taken off "${rental.name}"` });
  });
  return rentalCases(rentalId);
}

// Manual picker: add several chosen items at once (optionally straight into a case). Items that cannot go out are skipped with a reason.
export function addItemsToRental(rentalId, itemIds, caseId = null) {
  const rental = getRental(rentalId);
  if (!rental) throw new HttpError(404, 'Rental not found');
  if (rental.status !== 'active') throw new HttpError(409, `"${rental.name}" is completed — reopen it to add items`);
  if (!Array.isArray(itemIds) || !itemIds.length) throw new HttpError(400, 'No items selected');
  if (itemIds.length > 1000) throw new HttpError(400, 'Too many items selected at once (max 1000)');
  const cid = caseIdOrNull(caseId);

  const addedIds = [];
  let added = 0;
  let warned = 0;
  const skipped = [];
  for (const raw of new Set(itemIds.map(Number))) {
    const item = Number.isInteger(raw) ? getItem(raw) : null;
    if (!item) { skipped.push({ id: raw, barcode: String(raw), reason: 'item not found' }); continue; }
    const r = checkout(item, rental, false);
    if (r.state === 'added') { added++; addedIds.push(item.id); if (r.warning) warned++; }
    else skipped.push({ id: item.id, barcode: item.barcode, reason: r.text });
  }
  if (cid && addedIds.length) packItems(rentalId, addedIds, cid);
  return { added, warned, skipped, packed: cid ? addedIds.length : 0 };
}

// Undo a mistaken scan-out: takes the item off the rental as if it was never added
export function removeFromRental(rentalId, itemId) {
  const item = getItem(itemId);
  if (!item) throw new HttpError(404, 'Item not found');
  const row = get(`SELECT * FROM rental_items WHERE rental_id = ? AND item_id = ? AND outcome IS NULL`, rentalId, itemId);
  if (!row) throw new HttpError(404, 'Item is not currently on this rental');
  tx(() => {
    run('DELETE FROM rental_items WHERE id = ?', row.id);
    run(`UPDATE items SET rental_id = NULL, status = CASE WHEN status = 'on_rental' THEN 'in_stock' ELSE status END, updated_at = ? WHERE id = ?`,
      nowIso(), itemId);
    logEvent({ action: 'removed', item, rental: { id: rentalId }, detail: `Removed from "${item.rental_name}" (undo)` });
  });
  return getItem(itemId);
}
