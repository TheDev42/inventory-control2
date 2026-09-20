import { api, html, mount, cap, fmtDate, timeAgo, statusBadge, patBadge, itemTitle, ends, plural } from '../util.js';

const STATES = [
  { key: 'in_stock', label: 'In stock', c: '--s1' },
  { key: 'on_rental', label: 'On rental', c: '--s2' },
  { key: 'repair', label: 'Repair', c: '--s7' },
  { key: 'lost', label: 'Lost', c: '--s5' },
  { key: 'disassembled', label: 'Disassembled', c: '--s4' },
];

const PAT_ROWS = [
  { key: 'ok', label: 'PAT OK', icon: '✓', c: '--good' },
  { key: 'due_soon', label: 'Due in 30 days', icon: '▲', c: '--warning' },
  { key: 'overdue', label: 'Overdue', icon: '✕', c: '--critical' },
  { key: 'failed', label: 'Failed', icon: '✕', c: '--critical' },
  { key: 'never', label: 'Never tested', icon: '?', c: '--serious' },
  { key: 'na', label: 'Not required', icon: '–', c: '--muted' },
];

const kpi = (label, value, { href, color, note } = {}) => html`
  <a class="kpi" href="${href || '#/inventory'}">
    <div class="label">${color ? html`<span class="dot" style="--c:var(${color})"></span>` : ''}${label}</div>
    <div class="value">${value}</div>
    ${note ? html`<div class="note">${note}</div>` : ''}
  </a>`;

function stockByType(rows) {
  if (!rows.length) return html`<div class="empty">No items yet. <a href="#/bulk">Bulk add some</a> or <a href="#/items/new">add one</a>.</div>`;
  const max = Math.max(...rows.map((r) => r.total));
  return html`
    <div class="legend">${STATES.map((s) => html`<span class="key"><span class="sw" style="--c:var(${s.c})"></span>${s.label}</span>`)}</div>
    <div class="hbars">${rows.map((r) => {
      const parts = STATES.filter((s) => r[s.key] > 0);
      return html`<div class="hbar">
        <div class="name">${cap(r.category)} · ${r.type}</div>
        <div class="track" style="width:${(r.total / max) * 100}%" role="img"
          aria-label="${parts.map((s) => `${r[s.key]} ${s.label.toLowerCase()}`).join(', ')}">
          ${parts.map((s) => html`<span class="seg-fill" style="--c:var(${s.c});flex:${r[s.key]}" title="${r[s.key]} ${s.label.toLowerCase()}"></span>`)}
        </div>
        <div class="total">${r.total}</div>
      </div>
      ${''}`;
    })}</div>
    <p class="muted small-text" style="margin-top:12px">Bar length is relative to the biggest group. Hover a segment for its count.</p>`;
}

function patPanel(pat, total) {
  const max = Math.max(1, total);
  return html`<div class="patbars">${PAT_ROWS.map((r) => html`
    <a class="patbar" href="#/pat?status=${r.key}">
      <span><span style="color:var(${r.c});font-weight:800">${r.icon}</span> ${r.label}</span>
      <span class="track"><span class="seg-fill" style="--c:var(${r.c});width:${(pat[r.key] / max) * 100}%;${pat[r.key] ? '' : 'min-width:0'}"></span></span>
      <span class="n">${pat[r.key]}</span>
    </a>`)}</div>`;
}

const activityLine = (e) => html`<li>
  <span class="what">${e.item_id ? html`<a class="barcode" href="#/items/${e.item_id}">${e.barcode}</a> ` : e.barcode ? html`<span class="barcode">${e.barcode}</span> ` : ''}${e.detail}</span>
  <span class="when">${timeAgo(e.ts)}</span></li>`;

export default async function dashboardView({ el, isActive }) {
  async function load() {
    const d = await api.get('/api/dashboard');
    if (!isActive()) return;
    const t = d.totals;
    const patAttention = d.pat.overdue + d.pat.failed + d.pat.never;
    mount(el, html`
      <div class="page-head">
        <div><h1>Dashboard</h1><div class="sub">${plural(t.total, 'item')} across ${plural(t.containers, 'container')} · ${fmtDate(d.today)}</div></div>
        <div class="actions">
          <a class="btn secondary" href="#/bulk">Bulk add</a>
          <a class="btn secondary" href="#/rentals">New rental</a>
        </div>
      </div>

      <div class="kpis">
        ${kpi('Total items', t.total)}
        ${kpi('In stock', t.in_stock, { href: '#/inventory?status=in_stock', color: '--s1' })}
        ${kpi('On rental', t.on_rental, { href: '#/inventory?status=on_rental', color: '--s2' })}
        ${kpi('In containers', t.in_containers, { href: '#/containers', note: plural(t.containers, 'container') })}
        ${kpi('Lost', t.lost, { href: '#/inventory?status=lost', color: '--s5' })}
        ${kpi('Disassembled / repair', t.disassembled + t.repair, { href: '#/inventory?status=disassembled', color: '--s4', note: `${t.disassembled} disassembled · ${t.repair} repair` })}
        ${kpi('PAT needs attention', patAttention, { href: '#/pat', note: `${d.pat.overdue} overdue · ${d.pat.failed} failed · ${d.pat.never} never tested` })}
      </div>

      <div class="grid side">
        <section class="card"><div class="card-head"><h2>Stock by type</h2><a href="#/inventory">View all</a></div>${stockByType(d.byType)}</section>
        <section class="card"><div class="card-head"><h2>PAT testing</h2><a href="#/pat">Manage</a></div>${patPanel(d.pat, t.total)}</section>
      </div>

      <div class="grid cols-2" style="margin-top:16px">
        <section class="card">
          <div class="card-head"><h2>Active rentals</h2><a href="#/rentals">All rentals</a></div>
          ${d.activeRentals.length ? html`<div class="table-wrap"><table class="data">
            <thead><tr><th>Rental</th><th>Ends</th><th class="num">Out</th></tr></thead>
            <tbody>${d.activeRentals.map((r) => html`<tr class="clickable" onclick="location.hash='#/rentals/${r.id}'">
              <td><a href="#/rentals/${r.id}"><strong>${r.name}</strong></a>${r.customer ? html`<div class="muted small-text">${r.customer}</div>` : ''}</td>
              <td class="nowrap">${r.end_date ? fmtDate(r.end_date) : '—'} ${r.overdue ? html`<span class="badge pat-bad"><span class="ico">✕</span>Overdue</span>` : ''}</td>
              <td class="num">${r.out_count}<span class="muted"> / ${r.total_count}</span></td></tr>`)}</tbody></table></div>`
            : html`<div class="empty">No active rentals. <a href="#/rentals">Create one</a> to start scanning items out.</div>`}
        </section>

        <section class="card">
          <div class="card-head"><h2>Needs attention</h2></div>
          ${d.attention.length || d.patAttention.length ? html`<div class="table-wrap"><table class="data"><tbody>
            ${d.attention.map((it) => html`<tr class="clickable" onclick="location.hash='#/items/${it.id}'">
              <td><a class="barcode" href="#/items/${it.id}">${it.barcode}</a></td><td>${itemTitle(it)}</td><td>${statusBadge(it.status)}</td></tr>`)}
            ${d.patAttention.map((it) => html`<tr class="clickable" onclick="location.hash='#/items/${it.id}'">
              <td><a class="barcode" href="#/items/${it.id}">${it.barcode}</a></td><td>${itemTitle(it)}</td><td>${patBadge(it.pat_status)}</td></tr>`)}
          </tbody></table></div>`
            : html`<div class="empty">Nothing flagged — no lost, disassembled, repair or overdue-PAT items.</div>`}
        </section>
      </div>

      <section class="card" style="margin-top:16px">
        <div class="card-head"><h2>Recent activity</h2></div>
        ${d.activity.length ? html`<ul class="feed">${d.activity.map(activityLine)}</ul>` : html`<div class="empty">Activity from scans and edits will show up here.</div>`}
      </section>`);
  }

  await load();
  return { refresh: load };
}
