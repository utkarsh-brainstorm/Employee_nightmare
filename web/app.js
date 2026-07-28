/**
 * app.js — AttendanceProcessor v3.1
 * =====================================
 * IMPORTANT: localStorage does NOT exist in pywebview GTK/WebKit2.
 * ALL persistence goes through:
 *   window._apMem   — in-memory session store (instant, no I/O)
 *   api.save_settings / get_settings — SQLite backend (across sessions)
 *
 * No localStorage, sessionStorage, or IndexedDB calls anywhere in this file.
 */

'use strict';

/* ============================================================
   IN-MEMORY SESSION STORE  (replaces localStorage completely)
   ============================================================ */
window._apMem = window._apMem || {};

function memGet(key, def) {
  var v = window._apMem[key];
  return (v !== undefined && v !== null) ? v : (def !== undefined ? def : null);
}
function memSet(key, value) {
  window._apMem[key] = value;
}

/* ============================================================
   PYWEBVIEW BRIDGE
   ============================================================ */
function waitForApi() {
  return new Promise(function(resolve) {
    if (window.pywebview && window.pywebview.api) return resolve();
    var id = setInterval(function() {
      if (window.pywebview && window.pywebview.api) { clearInterval(id); resolve(); }
    }, 60);
  });
}

function apiCall(method) {
  var args = Array.prototype.slice.call(arguments, 1);
  return waitForApi().then(function() {
    return window.pywebview.api[method].apply(window.pywebview.api, args);
  }).then(function(res) {
    if (!res.ok) throw new Error(res.error || 'Unknown error');
    return res.data;
  });
}

/* ============================================================
   STATE
   ============================================================ */
var State = {
  results:     { columns: [], rows: [], title: '' },
  sortCol:     null,
  sortAsc:     true,
  pendingFile: null,
  editingEmp:  null,
  settings:    {},
  customReports: [],
  activeModal:   null,
  orgLogo:       null,
};

/* ============================================================
   ZOOM  (30% default, Ctrl+/-/0, persisted via backend)
   Uses CSS zoom on <html> element — reliable in WebKit2GTK.
   ============================================================ */
var ZOOM_MIN  = 0.7;
var ZOOM_MAX  = 2.0;
var ZOOM_STEP = 0.1;
var ZOOM_DEFAULT = 1.3;

function getCurrentZoom() {
  return parseFloat(memGet('ap_zoom', ZOOM_DEFAULT));
}

function setZoom(z) {
  z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
  document.documentElement.style.zoom = String(z);
  var lbl = document.getElementById('zoom-label');
  if (lbl) lbl.textContent = Math.round(z * 100) + '%';
  memSet('ap_zoom', z);
  // Persist async — no await needed
  apiCall('save_settings', { ap_zoom: String(z) }).catch(function(){});
}

function adjustZoom(delta) { setZoom(getCurrentZoom() + delta); }
function resetZoom()        { setZoom(ZOOM_DEFAULT); }

function initZoom() {
  // Apply saved zoom (initially from _apMem; overwritten after API load)
  document.documentElement.style.zoom = String(getCurrentZoom());
  var lbl = document.getElementById('zoom-label');
  if (lbl) lbl.textContent = Math.round(getCurrentZoom() * 100) + '%';

  document.addEventListener('keydown', function(e) {
    if (!e.ctrlKey) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); adjustZoom(ZOOM_STEP); }
    else if (e.key === '-')             { e.preventDefault(); adjustZoom(-ZOOM_STEP); }
    else if (e.key === '0')             { e.preventDefault(); resetZoom(); }
  });
}

/* ============================================================
   RESIZABLE PANELS  (VS Code-style, persisted via backend)
   ============================================================ */
function loadPanelWidths() {
  var raw = memGet('ap_panels', null);
  if (!raw) return;
  try {
    var saved = (typeof raw === 'string') ? JSON.parse(raw) : raw;
    var pf = document.getElementById('panel-filter');
    var pq = document.getElementById('panel-quick');
    if (saved.left  && pf) pf.style.width = saved.left;
    if (saved.right && pq) pq.style.width  = saved.right;
  } catch(e) {}
}

function savePanelWidths() {
  var pf = document.getElementById('panel-filter');
  var pq = document.getElementById('panel-quick');
  if (!pf || !pq) return;
  var obj = { left: pf.offsetWidth + 'px', right: pq.offsetWidth + 'px' };
  memSet('ap_panels', JSON.stringify(obj));
  apiCall('save_settings', { ap_panels: JSON.stringify(obj) }).catch(function(){});
}

function initResizableHandles() {
  setupHandle('rh-left',  'panel-filter', 'left');
  setupHandle('rh-right', 'panel-quick',  'right');
}

function setupHandle(handleId, panelId, side) {
  var handle = document.getElementById(handleId);
  var panel  = document.getElementById(panelId);
  if (!handle || !panel) return;

  var startX = 0, startW = 0;

  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    startX = e.clientX;
    startW = panel.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    function onMove(ev) {
      var dx   = ev.clientX - startX;
      var newW = side === 'left' ? startW + dx : startW - dx;
      var min  = parseInt(panel.style.minWidth  || '180', 10);
      var max  = parseInt(panel.style.maxWidth  || '520', 10);
      panel.style.width = Math.max(min, Math.min(max, newW)) + 'px';
    }

    function onUp() {
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      savePanelWidths();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

/* ============================================================
   TOAST
   ============================================================ */
var _toastTimer = null;
function toast(msg, type) {
  var el = document.getElementById('toast');
  if (!el) return;
  var bg = { info: 'var(--text-head)', ok: 'var(--ok)', error: 'var(--danger)', warning: 'var(--warn)' }[type] || 'var(--text-head)';
  el.style.background = bg;
  el.style.color = type === 'warning' ? '#000' : 'var(--text-inv)';
  el.textContent = msg;
  el.classList.remove('hidden', 'fade-out');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() {
    el.classList.add('fade-out');
    setTimeout(function() { el.classList.add('hidden'); }, 320);
  }, 3200);
}

/* ============================================================
   MODAL
   ============================================================ */
function openModal(id) {
  closeModal();
  State.activeModal = id;
  var backdrop = document.getElementById('modal-backdrop');
  var modal    = document.getElementById(id);
  if (backdrop) backdrop.classList.remove('hidden');
  if (modal)    modal.classList.remove('hidden');
  if (id === 'modal-settings') {
    var firstTab = document.querySelector('.settings-tab');
    if (firstTab) switchSettingsTab(firstTab, 'general');
  }
}

function closeModal() {
  if (State.activeModal) {
    var m = document.getElementById(State.activeModal);
    if (m) m.classList.add('hidden');
    State.activeModal = null;
  }
  var backdrop = document.getElementById('modal-backdrop');
  if (backdrop) backdrop.classList.add('hidden');
}

/* ============================================================
   DB STATUS
   ============================================================ */
function refreshDbStatus() {
  apiCall('get_db_status').then(function(data) {
    var el = document.getElementById('db-status');
    if (!el) return;
    if (data && data.min_date) {
      el.textContent = data.min_date + ' → ' + data.max_date;
      var qf = document.getElementById('quick-from');
      var qt = document.getElementById('quick-to');
      if (qf) qf.value = data.min_date;
      if (qt) qt.value = data.max_date;
    } else {
      el.textContent = 'no data';
    }
  }).catch(function(){});
}

/* ============================================================
   SETTINGS
   ============================================================ */
function switchSettingsTab(btn, tabName) {
  if (!btn) return;
  document.querySelectorAll('.settings-tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.settings-tab-body').forEach(function(t) { t.classList.add('hidden'); });
  btn.classList.add('active');
  var tab = document.getElementById('tab-' + tabName);
  if (tab) tab.classList.remove('hidden');
  if (tabName === 'theme')    buildThemeGrid();
  if (tabName === 'querylog') loadQueryLog();
}

function openSettings() {
  apiCall('get_settings').then(function(s) {
    State.settings = s || {};
    var set = function(id, k) { var el = document.getElementById(id); if (el) el.value = s[k] || ''; };
    set('s-checkin',  'checkin_time');
    set('s-checkout', 'checkout_time');
    set('s-late',     'late_threshold');
    set('s-early',    'early_leave_threshold');
    set('s-wdays',    'working_days_per_month');
    set('s-org-name', 'org_name');
    var logo = s.org_logo_b64 || '';
    State.orgLogo = logo || null;
    updateLogoPreview(logo);
  }).catch(function(e) { toast('Failed to load settings: ' + e.message, 'error'); return; });
  openModal('modal-settings');
}

function updateLogoPreview(b64) {
  var preview = document.getElementById('logo-preview');
  var img     = document.getElementById('logo-img');
  if (!preview || !img) return;
  if (b64) {
    img.src = 'data:image/png;base64,' + b64;
    preview.classList.remove('hidden');
  } else {
    preview.classList.add('hidden');
    img.src = '';
  }
}

function pickLogo() {
  apiCall('open_file_dialog_type', 'image').then(function(path) {
    if (!path) return;
    return apiCall('read_file_as_b64', path);
  }).then(function(b64) {
    if (!b64) return;
    State.orgLogo = b64;
    updateLogoPreview(b64);
  }).catch(function(e) { toast('Could not load logo: ' + e.message, 'error'); });
}

function clearLogo() {
  State.orgLogo = null;
  updateLogoPreview(null);
}

function saveSettings() {
  var timeRe = /^\d{1,2}:\d{2}$/;
  var ci = (document.getElementById('s-checkin')  || {}).value || '';
  var co = (document.getElementById('s-checkout') || {}).value || '';
  var lt = (document.getElementById('s-late')     || {}).value || '';
  var el = (document.getElementById('s-early')    || {}).value || '';
  var wd = (document.getElementById('s-wdays')    || {}).value || '26';
  var orgName = (document.getElementById('s-org-name') || {}).value || '';

  var fields = [[ci,'Check-in'],[co,'Check-out'],[lt,'Late'],[el,'Early']];
  for (var i = 0; i < fields.length; i++) {
    if (!timeRe.test(fields[i][0].trim())) { toast(fields[i][1] + ' must be HH:MM', 'error'); return; }
  }

  var payload = {
    checkin_time: ci.trim(), checkout_time: co.trim(),
    late_threshold: lt.trim(), early_leave_threshold: el.trim(),
    working_days_per_month: wd.trim(),
    org_name: orgName.trim(),
    org_logo_b64: State.orgLogo || '',
  };

  apiCall('save_settings', payload).then(function() {
    State.settings = Object.assign({}, State.settings, payload);
    refreshThreshDisplay();
    updateOrgBranding();
    closeModal();
    toast('Settings saved.', 'ok');
  }).catch(function(e) { toast('Save failed: ' + e.message, 'error'); });
}

function refreshThreshDisplay() {
  var s  = State.settings;
  var el = document.getElementById('thresh-display');
  if (!el) return;
  el.innerHTML =
    '<div>check-in <span style="color:var(--text-body)">'  + (s.checkin_time||'—')             + '</span></div>' +
    '<div>check-out <span style="color:var(--text-body)">' + (s.checkout_time||'—')            + '</span></div>' +
    '<div>late &gt; <span style="color:var(--text-body)">' + (s.late_threshold||'—')           + '</span></div>' +
    '<div>early &lt; <span style="color:var(--text-body)">'+ (s.early_leave_threshold||'—')    + '</span></div>' +
    '<div>work days <span style="color:var(--text-body)">' + (s.working_days_per_month||'26')  + '</span>/mo</div>';
}

function updateOrgBranding() {
  var name = (State.settings && State.settings.org_name) || '';
  var el   = document.getElementById('org-name-display');
  if (!el) return;
  if (name) { el.textContent = name; el.classList.remove('hidden'); }
  else        el.classList.add('hidden');
}

/* ============================================================
   QUERY LOG
   ============================================================ */
function loadQueryLog() {
  var container = document.getElementById('query-log-list');
  if (!container) return;
  apiCall('get_query_log').then(function(logs) {
    if (!logs || !logs.length) {
      container.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;color:var(--text-dim)">No queries logged yet.</div>';
      return;
    }
    container.innerHTML = '';
    logs.forEach(function(log) {
      var row = document.createElement('div');
      row.className = 'qlog-row';
      var time = (log.ran_at || '').slice(0, 16).replace('T', ' ');
      var sqlEsc = escHtml(log.sql_text);
      row.innerHTML =
        '<div class="qlog-sql">' + sqlEsc + '</div>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">' +
          '<span class="qlog-meta">' + time + '<br>' + (log.row_count||0) + ' rows</span>' +
          '<button class="qlog-copy" onclick="copyToClipboard(' + JSON.stringify(log.sql_text) + ')">Copy</button>' +
        '</div>';
      container.appendChild(row);
    });
  }).catch(function(e) {
    container.innerHTML = '<div style="padding:10px;color:var(--danger);font-size:11px">' + escHtml(e.message) + '</div>';
  });
}

function clearQueryLog() {
  apiCall('clear_query_log').then(function() {
    loadQueryLog();
    toast('Query log cleared.', 'ok');
  }).catch(function(e) { toast(e.message, 'error'); });
}

function copyToClipboard(text) {
  // pywebview GTK doesn't support navigator.clipboard — use execCommand fallback
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('Copied to clipboard', 'ok');
  } catch(e) {
    toast('Copy failed: ' + e.message, 'error');
  }
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================
   IMPORT
   ============================================================ */
var _selectedFilePath = null;

function browseFile() {
  apiCall('open_file_dialog').then(function(path) {
    if (path) setSelectedFile(path);
  }).catch(function(e) { toast('File picker error: ' + e.message, 'error'); });
}

function setSelectedFile(path) {
  _selectedFilePath = path;
  var name = path.replace(/\\/g, '/').split('/').pop();
  var fn   = document.getElementById('import-filename');
  var btn  = document.getElementById('btn-import');
  if (fn)  fn.textContent = name;
  if (btn) btn.disabled = false;
}

function triggerImport() {
  if (!_selectedFilePath) return;
  var name = _selectedFilePath.replace(/\\/g, '/').split('/').pop();
  apiCall('check_already_imported', name).then(function(existing) {
    if (existing) {
      var msg = document.getElementById('overwrite-msg');
      if (msg) msg.innerHTML = '<strong>' + escHtml(name) + '</strong> was imported on ' + (existing.imported_at||'').slice(0,10) + ' (' + (existing.rows_imported||'?') + ' records).';
      State.pendingFile = _selectedFilePath;
      openModal('modal-overwrite');
    } else {
      doImport(_selectedFilePath, false);
    }
  }).catch(function(e) { toast('Error: ' + e.message, 'error'); });
}

function confirmImport(overwrite) {
  closeModal();
  if (State.pendingFile) { doImport(State.pendingFile, overwrite); State.pendingFile = null; }
}

function doImport(filepath, overwrite) {
  var progBar  = document.getElementById('import-progress');
  var btnImp   = document.getElementById('btn-import');
  var statusEl = document.getElementById('import-status');
  if (progBar) progBar.classList.remove('hidden');
  if (btnImp)  btnImp.disabled = true;
  setSqlStatus('Parsing file…', 'info');
  apiCall('import_file', filepath, overwrite).then(function(r) {
    if (progBar) progBar.classList.add('hidden');
    if (btnImp)  btnImp.disabled = false;
    if (statusEl) {
      statusEl.textContent = '✓ ' + r.inserted + ' records · ' + r.employees + ' employees · ' + r.period_start + '→' + r.period_end;
      statusEl.style.color = 'var(--ok)';
    }
    refreshDbStatus();
    toast('Import complete: ' + r.inserted + ' records.', 'ok');
    if (r.employee_diff) showEmployeeDiff(r.employee_diff);
    if (r.warnings && r.warnings.length) toast('⚠ ' + r.warnings.length + ' warning(s): ' + r.warnings[0], 'warning');
  }).catch(function(e) {
    if (progBar) progBar.classList.add('hidden');
    if (btnImp)  btnImp.disabled = false;
    if (statusEl) { statusEl.textContent = '✗ ' + e.message; statusEl.style.color = 'var(--danger)'; }
    toast('Import failed: ' + e.message, 'error');
  });
}

function showEmployeeDiff(diff) {
  var added   = diff.added   || [];
  var removed = diff.removed || [];
  if (!added.length && !removed.length) return;
  var html = '';
  if (added.length) {
    html += '<strong>' + added.length + ' new employee' + (added.length>1?'s':'') + ' detected:</strong> ' +
            added.slice(0,3).join(', ') + (added.length>3?' +' + (added.length-3) + ' more':'') + '. ' +
            '<button style="text-decoration:underline;font-weight:600;background:none;border:none;cursor:pointer;color:inherit" onclick="openEmployees()">Add details →</button>  ';
  }
  if (removed.length) {
    html += '<strong>' + removed.length + ' employee' + (removed.length>1?'s':'') + ' no longer in file:</strong> ' +
            removed.slice(0,3).join(', ') + (removed.length>3?' +' + (removed.length-3) + ' more':'') + '.';
  }
  var txtEl  = document.getElementById('emp-diff-text');
  var banner = document.getElementById('emp-diff-banner');
  if (txtEl)  txtEl.innerHTML = html;
  if (banner) banner.classList.remove('hidden');
}

function handleDragOver(e) {
  e.preventDefault();
  var dz = document.getElementById('drop-zone');
  if (dz) dz.classList.add('drag-over');
}
function handleDragLeave() {
  var dz = document.getElementById('drop-zone');
  if (dz) dz.classList.remove('drag-over');
}
function handleDrop(e) {
  e.preventDefault();
  var dz = document.getElementById('drop-zone');
  if (dz) dz.classList.remove('drag-over');
  var files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length > 0) {
    var f    = files[0];
    var path = f.path || f.name;
    if (/\.(xls|xlsx|xlsm)$/i.test(path)) setSelectedFile(path);
    else toast('Please drop an Excel file (.xls / .xlsx)', 'error');
  }
}

/* ============================================================
   FILTER BUILDER
   ============================================================ */
var FIELDS = [
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

var _filterRows = [], _filterIdCounter = 0;

function addFilterRow() {
  var id      = ++_filterIdCounter;
  var isFirst = _filterRows.length === 0;
  var field   = FIELDS[0];
  _filterRows.push({ id: id, field: field.label, op: field.ops[0], value: '', value2: '', joiner: 'AND' });
  var container = document.getElementById('filter-rows');
  if (!container) return;
  var row = document.createElement('div');
  row.className   = 'filter-row';
  row.dataset.id  = id;
  row.innerHTML   = renderFilterRow(id, isFirst, field);
  container.appendChild(row);
  bindFilterRow(row, id);
  updateFilterSQL();
}

function renderFilterRow(id, isFirst, field) {
  var joiner = isFirst
    ? '<span style="font-size:10px;color:var(--text-dim);flex-shrink:0;width:32px;text-align:center">WHERE</span>'
    : '<button class="joiner-pill active" data-id="' + id + '">AND</button>';

  var fieldOpts = FIELDS.map(function(f) {
    return '<option value="' + f.label + '"' + (f.label === field.label ? ' selected' : '') + '>' + f.label + '</option>';
  }).join('');
  var opOpts = field.ops.map(function(o) { return '<option value="' + o + '">' + o + '</option>'; }).join('');
  var valHTML = buildValueHTML(id, field, field.ops[0]);

  return joiner +
    '<select class="field-sel" style="width:110px;flex-shrink:0" data-id="' + id + '">' + fieldOpts + '</select>' +
    '<select class="op-sel"    style="width:90px;flex-shrink:0"  data-id="' + id + '">' + opOpts + '</select>' +
    '<div class="value-wrap"   style="flex:1;display:flex;gap:3px;min-width:0" data-id="' + id + '">' + valHTML + '</div>' +
    '<button class="remove-filter" data-id="' + id + '">✕</button>';
}

function buildValueHTML(id, field, op) {
  var today = new Date().toISOString().slice(0,10);
  if (field.opts) {
    return '<select class="val-inp" data-id="' + id + '" style="flex:1">' + field.opts.map(function(o){ return '<option>' + o + '</option>'; }).join('') + '</select>';
  }
  if (field.cat === 'date') {
    if (op === 'between') {
      return '<input class="val-inp" data-id="' + id + '" type="text" value="' + today + '" style="flex:1;min-width:80px" placeholder="YYYY-MM-DD">' +
             '<span style="font-size:10px;color:var(--text-dim);flex-shrink:0">to</span>' +
             '<input class="val2-inp" data-id="' + id + '" type="text" value="' + today + '" style="flex:1;min-width:80px" placeholder="YYYY-MM-DD">';
    }
    return '<input class="val-inp" data-id="' + id + '" type="text" value="' + today + '" style="flex:1" placeholder="YYYY-MM-DD">';
  }
  if (field.cat === 'time')   return '<input class="val-inp" data-id="' + id + '" type="text" value="09:00" style="flex:1;max-width:75px" placeholder="HH:MM">';
  if (field.cat === 'number') return '<input class="val-inp" data-id="' + id + '" type="number" value="6" style="flex:1;max-width:75px">';
  return '<input class="val-inp" data-id="' + id + '" type="text" style="flex:1" placeholder="Search…">';
}

function bindFilterRow(row, id) {
  var joinerBtn = row.querySelector('.joiner-pill');
  if (joinerBtn) {
    joinerBtn.addEventListener('click', function() {
      var fr = _filterRows.find(function(r){ return r.id === id; });
      if (!fr) return;
      fr.joiner = fr.joiner === 'AND' ? 'OR' : 'AND';
      joinerBtn.textContent = fr.joiner;
      joinerBtn.classList.toggle('active', fr.joiner === 'AND');
      updateFilterSQL();
    });
  }

  var fieldSel = row.querySelector('.field-sel');
  if (fieldSel) {
    fieldSel.addEventListener('change', function() {
      var fr = _filterRows.find(function(r){ return r.id === id; });
      if (!fr) return;
      fr.field = fieldSel.value; fr.value = ''; fr.value2 = '';
      var field = FIELDS.find(function(f){ return f.label === fr.field; });
      fr.op = field.ops[0];
      var opSel = row.querySelector('.op-sel');
      if (opSel) { opSel.innerHTML = field.ops.map(function(o){ return '<option value="' + o + '">' + o + '</option>'; }).join(''); opSel.value = fr.op; }
      var vw = row.querySelector('.value-wrap');
      if (vw) vw.innerHTML = buildValueHTML(id, field, fr.op);
      bindValueEvents(row, id);
      updateFilterSQL();
    });
  }

  var opSel = row.querySelector('.op-sel');
  if (opSel) {
    opSel.addEventListener('change', function() {
      var fr = _filterRows.find(function(r){ return r.id === id; });
      if (!fr) return;
      fr.op = opSel.value;
      var field = FIELDS.find(function(f){ return f.label === fr.field; });
      var vw = row.querySelector('.value-wrap');
      if (vw) vw.innerHTML = buildValueHTML(id, field, fr.op);
      bindValueEvents(row, id);
      updateFilterSQL();
    });
  }

  bindValueEvents(row, id);

  var removeBtn = row.querySelector('.remove-filter');
  if (removeBtn) {
    removeBtn.addEventListener('click', function() {
      row.remove();
      _filterRows = _filterRows.filter(function(r){ return r.id !== id; });
      updateFilterSQL();
    });
  }
}

function bindValueEvents(row, id) {
  row.querySelectorAll('.val-inp, .val2-inp').forEach(function(el) {
    el.addEventListener('input', function() {
      var fr = _filterRows.find(function(r){ return r.id === id; });
      if (!fr) return;
      if (el.classList.contains('val-inp'))  fr.value  = el.value;
      if (el.classList.contains('val2-inp')) fr.value2 = el.value;
      updateFilterSQL();
    });
  });
}

function clearFilters() {
  var c = document.getElementById('filter-rows');
  if (c) c.innerHTML = '';
  _filterRows = [];
  addFilterRow();
}

function buildFiltersPayload() {
  return _filterRows.map(function(fr) {
    return { field: fr.field, operator: fr.op, value: fr.value, value2: fr.value2 || '', joiner: fr.joiner };
  });
}

var OP_SQL = {
  'contains':    function(c,v)   { return "LOWER(" + c + ") LIKE '%" + v + "%'"; },
  'equals':      function(c,v)   { return "LOWER(" + c + ") = '" + v + "'"; },
  'starts with': function(c,v)   { return "LOWER(" + c + ") LIKE '" + v + "%'"; },
  'ends with':   function(c,v)   { return "LOWER(" + c + ") LIKE '%" + v + "'"; },
  'not equals':  function(c,v)   { return "LOWER(" + c + ") != '" + v + "'"; },
  'on':          function(c,v)   { return c + " = '" + v + "'"; },
  'before':      function(c,v)   { return c + " < '" + v + "'"; },
  'after':       function(c,v)   { return c + " > '" + v + "'"; },
  'on or before':function(c,v)   { return c + " <= '" + v + "'"; },
  'on or after': function(c,v)   { return c + " >= '" + v + "'"; },
  'between':     function(c,v,v2){ return c + " BETWEEN '" + v + "' AND '" + v2 + "'"; },
  'greater than':function(c,v)   { return c + " > " + v; },
  'less than':   function(c,v)   { return c + " < " + v; },
  'at least':    function(c,v)   { return c + " >= " + v; },
  'at most':     function(c,v)   { return c + " <= " + v; },
  'is':          function(c,v)   { return c + " = '" + (v==='Yes'?'1':v==='No'?'0':v.toUpperCase()) + "'"; },
  'is not':      function(c,v)   { return c + " != '" + v.toUpperCase() + "'"; },
};

function updateFilterSQL() {
  try {
    var sortCol = (document.getElementById('sort-col') || {}).value || 'work_date';
    var sortDir = (document.getElementById('sort-dir') || {}).value || 'ASC';
    var lim     = (document.getElementById('result-limit') || {}).value || '5000';

    var lines = buildFiltersPayload().map(function(f, i) {
      var field = FIELDS.find(function(fd){ return fd.label === f.field; });
      if (!field) return '';
      var fn = OP_SQL[f.operator];
      if (!fn) return '';
      var clause = fn(field.col, f.value || '?', f.value2 || '?');
      return (i === 0 ? 'WHERE ' : '  ' + f.joiner + ' ') + clause;
    }).filter(function(l){ return l !== ''; });

    var sql = [
      'SELECT',
      '  emp_code, emp_name, work_date, status,',
      '  punch_in AS "In", punch_out AS "Out",',
      '  work_hours AS "Hours", is_late AS "Late", left_early AS "Left Early"',
      'FROM attendance_raw',
    ].concat(lines).concat([
      'ORDER BY ' + sortCol + ' ' + sortDir,
      'LIMIT ' + lim,
    ]).join('\n');
    setSqlEditor(sql);
  } catch(e) {}
}

function runFilter() {
  var filters = JSON.stringify(buildFiltersPayload());
  var sc  = (document.getElementById('sort-col') || {}).value || 'work_date';
  var sd  = (document.getElementById('sort-dir') || {}).value || 'ASC';
  var lim = parseInt((document.getElementById('result-limit') || {}).value || '5000', 10);
  setSqlStatus('Running…', 'info');
  apiCall('run_filter', filters, sc, sd, lim).then(function(res) {
    setSqlStatus('✓ ' + res.count + ' records', 'ok');
    if (res.sql) setSqlEditor(res.sql);
    showResults(res.columns, res.rows, 'Search Results');
  }).catch(function(e) { setSqlStatus('✗ ' + e.message, 'error'); toast(e.message, 'error'); });
}

/* ============================================================
   SQL PANEL
   ============================================================ */
function setSqlEditor(sql) {
  var ta = document.getElementById('sql-editor');
  if (ta) ta.value = sql;
  updateLineNumbers('sql-editor', 'sql-lines');
}

function updateLineNumbers(editorId, linesId) {
  var ta = document.getElementById(editorId);
  var ln = document.getElementById(linesId);
  if (!ta || !ln) return;
  var n    = ta.value.split('\n').length;
  var html = '';
  for (var i = 1; i <= n; i++) html += i + '<br>';
  ln.innerHTML = html;
}

function setSqlStatus(msg, type) {
  var el     = document.getElementById('sql-status');
  if (!el) return;
  var colors = { info: 'var(--text-dim)', ok: 'var(--ok)', error: 'var(--danger)', warning: 'var(--warn)' };
  el.textContent  = msg;
  el.style.color  = colors[type] || 'var(--text-dim)';
}

function runSql() {
  var ta = document.getElementById('sql-editor');
  if (!ta) return;
  var sql = ta.value.split('\n').filter(function(l){ return !l.trim().startsWith('--'); }).join('\n').trim();
  if (!sql) { setSqlStatus('Enter a SELECT query.', 'error'); return; }
  setSqlStatus('Running…', 'info');
  apiCall('run_sql', sql).then(function(res) {
    setSqlStatus('✓ ' + res.count + ' records', 'ok');
    showResults(res.columns, res.rows, 'Query Results');
  }).catch(function(e) { setSqlStatus('✗ ' + e.message, 'error'); toast(e.message, 'error'); });
}

function clearSql() {
  var ta = document.getElementById('sql-editor');
  if (ta) ta.value = '';
  updateLineNumbers('sql-editor', 'sql-lines');
  setSqlStatus('');
}

/* Schema Reference */
var SCHEMA = [
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

var EXAMPLE_QUERIES = [
  "SELECT * FROM attendance_raw\nWHERE LOWER(emp_name) LIKE '%anita%'",
  "SELECT emp_name, COUNT(*) AS absent\nFROM attendance_raw WHERE status='ABSENT'\nGROUP BY emp_code ORDER BY absent DESC",
  "SELECT emp_name,\n  SUM(CASE WHEN status='PRESENT' THEN 1 ELSE 0 END) AS days\nFROM attendance_raw GROUP BY emp_code",
];

function buildSchemaContent(container) {
  if (!container) return;
  container.innerHTML = '';
  SCHEMA.forEach(function(s) {
    var badge = document.createElement('span');
    badge.className   = 'schema-table-badge';
    badge.textContent = s.table;
    container.appendChild(badge);
    s.cols.forEach(function(c) {
      var row = document.createElement('div');
      row.className = 'schema-col-row';
      row.innerHTML = '<span class="schema-col-name">' + c[0] + '</span><span class="schema-col-type type-' + c[1] + '">' + c[1] + '</span><span class="schema-col-hint">' + c[2] + '</span>';
      container.appendChild(row);
    });
  });
  var exBadge = document.createElement('span');
  exBadge.className = 'schema-table-badge';
  exBadge.style.cssText = 'color:var(--ok);background:var(--ok-bg)';
  exBadge.textContent = 'examples';
  container.appendChild(exBadge);
  EXAMPLE_QUERIES.forEach(function(ex) {
    var pre = document.createElement('pre');
    pre.style.cssText = 'font-size:9px;color:var(--text-mid);padding:3px 8px;cursor:pointer;border-radius:3px;white-space:pre-wrap;transition:background 100ms';
    pre.textContent = ex;
    pre.title = 'Click to insert';
    pre.addEventListener('mouseenter', function(){ pre.style.background = 'var(--bg-muted)'; });
    pre.addEventListener('mouseleave', function(){ pre.style.background = ''; });
    pre.addEventListener('click', function() { setSqlEditor(ex); toast('Query inserted', 'info'); });
    container.appendChild(pre);
  });
}

function toggleSchema() {
  var panel = document.getElementById('schema-panel');
  var btn   = document.getElementById('btn-schema-toggle');
  if (!panel) return;
  var isHidden = panel.classList.toggle('hidden');
  if (btn) btn.textContent = isHidden ? '📋 Schema' : '✕ Schema';
  if (!isHidden && !panel.children.length) buildSchemaContent(panel);
}

/* ============================================================
   RESULTS GRID
   ============================================================ */
function showResults(columns, rows, title) {
  State.results = { columns: columns, rows: rows.slice(), title: title || 'Results' };
  State.sortCol = null; State.sortAsc = true;
  renderGrid();
  var rt = document.getElementById('results-title');
  if (rt) rt.textContent = title || 'Results';
  var ec = document.getElementById('btn-export-csv');
  var ep = document.getElementById('btn-export-pdf');
  if (ec) ec.disabled = !rows.length;
  if (ep) ep.disabled = !rows.length;
}

function renderGrid() {
  var cols  = State.results.columns;
  var rows  = State.results.rows;
  var head  = document.getElementById('results-head');
  var body  = document.getElementById('results-body');
  var empty = document.getElementById('results-empty');
  var count = document.getElementById('results-count');
  if (!head || !body) return;
  head.innerHTML = ''; body.innerHTML = '';
  if (!cols || !cols.length) {
    if (empty) empty.classList.remove('hidden');
    if (count) count.textContent = '';
    return;
  }
  if (empty) empty.classList.add('hidden');
  var tr = document.createElement('tr');
  cols.forEach(function(col) {
    var th = document.createElement('th');
    th.textContent = col;
    if (col === State.sortCol) th.className = State.sortAsc ? 'sort-asc' : 'sort-desc';
    th.addEventListener('click', function(){ sortGrid(col); });
    tr.appendChild(th);
  });
  head.appendChild(tr);

  var frag = document.createDocumentFragment();
  rows.forEach(function(row) {
    var tr2 = document.createElement('tr');
    cols.forEach(function(col) {
      var td  = document.createElement('td');
      var val = (row[col] !== undefined && row[col] !== null) ? row[col] : '';
      if (col.toLowerCase() === 'status') {
        var span = document.createElement('span');
        span.className   = 'status-' + String(val).toUpperCase().replace(/ /g,'_');
        span.textContent = val;
        td.appendChild(span);
      } else {
        td.textContent = val;
      }
      tr2.appendChild(td);
    });
    frag.appendChild(tr2);
  });
  body.appendChild(frag);
  if (count) count.textContent = '— ' + rows.length.toLocaleString() + ' record' + (rows.length !== 1 ? 's' : '');
}

function sortGrid(col) {
  State.sortAsc = (State.sortCol === col) ? !State.sortAsc : true;
  State.sortCol = col;
  State.results.rows.sort(function(a, b) {
    var va = a[col] !== null && a[col] !== undefined ? a[col] : '';
    var vb = b[col] !== null && b[col] !== undefined ? b[col] : '';
    var na = parseFloat(String(va).replace(/[₹,]/g,''));
    var nb = parseFloat(String(vb).replace(/[₹,]/g,''));
    if (!isNaN(na) && !isNaN(nb)) return State.sortAsc ? na-nb : nb-na;
    return State.sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
  });
  renderGrid();
}

/* ============================================================
   QUICK REPORTS
   ============================================================ */
function runQuickReport(report, extra) {
  var from = (document.getElementById('quick-from') || {}).value || '';
  var to   = (document.getElementById('quick-to')   || {}).value || '';
  setSqlStatus('Running…', 'info');
  apiCall('quick_report', report, from, to, extra || '').then(function(res) {
    var titles = {
      monthly_summary:'Monthly Summary', late:'Late Arrivals', early:'Early Leavers',
      absent:'Absentees', days_worked:'Days Worked', salary:'Salary Report',
      grid:'Full Attendance Grid', perfect:'Perfect Attendance',
      chronic:'Frequent Absentees (≥' + (extra||3) + ')',
    };
    var title = (titles[report] || report) + (from ? ' (' + from + '→' + to + ')' : '');
    setSqlStatus('✓ ' + res.count + ' records', 'ok');
    showResults(res.columns, res.rows, title);
    toast((titles[report]||report) + ': ' + res.count + ' records', 'ok');
  }).catch(function(e) { setSqlStatus('✗ ' + e.message, 'error'); toast(e.message, 'error'); });
}

function runChronicReport() {
  var val = (document.getElementById('chronic-input') || {}).value || '3';
  closeModal();
  runQuickReport('chronic', val);
}

/* ============================================================
   CUSTOM SHORTCUTS  (persisted in SQLite via backend)
   ============================================================ */
function loadCustomReports() {
  var raw = memGet('ap_custom_reports', null);
  if (raw) {
    try { State.customReports = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch(e) { State.customReports = []; }
  } else {
    State.customReports = [];
  }
  renderCustomReports();
}

function saveCustomReportsToDisk() {
  var json = JSON.stringify(State.customReports);
  memSet('ap_custom_reports', json);
  apiCall('save_settings', { ap_custom_reports: json }).catch(function(){});
}

function renderCustomReports() {
  var container = document.getElementById('quick-custom');
  if (!container) return;
  if (!State.customReports.length) { container.innerHTML = ''; return; }
  container.innerHTML = '<div class="quick-section-label mt-1">Custom</div>';
  State.customReports.forEach(function(cr) {
    var outer = document.createElement('div');
    outer.className = 'quick-btn custom-shortcut';
    outer.innerHTML =
      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml((cr.icon||'📌') + ' ' + cr.title) + '</span>' +
      '<span class="cr-actions" style="display:none;gap:4px">' +
        '<button style="font-size:10px;color:var(--accent);background:none;border:none;cursor:pointer" data-edit="' + cr.id + '">✏</button>' +
        '<button style="font-size:10px;color:var(--danger);background:none;border:none;cursor:pointer" data-del="' + cr.id + '">✕</button>' +
      '</span>';
    outer.addEventListener('mouseenter', function(){ var a = outer.querySelector('.cr-actions'); if(a) a.style.display='flex'; });
    outer.addEventListener('mouseleave', function(){ var a = outer.querySelector('.cr-actions'); if(a) a.style.display='none'; });
    outer.addEventListener('click', function(e) {
      if (e.target.dataset.edit) { openCustomReportModal(e.target.dataset.edit); return; }
      if (e.target.dataset.del)  { deleteCustomReport(e.target.dataset.del); return; }
      runCustomReport(cr);
    });
    container.appendChild(outer);
  });
}

function runCustomReport(cr) {
  setSqlStatus('Running…', 'info');
  apiCall('run_sql', cr.sql).then(function(res) {
    setSqlStatus('✓ ' + res.count + ' records', 'ok');
    showResults(res.columns, res.rows, (cr.icon||'📌') + ' ' + cr.title);
    toast(cr.title + ': ' + res.count + ' records', 'ok');
  }).catch(function(e) { setSqlStatus('✗ ' + e.message, 'error'); toast(e.message, 'error'); });
}

function openCustomReportModal(editId) {
  var cr = editId ? State.customReports.find(function(r){ return r.id === editId; }) : null;
  var titleEl = document.getElementById('cr-title');
  var iconEl  = document.getElementById('cr-icon');
  var sqlEl   = document.getElementById('cr-sql');
  if (titleEl) titleEl.value = cr ? cr.title : '';
  if (iconEl)  iconEl.value  = cr ? (cr.icon||'📌') : '📌';
  if (sqlEl) { sqlEl.value = cr ? cr.sql : ''; sqlEl.dataset.editId = editId || ''; }
  updateLineNumbers('cr-sql', 'cr-lines');
  buildSchemaContent(document.getElementById('cr-schema-ref'));
  openModal('modal-custom-report');
}

function deleteCustomReport(id) {
  State.customReports = State.customReports.filter(function(r){ return r.id !== id; });
  saveCustomReportsToDisk();
  renderCustomReports();
  toast('Shortcut removed.', 'ok');
}

function saveCustomReport() {
  var title  = ((document.getElementById('cr-title') || {}).value || '').trim();
  var icon   = ((document.getElementById('cr-icon')  || {}).value || '📌').trim();
  var sql    = ((document.getElementById('cr-sql')   || {}).value || '').trim();
  var editId = ((document.getElementById('cr-sql')   || {}).dataset || {}).editId || '';
  if (!title) { toast('Please enter a report title.', 'error'); return; }
  if (!sql)   { toast('Please enter a SQL query.',    'error'); return; }
  if (editId) {
    var idx = State.customReports.findIndex(function(r){ return r.id === editId; });
    if (idx >= 0) State.customReports[idx] = { id: editId, title: title, icon: icon, sql: sql };
  } else {
    State.customReports.push({ id: Date.now().toString(), title: title, icon: icon, sql: sql });
  }
  saveCustomReportsToDisk();
  renderCustomReports();
  closeModal();
  toast('"' + title + '" shortcut saved.', 'ok');
}

/* ============================================================
   EMPLOYEES
   ============================================================ */
function openEmployees() {
  openModal('modal-employees');
  loadEmployees();
}

function loadEmployees() {
  apiCall('get_employees').then(function(employees) {
    var tbody = document.getElementById('emp-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    employees.forEach(function(e) {
      var sal  = e.monthly_salary || 0;
      var wd   = e.working_days   || 26;
      var dr   = sal > 0 ? (sal / wd).toFixed(2) : '—';
      var name = e.emp_name_override || '';
      var tr   = document.createElement('tr');
      tr.innerHTML =
        '<td class="tbl-head" style="font-family:monospace">' + escHtml(e.emp_code||'') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;color:var(--text-dim)">' + escHtml(e.emp_name||'') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;' + (name?'font-weight:500':'font-style:italic;color:var(--text-dim)') + '">' + escHtml(name||'not set') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;text-align:right;font-family:monospace">' + (sal?'₹'+Number(sal).toLocaleString():'—') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;text-align:center">' + wd + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;text-align:right;font-family:monospace;color:var(--text-dim)">' + (dr!=='—'?'₹'+dr:'—') + '</td>' +
        '<td style="padding:5px 8px"><button style="font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer" ' +
          'data-code="' + escHtml(e.emp_code||'') + '" ' +
          'data-name="' + escHtml(e.emp_name||'') + '" ' +
          'data-override="' + escHtml(name) + '" ' +
          'data-sal="' + sal + '" ' +
          'data-wd="' + wd + '" ' +
          'onclick="editEmployee(this)">Edit</button></td>';
      tbody.appendChild(tr);
    });
  }).catch(function(e) { toast('Failed to load employees: ' + e.message, 'error'); });
}

function editEmployee(btn) {
  var code     = btn.dataset.code     || '';
  var name     = btn.dataset.name     || '';
  var override = btn.dataset.override || '';
  var sal      = btn.dataset.sal      || '0';
  var wd       = btn.dataset.wd       || '26';
  State.editingEmp = { code: code, name: name };
  var editRow = document.getElementById('emp-edit-row');
  var editLbl = document.getElementById('emp-edit-label');
  var fn      = document.getElementById('emp-fullname');
  var salary  = document.getElementById('emp-salary');
  var wdays   = document.getElementById('emp-wdays');
  if (editRow) editRow.classList.remove('hidden');
  if (editLbl) editLbl.textContent = '[' + code + '] ' + name;
  if (fn)     fn.value     = override;
  if (salary) salary.value = sal;
  if (wdays)  wdays.value  = wd;
}

function cancelEmpEdit() {
  State.editingEmp = null;
  var editRow = document.getElementById('emp-edit-row');
  if (editRow) editRow.classList.add('hidden');
}

function saveEmployee() {
  var emp = State.editingEmp;
  if (!emp) return;
  var fn     = (document.getElementById('emp-fullname') || {}).value || '';
  var sal    = parseFloat((document.getElementById('emp-salary') || {}).value || '0') || 0;
  var wdays  = parseInt((document.getElementById('emp-wdays')   || {}).value || '26', 10) || 26;
  apiCall('upsert_employee', emp.code, emp.name, fn, sal, wdays).then(function() {
    cancelEmpEdit();
    loadEmployees();
    toast('Employee updated.', 'ok');
  }).catch(function(e) { toast('Save failed: ' + e.message, 'error'); });
}

/* ============================================================
   IMPORT HISTORY
   ============================================================ */
function openHistory() {
  openModal('modal-history');
  apiCall('get_import_history').then(function(history) {
    var tbody = document.getElementById('history-tbody');
    var empty = document.getElementById('history-empty');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!history || !history.length) { if(empty) empty.classList.remove('hidden'); return; }
    if (empty) empty.classList.add('hidden');
    history.forEach(function(r) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="padding:5px 8px;font-size:11px;font-family:monospace">' + escHtml(r.filename||'') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;color:var(--text-dim)">' + (r.imported_at||'').slice(0,16).replace('T',' ') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;text-align:right;font-family:monospace">' + (r.rows_imported||0) + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;color:var(--text-dim)">' + (r.period_start||'') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;color:var(--text-dim)">' + (r.period_end||'') + '</td>' +
        '<td style="padding:5px 8px;font-size:11px;color:var(--text-dim)">' + escHtml(r.company_name||'') + '</td>';
      tbody.appendChild(tr);
    });
  }).catch(function(e) { toast('Could not load history: ' + e.message, 'error'); });
}

/* ============================================================
   EXPORT
   ============================================================ */
function exportCsv() {
  var cols = State.results.columns;
  var rows = State.results.rows;
  var title = State.results.title || 'export';
  if (!rows.length) { toast('No data to export', 'warning'); return; }
  var defName = title.replace(/[^a-z0-9]+/gi,'_').slice(0,40);
  apiCall('save_file_dialog', defName, 'csv').then(function(path) {
    if (!path) return;
    return apiCall('export_csv', cols, rows, path).then(function() {
      toast('CSV saved: ' + path.replace(/\\/g,'/').split('/').pop(), 'ok');
    });
  }).catch(function(e) { toast('Export failed: ' + e.message, 'error'); });
}

function exportPdf() {
  var cols  = State.results.columns;
  var rows  = State.results.rows;
  var title = State.results.title || 'Report';
  if (!rows.length) { toast('No data to export', 'warning'); return; }
  var defName = title.replace(/[^a-z0-9]+/gi,'_').slice(0,40);
  apiCall('save_file_dialog', defName, 'pdf').then(function(path) {
    if (!path) return;
    var orgName = (State.settings && State.settings.org_name) || '';
    var logo    = (State.settings && State.settings.org_logo_b64) || '';
    return apiCall('export_pdf', cols, rows, path, title, orgName, logo).then(function() {
      toast('PDF saved: ' + path.replace(/\\/g,'/').split('/').pop(), 'ok');
    });
  }).catch(function(e) { toast('Export failed: ' + e.message, 'error'); });
}

/* ============================================================
   INIT — all listeners, then load backend data
   ============================================================ */
document.addEventListener('DOMContentLoaded', function() {

  // ── Zoom (applied immediately, no API needed)
  initZoom();

  // ── Resizable panels
  loadPanelWidths();
  initResizableHandles();

  // ── Button listeners
  var on = function(id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  on('btn-browse',       'click', browseFile);
  on('btn-import',       'click', triggerImport);
  on('btn-settings',     'click', openSettings);
  on('btn-employees',    'click', openEmployees);
  on('btn-history',      'click', openHistory);
  on('btn-add-filter',   'click', addFilterRow);
  on('btn-run-filter',   'click', runFilter);
  on('btn-clear-filter', 'click', clearFilters);
  on('btn-sql-run',      'click', runSql);
  on('btn-sql-clear',    'click', clearSql);
  on('btn-schema-toggle','click', toggleSchema);
  on('btn-export-csv',   'click', exportCsv);
  on('btn-export-pdf',   'click', exportPdf);

  // ── SQL editor: line numbers + Ctrl+Enter + Tab
  var sqlEd = document.getElementById('sql-editor');
  if (sqlEd) {
    sqlEd.addEventListener('input', function(){ updateLineNumbers('sql-editor','sql-lines'); });
    sqlEd.addEventListener('keydown', function(e) {
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); runSql(); }
      if (e.key === 'Tab') {
        e.preventDefault();
        var s = sqlEd.selectionStart;
        sqlEd.value = sqlEd.value.slice(0,s) + '  ' + sqlEd.value.slice(sqlEd.selectionEnd);
        sqlEd.selectionStart = sqlEd.selectionEnd = s + 2;
        updateLineNumbers('sql-editor','sql-lines');
      }
    });
  }

  // ── Custom report SQL line numbers
  on('cr-sql', 'input', function(){ updateLineNumbers('cr-sql','cr-lines'); });

  // ── Sort + limit selects
  on('sort-col',      'change', updateFilterSQL);
  on('sort-dir',      'change', updateFilterSQL);
  on('result-limit',  'input',  updateFilterSQL);

  // ── Quick report buttons
  document.querySelectorAll('.quick-btn[data-report]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var report = btn.dataset.report;
      if (report === 'chronic') openModal('modal-chronic');
      else runQuickReport(report);
    });
  });

  // ── ESC closes modal
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });

  // ── Initial filter row
  addFilterRow();

  // ── Load persisted UI state from Python backend (non-blocking)
  waitForApi().then(function() {
    return window.pywebview.api.get_settings();
  }).then(function(res) {
    if (!res.ok) return;
    var s = res.data || {};

    // Theme
    var theme = s.ap_theme || 'mono';
    memSet('ap_theme', theme);
    loadSavedTheme(theme);

    // Zoom
    if (s.ap_zoom) {
      var z = parseFloat(s.ap_zoom);
      if (!isNaN(z)) { memSet('ap_zoom', z); setZoom(z); }
    } else {
      setZoom(ZOOM_DEFAULT);
    }

    // Panel widths
    if (s.ap_panels) {
      memSet('ap_panels', s.ap_panels);
      loadPanelWidths();
    }

    // Custom reports
    if (s.ap_custom_reports) {
      memSet('ap_custom_reports', s.ap_custom_reports);
      loadCustomReports();
    } else {
      loadCustomReports();
    }

    // App settings
    State.settings = s;
    refreshThreshDisplay();
    updateOrgBranding();
    if (s.org_logo_b64) State.orgLogo = s.org_logo_b64;

    // DB status
    return refreshDbStatus();
  }).catch(function(e) {
    console.error('Init error:', e);
    // Still load defaults
    loadCustomReports();
    addFilterRow();
  });
});
