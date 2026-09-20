import { api, html, mount, $, toast, notifyChanged, plural } from '../util.js';
import { app, refreshConnectors } from '../state.js';
import { setInterceptor } from '../scanner.js';
import { play } from '../audio.js';
import { itemFields, wireItemFields, readItemFields, errorBox } from '../ui.js';

export default async function itemFormView({ el, args, query }) {
  const editId = args[0] ? Number(args[0]) : null;
  let item = { barcode: query.get('barcode') || '' };
  if (editId) {
    try { item = (await api.get(`/api/items/${editId}`)).item; } catch (err) { mount(el, errorBox(err)); return; }
  }
  const containers = await api.get('/api/containers');
  let addedCount = 0;

  mount(el, html`
    <div class="crumbs"><a href="#/inventory">Inventory</a> / ${editId ? html`<a href="#/items/${editId}">${item.barcode}</a> / Edit` : 'New item'}</div>
    <div class="page-head"><h1>${editId ? 'Edit item' : 'Add item'}</h1></div>
    <form id="item-form" class="card" autocomplete="off">
      ${itemFields(item, { containers, isNew: !editId })}
      <div id="form-error"></div>
      <div class="form-actions">
        <button class="btn" type="submit" data-next="0">${editId ? 'Save changes' : 'Save'}</button>
        ${editId ? '' : html`<button class="btn secondary" type="submit" data-next="1">Save &amp; add another</button>`}
        <a class="btn ghost" href="${editId ? `#/items/${editId}` : '#/inventory'}">Cancel</a>
      </div>
    </form>`);

  const form = $('#item-form', el);
  wireItemFields(form);
  const barcodeInput = $('[name=barcode]', form);
  if (!editId) barcodeInput.focus();

  // Scanning while this page is open fills the barcode box (and warns if that code is already in the system).
  setInterceptor(async (code) => {
    let exists = null;
    try { exists = await api.get(`/api/items/lookup/${encodeURIComponent(code)}`); } catch { /* not found is what we want */ }
    if (exists && exists.id !== editId) {
      play('warn');
      toast(`${code} is already in the system (${exists.category.toLowerCase()} ${exists.type})`, 'error', 5000);
    } else {
      barcodeInput.value = code;
      play('lookup');
    }
    return true;
  });

  let submitter = null;
  form.addEventListener('click', (e) => { submitter = e.target.closest('button[type=submit]'); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = submitter?.dataset.next === '1';
    const body = readItemFields(form);
    $('#form-error', form).innerHTML = '';
    try {
      const saved = editId ? await api.put(`/api/items/${editId}`, body) : await api.post('/api/items', body);
      notifyChanged();
      refreshConnectors();
      if (editId) { toast('Saved', 'ok'); location.hash = `#/items/${editId}`; return; }
      if (next) {
        addedCount++;
        toast(`Saved ${saved.barcode} (${plural(addedCount, 'item')} added this session)`, 'ok');
        barcodeInput.value = '';
        barcodeInput.focus();
      } else {
        toast(`Saved ${saved.barcode}`, 'ok');
        location.hash = `#/items/${saved.id}`;
      }
    } catch (err) {
      mount($('#form-error', form), html`<div class="error-box" style="margin-top:12px">${err.message}</div>`);
    }
  });

  return {};
}
