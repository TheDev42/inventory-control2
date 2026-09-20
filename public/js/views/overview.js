import { api, html, mount, $, debounce, cap, itemTitle, ends, plural, qs } from '../util.js';
import { app } from '../state.js';

// Where the items of a group are right now (colours match the dashboard's "Stock by type")
const PLACES = [
  { key: 'available', label: 'Available', c: '--s1' },
  { key: 'on_rental', label: 'On rental', c: '--s2' },
  { key: 'repair', label: 'Repair', c: '--s7' },
  { key: 'lost', label: 'Lost', c: '--s5' },
  { key: 'disassembled', label: 'Disassembled', c: '--s4' },
];

const SORTS = [['name', 'Category, then name'], ['total', 'Most owned first'], ['low', 'Least available first']];

// What the group is called: its description, or (if it has none) its type
const label = (g) => (g.name && g.name.trim()) || itemTitle(g);

// Link into the inventory list for this group (optionally only the ones with a given status)
const inventoryLink = (g, status, owner) => '#/inventory' + qs({ category: g.category, type: g.type, q: g.name || '', status, owner });

export default async function overviewView({ el, isActive }) {
  let data = null;
  let q = '';
  let category = '';
  let sort = 'name';
  let owner = ''; // '' = everyone's, otherwise company / personal

  const matches = (g) => {
    if (category && g.category !== category) return false;
    if (!q) return true;
    const hay = [g.category, g.type, g.name, g.male_connector, g.female_connector, g.input_connector, g.outputs, g.length_m != null ? `${g.length_m}m` : '']
      .join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
  };

  function render() {
    if (!data) return;
    const t = data.totals;
    const shown = data.groups.filter(matches);
    if (sort === 'total') shown.sort((a, b) => b.total - a.total || label(a).localeCompare(label(b)));
    else if (sort === 'low') shown.sort((a, b) => a.available - b.available || label(a).localeCompare(label(b)));
    const categories = [...new Set(data.groups.map((g) => g.category))];

    const row = (g) => html`<tr>
      <td><div class="cell-main">${label(g)}</div><div class="cell-sub">${itemTitle(g)}${g.length_m != null ? ` · ${g.length_m} m` : ''}${g.personal > 0 && g.personal < g.total ? ` · ${g.personal} of ${g.total} are mine` : g.personal === g.total && g.total > 0 && !owner ? ' · all mine' : ''}</div></td>
      <td>${ends(g)}</td>
      <td class="num"><a class="big-num" href="${inventoryLink(g, undefined, owner)}" title="Show all ${g.total} in the inventory">${g.total}</a></td>
      <td class="num avail ${g.available === 0 ? 'none' : g.available === g.total ? 'all' : ''}">
        <a class="big-num" href="${inventoryLink(g, 'in_stock', owner)}" title="Show the ${g.available} available">${g.available}</a>
        <span class="track" role="img" aria-label="${PLACES.filter((p) => g[p.key]).map((p) => `${g[p.key]} ${p.label.toLowerCase()}`).join(', ')}">${PLACES.filter((p) => g[p.key] > 0)
          .map((p) => html`<span class="seg-fill" style="--c:var(${p.c});flex:${g[p.key]}" title="${g[p.key]} ${p.label.toLowerCase()}"></span>`)}</span></td>
      <td>${PLACES.slice(1).some((p) => g[p.key] > 0) ? html`<div class="elsewhere">${PLACES.slice(1).filter((p) => g[p.key] > 0).map((p) => html`<span class="chip-place"><span class="dot" style="--c:var(${p.c})"></span>${g[p.key]} ${p.label.toLowerCase()}</span>`)}</div>` : ''}</td>
    </tr>`;

    // grouped under a heading per category when sorted by name; a flat list otherwise
    const body = sort === 'name'
      ? categories.map((cat) => {
        const rows = shown.filter((g) => g.category === cat);
        if (!rows.length) return '';
        const sum = (k) => rows.reduce((s, g) => s + g[k], 0);
        return html`<tr class="group-row"><td colspan="5">${cap(cat)} <span class="muted">· ${plural(sum('total'), 'item')} in ${plural(rows.length, 'kind')}, ${sum('available')} available</span></td></tr>${rows.map(row)}`;
      })
      : shown.map(row);

    mount($('#ov-results', el), shown.length ? html`<div class="table-wrap cards overview-table"><table class="data">
      <thead><tr><th>Item</th><th>Details</th><th class="num">Total</th><th class="num">Available</th><th>Not available</th></tr></thead>
      <tbody>${body}</tbody></table></div>
      <p class="muted small-text" style="margin-top:10px">Items with identical details are counted together. Click a number to see those items in the inventory.${data.sold ? ` ${plural(data.sold, 'sold item')} not counted.` : ''}</p>`
      : html`<div class="card"><div class="empty">${data.groups.length ? 'Nothing matches that.' : 'No items yet. Add some from the Inventory or Bulk add pages.'}</div></div>`);

    $('#ov-sub', el).textContent = `${plural(shown.length, 'kind')} of item${shown.length === data.groups.length ? '' : ` (of ${data.groups.length})`}`;
  }

  mount(el, html`
    <div class="page-head">
      <div><h1>Stock overview</h1><div class="sub">Everything you own, grouped by identical details: how many of each, and how many are available right now. <span id="ov-sub"></span></div></div>
    </div>
    <div class="kpis" id="ov-kpis"></div>
    <div class="toolbar">
      <div class="grow"><input type="search" id="ov-q" placeholder="Search: description, type, connector, length…" aria-label="Search the overview"></div>
      <select id="ov-owner" aria-label="Owner"><option value="">All owners</option>${app.meta.owners.map((o) => html`<option value="${o}">${app.meta.ownerLabels[o]}</option>`)}</select>
      <select id="ov-category" aria-label="Category"><option value="">All categories</option></select>
      <select id="ov-sort" aria-label="Sort">${SORTS.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select>
    </div>
    <div id="ov-results"><div class="empty">Loading…</div></div>`);

  async function load() {
    const d = await api.get('/api/overview' + qs({ owner }));
    if (!isActive()) return;
    data = d;
    const t = d.totals;
    mount($('#ov-kpis', el), html`
      <div class="kpi"><div class="label">Kinds of item</div><div class="value">${t.kinds}</div></div>
      <div class="kpi"><div class="label">${owner === 'personal' ? 'Items I own' : owner === 'company' ? 'Company items' : 'Items you own'}</div><div class="value">${t.total}</div></div>
      <div class="kpi"><div class="label"><span class="dot" style="--c:var(--s1)"></span>Available</div><div class="value">${t.available}</div></div>
      <div class="kpi"><div class="label"><span class="dot" style="--c:var(--s2)"></span>On rental</div><div class="value">${t.on_rental}</div></div>
      <div class="kpi"><div class="label"><span class="dot" style="--c:var(--s7)"></span>Repair, lost or taken apart</div><div class="value">${t.repair + t.lost + t.disassembled}</div>
        <div class="note">${t.repair} repair · ${t.lost} lost · ${t.disassembled} disassembled</div></div>`);
    const sel = $('#ov-category', el);
    sel.innerHTML = '<option value="">All categories</option>' + [...new Set(d.groups.map((g) => g.category))].map((c) => `<option value="${c}">${cap(c)}</option>`).join('');
    sel.value = category;
    render();
  }

  $('#ov-q', el).addEventListener('input', debounce((e) => { q = e.target.value.trim(); render(); }, 150));
  $('#ov-owner', el).addEventListener('change', (e) => { owner = e.target.value; load(); });
  $('#ov-category', el).addEventListener('change', (e) => { category = e.target.value; render(); });
  $('#ov-sort', el).addEventListener('change', (e) => { sort = e.target.value; render(); });

  await load();
  return { refresh: load };
}
