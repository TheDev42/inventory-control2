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

-- A kit requirement on a rental: "10 of this kind of item", so packing it just means scanning any 10
-- matching barcodes rather than pre-picking specific ones. How much of it is already packed is computed
-- from the rental's current items (rentals.js), not stored here. The category/type/connector/length
-- columns are a snapshot of the kind requested (kind_key is a one-way hash, so they can't be recovered
-- from it) — needed to print a hire sheet for a booking before anything has actually been packed.
CREATE TABLE IF NOT EXISTS rental_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rental_id INTEGER NOT NULL REFERENCES rentals(id) ON DELETE CASCADE,
  kind_key TEXT NOT NULL,
  label TEXT NOT NULL,
  details TEXT,
  qty INTEGER NOT NULL,
  category TEXT,
  type TEXT,
  name TEXT,
  male_connector TEXT,
  female_connector TEXT,
  input_connector TEXT,
  outputs TEXT,
  length_m REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rental_req_rental ON rental_requirements(rental_id);

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
  location TEXT,
  cost REAL,
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
// Exported so other modules (e.g. hire.js, which owns its own tables) can extend them the same way.
export function ensureColumn(table, col, ddl) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
ensureColumn('items', 'input_connector', 'TEXT');
ensureColumn('items', 'outputs', 'TEXT');
ensureColumn('items', 'owner', "TEXT NOT NULL DEFAULT 'company'"); // company | personal
ensureColumn('items', 'location', 'TEXT'); // where a loose (not containered) item is physically kept, e.g. a different yard
ensureColumn('items', 'cost', 'REAL'); // what it cost to buy, in GBP — admin info, not shown in the inventory list
ensureColumn('items', 'category2', 'TEXT'); // optional second category + type, for items that belong in two places (both set, or both NULL)
ensureColumn('items', 'type2', 'TEXT');
ensureColumn('containers', 'kind', "TEXT NOT NULL DEFAULT 'permanent'"); // permanent (always used) | temporary (one-off box)
ensureColumn('rental_items', 'case_id', 'INTEGER REFERENCES containers(id) ON DELETE SET NULL'); // the case this line is packed in for the shipment
ensureColumn('rentals', 'job_number', 'TEXT'); // JOB-0001, JOB-0002... one counter shared by every rental, however it was created

// Rentals from before job numbers existed are backfilled once, in creation order, so the counter carries
// on from history instead of leaving old rentals blank.
{
  const unnumbered = db.prepare('SELECT id FROM rentals WHERE job_number IS NULL ORDER BY id').all();
  if (unnumbered.length) {
    const maxExisting = db.prepare(
      `SELECT MAX(CAST(SUBSTR(job_number, 5) AS INTEGER)) AS n FROM rentals WHERE job_number LIKE 'JOB-%'`
    ).get().n || 0;
    const setJob = db.prepare('UPDATE rentals SET job_number = ? WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      unnumbered.forEach((r, i) => setJob.run(`JOB-${String(maxExisting + i + 1).padStart(4, '0')}`, r.id));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// The next JOB-#### for a new rental. Called from inside createRental()'s own transaction, so two
// concurrent creates can never be handed the same number (node:sqlite's calls are synchronous, so there
// is no interleaving within a single BEGIN IMMEDIATE ... COMMIT).
export function nextJobNumber() {
  const n = (db.prepare(`SELECT MAX(CAST(SUBSTR(job_number, 5) AS INTEGER)) AS n FROM rentals WHERE job_number LIKE 'JOB-%'`).get().n || 0) + 1;
  return `JOB-${String(n).padStart(4, '0')}`;
}

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
