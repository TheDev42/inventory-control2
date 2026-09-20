import { all, get, run, tx, nowIso, logEvent, HttpError } from './db.js';
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
    `${itemSelect('ri.id AS row_id, ri.added_at, ri.returned_at, ri.outcome')}
     JOIN rental_items ri ON ri.item_id = i.id
     WHERE ri.rental_id = ?
     ORDER BY i.category, i.type, i.barcode COLLATE NOCASE, ri.added_at`,
    rentalId
  );
}

export function rentalDetail(id) {
  const rental = getRental(id);
  if (!rental) throw new HttpError(404, 'Rental not found');
  return { rental, items: rentalItems(id) };
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

export function completeRental(id, returnAll) {
  const rental = getRental(id);
  if (!rental) throw new HttpError(404, 'Rental not found');
  if (rental.status !== 'active') throw new HttpError(409, 'Rental is already completed');
  const stillOut = all(`${itemSelect()} WHERE i.rental_id = ? AND i.status = 'on_rental'`, id);
  if (stillOut.length && !returnAll) {
    throw new HttpError(409, `${stillOut.length} item(s) are still out on this rental`);
  }
  tx(() => {
    for (const item of stillOut) returnItem(item);
    // Anything lost on this job is closed off as lost; the item itself stays flagged LOST in inventory.
    run(`UPDATE rental_items SET outcome = 'lost' WHERE rental_id = ? AND outcome IS NULL`, id);
    run(`UPDATE items SET rental_id = NULL WHERE rental_id = ? AND status = 'lost'`, id);
    run(`UPDATE rentals SET status = 'completed', completed_at = ? WHERE id = ?`, nowIso(), id);
    logEvent({ action: 'rental_completed', rental, detail: `Rental "${rental.name}" completed` });
  });
  return getRental(id);
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
    run('DELETE FROM rentals WHERE id = ?', id);
    logEvent({ action: 'rental_deleted', detail: `Rental "${rental.name}" deleted` });
  });
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
