/* Public hire site. Self-contained on purpose: it shares no code with the admin app, so neither can
   break the other. Runs under a strict CSP, which means no inline styles and no inline handlers. */

/* ---------- tiny helpers ---------- */
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Safe(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const render = (v) => {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
};
const html = (strings, ...vals) => new Safe(strings.reduce((out, s, i) => out + s + (i < vals.length ? render(vals[i]) : ''), ''));
const mount = (el, tpl) => { if (el) el.innerHTML = tpl instanceof Safe ? tpl.s : esc(tpl); };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private browsing */ } },
};

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error('Cannot reach the server. Please check your connection.'); }
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.short = data?.short;
    throw err;
  }
  return data;
}

const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtRange = (a, b) => (a && b ? (a === b ? fmtDate(a) : `${fmtDate(a)} to ${fmtDate(b)}`) : '');
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const days = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000) + 1;

function toast(message, kind = 'info', ms = 3600) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, ms);
}

const PLACEHOLDER = raw(`<div class="ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/></svg></div>`);

const picture = (scope, key, hasImage, alt, cls = 'thumb') =>
  html`<div class="${cls}">${hasImage ? html`<img src="/img/${scope}/${key}" alt="${alt}" loading="lazy" decoding="async">` : PLACEHOLDER}</div>`;

const availPill = (n, dated) => {
  const cls = n === 0 ? 'none' : n <= 2 ? 'low' : 'ok';
  const label = n === 0 ? 'None free' : `${n} available`;
  return html`<span class="pill ${cls}" title="${dated ? 'Free for the dates you chose' : 'In stock right now'}"><span class="dot" aria-hidden="true"></span>${label}</span>`;
};

/* ---------- state kept in the browser ---------- */
const BOOKING_KEY = 'hire.booking';
const CASE_KEY = 'hire.case';
const BOOKING_FIELDS = ['start', 'end', 'client', 'event', 'name', 'email'];

// Both of these come back from localStorage, which anyone can edit, so they are checked rather than trusted.
const loadCase = () => {
  const saved = store.get(CASE_KEY, []);
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((l) => l && /^[a-f0-9]{16}$/.test(String(l.key)) && Number.isFinite(Number(l.qty)))
    .map((l) => ({ key: String(l.key), label: String(l.label ?? ''), details: l.details ? String(l.details) : null, qty: Math.min(999, Math.max(1, Math.floor(Number(l.qty)))) }))
    .slice(0, 100);
};

const state = {
  meta: { company: 'Hire', contactEmail: '', contactPhone: '', today: '' },
  booking: { ...(store.get(BOOKING_KEY, {}) || {}) },
  flightCase: loadCase(),
  notes: '', // only for this visit, so it is not kept between sessions
};

const bookingComplete = () => BOOKING_FIELDS.every((f) => String(state.booking[f] || '').trim());
const saveBooking = () => store.set(BOOKING_KEY, state.booking);
const saveCase = () => { store.set(CASE_KEY, state.flightCase); paintCaseCount(); };
const dateWindow = () => (state.booking.start && state.booking.end ? { start: state.booking.start, end: state.booking.end } : {});
const caseTotal = () => state.flightCase.reduce((s, l) => s + l.qty, 0);

function addToCase(item, qty) {
  const line = state.flightCase.find((l) => l.key === item.key);
  if (line) line.qty = Math.min(999, line.qty + qty);
  else state.flightCase.push({ key: item.key, label: item.label, details: item.details || null, qty });
  saveCase();
}

function paintCaseCount() {
  const n = caseTotal();
  const badge = $('#case-count');
  badge.textContent = String(n);
  badge.hidden = n === 0;
  $('#case-link').setAttribute('aria-label', n ? `Flight case, ${plural(n, 'item')}` : 'Flight case, empty');
}

/* ---------- the hire details form (dates, client, event, who is asking) ---------- */
// Browsing needs none of this. It is asked for once, the first time someone adds something to a
// flight case, because the dates decide what is actually free.
function openBookingModal({ reason, onDone, onCancel } = {}) {
  const host = $('#modal-host');
  const b = state.booking;
  const minDate = state.meta.today || '';
  host.hidden = false;
  mount(host, html`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="bk-title">
    <h2 id="bk-title">Your hire details</h2>
    <p class="lead">${reason || 'We need these before anything can go in a flight case. You can keep browsing without them.'}</p>
    <form id="bk-form" novalidate>
      <div class="field-row">
        <label class="field"><span>Hire from</span><input type="date" name="start" value="${b.start || ''}" min="${minDate}" required></label>
        <label class="field"><span>Hire until</span><input type="date" name="end" value="${b.end || ''}" min="${minDate}" required></label>
      </div>
      <label class="field"><span>Client <span class="hint muted">who the kit is for</span></span><input name="client" value="${b.client || ''}" maxlength="120" autocomplete="organization" required></label>
      <label class="field"><span>Event</span><input name="event" value="${b.event || ''}" maxlength="120" required></label>
      <div class="field-row">
        <label class="field"><span>Your name</span><input name="name" value="${b.name || ''}" maxlength="120" autocomplete="name" required></label>
        <label class="field"><span>Your email</span><input type="email" name="email" value="${b.email || ''}" maxlength="160" autocomplete="email" required></label>
      </div>
      <div class="form-error" id="bk-error" role="alert"></div>
      <div class="actions">
        <button class="btn ghost" type="button" id="bk-cancel">Cancel</button>
        <button class="btn primary" type="submit">Save details</button>
      </div>
    </form>
  </div>`);

  let settled = false;
  const close = (saved) => {
    if (settled) return;
    settled = true;
    host.hidden = true;
    mount(host, '');
    document.removeEventListener('keydown', onKey);
    if (!saved) onCancel?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(false); };
  document.addEventListener('keydown', onKey);
  $('#bk-cancel', host).addEventListener('click', () => close(false));
  host.addEventListener('click', (e) => { if (e.target === host) close(false); });
  $('#bk-form', host).querySelector('input')?.focus();

  $('#bk-form', host).addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    const next = {};
    for (const f of BOOKING_FIELDS) next[f] = String(data[f] || '').trim();
    const fail = (msg) => { $('#bk-error', host).textContent = msg; };
    if (!next.start || !next.end) return fail('Please pick both dates.');
    if (next.end < next.start) return fail('The end date is before the start date.');
    if (state.meta.today && next.end < state.meta.today) return fail('Those dates are in the past.');
    if (!next.client) return fail('Please say who the client is.');
    if (!next.event) return fail('Please name the event.');
    if (!next.name) return fail('Please give your name.');
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(next.email)) return fail('Please check your email address.');
    const datesChanged = next.start !== state.booking.start || next.end !== state.booking.end;
    state.booking = next;
    saveBooking();
    paintBookingBar();
    close(true);
    onDone?.({ datesChanged });
  });
}

// Resolves true once the details are there, false if the visitor backs out.
const requireBooking = (reason) =>
  new Promise((resolve) => {
    if (bookingComplete()) return resolve(true);
    openBookingModal({ reason, onDone: () => resolve(true), onCancel: () => resolve(false) });
  });

function paintBookingBar() {
  const bar = $('#booking-bar');
  if (!bookingComplete()) { bar.hidden = true; mount(bar, ''); return; }
  const b = state.booking;
  bar.hidden = false;
  mount(bar, html`
    <span class="bk"><b>${fmtRange(b.start, b.end)}</b> <span>· ${plural(days(b.start, b.end), 'day')}</span></span>
    <span class="bk"><span>Client</span> <b>${b.client}</b></span>
    <span class="bk"><span>Event</span> <b>${b.event}</b></span>
    <span class="spacer"></span>
    <button class="btn ghost small" type="button" id="bk-edit">Change</button>`);
  $('#bk-edit', bar).addEventListener('click', () =>
    openBookingModal({ reason: 'Change the dates or who it is for. Changing the dates re-checks what is free.', onDone: () => route() }));
}

/* ---------- pages ---------- */
const view = () => $('#main');

async function homePage() {
  const data = await api('GET', '/api/catalogue' + qs(dateWindow()));

  mount(view(), html`<div class="wrap">
    <div class="hero">
      <div>
        <h1>What do you need?</h1>
        <p>Pick a category to see what we have and how many are free. Add what you want to a flight case and send it over — it reserves the kit straight away, and we will ask you to confirm the details are right.</p>
      </div>
      ${bookingComplete() ? '' : html`<button class="btn" type="button" id="set-dates">Set your hire dates</button>`}
    </div>
    ${data.dated
      ? html`<p class="muted small">Quantities below are what is free for <b>${fmtRange(state.booking.start, state.booking.end)}</b>.</p>`
      : html`<p class="muted small">Quantities below are what is in stock right now. Set your hire dates to see what is free for them.</p>`}
    ${data.subcategories.length
      ? html`<div class="grid">${data.subcategories.map((s) => html`<a class="tile" href="#/c/${s.slug}">
          ${picture('subcategory', s.slug, s.image, s.label)}
          <div class="tile-body">
            <div class="name">${s.label}</div>
            <div class="det">${plural(s.kinds, 'kind')} · ${plural(s.total, 'item')}</div>
            <div class="foot">${availPill(s.available, data.dated)}</div>
          </div></a>`)}</div>`
      : html`<div class="empty">Nothing is listed for hire yet. Please check back soon.</div>`}
  </div>`);

  $('#set-dates')?.addEventListener('click', () => openBookingModal({ onDone: () => route() }));
}

// Items keep the order the server gave them (sort_order, arranged from the admin). Grouping by
// section only clusters consecutive same-section runs — it never re-sorts — so an admin who wants
// "16A" kit together just has to arrange it together, same as any other ordering.
function groupBySection(types) {
  const sections = [];
  for (const t of types) {
    const last = sections[sections.length - 1];
    if (last && last.name === (t.section || null)) last.items.push(t);
    else sections.push({ name: t.section || null, items: [t] });
  }
  return sections;
}

const typeTile = (t, dated) => html`<a class="tile" href="#/i/${t.key}">
  ${picture('type', t.key, t.image, t.label)}
  <div class="tile-body">
    <div class="name">${t.label}</div>
    ${t.details ? html`<div class="det">${t.details}</div>` : ''}
    <div class="foot">${availPill(t.available, dated)}<span class="muted small">${t.total} owned</span></div>
  </div></a>`;

async function subcategoryPage(slug) {
  const data = await api('GET', `/api/subcategories/${encodeURIComponent(slug)}` + qs(dateWindow()));
  const s = data.subcategory;
  const sections = groupBySection(data.types);
  mount(view(), html`<div class="wrap">
    <div class="crumbs"><a href="#/">All categories</a><span aria-hidden="true">/</span><span>${s.label}</span></div>
    <div class="page-head">
      <h1>${s.label}</h1>
      <div class="sub">${plural(data.types.length, 'kind of item')} · ${s.available} of ${s.total} ${data.dated ? 'free for your dates' : 'in stock now'}</div>
      ${s.about ? html`<p class="about muted">${s.about}</p>` : ''}
    </div>
    ${sections.length > 1 || sections[0]?.name
      ? sections.map((sec) => html`<div class="kit-section">
          ${sec.name ? html`<div class="kit-section-head">${sec.name}</div>` : ''}
          <div class="grid">${sec.items.map((t) => typeTile(t, data.dated))}</div>
        </div>`)
      : html`<div class="grid">${data.types.map((t) => typeTile(t, data.dated))}</div>`}
  </div>`);
}

async function itemPage(key) {
  const data = await api('GET', `/api/items/${encodeURIComponent(key)}` + qs(dateWindow()));
  const it = data.item;
  const inCase = state.flightCase.find((l) => l.key === it.key)?.qty || 0;
  const cap = (s) => s.charAt(0) + s.slice(1).toLowerCase();
  const max = Math.max(1, it.available);

  mount(view(), html`<div class="wrap">
    <div class="crumbs"><a href="#/">All categories</a><span aria-hidden="true">/</span>
      <a href="#/c/${it.subcategory}">${data.subcategory?.label || it.subcategory}</a><span aria-hidden="true">/</span><span>${it.label}</span></div>
    <div class="item-layout">
      ${picture('type', it.key, it.image, it.label, 'item-photo thumb')}
      <div>
        <h1>${it.label}</h1>
        <p class="muted">${cap(it.category)} · ${it.type}</p>
        <div class="spec">
          ${it.details ? html`<div><span class="k">Details</span><span>${it.details}</span></div>` : ''}
          ${it.male_connector || it.female_connector ? html`<div><span class="k">Connectors</span><span>${it.male_connector || '?'} to ${it.female_connector || '?'}</span></div>` : ''}
          ${it.input_connector ? html`<div><span class="k">Input</span><span>${it.input_connector}</span></div>` : ''}
          ${it.length_m != null ? html`<div><span class="k">Length</span><span>${it.length_m} m</span></div>` : ''}
          <div><span class="k">We own</span><span>${plural(it.total, 'of these')}</span></div>
          <div><span class="k">${data.dated ? 'Free for your dates' : 'Free right now'}</span><span>${availPill(it.available, data.dated)}</span></div>
        </div>
        ${it.about ? html`<h2>About this item</h2><p class="about">${it.about}</p>` : ''}

        <div class="add-box">
          ${it.available === 0
            ? html`<p class="muted">None of these are free ${data.dated ? 'for the dates you picked — try different dates, or get in touch and we will see what we can do.' : 'at the moment.'}</p>`
            : html`<div class="add-row">
              <div class="qty">
                <button type="button" id="q-minus" aria-label="One fewer">-</button>
                <input id="q-input" type="number" inputmode="numeric" min="1" max="${max}" value="1" aria-label="How many">
                <button type="button" id="q-plus" aria-label="One more">+</button>
              </div>
              <button class="btn primary" type="button" id="add-btn">Add to flight case</button>
            </div>
            <p class="muted small">${max} is the most we can do ${data.dated ? 'for those dates' : 'today'}.${bookingComplete() ? '' : ' You will be asked for your dates and details first.'}</p>`}
          ${inCase ? html`<p class="muted small">${plural(inCase, 'of these is', 'of these are')} already in your flight case. <a href="#/case">View it</a>.</p>` : ''}
        </div>
      </div>
    </div>
  </div>`);

  if (it.available === 0) return;

  const input = $('#q-input');
  const clamp = () => {
    const n = Math.floor(Number(input.value));
    input.value = String(!Number.isInteger(n) || n < 1 ? 1 : Math.min(max, n));
  };
  $('#q-minus').addEventListener('click', () => { input.value = String(Math.max(1, Math.floor(Number(input.value) || 1) - 1)); });
  $('#q-plus').addEventListener('click', () => { input.value = String(Math.min(max, Math.floor(Number(input.value) || 0) + 1)); });
  input.addEventListener('change', clamp);

  $('#add-btn').addEventListener('click', async (e) => {
    clamp();
    const wanted = Number(input.value);
    e.currentTarget.disabled = true;
    try {
      if (!(await requireBooking(`Before putting ${it.label} in a flight case, tell us when you need it and who it is for.`))) return;
      // The dates may only just have been given, so check the real number for them before adding.
      const fresh = (await api('GET', `/api/items/${encodeURIComponent(it.key)}` + qs(dateWindow()))).item;
      const already = state.flightCase.find((l) => l.key === fresh.key)?.qty || 0;
      const room = fresh.available - already;
      if (room <= 0) {
        toast(`All ${fresh.available} of those are already in your flight case`, 'bad');
        return route();
      }
      const qty = Math.min(wanted, room);
      addToCase(fresh, qty);
      toast(qty < wanted
        ? `Only ${qty} more were free, so that is what went in`
        : `${qty} × ${fresh.label} added to your flight case`, 'good');
      route();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      const btn = $('#add-btn');
      if (btn) btn.disabled = false;
    }
  });
}

async function casePage() {
  // Saved dates expire, so a case can outlive the details that were given for it: ask again before showing it.
  if (state.flightCase.length && !bookingComplete()) {
    mount(view(), html`<div class="wrap"><div class="empty">We need your hire dates and details again before we can price up your flight case.
      <p><button class="btn primary" type="button" id="case-redo">Enter your details</button></p></div></div>`);
    $('#case-redo').addEventListener('click', () =>
      openBookingModal({ reason: 'Your saved dates have passed. Tell us the new ones and we will re-check what is free.', onDone: () => route() }));
    return;
  }
  const data = state.flightCase.length ? await api('GET', '/api/catalogue' + qs(dateWindow())) : { types: [], dated: false };
  const byKey = new Map(data.types.map((t) => [t.key, t]));
  // Anything that has been edited out of the inventory since it was added is dropped rather than left to fail on send.
  const dropped = state.flightCase.filter((l) => !byKey.has(l.key));
  if (dropped.length) {
    state.flightCase = state.flightCase.filter((l) => byKey.has(l.key));
    saveCase();
  }
  const lines = state.flightCase.map((l) => ({ ...l, live: byKey.get(l.key) }));
  const b = state.booking;
  const short = lines.filter((l) => l.qty > l.live.available);

  mount(view(), html`<div class="wrap">
    <div class="page-head">
      <h1>Your flight case</h1>
      <div class="sub">${lines.length ? `${plural(caseTotal(), 'item')} in ${plural(lines.length, 'kind')}` : 'Nothing in it yet.'}</div>
    </div>
    ${dropped.length ? html`<div class="notice warn">${plural(dropped.length, 'item')} had to be removed because it is no longer listed.</div>` : ''}
    ${!lines.length
      ? html`<div class="empty">Your flight case is empty. <a href="#/">Have a look at what we have</a>.</div>`
      : html`<div class="case-layout">
        <div class="card">
          <div class="lines">${lines.map((l) => html`<div class="line" data-key="${l.key}">
            ${picture('type', l.key, l.live.image, l.live.label, 'mini')}
            <div>
              <div class="nm"><a href="#/i/${l.key}">${l.live.label}</a></div>
              ${l.live.details ? html`<div class="det">${l.live.details}</div>` : ''}
              ${l.qty > l.live.available
                ? html`<div class="warn">Only ${l.live.available} free ${data.dated ? 'for your dates' : 'right now'}</div>`
                : html`<div class="det">${l.live.available} free</div>`}
            </div>
            <div class="qty">
              <button type="button" data-act="minus" aria-label="One fewer ${l.live.label}">-</button>
              <input type="number" min="1" max="${Math.max(l.qty, l.live.available)}" value="${l.qty}" data-act="set" aria-label="How many ${l.live.label}">
              <button type="button" data-act="plus" aria-label="One more ${l.live.label}">+</button>
            </div>
            <button class="btn ghost small danger rm" type="button" data-act="remove" aria-label="Remove ${l.live.label}">Remove</button>
          </div>`)}</div>
        </div>

        <div class="sticky">
          <div class="card summary">
            <h2>Hire details</h2>
            <dl>
              <dt>Dates</dt><dd>${fmtRange(b.start, b.end)} <span class="muted">(${plural(days(b.start, b.end), 'day')})</span></dd>
              <dt>Client</dt><dd>${b.client}</dd>
              <dt>Event</dt><dd>${b.event}</dd>
              <dt>Name</dt><dd>${b.name}</dd>
              <dt>Email</dt><dd>${b.email}</dd>
            </dl>
            <p class="small"><button class="btn ghost small" type="button" id="case-edit">Change details</button></p>
            <label class="field"><span>Anything else we should know? <span class="hint muted">optional</span></span><textarea id="case-notes" maxlength="2000" placeholder="Delivery, collection times, cable runs…">${state.notes}</textarea></label>
            ${short.length ? html`<div class="notice bad small">Some lines are more than we have free. Lower them before sending.</div>` : ''}
            <button class="btn primary" type="button" id="send-btn" ${short.length ? raw('disabled') : ''}>Book this kit</button>
            <p class="muted small">This reserves the kit straight away. You'll get a reference and a hire sheet to download — please get in touch afterwards to confirm everything is correct.</p>
            <div class="form-error" id="send-error" role="alert"></div>
          </div>
        </div>
      </div>`}
  </div>`);

  if (!lines.length) return;

  $('#case-notes').addEventListener('input', (e) => { state.notes = e.target.value; });

  $('#case-edit').addEventListener('click', () =>
    openBookingModal({ reason: 'Change the dates or who it is for. Changing the dates re-checks what is free.', onDone: () => route() }));

  $('.lines').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const key = btn.closest('.line').dataset.key;
    const line = state.flightCase.find((l) => l.key === key);
    if (!line) return;
    const free = byKey.get(key)?.available ?? 999;
    if (btn.dataset.act === 'remove') state.flightCase = state.flightCase.filter((l) => l.key !== key);
    else if (btn.dataset.act === 'plus') {
      if (line.qty >= free) return toast(`Only ${free} of those are free`, 'bad');
      line.qty += 1;
    } else if (btn.dataset.act === 'minus') line.qty = Math.max(1, line.qty - 1);
    saveCase();
    route();
  });

  $('.lines').addEventListener('change', (e) => {
    const input = e.target.closest('input[data-act="set"]');
    if (!input) return;
    const line = state.flightCase.find((l) => l.key === input.closest('.line').dataset.key);
    if (!line) return;
    const free = byKey.get(line.key)?.available ?? 999;
    const n = Math.floor(Number(input.value));
    line.qty = !Number.isInteger(n) || n < 1 ? 1 : Math.min(Math.max(1, free), n);
    saveCase();
    route();
  });

  $('#send-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    $('#send-error').textContent = '';
    try {
      const { reference, jobNumber } = await api('POST', '/api/requests', {
        client: b.client, event: b.event, renter_name: b.name, renter_email: b.email,
        start_date: b.start, end_date: b.end, notes: state.notes,
        lines: state.flightCase.map((l) => ({ key: l.key, qty: l.qty })),
      });
      state.flightCase = [];
      state.notes = '';
      saveCase();
      showSent(jobNumber, reference);
    } catch (err) {
      btn.disabled = false;
      $('#send-error').textContent = err.message + (err.short?.length ? ` (${err.short.map((s) => `${s.label}: ${s.available} free, ${s.wanted} asked for`).join('; ')})` : '');
      if (err.short?.length) route();
    }
  });
}

// `reference` is only ever used here, as the unguessable token the PDF download needs — it's never
// shown. The job number (sequential) is what's displayed, and walking it must not expose someone
// else's hire sheet, which is why the PDF route is keyed by reference instead.
function showSent(jobNumber, reference) {
  const b = state.booking;
  const mailBody = encodeURIComponent(
    `Hi,\n\nPlease can you confirm everything for ${jobNumber} is correct:\n\nClient: ${b.client}\nEvent: ${b.event}\nDates: ${fmtRange(b.start, b.end)}\n\nThanks,\n${b.name}`
  );
  const contact = state.meta.contactEmail
    ? html`<a class="btn primary" href="mailto:${state.meta.contactEmail}?subject=${encodeURIComponent(`Please confirm ${jobNumber}`)}&body=${mailBody}">Email us to confirm</a>`
    : state.meta.contactPhone ? html`<a class="btn primary" href="tel:${state.meta.contactPhone.replace(/\s+/g, '')}">Call us to confirm</a>` : '';
  mount(view(), html`<div class="wrap">
    <div class="hero">
      <div>
        <h1>Booked — <span class="mono">${jobNumber}</span></h1>
        <p>Thanks ${b.name}. This has reserved the kit for ${fmtRange(b.start, b.end)}, but please get in touch to confirm everything is correct before the day${state.meta.contactEmail || state.meta.contactPhone ? '' : ` — we'll follow up at ${b.email}`}.</p>
      </div>
      <div class="actions">
        ${contact}
        <a class="btn" href="/api/requests/${encodeURIComponent(reference)}/pdf">Download hire sheet (PDF)</a>
      </div>
    </div>
    <p class="muted small">Quote <b>${jobNumber}</b> if you call or write in. <a href="#/">Back to browsing</a>.</p>
  </div>`);
  window.scrollTo(0, 0);
}

/* ---------- search ---------- */
// Filters the catalogue already fetched for browsing — there's nothing here that needs its own
// endpoint, since a search is just a different view over the same subcategories and item kinds.
async function searchPage(q) {
  $('#top-search-input').value = q;
  const data = await api('GET', '/api/catalogue' + qs(dateWindow()));
  const term = q.trim().toLowerCase();
  const terms = term.split(/\s+/).filter(Boolean);
  const hay = (parts) => parts.filter(Boolean).join(' ').toLowerCase();
  const matchedSubs = data.subcategories.filter((s) => terms.every((t) => hay([s.label, s.about]).includes(t)));
  const matchedTypes = data.types.filter((t) => terms.every((w) => hay([t.label, t.details, t.about, t.category, t.type]).includes(w)));

  mount(view(), html`<div class="wrap">
    <div class="page-head">
      <h1>Search</h1>
      <div class="sub">${term ? html`Results for “${q}”` : 'Type something into the search box above.'}</div>
    </div>
    ${!term
      ? ''
      : !matchedSubs.length && !matchedTypes.length
      ? html`<div class="empty">Nothing matches “${q}”.</div>`
      : html`
        ${matchedSubs.length ? html`<div class="section-title"><h2>Categories</h2><span class="rule"></span></div>
          <div class="grid">${matchedSubs.map((s) => html`<a class="tile" href="#/c/${s.slug}">
            ${picture('subcategory', s.slug, s.image, s.label)}
            <div class="tile-body"><div class="name">${s.label}</div>
              <div class="det">${plural(s.kinds, 'kind')} · ${plural(s.total, 'item')}</div>
              <div class="foot">${availPill(s.available, data.dated)}</div></div></a>`)}</div>` : ''}
        ${matchedTypes.length ? html`<div class="section-title"><h2>Items</h2><span class="rule"></span></div>
          <div class="grid">${matchedTypes.map((t) => typeTile(t, data.dated))}</div>` : ''}`}
  </div>`);
}

/* ---------- stock list: everything, flat, for people who already know what they want ---------- */
async function stockPage(q = '') {
  const data = await api('GET', '/api/catalogue' + qs(dateWindow()));
  const term = q.trim().toLowerCase();
  const terms = term.split(/\s+/).filter(Boolean);
  const hay = (t) => [t.label, t.details, t.category, t.type].filter(Boolean).join(' ').toLowerCase();
  const shown = data.types.filter((t) => terms.every((w) => hay(t).includes(w)));
  const cap = (s) => s.charAt(0) + s.slice(1).toLowerCase();

  mount(view(), html`<div class="wrap">
    <div class="page-head">
      <h1>Everything we have</h1>
      <div class="sub">${plural(data.types.length, 'kind of item')} across every category. ${data.dated ? 'Showing what is free for your dates.' : 'Set your hire dates to see what is free for them.'}</div>
    </div>
    <div class="toolbar"><input type="search" id="stock-q" value="${q}" placeholder="Filter by name, type or connector…" aria-label="Filter the stock list"></div>
    ${shown.length ? html`<div class="stock-table">${shown.map((t) => html`<a class="stock-row" href="#/i/${t.key}">
        ${picture('type', t.key, t.image, t.label, 'mini')}
        <div><div class="nm">${t.label}</div><div class="det">${cap(t.category)} · ${t.type}${t.details ? ` · ${t.details}` : ''}</div></div>
        ${availPill(t.available, data.dated)}
      </a>`)}</div>` : html`<div class="empty">Nothing matches.</div>`}
  </div>`);

  $('#stock-q').addEventListener('input', debounce((e) => {
    const next = e.target.value;
    history.replaceState(null, '', `#/stock${qs({ q: next })}`);
    stockPage(next);
  }, 220));
}

/* ---------- routing ---------- */
const ROUTES = [
  [/^\/?$/, () => homePage()],
  [/^\/c\/([a-z0-9-]{1,80})$/, (m) => subcategoryPage(m[1])],
  [/^\/i\/([a-f0-9]{16})$/, (m) => itemPage(m[1])],
  [/^\/case$/, () => casePage()],
  [/^\/search$/, (_m, query) => searchPage(query.get('q') || '')],
  [/^\/stock$/, (_m, query) => stockPage(query.get('q') || '')],
];

let token = 0;
async function route() {
  const mine = ++token;
  const hash = location.hash.slice(1);
  const qIndex = hash.indexOf('?');
  const rawPath = qIndex >= 0 ? hash.slice(0, qIndex) : hash;
  const query = new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : '');
  let path;
  try { path = decodeURIComponent(rawPath) || '/'; } catch { path = rawPath || '/'; } // a hand-mangled URL must not blank the page
  const match = ROUTES.reduce((found, [re, fn]) => found || (re.test(path) ? [path.match(re), fn] : null), null);
  $$('.top-nav > a').forEach((a) => {
    if (a.getAttribute('href') === '#' + path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (path !== '/search') $('#top-search-input').value = '';

  if (!match) {
    mount(view(), html`<div class="wrap"><div class="empty">That page does not exist. <a href="#/">Start again</a>.</div></div>`);
    return;
  }
  try {
    await match[1](match[0], query);
  } catch (err) {
    if (mine !== token) return;
    mount(view(), html`<div class="wrap"><div class="empty">${err.message === 'Not found' ? 'We could not find that.' : err.message} <a href="#/">Start again</a>.</div></div>`);
  }
}

async function boot() {
  paintCaseCount();
  try {
    state.meta = await api('GET', '/api/meta');
  } catch {
    mount(view(), html`<div class="wrap"><div class="empty">The hire catalogue is not reachable right now. Please try again shortly.</div></div>`);
    return;
  }
  const [first, ...rest] = String(state.meta.company || 'Hire').split(' ');
  mount($('#brand-name'), html`${first}${rest.length ? html` <em>${rest.join(' ')}</em>` : ''}`);
  document.title = `${state.meta.company} hire`;
  mount($('#foot-inner'), html`<span>${state.meta.company} dry hire</span>
    <span>${[state.meta.contactEmail && html`<a href="mailto:${state.meta.contactEmail}">${state.meta.contactEmail}</a>`, state.meta.contactPhone].filter(Boolean).map((v, i) => html`${i ? ' · ' : ''}${v}`)}</span>`);

  // A logo, if one has been set, replaces the text wordmark but keeps the same link and alt text.
  try {
    const check = await fetch('/img/site/logo', { method: 'GET' });
    if (check.ok) {
      const logo = $('#brand-logo');
      logo.src = '/img/site/logo';
      logo.alt = state.meta.company;
      logo.hidden = false;
      $('#brand-mark').hidden = true;
      $('#brand-name').hidden = true;
    }
  } catch { /* no logo: the text wordmark stays */ }

  $('#top-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#top-search-input').value.trim();
    location.hash = `#/search${qs({ q })}`;
  });

  // Dates in the past are no use: if the saved ones have expired, ask again on the next add.
  if (state.booking.end && state.meta.today && state.booking.end < state.meta.today) {
    state.booking = { ...state.booking, start: '', end: '' };
    saveBooking();
  }
  paintBookingBar();
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });
  route();
}

boot();
