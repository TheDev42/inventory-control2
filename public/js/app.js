import { $, html, mount, icon, store, CHANGED } from './util.js';
import { app, loadMeta } from './state.js';
import { initScanner, setInterceptor } from './scanner.js';
import { errorBox } from './ui.js';

import dashboardView from './views/dashboard.js';
import inventoryView from './views/inventory.js';
import itemView from './views/item.js';
import itemFormView from './views/itemForm.js';
import rentalsView from './views/rentals.js';
import rentalView from './views/rental.js';
import containersView from './views/containers.js';
import containerView from './views/container.js';
import patView from './views/pat.js';
import bulkView from './views/bulk.js';

const NAV = [
  ['dashboard', 'Dashboard', '/dashboard'],
  ['inventory', 'Inventory', '/inventory'],
  ['rentals', 'Rentals', '/rentals'],
  ['containers', 'Containers', '/containers'],
  ['pat', 'PAT testing', '/pat'],
  ['bulk', 'Bulk add', '/bulk'],
];

const ROUTES = [
  [/^\/dashboard$/, dashboardView, '/dashboard'],
  [/^\/inventory$/, inventoryView, '/inventory'],
  [/^\/items\/new$/, itemFormView, '/inventory'],
  [/^\/items\/(\d+)\/edit$/, itemFormView, '/inventory'],
  [/^\/items\/(\d+)$/, itemView, '/inventory'],
  [/^\/rentals$/, rentalsView, '/rentals'],
  [/^\/rentals\/(\d+)$/, rentalView, '/rentals'],
  [/^\/containers$/, containersView, '/containers'],
  [/^\/containers\/(\d+)$/, containerView, '/containers'],
  [/^\/pat$/, patView, '/pat'],
  [/^\/bulk$/, bulkView, '/bulk'],
];

let current = null;
let navToken = 0;

async function route() {
  const token = ++navToken;
  const hash = location.hash.slice(1) || '/dashboard';
  const qIndex = hash.indexOf('?');
  const path = qIndex >= 0 ? hash.slice(0, qIndex) : hash;
  const query = new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : '');

  current?.destroy?.();
  current = null;
  setInterceptor(null);

  const view = $('#view');
  const match = ROUTES.find(([re]) => re.test(path));
  if (!match) {
    mount(view, html`<div class="empty">Page not found. <a href="#/dashboard">Go to the dashboard</a></div>`);
    return;
  }
  const [re, handler, navPath] = match;
  $('#nav').querySelectorAll('a').forEach((a) => {
    if (a.getAttribute('href') === '#' + navPath) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = 'Stock Tracker';
  window.scrollTo(0, 0);

  try {
    const isActive = () => token === navToken;
    const instance = await handler({ el: view, args: path.match(re).slice(1), query, isActive });
    if (token !== navToken) { instance?.destroy?.(); return; }
    current = instance || null;
  } catch (err) {
    if (token === navToken) mount(view, errorBox(err));
  }
}

function initTheme() {
  const apply = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  apply(store.get('theme', null));
  $('#theme-btn').addEventListener('click', () => {
    const isDark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = isDark ? 'light' : 'dark';
    store.set('theme', next);
    apply(next);
  });
}

async function boot() {
  initTheme();
  mount($('#nav'), html`${NAV.map(([id, label, path]) => html`<a href="#${path}" data-nav="${id}">${icon(id)}<span class="label">${label}</span></a>`)}`);
  try {
    await loadMeta();
  } catch (err) {
    mount($('#view'), errorBox(err));
    return;
  }
  $('#brand-name').textContent = app.meta.company || 'Stock Tracker';
  initScanner();
  document.addEventListener(CHANGED, () => current?.refresh?.());
  window.addEventListener('hashchange', route);
  route();
}

boot();
