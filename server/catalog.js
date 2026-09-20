export const CATALOG = {
  POWER: ['cable', 'adapter', 'splitter', 'distro'],
  LIGHTING: ['cable', 'light', 'unit'],
  SOUND: ['cable', 'audio'],
};

// Types that have a male end and a female end recorded
export const CONNECTOR_TYPES = new Set(['cable', 'adapter', 'splitter']);

// Distros have one input connector and a list of output connectors (e.g. 6 x 16A Cee, 2 x 13A) instead of a male/female end
export const OUTPUT_TYPES = new Set(['distro']);

export const STATUSES = ['in_stock', 'on_rental', 'lost', 'disassembled', 'repair', 'sold'];

export const STATUS_LABEL = {
  in_stock: 'In stock',
  on_rental: 'On rental',
  lost: 'Lost',
  disassembled: 'Disassembled',
  repair: 'Repair',
  sold: 'Sold',
};

export const PAT_STATUSES = ['ok', 'due_soon', 'overdue', 'failed', 'never', 'na'];

// Suggestions for the connector pick-lists; anything already in the database is merged in too.
export const CONNECTOR_SUGGESTIONS = [
  '13A (BS1363)',
  '2 Way 13A (BS1363)',
  '4 Way 13A (BS1363)',
  '16A 3-pin (blue)',
  '16A 3-pin (black)',
  '32A 3-pin (blue)',
  '32A 3-pin (black)',
  '63A 3-pin (blue)',
  '16A 5-pin (red)',
  '32A 5-pin (red)',
  '63A 5-pin (red)',
  '125A 5-pin (red)',
  'PowerCON (blue)',
  'PowerCON (grey)',
  'PowerCON TRUE1 Old',
  'PowerCON TRUE1 New',
  'Schuko',
  'IEC C13',
  'IEC C14',
  'IEC C19',
  'IEC C20',
  'Socapex 19-pin',
  'DMX 3-pin XLR',
  'DMX 5-pin XLR',
  'XLR 3-pin',
  'TRS jack',
  'TS jack',
  'Speakon NL4',
  'Speakon NL8',
  'RCA',
  'BNC',
  'Ethercon',
  'Bare ends',
  'HDMI',
  'VGA',
];

// Barcodes are zero-padded numbers (00001). Spreadsheets and hand-typing drop the leading zeros, so purely
// numeric codes shorter than this are padded back up. Set BARCODE_DIGITS=0 to switch padding off.
const parsedDigits = parseInt(process.env.BARCODE_DIGITS ?? '5', 10);
export const BARCODE_DIGITS = Number.isNaN(parsedDigits) ? 5 : Math.max(0, parsedDigits);

export function normalizeBarcode(value) {
  const s = String(value ?? '').trim();
  if (BARCODE_DIGITS && /^\d+$/.test(s) && s.length < BARCODE_DIGITS) return s.padStart(BARCODE_DIGITS, '0');
  return s;
}

/* ---------- distro outputs: [{ connector, qty }] stored as JSON in items.outputs ---------- */

// Tolerant reader for display/export: the stored JSON, or an already-parsed array. Never throws.
export function parseOutputs(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export const formatOutputs = (list, sep = ', ') => parseOutputs(list).map((o) => `${o.qty}× ${o.connector}`).join(sep);

export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');
