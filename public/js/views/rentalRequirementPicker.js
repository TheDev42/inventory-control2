import { api, html, mount, $, debounce, cap, itemTitle, ends, outputsOf, toast } from '../util.js';

/*
 * "Add by quantity": pick a kind of item (the same grouping the Stock overview uses) and how many,
 * instead of ticking specific barcodes. Packing it is then just scanning any matching barcode — the
 * requirement's progress bar on the rental page is a read-only reflection of what's already out.
 */

const label = (g) => (g.name && g.name.trim()) || itemTitle(g);

const detailsText = (g) => {
  const parts = [];
  if (g.input_connector || g.outputs) {
    const outs = outputsOf(g).map((o) => `${o.qty}× ${o.connector}`).join(', ');
    parts.push(`${g.input_connector || '?'} in${outs ? ` → ${outs} out` : ''}`);
  } else if (g.male_connector || g.female_connector) {
    parts.push(`${g.male_connector || '?'} → ${g.female_connector || '?'}`);
  }
  if (g.length_m != null) parts.push(`${g.length_m} m`);
  return parts.join(' · ') || null;
};

export function createRequirementPicker({ rentalId, onClose }) {
  const s = { q: '', category: '' };
  let host = null;
  let groups = [];
  let loaded = false;

  function matches(g) {
    if (s.category && g.category !== s.category) return false;
    if (!s.q) return true;
    const hay = [g.category, g.type, g.name, g.male_connector, g.female_connector, g.input_connector, g.length_m != null ? `${g.length_m}m` : '']
      .join(' ').toLowerCase();
    return s.q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
  }

  function fillCategories() {
    const sel = $('#rqp-category', host);
    if (!sel) return;
    const categories = [...new Set(groups.map((g) => g.category))];
    mount(sel, html`<option value="">All categories</option>${categories.map((c) => html`<option value="${c}" ${c === s.category ? 'selected' : ''}>${cap(c)}</option>`)}`);
  }

  function renderList() {
    const list = $('#rqp-list', host);
    if (!list) return;
    const shown = groups.filter(matches);
    mount(list, shown.length ? html`<div class="table-wrap cards pk-table"><table class="data">
        <thead><tr><th>Kind</th><th>Ends</th><th class="num">Free / total</th><th></th></tr></thead>
        <tbody>${shown.map((g) => html`<tr data-key="${g.key}">
          <td><div class="cell-main">${label(g)}</div><div class="cell-sub">${itemTitle(g)}</div></td>
          <td>${ends(g)}</td>
          <td class="num">${g.available} / ${g.total}</td>
          <td class="right"><span class="inline-form" style="justify-content:flex-end">
            <input type="number" class="rqp-qty" min="1" max="999" value="1" style="width:68px" aria-label="Quantity of ${label(g)}">
            <button class="btn small" type="button" data-rqp="add">Add</button>
          </span></td>
        </tr>`)}</tbody></table></div>`
      : html`<div class="empty">${loaded ? 'Nothing matches that.' : 'Loading…'}</div>`);
  }

  async function load() {
    try {
      groups = (await api.get('/api/overview')).groups;
      loaded = true;
    } catch (err) {
      loaded = true;
      toast(err.message, 'error', 5000);
      groups = [];
    }
    if (!host?.isConnected) return;
    fillCategories();
    renderList();
  }

  async function addRow(row) {
    const key = row.dataset.key;
    const g = groups.find((x) => x.key === key);
    const input = $('.rqp-qty', row);
    const qty = Math.max(1, Math.min(999, Math.floor(Number(input.value)) || 1));
    const btn = $('[data-rqp=add]', row);
    btn.disabled = true;
    try {
      await api.post(`/api/rentals/${rentalId}/requirements`, {
        kindKey: g.key, label: label(g), details: detailsText(g), qty,
        snapshot: { category: g.category, type: g.type, name: g.name, male_connector: g.male_connector,
          female_connector: g.female_connector, input_connector: g.input_connector, outputs: g.outputs, length_m: g.length_m },
      });
      toast(`${qty} × ${label(g)} added as a kit requirement`, 'ok');
      onClose?.();
    } catch (err) {
      toast(err.message, 'error', 5000);
      btn.disabled = false;
    }
  }

  function wire() {
    const search = debounce((value) => { s.q = value.trim(); renderList(); }, 200);
    host.addEventListener('input', (e) => { if (e.target.id === 'rqp-q') search(e.target.value); });
    host.addEventListener('change', (e) => { if (e.target.id === 'rqp-category') { s.category = e.target.value; renderList(); } });
    host.addEventListener('click', (e) => {
      if (e.target.closest('[data-rqp=close]')) { onClose?.(); return; }
      const add = e.target.closest('[data-rqp=add]');
      if (add) addRow(add.closest('tr[data-key]'));
    });
  }

  return {
    mount(el) {
      host = el;
      mount(host, html`
        <section class="card picker" aria-label="Add a kit requirement to this rental">
          <div class="card-head">
            <h2>Add by quantity</h2>
            <button class="btn ghost small" type="button" data-rqp="close">Close</button>
          </div>
          <p class="muted small-text">Add "N of this kind of item" instead of picking specific barcodes. Packing it is then just scanning any N matching items.</p>
          <div class="toolbar">
            <div class="grow"><input type="search" id="rqp-q" placeholder="Search: description, type, connector…" value="${s.q}" aria-label="Search stock kinds" autocomplete="off"></div>
            <select id="rqp-category" aria-label="Category"><option value="">All categories</option></select>
          </div>
          <div id="rqp-list">${html`<div class="empty">Loading…</div>`}</div>
        </section>`);
      wire();
      load();
    },
    focus() { $('#rqp-q', host)?.focus(); },
  };
}
