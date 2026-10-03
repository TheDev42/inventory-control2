import { api, html, mount, $, debounce, fmtDate, fmtDateTime, plural, toast, notifyChanged } from '../util.js';
import { errorBox } from '../ui.js';

/* Admin side of the public hire site (the one on port 90).
   Three jobs: set the look (logo), arrange and caption the catalogue, and look back over the bookings
   that have come in. The catalogue itself is the inventory, so there is nothing here to keep in step —
   a booking becomes a real active rental the instant it's submitted, so there's nothing left to
   accept or decline either; this is just its history. */

const PLACEHOLDER = html`<div class="ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/></svg></div>`;

// Centre-crops whatever is chosen to a square and shrinks it, so item/category tiles always line up
// and the database only ever holds a small picture.
async function squareDataUrl(file, size = 640) {
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

// A logo keeps its own proportions (scaled to fit) rather than being cropped square like a tile photo.
async function fitDataUrl(file, maxW = 640, maxH = 200) {
  if (!file.type.startsWith('image/')) throw new Error('That file is not a picture');
  if (file.size > 25 * 1024 * 1024) throw new Error('That picture is too big to work with (25 MB max)');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxW / bmp.width, maxH / bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  let url = canvas.toDataURL('image/webp', 0.9);
  if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/png');
  if (url.length > 2_600_000) throw new Error('That picture will not compress small enough — try a smaller one');
  return url;
}

export default async function hireView({ el, query, isActive }) {
  let tab = query.get('tab') === 'bookings' ? 'bookings' : 'pictures';
  let catalogue = null;
  let hasLogo = false;
  let bookings = null;
  let viewing = null; // the booking being read, or null for the list
  let q = '';
  let reordering = false;
  const open = new Set(); // which tile editors are expanded

  mount(el, html`
    <div class="page-head">
      <div><h1>Hire site</h1><div class="sub">The customer-facing site on port 90: its logo, what's listed on it and how it's arranged, and the bookings it has sent in.</div></div>
    </div>
    <div class="tabs" id="hire-tabs"></div>
    <div id="hire-body"><div class="empty">Loading…</div></div>`);

  const newToday = (list) => (list || []).filter((r) => r.created_at?.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  const paintTabs = () => mount($('#hire-tabs', el), html`
    <button class="tab" type="button" data-tab="pictures" aria-pressed="${tab === 'pictures'}">Pictures &amp; wording</button>
    <button class="tab" type="button" data-tab="bookings" aria-pressed="${tab === 'bookings'}">Bookings${newToday(bookings) ? html`<span class="count">${newToday(bookings)} today</span>` : ''}</button>`);

  /* ---------- look & feel: logo ---------- */
  function renderLook() {
    return html`<section class="card" style="margin-bottom:20px">
      <div class="card-head"><h2>Logo</h2></div>
      <div class="hire-logo-row">
        <div class="hire-logo-preview">${hasLogo ? html`<img src="/api/hire/img/site/logo?v=${Date.now()}" alt="Current logo">` : html`<span class="muted small-text">No logo set — the site shows its name as text instead.</span>`}</div>
        <div class="hire-logo-actions">
          <label class="btn secondary small" style="cursor:pointer">Upload logo<input id="logo-file" type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
          ${hasLogo ? html`<button class="btn ghost small danger" type="button" data-act="remove-logo">Remove</button>` : ''}
        </div>
      </div>
      <p class="muted small-text">Any size works — it's scaled to fit and keeps its own proportions (not cropped square like the catalogue photos below). Best as a transparent PNG or WebP.</p>
    </section>`;
  }

  /* ---------- pictures and wording: browsing view ---------- */
  const tile = (scope, key, row) => {
    const expanded = open.has(`${scope}:${key}`);
    return html`<div class="hire-tile" data-scope="${scope}" data-key="${key}">
      <div class="hire-thumb">${row.image
        ? html`<img src="/api/hire/img/${scope}/${key}?v=${encodeURIComponent(row.updated_at || '')}" alt="">`
        : PLACEHOLDER}</div>
      <div class="hire-body">
        <div class="hire-name">${row.label}${row.section ? html` <span class="chip">${row.section}</span>` : ''}</div>
        <div class="muted small-text">${scope === 'subcategory'
          ? `${plural(row.kinds, 'kind')} · ${plural(row.total, 'item')}`
          : [row.details, `${row.available} of ${row.total} free`].filter(Boolean).join(' · ')}</div>
        <div class="hire-flags">
          ${row.image
            ? html`<span class="badge pat-ok"><span class="ico" aria-hidden="true">✓</span>Picture</span>`
            : html`<span class="badge pat-never"><span class="ico" aria-hidden="true">?</span>No picture</span>`}
          ${row.about ? html`<span class="badge pat-ok"><span class="ico" aria-hidden="true">✓</span>Wording</span>` : ''}
        </div>
        <button class="btn ghost small" type="button" data-act="toggle">${expanded ? 'Close' : 'Edit'}</button>
      </div>
      ${expanded ? html`<div class="hire-edit">
        <div class="field"><label>Name shown on the site</label>
          <input data-f="label" type="text" maxlength="120" value="${row.custom_label || ''}" placeholder="${row.label}">
          <span class="hint">Leave blank to use “${row.label}”.</span></div>
        <div class="field"><label>About this ${scope === 'subcategory' ? 'category' : 'item'}</label>
          <textarea data-f="about" rows="5" maxlength="4000" placeholder="What it is, what it is for, anything a customer should know.">${row.about || ''}</textarea></div>
        <div class="field"><label>Square picture</label>
          <input data-f="file" type="file" accept="image/png,image/jpeg,image/webp">
          <span class="hint">Any shape works: it is cropped square from the middle and shrunk before saving.</span></div>
        <div class="form-actions">
          <button class="btn small" type="button" data-act="save">Save</button>
          ${row.image ? html`<button class="btn ghost small danger" type="button" data-act="remove-image">Remove picture</button>` : ''}
        </div>
      </div>` : ''}
    </div>`;
  };

  /* ---------- pictures and wording: reorder view ---------- */
  // A plain ordered list with Move up/down, rather than drag-and-drop: works the same with a mouse,
  // a touchscreen or a keyboard, and there's no drag library anywhere else in this app to lean on.
  const reorderRow = (scope, key, label, extra) => html`<div class="reorder-row" data-scope="${scope}" data-key="${key}">
    <div class="reorder-main"><strong>${label}</strong>${extra || ''}</div>
    <div class="reorder-move">
      <button class="btn ghost small" type="button" data-move="up" aria-label="Move ${label} up">↑</button>
      <button class="btn ghost small" type="button" data-move="down" aria-label="Move ${label} down">↓</button>
    </div>
  </div>`;

  function renderSubReorder() {
    return html`<div class="reorder-list" id="sub-order">${catalogue.subcategories.map((s) =>
      reorderRow('subcategory', s.slug, s.label))}</div>`;
  }

  function renderTypeReorder(sub) {
    const types = catalogue.types.filter((t) => t.subcategory === sub.slug);
    const sections = [...new Set(types.map((t) => t.section).filter(Boolean))].sort();
    const datalistId = `sections-${sub.slug}`;
    return html`<div class="reorder-group">
      <datalist id="${datalistId}">${sections.map((s) => html`<option value="${s}">`)}</datalist>
      <div class="reorder-list" id="type-order-${sub.slug}" data-sub="${sub.slug}">${types.map((t) => reorderRow('type', t.key, t.label,
        html` <input class="reorder-section" type="text" list="${datalistId}" value="${t.section || ''}" placeholder="Section (e.g. 16A)" maxlength="60" aria-label="Section for ${t.label}">`))}</div>
    </div>`;
  }

  // Resends the whole list's order (and, for item types, section) in one go — simplest way to turn
  // "move/relabel this one row" into consistent, gap-free sort_order values for everyone in the list.
  async function saveOrder(listEl, { withSections } = {}) {
    const rows = [...listEl.querySelectorAll('.reorder-row')];
    const entries = rows.map((row, i) => {
      const entry = { scope: row.dataset.scope, key: row.dataset.key, sortOrder: i * 10 };
      if (withSections) entry.section = row.querySelector('.reorder-section')?.value || '';
      return entry;
    });
    try {
      catalogue = await api.post('/api/hire/order', entries);
      toast('Order saved', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  }

  function renderPictures() {
    if (!catalogue) return;
    const term = q.toLowerCase();
    const matches = (r, extra = '') => !term || `${r.label} ${r.custom_label || ''} ${extra}`.toLowerCase().includes(term);
    const subs = catalogue.subcategories.filter((s) => matches(s));
    const types = catalogue.types.filter((t) => matches(t, `${t.details || ''} ${t.category} ${t.type} ${t.section || ''}`));
    const noPicture = catalogue.types.filter((t) => !t.image).length + catalogue.subcategories.filter((s) => !s.image).length;

    mount($('#hire-body', el), html`
      ${renderLook()}
      <div class="kpis">
        <div class="kpi"><div class="label">Sub-categories</div><div class="value">${catalogue.subcategories.length}</div><div class="note">The tiles on the hire home page</div></div>
        <div class="kpi"><div class="label">Kinds of item</div><div class="value">${catalogue.types.length}</div><div class="note">Grouped like the stock overview</div></div>
        <div class="kpi"><div class="label">Still need a picture</div><div class="value">${noPicture}</div></div>
      </div>
      ${catalogue.types.length ? '' : html`<div class="notice">There is no stock to show, so the hire site is empty. Add some items first.</div>`}
      <div class="toolbar">
        <div class="grow">${reordering ? '' : html`<input type="search" id="hire-q" value="${q}" placeholder="Find a category or item…" aria-label="Search the hire catalogue">`}</div>
        <button class="btn ${reordering ? '' : 'secondary'} small" type="button" id="reorder-toggle">${reordering ? 'Done reordering' : 'Reorder'}</button>
      </div>

      ${reordering ? html`
        <h2 class="hire-head">Sub-categories</h2>
        <p class="muted small-text">The order of the tiles on the hire home page.</p>
        ${renderSubReorder()}
        <h2 class="hire-head">Kinds of item, by sub-category</h2>
        <p class="muted small-text">Order within each sub-category, and the section (e.g. "16A", "32A") each one sits under. Leave the section blank to keep it unsectioned. Changes save as soon as you move or retype something.</p>
        ${catalogue.subcategories.map((s) => html`<div class="reorder-sub-head">${s.label}</div>${renderTypeReorder(s)}`)}`
      : html`
        <h2 class="hire-head">Sub-categories</h2>
        <p class="muted small-text">The tiles on the front page, one per category and type of stock you own.</p>
        <div class="hire-grid">${subs.length ? subs.map((s) => tile('subcategory', s.slug, s)) : html`<div class="empty">Nothing matches.</div>`}</div>
        <h2 class="hire-head">Kinds of item</h2>
        <p class="muted small-text">One per group of identical items. Changing an item's description, connectors or length in the inventory moves it to a different group, which would need its own picture.</p>
        <div class="hire-grid">${types.length ? types.map((t) => tile('type', t.key, t)) : html`<div class="empty">Nothing matches.</div>`}</div>`}`);

    $('#hire-q', el)?.addEventListener('input', debounce((e) => { q = e.target.value.trim(); renderPictures(); }, 200));
    $('#reorder-toggle', el).addEventListener('click', () => { reordering = !reordering; renderPictures(); });
    $('#logo-file', el)?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const image = await fitDataUrl(file);
        await api.put('/api/hire/meta/site/logo', { image });
        hasLogo = true;
        toast('Logo saved', 'ok');
        renderPictures();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  async function saveTile(tileEl) {
    const { scope, key } = tileEl.dataset;
    const body = { label: $('[data-f=label]', tileEl).value, about: $('[data-f=about]', tileEl).value };
    const file = $('[data-f=file]', tileEl).files[0];
    if (file) body.image = await squareDataUrl(file);
    await api.put(`/api/hire/meta/${scope}/${key}`, body);
    open.delete(`${scope}:${key}`);
    toast('Saved', 'ok');
    await loadCatalogue();
  }

  /* ---------- bookings: read-only history ---------- */
  function renderBookings() {
    if (!bookings) return;
    mount($('#hire-body', el), bookings.length
      ? html`<div class="table-wrap cards"><table class="data">
          <thead><tr><th>Job</th><th>Client &amp; event</th><th>Dates</th><th>Who booked</th><th class="num">Items</th><th></th></tr></thead>
          <tbody>${bookings.map((r) => html`<tr data-id="${r.id}">
            <td><div class="cell-main mono">${r.job_number || '—'}</div><div class="cell-sub">${fmtDateTime(r.created_at)}</div></td>
            <td><div class="cell-main">${r.client}</div><div class="cell-sub">${r.event}</div></td>
            <td class="nowrap">${fmtDate(r.start_date)}<div class="cell-sub">to ${fmtDate(r.end_date)}</div></td>
            <td><div class="cell-main">${r.renter_name}</div><div class="cell-sub">${r.renter_email}</div></td>
            <td class="num">${r.item_count}<div class="cell-sub">${plural(r.line_count, 'kind')}</div></td>
            <td class="right"><button class="btn ghost small" type="button" data-act="view">Open</button></td>
          </tr>`)}</tbody></table></div>`
      : html`<div class="empty">No bookings yet. They land here — and on the Rentals list — the moment someone sends a flight case from the site on port 90.</div>`);
  }

  async function renderBooking(id) {
    const { request: r, lines } = await api.get(`/api/hire/requests/${id}`);
    if (!isActive()) return;
    viewing = id;
    const shortfalls = lines.filter((l) => l.available !== null && l.qty > l.available);
    mount($('#hire-body', el), html`
      <div class="crumbs"><button class="btn ghost small" type="button" data-act="back">← All bookings</button></div>
      <div class="page-head item-hero">
        <div><h1 class="mono">${r.job_number || r.reference}</h1><div class="sub">${r.client} · ${r.event} · booked ${fmtDateTime(r.created_at)}</div></div>
        <div class="actions">${r.rental_id ? html`<a class="btn" href="#/rentals/${r.rental_id}">Open the rental</a>` : ''}</div>
      </div>
      <div class="grid cols-2">
        <div class="card"><h2>Booking details</h2>
          <dl class="dl">
            <dt>Dates</dt><dd>${fmtDate(r.start_date)} to ${fmtDate(r.end_date)}</dd>
            <dt>Client</dt><dd>${r.client}</dd>
            <dt>Event</dt><dd>${r.event}</dd>
            <dt>Booked by</dt><dd>${r.renter_name}</dd>
            <dt>Email</dt><dd><a href="mailto:${r.renter_email}?subject=${encodeURIComponent(`${r.job_number || r.reference}: ${r.event}`)}">${r.renter_email}</a></dd>
          </dl>
          ${r.notes ? html`<h2 class="hire-head">Their notes</h2><p class="hire-about">${r.notes}</p>` : ''}
        </div>
        <div class="card"><h2>What was booked</h2>
          ${shortfalls.length ? html`<div class="notice warn">${plural(shortfalls.length, 'line')} now ${shortfalls.length === 1 ? 'asks' : 'ask'} for more than is free for those dates.</div>` : ''}
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Item</th><th class="num">Booked</th><th class="num">Free now</th></tr></thead>
            <tbody>${lines.map((l) => html`<tr>
              <td><div class="cell-main">${l.label}</div>${l.details ? html`<div class="cell-sub">${l.details}</div>` : ''}</td>
              <td class="num">${l.qty}</td>
              <td class="num">${l.available === null ? '—' : l.available}</td>
            </tr>`)}</tbody></table></div>
          <p class="muted small-text">These became kit requirements on the rental automatically — packing it is just scanning any matching barcodes, not these specific ones.</p>
        </div>
      </div>`);
  }

  /* ---------- loading ---------- */
  async function loadCatalogue() {
    const [d, logoCheck] = await Promise.all([
      api.get('/api/hire/catalogue'),
      fetch('/api/hire/img/site/logo').then((r) => r.ok).catch(() => false),
    ]);
    if (!isActive()) return;
    catalogue = d;
    hasLogo = logoCheck;
    paintTabs();
    if (tab === 'pictures') renderPictures();
  }

  async function loadBookings() {
    const d = await api.get('/api/hire/requests');
    if (!isActive()) return;
    bookings = d;
    viewing = null;
    paintTabs();
    if (tab === 'bookings') renderBookings();
  }

  const show = (err) => mount($('#hire-body', el), errorBox(err));

  $('#hire-tabs', el).addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn || btn.dataset.tab === tab) return;
    tab = btn.dataset.tab;
    viewing = null;
    paintTabs();
    if (tab === 'pictures') catalogue ? renderPictures() : loadCatalogue().catch(show);
    else bookings ? renderBookings() : loadBookings().catch(show);
  });

  // One delegated handler for both tabs, so nothing stacks up as the body is re-rendered
  $('#hire-body', el).addEventListener('click', async (e) => {
    const move = e.target.closest('button[data-move]');
    if (move) {
      const row = move.closest('.reorder-row');
      const list = move.closest('.reorder-list');
      if (move.dataset.move === 'up' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
      else if (move.dataset.move === 'down' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
      else return;
      saveOrder(list, { withSections: list.id.startsWith('type-order-') });
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === 'view') return await renderBooking(Number(btn.closest('tr[data-id]').dataset.id));
      if (act === 'back') return await loadBookings();
      if (act === 'remove-logo') {
        await api.put('/api/hire/meta/site/logo', { image: null });
        hasLogo = false;
        toast('Logo removed', 'ok');
        renderPictures();
        return;
      }

      const tileEl = btn.closest('.hire-tile');
      if (!tileEl) return;
      const id = `${tileEl.dataset.scope}:${tileEl.dataset.key}`;
      if (act === 'toggle') {
        open.has(id) ? open.delete(id) : open.add(id);
        renderPictures();
      } else if (act === 'save') {
        btn.disabled = true;
        await saveTile(tileEl);
      } else if (act === 'remove-image') {
        await api.put(`/api/hire/meta/${tileEl.dataset.scope}/${tileEl.dataset.key}`, { image: null });
        toast('Picture removed', 'ok');
        await loadCatalogue();
      }
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });

  // Retyping a section (no row movement) also needs saving
  $('#hire-body', el).addEventListener('change', (e) => {
    const input = e.target.closest('.reorder-section');
    if (!input) return;
    saveOrder(input.closest('.reorder-list'), { withSections: true });
  });

  paintTabs();
  if (tab === 'bookings') await loadBookings();
  else await loadCatalogue();

  return {
    refresh: () => (tab === 'pictures' ? loadCatalogue() : viewing ? renderBooking(viewing) : loadBookings()),
  };
}
