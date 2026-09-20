import { $, html, mount, icon, store, CHANGED } from './util.js';
import { app, loadMeta } from './state.js';
import { initScanner, setInterceptor } from './scanner.js';
import { errorBox } from './ui.js';

import dashboardView from './views/dashboard.js';
import overviewView from './views/overview.js';
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
  ['Overview', [['dashboard', 'Dashboard', '/dashboard'], ['overview', 'Stock overview', '/overview']]],
  ['Equipment', [['inventory', 'Inventory', '/inventory'], ['bulk', 'Bulk add', '/bulk']]],
  ['Storage', [['containers', 'Containers', '/containers']]],
  ['Rentals', [['rentals', 'Rentals', '/rentals']]],
  ['Compliance', [['pat', 'PAT testing', '/pat']]],
];

const ROUTES = [
  [/^\/dashboard$/, dashboardView, '/dashboard'],
  [/^\/overview$/, overviewView, '/overview'],
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
  const apply = (t) => { document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark'; };
  // Dark is the default look; the button flips to light and remembers the choice.
  apply(store.get('theme', 'dark'));
  $('#theme-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    store.set('theme', next);
    apply(next);
  });
}

// Phone layout: the sidebar collapses to a top bar and this button slides the menu in and out.
function initMenu() {
  const sidebar = $('#sidebar');
  const btn = $('#menu-btn');
  const backdrop = $('#nav-backdrop');
  const setOpen = (open) => {
    sidebar.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    backdrop.hidden = !open;
  };
  btn.addEventListener('click', () => setOpen(!sidebar.classList.contains('open')));
  backdrop.addEventListener('click', () => setOpen(false));
  $('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  window.addEventListener('hashchange', () => setOpen(false));
}

async function boot() {
  initTheme();
  initMenu();
  mount($('#nav'), html`${NAV.map(([title, links]) => html`<div class="nav-section"><div class="nav-section-title">${title}</div>
    ${links.map(([id, label, path]) => html`<a href="#${path}" data-nav="${id}">${icon(id)}<span class="label">${label}</span></a>`)}</div>`)}`);
  try {
    await loadMeta();
  } catch (err) {
    mount($('#view'), errorBox(err));
    return;
  }
  // Two-tone name like the Inventory Control logo: first word plain, the rest in the accent colour
  const [first, ...rest] = (app.meta.company || 'Stock Tracker').split(' ');
  mount($('#brand-name'), html`${first}${rest.length ? html` <span>${rest.join(' ')}</span>` : ''}`);
  initScanner();
  document.addEventListener(CHANGED, () => current?.refresh?.());
  window.addEventListener('hashchange', route);
  route();
}

boot();
