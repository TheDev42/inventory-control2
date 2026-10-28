import {
  api, html, mount, $, cap, fmtDate, fmtMoney, toast, notifyChanged, plural, itemTitle, ends, outputsOf, statusBadge, patBadge, ownerBadge, normalizeBarcode,
} from '../util.js';
import { app, refreshConnectors } from '../state.js';
import { setInterceptor } from '../scanner.js';
import { play } from '../audio.js';
import { errorBox, typeFields, squareDataUrl } from '../ui.js';

/* A product: every item with the same details (the same grouping as the Stock overview and the hire site).
   Shows how many there are and where each one is, the hire site's picture of it, and adds more of it. */

const PLACEHOLDER = html`<div class="ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/></svg></div>`;

// The count tiles, which double as filters for the barcode list (colours match the Stock overview)
const PLACES = [
  { key: 'in_stock', label: 'Available', c: '--s1' },
  { key: 'on_rental', label: 'On rental', c: '--s2' },
  { key: 'repair', label: 'Repair (broken)', c: '--s7' },
  { key: 'lost', label: 'Lost', c: '--s5' },
  { key: 'disassembled', label: 'Disassembled', c: '--s4' },
  { key: 'sold', label: 'Sold', c: '--muted' },
];

// "2.5 kg", "2.5 – 3 kg" when the items differ, and how many have nothing recorded
const spreadText = (s, fmt) => {
  if (s.min == null) return '—';
  const v = s.min === s.max ? fmt(s.min) : `${fmt(s.min)} – ${fmt(s.max)}`;
  return s.missing ? `${v} (${s.missing} not recorded)` : v;
};

const parseCodes = (text) => [...new Set(text.split(/[\n\r\t,;]+/).map((c) => normalizeBarcode(c.trim(), app.meta.barcodeDigits)).filter(Boolean))];

export default async function productView({ el, args, isActive }) {
  const key = args[0];
  let adding = false;
  let filter = ''; // '' = every barcode, otherwise one status
  let codes = ''; // barcodes typed / scanned into the add box, kept when the page redraws

  // While the add box is open, a scan anywhere on the page goes into it
  setInterceptor(async (code) => {
    if (!adding) return false;
    const box = $('#add-codes', el);
    const c = normalizeBarcode(code, app.meta.barcodeDigits);
    const have = parseCodes(box.value);
    if (have.some((x) => x.toLowerCase() === c.toLowerCase())) { play('warn'); toast(`${c} is already in the list`, 'error'); return true; }
    box.value = [...have, c].join('\n') + '\n';
    codes = box.value;
    play('store');
    return true;
  });

  async function load() {
    let d;
    try { d = await api.get(`/api/products/${key}`); } catch (err) { if (isActive()) mount(el, errorBox(err)); return; }
    if (!isActive()) return;
    const { product: p, items, image, hire, spread } = d;
    const t = p.template;
    const c = p.counts;
    const fields = typeFields(t.category, t.type);
    const shown = filter ? items.filter((it) => it.status === filter) : items;
    const ownPicture = image && !image.combined;

    mount(el, html`
      <div class="crumbs"><a href="#/inventory">Inventory</a> / ${p.label}</div>
      <section class="card product-hero">
        <div>
          <div class="product-pic">${image ? html`<img src="/api/hire/img/type/${image.key}?v=${encodeURIComponent(image.v)}" alt="${p.label}">` : PLACEHOLDER}</div>
          <div class="product-pic-actions">
            <label class="btn secondary small" style="cursor:pointer">${ownPicture ? 'Change picture' : 'Add picture'}<input id="pic-file" type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
            ${ownPicture ? html`<button class="btn ghost small" type="button" data-act="remove-pic">Remove</button>` : ''}
          </div>
          <div class="muted small-text" style="margin-top:6px">${image?.combined
            ? html`Picture of the combined hire-site item “${hire.combined.name}”.`
            : 'The same picture the hire site shows for it.'}</div>
        </div>
        <div>
          <h1 class="product-title">${p.label}</h1>
          <div class="muted" style="margin-top:2px">${itemTitle(t)}${p.details ? html` · ${p.details}` : ''}</div>
          ${ends(t) ? html`<div style="margin-top:8px">${ends(t)}</div>` : ''}
          ${hire.label && hire.label !== p.label ? html`<div class="muted small-text" style="margin-top:8px">Listed on the hire site as “${hire.label}”</div>` : ''}
          ${hire.about ? html`<p class="hire-about" style="margin:10px 0 0">${hire.about}</p>` : ''}
          <div class="actions" style="margin-top:14px">
            <button class="btn" type="button" data-act="add" aria-pressed="${String(adding)}">${adding ? 'Hide' : '+ Add items of this product'}</button>
            <a class="btn secondary" href="#/items/new?product=${key}" title="Add one with the full item form, already filled in with this product's details">Add one (full form)</a>
            <a class="btn ghost" href="#/hire" title="Change the picture, wording and order on the public hire site">Hire site</a>
          </div>
        </div>
      </section>

      ${adding ? html`<section class="card" style="margin-top:16px">
        <h2>Add items of this product</h2>
        <p class="muted">Scan or type the new barcodes, one per line. Each one is added with this product's details (everything on the right below). Owned by the company and not in a container; change either on the item afterwards.</p>
        <textarea id="add-codes" rows="5" spellcheck="false" autocomplete="off" placeholder="00101&#10;00102&#10;…" aria-label="Barcodes to add">${codes}</textarea>
        <div class="form-actions"><button class="btn" type="button" data-act="add-save">Add them</button></div>
        <div id="add-result"></div>
      </section>` : ''}

      <div class="kpis" style="margin-top:16px">
        <a class="kpi" href="#" data-filter="" aria-pressed="${String(filter === '')}"><div class="label">How many you have</div><div class="value">${c.total}</div>${c.sold ? html`<div class="note">plus ${c.sold} sold</div>` : ''}</a>
        ${PLACES.filter((pl) => pl.key === 'in_stock' || pl.key === 'on_rental' || pl.key === 'repair' || c[pl.key] > 0).map((pl) => html`
          <a class="kpi" href="#" data-filter="${pl.key}" aria-pressed="${String(filter === pl.key)}"><div class="label"><span class="dot" style="--c:var(${pl.c})"></span>${pl.label}</div><div class="value">${c[pl.key]}</div></a>`)}
      </div>

      <div class="grid side">
        <section class="card">
          <div class="card-head"><h2>Barcodes${filter ? html` <span class="muted">· ${PLACES.find((pl) => pl.key === filter)?.label}</span>` : ''}</h2>
            ${filter ? html`<button class="btn ghost small" type="button" data-filter="">Show all</button>` : ''}</div>
          ${shown.length ? html`<div class="table-wrap"><table class="data">
            <thead><tr><th>Barcode</th><th>Status</th><th>Where</th><th>PAT</th><th>Added</th></tr></thead>
            <tbody>${shown.map((it) => html`<tr class="${it.status === 'on_rental' ? 'is-out' : it.status === 'lost' ? 'is-lost' : it.status === 'sold' ? 'is-sold' : ''}">
              <td class="nowrap"><a class="barcode" href="#/items/${it.id}">${it.barcode}</a> ${ownerBadge(it)}</td>
              <td>${statusBadge(it.status)}</td>
              <td>${it.rental_id ? html`<a href="#/rentals/${it.rental_id}">${it.rental_name}</a>`
                : it.container_id ? html`In <a href="#/containers/${it.container_id}">${it.container_name}</a>`
                : it.location ? html`📍 ${it.location}` : html`<span class="muted">—</span>`}</td>
              <td>${it.status === 'sold' ? '' : patBadge(it.pat_status)}</td>
              <td class="nowrap">${fmtDate(it.created_at)}</td>
            </tr>`)}</tbody></table></div>` : html`<div class="empty">None ${filter ? 'with that status' : ''}.</div>`}
        </section>

        <section class="card">
          <h2>Details</h2>
          <dl class="dl">
            <dt>Category</dt><dd>${cap(t.category)}</dd>
            <dt>Type</dt><dd>${cap(t.type)}</dd>
            ${t.category2 ? html`<dt>Second category</dt><dd>${cap(t.category2)} ${t.type2}</dd>` : ''}
            <dt>Description</dt><dd>${t.name || '—'}</dd>
            ${fields === 'ends' ? html`<dt>Male end</dt><dd>${t.male_connector || '—'}</dd><dt>Female end</dt><dd>${t.female_connector || '—'}</dd>` : ''}
            ${fields === 'outputs' ? html`<dt>Input (in)</dt><dd>${t.input_connector || '—'}</dd>
              <dt>Outputs (out)</dt><dd>${outputsOf(t).length ? html`<ul class="plain">${outputsOf(t).map((o) => html`<li><strong>${o.qty}×</strong> ${o.connector}</li>`)}</ul>` : '—'}</dd>` : ''}
            <dt>Length</dt><dd>${t.length_m != null ? `${t.length_m} m` : '—'}</dd>
            <dt>Weight</dt><dd>${spreadText(spread.weight_kg, (v) => `${v} kg`)}</dd>
            <dt>Power</dt><dd>${spreadText(spread.power_w, (v) => `${v} W`)}</dd>
            <dt>Cost</dt><dd>${spreadText(spread.cost, fmtMoney)}</dd>
            <dt>PAT</dt><dd>${t.pat_required ? `Required, every ${t.pat_interval_months || 12} months` : 'Not required'}</dd>
          </dl>
          <p class="muted small-text" style="margin:14px 0 0">New items of this product are given these details (taken from the most recently added one). Edit an item to change it; changing its description, type, connectors or length moves it to a different product.</p>
        </section>
      </div>`);
    if (adding) $('#add-codes', el)?.focus();
  }

  el.onclick = async (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) { e.preventDefault(); filter = filter === f.dataset.filter ? '' : f.dataset.filter; load(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add') { adding = !adding; load(); } else if (act === 'remove-pic') {
      if (!confirm('Remove the picture? It goes from the hire site too.')) return;
      try { await api.put(`/api/hire/meta/type/${key}`, { image: null }); toast('Picture removed', 'ok'); load(); } catch (err) { toast(err.message, 'error', 5000); }
    } else if (act === 'add-save') {
      const list = parseCodes($('#add-codes', el).value);
      if (!list.length) { toast('Scan or type at least one barcode', 'error'); return; }
      const btn = e.target.closest('button');
      btn.disabled = true;
      try {
        const { product } = await api.get(`/api/products/${key}`); // the latest details, in case they changed since the page was drawn
        const res = await api.post('/api/items/bulk', { items: list.map((barcode) => ({ ...product.template, barcode })) });
        codes = res.skipped.map((s) => s.barcode).join('\n'); // keep only the rejected ones, to fix and retry
        if (res.created) { play('pat_pass'); toast(`Added ${plural(res.created, 'item')}`, 'ok'); refreshConnectors(); } else play('error');
        notifyChanged();
        await load();
        if (res.skipped.length) {
          mount($('#add-result', el), html`<div class="notice warn" style="margin-top:12px"><strong>${plural(res.skipped.length, 'barcode')} not added:</strong>
            <ul style="margin:4px 0 0;padding-left:18px">${res.skipped.map((s) => html`<li><span class="barcode">${s.barcode}</span> — ${s.reason}</li>`)}</ul></div>`);
        }
      } catch (err) { toast(err.message, 'error', 5000); btn.disabled = false; }
    }
  };

  el.oninput = (e) => { if (e.target.id === 'add-codes') codes = e.target.value; };

  el.onchange = async (e) => {
    if (e.target.id !== 'pic-file') return;
    const file = e.target.files[0];
    if (!file) return;
    try {
      await api.put(`/api/hire/meta/type/${key}`, { image: await squareDataUrl(file) });
      toast('Picture saved (the hire site shows it too)', 'ok');
      load();
    } catch (err) { toast(err.message, 'error', 5000); }
  };

  await load();
  return { refresh: load, destroy() { el.onclick = null; el.oninput = null; el.onchange = null; } };
}
