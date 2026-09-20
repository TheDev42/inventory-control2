import { html, raw, $, esc, cap, itemTitle, ends, statusBadge, patBadge, fmtDate } from './util.js';
import { app } from './state.js';

/* ---------- shared item form fields (used by new/edit item and bulk add) ---------- */

export const connectorDatalist = () =>
  html`<datalist id="connector-list">${app.meta.connectors.map((c) => html`<option value="${c}"></option>`)}</datalist>`;

const typeOptions = (category, selected) =>
  html`${(app.meta.catalog[category] || []).map((t) => html`<option value="${t}" ${t === selected ? 'selected' : ''}>${cap(t)}</option>`)}`;

export function itemFields(item = {}, { barcode = true, containers = [], isNew = false } = {}) {
  const category = item.category || 'POWER';
  const type = item.type || app.meta.catalog[category][0];
  const hasEnds = app.meta.connectorTypes.includes(type);
  const patRequired = item.pat_required === undefined ? !(category === 'SOUND' && type === 'cable') : !!item.pat_required;
  return html`
    ${connectorDatalist()}
    <div class="form-grid" data-item-fields data-auto-pat="${isNew ? '1' : ''}">
      ${barcode ? html`<div class="field"><label for="f-barcode">Barcode *</label>
        <input id="f-barcode" name="barcode" type="text" inputmode="numeric" required autocomplete="off" value="${item.barcode || ''}" placeholder="e.g. 00001 (scan or type)">
        <span class="hint">You can scan straight into this page.</span></div>` : ''}
      <div class="field"><label for="f-category">Category *</label>
        <select id="f-category" name="category">${Object.keys(app.meta.catalog).map((c) => html`<option ${c === category ? 'selected' : ''}>${c}</option>`)}</select></div>
      <div class="field"><label for="f-type">Type *</label>
        <select id="f-type" name="type">${typeOptions(category, type)}</select></div>
      <div class="field"><label for="f-name">Description</label>
        <input id="f-name" name="name" type="text" value="${item.name || ''}" placeholder="e.g. 10m 16A extension"></div>
      <div class="field" data-ends ${hasEnds ? '' : 'hidden'}><label for="f-male">Male end (connector)</label>
        <input id="f-male" name="male_connector" type="text" list="connector-list" value="${item.male_connector || ''}" placeholder="e.g. 16A Cee (blue)"></div>
      <div class="field" data-ends ${hasEnds ? '' : 'hidden'}><label for="f-female">Female end (connector)</label>
        <input id="f-female" name="female_connector" type="text" list="connector-list" value="${item.female_connector || ''}" placeholder="e.g. 13A (BS1363)"></div>
      <div class="field"><label for="f-length">Length (m)</label>
        <input id="f-length" name="length_m" type="number" step="0.01" min="0" value="${item.length_m ?? ''}"></div>
      <div class="field"><span class="lbl">PAT testing</span>
        <label class="check"><input type="checkbox" name="pat_required" ${patRequired ? 'checked' : ''}> PAT test required</label></div>
      <div class="field"><label for="f-interval">PAT interval (months)</label>
        <input id="f-interval" name="pat_interval_months" type="number" min="1" max="120" value="${item.pat_interval_months || 12}"></div>
      ${containers.length || item.container_id ? html`<div class="field"><label for="f-container">Container</label>
        <select id="f-container" name="container_id"><option value="">— none —</option>
        ${containers.map((c) => html`<option value="${c.id}" ${c.id === item.container_id ? 'selected' : ''}>${c.name} (${c.barcode})</option>`)}</select></div>` : ''}
    </div>`;
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
      type.value = keep;
    }
    const hasEnds = app.meta.connectorTypes.includes(type.value);
    box.querySelectorAll('[data-ends]').forEach((f) => { f.hidden = !hasEnds; });
    if (box.dataset.autoPat) pat.checked = !(cat.value === 'SOUND' && type.value === 'cable');
  };
  cat.addEventListener('change', () => sync(true));
  type.addEventListener('change', () => sync(false));
}

export function readItemFields(root) {
  const v = (n) => root.querySelector(`[name=${n}]`);
  const out = {
    category: v('category').value,
    type: v('type').value,
    name: v('name').value.trim(),
    male_connector: v('male_connector')?.value.trim() || '',
    female_connector: v('female_connector')?.value.trim() || '',
    length_m: v('length_m').value,
    pat_required: v('pat_required').checked,
    pat_interval_months: v('pat_interval_months').value,
  };
  if (v('barcode')) out.barcode = v('barcode').value.trim();
  if (v('container_id')) out.container_id = v('container_id').value;
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

export const errorBox = (err) => html`<div class="error-box"><strong>Something went wrong:</strong> ${err.message || err}</div>`;
export { raw };
