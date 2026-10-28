import { api, html, raw, $, esc, cap, itemTitle, ends, outputsOf, statusBadge, patBadge, fmtDate } from './util.js';
import { app } from './state.js';

/* ---------- shared item form fields (used by new/edit item and bulk add) ---------- */

export const connectorDatalist = () =>
  html`<datalist id="connector-list">${app.meta.connectors.map((c) => html`<option value="${c}"></option>`)}</datalist>`;

// Which extra boxes a type gets: 'ends' (male + female connector), 'outputs' (distro-style) or 'none'
export const typeFields = (category, type) => app.meta.typeFields[`${category}/${type}`] || 'none';

const SECOND_ADD = '+ Add a second category and type';
const SECOND_REMOVE = '✕ Remove the second category';

const typeOptions = (category, selected) =>
  html`${(app.meta.catalog[category] || []).map((t) => html`<option value="${t}" ${t === selected ? 'selected' : ''}>${cap(t)}</option>`)}`;

// One output line of a distro: how many of which connector
const outputRow = (o = { qty: 1, connector: '' }) => html`<div class="output-row">
  <input type="number" name="out_qty" min="1" max="99" value="${o.qty}" inputmode="numeric" aria-label="Quantity">
  <span class="times" aria-hidden="true">×</span>
  <input type="text" name="out_connector" list="connector-list" value="${o.connector}" placeholder="e.g. 16A Cee (blue)" aria-label="Output connector">
  <button class="btn ghost small" type="button" data-remove-output aria-label="Remove this output">✕</button>
</div>`;

// What a product is called in the pick-list: its name, its type and its ends / length, so look-alikes can be told apart
const productText = (p) => [p.label, `${cap(p.template.category)} ${p.template.type}`, p.details].filter(Boolean).join(' · ');

// unitFields: false leaves out what belongs to one particular item (owner, location) — for editing a whole product
export function itemFields(item = {}, { barcode = true, containers = [], isNew = false, productPicker = false, unitFields = true } = {}) {
  const category = item.category || Object.keys(app.meta.catalog)[0];
  const type = item.type || (app.meta.catalog[category] || [])[0];
  const hasEnds = typeFields(category, type) === 'ends';
  const isDistro = typeFields(category, type) === 'outputs';
  const outs = outputsOf(item);
  const second = !!item.category2;
  const category2 = item.category2 || category;
  const patRequired = item.pat_required === undefined ? !(category === 'SOUND' && type === 'cable') : !!item.pat_required;
  return html`
    ${connectorDatalist()}
    <div class="form-grid" data-item-fields data-auto-pat="${isNew ? '1' : ''}">
      ${productPicker ? html`<div class="field wide product-pick"><label for="f-product">Product</label>
        <input id="f-product" type="search" list="product-list" data-product-pick autocomplete="off" placeholder="Start typing a product you already have, e.g. 10m 16A…">
        <datalist id="product-list"></datalist>
        <span class="hint">Pick an existing product and every detail below is filled in from it (you can still change any of them). Leave it blank for something new.</span></div>` : ''}
      ${barcode ? html`<div class="field"><label for="f-barcode">Barcode *</label>
        <input id="f-barcode" name="barcode" type="text" inputmode="numeric" required autocomplete="off" value="${item.barcode || ''}" placeholder="e.g. 00001 (scan or type)">
        <span class="hint">You can scan straight into this page.</span></div>` : ''}
      <div class="field"><label for="f-category">Category *</label>
        <select id="f-category" name="category">${Object.keys(app.meta.catalog).map((c) => html`<option ${c === category ? 'selected' : ''}>${c}</option>`)}</select></div>
      <div class="field"><label for="f-type">Type *</label>
        <select id="f-type" name="type">${typeOptions(category, type)}</select></div>
      <div class="field" data-second ${second ? '' : 'hidden'}><label for="f-category2">Second category</label>
        <select id="f-category2" name="category2">${Object.keys(app.meta.catalog).map((c) => html`<option ${c === category2 ? 'selected' : ''}>${c}</option>`)}</select></div>
      <div class="field" data-second ${second ? '' : 'hidden'}><label for="f-type2">Second type</label>
        <select id="f-type2" name="type2">${typeOptions(category2, item.type2)}</select></div>
      <div class="field"><span class="lbl">Two categories?</span>
        <div><button class="btn secondary small" type="button" data-toggle-second>${second ? SECOND_REMOVE : SECOND_ADD}</button></div></div>
      <div class="field"><label for="f-name">Description</label>
        <input id="f-name" name="name" type="text" value="${item.name || ''}" placeholder="e.g. 10m 16A extension"></div>
      <div class="field" data-ends ${hasEnds ? '' : 'hidden'}><label for="f-male">Male end (connector)</label>
        <input id="f-male" name="male_connector" type="text" list="connector-list" value="${item.male_connector || ''}" placeholder="e.g. 16A Cee (blue)"></div>
      <div class="field" data-ends ${hasEnds ? '' : 'hidden'}><label for="f-female">Female end (connector)</label>
        <input id="f-female" name="female_connector" type="text" list="connector-list" value="${item.female_connector || ''}" placeholder="e.g. 13A (BS1363)"></div>
      <div class="field" data-distro ${isDistro ? '' : 'hidden'}><label for="f-input">Input connector (in)</label>
        <input id="f-input" name="input_connector" type="text" list="connector-list" value="${item.input_connector || ''}" placeholder="e.g. 32A Cee (blue)"></div>
      <div class="field wide" data-distro ${isDistro ? '' : 'hidden'}><span class="lbl">Outputs (out)</span>
        <div class="outputs" data-outputs>${(outs.length ? outs : [undefined]).map((o) => outputRow(o))}</div>
        <div><button class="btn secondary small" type="button" data-add-output>+ Add another output</button></div>
        <span class="hint">One line per kind of connector, with how many there are — e.g. 6 × 16A Cee (blue) and 2 × 13A.</span></div>
      ${unitFields ? html`<div class="field"><label for="f-owner">Owner</label>
        <select id="f-owner" name="owner">${app.meta.owners.map((o) => html`<option value="${o}" ${(item.owner || 'company') === o ? 'selected' : ''}>${app.meta.ownerLabels[o]}</option>`)}</select></div>` : ''}
      <div class="field"><label for="f-length">Length (m)</label>
        <input id="f-length" name="length_m" type="number" step="0.01" min="0" value="${item.length_m ?? ''}"></div>
      <div class="field"><span class="lbl">PAT testing</span>
        <label class="check"><input type="checkbox" name="pat_required" ${patRequired ? 'checked' : ''}> PAT test required</label></div>
      <div class="field"><label for="f-interval">PAT interval (months)</label>
        <input id="f-interval" name="pat_interval_months" type="number" min="1" max="120" value="${item.pat_interval_months || 12}"></div>
      ${containers.length || item.container_id ? html`<div class="field"><label for="f-container">Container</label>
        <select id="f-container" name="container_id"><option value="">— none —</option>
        ${containers.map((c) => html`<option value="${c.id}" ${c.id === item.container_id ? 'selected' : ''}>${c.name} (${c.barcode})</option>`)}</select></div>` : ''}
      ${unitFields ? html`<div class="field"><label for="f-location">Location</label>
        <input id="f-location" name="location" type="text" value="${item.location || ''}" placeholder="e.g. North Yard">
        <span class="hint">Where this item is kept if it's not in a container — e.g. loose stock at another yard.</span></div>` : ''}
      <div class="field"><label for="f-cost">Cost (£)</label>
        <input id="f-cost" name="cost" type="number" step="0.01" min="0" value="${item.cost ?? ''}" placeholder="e.g. 45.00">
        <span class="hint">What it cost to buy. Only shown on this item's Details tab — never in the inventory list.</span></div>
      <div class="field"><label for="f-weight">Weight (kg)</label>
        <input id="f-weight" name="weight_kg" type="number" step="0.01" min="0" value="${item.weight_kg ?? ''}" placeholder="e.g. 2.5">
        <span class="hint">What one of these weighs. Added up into the NET weight printed on a case label.</span></div>
      <div class="field"><label for="f-power">Power consumption (W)</label>
        <input id="f-power" name="power_w" type="number" step="any" min="0" value="${item.power_w ?? ''}" placeholder="e.g. 150">
        <span class="hint">What one of these draws when running, in watts. Added up into a rental's power total.</span></div>
    </div>`;
}

// Fills the item fields from a product's details (category, type, connectors… down to weight and power).
// Owner, location and container belong to the one item being added, so they are left as they are.
export function fillItemFields(box, t) {
  const f = (n) => box.querySelector(`[name=${n}]`);
  const fire = (el) => el.dispatchEvent(new Event('change', { bubbles: true }));
  const cat = f('category');
  if (app.meta.catalog[t.category]) { cat.value = t.category; fire(cat); }
  const type = f('type');
  if ((app.meta.catalog[t.category] || []).includes(t.type)) { type.value = t.type; fire(type); }
  // second category: shown and set, or hidden
  const cat2 = f('category2');
  const showSecond = !!(t.category2 && app.meta.catalog[t.category2]);
  box.querySelectorAll('[data-second]').forEach((el) => { el.hidden = !showSecond; });
  const toggle = box.querySelector('[data-toggle-second]');
  if (toggle) toggle.textContent = showSecond ? SECOND_REMOVE : SECOND_ADD;
  if (showSecond) { cat2.value = t.category2; fire(cat2); f('type2').value = t.type2 || ''; }
  for (const n of ['name', 'male_connector', 'female_connector', 'input_connector', 'length_m', 'cost', 'weight_kg', 'power_w']) {
    if (f(n)) f(n).value = t[n] ?? '';
  }
  f('pat_required').checked = !!t.pat_required;
  f('pat_interval_months').value = t.pat_interval_months || 12;
  const outs = box.querySelector('[data-outputs]');
  if (outs) {
    const list = outputsOf(t);
    outs.innerHTML = (list.length ? list : [undefined]).map((o) => outputRow(o).toString()).join('');
  }
}

// Centre-crops whatever is chosen to a square and shrinks it, so item/category tiles always line up
// and the database only ever holds a small picture.
export async function squareDataUrl(file, size = 640) {
  if (!file.type.startsWith('image/')) throw new Error('That file is not a picture');
  if (file.size > 25 * 1024 * 1024) throw new Error('That picture is too big to work with (25 MB max)');
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(size, side);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  let url = canvas.toDataURL('image/webp', 0.85);
  if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', 0.85);
  if (url.length > 2_600_000) throw new Error('That picture will not compress small enough — try a smaller one');
  return url;
}

// Keeps the type list, connector fields and PAT default in sync with the chosen category / type
export function wireItemFields(root) {
  const box = $('[data-item-fields]', root);
  if (!box) return;
  const cat = $('[name=category]', box);
  const type = $('[name=type]', box);
  const pat = $('[name=pat_required]', box);
  const sync = (rebuild) => {
    if (rebuild) {
      const list = app.meta.catalog[cat.value] || [];
      const keep = list.includes(type.value) ? type.value : list[0];
      type.innerHTML = list.map((t) => `<option value="${esc(t)}">${esc(cap(t))}</option>`).join('');
      type.value = keep ?? '';
    }
    const hasEnds = typeFields(cat.value, type.value) === 'ends';
    box.querySelectorAll('[data-ends]').forEach((f) => { f.hidden = !hasEnds; });
    const isDistro = typeFields(cat.value, type.value) === 'outputs';
    box.querySelectorAll('[data-distro]').forEach((f) => { f.hidden = !isDistro; });
    if (box.dataset.autoPat) pat.checked = !(cat.value === 'SOUND' && type.value === 'cable');
  };
  cat.addEventListener('change', () => sync(true));

  // Second category + type, for items that belong in two places: shown by the button, hidden again to remove it
  const cat2 = $('[name=category2]', box);
  const type2 = $('[name=type2]', box);
  cat2.addEventListener('change', () => {
    type2.innerHTML = (app.meta.catalog[cat2.value] || []).map((t) => `<option value="${esc(t)}">${esc(cap(t))}</option>`).join('');
  });
  $('[data-toggle-second]', box).addEventListener('click', (e) => {
    const show = cat2.closest('[data-second]').hidden;
    box.querySelectorAll('[data-second]').forEach((f) => { f.hidden = !show; });
    e.currentTarget.textContent = show ? SECOND_REMOVE : SECOND_ADD;
    if (show) cat2.focus();
  });
  type.addEventListener('change', () => sync(false));

  // Product: choosing one from the list fills in all of its details
  const pick = $('[data-product-pick]', box);
  if (pick) {
    const byText = new Map();
    api.get('/api/products').then((list) => {
      for (const p of list) {
        let text = productText(p);
        for (let n = 2; byText.has(text); n++) text = `${productText(p)} (${n})`;
        byText.set(text, p);
      }
      $('#product-list', box).innerHTML = [...byText.keys()].map((t) => `<option value="${esc(t)}"></option>`).join('');
    }).catch(() => { pick.placeholder = 'Could not load the product list'; });
    pick.addEventListener('input', () => {
      const p = byText.get(pick.value);
      if (!p) return;
      fillItemFields(box, p.template);
      pick.dispatchEvent(new CustomEvent('product-picked', { bubbles: true, detail: p }));
    });
  }

  // Distro outputs: add / remove lines (the last line is cleared rather than removed)
  box.addEventListener('click', (e) => {
    const list = $('[data-outputs]', box);
    if (!list) return;
    if (e.target.closest('[data-add-output]')) {
      list.insertAdjacentHTML('beforeend', outputRow().toString());
      list.lastElementChild.querySelector('[name=out_connector]').focus();
      return;
    }
    const rm = e.target.closest('[data-remove-output]');
    if (!rm) return;
    const rows = list.querySelectorAll('.output-row');
    if (rows.length > 1) rm.closest('.output-row').remove();
    else { rows[0].querySelector('[name=out_qty]').value = 1; rows[0].querySelector('[name=out_connector]').value = ''; }
  });
}

export function readItemFields(root) {
  const v = (n) => root.querySelector(`[name=${n}]`);
  const out = {
    category: v('category').value,
    type: v('type').value,
    // blank (not left out) when there is no second category, so saving an edit clears one that was removed
    category2: v('category2').closest('[data-second]').hidden ? '' : v('category2').value,
    type2: v('category2').closest('[data-second]').hidden ? '' : v('type2').value,
    name: v('name').value.trim(),
    male_connector: v('male_connector')?.value.trim() || '',
    female_connector: v('female_connector')?.value.trim() || '',
    length_m: v('length_m').value,
    pat_required: v('pat_required').checked,
    pat_interval_months: v('pat_interval_months').value,
  };
  if (v('owner')) out.owner = v('owner').value;
  if (v('location')) out.location = v('location').value.trim();
  if (v('input_connector')) {
    out.input_connector = v('input_connector').value.trim();
    out.outputs = [...root.querySelectorAll('.output-row')]
      .map((r) => ({ connector: r.querySelector('[name=out_connector]').value.trim(), qty: Number(r.querySelector('[name=out_qty]').value) || 1 }))
      .filter((o) => o.connector); // blank lines are ignored
  }
  if (v('barcode')) out.barcode = v('barcode').value.trim();
  if (v('container_id')) out.container_id = v('container_id').value;
  if (v('cost')) out.cost = v('cost').value;
  if (v('weight_kg')) out.weight_kg = v('weight_kg').value;
  if (v('power_w')) out.power_w = v('power_w').value;
  return out;
}

/* ---------- compact item table (containers, PAT lists, dashboard) ---------- */
export function itemsTable(items, { extraHead = [], extra = () => [], rowClass = () => '', empty = 'No items.' } = {}) {
  if (!items.length) return html`<div class="empty">${empty}</div>`;
  return html`<div class="table-wrap"><table class="data">
    <thead><tr><th>Barcode</th><th>Type</th><th>Description</th><th>Ends</th><th>Status</th><th>PAT</th>${extraHead.map((h) => html`<th>${h}</th>`)}</tr></thead>
    <tbody>${items.map((it) => html`<tr class="${rowClass(it)}">
      <td><a class="barcode" href="#/items/${it.id}">${it.barcode}</a></td>
      <td>${itemTitle(it)}</td>
      <td>${it.name || ''}</td>
      <td>${ends(it)}</td>
      <td>${statusBadge(it.status)}</td>
      <td>${patBadge(it.pat_status)}${it.next_pat_due && it.pat_status !== 'na' ? html` <span class="muted small-text">${fmtDate(it.next_pat_due)}</span>` : ''}</td>
      ${extra(it).map((c) => html`<td>${c}</td>`)}
    </tr>`)}</tbody></table></div>`;
}

// <option>s for choosing a case: your permanent cases and the temporary boxes are both listed (grouped)
export const caseOptions = (containers, selected = null) => {
  const group = (label, kind) => {
    const rows = containers.filter((c) => c.kind === kind);
    return rows.length
      ? html`<optgroup label="${label}">${rows.map((c) => html`<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.name} (${c.barcode})</option>`)}</optgroup>`
      : '';
  };
  return html`${group('Cases you always use', 'permanent')}${group('Temporary boxes', 'temporary')}`;
};

// Asks for a name and makes a temporary box (the barcode is generated). Resolves to the new container, or null if cancelled.
export async function newTempBox() {
  const name = prompt('Name for the new temporary box, e.g. "Box 1". Leave it blank to number it automatically:', '');
  if (name === null) return null;
  return api.post('/api/containers', { kind: 'temporary', name });
}

export const errorBox = (err) => html`<div class="error-box"><strong>Something went wrong:</strong> ${err.message || err}</div>`;
export { raw };
