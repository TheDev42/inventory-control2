import { api, html, mount, $, debounce, toast, notifyChanged, plural } from '../util.js';
import { setInterceptor } from '../scanner.js';
import { play } from '../audio.js';

const TABS = [['permanent', 'Permanent cases'], ['temporary', 'Temporary boxes'], ['all', 'All']];

export default async function containersView({ el, query, isActive }) {
  let q = '';
  let tab = TABS.some(([k]) => k === query.get('kind')) ? query.get('kind') : 'permanent';
  mount(el, html`
    <div class="page-head">
      <div><h1>Containers</h1><div class="sub">Cases and boxes. <strong>Permanent cases</strong> are the ones you always use (kept in your inventory); <strong>temporary boxes</strong> are one-offs made for a job. Every one has its own barcode.</div></div>
      <div class="actions"><button class="btn" id="new-toggle" type="button">New container</button></div>
    </div>
    <form id="new-container" class="card" hidden style="margin-bottom:16px">
      <h2>New container</h2>
      <div class="form-grid">
        <div class="field wide"><span class="lbl">Type</span>
          <label class="check"><input type="radio" name="kind" value="permanent" checked> <span><strong>Permanent case</strong> — one you always use; stays in your inventory</span></label>
          <label class="check"><input type="radio" name="kind" value="temporary"> <span><strong>Temporary box</strong> — a one-off for a job; just name it and it gets its own barcode</span></label></div>
        <div class="field"><label for="c-barcode">Barcode <span id="c-bc-req">*</span></label><input id="c-barcode" name="barcode" type="text" inputmode="numeric" required placeholder="e.g. 90001 (scan or type)" autocomplete="off"><span class="hint" id="c-bc-hint">You can scan straight into this page.</span></div>
        <div class="field"><label for="c-name">Name <span id="c-name-req">*</span></label><input id="c-name" name="name" type="text" required placeholder="e.g. Flightcase 12 – 16A leads"></div>
        <div class="field"><label for="c-location">Location</label><input id="c-location" name="location" type="text" placeholder="e.g. Warehouse, bay 3"></div>
        <div class="field wide"><label for="c-notes">Notes</label><textarea id="c-notes" name="notes" rows="2"></textarea></div>
      </div>
      <div id="container-error"></div>
      <div class="form-actions"><button class="btn" type="submit">Create container</button><button class="btn ghost" type="button" id="new-cancel">Cancel</button></div>
    </form>
    <div class="toolbar">
      <div class="tabs" id="container-tabs" style="margin:0"></div>
      <div class="grow"><input type="search" id="container-q" placeholder="Search containers…" aria-label="Search containers"></div>
      <button class="btn secondary small" id="clear-temp" type="button" hidden title="Delete temporary boxes that were used on a rental, are now empty and are not on an active rental">Clear finished temporary boxes</button>
    </div>
    <div id="container-list"></div>`);

  const form = $('#new-container', el);
  const barcode = $('#c-barcode', el);
  const nameInput = $('#c-name', el);
  const kindNow = () => form.querySelector('[name=kind]:checked').value;
  // A temporary box only needs a name (its barcode is made for it); a permanent case needs both
  const syncKind = () => {
    const temp = kindNow() === 'temporary';
    barcode.required = !temp;
    nameInput.required = !temp;
    $('#c-bc-req', el).textContent = temp ? '(optional)' : '*';
    $('#c-name-req', el).textContent = temp ? '(optional)' : '*';
    barcode.placeholder = temp ? 'leave blank to number it automatically (T0001…)' : 'e.g. 90001 (scan or type)';
    $('#c-bc-hint', el).textContent = temp ? 'Leave it blank and the box gets the next free T-number.' : 'You can scan straight into this page.';
  };
  form.addEventListener('change', (e) => { if (e.target.name === 'kind') syncKind(); });

  $('#new-toggle', el).addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) barcode.focus(); });
  $('#new-cancel', el).addEventListener('click', () => { form.hidden = true; });

  // While the "new container" form is open, a scan fills the barcode field.
  setInterceptor(async (code) => {
    if (form.hidden) return false;
    barcode.value = code;
    play('lookup');
    nameInput.focus();
    return true;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const c = await api.post('/api/containers', Object.fromEntries(new FormData(form)));
      toast(`${c.kind === 'temporary' ? 'Temporary box' : 'Container'} "${c.name}" created (${c.barcode})`, 'ok');
      notifyChanged();
      location.hash = `#/containers/${c.id}`;
    } catch (err) {
      mount($('#container-error', el), html`<div class="error-box" style="margin-top:12px">${err.message}</div>`);
    }
  });

  async function load() {
    const all = await api.get('/api/containers' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    if (!isActive()) return;
    const counts = { all: all.length, permanent: 0, temporary: 0 };
    all.forEach((c) => { counts[c.kind]++; });
    const list = tab === 'all' ? all : all.filter((c) => c.kind === tab);
    mount($('#container-tabs', el), html`${TABS.map(([k, l]) => html`<button class="tab" type="button" data-tab="${k}" aria-pressed="${String(tab === k)}">${l}<span class="count">${counts[k]}</span></button>`)}`);
    $('#clear-temp', el).hidden = tab === 'permanent' || !counts.temporary;
    const emptyText = q ? 'No containers match.'
      : tab === 'temporary' ? 'No temporary boxes. Make one from “New container”, or from a rental’s Cases panel.'
      : 'No containers yet. Click “New container” and scan its barcode.';
    mount($('#container-list', el), list.length ? html`<div class="table-wrap cards containers-table"><table class="data">
      <thead><tr><th>Name</th><th>Barcode</th><th>Location</th><th class="num">Items</th><th>Now</th></tr></thead>
      <tbody>${list.map((c) => html`<tr class="clickable" data-id="${c.id}">
        <td><a href="#/containers/${c.id}"><strong>${c.name}</strong></a>${c.kind === 'temporary' ? html` <span class="badge st-temp"><span class="ico">◷</span>Temporary</span>` : ''}</td>
        <td class="barcode">${c.barcode}</td><td>${c.location || ''}</td><td class="num">${c.item_count}</td>
        <td>${c.out_rental_id ? html`<span class="badge st-rental"><span class="ico">➜</span>Out</span> <a href="#/rentals/${c.out_rental_id}">${c.out_rental_name}</a>` : html`<span class="muted">Here</span>`}</td></tr>`)}</tbody></table></div>`
      : html`<div class="card"><div class="empty">${emptyText}</div></div>`);
  }
  el.onclick = async (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; load(); return; }
    if (e.target.closest('#clear-temp')) {
      if (!confirm('Delete every temporary box that was used on a rental, is now empty and is not on an active rental?')) return;
      try {
        const { removed } = await api.post('/api/containers/clear-temporary');
        toast(removed ? `Cleared ${plural(removed, 'temporary box', 'temporary boxes')}` : 'No finished temporary boxes to clear', removed ? 'ok' : 'info');
        notifyChanged();
      } catch (err) { toast(err.message, 'error', 5000); }
      return;
    }
    const row = e.target.closest('tr[data-id]');
    if (row && !e.target.closest('a')) location.hash = `#/containers/${row.dataset.id}`;
  };
  $('#container-q', el).addEventListener('input', debounce((e) => { q = e.target.value.trim(); load(); }, 220));

  await load();
  return { refresh: load, destroy() { el.onclick = null; } };
}
