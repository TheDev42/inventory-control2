import { api, html, mount, $, store, fmtDateTime, notifyChanged, CHANGED } from './util.js';
import { play, TONES, isMuted, setMuted, getVolume, setVolume, unlockAudio } from './audio.js';

/*
 * Scanner: a USB/Bluetooth barcode scanner acts like a keyboard - it "types" the code very fast and presses Enter.
 * We listen for that on the whole document, so nothing has to be focused. Keystrokes are ignored while you are
 * typing in a form field, so normal data entry still works.
 */

export const MODES = [
  { id: 'lookup', label: 'Lookup', hint: 'Scan to open an item or container' },
  { id: 'out', label: 'Scan OUT', hint: 'Scan to add items to the selected rental' },
  { id: 'return', label: 'Return', hint: 'Scan anywhere to return items to active inventory' },
  { id: 'store', label: 'Store', hint: 'Scan to put items into the selected container' },
  { id: 'pat', label: 'PAT test', hint: 'Scan to record a PAT result' },
];

const saved = store.get('scan', {});
export const state = {
  mode: MODES.some((m) => m.id === saved.mode) ? saved.mode : 'lookup',
  rentalId: saved.rentalId || null,
  containerId: saved.containerId || null,
  patResult: saved.patResult === 'fail' ? 'fail' : 'pass',
  tester: saved.tester || '',
};
export const lists = { rentals: [], containers: [] };
const persist = () => store.set('scan', state);

let interceptor = null;
export const setInterceptor = (fn) => { interceptor = fn; };

const el = {};
const log = [];
let panel = null; // 'log' | 'sound' | null

/* ---------- public helpers for views ---------- */
export function setMode(mode, ctx = {}) {
  state.mode = mode;
  if ('rentalId' in ctx) state.rentalId = ctx.rentalId;
  if ('containerId' in ctx) state.containerId = ctx.containerId;
  persist();
  renderModes();
  renderCtx();
}

export async function refreshLists() {
  try {
    const [rentals, containers] = await Promise.all([api.get('/api/rentals?status=active'), api.get('/api/containers')]);
    lists.rentals = rentals;
    lists.containers = containers;
    if (state.rentalId && !rentals.some((r) => r.id === state.rentalId)) state.rentalId = null;
    if (state.containerId && !containers.some((c) => c.id === state.containerId)) state.containerId = null;
    persist();
    renderCtx();
  } catch { /* server unreachable; keep old lists */ }
}

/* ---------- rendering ---------- */
function renderModes() {
  mount(el.modes, html`${MODES.map((m) => html`<button type="button" class="mode-btn m-${m.id}" data-mode="${m.id}" aria-pressed="${String(state.mode === m.id)}" title="${m.hint}">${m.label}</button>`)}`);
  el.bar.className = `scanbar mode-${state.mode}`;
}

function renderCtx() {
  const hint = MODES.find((m) => m.id === state.mode).hint;
  let body;
  if (state.mode === 'out') {
    body = html`<label class="ctx-field">Rental
      <select id="sb-rental" aria-label="Rental to scan items onto">
        <option value="">— choose a rental —</option>
        ${lists.rentals.map((r) => html`<option value="${r.id}" ${r.id === state.rentalId ? 'selected' : ''}>${r.name}${r.customer ? ' · ' + r.customer : ''}</option>`)}
      </select></label>`;
  } else if (state.mode === 'store') {
    body = html`<label class="ctx-field">Container
      <select id="sb-container" aria-label="Container to store items in">
        <option value="">— choose a container —</option>
        ${['permanent', 'temporary'].map((kind) => html`<optgroup label="${kind === 'permanent' ? 'Cases you always use' : 'Temporary boxes'}">${lists.containers.filter((c) => c.kind === kind)
          .map((c) => html`<option value="${c.id}" ${c.id === state.containerId ? 'selected' : ''}>${c.name} (${c.barcode})</option>`)}</optgroup>`)}
      </select></label>`;
  } else if (state.mode === 'pat') {
    body = html`<div class="seg" role="group" aria-label="PAT result">
        <button type="button" class="seg-btn pass" data-pat="pass" aria-pressed="${String(state.patResult === 'pass')}">✓ Pass</button>
        <button type="button" class="seg-btn fail" data-pat="fail" aria-pressed="${String(state.patResult === 'fail')}">✕ Fail</button>
      </div>
      <label class="ctx-field">Tester <input id="sb-tester" type="text" value="${state.tester}" placeholder="name (optional)" maxlength="60"></label>`;
  } else {
    body = html`<span class="ctx-hint">${hint}</span>`;
  }
  mount(el.ctx, body);
}

const LEVEL = { out: 'ok', return: 'ok', store: 'ok', found: 'ok', pat_pass: 'ok', lookup: 'ok', out_warn: 'warn', warn: 'warn', pat_fail: 'warn', error: 'err', unknown: 'err' };
const GLYPH = { ok: '✓', warn: '⚠', err: '✕' };

function renderResult() {
  const r = log[0];
  if (!r) {
    mount(el.result, html`<span class="res-idle">Ready — scanner input is live on every page. Current mode: <strong>${MODES.find((m) => m.id === state.mode).label}</strong>.</span>`);
    el.result.className = 'sb-result';
    return;
  }
  const level = LEVEL[r.tone] || 'ok';
  el.result.className = `sb-result res-${level}`;
  const link = r.item ? html` <a href="#/items/${r.item.id}">open</a>` : r.container ? html` <a href="#/containers/${r.container.id}">open</a>` : '';
  const create = r.unknown ? html` <a class="btn small" href="#/items/new?barcode=${encodeURIComponent(r.barcode)}">Add this barcode as an item</a>` : '';
  mount(el.result, html`<span class="res-ico" aria-hidden="true">${GLYPH[level]}</span><span class="res-msg">${r.message}</span>${link}${create}<span class="res-time">${fmtDateTime(r.at)}</span>`);
}

function renderPanel() {
  el.panel.hidden = !panel;
  el.logBtn.setAttribute('aria-pressed', panel === 'log');
  el.soundBtn.setAttribute('aria-pressed', panel === 'sound');
  el.soundBtn.textContent = isMuted() ? 'Muted' : 'Sound';
  if (panel === 'log') {
    mount(el.panel, log.length
      ? html`<ol class="log">${log.map((r) => html`<li class="res-${LEVEL[r.tone] || 'ok'}"><span class="res-ico">${GLYPH[LEVEL[r.tone] || 'ok']}</span><span class="res-msg">${r.message}</span><span class="res-time">${fmtDateTime(r.at)}</span></li>`)}</ol>`
      : html`<p class="muted">No scans yet this session.</p>`);
  } else if (panel === 'sound') {
    mount(el.panel, html`<div class="sound-panel">
      <div class="sound-head">
        <label class="check"><input type="checkbox" id="snd-mute" ${isMuted() ? 'checked' : ''}> Mute</label>
        <label class="ctx-field">Volume <input type="range" id="snd-vol" min="5" max="100" value="${Math.round(getVolume() * 100)}"></label>
      </div>
      <ul class="tones">${Object.entries(TONES).map(([id, t]) => html`<li><button type="button" class="btn small" data-tone="${id}">▶ Play</button><span>${t.label}</span></li>`)}</ul>
    </div>`);
  }
}

/* ---------- scanning ---------- */
let chain = Promise.resolve();
export function submitScan(barcode) {
  const code = String(barcode).trim();
  if (!code) return;
  chain = chain.then(() => doScan(code)).catch((err) => console.error(err));
}

async function doScan(barcode) {
  if (interceptor && (await interceptor(barcode))) return;
  let res;
  try {
    res = await api.post('/api/scan', {
      barcode, mode: state.mode, rentalId: state.rentalId, containerId: state.containerId,
      patResult: state.patResult, tester: state.tester,
    });
  } catch (err) {
    res = { ok: false, tone: 'error', message: err.message, barcode };
  }
  res.at = new Date().toISOString();
  log.unshift(res);
  log.length = Math.min(log.length, 40);
  play(res.tone);
  renderResult();
  if (panel === 'log') renderPanel();
  if (res.setContainerId) { state.containerId = res.setContainerId; persist(); renderCtx(); }
  if (res.navigate) {
    // Already on that page? Just refresh it; otherwise go there.
    if (location.hash === '#' + res.navigate) notifyChanged();
    else location.hash = '#' + res.navigate;
    return;
  }
  if (res.item || res.container) notifyChanged();
}

/* ---------- global keyboard capture ---------- */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color', 'image']);
const isTextEntry = (t) =>
  !!t && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !NON_TEXT_INPUTS.has(t.type)));

const GAP_MS = 350; // longest pause between keystrokes still counted as the same scan
let buffer = '';
let lastKey = 0;

function onKeyDown(e) {
  unlockAudio();
  if (e.key === 'Escape' && !isTextEntry(e.target)) { setMode('lookup'); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t === el.input) return; // the scan box handles itself
  if (isTextEntry(t)) { buffer = ''; return; }

  const now = performance.now();
  if (now - lastKey > GAP_MS) buffer = '';
  lastKey = now;

  if (e.key === 'Enter' || (e.key === 'Tab' && buffer.length >= 2)) {
    if (buffer.length >= 2) {
      e.preventDefault();
      const code = buffer;
      buffer = '';
      submitScan(code);
    } else buffer = '';
    return;
  }
  if (e.key.length === 1) {
    if (e.key === ' ' && !buffer && (t.tagName === 'BUTTON' || t.tagName === 'A')) return; // let Space press a focused button
    buffer += e.key;
    e.preventDefault(); // stops select-box type-ahead, page scroll, etc. while a scan is arriving
  }
}

/* ---------- init ---------- */
export function initScanner() {
  el.bar = $('#scanbar');
  el.modes = $('#sb-modes');
  el.ctx = $('#sb-ctx');
  el.input = $('#sb-input');
  el.result = $('#sb-result');
  el.panel = $('#sb-panel');
  el.logBtn = $('#sb-log-btn');
  el.soundBtn = $('#sb-sound-btn');

  renderModes();
  renderCtx();
  renderResult();
  renderPanel();
  refreshLists();

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener(CHANGED, () => refreshLists());

  $('#sb-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitScan(el.input.value);
    el.input.value = '';
  });

  el.modes.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) { setMode(b.dataset.mode); b.blur(); }
  });

  el.ctx.addEventListener('change', (e) => {
    if (e.target.id === 'sb-rental') { state.rentalId = Number(e.target.value) || null; persist(); e.target.blur(); }
    if (e.target.id === 'sb-container') { state.containerId = Number(e.target.value) || null; persist(); e.target.blur(); }
    if (e.target.id === 'sb-tester') { state.tester = e.target.value.trim(); persist(); }
  });
  el.ctx.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pat]');
    if (b) { state.patResult = b.dataset.pat; persist(); renderCtx(); }
  });

  const toggle = (which) => { panel = panel === which ? null : which; renderPanel(); };
  el.logBtn.addEventListener('click', () => toggle('log'));
  el.soundBtn.addEventListener('click', () => toggle('sound'));
  el.panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tone]');
    if (b) play(b.dataset.tone, true);
  });
  el.panel.addEventListener('input', (e) => {
    if (e.target.id === 'snd-vol') setVolume(Number(e.target.value) / 100);
  });
  el.panel.addEventListener('change', (e) => {
    if (e.target.id === 'snd-mute') { setMuted(e.target.checked); renderPanel(); }
  });
}
