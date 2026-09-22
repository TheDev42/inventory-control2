import { api, html, mount, $, $$, qs, debounce, cap, fmtDate, statusBadge, patBadge, ends, itemTitle, ownerBadge, toast, plural } from '../util.js';
import { app } from '../state.js';

// The table stacks related details into one cell so it fits without sideways scrolling (ends and length each get their
// own column). Clicking a header sorts by its main field; every other field can still be sorted from the "Sort by" list.
const COLUMNS = [
  ['barcode', 'Barcode'], ['category', 'Item'], ['male', 'Ends'], ['length', 'Length'], ['status', 'Status & location'], ['pat', 'PAT'], ['created', 'Added'],
];
const SORT_OPTIONS = [
  ['barcode', 'Barcode'], ['category', 'Category'], ['type', 'Type'], ['name', 'Description'],
  ['male', 'Male end'], ['female', 'Female end'], ['length', 'Length'],
  ['status', 'Status'], ['owner', 'Owner'], ['rental', 'Rental'], ['container', 'Container'], ['location', 'Location'],
  ['pat', 'PAT status'], ['last_pat', 'Last PAT'], ['next_pat', 'PAT due'], ['created', 'Date added'],
];
const MAX_BULK = 1000; // the API returns at most 1000 items per request

export default async function inventoryView({ el, query, isActive }) {
  const s = {
    q: query.get('q') || '', category: query.get('category') || '', type: query.get('type') || '',
    status: query.get('status') || '', pat: query.get('pat') || '', owner: query.get('owner') || '',
    sort: query.get('sort') || 'barcode', dir: query.get('dir') === 'desc' ? 'desc' : 'asc',
    limit: Number(query.get('limit')) || 50, page: Math.max(0, (Number(query.get('page')) || 1) - 1),
  };
  const meta = app.meta;
  const allTypes = [...new Set(Object.values(meta.catalog).flat())];
  const typesFor = () => (s.category ? meta.catalog[s.category] || [] : allTypes);
  const selected = new Set(); // ticked items (ids), kept while you page and filter, for "set owner"
  let lastTotal = 0;

  const params = () => ({
    q: s.q, category: s.category, type: s.type, status: s.status, pat: s.pat, owner: s.owner,
    sort: s.sort, dir: s.dir, limit: s.limit, offset: s.page * s.limit,
  });
  const syncUrl = () => {
    const p = { ...params() };
    delete p.offset;
    if (s.sort === 'barcode') delete p.sort;
    if (s.dir === 'asc') delete p.dir;
    if (s.limit === 50) delete p.limit;
    p.page = s.page ? s.page + 1 : '';
    history.replaceState(null, '', '#/inventory' + qs(p));
  };

  const opt = (value, label, selectedOpt) => html`<option value="${value}" ${selectedOpt ? 'selected' : ''}>${label}</option>`;

  mount(el, html`
    <div class="page-head">
      <div><h1>Inventory</h1><div class="sub" id="inv-sub"></div></div>
      <div class="actions">
        <a class="btn secondary" id="inv-export" href="/api/items/export.csv">Export CSV</a>
        <a class="btn secondary" href="#/bulk">Bulk add</a>
        <a class="btn" href="#/items/new">Add item</a>
      </div>
    </div>
    <div class="toolbar">
      <div class="grow"><input type="search" id="inv-q" placeholder="Search barcode, type, connector, rental…" value="${s.q}" aria-label="Search inventory"></div>
      <select id="inv-category" aria-label="Category"><option value="">All categories</option>${Object.keys(meta.catalog).map((c) => opt(c, c, c === s.category))}</select>
      <select id="inv-type" aria-label="Type"></select>
      <select id="inv-status" aria-label="Status"><option value="">Any status</option>${meta.statuses.map((x) => opt(x, meta.statusLabels[x], x === s.status))}</select>
      <select id="inv-owner" aria-label="Owner"><option value="">Any owner</option>${meta.owners.map((o) => opt(o, meta.ownerLabels[o], o === s.owner))}</select>
      <select id="inv-pat" aria-label="PAT status"><option value="">Any PAT status</option>
        ${[['ok', 'PAT OK'], ['due_soon', 'Due in 30 days'], ['overdue', 'Overdue'], ['failed', 'Failed'], ['never', 'Never tested'], ['na', 'Not required']].map(([v, l]) => opt(v, l, v === s.pat))}</select>
      <select id="inv-sort" aria-label="Sort by">${SORT_OPTIONS.map(([v, l]) => opt(v, 'Sort: ' + l, v === s.sort))}</select>
      <button class="btn secondary small" id="inv-dir" type="button" aria-label="Sort direction"></button>
      <button class="btn ghost small" id="inv-clear" type="button">Clear</button>
    </div>
    <div id="inv-bulk"></div>
    <div id="inv-results"></div>`);

  const fillTypes = () => {
    if (s.type && !typesFor().includes(s.type)) s.type = '';
    mount($('#inv-type', el), html`<option value="">All types</option>${typesFor().map((t) => opt(t, cap(t), t === s.type))}`);
  };
  fillTypes();

  // The bar that appears when items are ticked. Drawn on its own, so ticking never re-renders (or scrolls) the list.
  function renderBulk() {
    const n = selected.size;
    mount($('#inv-bulk', el), n ? html`<div class="bulk-bar">
      <span><strong>${n}</strong> selected</span>
      <label class="ctx-field">Set owner to
        <select id="bulk-owner" aria-label="New owner">${meta.owners.map((o) => html`<option value="${o}">${meta.ownerLabels[o]}</option>`)}</select></label>
      <button class="btn small" type="button" data-bulk="apply">Apply</button>
      ${lastTotal > n ? html`<button class="btn ghost small" type="button" data-bulk="all">Select all ${Math.min(lastTotal, MAX_BULK)} matching</button>` : ''}
      <button class="btn ghost small" type="button" data-bulk="clear">Clear</button>
    </div>` : html``);
    const head = $('#inv-all', el);
    if (head) {
      const boxes = $$('.inv-check', el);
      const on = boxes.filter((b) => b.checked).length;
      head.checked = boxes.length > 0 && on === boxes.length;
      head.indeterminate = on > 0 && on < boxes.length;
    }
  }

  let seq = 0;
  async function load() {
    const mine = ++seq;
    syncUrl();
    $('#inv-sort', el).value = s.sort;
    $('#inv-dir', el).textContent = s.dir === 'asc' ? '▲ Asc' : '▼ Desc';
    $('#inv-export', el).href = '/api/items/export.csv' + qs({ q: s.q, category: s.category, type: s.type, status: s.status, pat: s.pat, owner: s.owner, sort: s.sort, dir: s.dir });
    let data;
    try { data = await api.get('/api/items' + qs(params())); } catch (err) {
      mount($('#inv-results', el), html`<div class="error-box">${err.message}</div>`);
      return;
    }
    if (mine !== seq || !isActive()) return;
    const pages = Math.max(1, Math.ceil(data.total / s.limit));
    if (s.page >= pages) { s.page = pages - 1; return load(); }
    lastTotal = data.total;
    $('#inv-sub', el).textContent = `${plural(data.total, 'item')} match${data.total === 1 ? 'es' : ''}`;
    const from = data.total ? s.page * s.limit + 1 : 0;
    const to = Math.min(data.total, (s.page + 1) * s.limit);
    const filtered = s.q || s.category || s.type || s.status || s.pat || s.owner;

    mount($('#inv-results', el), html`
      <div class="table-wrap cards"><table class="data inventory-table">
        <thead><tr><th class="ck"><input type="checkbox" id="inv-all" aria-label="Tick every item on this page"></th>${COLUMNS.map(([key, label]) => html`<th class="sortable" data-sort="${key}" aria-sort="${s.sort === key ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${label}<span class="sort-ind">${s.sort === key ? (s.dir === 'asc' ? '▲' : '▼') : ''}</span></th>`)}</tr></thead>
        <tbody>${data.items.length ? data.items.map((it) => html`
          <tr class="clickable ${it.status === 'on_rental' ? 'is-out' : it.status === 'lost' ? 'is-lost' : it.status === 'sold' ? 'is-sold' : ''}" data-id="${it.id}">
            <td class="ck"><input type="checkbox" class="inv-check" data-id="${it.id}" ${selected.has(it.id) ? 'checked' : ''} aria-label="Tick ${it.barcode}"></td>
            <td><a class="barcode" href="#/items/${it.id}">${it.barcode}</a></td>
            <td><div class="cell-main">${it.name || itemTitle(it)} ${ownerBadge(it)}</div>${it.name ? html`<div class="cell-sub">${itemTitle(it)}</div>` : ''}</td>
            <td>${ends(it)}</td>
            <td class="nowrap">${it.length_m != null ? `${it.length_m} m` : ''}</td>
            <td>${statusBadge(it.status)}
              ${it.rental_id ? html`<div class="cell-sub">Rental: <a href="#/rentals/${it.rental_id}">${it.rental_name}</a></div>` : ''}
              ${it.container_id ? html`<div class="cell-sub">Container: <a href="#/containers/${it.container_id}">${it.container_name}</a></div>` : ''}
              ${!it.container_id && it.location ? html`<div class="cell-sub">📍 ${it.location}</div>` : ''}</td>
            <td>${it.status === 'sold' ? '' : html`${patBadge(it.pat_status)}
              ${it.pat_status !== 'na' && it.next_pat_due ? html`<div class="cell-sub">Due ${fmtDate(it.next_pat_due)}</div>` : ''}
              ${it.pat_status !== 'na' && it.last_pat_date ? html`<div class="cell-sub">Last ${fmtDate(it.last_pat_date)}</div>` : ''}`}</td>
            <td class="nowrap">${fmtDate(it.created_at)}</td>
          </tr>`) : html`<tr><td colspan="${COLUMNS.length + 1}"><div class="empty">${filtered ? 'No items match those filters.' : 'Nothing here yet — add items one at a time or in bulk.'}</div></td></tr>`}
        </tbody></table></div>
      <div class="pager">
        <span>Showing ${from}–${to} of ${data.total}</span>
        <span class="actions">
          <label>Per page <select id="inv-limit">${[25, 50, 100, 250].map((n) => opt(n, n, n === s.limit))}</select></label>
          <button class="btn secondary small" data-page="prev" ${s.page === 0 ? 'disabled' : ''}>← Prev</button>
          <span>Page ${s.page + 1} of ${pages}</span>
          <button class="btn secondary small" data-page="next" ${s.page + 1 >= pages ? 'disabled' : ''}>Next →</button>
        </span>
      </div>`);
    renderBulk();
  }

  const reload = (resetPage = true) => { if (resetPage) s.page = 0; load(); };
  const search = debounce(() => { s.q = $('#inv-q', el).value.trim(); reload(); }, 220);
  $('#inv-q', el).addEventListener('input', search);
  $('#inv-category', el).addEventListener('change', (e) => { s.category = e.target.value; fillTypes(); reload(); });
  $('#inv-type', el).addEventListener('change', (e) => { s.type = e.target.value; reload(); });
  $('#inv-status', el).addEventListener('change', (e) => { s.status = e.target.value; reload(); });
  $('#inv-owner', el).addEventListener('change', (e) => { s.owner = e.target.value; reload(); });
  $('#inv-pat', el).addEventListener('change', (e) => { s.pat = e.target.value; reload(); });
  $('#inv-sort', el).addEventListener('change', (e) => { s.sort = e.target.value; reload(); });
  $('#inv-dir', el).addEventListener('click', () => { s.dir = s.dir === 'asc' ? 'desc' : 'asc'; reload(); });
  $('#inv-clear', el).addEventListener('click', () => {
    Object.assign(s, { q: '', category: '', type: '', status: '', pat: '', owner: '', sort: 'barcode', dir: 'asc' });
    $('#inv-q', el).value = '';
    $('#inv-category', el).value = ''; $('#inv-status', el).value = ''; $('#inv-pat', el).value = ''; $('#inv-owner', el).value = '';
    fillTypes();
    reload();
  });

  $('#inv-bulk', el).addEventListener('click', async (e) => {
    const act = e.target.closest('[data-bulk]')?.dataset.bulk;
    if (act === 'clear') {
      selected.clear();
      $$('.inv-check', el).forEach((b) => { b.checked = false; });
      renderBulk();
    } else if (act === 'all') {
      try {
        const data = await api.get('/api/items' + qs({ ...params(), limit: MAX_BULK, offset: 0 }));
        data.items.forEach((it) => selected.add(it.id));
        $$('.inv-check', el).forEach((b) => { b.checked = selected.has(Number(b.dataset.id)); });
        if (data.total > MAX_BULK) toast(`Only the first ${MAX_BULK} matches were ticked. Narrow the filters for the rest`, 'info', 5000);
        renderBulk();
      } catch (err) { toast(err.message, 'error', 5000); }
    } else if (act === 'apply') {
      const owner = $('#bulk-owner', el).value;
      try {
        const res = await api.post('/api/items/owner', { itemIds: [...selected], owner });
        toast(res.updated
          ? `${plural(res.updated, 'item')} set to ${meta.ownerLabels[owner]}`
          : `Nothing to change: they are already ${meta.ownerLabels[owner]}`, res.updated ? 'ok' : 'info');
        selected.clear();
        load();
      } catch (err) { toast(err.message, 'error', 5000); }
    }
  });

  $('#inv-results', el).addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (s.sort === key) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
      else { s.sort = key; s.dir = 'asc'; }
      reload();
      return;
    }
    const pg = e.target.closest('[data-page]');
    if (pg) { s.page += pg.dataset.page === 'next' ? 1 : -1; reload(false); window.scrollTo(0, 0); return; }
    const row = e.target.closest('tr[data-id]');
    if (row && !e.target.closest('a') && !e.target.closest('.ck')) location.hash = `#/items/${row.dataset.id}`;
  });
  $('#inv-results', el).addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'inv-limit') { s.limit = Number(t.value); reload(); }
    else if (t.classList.contains('inv-check')) {
      const id = Number(t.dataset.id);
      if (t.checked) selected.add(id); else selected.delete(id);
      renderBulk();
    } else if (t.id === 'inv-all') {
      $$('.inv-check', el).forEach((b) => {
        b.checked = t.checked;
        const id = Number(b.dataset.id);
        if (t.checked) selected.add(id); else selected.delete(id);
      });
      renderBulk();
    }
  });

  await load();
  return { refresh: () => load() };
}
