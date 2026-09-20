import {
  api, html, mount, $, $$, fmtDate, fmtDateTime, toast, notifyChanged, plural, itemTitle, ends, patBadge, statusBadge,
} from '../util.js';
import { app } from '../state.js';
import { state as scanState, setMode } from '../scanner.js';
import { errorBox, caseOptions, newTempBox } from '../ui.js';
import { createPicker } from './rentalPicker.js';

// What is this line of the rental right now?
const lineState = (it) => {
  if (it.outcome === 'returned') return 'returned';
  if (it.outcome === 'lost' || it.status === 'lost') return 'lost';
  return 'out';
};

const tempBadge = html`<span class="badge st-temp"><span class="ico">◷</span>Temporary</span>`;

export default async function rentalView({ el, args, isActive }) {
  const id = Number(args[0]);
  let filter = 'all';
  let caseFilter = ''; // '' = every line, 'none' = lines not packed in a case, otherwise a case's container id
  let editing = false;
  let entered = false;
  let picking = false;
  const selected = new Set(); // ticked lines (item ids) waiting for "assign to case"
  let containers = []; // every case and box: both permanent and temporary ones can be chosen
  const picker = createPicker({ rentalId: id, onClose: () => { picking = false; load(); } });

  // The bar that appears when lines are ticked. Re-drawn on its own so ticking never re-renders (and scrolls) the page.
  function renderBulk() {
    const host = $('#bulk-host', el);
    if (!host) return;
    const n = selected.size;
    mount(host, n ? html`<div class="bulk-bar">
      <span><strong>${n}</strong> selected</span>
      <select id="bulk-case" aria-label="Case to pack the selected lines into">
        <option value="">Choose a case…</option><option value="__none">Take out of any case</option>${caseOptions(containers)}<option value="__new">+ New temporary box…</option>
      </select>
      <button class="btn small" type="button" data-act="bulk-assign">Assign to case</button>
      <button class="btn ghost small" type="button" data-act="bulk-clear">Clear</button>
    </div>` : html``);
    const all = $('#ln-all', el);
    if (all) {
      const boxes = $$('.ln-check', el);
      const on = boxes.filter((b) => b.checked).length;
      all.checked = boxes.length > 0 && on === boxes.length;
      all.indeterminate = on > 0 && on < boxes.length;
    }
  }

  async function load() {
    let d;
    try { [d, containers] = await Promise.all([api.get(`/api/rentals/${id}`), api.get('/api/containers')]); } catch (err) { if (isActive()) mount(el, errorBox(err)); return; }
    if (!isActive()) return;
    const { rental: r, items, cases } = d;
    const active = r.status === 'active';

    // Opening an active rental puts the scanner into "scan OUT" for it (once), so scanning just works.
    if (active && !entered) { setMode('out', { rentalId: id }); }
    entered = true;

    const counts = { all: items.length, out: 0, returned: 0, lost: 0 };
    items.forEach((it) => { counts[lineState(it)]++; });
    // forget ticks for lines that are no longer out, and a case filter for a case that is no longer on the rental
    const outIds = new Set(items.filter((it) => lineState(it) === 'out').map((it) => it.id));
    for (const n of [...selected]) if (!outIds.has(n)) selected.delete(n);
    if (caseFilter !== '' && caseFilter !== 'none' && !cases.some((c) => String(c.container_id) === caseFilter)) caseFilter = '';

    const byState = filter === 'all' ? items : items.filter((it) => lineState(it) === filter);
    const shown = byState.filter((it) => caseFilter === '' || (caseFilter === 'none' ? !it.case_id : it.case_id === Number(caseFilter)));
    const noCase = items.filter((it) => !it.case_id).length;
    const overdue = active && r.end_date && r.end_date < app.meta.today;
    const scanningHere = scanState.rentalId === id;
    const spare = containers.filter((c) => !cases.some((x) => x.container_id === c.id)); // cases not yet on this rental

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
          <a class="btn secondary" href="/api/rentals/${id}/pdf" download title="INTERNAL copy for staff: barcodes, PAT dates and return tick-boxes. Not for the client.">Internal PDF (staff)</a>
          <a class="btn secondary" href="/api/rentals/${id}/client-pdf" download title="CLIENT copy to give the customer: no barcodes or PAT dates, identical items combined into quantities">Client PDF (customer)</a>
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
            <span>Scanner is live on this page. ${scanningHere && scanState.mode === 'out' ? html`<strong>Scanning items OUT onto this rental.</strong> Scan a case OUT to put it on the rental with everything in it packed into it.`
              : scanningHere && scanState.mode === 'return' ? html`<strong>Scanning items back IN</strong> (returns each item to stock). A case scanned back only marks the <em>case</em> as back: scan every item in it individually.`
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

      ${active || cases.length ? html`<section class="card cases-panel">
        <div class="card-head"><h2>Cases</h2>
          <span class="muted small-text">Organise the shipment: pack lines into cases below. Your permanent cases and temporary boxes can both be used.${items.length ? ` ${noCase} of ${items.length} not in a case yet.` : ''}</span></div>
        ${cases.length ? html`<div class="case-list">${cases.map((c) => html`
          <div class="case-row ${caseFilter === String(c.container_id) ? 'on' : ''}">
            <div class="case-main"><a href="#/containers/${c.container_id}"><strong>${c.name}</strong></a> ${c.kind === 'temporary' ? tempBadge : ''} <span class="barcode small-text">${c.barcode}</span></div>
            <div class="case-meta">${plural(c.packed_count, 'item')} packed · ${c.returned_at ? 'case back' : 'with this rental'}</div>
            <div class="actions">
              <button class="btn ghost small" type="button" data-case-filter="${c.container_id}">${caseFilter === String(c.container_id) ? 'Show all' : 'Show items'}</button>
              ${active ? html`<a class="btn ghost small" href="/api/containers/${c.container_id}/label.pdf" target="_blank" rel="noopener" title="Print this case's 4 x 6 label (contents, client, event and box number filled in from this rental)">Label</a>
              <button class="btn ghost small" type="button" data-case-remove="${c.container_id}" title="Take this case off the rental (its items stay on the rental, just no longer packed in it)">Remove</button>` : ''}
            </div>
          </div>`)}</div>` : html`<div class="muted">No cases on this rental yet. Add one below, or pack lines into a case from the list.</div>`}
        ${active ? html`<div class="inline-form" style="margin-top:12px">
          <select id="case-add" aria-label="Add a case to this rental"><option value="">Add a case…</option>${caseOptions(spare)}</select>
          <button class="btn secondary small" type="button" data-act="case-add">Add case</button>
          <button class="btn secondary small" type="button" data-act="case-new">+ New temporary box</button>
        </div>` : ''}
      </section>` : ''}

      <div class="toolbar">
        <div class="tabs" style="margin:0">${[['all', 'All'], ['out', 'Out'], ['returned', 'Returned'], ['lost', 'Lost']].map(([k, l]) =>
          html`<button class="tab" data-filter="${k}" aria-pressed="${String(filter === k)}">${l}<span class="count">${counts[k]}</span></button>`)}</div>
        <span class="grow"></span>
        ${cases.length ? html`<label class="ctx-field">Case
          <select id="case-filter" aria-label="Show lines in this case">
            <option value="" ${caseFilter === '' ? 'selected' : ''}>All lines</option>
            <option value="none" ${caseFilter === 'none' ? 'selected' : ''}>Not in a case</option>
            ${cases.map((c) => html`<option value="${c.container_id}" ${caseFilter === String(c.container_id) ? 'selected' : ''}>${c.name}</option>`)}
          </select></label>` : ''}
      </div>
      <div id="bulk-host"></div>

      ${shown.length ? html`<div class="table-wrap cards rental-lines"><table class="data">
        <thead><tr><th class="ck">${active && counts.out ? html`<input type="checkbox" id="ln-all" aria-label="Tick every line that is still out">` : ''}</th><th>Barcode</th><th>Item</th><th>Ends</th><th>PAT</th><th>Status</th><th>Case</th><th></th></tr></thead>
        <tbody>${shown.map((it) => {
          const st = lineState(it);
          return html`<tr class="${st === 'lost' ? 'is-lost' : ''}">
            <td class="ck">${active && st === 'out' ? html`<input type="checkbox" class="ln-check" data-item="${it.id}" ${selected.has(it.id) ? 'checked' : ''} aria-label="Tick ${it.barcode}">` : ''}</td>
            <td><a class="barcode" href="#/items/${it.id}">${it.barcode}</a></td>
            <td><div class="cell-main">${itemTitle(it)}</div>${it.name ? html`<div class="cell-sub">${it.name}</div>` : ''}</td>
            <td>${ends(it)}</td>
            <td>${patBadge(it.pat_status)}</td>
            <td>${st === 'returned' ? html`<span class="badge st-stock"><span class="ico">✓</span>Returned</span><div class="cell-sub">${fmtDateTime(it.returned_at)}</div>`
              : html`${st === 'lost' ? statusBadge('lost') : statusBadge('on_rental')}<div class="cell-sub">since ${fmtDateTime(it.added_at)}</div>`}</td>
            <td>${active && st === 'out'
              ? html`<select class="case-select" data-case-for="${it.id}" aria-label="Case for ${it.barcode}"><option value="">— none —</option>${caseOptions(containers, it.case_id)}<option value="__new">+ New temporary box…</option></select>`
              : it.case_name ? html`${it.case_name}${it.case_kind === 'temporary' ? html` <span class="muted small-text">(temp)</span>` : ''}` : ''}</td>
            <td class="nowrap right">${st === 'out' ? html`<button class="btn secondary small" data-return="${it.id}">Return</button> <button class="btn ghost small" data-remove="${it.id}" title="Take it off this rental (undo a mistaken scan)">Remove</button>`
              : st === 'lost' && it.outcome === null ? html`<button class="btn secondary small" data-return="${it.id}">Found</button>` : ''}</td>
          </tr>`; })}</tbody></table></div>`
        : html`<div class="card"><div class="empty">${items.length ? 'Nothing in this view.' : active ? 'No items yet — scan a barcode, or use “Add items” to pick them from the list.' : 'No items were added to this rental.'}</div></div>`}`);

    renderBulk();
    if (active && picking) picker.mount($('#picker-host', el));
  }

  async function run(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg, 'ok'); notifyChanged(); } catch (err) { toast(err.message, 'error', 5000); }
  }

  // Pack lines into a case. `value` is a container id, "__new" (make a temporary box first), or ""/"__none" (take out of any case)
  async function assign(itemIds, value) {
    try {
      let caseId = null;
      if (value === '__new') {
        const box = await newTempBox();
        if (!box) { load(); return; } // cancelled: put the drop-down back
        caseId = box.id;
      } else if (value !== '' && value !== '__none') caseId = Number(value);
      const res = await api.put(`/api/rentals/${id}/case`, { itemIds, caseId });
      itemIds.forEach((n) => selected.delete(n));
      const name = caseId ? containers.find((c) => c.id === caseId)?.name : null;
      if (res.skipped.length) toast(`${res.assigned} packed, ${res.skipped.length} skipped (not out on this rental)`, 'error', 5000);
      else toast(caseId ? `${plural(res.assigned, 'item')} packed into ${name || 'the new box'}` : `${plural(res.assigned, 'item')} taken out of their case`, 'ok');
      notifyChanged();
    } catch (err) { toast(err.message, 'error', 5000); load(); }
  }

  el.onclick = async (e) => {
    const t = e.target;
    const scan = t.closest('[data-scan]');
    if (scan) { setMode(scan.dataset.scan, scan.dataset.scan === 'out' ? { rentalId: id } : {}); load(); return; }
    const f = t.closest('[data-filter]');
    if (f) { filter = f.dataset.filter; load(); return; }
    const cf = t.closest('[data-case-filter]');
    if (cf) { caseFilter = caseFilter === cf.dataset.caseFilter ? '' : cf.dataset.caseFilter; load(); return; }
    const cr = t.closest('[data-case-remove]');
    if (cr) {
      if (confirm('Take this case off the rental? Its items stay on the rental, just no longer packed in it.')) {
        run(() => api.del(`/api/rentals/${id}/cases/${cr.dataset.caseRemove}`), 'Case taken off the rental');
      }
      return;
    }
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
    } else if (act === 'case-add') {
      const v = $('#case-add', el).value;
      if (!v) { toast('Choose a case to add first', 'info'); return; }
      run(() => api.post(`/api/rentals/${id}/cases`, { caseId: Number(v) }), 'Case added to the rental');
    } else if (act === 'case-new') {
      run(async () => {
        const box = await newTempBox();
        if (box) await api.post(`/api/rentals/${id}/cases`, { caseId: box.id });
      }, 'Temporary box added to the rental');
    } else if (act === 'bulk-assign') {
      const v = $('#bulk-case', el).value;
      if (v === '') { toast('Choose a case first', 'info'); return; }
      assign([...selected], v);
    } else if (act === 'bulk-clear') {
      selected.clear();
      $$('.ln-check', el).forEach((b) => { b.checked = false; });
      renderBulk();
    } else if (act === 'reopen') run(() => api.post(`/api/rentals/${id}/reopen`), 'Rental reopened');
    else if (act === 'complete') {
      const { items } = await api.get(`/api/rentals/${id}`);
      const stillOut = items.filter((it) => lineState(it) === 'out').length;
      const msg = stillOut
        ? `${plural(stillOut, 'item')} ${stillOut === 1 ? 'has' : 'have'} not been returned. Completing this rental will mark ${stillOut === 1 ? 'it' : 'them'} as LOST. Complete the rental?`
        : 'Complete this rental?';
      if (!confirm(msg)) return;
      try {
        const res = await api.post(`/api/rentals/${id}/complete`, { markLost: true });
        if (scanState.mode === 'out' && scanState.rentalId === id) setMode('lookup', { rentalId: null });
        toast(res.marked_lost ? `Rental completed. ${plural(res.marked_lost, 'item')} not returned, marked lost` : 'Rental completed', res.marked_lost ? 'info' : 'ok', res.marked_lost ? 6000 : 3800);
        notifyChanged();
      } catch (err) { toast(err.message, 'error', 5000); }
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

  el.onchange = (e) => {
    const t = e.target;
    if (t.id === 'case-filter') { caseFilter = t.value; load(); return; }
    if (t.classList.contains('ln-check')) {
      const n = Number(t.dataset.item);
      if (t.checked) selected.add(n); else selected.delete(n);
      renderBulk();
    } else if (t.id === 'ln-all') {
      $$('.ln-check', el).forEach((b) => {
        b.checked = t.checked;
        const n = Number(b.dataset.item);
        if (t.checked) selected.add(n); else selected.delete(n);
      });
      renderBulk();
    } else if (t.dataset.caseFor) {
      assign([Number(t.dataset.caseFor)], t.value);
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
  return { refresh: load, destroy() { el.onclick = null; el.onchange = null; el.onsubmit = null; } };
}
