import { api, html, mount, $, debounce, fmtDate, toast, notifyChanged, plural } from '../util.js';
import { app } from '../state.js';
import { setMode } from '../scanner.js';

export default async function rentalsView({ el, query, isActive }) {
  const s = { status: query.get('status') || 'active', q: '' };

  mount(el, html`
    <div class="page-head">
      <div><h1>Rentals</h1><div class="sub">Create a rental, then scan items onto it. Open a rental to export its PDF hire sheet.</div></div>
      <div class="actions"><button class="btn" id="new-toggle" type="button">New rental</button></div>
    </div>
    <form id="new-rental" class="card" hidden style="margin-bottom:16px">
      <h2>New rental</h2>
      <div class="form-grid">
        <div class="field"><label for="r-name">Rental / job name *</label><input id="r-name" name="name" type="text" required placeholder="e.g. Summer Festival main stage"></div>
        <div class="field"><label for="r-customer">Customer</label><input id="r-customer" name="customer" type="text"></div>
        <div class="field"><label for="r-start">Start date</label><input id="r-start" name="start_date" type="date" value="${app.meta.today}"></div>
        <div class="field"><label for="r-end">End date</label><input id="r-end" name="end_date" type="date"></div>
        <div class="field wide"><label for="r-notes">Notes</label><textarea id="r-notes" name="notes" rows="2"></textarea></div>
      </div>
      <div id="rental-error"></div>
      <div class="form-actions"><button class="btn" type="submit">Create &amp; start scanning</button><button class="btn ghost" type="button" id="new-cancel">Cancel</button></div>
    </form>
    <div class="toolbar">
      <div class="tabs" id="rental-tabs"></div>
      <div class="grow"><input type="search" id="rental-q" placeholder="Search rentals…" aria-label="Search rentals"></div>
    </div>
    <div id="rental-list"></div>`);

  const form = $('#new-rental', el);
  $('#new-toggle', el).addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) $('#r-name', el).focus(); });
  $('#new-cancel', el).addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    try {
      const r = await api.post('/api/rentals', body);
      toast(`Rental "${r.name}" created`, 'ok');
      notifyChanged();
      location.hash = `#/rentals/${r.id}`;
    } catch (err) {
      mount($('#rental-error', el), html`<div class="error-box" style="margin-top:12px">${err.message}</div>`);
    }
  });

  async function load() {
    const [all, list] = await Promise.all([
      api.get('/api/rentals'),
      api.get('/api/rentals' + (s.status !== 'all' || s.q ? '?' : '') + new URLSearchParams({
        ...(s.status !== 'all' ? { status: s.status } : {}), ...(s.q ? { q: s.q } : {}) })),
    ]);
    if (!isActive()) return;
    const counts = { active: 0, completed: 0, all: all.length };
    all.forEach((r) => { counts[r.status]++; });
    mount($('#rental-tabs', el), html`${[['active', 'Active'], ['completed', 'Completed'], ['all', 'All']].map(([k, l]) =>
      html`<button class="tab" type="button" data-status="${k}" aria-pressed="${String(s.status === k)}">${l}<span class="count">${counts[k]}</span></button>`)}`);
    const today = app.meta.today;
    mount($('#rental-list', el), list.length ? html`<div class="table-wrap"><table class="data">
      <thead><tr><th>Rental</th><th>Customer</th><th>Dates</th><th class="num">Out</th><th class="num">Returned</th><th class="num">Lost</th><th>Status</th></tr></thead>
      <tbody>${list.map((r) => html`<tr class="clickable" data-id="${r.id}">
        <td><a href="#/rentals/${r.id}"><strong>${r.name}</strong></a></td>
        <td>${r.customer || ''}</td>
        <td class="nowrap">${r.start_date ? fmtDate(r.start_date) : '—'} → ${r.end_date ? fmtDate(r.end_date) : '—'}
          ${r.status === 'active' && r.end_date && r.end_date < today ? html` <span class="badge pat-bad"><span class="ico">✕</span>Past end date</span>` : ''}</td>
        <td class="num">${r.out_count}</td><td class="num">${r.returned_count}</td>
        <td class="num">${r.lost_count ? html`<span class="badge st-lost"><span class="ico">?</span>${r.lost_count}</span>` : 0}</td>
        <td>${r.status === 'active' ? html`<span class="badge st-rental"><span class="ico">●</span>Active</span>` : html`<span class="badge pat-na"><span class="ico">✓</span>Completed</span>`}</td>
      </tr>`)}</tbody></table></div>`
      : html`<div class="card"><div class="empty">${s.q ? 'No rentals match.' : s.status === 'active' ? 'No active rentals. Click “New rental” to create one.' : 'Nothing here.'}</div></div>`);
  }

  el.onclick = (e) => {
    const tab = e.target.closest('[data-status]');
    if (tab) { s.status = tab.dataset.status; load(); return; }
    const row = e.target.closest('tr[data-id]');
    if (row && !e.target.closest('a')) location.hash = `#/rentals/${row.dataset.id}`;
  };
  $('#rental-q', el).addEventListener('input', debounce((e) => { s.q = e.target.value.trim(); load(); }, 220));

  await load();
  return { refresh: load, destroy() { el.onclick = null; } };
}
