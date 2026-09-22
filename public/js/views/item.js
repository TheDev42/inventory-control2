import {
  api, html, mount, $, cap, fmtDate, fmtDateTime, timeAgo, toast, notifyChanged, itemTitle, ends, outputsOf, statusBadge, patBadge, statusLabel, ownerBadge,
} from '../util.js';
import { app } from '../state.js';
import { state as scanState } from '../scanner.js';
import { errorBox } from '../ui.js';

export default async function itemView({ el, args, isActive }) {
  const id = Number(args[0]);
  let it_status_is_repair = false; // remembered from the last render, for the delete-PAT-test confirmation

  async function load() {
    let d;
    try { d = await api.get(`/api/items/${id}`); } catch (err) { if (isActive()) mount(el, errorBox(err)); return; }
    if (!isActive()) return;
    const it = d.item;
    it_status_is_repair = it.status === 'repair';
    const missing = ['lost', 'disassembled', 'repair'].includes(it.status);
    const onRental = it.status === 'on_rental';
    const sold = it.status === 'sold';
    const canSell = ['in_stock', 'repair', 'disassembled'].includes(it.status);

    mount(el, html`
      <div class="crumbs"><a href="#/inventory">Inventory</a> / ${it.barcode}</div>
      <div class="card item-hero">
        <div>
          <div class="code">${it.barcode}</div>
          <div style="font-size:1.1rem;font-weight:650;margin-top:2px">${itemTitle(it)}${it.name ? html` <span class="muted">— ${it.name}</span>` : ''}</div>
          <div style="margin-top:8px" class="actions">${statusBadge(it.status)} ${sold ? '' : patBadge(it.pat_status)} ${ownerBadge(it)} ${ends(it)}</div>
          <div class="muted" style="margin-top:8px">
            ${it.rental_id ? html`${it.status === 'lost' ? 'Lost on' : 'Out on'} rental <a href="#/rentals/${it.rental_id}">${it.rental_name}</a>. ` : ''}
            ${it.container_id ? html`Stored in <a href="#/containers/${it.container_id}">${it.container_name}</a> (${it.container_barcode}). ` : ''}
            ${!it.rental_id && !it.container_id && it.status === 'in_stock' ? html`In stock, not in a container${it.location ? html` — 📍 ${it.location}` : ''}.` : ''}
            ${it.location && (it.rental_id || it.container_id) ? html` (Recorded location: ${it.location})` : ''}
          </div>
        </div>
        <div class="actions">
          <a class="btn secondary" href="#/items/${it.id}/edit">Edit</a>
          ${onRental ? html`<button class="btn" data-act="return">Return to stock</button>` : ''}
          ${it.container_id ? html`<button class="btn secondary" data-act="unstore">Remove from container</button>` : ''}
          ${sold ? html`<button class="btn" data-marker="in_stock">Undo sale</button>` : ''}
          ${missing ? html`<button class="btn" data-marker="in_stock">Restore to stock</button>` : ''}
          ${!sold && it.status !== 'lost' ? html`<button class="btn secondary" data-marker="lost">Mark lost</button>` : ''}
          ${!sold && !['disassembled', 'on_rental'].includes(it.status) ? html`<button class="btn secondary" data-marker="disassembled">Mark disassembled</button>` : ''}
          ${!sold && !['repair', 'on_rental'].includes(it.status) ? html`<button class="btn secondary" data-marker="repair">Mark repair</button>` : ''}
          ${canSell ? html`<button class="btn secondary" data-marker="sold" title="Keeps it on the register, but it can no longer be scanned in or out">Mark as sold</button>` : ''}
        </div>
      </div>
      ${sold ? html`<div class="notice warn" style="margin-top:16px"><strong>Sold.</strong> This item stays on the inventory register for your records, but it cannot be scanned in or out, added to a rental, stored in a container or PAT tested. Use <strong>Undo sale</strong> if that was a mistake.</div>` : ''}

      <div class="grid side" style="margin-top:16px">
        <div class="stack">
          <section class="card">
            <h2>Comments &amp; markers</h2>
            <form id="comment-form" class="stack" style="gap:8px;margin-bottom:12px">
              <textarea name="text" rows="2" placeholder="Leave a note — e.g. “Sheath damaged near the female end”, “Left at the Oakwood venue”…" aria-label="New comment" required></textarea>
              <div><button class="btn" type="submit">Add comment</button></div>
            </form>
            ${d.comments.length ? html`<ul class="thread">${d.comments.map((c) => html`
              <li class="${c.kind}">
                <div class="meta">${c.kind === 'marker' ? html`<span class="badge st-dis"><span class="ico">⚑</span>Marker</span>` : 'Comment'} · ${fmtDateTime(c.created_at)}
                  ${c.kind === 'comment' ? html`<button class="btn ghost small" data-del-comment="${c.id}" title="Delete comment">Delete</button>` : ''}</div>
                <div class="body">${c.text}</div>
              </li>`)}</ul>` : html`<div class="empty">No comments yet.</div>`}
          </section>

          <section class="card">
            <h2>Rental history</h2>
            ${d.rentals.length ? html`<div class="table-wrap"><table class="data">
              <thead><tr><th>Rental</th><th>Out</th><th>Back</th><th>Outcome</th></tr></thead>
              <tbody>${d.rentals.map((r) => html`<tr>
                <td><a href="#/rentals/${r.rental_id}">${r.rental_name}</a>${r.customer ? html` <span class="muted">· ${r.customer}</span>` : ''}</td>
                <td class="nowrap">${fmtDateTime(r.added_at)}</td><td class="nowrap">${fmtDateTime(r.returned_at)}</td>
                <td>${r.outcome === 'returned' ? 'Returned' : r.outcome === 'lost' ? 'Lost' : 'Still out'}</td></tr>`)}</tbody></table></div>`
              : html`<div class="empty">Never been out on a rental.</div>`}
          </section>

          <section class="card">
            <h2>Activity</h2>
            ${d.events.length ? html`<ul class="feed">${d.events.map((e) => html`<li><span class="what">${e.detail}</span><span class="when">${timeAgo(e.ts)}</span></li>`)}</ul>` : html`<div class="empty">No activity.</div>`}
          </section>
        </div>

        <div class="stack">
          <section class="card">
            <h2>Details</h2>
            <dl class="dl">
              <dt>Category</dt><dd>${cap(it.category)}</dd>
              <dt>Type</dt><dd>${cap(it.type)}</dd>
              <dt>Description</dt><dd>${it.name || '—'}</dd>
              <dt>Owner</dt><dd>${app.meta.ownerLabels[it.owner] || it.owner}</dd>
              <dt>Location</dt><dd>${it.location || '—'}</dd>
              ${app.meta.connectorTypes.includes(it.type) ? html`
                <dt>Male end</dt><dd>${it.male_connector || '—'}</dd>
                <dt>Female end</dt><dd>${it.female_connector || '—'}</dd>` : ''}
              ${app.meta.outputTypes.includes(it.type) ? html`
                <dt>Input (in)</dt><dd>${it.input_connector || '—'}</dd>
                <dt>Outputs (out)</dt><dd>${outputsOf(it).length ? html`<ul class="plain">${outputsOf(it).map((o) => html`<li><strong>${o.qty}×</strong> ${o.connector}</li>`)}</ul>` : '—'}</dd>` : ''}
              <dt>Length</dt><dd>${it.length_m != null ? `${it.length_m} m` : '—'}</dd>
              <dt>Cost</dt><dd>${it.cost != null ? `£${it.cost.toFixed(2)}` : '—'}</dd>
              <dt>Added</dt><dd>${fmtDate(it.created_at)}</dd>
            </dl>
          </section>

          ${sold ? html`<section class="card"><h2>PAT testing</h2><p class="muted" style="margin:0">Sold items are not PAT tested.${it.last_pat_date ? html` Last test before sale: ${fmtDate(it.last_pat_date)} (${it.last_pat_result === 'pass' ? 'pass' : 'FAIL'}).` : ''}</p></section>` : html`<section class="card">
            <h2>PAT testing</h2>
            <dl class="dl" style="margin-bottom:12px">
              <dt>Status</dt><dd>${patBadge(it.pat_status)}</dd>
              <dt>Required</dt><dd>${it.pat_required ? `Yes, every ${it.pat_interval_months} months` : 'No'}</dd>
              <dt>Last test</dt><dd>${it.last_pat_date ? html`${fmtDate(it.last_pat_date)} (${it.last_pat_result === 'pass' ? 'pass' : 'FAIL'})` : 'Never'}</dd>
              <dt>Next due</dt><dd>${it.next_pat_due && it.pat_required ? fmtDate(it.next_pat_due) : '—'}</dd>
            </dl>
            <form id="pat-form" class="stack" style="gap:8px">
              <div class="inline-form">
                <div class="field"><label for="pat-result">Result</label><select id="pat-result" name="result"><option value="pass">Pass</option><option value="fail">Fail</option></select></div>
                <div class="field"><label for="pat-date">Date</label><input id="pat-date" name="date" type="date" value="${app.meta.today}"></div>
              </div>
              <div class="field"><label for="pat-tester">Tester</label><input id="pat-tester" name="tester" type="text" value="${scanState.tester}" maxlength="60"></div>
              <div class="field"><label for="pat-notes">Notes</label><input id="pat-notes" name="notes" type="text" placeholder="optional"></div>
              <div><button class="btn secondary" type="submit">Record PAT test</button></div>
            </form>
            ${d.pat_tests.length ? html`<h3 style="margin:16px 0 6px">History</h3><ul class="feed">${d.pat_tests.map((t) => html`
              <li><span class="what"><strong>${t.result === 'pass' ? '✓ Pass' : '✕ Fail'}</strong> · ${fmtDate(t.tested_at)}${t.tester ? html` · ${t.tester}` : ''}${t.notes ? html`<div class="muted small-text">${t.notes}</div>` : ''}</span>
              <span class="when">${t.next_due ? 'due ' + fmtDate(t.next_due) : ''}</span>
              <button class="btn ghost small" data-del-pat="${t.id}" title="Delete this PAT test">Delete</button></li>`)}</ul>` : ''}
          </section>`}

          <section class="card"><h2>Danger zone</h2>
            <button class="btn danger" data-act="delete" ${it.rental_id ? 'disabled title="Return it from its rental first"' : ''}>Delete this item</button>
          </section>
        </div>
      </div>`);
  }

  async function run(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg, 'ok'); notifyChanged(); } catch (err) { toast(err.message, 'error', 5000); }
  }

  el.onclick = (e) => {
    const marker = e.target.closest('[data-marker]');
    if (marker) {
      const status = marker.dataset.marker;
      const undoSale = status === 'in_stock' && marker.textContent.trim() === 'Undo sale';
      const question = undoSale ? 'Undo the sale and put it back in stock — add a note (optional):'
        : status === 'in_stock' ? 'Restore to stock — add a note (optional):'
        : status === 'sold' ? 'Mark as SOLD — it stays on the register but can no longer be scanned in or out. Add a note (who to, price, date…) (optional):'
        : `Mark as ${statusLabel(status).toUpperCase()} — add a note (optional):`;
      const note = prompt(question, '');
      if (note === null) return;
      run(() => api.post(`/api/items/${id}/marker`, { status, note }), undoSale ? 'Sale undone — back in stock' : status === 'in_stock' ? 'Restored to stock' : `Marked ${statusLabel(status).toLowerCase()}`);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'return') run(() => api.post(`/api/items/${id}/return`), 'Returned to stock');
    if (act === 'unstore') run(() => api.post(`/api/items/${id}/unstore`), 'Removed from container');
    if (act === 'delete' && confirm('Delete this item permanently, including its comments and PAT history?')) {
      api.del(`/api/items/${id}`).then(() => { toast('Item deleted', 'ok'); notifyChanged(); location.hash = '#/inventory'; }).catch((err) => toast(err.message, 'error', 5000));
    }
    const delPat = e.target.closest('[data-del-pat]');
    if (delPat) {
      const t = delPat.closest('li').querySelector('.what').textContent.replace(/\s+/g, ' ').trim();
      const failWarn = it_status_is_repair ? ' The item is in REPAIR; deleting the test does not move it back, so restore it yourself if that was a mistake.' : '';
      if (confirm(`Delete this PAT test (${t})? The item's last test and due date are recalculated from the tests that remain.${failWarn}`)) {
        run(() => api.del(`/api/items/${id}/pat/${delPat.dataset.delPat}`), 'PAT test deleted');
      }
      return;
    }
    const del = e.target.closest('[data-del-comment]');
    if (del && confirm('Delete this comment?')) run(() => api.del(`/api/comments/${del.dataset.delComment}`));
  };

  el.onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.id === 'comment-form') {
      run(() => api.post(`/api/items/${id}/comments`, { text: f.text.value }), 'Comment added');
    } else if (f.id === 'pat-form') {
      scanState.tester = f.tester.value.trim();
      run(() => api.post(`/api/items/${id}/pat`, { result: f.result.value, date: f.date.value, tester: f.tester.value, notes: f.notes.value }),
        `PAT ${f.result.value === 'pass' ? 'pass' : 'fail'} recorded`);
    }
  };

  await load();
  return { refresh: load, destroy() { el.onclick = null; el.onsubmit = null; } };
}
