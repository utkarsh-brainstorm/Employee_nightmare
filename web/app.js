/**
 * app.js — AttendanceProcessor v3 (pywebview frontend)
 * ======================================================
 * All interaction with Python happens through:
 *   window.pywebview.api.<method>(args)  → Promise<{ok, data, error}>
 *
 * Architecture:
 *   State  — centralised app state object
 *   API    — thin wrappers around pywebview.api
 *   UI     — DOM manipulation helpers
 *   Grid   — results table renderer + sorter
 *   Filter — filter builder
 *   Init   — bootstrap on DOMContentLoaded
 */

'use strict';

/* ============================================================
   STATE
   ============================================================ */
const State = {
  results:     { columns: [], rows: [], title: '' },
  sortCol:     null,
  sortAsc:     true,
  pendingFile: null,          // filepath waiting for overwrite decision
  editingEmp:  null,          // employee row being edited
  settings:    {},
  activeModal: null,
};

/* ============================================================
   API — Promise wrappers
   ============================================================ */
async function api(method, ...args) {
  await waitForApi();
  const res = await window.pywebview.api[method](...args);
  if (!res.ok) throw new Error(res.error || 'Unknown error');
  return res.data;
}

function waitForApi() {
  return new Promise(resolve => {
    if (window.pywebview && window.pywebview.api) return resolve();
    const id = setInterval(() => {
      if (window.pywebview && window.pywebview.api) {
        clearInterval(id);
        resolve();
      }
    }, 50);
  });
}

/* ============================================================
   TOAST
   ============================================================ */
let _toastTimer = null;
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  const colors = {
    info:    'bg-head text-surface',
    ok:      'bg-ok text-surface',
    error:   'bg-danger text-surface',
    warning: 'bg-warn text-head',
  };
  el.className = `fixed bottom-5 right-5 z-50 text-xs font-medium px-4 py-2.5 rounded shadow-lg max-w-xs ${colors[type] || colors.info}`;
  el.textContent = msg;
  el.classList.remove('hidden', 'fade-out');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.classList.add('hidden'), 320);
  }, 3000);
}

/* ============================================================
   MODAL
   ============================================================ */
function openModal(id) {
  closeModal();
  State.activeModal = id;
  document.getElementById('modal-backdrop').classList.remove('hidden');
  document.getElementById(id).classList.remove('hidden');
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
    if (data && data.min_date) {
      el.textContent = `DB: ${data.min_date} → ${data.max_date}`;
      // Also seed quick-panel dates
      document.getElementById('quick-from').value = data.min_date;
      document.getElementById('quick-to').value   = data.max_date;
    } else {
      el.textContent = 'DB: no data yet';
    }
  } catch { /* silent */ }
}

/* ============================================================
   SETTINGS
   ============================================================ */
async function openSettings() {
  try {
    const s = await api('get_settings');
    State.settings = s;
    document.getElementById('s-checkin').value  = s.checkin_time  || '09:00';
    document.getElementById('s-checkout').value = s.checkout_time || '15:30';
    document.getElementById('s-late').value     = s.late_threshold || '09:15';
    document.getElementById('s-early').value    = s.early_leave_threshold || '15:30';
    document.getElementById('s-wdays').value    = s.working_days_per_month || '26';
    openModal('modal-settings');
  } catch(e) { toast('Failed to load settings: ' + e.message, 'error'); }
}

async function saveSettings() {
  const timeRe = /^\d{1,2}:\d{2}$/;
  const ci = document.getElementById('s-checkin').value.trim();
  const co = document.getElementById('s-checkout').value.trim();
  const lt = document.getElementById('s-late').value.trim();
  const el = document.getElementById('s-early').value.trim();
  const wd = document.getElementById('s-wdays').value.trim();

  for (const [v, name] of [[ci,'Check-in'],[co,'Check-out'],[lt,'Late'],[el,'Early']]) {
    if (!timeRe.test(v)) { toast(`${name} must be HH:MM`, 'error'); return; }
  }
  if (!wd || isNaN(wd) || +wd <= 0) { toast('Working days must be a positive number', 'error'); return; }

  try {
    await api('save_settings', {
      checkin_time: ci, checkout_time: co,
      late_threshold: lt, early_leave_threshold: el,
      working_days_per_month: wd,
    });
    State.settings = { checkin_time: ci, checkout_time: co,
      late_threshold: lt, early_leave_threshold: el, working_days_per_month: wd };
    refreshThreshDisplay();
    closeModal();
    toast('Settings saved.', 'ok');
  } catch(e) { toast('Save failed: ' + e.message, 'error'); }
}

function refreshThreshDisplay() {
  const s = State.settings;
  const el = document.getElementById('thresh-display');
  if (!el) return;
  el.innerHTML = `
    <div>check-in  <span class="text-body">${s.checkin_time || '—'}</span></div>
    <div>check-out <span class="text-body">${s.checkout_time || '—'}</span></div>
    <div>late after <span class="text-body">${s.late_threshold || '—'}</span></div>
    <div>early before <span class="text-body">${s.early_leave_threshold || '—'}</span></div>
    <div>work days <span class="text-body">${s.working_days_per_month || '26'}</span>/mo</div>
  `;
}

/* ============================================================
   IMPORT
   ============================================================ */
let _selectedFilePath = null;

async function browseFile() {
  try {
    const path = await api('open_file_dialog');
    if (path) setSelectedFile(path);
  } catch(e) { toast('Could not open file picker: ' + e.message, 'error'); }
}

function setSelectedFile(path) {
  _selectedFilePath = path;
  const name = path.split('/').pop().split('\\').pop();
  document.getElementById('import-filename').textContent = name;
  document.getElementById('import-filename').classList.add('text-head', 'font-medium');
  document.getElementById('btn-import').disabled = false;
}

async function triggerImport() {
  if (!_selectedFilePath) return;
  const name = _selectedFilePath.split('/').pop().split('\\').pop();
  try {
    const existing = await api('check_already_imported', name);
    if (existing) {
      document.getElementById('overwrite-msg').innerHTML =
        `<strong>${name}</strong> was imported on ${(existing.imported_at||'').slice(0,10)} ` +
        `(${existing.rows_imported || '?'} records).`;
      State.pendingFile = _selectedFilePath;
      openModal('modal-overwrite');
    } else {
      doImport(_selectedFilePath, false);
    }
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

function confirmImport(overwrite) {
  closeModal();
  if (State.pendingFile) {
    doImport(State.pendingFile, overwrite);
    State.pendingFile = null;
  }
}

function setImportProgress(show) {
  document.getElementById('import-progress').classList.toggle('hidden', !show);
  document.getElementById('btn-import').disabled = show;
}

async function doImport(filepath, overwrite) {
  setImportProgress(true);
  setSqlStatus('Parsing file…', 'info');
  try {
    const r = await api('import_file', filepath, overwrite);
    setImportProgress(false);
    document.getElementById('import-status').textContent =
      `✓ ${r.inserted} records · ${r.employees} employees · ${r.period_start} → ${r.period_end}`;
    document.getElementById('import-status').style.color = '#16A34A';
    refreshDbStatus();
    toast(`Import complete: ${r.inserted} records inserted.`, 'ok');
    if (r.warnings && r.warnings.length)
      toast(`⚠ ${r.warnings.length} warning(s): ${r.warnings[0]}`, 'warning');
  } catch(e) {
    setImportProgress(false);
    document.getElementById('import-status').textContent = '✗ ' + e.message;
    document.getElementById('import-status').style.color = '#DC2626';
    toast('Import failed: ' + e.message, 'error');
  }
}

/* Drag-and-drop */
function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.add('drag-over');
}
function handleDragLeave(e) {
  document.getElementById('drop-zone').classList.remove('drag-over');
}
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    // pywebview drops give us real file objects with .path or we use webkitRelativePath
    const f = files[0];
    const path = f.path || f.name; // pywebview exposes .path on File objects
    if (/\.(xls|xlsx|xlsm)$/i.test(path)) {
      setSelectedFile(path);
    } else {
      toast('Please drop an Excel file (.xls / .xlsx)', 'error');
    }
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
    ops: ['is','is not'],
    opts: ['PRESENT','ABSENT','WEEKLY_OFF','HALF_DAY'] },
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

// Operator → SQL fragment builder
const OP_SQL = {
  'contains':    (col, v)  => [`LOWER(${col}) LIKE LOWER(?)`, [`%${v}%`]],
  'equals':      (col, v)  => [`LOWER(${col}) = LOWER(?)`, [v]],
  'starts with': (col, v)  => [`LOWER(${col}) LIKE LOWER(?)`, [`${v}%`]],
  'ends with':   (col, v)  => [`LOWER(${col}) LIKE LOWER(?)`, [`%${v}`]],
  'not equals':  (col, v)  => [`LOWER(${col}) != LOWER(?)`, [v]],
  'on':          (col, v)  => [`${col} = ?`, [v]],
  'before':      (col, v)  => [`${col} < ?`, [v]],
  'after':       (col, v)  => [`${col} > ?`, [v]],
  'on or before':(col, v)  => [`${col} <= ?`, [v]],
  'on or after': (col, v)  => [`${col} >= ?`, [v]],
  'between':     (col,v,v2)=> [`${col} BETWEEN ? AND ?`, [v, v2]],
  'greater than':(col, v)  => [`${col} > ?`, [v]],
  'less than':   (col, v)  => [`${col} < ?`, [v]],
  'at least':    (col, v)  => [`${col} >= ?`, [v]],
  'at most':     (col, v)  => [`${col} <= ?`, [v]],
  'is':          (col, v)  => [`${col} = ?`, [v === 'Yes' ? '1' : v === 'No' ? '0' : v.toUpperCase()]],
  'is not':      (col, v)  => [`${col} != ?`, [v.toUpperCase()]],
};

let _filterRows = [];
let _filterIdCounter = 0;

function addFilterRow() {
  const id = ++_filterIdCounter;
  const isFirst = _filterRows.length === 0;
  const field = FIELDS[0];

  const container = document.getElementById('filter-rows');
  const row = document.createElement('div');
  row.className = 'filter-row';
  row.dataset.id = id;

  _filterRows.push({ id, field: field.label, op: field.ops[0], value: '', value2: '', joiner: 'AND' });

  row.innerHTML = buildFilterRowHTML(id, isFirst, field);
  container.appendChild(row);
  bindFilterRowEvents(row, id);
  updateFilterSQL();
}

function buildFilterRowHTML(id, isFirst, field) {
  const joinerHTML = isFirst
    ? `<span class="text-2xs text-dim w-8 shrink-0 text-center">WHERE</span>`
    : `<button class="joiner-pill active" data-id="${id}">AND</button>`;

  const fieldOpts = FIELDS.map(f =>
    `<option value="${f.label}" ${f.label === field.label ? 'selected' : ''}>${f.label}</option>`
  ).join('');

  const opOpts = field.ops.map(o =>
    `<option value="${o}" ${o === field.ops[0] ? 'selected' : ''}>${o}</option>`
  ).join('');

  const valHTML = buildValueInput(id, field, field.ops[0]);

  return `
    ${joinerHTML}
    <select class="field-sel" data-id="${id}" style="width:130px">${fieldOpts}</select>
    <select class="op-sel"    data-id="${id}" style="width:110px">${opOpts}</select>
    <div class="value-wrap" data-id="${id}" style="display:flex;gap:4px;align-items:center">${valHTML}</div>
    <button class="remove-btn" data-id="${id}" title="Remove">✕</button>
  `;
}

function buildValueInput(id, field, op) {
  if (field.opts) {
    const options = field.opts.map(o => `<option value="${o}">${o}</option>`).join('');
    return `<select class="val-inp" data-id="${id}" style="width:110px">${options}</select>`;
  }
  if (field.cat === 'date') {
    const today = new Date().toISOString().slice(0, 10);
    if (op === 'between') {
      return `<input class="val-inp" data-id="${id}" type="text" placeholder="YYYY-MM-DD" value="${today}" style="width:100px" />
              <span style="font-size:10px;color:#A0A0A6">to</span>
              <input class="val2-inp" data-id="${id}" type="text" placeholder="YYYY-MM-DD" value="${today}" style="width:100px" />`;
    }
    return `<input class="val-inp" data-id="${id}" type="text" placeholder="YYYY-MM-DD" value="${today}" style="width:110px" />`;
  }
  if (field.cat === 'time') {
    return `<input class="val-inp" data-id="${id}" type="text" placeholder="HH:MM" value="09:00" style="width:70px" />`;
  }
  if (field.cat === 'number') {
    return `<input class="val-inp" data-id="${id}" type="number" placeholder="0" value="6" style="width:70px" />`;
  }
  return `<input class="val-inp" data-id="${id}" type="text" placeholder="Search…" style="width:130px" />`;
}

function bindFilterRowEvents(row, id) {
  // Joiner toggle
  row.querySelector('.joiner-pill')?.addEventListener('click', e => {
    const fr = _filterRows.find(r => r.id === id);
    if (!fr) return;
    fr.joiner = fr.joiner === 'AND' ? 'OR' : 'AND';
    e.currentTarget.textContent = fr.joiner;
    e.currentTarget.classList.toggle('active', fr.joiner === 'AND');
    updateFilterSQL();
  });

  // Field change
  row.querySelector('.field-sel')?.addEventListener('change', e => {
    const fr = _filterRows.find(r => r.id === id);
    if (!fr) return;
    fr.field = e.target.value;
    fr.op = FIELDS.find(f => f.label === e.target.value)?.ops[0] || 'equals';
    fr.value = ''; fr.value2 = '';
    // Rebuild op dropdown + value
    const field = FIELDS.find(f => f.label === fr.field);
    const opSel = row.querySelector('.op-sel');
    opSel.innerHTML = field.ops.map(o => `<option value="${o}">${o}</option>`).join('');
    opSel.value = fr.op;
    row.querySelector('.value-wrap').innerHTML = buildValueInput(id, field, fr.op);
    bindValueEvents(row, id);
    updateFilterSQL();
  });

  // Op change
  row.querySelector('.op-sel')?.addEventListener('change', e => {
    const fr = _filterRows.find(r => r.id === id);
    if (!fr) return;
    fr.op = e.target.value;
    const field = FIELDS.find(f => f.label === fr.field);
    row.querySelector('.value-wrap').innerHTML = buildValueInput(id, field, fr.op);
    bindValueEvents(row, id);
    updateFilterSQL();
  });

  bindValueEvents(row, id);

  // Remove
  row.querySelector('.remove-btn')?.addEventListener('click', () => {
    row.remove();
    _filterRows = _filterRows.filter(r => r.id !== id);
    updateFilterSQL();
  });
}

function bindValueEvents(row, id) {
  row.querySelector('.val-inp')?.addEventListener('input', e => {
    const fr = _filterRows.find(r => r.id === id);
    if (fr) { fr.value = e.target.value; updateFilterSQL(); }
  });
  row.querySelector('.val2-inp')?.addEventListener('input', e => {
    const fr = _filterRows.find(r => r.id === id);
    if (fr) { fr.value2 = e.target.value; updateFilterSQL(); }
  });
}

function clearFilters() {
  document.getElementById('filter-rows').innerHTML = '';
  _filterRows = [];
  addFilterRow();
}

function buildFiltersPayload() {
  return _filterRows.map(fr => ({
    field:    fr.field,
    operator: fr.op,
    value:    fr.value,
    value2:   fr.value2 || '',
    joiner:   fr.joiner,
  }));
}

function updateFilterSQL() {
  // Generate a human-readable SQL preview and push to SQL editor
  try {
    const lines = buildFiltersPayload().map((f, i) => {
      const field  = FIELDS.find(fd => fd.label === f.field);
      if (!field) return '';
      const col  = field.col;
      const pair = OP_SQL[f.operator];
      if (!pair) return '';
      const [clause] = pair(col, f.value || '?', f.value2 || '?');
      return (i === 0 ? 'WHERE ' : `  ${f.joiner} `) + clause;
    }).filter(Boolean);

    const sortCol = document.getElementById('sort-col').value;
    const sortDir = document.getElementById('sort-dir').value;
    const limit   = document.getElementById('result-limit').value || 5000;

    const sql = [
      'SELECT',
      '  emp_code, emp_name, work_date, status,',
      '  punch_in AS "In", punch_out AS "Out",',
      '  work_hours AS "Hours", is_late AS "Late", left_early AS "Left Early"',
      'FROM attendance_raw',
      ...lines,
      `ORDER BY ${sortCol} ${sortDir}`,
      `LIMIT ${limit}`,
    ].join('\n');

    setSqlEditor(sql);
  } catch { /* skip */ }
}

async function runFilter() {
  const filters = buildFiltersPayload();
  const sortCol = document.getElementById('sort-col').value;
  const sortDir = document.getElementById('sort-dir').value;
  const limit   = parseInt(document.getElementById('result-limit').value) || 5000;

  setSqlStatus('Running…', 'info');
  try {
    const res = await api('run_filter', JSON.stringify(filters), sortCol, sortDir, limit);
    setSqlStatus(`✓ ${res.count} records`, 'ok');
    if (res.sql) setSqlEditor(res.sql);
    showResults(res.columns, res.rows, 'Search Results');
  } catch(e) {
    setSqlStatus('✗ ' + e.message, 'error');
    toast(e.message, 'error');
  }
}

/* ============================================================
   SQL PANEL
   ============================================================ */
function setSqlEditor(sql) {
  const ta = document.getElementById('sql-editor');
  ta.value = sql;
  updateLineNumbers();
}

function updateLineNumbers() {
  const ta = document.getElementById('sql-editor');
  const lines = ta.value.split('\n').length;
  document.getElementById('sql-lines').innerHTML =
    Array.from({ length: lines }, (_, i) => i + 1).join('<br>');
}

function setSqlStatus(msg, type = 'info') {
  const el = document.getElementById('sql-status');
  const colors = { info: '#A0A0A6', ok: '#16A34A', error: '#DC2626', warning: '#D97706' };
  el.textContent = msg;
  el.style.color = colors[type] || '#A0A0A6';
}

async function runSql() {
  const sql = document.getElementById('sql-editor').value.trim();
  const clean = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim();
  if (!clean) { setSqlStatus('Enter a SELECT query first.', 'error'); return; }

  setSqlStatus('Running…', 'info');
  try {
    const res = await api('run_sql', clean);
    setSqlStatus(`✓ ${res.count} records`, 'ok');
    showResults(res.columns, res.rows, 'Query Results');
  } catch(e) {
    setSqlStatus('✗ ' + e.message, 'error');
    toast(e.message, 'error');
  }
}

function clearSql() {
  document.getElementById('sql-editor').value = '';
  updateLineNumbers();
  setSqlStatus('');
}

/* Schema reference */
const SCHEMA = [
  { table: 'attendance_raw', cols: [
    ['emp_code','TEXT','Employee ID (e.g. "7")'],
    ['emp_name','TEXT','Name from file (may be truncated)'],
    ['work_date','DATE','YYYY-MM-DD'],
    ['status','TEXT','PRESENT | ABSENT | WEEKLY_OFF | HALF_DAY'],
    ['punch_in','TEXT','HH:MM arrival (or NULL)'],
    ['punch_out','TEXT','HH:MM departure (or NULL)'],
    ['work_hours','REAL','Decimal hours worked (or NULL)'],
    ['is_late','INTEGER','1 if arrived after late_threshold'],
    ['left_early','INTEGER','1 if left before early_leave_threshold'],
    ['report_file','TEXT','Source filename'],
    ['company_name','TEXT','School / company name'],
  ]},
  { table: 'employee_salary', cols: [
    ['emp_code','TEXT','PK — links to attendance_raw'],
    ['emp_name_override','TEXT','Full name set by admin'],
    ['monthly_salary','REAL','₹ per month (0 if not set)'],
    ['daily_rate','REAL','Auto: salary ÷ working_days'],
    ['working_days','INTEGER','Work days per month'],
  ]},
  { table: 'import_log', cols: [
    ['filename','TEXT','Imported filename'],
    ['imported_at','DATETIME','Import timestamp'],
    ['rows_imported','INTEGER','Records inserted'],
    ['period_start','DATE','Report period from'],
    ['period_end','DATE','Report period to'],
  ]},
];

function buildSchemaPanel() {
  const el = document.getElementById('schema-panel');
  el.innerHTML = '';

  for (const { table, cols } of SCHEMA) {
    const badge = document.createElement('span');
    badge.className = 'schema-table-badge';
    badge.textContent = table;
    el.appendChild(badge);

    for (const [name, type, hint] of cols) {
      const row = document.createElement('div');
      row.className = 'schema-col-row';
      row.innerHTML = `
        <span class="schema-col-name">${name}</span>
        <span class="schema-col-type type-${type}">${type}</span>
        <span class="schema-col-hint">${hint}</span>
      `;
      el.appendChild(row);
    }
  }

  // Example queries
  const exHeader = document.createElement('span');
  exHeader.className = 'schema-table-badge';
  exHeader.style.color = '#16A34A';
  exHeader.style.background = '#F0FDF4';
  exHeader.textContent = 'example queries';
  el.appendChild(exHeader);

  const examples = [
    "SELECT * FROM attendance_raw\nWHERE LOWER(emp_name) LIKE '%anita%'",
    "SELECT emp_name, COUNT(*) AS absent\nFROM attendance_raw\nWHERE status='ABSENT'\nGROUP BY emp_code\nORDER BY absent DESC",
    "SELECT a.emp_name,\n  COUNT(CASE WHEN status='PRESENT' THEN 1 END) AS days\nFROM attendance_raw a\nGROUP BY a.emp_code",
  ];
  for (const ex of examples) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'font-size:9px;color:#6B6B72;padding:4px 8px;margin:2px 0;cursor:pointer;border-radius:3px;transition:background 100ms;white-space:pre-wrap;';
    pre.textContent = ex;
    pre.title = 'Click to insert';
    pre.addEventListener('mouseenter', () => pre.style.background = '#E2E2E4');
    pre.addEventListener('mouseleave', () => pre.style.background = '');
    pre.addEventListener('click', () => {
      setSqlEditor(ex);
      toast('Query inserted', 'info');
    });
    el.appendChild(pre);
  }
}

function toggleSchema() {
  const panel = document.getElementById('schema-panel');
  const btn   = document.getElementById('btn-schema-toggle');
  const isHidden = panel.classList.toggle('hidden');
  btn.textContent = isHidden ? '📋 Schema' : '✕ Schema';
}

/* ============================================================
   RESULTS GRID
   ============================================================ */
function showResults(columns, rows, title) {
  State.results = { columns, rows: [...rows], title };
  State.sortCol = null;
  State.sortAsc = true;
  renderGrid();

  document.getElementById('results-title').textContent = title;
  document.getElementById('btn-export-csv').disabled = rows.length === 0;
  document.getElementById('btn-export-pdf').disabled = rows.length === 0;
}

function renderGrid() {
  const { columns, rows } = State.results;
  const head = document.getElementById('results-head');
  const body = document.getElementById('results-body');
  const empty = document.getElementById('results-empty');

  head.innerHTML = '';
  body.innerHTML = '';

  if (!columns || columns.length === 0) {
    empty.classList.remove('hidden');
    document.getElementById('results-count').textContent = '';
    return;
  }
  empty.classList.add('hidden');

  // Header
  const tr = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    th.textContent = col;
    if (col === State.sortCol) th.className = State.sortAsc ? 'sort-asc' : 'sort-desc';
    th.addEventListener('click', () => sortGrid(col));
    tr.appendChild(th);
  }
  head.appendChild(tr);

  // Rows
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const col of columns) {
      const td = document.createElement('td');
      const val = row[col] ?? '';
      td.textContent = val;
      // Status colouring
      if (col.toLowerCase() === 'status') {
        td.className = `status-${String(val).toUpperCase()}`;
        td.style.fontSize = '10px';
      }
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  body.appendChild(frag);

  const n = rows.length;
  document.getElementById('results-count').textContent = `— ${n} record${n !== 1 ? 's' : ''}`;
}

function sortGrid(col) {
  if (State.sortCol === col) {
    State.sortAsc = !State.sortAsc;
  } else {
    State.sortCol = col;
    State.sortAsc = true;
  }
  State.results.rows.sort((a, b) => {
    let va = a[col] ?? '', vb = b[col] ?? '';
    const na = parseFloat(String(va).replace(/[₹,]/g, ''));
    const nb = parseFloat(String(vb).replace(/[₹,]/g, ''));
    if (!isNaN(na) && !isNaN(nb)) return State.sortAsc ? na - nb : nb - na;
    return State.sortAsc
      ? String(va).localeCompare(String(vb))
      : String(vb).localeCompare(String(va));
  });
  renderGrid();
}

/* ============================================================
   QUICK REPORTS
   ============================================================ */
async function runQuickReport(report, extraInput) {
  const from  = document.getElementById('quick-from').value;
  const to    = document.getElementById('quick-to').value;
  const extra = extraInput || '';

  setSqlStatus('Running…', 'info');
  try {
    const res = await api('quick_report', report, from, to, extra);
    const titles = {
      monthly_summary: 'Monthly Summary',
      late:            'Late Arrivals',
      early:           'Early Leavers',
      absent:          'Absentees',
      days_worked:     'Days Worked',
      salary:          'Salary Report',
      grid:            'Full Attendance Grid',
      perfect:         'Perfect Attendance',
      chronic:         `Frequent Absentees (≥${extra||3})`,
    };
    const title = `${titles[report] || report}  ${from ? `(${from} → ${to})` : ''}`;
    setSqlStatus(`✓ ${res.count} records`, 'ok');
    showResults(res.columns, res.rows, title);
    toast(`${title}: ${res.count} records`, 'ok');
  } catch(e) {
    setSqlStatus('✗ ' + e.message, 'error');
    toast(e.message, 'error');
  }
}

function runChronicReport() {
  const val = document.getElementById('chronic-input').value || '3';
  closeModal();
  runQuickReport('chronic', val);
}

/* ============================================================
   EXPORT
   ============================================================ */
async function exportCsv() {
  const { columns, rows, title } = State.results;
  if (!rows.length) { toast('No data to export', 'warning'); return; }
  try {
    const defaultName = title.replace(/[^a-z0-9]+/gi, '_').replace(/_+/g, '_').slice(0, 40);
    const path = await api('save_file_dialog', defaultName, 'csv');
    if (!path) return;
    await api('export_csv', columns, rows, path);
    toast('CSV saved: ' + path.split('/').pop(), 'ok');
  } catch(e) { toast('Export failed: ' + e.message, 'error'); }
}

async function exportPdf() {
  const { columns, rows, title } = State.results;
  if (!rows.length) { toast('No data to export', 'warning'); return; }
  try {
    const defaultName = title.replace(/[^a-z0-9]+/gi, '_').replace(/_+/g, '_').slice(0, 40);
    const path = await api('save_file_dialog', defaultName, 'pdf');
    if (!path) return;
    await api('export_pdf', columns, rows, path, title);
    toast('PDF saved: ' + path.split('/').pop(), 'ok');
  } catch(e) { toast('Export failed: ' + e.message, 'error'); }
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

      const tr = document.createElement('tr');
      tr.className = i % 2 === 0 ? 'hover:bg-muted' : 'bg-muted/40 hover:bg-muted';
      tr.innerHTML = `
        <td class="tbl-head font-mono text-dim">${e.emp_code}</td>
        <td class="px-2 py-1.5 text-xs text-dim">${e.emp_name}</td>
        <td class="px-2 py-1.5 text-xs ${name ? 'text-body font-medium' : 'text-dim italic'}">${name || 'not set'}</td>
        <td class="px-2 py-1.5 text-xs text-right font-mono">${sal ? '₹' + sal.toLocaleString() : '—'}</td>
        <td class="px-2 py-1.5 text-xs text-center">${wd}</td>
        <td class="px-2 py-1.5 text-xs text-right font-mono text-dim">${dr !== '—' ? '₹' + dr : '—'}</td>
        <td class="px-2 py-1.5 text-xs">
          <button class="text-accent hover:text-accentHov text-2xs" onclick="editEmployee('${e.emp_code}','${(e.emp_name||'').replace(/'/g,"\\'")}','${(name||'').replace(/'/g,"\\'")}',${sal},${wd})">Edit</button>
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
  const fullname = document.getElementById('emp-fullname').value.trim();
  const salary   = parseFloat(document.getElementById('emp-salary').value) || 0;
  const wdays    = parseInt(document.getElementById('emp-wdays').value) || 26;
  try {
    await api('upsert_employee', emp.code, emp.name, fullname, salary, wdays);
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
    if (!history || !history.length) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    for (const [i, r] of history.entries()) {
      const tr = document.createElement('tr');
      tr.className = i % 2 === 0 ? '' : 'bg-muted/40';
      tr.innerHTML = `
        <td class="px-2 py-1.5 text-xs font-mono">${r.filename || ''}</td>
        <td class="px-2 py-1.5 text-xs text-dim font-mono">${(r.imported_at||'').slice(0,19).replace('T',' ')}</td>
        <td class="px-2 py-1.5 text-xs text-right font-mono">${r.rows_imported || 0}</td>
        <td class="px-2 py-1.5 text-xs text-dim">${r.period_start || ''}</td>
        <td class="px-2 py-1.5 text-xs text-dim">${r.period_end || ''}</td>
        <td class="px-2 py-1.5 text-xs text-dim">${r.company_name || ''}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch(e) { toast('Could not load history: ' + e.message, 'error'); }
}

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  // Buttons
  document.getElementById('btn-browse').addEventListener('click', browseFile);
  document.getElementById('btn-import').addEventListener('click', triggerImport);
  document.getElementById('drop-zone').addEventListener('click', browseFile);

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

  // SQL editor events
  const sqlEd = document.getElementById('sql-editor');
  sqlEd.addEventListener('input', updateLineNumbers);
  sqlEd.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); runSql(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const pos = sqlEd.selectionStart;
      sqlEd.value = sqlEd.value.slice(0, pos) + '  ' + sqlEd.value.slice(sqlEd.selectionEnd);
      sqlEd.selectionStart = sqlEd.selectionEnd = pos + 2;
    }
  });

  // Quick report buttons
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const report = btn.dataset.report;
      if (report === 'chronic') {
        openModal('modal-chronic');
      } else {
        runQuickReport(report);
      }
    });
  });

  // Keyboard ESC to close modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  // Build schema reference
  buildSchemaPanel();

  // First filter row
  addFilterRow();

  // Bootstrap DB status and settings
  await waitForApi();
  await refreshDbStatus();
  try {
    State.settings = await api('get_settings');
    refreshThreshDisplay();
  } catch { /* offline mode */ }
});
