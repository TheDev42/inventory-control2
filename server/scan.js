import { all, get, run, tx, nowIso, logEvent, HttpError } from './db.js';
import { STATUS_LABEL, normalizeBarcode } from './catalog.js';
import {
  itemSelect, getItem, getItemByBarcode, getContainerByBarcode, describeItem,
  returnItem, recordPat,
} from './items.js';
import { getRental, checkout, attachCase, packItems, caseRental } from './rentals.js';

/*
 * One endpoint handles every scan. The client sends the barcode plus the current mode, and gets back a
 * `tone` (which sound to play) and a human message. Domain outcomes (blocked, unknown, duplicate) are
 * normal 200 responses so the UI can play the right tone; only malformed requests are HTTP errors.
 */

const result = (tone, message, extra = {}) => ({
  ok: tone !== 'error' && tone !== 'unknown',
  tone,
  message,
  ...extra,
});

/* ---------- check out (add to rental) lives in rentals.js so the manual picker shares the same rules ---------- */

function scanOut(item, container, { rentalId }) {
  if (!rentalId) return result('error', 'No rental selected — open a rental (or pick one in the scan bar) to scan items out');
  const rental = getRental(rentalId);
  if (!rental) return result('error', 'Rental not found');
  if (rental.status !== 'active') return result('error', `"${rental.name}" is completed — reopen it to add items`);

  if (item) {
    const r = checkout(item, rental, false);
    const fresh = getItem(item.id);
    if (r.state === 'added') {
      return result(r.warning ? 'out_warn' : 'out',
        `OUT → ${rental.name}: ${item.barcode} (${describeItem(item)})${r.warning ? ` ⚠ ${r.warning}` : ''}`,
        { item: fresh, rentalId: rental.id });
    }
    if (r.state === 'duplicate') return result('warn', `${item.barcode} is ${r.text}`, { item: fresh });
    return result('error', `${item.barcode} is ${r.text}`, { item: fresh });
  }

  // The case itself goes on the rental, and whatever is stored in it goes out packed into it (so the shipment list shows "in case X")
  if (container.closed_at) return result('error', `${container.name} is closed — it cannot go out again`, { container });
  const { total, added, warned, problems } = attachCase(rental.id, container.id);
  if (!total) {
    return result('out', `OUT → ${rental.name}: case ${container.name} (empty — anything you scan into it now goes onto this rental too)`, { container, rentalId: rental.id });
  }
  const skipped = problems.length ? ` — ${problems.length} skipped: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}` : '';
  if (!added) return result(problems.length ? 'error' : 'warn', `Nothing new from ${container.name}${skipped || ' (all its items were already on this rental)'}`, { container, rentalId: rental.id });
  const pat = warned ? ` ⚠ ${warned} with PAT due/overdue` : '';
  return result(problems.length || warned ? 'out_warn' : 'out',
    `OUT → ${rental.name}: ${added} item(s) from ${container.name}${pat}${skipped}`, { container, rentalId: rental.id });
}

/* ---------- return (works on any page, no rental needed) ---------- */

const soldBlock = (item) => result('error', `${item.barcode} is SOLD — sold items cannot be scanned (undo the sale from its item page if this was a mistake)`, { item });

function scanReturn(item, container) {
  if (item) {
    if (item.status === 'sold') return soldBlock(item);
    if (item.status === 'on_rental') {
      const back = returnItem(item);
      return result('return', `RETURNED: ${item.barcode} (${describeItem(item)}) from ${item.rental_name}`, { item: back });
    }
    if (item.status === 'lost' || item.status === 'disassembled') {
      const back = returnItem(item);
      return result('found', `RESTORED: ${item.barcode} was ${STATUS_LABEL[item.status].toUpperCase()} — back in active inventory`, { item: back });
    }
    if (item.status === 'repair') {
      return result('warn', `${item.barcode} is marked REPAIR — restore it from its item page once fixed`, { item });
    }
    return result('warn', `${item.barcode} is already in stock`, { item });
  }
  // A case scanned back is just the case: it does NOT bring its items back. Every item is scanned in on its own.
  const wasOut = all(
    `SELECT rc.id, r.name AS rental_name FROM rental_cases rc JOIN rentals r ON r.id = rc.rental_id
     WHERE rc.container_id = ? AND rc.returned_at IS NULL`, container.id);
  const stillOut = all(
    `${itemSelect()} WHERE i.status = 'on_rental'
       AND (i.container_id = ? OR i.id IN (SELECT item_id FROM rental_items WHERE case_id = ? AND outcome IS NULL))
     ORDER BY i.barcode`, container.id, container.id);
  if (wasOut.length) {
    run('UPDATE rental_cases SET returned_at = ? WHERE container_id = ? AND returned_at IS NULL', nowIso(), container.id);
    logEvent({ action: 'case_back', container, detail: `Case ${container.name} scanned back${stillOut.length ? ` — ${stillOut.length} item(s) still to scan in` : ''}` });
  }
  if (stillOut.length) {
    const some = stillOut.slice(0, 4).map((it) => it.barcode).join(', ') + (stillOut.length > 4 ? '…' : '');
    return result('warn', `CASE BACK: ${container.name} — ${stillOut.length} item(s) still out (${some}). Scan each item individually to return it`, { container });
  }
  if (!wasOut.length) return result('warn', `${container.name} scanned back, but it was not out on a rental`, { container });
  return result('return', `CASE BACK: ${container.name} — nothing from it is still out`, { container });
}

/* ---------- store in container ---------- */

function scanStore(item, scannedContainer, { containerId }) {
  if (scannedContainer) {
    if (scannedContainer.closed_at) return result('error', `${scannedContainer.name} is closed — nothing more can go in it`, { container: scannedContainer });
    // Scanning a container while in Store mode simply switches the target container.
    return result('lookup', `Now storing into ${scannedContainer.name}`, { container: scannedContainer, setContainerId: scannedContainer.id });
  }
  if (item.status === 'sold') return soldBlock(item);
  if (!containerId) return result('error', 'No container selected — pick one in the scan bar or scan its barcode first');
  const container = get('SELECT * FROM containers WHERE id = ?', containerId);
  if (!container) return result('error', 'Container not found');
  if (container.closed_at) return result('error', `${container.name} is closed — nothing more can go in it`);

  // A case that has been added to a rental takes whatever is scanned into it onto that rental as well
  const rental = caseRental(container.id);

  if (item.status === 'on_rental') {
    if (!rental || item.rental_id !== rental.id) return result('error', `${item.barcode} is out on "${item.rental_name}" — return it first`, { item });
    // already on the case's own rental: this just packs it into the case
    if (item.container_id === container.id) return result('warn', `${item.barcode} is already in ${container.name}`, { item });
    tx(() => {
      run('UPDATE items SET container_id = ?, updated_at = ? WHERE id = ?', container.id, nowIso(), item.id);
      packItems(rental.id, [item.id], container.id);
      logEvent({ action: 'stored', item, container, rental, detail: `Packed into ${container.name} for "${rental.name}"` });
    });
    return result('store', `PACKED → ${container.name}: ${item.barcode} (${describeItem(item)}) — already on ${rental.name}`, { item: getItem(item.id), container });
  }
  const wasMissing = item.status === 'lost' || item.status === 'disassembled';
  if (!wasMissing && item.container_id === container.id) {
    return result('warn', `${item.barcode} is already in ${container.name}`, { item });
  }
  if (wasMissing) {
    returnItem(item, `Found and stored in ${container.name} (was ${STATUS_LABEL[item.status]})`);
  }
  const from = !wasMissing && item.container_name ? ` (moved from ${item.container_name})` : '';
  let out = null;
  tx(() => {
    run('UPDATE items SET container_id = ?, updated_at = ? WHERE id = ?', container.id, nowIso(), item.id);
    logEvent({ action: 'stored', item, container, detail: `Stored in ${container.name}${from}` });
    if (rental) {
      out = checkout(getItem(item.id), rental, true);
      if (out.state === 'added') packItems(rental.id, [item.id], container.id);
    }
  });
  const fresh = getItem(item.id);
  const msg = `${wasMissing ? `FOUND (was ${STATUS_LABEL[item.status].toUpperCase()}) → ` : 'STORED → '}${container.name}: ${item.barcode} (${describeItem(item)})${from}`;
  if (out?.state === 'added') {
    return result(out.warning ? 'out_warn' : 'out', `${msg} — OUT on ${rental.name}${out.warning ? ` ⚠ ${out.warning}` : ''}`, { item: fresh, container, rentalId: rental.id });
  }
  if (out) return result('warn', `${msg} — but NOT added to ${rental.name}: ${out.text}`, { item: fresh, container });
  return result(wasMissing ? 'found' : 'store', msg, { item: fresh, container });
}

/* ---------- PAT ---------- */

function scanPat(item, container, { patResult, tester }) {
  if (container) return result('error', 'Containers are not PAT tested — scan an item');
  if (item.status === 'sold') return soldBlock(item);
  const res = patResult === 'fail' ? 'fail' : 'pass';
  const fresh = recordPat(item.id, { result: res, tester });
  return result(res === 'pass' ? 'pat_pass' : 'pat_fail',
    `PAT ${res.toUpperCase()}: ${item.barcode} (${describeItem(item)})${res === 'pass' ? ` — next due ${fresh.next_pat_due}` : ' — moved to repair'}`,
    { item: fresh });
}

/* ---------- entry point ---------- */

export function handleScan(body) {
  const barcode = normalizeBarcode(body?.barcode);
  if (!barcode) throw new HttpError(400, 'No barcode supplied');
  const mode = body.mode || 'lookup';
  if (!['lookup', 'out', 'return', 'store', 'pat'].includes(mode)) throw new HttpError(400, `Unknown mode "${mode}"`);

  const item = getItemByBarcode(barcode);
  const container = item ? null : getContainerByBarcode(barcode);
  if (!item && !container) {
    return result('unknown', `Unknown barcode ${barcode}`, { unknown: true, barcode });
  }

  const ctx = {
    rentalId: body.rentalId ? Number(body.rentalId) : null,
    containerId: body.containerId ? Number(body.containerId) : null,
    patResult: body.patResult,
    tester: body.tester,
  };

  let out;
  switch (mode) {
    case 'out': out = scanOut(item, container, ctx); break;
    case 'return': out = scanReturn(item, container); break;
    case 'store': out = scanStore(item, container, ctx); break;
    case 'pat': out = scanPat(item, container, ctx); break;
    default:
      out = item
        ? result('lookup', `${item.barcode}: ${describeItem(item)} — ${STATUS_LABEL[item.status]}`, { item, navigate: `/items/${item.id}` })
        : result('lookup', `${container.name} (${container.barcode})`, { container, navigate: `/containers/${container.id}` });
  }
  return { barcode, mode, ...out };
}
