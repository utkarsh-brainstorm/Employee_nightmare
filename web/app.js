/**
 * app.js — AttendanceProcessor v3
 * =================================
 * Features:
 *  ✓ Global zoom (30% default, Ctrl+/-/0, persistent)
 *  ✓ Resizable panels (VS Code-style drag, persistent widths)
 *  ✓ Import with employee diff detection
 *  ✓ Filter builder (accessible, no overflow clipping)
 *  ✓ SQL editor with schema toggle
 *  ✓ Results grid (sortable, colour-coded)
 *  ✓ Quick reports + custom shortcuts
 *  ✓ Org name/logo in navbar + PDF exports
 *  ✓ Theme switcher (via themes.js)
 *  ✓ Query log (view, copy, clear)
 *  ✓ All modals
 *  ✓ Export CSV/PDF
 */

'use strict';

/* ============================================================
   PYWEBVIEW BRIDGE
   ============================================================ */
async function waitForApi() {
  return new Promise(resolve => {
    if (window.pywebview?.api) return resolve();
    const id = setInterval(() => {
      if (window.pywebview?.api) { clearInterval(id); resolve(); }
    }, 50);
  });
}

async function api(method, ...args) {
  await waitForApi();
  const res = await window.pywebview.api[method](...args);
  if (!res.ok) throw new Error(res.error || 'Unknown error');
  return res.data;
}

/* ============================================================
   STATE
   ============================================================ */
const State = {
  results:    { columns: [], rows: [], title: '' },
  sortCol:    null,
  sortAsc:    true,
  pendingFile: null,
  editingEmp:  null,
  settings:   {},
  customReports: [],    // [{id,title,sql,icon}]
  activeModal: null,
  orgLogo:    null,     // base64 string
};

/* ============================================================
   ZOOM (30% default, Ctrl+/-/0, persisted)
   ============================================================ */
const ZOOM_KEY  = 'ap_zoom';
const ZOOM_MIN  = 0.7;
const ZOOM_MAX  = 2.0;
const ZOOM_STEP = 0.1;
const ZOOM_DEFAULT = 1.3;

function getCurrentZoom() {
  return parseFloat(localStorage.getItem(ZOOM_KEY) || ZOOM_DEFAULT);
}

function setZoom(z) {
  z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, parseFloat(z.toFixed(2))));
  document.body.style.zoom = z;
  document.getElementById('zoom-label').textContent = Math.round(z * 100) + '%';
  localStorage.setItem(ZOOM_KEY, z);
}

function adjustZoom(delta) { setZoom(getCurrentZoom() + delta); }
function resetZoom()        { setZoom(ZOOM_DEFAULT); }

function initZoom() {
  setZoom(getCurrentZoom());
  document.addEventListener('keydown', e => {
    if (!e.ctrlKey) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); adjustZoom(ZOOM_STEP); }
    if (e.key === '-')  { e.preventDefault(); adjustZoom(-ZOOM_STEP); }
    if (e.key === '0')  { e.preventDefault(); resetZoom(); }
  });
}

/* ============================================================
   RESIZABLE PANELS (VS Code-style, persisted)
   ============================================================ */
const PANEL_KEY = 'ap_panels';

function loadPanelWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_KEY) || '{}');
    if (saved.left)  document.getElementById('panel-filter').style.width = saved.left;
    if (saved.right) document.getElementById('panel-quick').style.width  = saved.right;
  } catch {}
}

function savePanelWidths() {
  const left  = document.getElementById('panel-filter').offsetWidth + 'px';
  const right = document.getElementById('panel-quick').offsetWidth  + 'px';
  localStorage.setItem(PANEL_KEY, JSON.stringify({ left, right }));
}

function initResizableHandles() {
  setupHandle('rh-left',  'panel-filter', 'left');
  setupHandle('rh-right', 'panel-quick',  'right');
}

function setupHandle(handleId, panelId, side) {
  const handle = document.getElementById(handleId);
  const panel  = document.getElementById(panelId);
  if (!handle || !panel) return;

  let startX = 0, startW = 0;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX;
    startW = panel.offsetWidth;
    handle.classList.add('dragging');

    const onMove = ev => {
      const dx = ev.clientX - startX;
      const newW = side === 'left' ? startW + dx : startW - dx;
      const min = parseInt(panel.style.minWidth || '180');
      const max = parseInt(panel.style.maxWidth || '520');
      panel.style.width = Math.max(min, Math.min(max, newW)) + 'px';
    };

    const onUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      savePanelWidths();
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/* ============================================================
   TOAST
   ============================================================ */
let _toastTimer = null;
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  const bg = {
    info:    'var(--text-head)',
    ok:      'var(--ok)',
    error:   'var(--danger)',
    warning: 'var(--warn)',
  }[type] || 'var(--text-head)';
  el.style.background = bg;
  el.style.color = type === 'warning' ? 'var(--text-head)' : 'var(--text-inv)';
  el.textContent = msg;
  el.classList.remove('hidden', 'fade-out');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.classList.add('hidden'), 320);
  }, 3200);
}

/* ============================================================
   MODAL
   ============================================================ */
function openModal(id) {
  closeModal();
  State.activeModal = id;
  document.getElementById('modal-backdrop').classList.remove('hidden');
  document.getElementById(id).classList.remove('hidden');
  if (id === 'modal-settings') {
    switchSettingsTab(document.querySelector('.settings-tab.active') || document.querySelector('.settings-tab'), 'general');
  }
}

function closeModal() {
  if (State.activeModal) {
    document.getElementById(State.activeModal)?.classList.add('hidden');
    State.activeModal = null;
  }
  document.getElementById('modal-backdrop').classList.add('hidden');
}

/* ============================================================
   DB STATUS
   ============================================================ */
async function refreshDbStatus() {
  try {
    const data = await api('get_db_status');
    const el = document.getElementById('db-status');
    if (data?.min_date) {
      el.textContent = `${data.min_date} → ${data.max_date}`;
      document.getElementById('quick-from').value = data.min_date;
      document.getElementById('quick-to').value   = data.max_date;
    } else {
      el.textContent = 'no data';
    }
  } catch {}
}

/* ============================================================
   SETTINGS
   ============================================================ */
function switchSettingsTab(btn, tabName) {
  if (!btn) return;
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.settings-tab-body').forEach(t => t.classList.add('hidden'));
  btn.classList.add('active');
  const tab = document.getElementById(`tab-${tabName}`);
  if (tab) tab.classList.remove('hidden');

  if (tabName === 'theme') buildThemeGrid();
  if (tabName === 'querylog') loadQueryLog();
}

async function openSettings() {
  try {
    const s = await api('get_settings');
    State.settings = s;
    document.getElementById('s-checkin').value  = s.checkin_time || '09:00';
    document.getElementById('s-checkout').value = s.checkout_time || '15:30';
    document.getElementById('s-late').value     = s.late_threshold || '09:15';
    document.getElementById('s-early').value    = s.early_leave_threshold || '15:30';
    document.getElementById('s-wdays').value    = s.working_days_per_month || '26';
    document.getElementById('s-org-name').value = s.org_name || '';

    // Logo preview
    const logo = s.org_logo_b64 || '';
    State.orgLogo = logo || null;
    updateLogoPreview(logo);
  } catch(e) { toast('Failed to load settings: ' + e.message, 'error'); return; }
  openModal('modal-settings');
}

function updateLogoPreview(b64) {
  const preview = document.getElementById('logo-preview');
  const img     = document.getElementById('logo-img');
  if (b64) {
    img.src = 'data:image/png;base64,' + b64;
    preview.classList.remove('hidden');
  } else {
    preview.classList.add('hidden');
    img.src = '';
  }
}

async function pickLogo() {
  try {
    const path = await api('open_file_dialog_type', 'image');
    if (!path) return;
    const b64 = await api('read_file_as_b64', path);
    if (!b64) return;
    State.orgLogo = b64;
    updateLogoPreview(b64);
  } catch(e) { toast('Could not load logo: ' + e.message, 'error'); }
}

function clearLogo() {
  State.orgLogo = null;
  updateLogoPreview(null);
}

async function saveSettings() {
  const timeRe = /^\d{1,2}:\d{2}$/;
  const ci = document.getElementById('s-checkin').value.trim();
  const co = document.getElementById('s-checkout').value.trim();
  const lt = document.getElementById('s-late').value.trim();
  const el = document.getElementById('s-early').value.trim();
  const wd = document.getElementById('s-wdays').value.trim();
  const orgName = document.getElementById('s-org-name').value.trim();

  for (const [v, name] of [[ci,'Check-in'],[co,'Check-out'],[lt,'Late'],[el,'Early']]) {
    if (!timeRe.test(v)) { toast(`${name} must be HH:MM`, 'error'); return; }
  }

  const payload = {
    checkin_time: ci, checkout_time: co,
    late_threshold: lt, early_leave_threshold: el,
    working_days_per_month: wd,
    org_name: orgName,
    org_logo_b64: State.orgLogo || '',
  };

  try {
    await api('save_settings', payload);
    State.settings = { ...State.settings, ...payload };
    refreshThreshDisplay();
    updateOrgBranding();
    closeModal();
    toast('Settings saved.', 'ok');
  } catch(e) { toast('Save failed: ' + e.message, 'error'); }
}

function refreshThreshDisplay() {
  const s = State.settings;
  const el = document.getElementById('thresh-display');
  if (!el) return;
  el.innerHTML = `
    <div>check-in <span style="color:var(--text-body)">${s.checkin_time||'—'}</span></div>
    <div>check-out <span style="color:var(--text-body)">${s.checkout_time||'—'}</span></div>
    <div>late &gt; <span style="color:var(--text-body)">${s.late_threshold||'—'}</span></div>
    <div>early &lt; <span style="color:var(--text-body)">${s.early_leave_threshold||'—'}</span></div>
    <div>work days <span style="color:var(--text-body)">${s.working_days_per_month||'26'}</span>/mo</div>
  `;
}

function updateOrgBranding() {
  const name = State.settings.org_name || '';
  const el   = document.getElementById('org-name-display');
  if (name) {
    el.textContent = name;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

/* ============================================================
   QUERY LOG
   ============================================================ */
async function loadQueryLog() {
  const container = document.getElementById('query-log-list');
  if (!container) return;
  try {
    const logs = await api('get_query_log');
    if (!logs || !logs.length) {
      container.innerHTML = '<div class="px-4 py-6 text-center text-[10px] text-[var(--text-dim)]">No queries logged yet.</div>';
      return;
    }
    container.innerHTML = '';
    for (const log of logs) {
      const row = document.createElement('div');
      row.className = 'qlog-row';
      const time = (log.ran_at || '').slice(0, 16).replace('T', ' ');
      row.innerHTML = `
        <div class="qlog-sql">${escHtml(log.sql_text)}</div>
        <div class="flex flex-col items-end gap-1">
          <span class="qlog-meta">${time}<br>${log.row_count} rows</span>
          <button class="qlog-copy" onclick="copyToClipboard(${JSON.stringify(log.sql_text)})">Copy</button>
        </div>
      `;
      container.appendChild(row);
    }
  } catch(e) { container.innerHTML = `<div class="px-4 py-4 text-[10px] text-[var(--danger)]">${e.message}</div>`; }
}

async function clearQueryLog() {
  try {
    await api('clear_query_log');
    loadQueryLog();
    toast('Query log cleared.', 'ok');
  } catch(e) { toast(e.message, 'error'); }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard', 'ok'));
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ============================================================
   IMPORT
   ============================================================ */
let _selectedFilePath = null;

async function browseFile() {
  try {
    const path = await api('open_file_dialog');
    if (path) setSelectedFile(path);
  } catch(e) { toast('File picker error: ' + e.message, 'error'); }
}

function setSelectedFile(path) {
  _selectedFilePath = path;
  const name = path.replace(/\\/g, '/').split('/').pop();
  document.getElementById('import-filename').textContent = name;
  document.getElementById('btn-import').disabled = false;
}

async function triggerImport() {
  if (!_selectedFilePath) return;
  const name = _selectedFilePath.replace(/\\/g, '/').split('/').pop();
  try {
    const existing = await api('check_already_imported', name);
    if (existing) {
      document.getElementById('overwrite-msg').innerHTML =
        `<strong>${name}</strong> was imported on ${(existing.imported_at||'').slice(0,10)} (${existing.rows_imported||'?'} records).`;
      State.pendingFile = _selectedFilePath;
      openModal('modal-overwrite');
    } else {
      doImport(_selectedFilePath, false);
    }
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

function confirmImport(overwrite) {
  closeModal();
  if (State.pendingFile) { doImport(State.pendingFile, overwrite); State.pendingFile = null; }
}

async function doImport(filepath, overwrite) {
  document.getElementById('import-progress').classList.remove('hidden');
  document.getElementById('btn-import').disabled = true;
  setSqlStatus('Parsing file…', 'info');
  try {
    const r = await api('import_file', filepath, overwrite);
    document.getElementById('import-progress').classList.add('hidden');
    document.getElementById('btn-import').disabled = false;

    document.getElementById('import-status').textContent =
      `✓ ${r.inserted} records · ${r.employees} employees · ${r.period_start}→${r.period_end}`;
    document.getElementById('import-status').style.color = 'var(--ok)';

    refreshDbStatus();
    toast(`Import complete: ${r.inserted} records.`, 'ok');

    // Employee diff
    if (r.employee_diff) {
      showEmployeeDiff(r.employee_diff);
    }
    if (r.warnings?.length) toast(`⚠ ${r.warnings.length} warning(s): ${r.warnings[0]}`, 'warning');
  } catch(e) {
    document.getElementById('import-progress').classList.add('hidden');
    document.getElementById('btn-import').disabled = false;
    document.getElementById('import-status').textContent = '✗ ' + e.message;
    document.getElementById('import-status').style.color = 'var(--danger)';
    toast('Import failed: ' + e.message, 'error');
  }
}

function showEmployeeDiff(diff) {
  const added   = diff.added   || [];
  const removed = diff.removed || [];
  if (!added.length && !removed.length) return;

  let html = '';
  if (added.length) {
    html += `<strong>${added.length} new employee${added.length>1?'s':''} detected:</strong> ${added.slice(0,3).join(', ')}${added.length>3?` +${added.length-3} more`:''}.
             <button class="underline ml-2 font-medium" onclick="openEmployees()">Add details →</button>  `;
  }
  if (removed.length) {
    html += `<strong>${removed.length} employee${removed.length>1?'s':''} no longer in file:</strong> ${removed.slice(0,3).join(', ')}${removed.length>3?` +${removed.length-3} more`:''}.`;
  }
  document.getElementById('emp-diff-text').innerHTML = html;
  document.getElementById('emp-diff-banner').classList.remove('hidden');
}

function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.add('drag-over');
}
function handleDragLeave() {
  document.getElementById('drop-zone').classList.remove('drag-over');
}
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  const files = e.dataTransfer?.files;
  if (files?.length > 0) {
    const f = files[0];
    const path = f.path || f.name;
    if (/\.(xls|xlsx|xlsm)$/i.test(path)) setSelectedFile(path);
    else toast('Please drop an Excel file (.xls / .xlsx)', 'error');
  }
}

/* ============================================================
   FILTER BUILDER
   ============================================================ */
const FIELDS = [
  { label: 'Employee Name',  col: 'emp_name',   cat: 'text',
    ops: ['contains','equals','starts with','ends with','not equals'] },
  { label: 'Employee ID',    col: 'emp_code',   cat: 'text',
    ops: ['equals','contains'] },
  { label: 'Date',           col: 'work_date',  cat: 'date',
    ops: ['on','before','after','on or before','on or after','between'] },
  { label: 'Status',         col: 'status',     cat: 'status',
    ops: ['is','is not'], opts: ['PRESENT','ABSENT','WEEKLY_OFF','HALF_DAY'] },
  { label: 'Arrival Time',   col: 'punch_in',   cat: 'time',
    ops: ['before','after','equals'] },
  { label: 'Departure Time', col: 'punch_out',  cat: 'time',
    ops: ['before','after','equals'] },
  { label: 'Hours Worked',   col: 'work_hours', cat: 'number',
    ops: ['greater than','less than','equals','at least','at most'] },
  { label: 'Arrived Late?',  col: 'is_late',    cat: 'bool',
    ops: ['is'], opts: ['Yes','No'] },
  { label: 'Left Early?',    col: 'left_early', cat: 'bool',
    ops: ['is'], opts: ['Yes','No'] },
];

let _filterRows = [], _filterIdCounter = 0;

function addFilterRow() {
  const id = ++_filterIdCounter;
  const isFirst = _filterRows.length === 0;
  const field = FIELDS[0];
  _filterRows.push({ id, field: field.label, op: field.ops[0], value: '', value2: '', joiner: 'AND' });

  const container = document.getElementById('filter-rows');
  const row = document.createElement('div');
  row.className = 'filter-row';
  row.dataset.id = id;
  row.innerHTML = renderFilterRow(id, isFirst, field);
  container.appendChild(row);
  bindFilterRow(row, id);
  updateFilterSQL();
}

function renderFilterRow(id, isFirst, field) {
  const joiner = isFirst
    ? `<span style="font-size:10px;color:var(--text-dim);flex-shrink:0;width:30px;text-align:center">WHERE</span>`
    : `<button class="joiner-pill active" data-id="${id}">AND</button>`;

  const fieldOpts = FIELDS.map(f =>
    `<option value="${f.label}" ${f.label === field.label ? 'selected' : ''}>${f.label}</option>`
  ).join('');
  const opOpts = field.ops.map(o => `<option value="${o}">${o}</option>`).join('');
  const valHTML = buildValueHTML(id, field, field.ops[0]);

  return `
    ${joiner}
    <select class="field-sel" style="flex:0 0 auto;width:110px" data-id="${id}">${fieldOpts}</select>
    <select class="op-sel"    style="flex:0 0 auto;width:90px"  data-id="${id}">${opOpts}</select>
    <div class="value-wrap" data-id="${id}" style="flex:1;display:flex;gap:3px;min-width:0">${valHTML}</div>
    <button class="remove-filter" data-id="${id}">✕</button>
  `;
}

function buildValueHTML(id, field, op) {
  if (field.opts) {
    return `<select class="val-inp" data-id="${id}" style="flex:1">${field.opts.map(o=>`<option>${o}</option>`).join('')}</select>`;
  }
  if (field.cat === 'date') {
    const today = new Date().toISOString().slice(0,10);
    if (op === 'between') {
      return `<input class="val-inp" data-id="${id}" type="text" value="${today}" style="flex:1;min-width:80px" placeholder="YYYY-MM-DD" />
              <span style="font-size:10px;color:var(--text-dim);flex-shrink:0">to</span>
              <input class="val2-inp" data-id="${id}" type="text" value="${today}" style="flex:1;min-width:80px" placeholder="YYYY-MM-DD" />`;
    }
    return `<input class="val-inp" data-id="${id}" type="text" value="${today}" style="flex:1" placeholder="YYYY-MM-DD" />`;
  }
  if (field.cat === 'time') return `<input class="val-inp" data-id="${id}" type="text" value="09:00" style="flex:1;max-width:70px" placeholder="HH:MM" />`;
  if (field.cat === 'number') return `<input class="val-inp" data-id="${id}" type="number" value="6" style="flex:1;max-width:70px" />`;
  return `<input class="val-inp" data-id="${id}" type="text" style="flex:1" placeholder="Search…" />`;
}

function bindFilterRow(row, id) {
  row.querySelector('.joiner-pill')?.addEventListener('click', e => {
    const fr = _filterRows.find(r => r.id === id);
    if (!fr) return;
    fr.joiner = fr.joiner === 'AND' ? 'OR' : 'AND';
    e.currentTarget.textContent = fr.joiner;
    e.currentTarget.classList.toggle('active', fr.joiner === 'AND');
    updateFilterSQL();
  });

  row.querySelector('.field-sel')?.addEventListener('change', e => {
    const fr = _filterRows.find(r => r.id === id);
    if (!fr) return;
    fr.field = e.target.value; fr.value = ''; fr.value2 = '';
    const field = FIELDS.find(f => f.label === fr.field);
    fr.op = field.ops[0];
    const opSel = row.querySelector('.op-sel');
    opSel.innerHTML = field.ops.map(o=>`<option value="${o}">${o}</option>`).join('');
    opSel.value = fr.op;
    row.querySelector('.value-wrap').innerHTML = buildValueHTML(id, field, fr.op);
    bindValueEvents(row, id);
    updateFilterSQL();
  });

  row.querySelector('.op-sel')?.addEventListener('change', e => {
    const fr = _filterRows.find(r => r.id === id);
    if (!fr) return;
    fr.op = e.target.value;
    const field = FIELDS.find(f => f.label === fr.field);
    row.querySelector('.value-wrap').innerHTML = buildValueHTML(id, field, fr.op);
    bindValueEvents(row, id);
    updateFilterSQL();
  });

  bindValueEvents(row, id);

  row.querySelector('.remove-filter')?.addEventListener('click', () => {
    row.remove();
    _filterRows = _filterRows.filter(r => r.id !== id);
    updateFilterSQL();
  });
}

function bindValueEvents(row, id) {
  const handler = e => {
    const fr = _filterRows.find(r => r.id === id);
    if (fr) {
      if (e.target.classList.contains('val-inp'))  fr.value  = e.target.value;
      if (e.target.classList.contains('val2-inp')) fr.value2 = e.target.value;
      updateFilterSQL();
    }
  };
  row.querySelectorAll('.val-inp, .val2-inp').forEach(el => el.addEventListener('input', handler));
}

function clearFilters() {
  document.getElementById('filter-rows').innerHTML = '';
  _filterRows = [];
  addFilterRow();
}

function buildFiltersPayload() {
  return _filterRows.map(fr => ({
    field: fr.field, operator: fr.op,
    value: fr.value, value2: fr.value2 || '',
    joiner: fr.joiner,
  }));
}

/* Quick SQL preview generator */
const OP_SQL_PREVIEW = {
  'contains':    (c,v)   => `LOWER(${c}) LIKE '%${v}%'`,
  'equals':      (c,v)   => `LOWER(${c}) = '${v}'`,
  'starts with': (c,v)   => `LOWER(${c}) LIKE '${v}%'`,
  'ends with':   (c,v)   => `LOWER(${c}) LIKE '%${v}'`,
  'not equals':  (c,v)   => `LOWER(${c}) != '${v}'`,
  'on':          (c,v)   => `${c} = '${v}'`,
  'before':      (c,v)   => `${c} < '${v}'`,
  'after':       (c,v)   => `${c} > '${v}'`,
  'on or before':(c,v)   => `${c} <= '${v}'`,
  'on or after': (c,v)   => `${c} >= '${v}'`,
  'between':     (c,v,v2)=> `${c} BETWEEN '${v}' AND '${v2}'`,
  'greater than':(c,v)   => `${c} > ${v}`,
  'less than':   (c,v)   => `${c} < ${v}`,
  'at least':    (c,v)   => `${c} >= ${v}`,
  'at most':     (c,v)   => `${c} <= ${v}`,
  'is':          (c,v)   => `${c} = '${v === 'Yes' ? '1' : v === 'No' ? '0' : v.toUpperCase()}'`,
  'is not':      (c,v)   => `${c} != '${v.toUpperCase()}'`,
};

function updateFilterSQL() {
  try {
    const lines = buildFiltersPayload().map((f, i) => {
      const field = FIELDS.find(fd => fd.label === f.field);
      if (!field) return '';
      const fn = OP_SQL_PREVIEW[f.operator];
      if (!fn) return '';
      const clause = fn(field.col, f.value || '?', f.value2 || '?');
      return (i === 0 ? 'WHERE ' : `  ${f.joiner} `) + clause;
    }).filter(Boolean);

    const sc = document.getElementById('sort-col').value;
    const sd = document.getElementById('sort-dir').value;
    const lim = document.getElementById('result-limit').value || 5000;

    const sql = [
      'SELECT',
      '  emp_code, emp_name, work_date, status,',
      '  punch_in AS "In", punch_out AS "Out",',
      '  work_hours AS "Hours", is_late AS "Late", left_early AS "Left Early"',
      'FROM attendance_raw',
      ...lines,
      `ORDER BY ${sc} ${sd}`,
      `LIMIT ${lim}`,
    ].join('\n');
    setSqlEditor(sql);
  } catch {}
}

async function runFilter() {
  const filters = buildFiltersPayload();
  const sc  = document.getElementById('sort-col').value;
  const sd  = document.getElementById('sort-dir').value;
  const lim = parseInt(document.getElementById('result-limit').value) || 5000;
  setSqlStatus('Running…', 'info');
  try {
    const res = await api('run_filter', JSON.stringify(filters), sc, sd, lim);
    setSqlStatus(`✓ ${res.count} records`, 'ok');
    if (res.sql) setSqlEditor(res.sql);
    showResults(res.columns, res.rows, 'Search Results');
  } catch(e) { setSqlStatus('✗ ' + e.message, 'error'); toast(e.message, 'error'); }
}

/* ============================================================
   SQL PANEL
   ============================================================ */
function setSqlEditor(sql) {
  const ta = document.getElementById('sql-editor');
  ta.value = sql;
  updateLineNumbers('sql-editor', 'sql-lines');
}

function updateLineNumbers(editorId, linesId) {
  const ta = document.getElementById(editorId);
  const linesEl = document.getElementById(linesId);
  if (!ta || !linesEl) return;
  const n = ta.value.split('\n').length;
  linesEl.innerHTML = Array.from({length: n}, (_, i) => i + 1).join('<br>');
}

function setSqlStatus(msg, type = 'info') {
  const el = document.getElementById('sql-status');
  const colors = { info: 'var(--text-dim)', ok: 'var(--ok)', error: 'var(--danger)', warning: 'var(--warn)' };
  el.textContent = msg;
  el.style.color = colors[type] || 'var(--text-dim)';
}

async function runSql() {
  const sql = document.getElementById('sql-editor').value.trim();
  const clean = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim();
  if (!clean) { setSqlStatus('Enter a SELECT query.', 'error'); return; }
  setSqlStatus('Running…', 'info');
  try {
    const res = await api('run_sql', clean);
    setSqlStatus(`✓ ${res.count} records`, 'ok');
    showResults(res.columns, res.rows, 'Query Results');
  } catch(e) { setSqlStatus('✗ ' + e.message, 'error'); toast(e.message, 'error'); }
}

function clearSql() {
  document.getElementById('sql-editor').value = '';
  updateLineNumbers('sql-editor', 'sql-lines');
  setSqlStatus('');
}

/* Schema Reference */
const SCHEMA = [
  { table: 'attendance_raw', cols: [
    ['emp_code','TEXT','Employee ID'],
    ['emp_name','TEXT','Name from file'],
    ['work_date','DATE','YYYY-MM-DD'],
    ['status','TEXT','PRESENT|ABSENT|WEEKLY_OFF|HALF_DAY'],
    ['punch_in','TEXT','HH:MM arrival'],
    ['punch_out','TEXT','HH:MM departure'],
    ['work_hours','REAL','Decimal hours'],
    ['is_late','INTEGER','1 = late'],
    ['left_early','INTEGER','1 = left early'],
    ['report_file','TEXT','Source filename'],
    ['company_name','TEXT','School/org name'],
  ]},
  { table: 'employee_salary', cols: [
    ['emp_code','TEXT','PK'],
    ['emp_name_override','TEXT','Admin full name'],
    ['monthly_salary','REAL','₹/month'],
    ['daily_rate','REAL','Auto: salary÷days'],
    ['working_days','INTEGER','Days/month'],
  ]},
  { table: 'import_log', cols: [
    ['filename','TEXT','Imported file'],
    ['imported_at','DATETIME','Timestamp'],
    ['rows_imported','INTEGER','Records'],
    ['period_start','DATE','From'],
    ['period_end','DATE','To'],
  ]},
];

const EXAMPLE_QUERIES = [
  "SELECT * FROM attendance_raw\nWHERE LOWER(emp_name) LIKE '%anita%'",
  "SELECT emp_name, COUNT(*) AS absent\nFROM attendance_raw WHERE status='ABSENT'\nGROUP BY emp_code ORDER BY absent DESC",
  "SELECT emp_name,\n  SUM(CASE WHEN status='PRESENT' THEN 1 ELSE 0 END) AS days\nFROM attendance_raw GROUP BY emp_code",
];

function buildSchemaContent(container) {
  container.innerHTML = '';
  for (const { table, cols } of SCHEMA) {
    const badge = document.createElement('span');
    badge.className = 'schema-table-badge';
    badge.textContent = table;
    container.appendChild(badge);
    for (const [name, type, hint] of cols) {
      const row = document.createElement('div');
      row.className = 'schema-col-row';
      row.innerHTML = `<span class="schema-col-name">${name}</span><span class="schema-col-type type-${type}">${type}</span><span class="schema-col-hint">${hint}</span>`;
      container.appendChild(row);
    }
  }
  const exBadge = document.createElement('span');
  exBadge.className = 'schema-table-badge';
  exBadge.style.cssText = 'color:var(--ok);background:var(--ok-bg)';
  exBadge.textContent = 'examples';
  container.appendChild(exBadge);
  for (const ex of EXAMPLE_QUERIES) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'font-size:9px;color:var(--text-mid);padding:3px 8px;cursor:pointer;border-radius:3px;white-space:pre-wrap;transition:background 100ms';
    pre.textContent = ex;
    pre.title = 'Click to use';
    pre.addEventListener('mouseenter', () => pre.style.background = 'var(--bg-muted)');
    pre.addEventListener('mouseleave', () => pre.style.background = '');
    pre.addEventListener('click', () => { setSqlEditor(ex); if (State.activeModal !== 'modal-custom-report') toast('Query inserted','info'); });
    container.appendChild(pre);
  }
}

function toggleSchema() {
  const panel = document.getElementById('schema-panel');
  const btn   = document.getElementById('btn-schema-toggle');
  const isHidden = panel.classList.toggle('hidden');
  btn.textContent = isHidden ? '📋 Schema' : '✕ Schema';
  if (!isHidden && !panel.children.length) buildSchemaContent(panel);
}

/* ============================================================
   RESULTS GRID
   ============================================================ */
function showResults(columns, rows, title) {
  State.results = { columns, rows: [...rows], title };
  State.sortCol = null; State.sortAsc = true;
  renderGrid();
  document.getElementById('results-title').textContent = title;
  document.getElementById('btn-export-csv').disabled = !rows.length;
  document.getElementById('btn-export-pdf').disabled = !rows.length;
}

function renderGrid() {
  const { columns, rows } = State.results;
  const head  = document.getElementById('results-head');
  const body  = document.getElementById('results-body');
  const empty = document.getElementById('results-empty');

  head.innerHTML = ''; body.innerHTML = '';
  if (!columns?.length) { empty.classList.remove('hidden'); document.getElementById('results-count').textContent = ''; return; }
  empty.classList.add('hidden');

  const tr = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    th.textContent = col;
    if (col === State.sortCol) th.className = State.sortAsc ? 'sort-asc' : 'sort-desc';
    th.addEventListener('click', () => sortGrid(col));
    tr.appendChild(th);
  }
  head.appendChild(tr);

  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const col of columns) {
      const td = document.createElement('td');
      const val = row[col] ?? '';
      td.textContent = val;
      if (col.toLowerCase() === 'status') {
        const span = document.createElement('span');
        span.className = `status-${String(val).toUpperCase().replace(/ /g,'_')}`;
        span.textContent = val;
        td.textContent = '';
        td.appendChild(span);
      }
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  body.appendChild(frag);
  const n = rows.length;
  document.getElementById('results-count').textContent = `— ${n.toLocaleString()} record${n !== 1 ? 's' : ''}`;
}

function sortGrid(col) {
  State.sortAsc = State.sortCol === col ? !State.sortAsc : true;
  State.sortCol = col;
  State.results.rows.sort((a, b) => {
    let va = a[col] ?? '', vb = b[col] ?? '';
    const na = parseFloat(String(va).replace(/[₹,]/g,''));
    const nb = parseFloat(String(vb).replace(/[₹,]/g,''));
    if (!isNaN(na) && !isNaN(nb)) return State.sortAsc ? na-nb : nb-na;
    return State.sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
  });
  renderGrid();
}

/* ============================================================
   QUICK REPORTS
   ============================================================ */
async function runQuickReport(report, extra) {
  const from  = document.getElementById('quick-from').value;
  const to    = document.getElementById('quick-to').value;
  setSqlStatus('Running…', 'info');
  try {
    const res = await api('quick_report', report, from, to, extra || '');
    const titles = {
      monthly_summary:'Monthly Summary', late:'Late Arrivals', early:'Early Leavers',
      absent:'Absentees', days_worked:'Days Worked', salary:'Salary Report',
      grid:'Full Attendance Grid', perfect:'Perfect Attendance',
      chronic:`Frequent Absentees (≥${extra||3})`,
    };
    const title = `${titles[report]||report}${from?' ('+from+'→'+to+')':''}`;
    setSqlStatus(`✓ ${res.count} records`, 'ok');
    showResults(res.columns, res.rows, title);
    toast(`${titles[report]||report}: ${res.count} records`, 'ok');
  } catch(e) { setSqlStatus('✗ ' + e.message, 'error'); toast(e.message, 'error'); }
}

function runChronicReport() {
  const val = document.getElementById('chronic-input').value || '3';
  closeModal(); runQuickReport('chronic', val);
}

/* ============================================================
   CUSTOM SHORTCUTS
   ============================================================ */
const CUSTOM_KEY = 'ap_custom_reports';

function loadCustomReports() {
  try {
    State.customReports = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
  } catch { State.customReports = []; }
  renderCustomReports();
}

function renderCustomReports() {
  const container = document.getElementById('quick-custom');
  if (!container) return;
  if (!State.customReports.length) { container.innerHTML = ''; return; }

  container.innerHTML = `<div class="quick-section-label mt-1">Custom</div>`;
  for (const cr of State.customReports) {
    const btn = document.createElement('div');
    btn.className = 'quick-btn custom-shortcut';
    btn.innerHTML = `
      <span class="truncate flex-1">${cr.icon || '📌'} ${cr.title}</span>
      <span class="cr-actions">
        <button style="font-size:10px;color:var(--accent)" onclick="editCustomReport('${cr.id}',event)">✏</button>
        <button style="font-size:10px;color:var(--danger)" onclick="deleteCustomReport('${cr.id}',event)">✕</button>
      </span>
    `;
    btn.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      runCustomReport(cr);
    });
    container.appendChild(btn);
  }
}

async function runCustomReport(cr) {
  setSqlStatus('Running…', 'info');
  try {
    const res = await api('run_sql', cr.sql);
    setSqlStatus(`✓ ${res.count} records`, 'ok');
    showResults(res.columns, res.rows, `${cr.icon||'📌'} ${cr.title}`);
    toast(`${cr.title}: ${res.count} records`, 'ok');
  } catch(e) { setSqlStatus('✗ ' + e.message, 'error'); toast(e.message, 'error'); }
}

function openCustomReportModal(editId) {
  const cr = editId ? State.customReports.find(r => r.id === editId) : null;
  document.getElementById('cr-title').value = cr?.title || '';
  document.getElementById('cr-icon').value  = cr?.icon  || '📌';
  document.getElementById('cr-sql').value   = cr?.sql   || '';
  document.getElementById('cr-sql').dataset.editId = editId || '';
  updateLineNumbers('cr-sql', 'cr-lines');
  // Build mini schema
  buildSchemaContent(document.getElementById('cr-schema-ref'));
  openModal('modal-custom-report');
}

function editCustomReport(id, e) {
  e.stopPropagation();
  openCustomReportModal(id);
}

function deleteCustomReport(id, e) {
  e.stopPropagation();
  State.customReports = State.customReports.filter(r => r.id !== id);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(State.customReports));
  renderCustomReports();
  toast('Shortcut removed.', 'ok');
}

function saveCustomReport() {
  const title = document.getElementById('cr-title').value.trim();
  const icon  = document.getElementById('cr-icon').value.trim() || '📌';
  const sql   = document.getElementById('cr-sql').value.trim();
  const editId = document.getElementById('cr-sql').dataset.editId;

  if (!title) { toast('Please enter a report title.', 'error'); return; }
  if (!sql)   { toast('Please enter a SQL query.',    'error'); return; }

  if (editId) {
    const idx = State.customReports.findIndex(r => r.id === editId);
    if (idx >= 0) State.customReports[idx] = { id: editId, title, icon, sql };
  } else {
    State.customReports.push({ id: Date.now().toString(), title, icon, sql });
  }
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(State.customReports));
  renderCustomReports();
  closeModal();
  toast(`"${title}" shortcut saved.`, 'ok');
}

/* ============================================================
   EMPLOYEES
   ============================================================ */
async function openEmployees() {
  openModal('modal-employees');
  await loadEmployees();
}

async function loadEmployees() {
  try {
    const employees = await api('get_employees');
    const tbody = document.getElementById('emp-tbody');
    tbody.innerHTML = '';
    for (const [i, e] of employees.entries()) {
      const sal  = e.monthly_salary || 0;
      const wd   = e.working_days || 26;
      const dr   = sal > 0 ? (sal / wd).toFixed(2) : '—';
      const name = e.emp_name_override || '';
      const tr   = document.createElement('tr');
      tr.innerHTML = `
        <td class="tbl-head font-mono">${e.emp_code}</td>
        <td class="px-2 py-1.5 text-[11px] text-[var(--text-dim)]">${e.emp_name}</td>
        <td class="px-2 py-1.5 text-[11px] ${name?'font-medium text-[var(--text-body)]':'italic text-[var(--text-dim)]'}">${name||'not set'}</td>
        <td class="px-2 py-1.5 text-[11px] text-right font-mono">${sal?'₹'+sal.toLocaleString():'—'}</td>
        <td class="px-2 py-1.5 text-[11px] text-center">${wd}</td>
        <td class="px-2 py-1.5 text-[11px] text-right font-mono text-[var(--text-dim)]">${dr!=='—'?'₹'+dr:'—'}</td>
        <td class="px-2 py-1.5">
          <button style="font-size:11px;color:var(--accent)" onclick="editEmployee('${e.emp_code}','${(e.emp_name||'').replace(/'/g,"\\'")}','${(name||'').replace(/'/g,"\\'")}',${sal},${wd})">Edit</button>
        </td>
      `;
      tbody.appendChild(tr);
    }
  } catch(e) { toast('Failed to load employees: ' + e.message, 'error'); }
}

function editEmployee(code, name, override, salary, wdays) {
  State.editingEmp = { code, name };
  document.getElementById('emp-edit-row').classList.remove('hidden');
  document.getElementById('emp-edit-label').textContent = `[${code}] ${name}`;
  document.getElementById('emp-fullname').value = override || '';
  document.getElementById('emp-salary').value   = salary || '';
  document.getElementById('emp-wdays').value    = wdays || 26;
}

function cancelEmpEdit() {
  State.editingEmp = null;
  document.getElementById('emp-edit-row').classList.add('hidden');
}

async function saveEmployee() {
  const emp = State.editingEmp;
  if (!emp) return;
  try {
    await api('upsert_employee', emp.code, emp.name,
      document.getElementById('emp-fullname').value.trim(),
      parseFloat(document.getElementById('emp-salary').value) || 0,
      parseInt(document.getElementById('emp-wdays').value) || 26
    );
    cancelEmpEdit();
    await loadEmployees();
    toast('Employee updated.', 'ok');
  } catch(e) { toast('Save failed: ' + e.message, 'error'); }
}

/* ============================================================
   IMPORT HISTORY
   ============================================================ */
async function openHistory() {
  openModal('modal-history');
  try {
    const history = await api('get_import_history');
    const tbody = document.getElementById('history-tbody');
    const empty = document.getElementById('history-empty');
    tbody.innerHTML = '';
    if (!history?.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    for (const r of history) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="px-2 py-1.5 text-[11px] font-mono">${r.filename||''}</td>
        <td class="px-2 py-1.5 text-[11px] font-mono text-[var(--text-dim)]">${(r.imported_at||'').slice(0,16).replace('T',' ')}</td>
        <td class="px-2 py-1.5 text-[11px] text-right font-mono">${r.rows_imported||0}</td>
        <td class="px-2 py-1.5 text-[11px] text-[var(--text-dim)]">${r.period_start||''}</td>
        <td class="px-2 py-1.5 text-[11px] text-[var(--text-dim)]">${r.period_end||''}</td>
        <td class="px-2 py-1.5 text-[11px] text-[var(--text-dim)]">${r.company_name||''}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch(e) { toast('Could not load history: ' + e.message, 'error'); }
}

/* ============================================================
   EXPORT
   ============================================================ */
async function exportCsv() {
  const { columns, rows, title } = State.results;
  if (!rows.length) { toast('No data to export', 'warning'); return; }
  try {
    const defName = title.replace(/[^a-z0-9]+/gi,'_').slice(0,40);
    const path = await api('save_file_dialog', defName, 'csv');
    if (!path) return;
    await api('export_csv', columns, rows, path);
    toast('CSV saved: ' + path.replace(/\\/g,'/').split('/').pop(), 'ok');
  } catch(e) { toast('Export failed: ' + e.message, 'error'); }
}

async function exportPdf() {
  const { columns, rows, title } = State.results;
  if (!rows.length) { toast('No data to export', 'warning'); return; }
  try {
    const defName = title.replace(/[^a-z0-9]+/gi,'_').slice(0,40);
    const path = await api('save_file_dialog', defName, 'pdf');
    if (!path) return;
    const orgName  = State.settings.org_name   || '';
    const logoBb64 = State.settings.org_logo_b64 || '';
    await api('export_pdf', columns, rows, path, title, orgName, logoBb64);
    toast('PDF saved: ' + path.replace(/\\/g,'/').split('/').pop(), 'ok');
  } catch(e) { toast('Export failed: ' + e.message, 'error'); }
}

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {

  /* Zoom */
  initZoom();

  /* Panel resize */
  loadPanelWidths();
  initResizableHandles();

  /* Custom reports */
  loadCustomReports();

  /* Buttons */
  document.getElementById('btn-browse').addEventListener('click', browseFile);
  document.getElementById('btn-import').addEventListener('click', triggerImport);
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-employees').addEventListener('click', openEmployees);
  document.getElementById('btn-history').addEventListener('click', openHistory);
  document.getElementById('btn-add-filter').addEventListener('click', addFilterRow);
  document.getElementById('btn-run-filter').addEventListener('click', runFilter);
  document.getElementById('btn-clear-filter').addEventListener('click', clearFilters);
  document.getElementById('btn-sql-run').addEventListener('click', runSql);
  document.getElementById('btn-sql-clear').addEventListener('click', clearSql);
  document.getElementById('btn-schema-toggle').addEventListener('click', toggleSchema);
  document.getElementById('btn-export-csv').addEventListener('click', exportCsv);
  document.getElementById('btn-export-pdf').addEventListener('click', exportPdf);

  /* SQL editor line numbers + Ctrl+Enter */
  const sqlEd = document.getElementById('sql-editor');
  sqlEd.addEventListener('input', () => updateLineNumbers('sql-editor','sql-lines'));
  sqlEd.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); runSql(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const pos = sqlEd.selectionStart;
      sqlEd.value = sqlEd.value.slice(0,pos) + '  ' + sqlEd.value.slice(sqlEd.selectionEnd);
      sqlEd.selectionStart = sqlEd.selectionEnd = pos + 2;
      updateLineNumbers('sql-editor','sql-lines');
    }
  });

  /* Custom report SQL editor */
  const crSql = document.getElementById('cr-sql');
  crSql.addEventListener('input', () => updateLineNumbers('cr-sql','cr-lines'));

  /* Sort selects */
  document.getElementById('sort-col').addEventListener('change', updateFilterSQL);
  document.getElementById('sort-dir').addEventListener('change', updateFilterSQL);
  document.getElementById('result-limit').addEventListener('input', updateFilterSQL);

  /* Quick report buttons */
  document.querySelectorAll('.quick-btn[data-report]').forEach(btn => {
    btn.addEventListener('click', () => {
      const report = btn.dataset.report;
      if (report === 'chronic') openModal('modal-chronic');
      else runQuickReport(report);
    });
  });

  /* ESC closes modal */
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  /* First filter row */
  addFilterRow();

  /* Bootstrap from API */
  await waitForApi();
  await refreshDbStatus();
  try {
    State.settings = await api('get_settings');
    refreshThreshDisplay();
    updateOrgBranding();
    if (State.settings.org_logo_b64) State.orgLogo = State.settings.org_logo_b64;
  } catch {}
});
