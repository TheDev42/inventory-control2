import { all, get, today } from './db.js';
import { itemSelect, patCase } from './items.js';
import { parseOwner } from './catalog.js';

export function dashboard() {
  const t = today();
  const totals = get(
    `SELECT COUNT(*) AS total,
       SUM(status = 'in_stock') AS in_stock,
       SUM(status = 'on_rental') AS on_rental,
       SUM(status = 'lost') AS lost,
       SUM(status = 'disassembled') AS disassembled,
       SUM(status = 'repair') AS repair,
       SUM(status = 'sold') AS sold,
       SUM(container_id IS NOT NULL) AS in_containers
     FROM items`
  );
  for (const k of Object.keys(totals)) totals[k] = totals[k] || 0;
  totals.containers = get('SELECT COUNT(*) AS n FROM containers').n;

  const byType = all(
    `SELECT category, type, COUNT(*) AS total,
       SUM(status = 'in_stock') AS in_stock, SUM(status = 'on_rental') AS on_rental,
       SUM(status = 'repair') AS repair, SUM(status = 'lost') AS lost, SUM(status = 'disassembled') AS disassembled, SUM(status = 'sold') AS sold
     FROM items GROUP BY category, type ORDER BY category, type`
  );

  const patRows = all(`SELECT ${patCase()} AS s, COUNT(*) AS n FROM items i WHERE i.status != 'sold' GROUP BY s`);
  const pat = { ok: 0, due_soon: 0, overdue: 0, failed: 0, never: 0, na: 0 };
  for (const r of patRows) pat[r.s] = r.n;

  const activeRentals = all(
    `SELECT r.*,
       (SELECT COUNT(*) FROM rental_items ri JOIN items i ON i.id = ri.item_id
          WHERE ri.rental_id = r.id AND ri.outcome IS NULL AND i.status = 'on_rental') AS out_count,
       (SELECT COUNT(*) FROM rental_items ri WHERE ri.rental_id = r.id) AS total_count
     FROM rentals r WHERE r.status = 'active'
     ORDER BY (r.end_date IS NULL), r.end_date, r.id DESC LIMIT 12`
  ).map((r) => ({ ...r, overdue: !!r.end_date && r.end_date < t }));

  const attention = all(
    `${itemSelect()} WHERE i.status IN ('lost','repair','disassembled') ORDER BY i.updated_at DESC LIMIT 10`
  );
  const patAttention = all(
    `${itemSelect()} WHERE ${patCase()} IN ('overdue','failed') ORDER BY i.next_pat_due LIMIT 8`
  );
  const activity = all('SELECT * FROM events ORDER BY id DESC LIMIT 15');

  return { totals, byType, pat, activeRentals, attention, patAttention, activity, today: t };
}

// Stock overview: everything you own, grouped by identical details (same category, type, description, connectors and
// length; capitals and stray spaces don't count as a difference), with how many there are and how many are available
// (in stock). Sold items are no longer yours, so they are left out. Each group is labelled with its most common spelling.
export function overview(ownerFilter) {
  const owner = ownerFilter ? parseOwner(ownerFilter) : null;
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const rows = all(
    `SELECT category, type, name, male_connector, female_connector, input_connector, outputs, length_m, status, owner
     FROM items WHERE status != 'sold' ${owner ? 'AND owner = ?' : ''} ORDER BY id`,
    ...(owner ? [owner] : [])
  );
  const groups = new Map();
  for (const r of rows) {
    const key = [r.category, r.type, norm(r.name), norm(r.male_connector), norm(r.female_connector), norm(r.input_connector), r.outputs ?? '', r.length_m ?? ''].join('\u0001');
    let g = groups.get(key);
    if (!g) {
      g = { category: r.category, type: r.type, outputs: r.outputs, length_m: r.length_m, personal: 0, total: 0, available: 0, on_rental: 0, repair: 0, lost: 0, disassembled: 0, spellings: {} };
      groups.set(key, g);
    }
    g.total++;
    if (r.owner === 'personal') g.personal++;
    if (r.status === 'in_stock') g.available++;
    else if (g[r.status] !== undefined) g[r.status]++;
    for (const f of ['name', 'male_connector', 'female_connector', 'input_connector']) {
      const v = String(r[f] ?? '').trim();
      if (v) { g.spellings[f] ??= new Map(); g.spellings[f].set(v, (g.spellings[f].get(v) || 0) + 1); }
    }
  }
  const commonest = (m) => (m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : null); // ties: the first one seen
  const list = [...groups.values()].map(({ spellings, ...g }) => ({
    ...g,
    name: commonest(spellings.name), male_connector: commonest(spellings.male_connector),
    female_connector: commonest(spellings.female_connector), input_connector: commonest(spellings.input_connector),
  }));
  const cmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true, sensitivity: 'base' });
  list.sort((a, b) => cmp(a.category, b.category) || cmp(a.type, b.type) || cmp(a.name, b.name) ||
    cmp(a.male_connector, b.male_connector) || cmp(a.female_connector, b.female_connector) || (a.length_m ?? 0) - (b.length_m ?? 0));
  const totals = { kinds: list.length, total: 0, available: 0, on_rental: 0, repair: 0, lost: 0, disassembled: 0 };
  for (const g of list) for (const k of Object.keys(totals)) if (k !== 'kinds') totals[k] += g[k];
  return { groups: list, totals, sold: get(`SELECT COUNT(*) AS n FROM items WHERE status = 'sold'`).n };
}
