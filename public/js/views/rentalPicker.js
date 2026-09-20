import { api, html, mount, $, $$, qs, debounce, cap, itemTitle, ends, patBadge, plural, toast, notifyChanged } from '../util.js';
import { app } from '../state.js';
import { caseOptions, newTempBox } from '../ui.js';

/*
 * Manual item picker for a rental: search / filter the in-stock items, tick the ones you want, add them in one go.
 * It is the click-around alternative to scanning. Filters, page and the ticked items live here (not in the DOM), so
 * the rental page can re-render itself (e.g. after a scan) and simply call mount() again.
 */

const PAGE_SIZE = 50;
const MAX_BULK = 1000; // the API caps a list request at 1000 items

export function createPicker({ rentalId, onClose }) {
  const s = { q: '', category: '', type: '', page: 0 };
  const selected = new Set();
  let host = null;
  let rows = [];
  let total = 0;
  let seq = 0;
  let caseId = null; // "pack into" choice: added items go straight into this case
  let containers = [];

  const types = () => (s.category ? app.meta.catalog[s.category] || [] : [...new Set(Object.values(app.meta.catalog).flat())]);
  const selectable = (it) => it.pat_status !== 'failed';
  const query = (extra = {}) => qs({ status: 'in_stock', q: s.q, category: s.category, type: s.type, ...extra });
  const opt = (value, label, on) => html`<option value="${value}" ${on ? 'selected' : ''}>${label}</option>`;

  function fillTypes() {
    if (s.type && !types().includes(s.type)) s.type = '';
    mount($('#pk-type', host), html`<option value="">All types</option>${types().map((t) => opt(t, cap(t), t === s.type))}`);
  }

  function renderBar() {
    const n = selected.size;
    const bar = $('#pk-bar', host);
    if (!bar) return;
    mount(bar, html`
      <span class="pk-count"><strong>${n}</strong> selected</span>
      <label class="pk-case">Pack into
        <select id="pk-case" aria-label="Pack the added items into this case">
          <option value="">no case</option>${caseOptions(containers, caseId)}<option value="__new">+ New temporary box…</option>
        </select></label>
      <span class="actions">
        ${n ? html`<button class="btn ghost small" type="button" data-pk="clear">Clear selection</button>` : ''}
        <button class="btn" type="button" data-pk="add" ${n ? '' : 'disabled'}>${n ? `Add ${plural(n, 'item')} to rental` : 'Add to rental'}</button>
      </span>`);
    const head = $('#pk-all', host);
    if (head) {
      const ids = rows.filter(selectable).map((it) => it.id);
      const picked = ids.filter((id) => selected.has(id)).length;
      head.checked = ids.length > 0 && picked === ids.length;
      head.indeterminate = picked > 0 && picked < ids.length;
      head.disabled = ids.length === 0;
    }
  }

  function renderList(error) {
    const list = $('#pk-list', host);
    if (!list) return;
    if (error) { mount(list, html`<div class="error-box">${error}</div>`); return; }
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const from = total ? s.page * PAGE_SIZE + 1 : 0;
    const to = Math.min(total, (s.page + 1) * PAGE_SIZE);
    const filtered = s.q || s.category || s.type;
    mount(list, html`
      <div class="table-wrap cards pk-table"><table class="data">
        <thead><tr>
          <th class="pk-col"><input type="checkbox" id="pk-all" aria-label="Select all on this page"></th>
          <th>Barcode</th><th>Type</th><th>Description</th><th>Ends</th><th class="num pk-hide-sm">Length (m)</th><th class="pk-hide-sm">Container</th><th>PAT</th>
        </tr></thead>
        <tbody>${rows.length ? rows.map((it) => html`
          <tr class="${selectable(it) ? 'clickable' : 'pk-blocked'} ${selected.has(it.id) ? 'picked' : ''}" data-id="${it.id}">
            <td class="pk-col"><input type="checkbox" aria-label="Select ${it.barcode}" ${selected.has(it.id) ? 'checked' : ''} ${selectable(it) ? '' : 'disabled'}></td>
            <td><span class="barcode">${it.barcode}</span></td>
            <td>${itemTitle(it)}</td><td>${it.name || ''}</td><td>${ends(it)}</td>
            <td class="num pk-hide-sm">${it.length_m ?? ''}</td>
            <td class="pk-hide-sm">${it.container_name || ''}</td>
            <td>${patBadge(it.pat_status)}${selectable(it) ? '' : html` <span class="muted small-text">can't go out</span>`}</td>
          </tr>`)
          : html`<tr><td colspan="8"><div class="empty">${filtered ? 'No in-stock items match those filters.' : 'There are no in-stock items to add.'}</div></td></tr>`}
        </tbody></table></div>
      <div class="pager">
        <span>${total ? `Showing ${from}–${to} of ${total} in stock` : ''}
          ${total > rows.length ? html` · <button class="btn ghost small" type="button" data-pk="all-matching">Select all ${Math.min(total, MAX_BULK)} matching</button>` : ''}</span>
        <span class="actions">
          <button class="btn secondary small" type="button" data-pk="prev" ${s.page === 0 ? 'disabled' : ''}>← Prev</button>
          <span>Page ${s.page + 1} of ${pages}</span>
          <button class="btn secondary small" type="button" data-pk="next" ${s.page + 1 >= pages ? 'disabled' : ''}>Next →</button>
        </span>
      </div>`);
    renderBar();
  }

  async function load() {
    const mine = ++seq;
    let data;
    try { data = await api.get('/api/items' + query({ sort: 'barcode', limit: PAGE_SIZE, offset: s.page * PAGE_SIZE })); } catch (err) {
      if (mine === seq && host?.isConnected) renderList(err.message);
      return;
    }
    if (mine !== seq || !host?.isConnected) return;
    const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
    if (s.page >= pages) { s.page = pages - 1; load(); return; }
    rows = data.items;
    total = data.total;
    renderList();
  }

  async function selectAllMatching() {
    try {
      const data = await api.get('/api/items' + query({ sort: 'barcode', limit: MAX_BULK, offset: 0 }));
      data.items.filter(selectable).forEach((it) => selected.add(it.id));
      if (data.total > MAX_BULK) toast(`Only the first ${MAX_BULK} matches were selected — narrow the search for the rest`, 'info', 5000);
      renderList();
    } catch (err) { toast(err.message, 'error', 5000); }
  }

  async function addSelected() {
    const itemIds = [...selected];
    if (!itemIds.length) return;
    const btn = $('[data-pk=add]', host);
    if (btn) btn.disabled = true;
    try {
      const r = await api.post(`/api/rentals/${rentalId}/items`, { itemIds, caseId });
      selected.clear();
      const pat = r.warned ? ` ⚠ ${r.warned} with PAT due/overdue` : '';
      if (r.skipped.length) {
        const why = r.skipped.slice(0, 3).map((x) => `${x.barcode} ${x.reason}`).join('; ') + (r.skipped.length > 3 ? '…' : '');
        toast(`${r.added ? `Added ${plural(r.added, 'item')}${pat}. ` : ''}${r.skipped.length} skipped: ${why}`, r.added ? 'info' : 'error', 8000);
      } else {
        const boxName = r.packed ? containers.find((c) => c.id === caseId)?.name : null;
        toast(`Added ${plural(r.added, 'item')} to the rental${boxName ? `, packed into ${boxName}` : ''}${pat}`, 'ok');
      }
      notifyChanged(); // re-renders the rental page (and this picker) with the new lines
    } catch (err) {
      toast(err.message, 'error', 5000);
      renderBar();
    }
  }

  function toggleRow(row, checked) {
    const id = Number(row.dataset.id);
    if (checked) selected.add(id); else selected.delete(id);
    row.classList.toggle('picked', checked);
    renderBar();
  }

  function wire() {
    const search = debounce((value) => { s.q = value.trim(); s.page = 0; load(); }, 220);
    host.addEventListener('input', (e) => { if (e.target.id === 'pk-q') search(e.target.value); });
    host.addEventListener('change', async (e) => {
      const t = e.target;
      if (t.id === 'pk-case') {
        if (t.value === '__new') {
          try {
            const box = await newTempBox();
            if (box) { containers = [...containers, box]; caseId = box.id; }
          } catch (err) { toast(err.message, 'error', 5000); }
        } else caseId = t.value ? Number(t.value) : null;
        renderBar();
        return;
      }
      if (t.id === 'pk-category') { s.category = t.value; fillTypes(); s.page = 0; load(); }
      else if (t.id === 'pk-type') { s.type = t.value; s.page = 0; load(); }
      else if (t.id === 'pk-all') {
        rows.filter(selectable).forEach((it) => { if (t.checked) selected.add(it.id); else selected.delete(it.id); });
        $$('#pk-list tbody tr[data-id]', host).forEach((tr) => {
          const cb = tr.querySelector('input[type=checkbox]');
          if (cb && !cb.disabled) { cb.checked = t.checked; tr.classList.toggle('picked', t.checked); }
        });
        renderBar();
      }
    });
    host.addEventListener('click', (e) => {
      const act = e.target.closest('[data-pk]')?.dataset.pk;
      if (act === 'add') addSelected();
      else if (act === 'clear') { selected.clear(); renderList(); }
      else if (act === 'all-matching') selectAllMatching();
      else if (act === 'prev' || act === 'next') { s.page += act === 'next' ? 1 : -1; load(); }
      else if (act === 'close') onClose?.();
      if (act) return;
      // Click anywhere on a row to tick it (the checkbox itself has already flipped by the time we get here)
      const row = e.target.closest('tr[data-id]');
      const cb = row?.querySelector('input[type=checkbox]');
      if (!cb || cb.disabled) return;
      if (e.target !== cb) cb.checked = !cb.checked;
      toggleRow(row, cb.checked);
    });
  }

  return {
    selectedCount: () => selected.size,
    mount(el) {
      host = el;
      mount(host, html`
        <section class="card picker" aria-label="Add items to this rental">
          <div class="card-head">
            <h2>Add items to this rental</h2>
            <button class="btn ghost small" type="button" data-pk="close">Close</button>
          </div>
          <p class="muted small-text">Only items that are in stock are listed. Tick the ones you want, then add them all at once. Selections are kept while you search and change page.</p>
          <div class="toolbar">
            <div class="grow"><input type="search" id="pk-q" placeholder="Search in-stock items: barcode, type, connector, container…" value="${s.q}" aria-label="Search in-stock items" autocomplete="off"></div>
            <select id="pk-category" aria-label="Category"><option value="">All categories</option>${Object.keys(app.meta.catalog).map((c) => opt(c, c, c === s.category))}</select>
            <select id="pk-type" aria-label="Type"></select>
          </div>
          <div id="pk-list">${rows.length ? '' : html`<div class="empty">Loading…</div>`}</div>
          <div class="picker-bar" id="pk-bar"></div>
        </section>`);
      fillTypes();
      wire();
      api.get('/api/containers').then((list) => { containers = list; renderBar(); }).catch(() => { /* the case list is optional */ });
      if (rows.length) renderList(); // show the last results straight away while the fresh ones load
      else renderBar();
      load();
    },
    focus() { $('#pk-q', host)?.focus(); },
  };
}
