import { api, html, mount, $, toast, notifyChanged, plural, normalizeBarcode } from '../util.js';
import { state as scanState, setMode } from '../scanner.js';
import { errorBox, itemsTable } from '../ui.js';
import { app } from '../state.js';

export default async function containerView({ el, args, isActive }) {
  const id = Number(args[0]);
  let editing = false;
  let entered = false;
  let label = null; // the "print label" form's values while it is open (kept here so a refresh never wipes what you typed)

  async function load() {
    let d;
    try { d = await api.get(`/api/containers/${id}`); } catch (err) { if (isActive()) mount(el, errorBox(err)); return; }
    if (!isActive()) return;
    const { container: c, items, onRental } = d;
    if (!entered) { setMode('store', { containerId: id }); entered = true; }
    const storing = scanState.mode === 'store' && scanState.containerId === id;
    const out = items.filter((i) => i.status === 'on_rental').length;

    mount(el, html`
      <div class="crumbs"><a href="#/containers">Containers</a> / ${c.name}</div>
      <div class="page-head">
        <div>
          <h1>${c.name} ${c.kind === 'temporary' ? html`<span class="badge st-temp" style="vertical-align:middle"><span class="ico">◷</span>Temporary box</span>` : ''}</h1>
          <div class="sub"><span class="barcode">${c.barcode}</span>${onRental ? html` · <span class="badge st-rental"><span class="ico">➜</span>Out</span> on <a href="#/rentals/${onRental.id}">${onRental.name}</a>` : ''}${c.location ? html` · ${c.location}` : ''} · ${plural(items.length, 'item')}${out ? ` (${out} out on rental)` : ''}</div>
          ${c.notes ? html`<div class="muted" style="margin-top:6px;white-space:pre-wrap">${c.notes}</div>` : ''}
        </div>
        <div class="actions">
          <button class="btn" data-act="label" aria-pressed="${String(!!label)}" title="Print a 4 x 6 inch label for this case: FaderUp logo, barcode and contents">Print label</button>
          <button class="btn secondary" data-act="edit">Edit</button>
          ${items.length ? html`<button class="btn secondary" data-act="empty">Empty container</button>` : ''}
          <button class="btn danger" data-act="delete">Delete</button>
        </div>
      </div>

      ${editing ? html`<form id="edit-form" class="card" style="margin-bottom:16px">
        <div class="form-grid">
          <div class="field"><label for="e-barcode">Barcode *</label><input id="e-barcode" name="barcode" type="text" required value="${c.barcode}"></div>
          <div class="field"><label for="e-name">Name *</label><input id="e-name" name="name" type="text" required value="${c.name}"></div>
          <div class="field"><label for="e-kind">Type</label><select id="e-kind" name="kind">
            <option value="permanent" ${c.kind === 'permanent' ? 'selected' : ''}>Permanent case (one you always use)</option>
            <option value="temporary" ${c.kind === 'temporary' ? 'selected' : ''}>Temporary box (a one-off)</option></select></div>
          <div class="field"><label for="e-loc">Location</label><input id="e-loc" name="location" type="text" value="${c.location || ''}"></div>
          <div class="field wide"><label for="e-notes">Notes</label><textarea id="e-notes" name="notes" rows="2">${c.notes || ''}</textarea></div>
        </div>
        <div id="edit-error"></div>
        <div class="form-actions"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-act="edit">Cancel</button></div>
      </form>` : ''}

      ${label ? html`<form id="label-form" class="card" style="margin-bottom:16px" autocomplete="off">
        <div class="card-head"><h2>Print label</h2><span class="muted small-text">4″ × 6″ · FaderUp logo, this case's barcode (${c.barcode}) and its contents</span></div>
        <div class="form-grid">
          <div class="field"><label for="l-client">Client</label><input id="l-client" name="client" type="text" maxlength="60" value="${label.client}"></div>
          <div class="field"><label for="l-event">Event</label><input id="l-event" name="event" type="text" maxlength="60" value="${label.event}"></div>
          <div class="field"><label for="l-date">Date</label><input id="l-date" name="date" type="date" value="${label.date}"></div>
          <div class="field"><label for="l-box">Box no.</label><input id="l-box" name="box" type="text" maxlength="20" placeholder="e.g. 2 of 3" value="${label.box}"></div>
          <div class="field wide"><label for="l-contents">Contents <span class="muted">— one line per kind of item; edit it freely</span></label>
            <textarea id="l-contents" name="contents" rows="8" spellcheck="false">${label.contents}</textarea>
            <div><button class="btn ghost small" type="button" data-act="label-reset">Reset from what is in the case</button></div>
            <span class="hint">Client, event and date are filled in when everything from this case is out on one rental.</span></div>
        </div>
        <div class="form-actions">
          <button class="btn" type="button" data-act="label-open">Open to print</button>
          <button class="btn secondary" type="button" data-act="label-download">Download PDF</button>
          <button class="btn ghost" type="button" data-act="label">Close</button>
        </div>
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
    else if (act === 'label') {
      if (label) { label = null; load(); return; }
      try { label = await api.get(`/api/containers/${id}/label-defaults`); } catch (err) { toast(err.message, 'error', 5000); return; }
      await load();
      $('#l-box', el)?.focus();
    } else if (act === 'label-reset') {
      try {
        label.contents = (await api.get(`/api/containers/${id}/label-defaults`)).contents;
        $('#l-contents', el).value = label.contents;
      } catch (err) { toast(err.message, 'error', 5000); }
    } else if (act === 'label-open' || act === 'label-download') {
      const p = new URLSearchParams({ client: label.client, event: label.event, date: label.date, box: label.box, contents: label.contents });
      if (act === 'label-download') {
        p.set('download', '1');
        const a = document.createElement('a');
        a.href = `/api/containers/${id}/label.pdf?${p}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else window.open(`/api/containers/${id}/label.pdf?${p}`, '_blank');
    } else if (act === 'empty') {
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
  // keep the label form's values in memory as you type
  el.oninput = (e) => { if (label && e.target.form?.id === 'label-form') label[e.target.name] = e.target.value; };
  // Typing the barcode by hand and tabbing/clicking away normalizes it (e.g. a 6-digit QR code becomes the
  // 5-digit barcode the system uses). focusout (not blur) so this delegated listener sees it.
  el.onfocusout = (e) => {
    if (e.target.id !== 'e-barcode') return;
    const code = normalizeBarcode(e.target.value.trim(), app.meta.barcodeDigits);
    if (code !== e.target.value) e.target.value = code;
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
  return { refresh: load, destroy() { el.onclick = null; el.onsubmit = null; el.oninput = null; el.onfocusout = null; } };
}
