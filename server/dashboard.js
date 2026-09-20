import { all, get, today } from './db.js';
import { itemSelect, patCase } from './items.js';

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
