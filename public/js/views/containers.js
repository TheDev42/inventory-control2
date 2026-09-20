import { api, html, mount, $, debounce, toast, notifyChanged, plural } from '../util.js';
import { setInterceptor } from '../scanner.js';
import { play } from '../audio.js';

export default async function containersView({ el, isActive }) {
  let q = '';
  mount(el, html`
    <div class="page-head">
      <div><h1>Containers</h1><div class="sub">Cases, racks, shelves and bins. Every container has its own barcode; scan items into them from the container page.</div></div>
      <div class="actions"><button class="btn" id="new-toggle" type="button">New container</button></div>
    </div>
    <form id="new-container" class="card" hidden style="margin-bottom:16px">
      <h2>New container</h2>
      <div class="form-grid">
        <div class="field"><label for="c-barcode">Barcode *</label><input id="c-barcode" name="barcode" type="text" inputmode="numeric" required placeholder="e.g. 90001 (scan or type)" autocomplete="off"><span class="hint">You can scan straight into this page.</span></div>
        <div class="field"><label for="c-name">Name *</label><input id="c-name" name="name" type="text" required placeholder="e.g. Flightcase 12 – 16A leads"></div>
        <div class="field"><label for="c-location">Location</label><input id="c-location" name="location" type="text" placeholder="e.g. Warehouse, bay 3"></div>
        <div class="field wide"><label for="c-notes">Notes</label><textarea id="c-notes" name="notes" rows="2"></textarea></div>
      </div>
      <div id="container-error"></div>
      <div class="form-actions"><button class="btn" type="submit">Create container</button><button class="btn ghost" type="button" id="new-cancel">Cancel</button></div>
    </form>
    <div class="toolbar"><div class="grow"><input type="search" id="container-q" placeholder="Search containers…" aria-label="Search containers"></div></div>
    <div id="container-list"></div>`);

  const form = $('#new-container', el);
  const barcode = $('#c-barcode', el);
  $('#new-toggle', el).addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) barcode.focus(); });
  $('#new-cancel', el).addEventListener('click', () => { form.hidden = true; });

  // While the "new container" form is open, a scan fills the barcode field.
  setInterceptor(async (code) => {
    if (form.hidden) return false;
    barcode.value = code;
    play('lookup');
    $('#c-name', el).focus();
    return true;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const c = await api.post('/api/containers', Object.fromEntries(new FormData(form)));
      toast(`Container "${c.name}" created`, 'ok');
      notifyChanged();
      location.hash = `#/containers/${c.id}`;
    } catch (err) {
      mount($('#container-error', el), html`<div class="error-box" style="margin-top:12px">${err.message}</div>`);
    }
  });

  async function load() {
    const list = await api.get('/api/containers' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    if (!isActive()) return;
    mount($('#container-list', el), list.length ? html`<div class="table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>Barcode</th><th>Location</th><th class="num">Items</th></tr></thead>
      <tbody>${list.map((c) => html`<tr class="clickable" data-id="${c.id}">
        <td><a href="#/containers/${c.id}"><strong>${c.name}</strong></a></td>
        <td class="barcode">${c.barcode}</td><td>${c.location || ''}</td><td class="num">${c.item_count}</td></tr>`)}</tbody></table></div>`
      : html`<div class="card"><div class="empty">${q ? 'No containers match.' : 'No containers yet. Click “New container” and scan its barcode.'}</div></div>`);
  }
  el.onclick = (e) => {
    const row = e.target.closest('tr[data-id]');
    if (row && !e.target.closest('a')) location.hash = `#/containers/${row.dataset.id}`;
  };
  $('#container-q', el).addEventListener('input', debounce((e) => { q = e.target.value.trim(); load(); }, 220));

  await load();
  return { refresh: load, destroy() { el.onclick = null; } };
}
