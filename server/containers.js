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

export function listContainers(q) {
  const where = [];
  const args = [];
  for (const term of String(q || '').trim().split(/\s+/).filter(Boolean)) {
    const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    where.push(`(c.name LIKE ? ESCAPE '\\' OR c.barcode LIKE ? ESCAPE '\\' OR c.location LIKE ? ESCAPE '\\' OR c.notes LIKE ? ESCAPE '\\')`);
    args.push(like, like, like, like);
  }
  return all(
    `SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.container_id = c.id) AS item_count
     FROM containers c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY c.name COLLATE NOCASE`,
    ...args
  );
}

export function containerDetail(id) {
  const container = getContainer(id);
  if (!container) throw new HttpError(404, 'Container not found');
  const items = all(`${itemSelect()} WHERE i.container_id = ? ORDER BY i.category, i.type, i.barcode COLLATE NOCASE`, id);
  return { container, items };
}

export function createContainer(data) {
  const barcode = str(normalizeBarcode(data.barcode));
  const name = str(data.name);
  if (!barcode) throw new HttpError(400, 'Barcode is required');
  if (!name) throw new HttpError(400, 'Name is required');
  const clash = barcodeTaken(barcode);
  if (clash) throw new HttpError(409, `Barcode ${barcode} is already used by a ${clash}`);
  const res = run('INSERT INTO containers (barcode, name, location, notes, created_at) VALUES (?, ?, ?, ?, ?)',
    barcode, name, str(data.location), str(data.notes), nowIso());
  const container = getContainer(Number(res.lastInsertRowid));
  logEvent({ action: 'container_created', container, detail: `Container "${name}" created` });
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
  run('UPDATE containers SET barcode=?, name=?, location=?, notes=? WHERE id=?',
    barcode, name, str(merged.location), str(merged.notes), id);
  return getContainer(id);
}

export function deleteContainer(id) {
  const container = getContainer(id);
  if (!container) throw new HttpError(404, 'Container not found');
  tx(() => {
    run('UPDATE items SET container_id = NULL WHERE container_id = ?', id); // contents go back to loose stock
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

// Starting values for the "print label" form. If everything out of this case belongs to one rental, its client, event
// name and start date are filled in; the contents are the items currently in the case, counted by description.
export function labelDefaults(id) {
  const { container, items } = containerDetail(id);
  const rentalIds = [...new Set(items.filter((i) => i.status === 'on_rental' && i.rental_id).map((i) => i.rental_id))];
  const rental = rentalIds.length === 1 ? get('SELECT * FROM rentals WHERE id = ?', rentalIds[0]) : null;
  return {
    client: rental?.customer || '',
    event: rental?.name || '',
    date: rental?.start_date || today(),
    box: '',
    contents: contentsLines(items).join('\n'),
    name: container.name,
    barcode: container.barcode,
  };
}
