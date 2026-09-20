import { api, html, mount, $, toast, notifyChanged, plural, cap } from '../util.js';
import { setInterceptor } from '../scanner.js';
import { play } from '../audio.js';
import { app, refreshConnectors } from '../state.js';
import { itemFields, wireItemFields, readItemFields } from '../ui.js';

/* ---------- parsing helpers ---------- */
const parseCodes = (text) => {
  const seen = new Set();
  const list = [];
  let dupes = 0;
  for (const raw of text.split(/[\n\r\t,;]+/)) {
    const c = raw.trim();
    if (!c) continue;
    if (seen.has(c.toLowerCase())) { dupes++; continue; }
    seen.add(c.toLowerCase());
    list.push(c);
  }
  return { list, dupes };
};

function parseCsv(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [['\t', first.split('\t').length], [';', first.split(';').length], [',', first.split(',').length]].sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const HEADER_ALIASES = {
  barcode: 'barcode', code: 'barcode', id: 'barcode',
  category: 'category', type: 'type',
  name: 'name', description: 'name',
  male: 'male_connector', maleend: 'male_connector', maleconnector: 'male_connector',
  female: 'female_connector', femaleend: 'female_connector', femaleconnector: 'female_connector',
  input: 'input_connector', inputconnector: 'input_connector', in: 'input_connector',
  outputs: 'outputs', output: 'outputs', out: 'outputs',
  owner: 'owner', ownedby: 'owner', owned: 'owner',
  length: 'length_m', lengthm: 'length_m', lenm: 'length_m',
  pat: 'pat_required', patrequired: 'pat_required',
  interval: 'pat_interval_months', patinterval: 'pat_interval_months', patintervalmonths: 'pat_interval_months',
};

function csvToItems(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { items: [], problems: ['Need a header row and at least one data row'] };
  const map = rows[0].map((h) => HEADER_ALIASES[h.toLowerCase().replace(/[^a-z]/g, '')] || null);
  const problems = [];
  for (const need of ['barcode', 'category', 'type']) if (!map.includes(need)) problems.push(`Missing "${need}" column`);
  const items = rows.slice(1).map((r) => {
    const o = {};
    map.forEach((key, i) => { if (key && r[i] !== undefined && r[i].trim() !== '') o[key] = r[i].trim(); });
    return o;
  });
  return { items, problems };
}

const CSV_TEMPLATE = 'barcode,category,type,name,male_connector,female_connector,length_m,pat_required,input_connector,outputs\n' +
  '00001,POWER,cable,10m 16A extension,16A Cee (blue),16A Cee (blue),10,yes,,\n' +
  '00002,POWER,adapter,13A to 16A adapter,13A (BS1363),16A Cee (blue),,yes,,\n' +
  '00003,SOUND,cable,XLR lead 5m,XLR 3-pin,XLR 3-pin,5,no,,\n' +
  '00004,LIGHTING,light,LED par can,,,,yes,,\n' +
  '00005,POWER,distro,32A 8-way distro,,,,yes,32A Cee (blue),"6x 16A Cee (blue); 2x 13A (BS1363)"\n';

export default async function bulkView({ el }) {
  const containers = await api.get('/api/containers');
  let tab = 'list';
  let csvItems = [];

  mount(el, html`
    <div class="page-head">
      <div><h1>Bulk add</h1><div class="sub">Add lots of items in one go, either by scanning/pasting barcodes, generating a range, or importing a CSV.</div></div>
    </div>
    <div class="tabs">
      <button class="tab" data-tab="list" aria-pressed="true">Scan / paste barcodes</button>
      <button class="tab" data-tab="csv" aria-pressed="false">Import CSV</button>
    </div>

    <div id="tab-list" class="stack">
      <section class="card">
        <h2>1 · What are these items?</h2>
        <p class="muted">Everything below is applied to every barcode in the list. Cables, adapters and splitters take a male and female end; distros take one input and a list of outputs.</p>
        <div id="bulk-fields">${itemFields({}, { barcode: false, containers, isNew: true })}</div>
      </section>
      <section class="card">
        <h2>2 · Barcodes</h2>
        <div class="grid cols-2">
          <div class="field">
            <label for="bulk-codes">One per line <span class="muted">— or just scan them: with nothing selected, every scan on this page is added</span></label>
            <textarea id="bulk-codes" rows="10" placeholder="00001&#10;00002&#10;00003&#10;…" spellcheck="false" autocomplete="off"></textarea>
            <div class="actions" style="justify-content:space-between"><span id="code-count" class="muted">0 barcodes</span><button class="btn ghost small" id="codes-clear" type="button">Clear list</button></div>
          </div>
          <div class="drop">
            <h3 style="margin-bottom:8px">Generate a range</h3>
            <p class="muted small-text">For a printed run of labels, e.g. 00101 … 00150.</p>
            <div class="form-grid" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))">
              <div class="field"><label for="g-start">Start at</label><input id="g-start" type="number" value="1" min="0" inputmode="numeric"></div>
              <div class="field"><label for="g-count">How many</label><input id="g-count" type="number" value="10" min="1" max="2000"></div>
              <div class="field"><label for="g-pad">Digits</label><input id="g-pad" type="number" value="${app.meta.barcodeDigits || 5}" min="1" max="10"></div>
            </div>
            <div style="margin-top:10px"><button class="btn secondary" id="g-add" type="button">Add range to list</button> <span id="g-preview" class="muted small-text"></span></div>
          </div>
        </div>
        <div class="form-actions"><button class="btn" id="bulk-submit" type="button" disabled>Add items</button></div>
        <div id="bulk-result" style="margin-top:12px"></div>
      </section>
    </div>

    <div id="tab-csv" class="stack" hidden>
      <section class="card">
        <h2>Import from CSV</h2>
        <p class="muted">Columns: <code>barcode, category, type</code> are required; optional: <code>name, male_connector, female_connector, length_m, pat_required, pat_interval_months</code>. <code>owner</code> is <code>company</code> (the default) or <code>me</code>. Distros use <code>input_connector</code> and <code>outputs</code> (e.g. <code>6x 16A Cee (blue); 2x 13A (BS1363)</code>) instead of the male/female ends.
          Category is POWER / LIGHTING / SOUND. Paste from a spreadsheet, or choose a file. Barcodes that a spreadsheet has stripped of leading zeros (12 instead of 00012) are padded back to ${app.meta.barcodeDigits || 5} digits. <a href="#" id="csv-template">Download a template</a>.</p>
        <div class="field"><label for="csv-file">CSV file</label><input id="csv-file" type="file" accept=".csv,.txt,text/csv"></div>
        <div class="field" style="margin-top:10px"><label for="csv-text">…or paste here</label><textarea id="csv-text" rows="8" spellcheck="false"></textarea></div>
        <div id="csv-preview" style="margin-top:12px"></div>
        <div class="form-actions"><button class="btn" id="csv-submit" type="button" disabled>Import</button></div>
        <div id="csv-result" style="margin-top:12px"></div>
      </section>
    </div>`);

  wireItemFields($('#bulk-fields', el));
  const ta = $('#bulk-codes', el);
  const submit = $('#bulk-submit', el);

  const refreshCount = () => {
    const { list, dupes } = parseCodes(ta.value);
    $('#code-count', el).textContent = `${plural(list.length, 'barcode')}${dupes ? ` (${plural(dupes, 'duplicate')} ignored)` : ''}`;
    submit.disabled = !list.length;
    submit.textContent = list.length ? `Add ${plural(list.length, 'item')}` : 'Add items';
  };
  ta.addEventListener('input', refreshCount);
  $('#codes-clear', el).addEventListener('click', () => { ta.value = ''; refreshCount(); });

  const addCodes = (codes) => {
    const { list } = parseCodes(ta.value);
    const have = new Set(list.map((c) => c.toLowerCase()));
    const fresh = codes.filter((c) => !have.has(c.toLowerCase()));
    ta.value = [...list, ...fresh].join('\n') + (fresh.length || list.length ? '\n' : '');
    ta.scrollTop = ta.scrollHeight;
    refreshCount();
    return fresh.length;
  };

  // Scans on this page (with nothing focused) are appended to the list
  setInterceptor(async (code) => {
    if (tab !== 'list') return false;
    const added = addCodes([code]);
    play(added ? 'store' : 'warn');
    if (!added) toast(`${code} is already in the list`, 'error');
    return true;
  });

  const genList = () => {
    const start = parseInt($('#g-start', el).value, 10) || 0;
    const count = Math.min(2000, Math.max(0, parseInt($('#g-count', el).value, 10) || 0));
    const pad = Math.min(10, Math.max(1, parseInt($('#g-pad', el).value, 10) || 1));
    return Array.from({ length: count }, (_, i) => String(start + i).padStart(pad, '0'));
  };
  const genPreview = () => {
    const l = genList();
    $('#g-preview', el).textContent = l.length ? `${l[0]} … ${l[l.length - 1]}` : '';
  };
  ['g-start', 'g-count', 'g-pad'].forEach((id) => $('#' + id, el).addEventListener('input', genPreview));
  genPreview();
  $('#g-add', el).addEventListener('click', () => {
    const n = addCodes(genList());
    toast(n ? `Added ${plural(n, 'barcode')} to the list` : 'Those are already in the list', n ? 'ok' : 'error');
  });

  const showResult = (target, res) => {
    mount(target, html`
      <div class="${res.created ? 'notice' : 'notice warn'}" style="margin:0 0 8px"><strong>${plural(res.created, 'item')} added.</strong>
        ${res.skipped.length ? html` ${plural(res.skipped.length, 'row')} skipped:` : html` <a href="#/inventory">View inventory</a>`}</div>
      ${res.skipped.length ? html`<div class="result-list"><ul style="margin:0;padding-left:18px">${res.skipped.map((s) => html`<li><span class="barcode">${s.barcode}</span> — ${s.reason}</li>`)}</ul></div>` : ''}`);
  };

  submit.addEventListener('click', async () => {
    const { list } = parseCodes(ta.value);
    if (!list.length) return;
    const shared = readItemFields($('#bulk-fields', el));
    submit.disabled = true;
    try {
      const res = await api.post('/api/items/bulk', { items: list.map((barcode) => ({ ...shared, barcode })) });
      showResult($('#bulk-result', el), res);
      // keep only the rejected barcodes in the box so they can be fixed and retried
      ta.value = res.skipped.map((s) => s.barcode).join('\n');
      refreshCount();
      if (res.created) { play('pat_pass'); toast(`Added ${plural(res.created, 'item')}`, 'ok'); notifyChanged(); refreshConnectors(); } else play('error');
    } catch (err) {
      mount($('#bulk-result', el), html`<div class="error-box">${err.message}</div>`);
      play('error');
    } finally { refreshCount(); }
  });

  /* ----- CSV tab ----- */
  const csvText = $('#csv-text', el);
  const csvSubmit = $('#csv-submit', el);
  const renderCsv = () => {
    const text = csvText.value;
    if (!text.trim()) { csvItems = []; mount($('#csv-preview', el), html``); csvSubmit.disabled = true; return; }
    const { items, problems } = csvToItems(text);
    csvItems = problems.length ? [] : items;
    csvSubmit.disabled = !csvItems.length;
    csvSubmit.textContent = csvItems.length ? `Import ${plural(csvItems.length, 'item')}` : 'Import';
    mount($('#csv-preview', el), problems.length
      ? html`<div class="error-box">${problems.join('. ')}.</div>`
      : html`<p class="muted">${plural(items.length, 'row')} found. Preview of the first ${Math.min(8, items.length)}:</p>
        <div class="table-wrap"><table class="data"><thead><tr><th>Barcode</th><th>Category</th><th>Type</th><th>Description</th><th>Male end</th><th>Female end</th><th>Length</th></tr></thead>
        <tbody>${items.slice(0, 8).map((i) => html`<tr><td class="barcode">${i.barcode}</td><td>${i.category}</td><td>${i.type}</td><td>${i.name || ''}</td><td>${i.male_connector || (i.input_connector ? `In: ${i.input_connector}` : '')}</td><td>${i.female_connector || (i.outputs ? `Out: ${i.outputs}` : '')}</td><td>${i.length_m || ''}</td></tr>`)}</tbody></table></div>`);
  };
  csvText.addEventListener('input', renderCsv);
  $('#csv-file', el).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    csvText.value = await f.text();
    renderCsv();
  });
  $('#csv-template', el).addEventListener('click', (e) => {
    e.preventDefault();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: 'text/csv' }));
    a.download = 'inventory-template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  csvSubmit.addEventListener('click', async () => {
    csvSubmit.disabled = true;
    try {
      const res = await api.post('/api/items/bulk', { items: csvItems });
      showResult($('#csv-result', el), res);
      if (res.created) { play('pat_pass'); toast(`Imported ${plural(res.created, 'item')}`, 'ok'); notifyChanged(); refreshConnectors(); } else play('error');
    } catch (err) {
      mount($('#csv-result', el), html`<div class="error-box">${err.message}</div>`);
    } finally { csvSubmit.disabled = !csvItems.length; }
  });

  el.onclick = (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    tab = t.dataset.tab;
    el.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    $('#tab-list', el).hidden = tab !== 'list';
    $('#tab-csv', el).hidden = tab !== 'csv';
  };

  return { destroy() { el.onclick = null; } };
}
