import { all, get, run, tx, nowIso, logEvent, HttpError } from './db.js';
import { STATUS_LABEL, normalizeBarcode } from './catalog.js';
import {
  itemSelect, getItem, getItemByBarcode, getContainerByBarcode, describeItem,
  returnItem, recordPat,
} from './items.js';
import { getRental, checkout } from './rentals.js';

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

  const contents = all(`${itemSelect()} WHERE i.container_id = ? ORDER BY i.barcode`, container.id);
  if (!contents.length) return result('warn', `${container.name} is empty`, { container });
  let added = 0;
  const problems = [];
  let warned = 0;
  for (const it of contents) {
    const r = checkout(it, rental, true);
    if (r.state === 'added') { added++; if (r.warning) warned++; }
    else if (r.state !== 'duplicate') problems.push(`${it.barcode} ${r.text}`);
  }
  const skipped = problems.length ? ` — ${problems.length} skipped: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}` : '';
  if (!added) return result('error', `Nothing added from ${container.name}${skipped || ' (all already on this rental)'}`, { container });
  const pat = warned ? ` ⚠ ${warned} with PAT due/overdue` : '';
  return result(problems.length || warned ? 'out_warn' : 'out',
    `OUT → ${rental.name}: ${added} item(s) from ${container.name}${pat}${skipped}`, { container, rentalId: rental.id });
}

/* ---------- return (works on any page, no rental needed) ---------- */

function scanReturn(item, container) {
  if (item) {
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
  const out = all(`${itemSelect()} WHERE i.container_id = ? AND i.status IN ('on_rental','lost','disassembled')`, container.id);
  if (!out.length) return result('warn', `Nothing to return from ${container.name}`, { container });
  for (const it of out) returnItem(it);
  return result('return', `RETURNED: ${out.length} item(s) from ${container.name}`, { container });
}

/* ---------- store in container ---------- */

function scanStore(item, scannedContainer, { containerId }) {
  if (scannedContainer) {
    // Scanning a container while in Store mode simply switches the target container.
    return result('lookup', `Now storing into ${scannedContainer.name}`, { container: scannedContainer, setContainerId: scannedContainer.id });
  }
  if (!containerId) return result('error', 'No container selected — pick one in the scan bar or scan its barcode first');
  const container = get('SELECT * FROM containers WHERE id = ?', containerId);
  if (!container) return result('error', 'Container not found');

  if (item.status === 'on_rental') {
    return result('error', `${item.barcode} is out on "${item.rental_name}" — return it first`, { item });
  }
  const wasMissing = item.status === 'lost' || item.status === 'disassembled';
  if (!wasMissing && item.container_id === container.id) {
    return result('warn', `${item.barcode} is already in ${container.name}`, { item });
  }
  if (wasMissing) {
    returnItem(item, `Found and stored in ${container.name} (was ${STATUS_LABEL[item.status]})`);
  }
  const from = !wasMissing && item.container_name ? ` (moved from ${item.container_name})` : '';
  tx(() => {
    run('UPDATE items SET container_id = ?, updated_at = ? WHERE id = ?', container.id, nowIso(), item.id);
    logEvent({ action: 'stored', item, container, detail: `Stored in ${container.name}${from}` });
  });
  const fresh = getItem(item.id);
  return result(wasMissing ? 'found' : 'store',
    `${wasMissing ? `FOUND (was ${STATUS_LABEL[item.status].toUpperCase()}) → ` : 'STORED → '}${container.name}: ${item.barcode} (${describeItem(item)})${from}`,
    { item: fresh, container });
}

/* ---------- PAT ---------- */

function scanPat(item, container, { patResult, tester }) {
  if (container) return result('error', 'Containers are not PAT tested — scan an item');
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
