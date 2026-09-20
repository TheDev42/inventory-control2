import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Default: the "data" folder in the project root (next to package.json), wherever the server is started from.
// Docker sets DATA_DIR=/data, which docker-compose.yml maps to that same folder.
const dataDir = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
export const DATA_DIR = dataDir;
export const DB_PATH = path.join(dataDir, 'inventory.db');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS containers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  location TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rentals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  customer TEXT,
  start_date TEXT,
  end_date TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode TEXT NOT NULL UNIQUE COLLATE NOCASE,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT,
  male_connector TEXT,
  female_connector TEXT,
  length_m REAL,
  status TEXT NOT NULL DEFAULT 'in_stock',
  rental_id INTEGER REFERENCES rentals(id),
  container_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
  pat_required INTEGER NOT NULL DEFAULT 1,
  pat_interval_months INTEGER NOT NULL DEFAULT 12,
  last_pat_date TEXT,
  last_pat_result TEXT,
  next_pat_due TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_cat_type ON items(category, type);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_rental ON items(rental_id);
CREATE INDEX IF NOT EXISTS idx_items_container ON items(container_id);

CREATE TABLE IF NOT EXISTS rental_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rental_id INTEGER NOT NULL REFERENCES rentals(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  added_at TEXT NOT NULL,
  returned_at TEXT,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_ri_rental ON rental_items(rental_id);
CREATE INDEX IF NOT EXISTS idx_ri_item ON rental_items(item_id);

-- Which cases are on a rental (packed for shipment, or scanned out). returned_at is set when the case itself is scanned back.
CREATE TABLE IF NOT EXISTS rental_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rental_id INTEGER NOT NULL REFERENCES rentals(id) ON DELETE CASCADE,
  container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  returned_at TEXT,
  UNIQUE (rental_id, container_id)
);
CREATE INDEX IF NOT EXISTS idx_rc_rental ON rental_cases(rental_id);
CREATE INDEX IF NOT EXISTS idx_rc_container ON rental_cases(container_id);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'comment',
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id);

CREATE TABLE IF NOT EXISTS pat_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tested_at TEXT NOT NULL,
  result TEXT NOT NULL,
  tester TEXT,
  notes TEXT,
  next_due TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pat_item ON pat_tests(item_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  item_id INTEGER,
  rental_id INTEGER,
  container_id INTEGER,
  barcode TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`);

// Databases created by older versions are upgraded in place (columns are only ever added).
function ensureColumn(table, col, ddl) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
ensureColumn('items', 'input_connector', 'TEXT');
ensureColumn('items', 'outputs', 'TEXT');
ensureColumn('containers', 'kind', "TEXT NOT NULL DEFAULT 'permanent'"); // permanent (always used) | temporary (one-off box)
ensureColumn('rental_items', 'case_id', 'INTEGER REFERENCES containers(id) ON DELETE SET NULL'); // the case this line is packed in for the shipment

const norm = (params) =>
  params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

export const all = (sql, ...p) => db.prepare(sql).all(...norm(p));
export const get = (sql, ...p) => db.prepare(sql).get(...norm(p));
export const run = (sql, ...p) => db.prepare(sql).run(...norm(p));

let txDepth = 0;
// Re-entrant: a nested tx() just joins the outer transaction, so an outer failure rolls everything back.
export function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

export const nowIso = () => new Date().toISOString();

const pad = (n) => String(n).padStart(2, '0');
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  if (dt.getUTCDate() !== d) dt.setUTCDate(0); // e.g. 31 Jan + 1 month -> 28/29 Feb
  return dt.toISOString().slice(0, 10);
}

export function logEvent({ action, item, rental, container, barcode, detail }) {
  run(
    `INSERT INTO events (ts, action, item_id, rental_id, container_id, barcode, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    nowIso(),
    action,
    item?.id ?? null,
    rental?.id ?? null,
    container?.id ?? null,
    barcode ?? item?.barcode ?? container?.barcode ?? null,
    detail ?? null
  );
}
