export const CATALOG = {
  POWER: ['cable', 'adapter', 'splitter'],
  LIGHTING: ['cable', 'light', 'unit'],
  SOUND: ['cable', 'audio'],
};

// Types that have a male end and a female end recorded
export const CONNECTOR_TYPES = new Set(['cable', 'adapter', 'splitter']);

export const STATUSES = ['in_stock', 'on_rental', 'lost', 'disassembled', 'repair'];

export const STATUS_LABEL = {
  in_stock: 'In stock',
  on_rental: 'On rental',
  lost: 'Lost',
  disassembled: 'Disassembled',
  repair: 'Repair',
};

export const PAT_STATUSES = ['ok', 'due_soon', 'overdue', 'failed', 'never', 'na'];

// Suggestions for the connector pick-lists; anything already in the database is merged in too.
export const CONNECTOR_SUGGESTIONS = [
  '13A (BS1363)',
  '16A Cee (blue)',
  '32A Cee (blue)',
  '63A Cee (blue)',
  '125A Cee (blue)',
  '16A 5-pin (red)',
  '32A 5-pin (red)',
  '63A 5-pin (red)',
  '125A 5-pin (red)',
  'PowerCON (blue)',
  'PowerCON (grey)',
  'PowerCON TRUE1',
  'Schuko',
  'IEC C13',
  'IEC C14',
  'IEC C19',
  'IEC C20',
  'Camlock',
  'Wieland',
  'Socapex 19-pin',
  'Harting 16-pin',
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

export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');
