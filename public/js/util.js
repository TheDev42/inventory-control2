/* ---------- safe HTML templating: interpolated values are escaped unless wrapped in raw() / html`` ---------- */
export class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Safe(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const render = (v) => {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
};
export const html = (strings, ...vals) =>
  new Safe(strings.reduce((out, s, i) => out + s + (i < vals.length ? render(vals[i]) : ''), ''));
// Tolerates a missing target: a slow request can finish after you have already navigated to another page.
export const mount = (el, tpl) => { if (el) el.innerHTML = tpl instanceof Safe ? tpl.s : esc(tpl); };

/* ---------- DOM helpers ---------- */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};

/* ---------- API ---------- */
export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the server');
  }
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}
api.get = (url) => api('GET', url);
api.post = (url, body = {}) => api('POST', url, body);
api.put = (url, body = {}) => api('PUT', url, body);
api.del = (url) => api('DELETE', url);
export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

/* ---------- formatting ---------- */
export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');
export const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
export const fmtDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(iso);
}
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/* ---------- shared badges (icon + label, never colour alone) ---------- */
const STATUS_META = {
  in_stock: { label: 'In stock', icon: '●', cls: 'st-stock' },
  on_rental: { label: 'On rental', icon: '➜', cls: 'st-rental' },
  lost: { label: 'Lost', icon: '?', cls: 'st-lost' },
  disassembled: { label: 'Disassembled', icon: '✂', cls: 'st-dis' },
  repair: { label: 'Repair', icon: '⚒', cls: 'st-repair' },
  sold: { label: 'Sold', icon: '£', cls: 'st-sold' },
};
export const statusLabel = (s) => STATUS_META[s]?.label || s;
export const statusBadge = (s) => {
  const m = STATUS_META[s] || { label: s, icon: '•', cls: '' };
  return html`<span class="badge ${m.cls}"><span class="ico" aria-hidden="true">${m.icon}</span>${m.label}</span>`;
};

const PAT_META = {
  ok: { label: 'PAT OK', icon: '✓', cls: 'pat-ok' },
  due_soon: { label: 'Due soon', icon: '▲', cls: 'pat-soon' },
  overdue: { label: 'Overdue', icon: '✕', cls: 'pat-bad' },
  failed: { label: 'Failed', icon: '✕', cls: 'pat-bad' },
  never: { label: 'Never tested', icon: '?', cls: 'pat-never' },
  na: { label: 'Not required', icon: '–', cls: 'pat-na' },
};
export const patLabel = (s) => PAT_META[s]?.label || s;
export const patBadge = (s) => {
  const m = PAT_META[s] || { label: s, icon: '•', cls: '' };
  return html`<span class="badge ${m.cls}"><span class="ico" aria-hidden="true">${m.icon}</span>${m.label}</span>`;
};

export const itemTitle = (it) => `${cap(it.category)} ${it.type}`;
// Distro outputs arrive as a JSON string: [{ connector, qty }]
export const outputsOf = (it) => {
  try { const v = JSON.parse(it.outputs); return Array.isArray(v) ? v : []; } catch { return []; }
};
export const ends = (it) =>
  it.input_connector || it.outputs
    ? html`<span class="ends">${it.input_connector ? html`<span class="end in" title="Input connector">${it.input_connector}</span>` : ''}${outputsOf(it).length
      ? html`<span class="arrow" aria-hidden="true">→</span><span class="outs" title="Output connectors">${outputsOf(it).map((o) => html`<span class="end">${o.qty}× ${o.connector}</span>`)}</span>` : ''}</span>`
    : it.male_connector || it.female_connector
    ? html`<span class="ends"><span class="end m" title="Male end">${it.male_connector || '?'}</span><span class="arrow" aria-hidden="true">→</span><span class="end f" title="Female end">${it.female_connector || '?'}</span></span>`
    : '';

/* ---------- toasts ---------- */
export function toast(message, kind = 'info', ms = 3800) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms);
}

export const CHANGED = 'inventory:changed';
export const notifyChanged = () => document.dispatchEvent(new CustomEvent(CHANGED));

/* ---------- small icon set ---------- */
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  inventory: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/>',
  rentals: '<path d="M9 4h6a1 1 0 011 1v1H8V5a1 1 0 011-1z"/><rect x="5" y="6" width="14" height="15" rx="2"/><path d="M9 12h6M9 16h4"/>',
  containers: '<path d="M4 8l8-4 8 4v9l-8 4-8-4V8z"/><path d="M4 8l8 4 8-4M12 12v9"/>',
  overview: '<path d="M4 20V11M10 20V4M16 20v-6M22 20H2"/>',
  pat: '<path d="M12 3l8 3v6c0 4.5-3.2 7.7-8 9-4.8-1.3-8-4.5-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  bulk: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>',
};
export const icon = (name) =>
  raw(`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);
