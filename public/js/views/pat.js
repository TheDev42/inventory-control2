import { api, html, mount, $, qs, fmtDate, toast, notifyChanged, itemTitle, ends, patBadge, statusBadge } from '../util.js';
import { state as scanState, setMode } from '../scanner.js';

const TABS = [
  ['overdue', 'Overdue'], ['due_soon', 'Due in 30 days'], ['failed', 'Failed'], ['never', 'Never tested'], ['ok', 'PAT OK'], ['na', 'Not required'],
];

export default async function patView({ el, query, isActive }) {
  let status = TABS.some(([k]) => k === query.get('status')) ? query.get('status') : null;

  async function load() {
    const dash = await api.get('/api/dashboard');
    if (!isActive()) return;
    const counts = dash.pat;
    if (!status) status = TABS.find(([k]) => k !== 'ok' && k !== 'na' && counts[k] > 0)?.[0] || 'ok';
    const { items, total } = await api.get('/api/items' + qs({ pat: status, sort: 'next_pat', dir: 'asc', limit: 200 }));
    if (!isActive()) return;
    const scanning = scanState.mode === 'pat';

    mount(el, html`
      <div class="page-head">
        <div><h1>PAT testing</h1><div class="sub">Portable appliance tests: every item that needs one, when it was last done and when it is next due.</div></div>
      </div>

      <div class="notice">
        <div class="actions" style="justify-content:space-between">
          <span class="live-note"><span class="live-dot"></span>
            <span>${scanning
              ? html`<strong>PAT scan mode is on.</strong> Scan an item to record a <strong>${scanState.patResult === 'pass' ? 'PASS' : 'FAIL'}</strong> for today${scanState.tester ? html` by ${scanState.tester}` : ''}. Failed items are moved to Repair and blocked from rentals.`
              : html`Turn on PAT scan mode to test items by scanning their barcodes — pass/fail and tester are set in the scan bar.`}</span></span>
          <button class="btn ${scanning ? 'secondary' : ''}" data-act="${scanning ? 'stop' : 'start'}">${scanning ? 'Stop PAT scanning' : 'Start PAT scanning'}</button>
        </div>
      </div>

      <div class="toolbar">
        <div class="tabs" style="margin:0">${TABS.map(([k, l]) => html`<button class="tab" data-status="${k}" aria-pressed="${String(status === k)}">${l}<span class="count">${counts[k]}</span></button>`)}</div>
        <span class="grow"></span>
        <label class="ctx-field">Tester <input type="text" id="pat-tester" value="${scanState.tester}" placeholder="name" maxlength="60"></label>
      </div>

      ${items.length ? html`<div class="table-wrap"><table class="data">
        <thead><tr><th>Barcode</th><th>Type</th><th>Description</th><th>Ends</th><th>Status</th><th>PAT</th><th>Last test</th><th>Due</th><th></th></tr></thead>
        <tbody>${items.map((it) => html`<tr>
          <td><a class="barcode" href="#/items/${it.id}">${it.barcode}</a></td>
          <td>${itemTitle(it)}</td><td>${it.name || ''}</td><td>${ends(it)}</td>
          <td>${statusBadge(it.status)}</td><td>${patBadge(it.pat_status)}</td>
          <td class="nowrap">${it.last_pat_date ? fmtDate(it.last_pat_date) + (it.last_pat_result === 'fail' ? ' (fail)' : '') : '—'}</td>
          <td class="nowrap">${it.pat_status === 'na' ? '' : it.next_pat_due ? fmtDate(it.next_pat_due) : '—'}</td>
          <td class="nowrap right"><button class="btn secondary small" data-pat="pass" data-id="${it.id}">✓ Pass</button> <button class="btn danger small" data-pat="fail" data-id="${it.id}">✕ Fail</button></td>
        </tr>`)}</tbody></table></div>
        ${total > items.length ? html`<p class="muted" style="margin-top:8px">Showing the first ${items.length} of ${total}. Use the inventory page filters for the rest.</p>` : ''}`
        : html`<div class="card"><div class="empty">Nothing in this group.</div></div>`}`);
  }

  el.onclick = async (e) => {
    const tab = e.target.closest('[data-status]');
    if (tab) { status = tab.dataset.status; load(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'start') { setMode('pat'); load(); return; }
    if (act === 'stop') { setMode('lookup'); load(); return; }
    const b = e.target.closest('[data-pat]');
    if (b) {
      try {
        await api.post(`/api/items/${b.dataset.id}/pat`, { result: b.dataset.pat, tester: scanState.tester });
        toast(`PAT ${b.dataset.pat} recorded`, 'ok');
        notifyChanged();
      } catch (err) { toast(err.message, 'error', 5000); }
    }
  };
  el.onchange = (e) => {
    if (e.target.id === 'pat-tester') { scanState.tester = e.target.value.trim(); setMode(scanState.mode); }
  };

  await load();
  return { refresh: load, destroy() { el.onclick = null; el.onchange = null; } };
}
