/* The categories (POWER, LIGHTING, …) and the sub-categories — "types" — inside each one (cable, distro, …).
   They live in the database so they can be added from the Categories page; catalog.js only supplies the
   starting set a brand-new database is seeded with. */
import { all, get, run, tx, db, HttpError } from './db.js';
import { CATALOG, CONNECTOR_TYPES, OUTPUT_TYPES } from './catalog.js';

db.exec(`
CREATE TABLE IF NOT EXISTS catalog_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

-- fields: which extra boxes an item of this type gets — 'ends' (male + female connector),
-- 'outputs' (one input connector + a list of outputs, like a distro) or 'none'.
CREATE TABLE IF NOT EXISTS catalog_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL REFERENCES catalog_categories(name) ON DELETE CASCADE,
  type TEXT NOT NULL,
  fields TEXT NOT NULL DEFAULT 'none',
  UNIQUE (category, type)
);
`);

export const FIELD_KINDS = ['none', 'ends', 'outputs'];
const defaultFields = (type) => (CONNECTOR_TYPES.has(type) ? 'ends' : OUTPUT_TYPES.has(type) ? 'outputs' : 'none');

// First run: start from the built-in set. Anything already on an item (an older database) is kept usable too.
if (!get('SELECT 1 AS x FROM catalog_categories LIMIT 1')) {
  tx(() => {
    const pairs = Object.entries(CATALOG).flatMap(([c, types]) => types.map((t) => [c, t]));
    for (const r of all('SELECT DISTINCT category, type FROM items ORDER BY category, type')) pairs.push([r.category, r.type]);
    for (const c of Object.keys(CATALOG)) run('INSERT OR IGNORE INTO catalog_categories (name) VALUES (?)', c);
    for (const [c, t] of pairs) {
      run('INSERT OR IGNORE INTO catalog_categories (name) VALUES (?)', c);
      run('INSERT OR IGNORE INTO catalog_types (category, type, fields) VALUES (?, ?, ?)', c, t, defaultFields(t));
    }
  });
}

// { POWER: ['cable', 'adapter', …], … } in the order they were made
export function getCatalog() {
  const out = {};
  for (const c of all('SELECT name FROM catalog_categories ORDER BY id')) out[c.name] = [];
  for (const t of all('SELECT category, type FROM catalog_types ORDER BY id')) out[t.category]?.push(t.type);
  return out;
}

export const categoryOrder = () => all('SELECT name FROM catalog_categories ORDER BY id').map((c) => c.name);

// 'ends' | 'outputs' | 'none' for a known category/type pair, or null when the pair doesn't exist
export const fieldsFor = (category, type) =>
  get('SELECT fields FROM catalog_types WHERE category = ? AND type = ?', category, type)?.fields ?? null;

// { 'POWER/cable': 'ends', … } — sent to the browser so the item form knows which boxes to show
export const typeFieldsMap = () =>
  Object.fromEntries(all('SELECT category, type, fields FROM catalog_types').map((t) => [`${t.category}/${t.type}`, t.fields]));

// The Categories page: every category and sub-category with how many items use it
export function listCategories() {
  const counts = new Map(all('SELECT category, type, COUNT(*) AS n FROM items GROUP BY category, type').map((r) => [`${r.category}/${r.type}`, r.n]));
  const types = all('SELECT category, type, fields FROM catalog_types ORDER BY id');
  return all('SELECT name FROM catalog_categories ORDER BY id').map((c) => {
    const list = types.filter((t) => t.category === c.name)
      .map((t) => ({ type: t.type, fields: t.fields, items: counts.get(`${c.name}/${t.type}`) || 0 }));
    return { name: c.name, types: list, items: list.reduce((n, t) => n + t.items, 0) };
  });
}

function cleanName(value, what) {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!s) throw new HttpError(400, `${what} name is required`);
  if (s.length > 30) throw new HttpError(400, `${what} name is too long (max 30 characters)`);
  if (!/^[a-z0-9][a-z0-9 &+\-]*$/i.test(s)) throw new HttpError(400, `${what} names can only use letters, numbers, spaces, & + and -`);
  return s;
}
// Categories are stored in capitals and sub-categories in lower case, the same as the built-in ones
const categoryName = (v) => cleanName(v, 'Category').toUpperCase();
const typeName = (v) => cleanName(v, 'Sub-category').toLowerCase();

function mustExist(category) {
  if (!get('SELECT 1 AS x FROM catalog_categories WHERE name = ?', category)) throw new HttpError(404, `Category "${category}" not found`);
}

export function addCategory(d) {
  const name = categoryName(d.name);
  if (get('SELECT 1 AS x FROM catalog_categories WHERE name = ?', name)) throw new HttpError(409, `Category ${name} already exists`);
  run('INSERT INTO catalog_categories (name) VALUES (?)', name);
  return listCategories();
}

export function addType(categoryRaw, d) {
  const category = String(categoryRaw ?? '').trim().toUpperCase();
  mustExist(category);
  const type = typeName(d.name);
  const fields = d.fields === undefined || d.fields === '' ? defaultFields(type) : String(d.fields);
  if (!FIELD_KINDS.includes(fields)) throw new HttpError(400, `Invalid connector option "${d.fields}"`);
  if (fieldsFor(category, type)) throw new HttpError(409, `${category} already has a sub-category called ${type}`);
  run('INSERT INTO catalog_types (category, type, fields) VALUES (?, ?, ?)', category, type, fields);
  return listCategories();
}

// Only something no item uses can be removed, so no item is ever left pointing at a category that is gone
export function deleteType(categoryRaw, typeRaw) {
  const category = String(categoryRaw ?? '').trim().toUpperCase();
  const type = String(typeRaw ?? '').trim().toLowerCase();
  if (!fieldsFor(category, type)) throw new HttpError(404, 'Sub-category not found');
  const used = get('SELECT COUNT(*) AS n FROM items WHERE category = ? AND type = ?', category, type).n;
  if (used) throw new HttpError(409, `${used} item${used === 1 ? ' is' : 's are'} still in ${category} ${type} — move or delete ${used === 1 ? 'it' : 'them'} first`);
  run('DELETE FROM catalog_types WHERE category = ? AND type = ?', category, type);
  return listCategories();
}

export function deleteCategory(categoryRaw) {
  const category = String(categoryRaw ?? '').trim().toUpperCase();
  mustExist(category);
  const used = get('SELECT COUNT(*) AS n FROM items WHERE category = ?', category).n;
  if (used) throw new HttpError(409, `${used} item${used === 1 ? ' is' : 's are'} still in ${category} — move or delete ${used === 1 ? 'it' : 'them'} first`);
  tx(() => {
    run('DELETE FROM catalog_types WHERE category = ?', category);
    run('DELETE FROM catalog_categories WHERE name = ?', category);
  });
  return listCategories();
}
