import { api, html, mount, $, toast, notifyChanged, plural, normalizeBarcode } from '../util.js';
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

  // True (with a warning) when that code already belongs to another item
  async function warnIfTaken(code) {
    let exists = null;
    try { exists = await api.get(`/api/items/lookup/${encodeURIComponent(code)}`); } catch { /* not found is what we want */ }
    if (!exists || exists.id === editId) return false;
    play('warn');
    toast(`${code} is already in the system (${exists.category.toLowerCase()} ${exists.type})`, 'error', 5000);
    return true;
  }

  // Scanning while this page is open fills the barcode box (and warns if that code is already in the system).
  // Codes are normalized first (e.g. a 6-digit QR code "012345" becomes barcode "12345") so what lands in the
  // box, what gets checked for a clash, and what gets saved are always the same code.
  setInterceptor(async (code) => {
    code = normalizeBarcode(code, app.meta.barcodeDigits);
    if (!(await warnIfTaken(code))) { barcodeInput.value = code; play('lookup'); }
    return true;
  });

  // A scanner types the code and then presses Enter. Enter in the barcode box must NOT save the form: it just checks
  // the code and moves on to the next field (use the Save buttons to save).
  barcodeInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = normalizeBarcode(barcodeInput.value.trim(), app.meta.barcodeDigits);
    barcodeInput.value = code;
    if (code && await warnIfTaken(code)) { barcodeInput.select(); return; }
    if (code) play('lookup');
    $('[name=name]', form)?.focus();
  });

  // Typing the code by hand and tabbing/clicking away (no Enter) still gets it normalized before it's saved.
  barcodeInput.addEventListener('blur', () => {
    const code = normalizeBarcode(barcodeInput.value.trim(), app.meta.barcodeDigits);
    if (code !== barcodeInput.value) barcodeInput.value = code;
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
