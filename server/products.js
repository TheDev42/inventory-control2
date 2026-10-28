/* Products: a product is a group of identical items — the same "kind" the Stock overview, the hire site and kit
   requirements already group by (category, type, description, connectors, length; see catalog.js kindKey).
   Nothing extra is stored for one: it exists while at least one item has those details, and its picture and
   wording are the hire site's ones for that kind. */
import { all, get, run, tx, logEvent, HttpError } from './db.js';
import { kindKey, cap } from './catalog.js';
import { itemSelect, cleanItem, updateItem } from './items.js';
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

// Every item of a product (sold ones included), in barcode order
function productItems(key) {
  if (!/^[a-f0-9]{16}$/.test(String(key))) throw new HttpError(400, 'Invalid product');
  // kindKey always includes the category and type, so only items of the right type need hashing
  const any = all('SELECT * FROM items ORDER BY id').find((r) => kindKey(r) === key);
  if (!any) throw new HttpError(404, 'No items of this product are left');
  return all(`${itemSelect()} WHERE i.category = ? AND i.type = ? ORDER BY i.barcode COLLATE NOCASE`, any.category, any.type)
    .filter((it) => kindKey(it) === key);
}

export function productDetail(key) {
  const items = productItems(key);
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

/* ---------- editing a product: the change is made to every item of it ---------- */

// What can be edited on a product, and the item columns behind each. 'second' is the second category + type together.
const EDIT_FIELDS = {
  category: ['category'], type: ['type'], second: ['category2', 'type2'], name: ['name'],
  male_connector: ['male_connector'], female_connector: ['female_connector'], input_connector: ['input_connector'],
  outputs: ['outputs'], length_m: ['length_m'], pat_required: ['pat_required'], pat_interval_months: ['pat_interval_months'],
  cost: ['cost'], weight_kg: ['weight_kg'], power_w: ['power_w'],
};
const NUMERIC = new Set(['length_m', 'pat_interval_months', 'cost', 'weight_kg', 'power_w']);

// One comparable value per field: numbers as numbers, text ignoring capitals and stray spaces (the way products are grouped)
function valueOf(field, it) {
  if (field === 'second') return it.category2 && it.type2 ? `${it.category2}/${it.type2}`.toLowerCase() : null;
  if (field === 'pat_required') return it.pat_required ? 1 : 0;
  const v = it[field];
  if (v === undefined || v === null || v === '') return null;
  if (NUMERIC.has(field)) return Number(v);
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}
// How a value is shown in a conflict question (the stored spelling, not the comparable one)
const shownValue = (field, it) => (field === 'second' ? (it.category2 ? `${it.category2} ${it.type2}` : null) : it[field] ?? null);

// Point the hire site's picture / wording / combined item, and rental kit requirements, at the product's new key.
// When the product is merged into one that already has its own picture or wording, that one's are kept.
function moveKind(oldKey, newKey) {
  if (!get(`SELECT 1 AS x FROM hire_meta WHERE scope = 'type' AND key = ?`, newKey)) run(`UPDATE hire_meta SET key = ? WHERE scope = 'type' AND key = ?`, newKey, oldKey);
  if (!get('SELECT 1 AS x FROM hire_images WHERE key = ?', newKey)) run('UPDATE hire_images SET key = ? WHERE key = ?', newKey, oldKey);
  if (!get('SELECT 1 AS x FROM hire_group_members WHERE kind_key = ?', newKey)) run('UPDATE hire_group_members SET kind_key = ? WHERE kind_key = ?', newKey, oldKey);
  else run('DELETE FROM hire_group_members WHERE kind_key = ?', oldKey);
  run('UPDATE rental_requirements SET kind_key = ? WHERE kind_key = ?', newKey, oldKey);
  for (const r of all(`SELECT id, member_keys FROM rental_requirements WHERE member_keys LIKE ?`, `%${oldKey}%`)) {
    try {
      const keys = [...new Set(JSON.parse(r.member_keys).map((k) => (k === oldKey ? newKey : k)))];
      run('UPDATE rental_requirements SET member_keys = ? WHERE id = ?', JSON.stringify(keys), r.id);
    } catch { /* not JSON: leave it */ }
  }
}

// body: { fields: the edited details, resolutions: { field: 'all' | 'matching' | 'skip' }, merge: true }
// Only fields that were actually changed (compared with the details the page showed) are written. When items of the
// product don't all have the value being replaced, or the new details make it the same as another product, nothing is
// saved: a 409 comes back listing the `conflicts` (and/or `merge`) so the user can say what to do, then send it again.
export function updateProduct(key, { fields = {}, resolutions = {}, merge = false } = {}) {
  const items = productItems(key);
  const template = summarise(key, items).template;
  // both cleaned the same way as an item save, so "changed" means what would actually be stored differs
  const before = cleanItem({ ...template, barcode: 'x' });
  const after = cleanItem({ ...template, ...fields, barcode: 'x' });
  const changed = Object.keys(EDIT_FIELDS).filter((f) => valueOf(f, before) !== valueOf(f, after));
  if (!changed.length) throw new HttpError(400, 'Nothing has been changed');

  const conflicts = [];
  for (const f of changed) {
    const differ = items.filter((it) => valueOf(f, it) !== valueOf(f, before));
    if (!differ.length || ['all', 'matching', 'skip'].includes(resolutions[f])) continue;
    const counts = new Map();
    for (const it of items) {
      const v = shownValue(f, it);
      const k = JSON.stringify(v);
      counts.set(k, { value: v, count: (counts.get(k)?.count || 0) + 1 });
    }
    conflicts.push({
      field: f, from: shownValue(f, before), to: shownValue(f, after),
      matching: items.length - differ.length, total: items.length,
      values: [...counts.values()].sort((a, b) => b.count - a.count),
    });
  }
  const newKey = kindKey(after);
  let mergeInto = null;
  if (newKey !== key) {
    const others = all('SELECT * FROM items WHERE category = ? AND type = ?', after.category, after.type).filter((r) => kindKey(r) === newKey);
    if (others.length) mergeInto = { key: newKey, label: summarise(newKey, others).label, count: others.length };
  }
  if (conflicts.length || (mergeInto && !merge)) {
    const err = new HttpError(409, 'Some of the items are not all the same — choose what to do');
    err.details = { conflicts, merge: mergeInto };
    throw err;
  }

  let updated = 0;
  tx(() => {
    for (const it of items) {
      const patch = {};
      for (const f of changed) {
        const how = resolutions[f] || 'all';
        if (how === 'skip' || (how === 'matching' && valueOf(f, it) !== valueOf(f, before))) continue;
        for (const col of EDIT_FIELDS[f]) patch[col] = after[col];
      }
      if (Object.keys(patch).length) { updateItem(it.id, patch); updated++; }
    }
    if (newKey !== key) moveKind(key, newKey);
    logEvent({ action: 'product_edited', detail: `Product "${summarise(key, items).label}" edited: ${changed.join(', ').replace(/_/g, ' ')} on ${updated} item(s)${mergeInto ? `, merged into "${mergeInto.label}"` : ''}` });
  });
  return { key: newKey, updated, merged: !!mergeInto };
}
