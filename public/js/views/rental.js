import {
  api, html, mount, $, fmtDate, fmtDateTime, toast, notifyChanged, plural, itemTitle, ends, patBadge, statusBadge,
} from '../util.js';
import { app } from '../state.js';
import { state as scanState, setMode } from '../scanner.js';
import { errorBox } from '../ui.js';
import { createPicker } from './rentalPicker.js';

// What is this line of the rental right now?
const lineState = (it) => {
  if (it.outcome === 'returned') return 'returned';
  if (it.outcome === 'lost' || it.status === 'lost') return 'lost';
  return 'out';
};

export default async function rentalView({ el, args, isActive }) {
  const id = Number(args[0]);
  let filter = 'all';
  let editing = false;
  let entered = false;
  let picking = false;
  const picker = createPicker({ rentalId: id, onClose: () => { picking = false; load(); } });

  async function load() {
    let d;
    try { d = await api.get(`/api/rentals/${id}`); } catch (err) { if (isActive()) mount(el, errorBox(err)); return; }
    if (!isActive()) return;
    const { rental: r, items } = d;
    const active = r.status === 'active';

    // Opening an active rental puts the scanner into "scan OUT" for it (once), so scanning just works.
    if (active && !entered) { setMode('out', { rentalId: id }); }
    entered = true;

    const counts = { all: items.length, out: 0, returned: 0, lost: 0 };
    items.forEach((it) => { counts[lineState(it)]++; });
    const shown = filter === 'all' ? items : items.filter((it) => lineState(it) === filter);
    const overdue = active && r.end_date && r.end_date < app.meta.today;
    const scanningHere = scanState.rentalId === id;

    mount(el, html`
      <div class="crumbs"><a href="#/rentals">Rentals</a> / ${r.name}</div>
      <div class="page-head">
        <div>
          <h1>${r.name} ${active ? '' : html`<span class="badge pat-na" style="vertical-align:middle"><span class="ico">✓</span>Completed</span>`}</h1>
          <div class="sub">${r.customer ? html`${r.customer} · ` : ''}${r.start_date ? fmtDate(r.start_date) : 'no start date'} → ${r.end_date ? fmtDate(r.end_date) : 'no end date'}
            ${overdue ? html` <span class="badge pat-bad"><span class="ico">✕</span>Past end date</span>` : ''}</div>
          ${r.notes ? html`<div class="muted" style="margin-top:6px;white-space:pre-wrap">${r.notes}</div>` : ''}
        </div>
        <div class="actions">
          ${active ? html`<button class="btn" data-act="pick" aria-pressed="${String(picking)}" title="Pick items from the in-stock list instead of scanning">${picking ? 'Hide item picker' : 'Add items'}</button>` : ''}
          <a class="btn secondary" href="/api/rentals/${id}/pdf" download title="Internal hire sheet: barcodes, PAT dates and return tick-boxes">Internal PDF</a>
          <a class="btn secondary" href="/api/rentals/${id}/client-pdf" download title="Client copy: no barcodes or PAT dates, identical items combined into quantities">Client PDF</a>
          <button class="btn secondary" data-act="edit">Edit details</button>
          ${active ? html`<button class="btn secondary" data-act="complete">Complete rental</button>` : html`<button class="btn secondary" data-act="reopen">Reopen</button>`}
          <button class="btn danger" data-act="delete">Delete</button>
        </div>
      </div>

      ${editing ? html`<form id="edit-form" class="card" style="margin-bottom:16px">
        <div class="form-grid">
          <div class="field"><label for="e-name">Name *</label><input id="e-name" name="name" type="text" required value="${r.name}"></div>
          <div class="field"><label for="e-customer">Customer</label><input id="e-customer" name="customer" type="text" value="${r.customer || ''}"></div>
          <div class="field"><label for="e-start">Start date</label><input id="e-start" name="start_date" type="date" value="${r.start_date || ''}"></div>
          <div class="field"><label for="e-end">End date</label><input id="e-end" name="end_date" type="date" value="${r.end_date || ''}"></div>
          <div class="field wide"><label for="e-notes">Notes</label><textarea id="e-notes" name="notes" rows="2">${r.notes || ''}</textarea></div>
        </div>
        <div id="edit-error"></div>
        <div class="form-actions"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-act="edit">Cancel</button></div>
      </form>` : ''}

      ${active ? html`<div class="notice scan-notice">
        <div class="actions" style="justify-content:space-between">
          <span class="live-note"><span class="live-dot"></span>
            <span>Scanner is live on this page. ${scanningHere && scanState.mode === 'out' ? html`<strong>Scanning items OUT onto this rental.</strong> Unknown or unavailable items will beep and tell you why.`
              : scanningHere && scanState.mode === 'return' ? html`<strong>Scanning items back IN</strong> (returns to stock, works on any page).`
              : html`Scanner is currently in <strong>${scanState.mode}</strong> mode.`}</span></span>
          <span class="tabs" style="margin:0">
            <button class="tab" data-scan="out" aria-pressed="${String(scanningHere && scanState.mode === 'out')}">Scan OUT</button>
            <button class="tab" data-scan="return" aria-pressed="${String(scanState.mode === 'return')}">Scan IN (return)</button>
          </span>
        </div></div>` : html`<div class="notice warn">This rental is completed. Reopen it to add more items to it.</div>`}

      ${active && picking ? html`<div id="picker-host" style="margin-bottom:16px"></div>` : ''}

      <div class="kpis">
        <div class="kpi"><div class="label">Items on sheet</div><div class="value">${counts.all}</div></div>
        <div class="kpi"><div class="label"><span class="dot" style="--c:var(--s2)"></span>Still out</div><div class="value">${counts.out}</div></div>
        <div class="kpi"><div class="label"><span class="dot" style="--c:var(--s1)"></span>Returned</div><div class="value">${counts.returned}</div></div>
        <div class="kpi"><div class="label"><span class="dot" style="--c:var(--s5)"></span>Lost</div><div class="value">${counts.lost}</div></div>
      </div>

      <div class="tabs">${[['all', 'All'], ['out', 'Out'], ['returned', 'Returned'], ['lost', 'Lost']].map(([k, l]) =>
        html`<button class="tab" data-filter="${k}" aria-pressed="${String(filter === k)}">${l}<span class="count">${counts[k]}</span></button>`)}</div>

      ${shown.length ? html`<div class="table-wrap cards rental-lines"><table class="data">
        <thead><tr><th>Barcode</th><th>Type</th><th>Description</th><th>Ends</th><th>PAT</th><th>Status</th><th>Added</th><th></th></tr></thead>
        <tbody>${shown.map((it) => {
          const st = lineState(it);
          return html`<tr class="${st === 'lost' ? 'is-lost' : ''}">
            <td><a class="barcode" href="#/items/${it.id}">${it.barcode}</a></td>
            <td>${itemTitle(it)}</td><td>${it.name || ''}</td><td>${ends(it)}</td>
            <td>${patBadge(it.pat_status)}</td>
            <td>${st === 'returned' ? html`<span class="badge st-stock"><span class="ico">✓</span>Returned</span> <span class="muted small-text">${fmtDateTime(it.returned_at)}</span>`
              : st === 'lost' ? statusBadge('lost') : statusBadge('on_rental')}</td>
            <td class="nowrap muted small-text">${fmtDateTime(it.added_at)}</td>
            <td class="nowrap right">${st === 'out' ? html`<button class="btn secondary small" data-return="${it.id}">Return</button> <button class="btn ghost small" data-remove="${it.id}" title="Take it off this rental (undo a mistaken scan)">Remove</button>`
              : st === 'lost' && it.outcome === null ? html`<button class="btn secondary small" data-return="${it.id}">Found</button>` : ''}</td>
          </tr>`; })}</tbody></table></div>`
        : html`<div class="card"><div class="empty">${items.length ? 'Nothing in this view.' : active ? 'No items yet — scan a barcode, or use “Add items” to pick them from the list.' : 'No items were added to this rental.'}</div></div>`}`);

    if (active && picking) picker.mount($('#picker-host', el));
  }

  async function run(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg, 'ok'); notifyChanged(); } catch (err) { toast(err.message, 'error', 5000); }
  }

  el.onclick = async (e) => {
    const t = e.target;
    const scan = t.closest('[data-scan]');
    if (scan) { setMode(scan.dataset.scan, scan.dataset.scan === 'out' ? { rentalId: id } : {}); load(); return; }
    const f = t.closest('[data-filter]');
    if (f) { filter = f.dataset.filter; load(); return; }
    const ret = t.closest('[data-return]');
    if (ret) { run(() => api.post(`/api/items/${ret.dataset.return}/return`), 'Returned to stock'); return; }
    const rem = t.closest('[data-remove]');
    if (rem) { run(() => api.del(`/api/rentals/${id}/items/${rem.dataset.remove}`), 'Removed from rental'); return; }

    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'edit') { editing = !editing; load(); }
    else if (act === 'pick') {
      picking = !picking;
      await load();
      if (picking) { $('#picker-host', el)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); picker.focus(); }
    }
    else if (act === 'reopen') run(() => api.post(`/api/rentals/${id}/reopen`), 'Rental reopened');
    else if (act === 'complete') {
      const { items } = await api.get(`/api/rentals/${id}`);
      const stillOut = items.filter((it) => lineState(it) === 'out').length;
      const msg = stillOut
        ? `${plural(stillOut, 'item')} still out. Mark them all as returned and complete this rental?`
        : 'Complete this rental?';
      if (!confirm(msg)) return;
      run(async () => {
        await api.post(`/api/rentals/${id}/complete`, { returnAll: true });
        if (scanState.mode === 'out' && scanState.rentalId === id) setMode('lookup', { rentalId: null });
      }, 'Rental completed');
    } else if (act === 'delete') {
      if (!confirm('Delete this rental? This cannot be undone.')) return;
      try {
        await api.del(`/api/rentals/${id}`);
        toast('Rental deleted', 'ok');
        if (scanState.rentalId === id) setMode('lookup', { rentalId: null });
        notifyChanged();
        location.hash = '#/rentals';
      } catch (err) { toast(err.message, 'error', 5000); }
    }
  };

  el.onsubmit = async (e) => {
    e.preventDefault();
    if (e.target.id !== 'edit-form') return;
    try {
      await api.put(`/api/rentals/${id}`, Object.fromEntries(new FormData(e.target)));
      editing = false;
      toast('Saved', 'ok');
      notifyChanged();
    } catch (err) { mount($('#edit-error', el), html`<div class="error-box" style="margin-top:12px">${err.message}</div>`); }
  };

  await load();
  return { refresh: load, destroy() { el.onclick = null; el.onsubmit = null; } };
}
