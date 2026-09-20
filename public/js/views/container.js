import { api, html, mount, $, toast, notifyChanged, plural } from '../util.js';
import { state as scanState, setMode } from '../scanner.js';
import { errorBox, itemsTable } from '../ui.js';

export default async function containerView({ el, args, isActive }) {
  const id = Number(args[0]);
  let editing = false;
  let entered = false;

  async function load() {
    let d;
    try { d = await api.get(`/api/containers/${id}`); } catch (err) { if (isActive()) mount(el, errorBox(err)); return; }
    if (!isActive()) return;
    const { container: c, items } = d;
    if (!entered) { setMode('store', { containerId: id }); entered = true; }
    const storing = scanState.mode === 'store' && scanState.containerId === id;
    const out = items.filter((i) => i.status === 'on_rental').length;

    mount(el, html`
      <div class="crumbs"><a href="#/containers">Containers</a> / ${c.name}</div>
      <div class="page-head">
        <div>
          <h1>${c.name}</h1>
          <div class="sub"><span class="barcode">${c.barcode}</span>${c.location ? html` · ${c.location}` : ''} · ${plural(items.length, 'item')}${out ? ` (${out} out on rental)` : ''}</div>
          ${c.notes ? html`<div class="muted" style="margin-top:6px;white-space:pre-wrap">${c.notes}</div>` : ''}
        </div>
        <div class="actions">
          <button class="btn secondary" data-act="edit">Edit</button>
          ${items.length ? html`<button class="btn secondary" data-act="empty">Empty container</button>` : ''}
          <button class="btn danger" data-act="delete">Delete</button>
        </div>
      </div>

      ${editing ? html`<form id="edit-form" class="card" style="margin-bottom:16px">
        <div class="form-grid">
          <div class="field"><label for="e-barcode">Barcode *</label><input id="e-barcode" name="barcode" type="text" required value="${c.barcode}"></div>
          <div class="field"><label for="e-name">Name *</label><input id="e-name" name="name" type="text" required value="${c.name}"></div>
          <div class="field"><label for="e-loc">Location</label><input id="e-loc" name="location" type="text" value="${c.location || ''}"></div>
          <div class="field wide"><label for="e-notes">Notes</label><textarea id="e-notes" name="notes" rows="2">${c.notes || ''}</textarea></div>
        </div>
        <div id="edit-error"></div>
        <div class="form-actions"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-act="edit">Cancel</button></div>
      </form>` : ''}

      <div class="notice">
        <div class="actions" style="justify-content:space-between">
          <span class="live-note"><span class="live-dot"></span>
            <span>${storing ? html`<strong>Scanning items into this container.</strong> Scan a lost or disassembled item to recover it automatically.` : html`Scanner is in <strong>${scanState.mode}</strong> mode.`}</span></span>
          <button class="tab" style="background:var(--surface)" data-scan="store" aria-pressed="${String(storing)}">Scan items into ${c.name}</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Contents</h2>
          <span class="muted small-text">Scanning this container's barcode in Scan OUT mode adds everything in it to the rental.</span></div>
        ${itemsTable(items, {
          empty: 'Empty — scan items to put them in this container.',
          extraHead: [''],
          extra: (it) => [html`<button class="btn ghost small" data-remove="${it.id}">Remove</button>`],
          rowClass: (it) => (it.status === 'on_rental' ? 'is-out' : ''),
        })}
      </div>`);
  }

  async function run(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg, 'ok'); notifyChanged(); } catch (err) { toast(err.message, 'error', 5000); }
  }

  el.onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-scan]')) { setMode('store', { containerId: id }); load(); return; }
    const rem = t.closest('[data-remove]');
    if (rem) { run(() => api.post(`/api/items/${rem.dataset.remove}/unstore`), 'Removed from container'); return; }
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'edit') { editing = !editing; load(); }
    else if (act === 'empty') {
      if (confirm('Take every item out of this container? (They stay in inventory.)')) run(() => api.post(`/api/containers/${id}/empty`), 'Container emptied');
    } else if (act === 'delete') {
      if (!confirm('Delete this container? Its items stay in inventory but will no longer be in a container.')) return;
      try {
        await api.del(`/api/containers/${id}`);
        toast('Container deleted', 'ok');
        if (scanState.containerId === id) setMode('lookup', { containerId: null });
        notifyChanged();
        location.hash = '#/containers';
      } catch (err) { toast(err.message, 'error', 5000); }
    }
  };
  el.onsubmit = async (e) => {
    e.preventDefault();
    if (e.target.id !== 'edit-form') return;
    try {
      await api.put(`/api/containers/${id}`, Object.fromEntries(new FormData(e.target)));
      editing = false;
      toast('Saved', 'ok');
      notifyChanged();
    } catch (err) { mount($('#edit-error', el), html`<div class="error-box" style="margin-top:12px">${err.message}</div>`); }
  };

  await load();
  return { refresh: load, destroy() { el.onclick = null; el.onsubmit = null; } };
}
