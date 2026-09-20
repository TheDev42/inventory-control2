import { api, html, mount, $, $$, qs, debounce, cap, fmtDate, statusBadge, patBadge, ends, itemTitle, plural } from '../util.js';
import { app } from '../state.js';

// The table stacks related details into one cell so it fits without sideways scrolling (ends and length each get their
// own column). Clicking a header sorts by its main field; every other field can still be sorted from the "Sort by" list.
const COLUMNS = [
  ['barcode', 'Barcode'], ['category', 'Item'], ['male', 'Ends'], ['length', 'Length'], ['status', 'Status & location'], ['pat', 'PAT'], ['created', 'Added'],
];
const SORT_OPTIONS = [
  ['barcode', 'Barcode'], ['category', 'Category'], ['type', 'Type'], ['name', 'Description'],
  ['male', 'Male end'], ['female', 'Female end'], ['length', 'Length'],
  ['status', 'Status'], ['rental', 'Rental'], ['container', 'Container'],
  ['pat', 'PAT status'], ['last_pat', 'Last PAT'], ['next_pat', 'PAT due'], ['created', 'Date added'],
];

export default async function inventoryView({ el, query, isActive }) {
  const s = {
    q: query.get('q') || '', category: query.get('category') || '', type: query.get('type') || '',
    status: query.get('status') || '', pat: query.get('pat') || '',
    sort: query.get('sort') || 'barcode', dir: query.get('dir') === 'desc' ? 'desc' : 'asc',
    limit: Number(query.get('limit')) || 50, page: Math.max(0, (Number(query.get('page')) || 1) - 1),
  };
  const meta = app.meta;
  const allTypes = [...new Set(Object.values(meta.catalog).flat())];
  const typesFor = () => (s.category ? meta.catalog[s.category] || [] : allTypes);

  const params = () => ({
    q: s.q, category: s.category, type: s.type, status: s.status, pat: s.pat,
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

  const opt = (value, label, selected) => html`<option value="${value}" ${selected ? 'selected' : ''}>${label}</option>`;

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
      <select id="inv-pat" aria-label="PAT status"><option value="">Any PAT status</option>
        ${[['ok', 'PAT OK'], ['due_soon', 'Due in 30 days'], ['overdue', 'Overdue'], ['failed', 'Failed'], ['never', 'Never tested'], ['na', 'Not required']].map(([v, l]) => opt(v, l, v === s.pat))}</select>
      <select id="inv-sort" aria-label="Sort by">${SORT_OPTIONS.map(([v, l]) => opt(v, 'Sort: ' + l, v === s.sort))}</select>
      <button class="btn secondary small" id="inv-dir" type="button" aria-label="Sort direction"></button>
      <button class="btn ghost small" id="inv-clear" type="button">Clear</button>
    </div>
    <div id="inv-results"></div>`);

  const fillTypes = () => {
    if (s.type && !typesFor().includes(s.type)) s.type = '';
    mount($('#inv-type', el), html`<option value="">All types</option>${typesFor().map((t) => opt(t, cap(t), t === s.type))}`);
  };
  fillTypes();

  let seq = 0;
  async function load() {
    const mine = ++seq;
    syncUrl();
    $('#inv-sort', el).value = s.sort;
    $('#inv-dir', el).textContent = s.dir === 'asc' ? '▲ Asc' : '▼ Desc';
    $('#inv-export', el).href = '/api/items/export.csv' + qs({ q: s.q, category: s.category, type: s.type, status: s.status, pat: s.pat, sort: s.sort, dir: s.dir });
    let data;
    try { data = await api.get('/api/items' + qs(params())); } catch (err) {
      mount($('#inv-results', el), html`<div class="error-box">${err.message}</div>`);
      return;
    }
    if (mine !== seq || !isActive()) return;
    const pages = Math.max(1, Math.ceil(data.total / s.limit));
    if (s.page >= pages) { s.page = pages - 1; return load(); }
    $('#inv-sub', el).textContent = `${plural(data.total, 'item')} match${data.total === 1 ? 'es' : ''}`;
    const from = data.total ? s.page * s.limit + 1 : 0;
    const to = Math.min(data.total, (s.page + 1) * s.limit);

    mount($('#inv-results', el), html`
      <div class="table-wrap cards"><table class="data inventory-table">
        <thead><tr>${COLUMNS.map(([key, label]) => html`<th class="sortable" data-sort="${key}" aria-sort="${s.sort === key ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${label}<span class="sort-ind">${s.sort === key ? (s.dir === 'asc' ? '▲' : '▼') : ''}</span></th>`)}</tr></thead>
        <tbody>${data.items.length ? data.items.map((it) => html`
          <tr class="clickable ${it.status === 'on_rental' ? 'is-out' : it.status === 'lost' ? 'is-lost' : it.status === 'sold' ? 'is-sold' : ''}" data-id="${it.id}">
            <td><a class="barcode" href="#/items/${it.id}">${it.barcode}</a></td>
            <td><div class="cell-main">${itemTitle(it)}</div>${it.name ? html`<div class="cell-sub">${it.name}</div>` : ''}</td>
            <td>${ends(it)}</td>
            <td class="nowrap">${it.length_m != null ? `${it.length_m} m` : ''}</td>
            <td>${statusBadge(it.status)}
              ${it.rental_id ? html`<div class="cell-sub">Rental: <a href="#/rentals/${it.rental_id}">${it.rental_name}</a></div>` : ''}
              ${it.container_id ? html`<div class="cell-sub">Container: <a href="#/containers/${it.container_id}">${it.container_name}</a></div>` : ''}</td>
            <td>${it.status === 'sold' ? '' : html`${patBadge(it.pat_status)}
              ${it.pat_status !== 'na' && it.next_pat_due ? html`<div class="cell-sub">Due ${fmtDate(it.next_pat_due)}</div>` : ''}
              ${it.pat_status !== 'na' && it.last_pat_date ? html`<div class="cell-sub">Last ${fmtDate(it.last_pat_date)}</div>` : ''}`}</td>
            <td class="nowrap">${fmtDate(it.created_at)}</td>
          </tr>`) : html`<tr><td colspan="${COLUMNS.length}"><div class="empty">${s.q || s.category || s.type || s.status || s.pat ? 'No items match those filters.' : 'Nothing here yet — add items one at a time or in bulk.'}</div></td></tr>`}
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
  }

  const reload = (resetPage = true) => { if (resetPage) s.page = 0; load(); };
  const search = debounce(() => { s.q = $('#inv-q', el).value.trim(); reload(); }, 220);
  $('#inv-q', el).addEventListener('input', search);
  $('#inv-category', el).addEventListener('change', (e) => { s.category = e.target.value; fillTypes(); reload(); });
  $('#inv-type', el).addEventListener('change', (e) => { s.type = e.target.value; reload(); });
  $('#inv-status', el).addEventListener('change', (e) => { s.status = e.target.value; reload(); });
  $('#inv-pat', el).addEventListener('change', (e) => { s.pat = e.target.value; reload(); });
  $('#inv-sort', el).addEventListener('change', (e) => { s.sort = e.target.value; reload(); });
  $('#inv-dir', el).addEventListener('click', () => { s.dir = s.dir === 'asc' ? 'desc' : 'asc'; reload(); });
  $('#inv-clear', el).addEventListener('click', () => {
    Object.assign(s, { q: '', category: '', type: '', status: '', pat: '', sort: 'barcode', dir: 'asc' });
    $('#inv-q', el).value = '';
    $('#inv-category', el).value = ''; $('#inv-status', el).value = ''; $('#inv-pat', el).value = '';
    fillTypes();
    reload();
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
    if (row && !e.target.closest('a')) location.hash = `#/items/${row.dataset.id}`;
  });
  $('#inv-results', el).addEventListener('change', (e) => {
    if (e.target.id === 'inv-limit') { s.limit = Number(e.target.value); reload(); }
  });

  await load();
  return { refresh: () => load() };
}
