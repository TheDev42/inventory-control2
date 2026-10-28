/* Products: a product is a group of identical items — the same "kind" the Stock overview, the hire site and kit
   requirements already group by (category, type, description, connectors, length; see catalog.js kindKey).
   Nothing extra is stored for one: it exists while at least one item has those details, and its picture and
   wording are the hire site's ones for that kind. */
import { all, get, HttpError } from './db.js';
import { kindKey, cap } from './catalog.js';
import { itemSelect } from './items.js';
import { detailLine, groupKey } from './hire.js';

// What a new item of the product starts with: everything that describes the kit, nothing about one particular unit
const TEMPLATE_FIELDS = [
  'category', 'type', 'category2', 'type2', 'name', 'male_connector', 'female_connector', 'input_connector', 'outputs',
  'length_m', 'pat_required', 'pat_interval_months', 'cost', 'weight_kg', 'power_w',
];

const cmpStr = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true, sensitivity: 'base' });

function groupRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = kindKey(r);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

// The newest item that hasn't been sold stands in for the product: its details are the ones a new one is given
function summarise(key, rows) {
  const live = rows.filter((r) => r.status !== 'sold');
  const tpl = (live.length ? live : rows).reduce((a, b) => (b.id > a.id ? b : a));
  const template = Object.fromEntries(TEMPLATE_FIELDS.map((f) => [f, tpl[f] ?? null]));
  const counts = { total: live.length, in_stock: 0, on_rental: 0, repair: 0, lost: 0, disassembled: 0, sold: rows.length - live.length };
  for (const r of live) if (counts[r.status] !== undefined) counts[r.status]++;
  return {
    key,
    label: template.name || `${cap(template.category)} ${template.type}`,
    details: detailLine(template),
    template,
    counts,
  };
}

// Every product, for the "Product" pick-list on the add and bulk add forms
export function listProducts() {
  const groups = groupRows(all('SELECT * FROM items ORDER BY id'));
  return [...groups.entries()].map(([key, rows]) => summarise(key, rows)).sort((a, b) =>
    cmpStr(a.template.category, b.template.category) || cmpStr(a.template.type, b.template.type) ||
    cmpStr(a.label, b.label) || (a.template.length_m ?? 0) - (b.template.length_m ?? 0));
}

// Lowest and highest of a number across the product's items, and how many have none recorded
function spread(rows, field) {
  const vals = rows.map((r) => r[field]).filter((v) => v != null);
  return { min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null, missing: rows.length - vals.length };
}

export function productDetail(key) {
  if (!/^[a-f0-9]{16}$/.test(String(key))) throw new HttpError(400, 'Invalid product');
  // kindKey always includes the category and type, so only items of the right type need hashing
  const any = all('SELECT * FROM items ORDER BY id').find((r) => kindKey(r) === key);
  if (!any) throw new HttpError(404, 'No items of this product are left');
  const items = all(`${itemSelect()} WHERE i.category = ? AND i.type = ? ORDER BY i.barcode COLLATE NOCASE`, any.category, any.type)
    .filter((it) => kindKey(it) === key);
  const product = summarise(key, items);
  const live = items.filter((it) => it.status !== 'sold');

  // The hire site's picture and wording for it: its own, or (when it is listed as part of a combined item) the combined item's
  const meta = (k) => get(`SELECT label, about, image IS NOT NULL AS has_image, updated_at FROM hire_meta WHERE scope = 'type' AND key = ?`, k);
  const own = meta(key);
  const combined = get('SELECT g.id, g.name FROM hire_group_members m JOIN hire_groups g ON g.id = m.group_id WHERE m.kind_key = ?', key);
  const groupMeta = combined ? meta(groupKey(combined.id)) : null;
  const image = own?.has_image ? { key, v: own.updated_at }
    : groupMeta?.has_image ? { key: groupKey(combined.id), v: groupMeta.updated_at, combined: true } : null;

  return {
    product,
    items,
    image,
    hire: {
      label: own?.label || null,
      about: own?.about || groupMeta?.about || null,
      combined: combined ? { key: groupKey(combined.id), name: combined.name } : null,
    },
    spread: { weight_kg: spread(live, 'weight_kg'), power_w: spread(live, 'power_w'), cost: spread(live, 'cost') },
  };
}
