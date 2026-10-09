import { api, html, mount, $, cap, toast, plural } from '../util.js';
import { loadMeta } from '../state.js';

// Which extra boxes an item of a sub-category gets on its form
// Shorter wording for the drop-down on each existing sub-category, where there is less room
const SHORT = { none: 'No connectors', ends: 'Male + female end', outputs: 'Input + outputs' };
const FIELDS = [
  ['none', 'No connectors'],
  ['ends', 'Male + female end (cables, adapters)'],
  ['outputs', 'Input + list of outputs (distros)'],
];

export default async function categoriesView({ el, isActive }) {
  let list = [];

  mount(el, html`
    <div class="page-head">
      <div><h1>Categories</h1><div class="sub">The categories your stock is sorted into, and the sub-categories (types) inside each one. Whatever you add here shows up straight away in the item form, bulk add and the inventory filters.</div></div>
    </div>
    <form id="cat-new" class="card" style="margin-bottom:16px" autocomplete="off">
      <h2>New category</h2>
      <div class="cat-add">
        <input type="text" name="name" maxlength="30" required placeholder="e.g. VIDEO, RIGGING, STAGING" aria-label="Category name">
        <button class="btn" type="submit">Add category</button>
      </div>
    </form>
    <div id="cat-list"></div>`);

  const render = () => {
    mount($('#cat-list', el), list.length ? html`<div class="cat-grid">${list.map((c) => html`
      <section class="card" data-category="${c.name}">
        <div class="card-head">
          <h2>${c.name}</h2>
          <span class="muted small-text">${plural(c.items, 'item')}</span>
        </div>
        ${c.types.length ? html`<ul class="cat-types">${c.types.map((t) => html`<li>
          <span class="grow"><strong>${cap(t.type)}</strong></span>
          <select class="cat-fields" data-fields-type="${t.type}" aria-label="Connectors for ${t.type}">${FIELDS.map(([v]) => html`<option value="${v}" ${t.fields === v ? 'selected' : ''}>${SHORT[v]}</option>`)}</select>
          <span class="muted small-text">${plural(t.items, 'item')}</span>
          <button class="btn ghost small" type="button" data-del-type="${t.type}" ${t.items ? 'disabled' : ''} title="${t.items ? 'Still has items in it' : 'Delete this sub-category'}" aria-label="Delete ${t.type}">✕</button>
        </li>`)}</ul>` : html`<p class="muted small-text">No sub-categories yet — add one below before putting items in this category.</p>`}
        <form class="cat-add" data-add-type autocomplete="off">
          <input type="text" name="name" maxlength="30" required placeholder="New sub-category, e.g. screen" aria-label="New sub-category in ${c.name}">
          <select name="fields" aria-label="Connectors">${FIELDS.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select>
          <button class="btn secondary" type="submit">Add</button>
        </form>
        <div style="margin-top:12px"><button class="btn danger small" type="button" data-del-category ${c.items ? 'disabled' : ''} title="${c.items ? 'Still has items in it' : ''}">Delete category</button></div>
      </section>`)}</div>` : html`<div class="card"><div class="empty">No categories yet. Add your first one above.</div></div>`);
  };

  // Every change comes back with the fresh list; the item forms read theirs from the shared meta, so that is reloaded too
  const apply = async (request, message) => {
    try {
      list = await request;
      await loadMeta();
      if (!isActive()) return false;
      render();
      toast(message, 'ok');
      return true;
    } catch (err) {
      toast(err.message, 'error', 5000);
      return false;
    }
  };

  $('#cat-new', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.elements.name;
    const name = input.value.trim();
    if (await apply(api.post('/api/categories', { name }), `Category ${name.toUpperCase()} added`)) { input.value = ''; input.focus(); }
  });

  const listEl = $('#cat-list', el);
  listEl.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-add-type]');
    if (!form) return;
    e.preventDefault();
    const category = form.closest('[data-category]').dataset.category;
    const name = form.elements.name.value.trim();
    const ok = await apply(api.post(`/api/categories/${encodeURIComponent(category)}/types`, { name, fields: form.elements.fields.value }),
      `${cap(name)} added to ${category}`);
    if (ok) $(`[data-category="${CSS.escape(category)}"] [data-add-type] [name=name]`, el)?.focus();
  });
  // Changing an existing sub-category's connector boxes
  listEl.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-fields-type]');
    if (!sel) return;
    const category = sel.closest('[data-category]').dataset.category;
    const type = sel.dataset.fieldsType;
    const label = SHORT[sel.value];
    if (!await apply(api.put(`/api/categories/${encodeURIComponent(category)}/types/${encodeURIComponent(type)}`, { fields: sel.value }),
      `${cap(type)} now has: ${label.toLowerCase()}`)) render();
  });
  listEl.addEventListener('click', async (e) => {
    const card = e.target.closest('[data-category]');
    if (!card) return;
    const category = card.dataset.category;
    const delType = e.target.closest('[data-del-type]');
    if (delType) {
      const type = delType.dataset.delType;
      if (!confirm(`Delete the sub-category "${cap(type)}" from ${category}?`)) return;
      await apply(api.del(`/api/categories/${encodeURIComponent(category)}/types/${encodeURIComponent(type)}`), `${cap(type)} deleted`);
      return;
    }
    if (e.target.closest('[data-del-category]')) {
      if (!confirm(`Delete the category ${category} and its sub-categories?`)) return;
      await apply(api.del(`/api/categories/${encodeURIComponent(category)}`), `Category ${category} deleted`);
    }
  });

  async function load() {
    list = await api.get('/api/categories');
    if (isActive()) render();
  }
  await load();
  return { refresh: load };
}
