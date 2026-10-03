import { api, html, mount, $, debounce, fmtDate, fmtDateTime, plural, toast, notifyChanged } from '../util.js';
import { errorBox } from '../ui.js';

/* Admin side of the public hire site (the one on port 90).
   Two jobs: give every sub-category and kind of item a square picture and some wording, and deal with
   the requests that come in. The catalogue itself is the inventory, so there is nothing here to keep in step. */

const PLACEHOLDER = html`<div class="ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/></svg></div>`;

const STATUS_BADGE = { new: 'pat-soon', accepted: 'pat-ok', declined: 'pat-na' };
const STATUS_LABEL = { new: 'New', accepted: 'Accepted', declined: 'Declined' };

// Centre-crops whatever is chosen to a square and shrinks it, so the tiles always line up and the
// database only ever holds a small picture.
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

export default async function hireView({ el, query, isActive }) {
  let tab = query.get('tab') === 'requests' ? 'requests' : 'pictures';
  let catalogue = null;
  let requests = null;
  let viewing = null; // the request being read, or null for the list
  let q = '';
  const open = new Set(); // which tile editors are expanded

  mount(el, html`
    <div class="page-head">
      <div><h1>Hire site</h1><div class="sub">The customer-facing site on port 90: the pictures and wording people see there, and the flight cases they send in.</div></div>
    </div>
    <div class="tabs" id="hire-tabs"></div>
    <div id="hire-body"><div class="empty">Loading…</div></div>`);

  const newCount = () => (requests || []).filter((r) => r.status === 'new').length;
  const paintTabs = () => mount($('#hire-tabs', el), html`
    <button class="tab" type="button" data-tab="pictures" aria-pressed="${tab === 'pictures'}">Pictures &amp; wording</button>
    <button class="tab" type="button" data-tab="requests" aria-pressed="${tab === 'requests'}">Requests${newCount() ? html`<span class="count">${newCount()} new</span>` : ''}</button>`);

  /* ---------- pictures and wording ---------- */
  const tile = (scope, key, row) => {
    const expanded = open.has(`${scope}:${key}`);
    return html`<div class="hire-tile" data-scope="${scope}" data-key="${key}">
      <div class="hire-thumb">${row.image
        ? html`<img src="/api/hire/img/${scope}/${key}?v=${encodeURIComponent(row.updated_at || '')}" alt="">`
        : PLACEHOLDER}</div>
      <div class="hire-body">
        <div class="hire-name">${row.label}</div>
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

  function renderPictures() {
    if (!catalogue) return;
    const term = q.toLowerCase();
    const matches = (r, extra = '') => !term || `${r.label} ${r.custom_label || ''} ${extra}`.toLowerCase().includes(term);
    const subs = catalogue.subcategories.filter((s) => matches(s));
    const types = catalogue.types.filter((t) => matches(t, `${t.details || ''} ${t.category} ${t.type}`));
    const noPicture = catalogue.types.filter((t) => !t.image).length + catalogue.subcategories.filter((s) => !s.image).length;

    mount($('#hire-body', el), html`
      <div class="kpis">
        <div class="kpi"><div class="label">Sub-categories</div><div class="value">${catalogue.subcategories.length}</div><div class="note">The tiles on the hire home page</div></div>
        <div class="kpi"><div class="label">Kinds of item</div><div class="value">${catalogue.types.length}</div><div class="note">Grouped like the stock overview</div></div>
        <div class="kpi"><div class="label">Still need a picture</div><div class="value">${noPicture}</div></div>
      </div>
      ${catalogue.types.length ? '' : html`<div class="notice">There is no stock to show, so the hire site is empty. Add some items first.</div>`}
      <div class="toolbar"><div class="grow"><input type="search" id="hire-q" value="${q}" placeholder="Find a category or item…" aria-label="Search the hire catalogue"></div></div>
      <h2 class="hire-head">Sub-categories</h2>
      <p class="muted small-text">The tiles on the front page, one per category and type of stock you own.</p>
      <div class="hire-grid">${subs.length ? subs.map((s) => tile('subcategory', s.slug, s)) : html`<div class="empty">Nothing matches.</div>`}</div>
      <h2 class="hire-head">Kinds of item</h2>
      <p class="muted small-text">One per group of identical items. Changing an item's description, connectors or length in the inventory moves it to a different group, which would need its own picture.</p>
      <div class="hire-grid">${types.length ? types.map((t) => tile('type', t.key, t)) : html`<div class="empty">Nothing matches.</div>`}</div>`);

    $('#hire-q', el).addEventListener('input', debounce((e) => { q = e.target.value.trim(); renderPictures(); }, 200));
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

  /* ---------- requests ---------- */
  function renderRequests() {
    if (!requests) return;
    mount($('#hire-body', el), requests.length
      ? html`<div class="table-wrap cards"><table class="data">
          <thead><tr><th>Reference</th><th>Client &amp; event</th><th>Dates</th><th>Who asked</th><th class="num">Items</th><th>Status</th><th></th></tr></thead>
          <tbody>${requests.map((r) => html`<tr data-id="${r.id}">
            <td><div class="cell-main mono">${r.reference}</div><div class="cell-sub">${fmtDateTime(r.created_at)}</div></td>
            <td><div class="cell-main">${r.client}</div><div class="cell-sub">${r.event}</div></td>
            <td class="nowrap">${fmtDate(r.start_date)}<div class="cell-sub">to ${fmtDate(r.end_date)}</div></td>
            <td><div class="cell-main">${r.renter_name}</div><div class="cell-sub">${r.renter_email}</div></td>
            <td class="num">${r.item_count}<div class="cell-sub">${plural(r.line_count, 'kind')}</div></td>
            <td><span class="badge ${STATUS_BADGE[r.status]}">${STATUS_LABEL[r.status]}</span>
              ${r.rental_name ? html`<div class="cell-sub">Rental: ${r.rental_name}</div>` : ''}</td>
            <td class="right"><button class="btn ghost small" type="button" data-act="view">Open</button></td>
          </tr>`)}</tbody></table></div>`
      : html`<div class="empty">No hire requests yet. They land here when someone sends a flight case from the site on port 90.</div>`);
  }

  async function renderRequest(id) {
    const { request: r, lines } = await api.get(`/api/hire/requests/${id}`);
    if (!isActive()) return;
    viewing = id;
    const shortfalls = lines.filter((l) => l.available !== null && l.qty > l.available);
    mount($('#hire-body', el), html`
      <div class="crumbs"><button class="btn ghost small" type="button" data-act="back">← All requests</button></div>
      <div class="page-head item-hero">
        <div><h1 class="mono">${r.reference}</h1><div class="sub">${r.client} · ${r.event} · sent ${fmtDateTime(r.created_at)}</div></div>
        <div class="actions">
          ${r.rental_id
            ? html`<a class="btn" href="#/rentals/${r.rental_id}">Open the rental</a>`
            : html`<button class="btn" type="button" data-act="make-rental">Create a rental from this</button>`}
          ${r.status !== 'accepted' ? html`<button class="btn ghost small" type="button" data-act="status" data-status="accepted">Mark accepted</button>` : ''}
          ${r.status !== 'declined' ? html`<button class="btn ghost small" type="button" data-act="status" data-status="declined">Mark declined</button>` : ''}
          <button class="btn ghost small danger" type="button" data-act="delete">Delete</button>
        </div>
      </div>
      <div class="grid cols-2">
        <div class="card"><h2>Hire details</h2>
          <dl class="dl">
            <dt>Status</dt><dd><span class="badge ${STATUS_BADGE[r.status]}">${STATUS_LABEL[r.status]}</span></dd>
            <dt>Dates</dt><dd>${fmtDate(r.start_date)} to ${fmtDate(r.end_date)}</dd>
            <dt>Client</dt><dd>${r.client}</dd>
            <dt>Event</dt><dd>${r.event}</dd>
            <dt>Asked by</dt><dd>${r.renter_name}</dd>
            <dt>Email</dt><dd><a href="mailto:${r.renter_email}?subject=${encodeURIComponent(`Hire request ${r.reference}: ${r.event}`)}">${r.renter_email}</a></dd>
          </dl>
          ${r.notes ? html`<h2 class="hire-head">Their notes</h2><p class="hire-about">${r.notes}</p>` : ''}
        </div>
        <div class="card"><h2>What they asked for</h2>
          ${shortfalls.length ? html`<div class="notice warn">${plural(shortfalls.length, 'line')} now ${shortfalls.length === 1 ? 'asks' : 'ask'} for more than is free for those dates.</div>` : ''}
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Item</th><th class="num">Wanted</th><th class="num">Free now</th></tr></thead>
            <tbody>${lines.map((l) => html`<tr>
              <td><div class="cell-main">${l.label}</div>${l.details ? html`<div class="cell-sub">${l.details}</div>` : ''}</td>
              <td class="num">${l.qty}</td>
              <td class="num">${l.available === null ? '—' : l.available}</td>
            </tr>`)}</tbody></table></div>
          <p class="muted small-text">A request names kinds of item, not barcodes, so the kit itself still has to be picked or scanned onto the rental.</p>
        </div>
      </div>`);
  }

  /* ---------- loading ---------- */
  async function loadCatalogue() {
    const d = await api.get('/api/hire/catalogue');
    if (!isActive()) return;
    catalogue = d;
    paintTabs();
    if (tab === 'pictures') renderPictures();
  }

  async function loadRequests() {
    const d = await api.get('/api/hire/requests');
    if (!isActive()) return;
    requests = d;
    viewing = null;
    paintTabs();
    if (tab === 'requests') renderRequests();
  }

  const show = (err) => mount($('#hire-body', el), errorBox(err));

  $('#hire-tabs', el).addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn || btn.dataset.tab === tab) return;
    tab = btn.dataset.tab;
    viewing = null;
    paintTabs();
    if (tab === 'pictures') catalogue ? renderPictures() : loadCatalogue().catch(show);
    else requests ? renderRequests() : loadRequests().catch(show);
  });

  // One delegated handler for both tabs, so nothing stacks up as the body is re-rendered
  $('#hire-body', el).addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === 'view') return await renderRequest(Number(btn.closest('tr[data-id]').dataset.id));
      if (act === 'back') return await loadRequests();
      if (act === 'status') {
        await api.post(`/api/hire/requests/${viewing}/status`, { status: btn.dataset.status });
        requests = null;
        return await renderRequest(viewing);
      }
      if (act === 'make-rental') {
        btn.disabled = true;
        const { rental } = await api.post(`/api/hire/requests/${viewing}/rental`);
        notifyChanged();
        toast(`Rental "${rental.name}" created`, 'ok');
        location.hash = `#/rentals/${rental.id}`;
        return;
      }
      if (act === 'delete') {
        const ref = $('.page-head h1', el)?.textContent || 'this request';
        if (!confirm(`Delete ${ref}? This cannot be undone.`)) return;
        await api.del(`/api/hire/requests/${viewing}`);
        toast('Request deleted', 'ok');
        return await loadRequests();
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

  paintTabs();
  if (tab === 'requests') await loadRequests();
  else await loadCatalogue();

  return {
    refresh: () => (tab === 'pictures' ? loadCatalogue() : viewing ? renderRequest(viewing) : loadRequests()),
  };
}
