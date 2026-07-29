/**
 * app.js — AttendanceProcessor v4
 * =================================
 * No localStorage. Uses window._apMem + Python SQLite backend.
 * V4 adds: SELECT/GROUP BY/HAVING builder, dual-table results,
 *          real SQL preview (no ?), last-file auto-load.
 */

'use strict';

/* ── In-memory store (replaces localStorage) ────────────────── */
window._apMem = window._apMem || {};
function memGet(key, def) { var v = window._apMem[key]; return (v !== undefined && v !== null) ? v : (def !== undefined ? def : null); }
function memSet(key, val) { window._apMem[key] = val; }

/* ── API bridge ─────────────────────────────────────────────── */
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
    if (!res.ok) throw new Error(res.error || 'API error');
    return res.data;
  });
}

/* ── State ──────────────────────────────────────────────────── */
var State = {
  results: { columns: [], rows: [], title: '' },
  dualResults: null,
  lastSqlDisplay: '',
  sortCol: null, sortAsc: true,
  pendingFile: null, editingEmp: null,
  settings: {}, customReports: [], activeModal: null,
  orgLogo: null,
  selectFields: [],  // [{label, expr, isAgg}]
  groupByFields: [], // [{label, expr}]
};

/* ── SELECT / GROUPBY field definitions (mirrors query_builder.py) ── */
var SELECT_FIELDS = [
  { label: 'Employee Name',    expr: 'emp_name',   isAgg: false },
  { label: 'Employee ID',      expr: 'emp_code',   isAgg: false },
  { label: 'Date',             expr: 'work_date',  isAgg: false },
  { label: 'Status',           expr: 'status',     isAgg: false },
  { label: 'Arrival Time',     expr: 'punch_in',   isAgg: false },
  { label: 'Departure Time',   expr: 'punch_out',  isAgg: false },
  { label: 'Hours Worked',     expr: 'work_hours', isAgg: false },
  { label: 'Late?',            expr: 'is_late',    isAgg: false },
  { label: 'Left Early?',      expr: 'left_early', isAgg: false },
  // Aggregates
  { label: '# Records',        expr: 'COUNT(*)',                                             isAgg: true },
  { label: '# Days Present',   expr: "SUM(CASE WHEN status='PRESENT' THEN 1 ELSE 0 END)",   isAgg: true },
  { label: '# Days Absent',    expr: "SUM(CASE WHEN status='ABSENT' THEN 1 ELSE 0 END)",    isAgg: true },
  { label: '# Late Days',      expr: 'SUM(is_late)',                                         isAgg: true },
  { label: 'Total Hours',      expr: 'SUM(work_hours)',                                      isAgg: true },
  { label: 'Avg Hours/Day',    expr: 'ROUND(AVG(work_hours),2)',                             isAgg: true },
  { label: 'Earliest Arrival', expr: 'MIN(punch_in)',                                        isAgg: true },
  { label: 'Latest Arrival',   expr: 'MAX(punch_in)',                                        isAgg: true },
];
var GROUPBY_FIELDS = [
  { label: 'Employee Name', expr: 'emp_name' },
  { label: 'Employee ID',   expr: 'emp_code' },
  { label: 'Date',          expr: 'work_date' },
  { label: 'Status',        expr: 'status' },
  { label: 'Month',         expr: "strftime('%Y-%m', work_date)" },
  { label: 'Year',          expr: "strftime('%Y', work_date)" },
  { label: 'Late?',         expr: 'is_late' },
];

function populateAggDropdowns() {
  var sel  = document.getElementById('select-add');
  var grp  = document.getElementById('groupby-add');
  if (!sel || !grp) return;
  sel.innerHTML = '<option value="">+ Add field or aggregate…</option>';
  var plain = [], agg = [];
  SELECT_FIELDS.forEach(function(f) { (f.isAgg ? agg : plain).push(f); });
  if (plain.length) {
    var og1 = document.createElement('optgroup'); og1.label = 'Regular Fields';
    plain.forEach(function(f) { var o = new Option(f.label, f.label); og1.appendChild(o); });
    sel.appendChild(og1);
  }
  if (agg.length) {
    var og2 = document.createElement('optgroup'); og2.label = 'Aggregates';
    agg.forEach(function(f) { var o = new Option(f.label, f.label); og2.appendChild(o); });
    sel.appendChild(og2);
  }
  grp.innerHTML = '<option value="">+ Add group field…</option>';
  GROUPBY_FIELDS.forEach(function(f) {
    var o = new Option(f.label, f.label); grp.appendChild(o);
  });
}

function addSelectField(select) {
  var label = select.value; if (!label) return; select.value = '';
  if (State.selectFields.find(function(f){ return f.label === label; })) { toast('Already added: ' + label, 'info'); return; }
  var def = SELECT_FIELDS.find(function(f){ return f.label === label; });
  if (!def) return;
  State.selectFields.push({ label: def.label, expr: def.expr, isAgg: def.isAgg });
  renderSelectPills();
  checkConflict();
  updateFilterSQL();
}

function addGroupByField(select) {
  var label = select.value; if (!label) return; select.value = '';
  if (State.groupByFields.find(function(f){ return f.label === label; })) { toast('Already grouped by: ' + label, 'info'); return; }
  var def = GROUPBY_FIELDS.find(function(f){ return f.label === label; });
  if (!def) return;
  State.groupByFields.push({ label: def.label, expr: def.expr });
  renderGroupByPills();
  checkConflict();
  updateFilterSQL();
}

function renderSelectPills() {
  var area = document.getElementById('select-pills');
  if (!area) return;
  area.innerHTML = '';
  State.selectFields.forEach(function(f) {
    var pill = document.createElement('span');
    pill.className = 'pill' + (f.isAgg ? ' pill-agg' : '');
    pill.innerHTML = escHtml(f.label) + ' <button onclick="removeSelectField(\'' + escHtml(f.label) + '\')">×</button>';
    area.appendChild(pill);
  });
}

function renderGroupByPills() {
  var area = document.getElementById('groupby-pills');
  if (!area) return;
  area.innerHTML = '';
  State.groupByFields.forEach(function(f) {
    var pill = document.createElement('span');
    pill.className = 'pill pill-group';
    pill.innerHTML = escHtml(f.label) + ' <button onclick="removeGroupByField(\'' + escHtml(f.label) + '\')">×</button>';
    area.appendChild(pill);
  });
}

function removeSelectField(label) {
  State.selectFields = State.selectFields.filter(function(f){ return f.label !== label; });
  renderSelectPills(); checkConflict(); updateFilterSQL();
}
function removeGroupByField(label) {
  State.groupByFields = State.groupByFields.filter(function(f){ return f.label !== label; });
  renderGroupByPills(); checkConflict(); updateFilterSQL();
}

function clearHaving() {
  var v = document.getElementById('having-val');
  if (v) v.value = '';
  checkConflict(); updateFilterSQL();
}

function checkConflict() {
  var grpExprs = State.groupByFields.map(function(f){ return f.expr; });
  var hasAgg = State.selectFields.some(function(f){ return f.isAgg; });
  var conflict = false;
  if (grpExprs.length > 0 && hasAgg) {
    var grpSet = {};
    grpExprs.forEach(function(e){ grpSet[e.trim()] = true; });
    State.selectFields.forEach(function(f) {
      if (!f.isAgg && !grpSet[f.expr.trim()]) conflict = true;
    });
  }
  var note = document.getElementById('conflict-note');
  if (note) note.classList[conflict ? 'remove' : 'add']('hidden');
  return conflict;
}

function getHaving() {
  var agg = (document.getElementById('having-agg') || {}).value || '';
  var op  = (document.getElementById('having-op')  || {}).value || '>';
  var val = (document.getElementById('having-val') || {}).value || '';
  if (!agg || !val || val === '') return '';
  var grps = State.groupByFields;
  if (!grps.length) return '';
  return agg + ' ' + op + ' ' + val;
}

function toggleAggSection() {
  var sec  = document.getElementById('agg-section');
  var icon = document.getElementById('agg-toggle-icon');
  if (!sec) return;
  var hidden = sec.classList.toggle('hidden');
  if (icon) icon.textContent = hidden ? '▶' : '▼';
}

/* ── ZOOM ───────────────────────────────────────────────────── */
var ZOOM_MIN = 0.7, ZOOM_MAX = 2.0, ZOOM_DEFAULT = 1.3, ZOOM_STEP = 0.1;
function getCurrentZoom() { return parseFloat(memGet('ap_zoom', ZOOM_DEFAULT)); }
function setZoom(z) {
  z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
  document.documentElement.style.zoom = String(z);
  var lbl = document.getElementById('zoom-label');
  if (lbl) lbl.textContent = Math.round(z * 100) + '%';
  memSet('ap_zoom', z);
  apiCall('save_settings', { ap_zoom: String(z) }).catch(function(){});
}
function adjustZoom(delta) { setZoom(getCurrentZoom() + delta); }
function resetZoom() { setZoom(ZOOM_DEFAULT); }
function initZoom() {
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

/* ── RESIZABLE PANELS ───────────────────────────────────────── */
function loadPanelWidths() {
  var raw = memGet('ap_panels', null);
  if (!raw) return;
  try {
    var saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
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
    startX = e.clientX; startW = panel.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none'; document.body.style.cursor = 'col-resize';
    function onMove(ev) {
      var dx = ev.clientX - startX;
      var nw = side === 'left' ? startW + dx : startW - dx;
      var mn = parseInt(panel.style.minWidth || '220', 10);
      var mx = parseInt(panel.style.maxWidth || '560', 10);
      panel.style.width = Math.max(mn, Math.min(mx, nw)) + 'px';
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.style.userSelect = ''; document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      savePanelWidths();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/* ── TOAST ──────────────────────────────────────────────────── */
var _toastTimer = null;
function toast(msg, type) {
  var el = document.getElementById('toast');
  if (!el) return;
  var bg = { info:'var(--text-head)', ok:'var(--ok)', error:'var(--danger)', warning:'var(--warn)' }[type] || 'var(--text-head)';
  el.style.background = bg; el.style.color = type === 'warning' ? '#000' : 'var(--text-inv)';
  el.textContent = msg; el.classList.remove('hidden', 'fade-out');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() { el.classList.add('fade-out'); setTimeout(function(){ el.classList.add('hidden'); }, 320); }, 3200);
}

/* ── MODAL ──────────────────────────────────────────────────── */
function openModal(id) {
  closeModal(); State.activeModal = id;
  var bd = document.getElementById('modal-backdrop'), m = document.getElementById(id);
  if (bd) bd.classList.remove('hidden');
  if (m)  m.classList.remove('hidden');
  if (id === 'modal-settings') { var t = document.querySelector('.settings-tab'); if(t) switchSettingsTab(t,'general'); }
}
function closeModal() {
  if (State.activeModal) { var m = document.getElementById(State.activeModal); if(m) m.classList.add('hidden'); State.activeModal = null; }
  var bd = document.getElementById('modal-backdrop'); if (bd) bd.classList.add('hidden');
}

/* ── DB STATUS ──────────────────────────────────────────────── */
function refreshDbStatus() {
  return apiCall('get_db_status').then(function(data) {
    var el = document.getElementById('db-status');
    if (!el) return;
    if (data && data.min_date) {
      el.textContent = data.min_date + ' → ' + data.max_date;
      var qf = document.getElementById('quick-from'); if (qf) qf.value = data.min_date;
      var qt = document.getElementById('quick-to');   if (qt) qt.value = data.max_date;
    } else { el.textContent = 'no data'; }
  }).catch(function(){});
}

/* ── SETTINGS ───────────────────────────────────────────────── */
function switchSettingsTab(btn, tabName) {
  if (!btn) return;
  document.querySelectorAll('.settings-tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('.settings-tab-body').forEach(function(t){ t.classList.add('hidden'); });
  btn.classList.add('active');
  var tab = document.getElementById('tab-' + tabName);
  if (tab) tab.classList.remove('hidden');
  if (tabName === 'theme')    buildThemeGrid();
  if (tabName === 'querylog') loadQueryLog();
}
function openSettings() {
  apiCall('get_settings').then(function(s) {
    State.settings = s || {};
    var set = function(id, k){ var el = document.getElementById(id); if(el) el.value = s[k] || ''; };
    set('s-checkin','checkin_time'); set('s-checkout','checkout_time');
    set('s-late','late_threshold'); set('s-early','early_leave_threshold');
    set('s-wdays','working_days_per_month'); set('s-org-name','org_name');
    var logo = s.org_logo_b64 || '';
    State.orgLogo = logo || null; updateLogoPreview(logo);
  }).catch(function(e){ toast('Failed to load settings: ' + e.message, 'error'); });
  openModal('modal-settings');
}
function updateLogoPreview(b64) {
  var pv = document.getElementById('logo-preview'), img = document.getElementById('logo-img');
  if (!pv || !img) return;
  if (b64) { img.src = 'data:image/png;base64,' + b64; pv.classList.remove('hidden'); }
  else { pv.classList.add('hidden'); img.src = ''; }
}
function pickLogo() {
  apiCall('open_file_dialog_type', 'image').then(function(path) {
    if (!path) return null;
    return apiCall('read_file_as_b64', path);
  }).then(function(b64) {
    if (!b64) return;
    State.orgLogo = b64; updateLogoPreview(b64);
  }).catch(function(e){ toast('Could not load logo: ' + e.message, 'error'); });
}
function clearLogo() { State.orgLogo = null; updateLogoPreview(null); }
function saveSettings() {
  var tr = /^\d{1,2}:\d{2}$/;
  var ci = ((document.getElementById('s-checkin') ||{}).value||'').trim();
  var co = ((document.getElementById('s-checkout')||{}).value||'').trim();
  var lt = ((document.getElementById('s-late')    ||{}).value||'').trim();
  var el = ((document.getElementById('s-early')   ||{}).value||'').trim();
  var wd = ((document.getElementById('s-wdays')   ||{}).value||'26').trim();
  var on = ((document.getElementById('s-org-name')||{}).value||'').trim();
  var fields = [[ci,'Check-in'],[co,'Check-out'],[lt,'Late'],[el,'Early']];
  for (var i=0;i<fields.length;i++) { if (!tr.test(fields[i][0])) { toast(fields[i][1]+' must be HH:MM','error'); return; } }
  var payload = { checkin_time:ci, checkout_time:co, late_threshold:lt, early_leave_threshold:el,
                  working_days_per_month:wd, org_name:on, org_logo_b64: State.orgLogo||'' };
  apiCall('save_settings', payload).then(function() {
    State.settings = Object.assign({}, State.settings, payload);
    refreshThreshDisplay(); updateOrgBranding(); closeModal(); toast('Settings saved.','ok');
  }).catch(function(e){ toast('Save failed: '+e.message,'error'); });
}
function refreshThreshDisplay() {
  var s = State.settings, el = document.getElementById('thresh-display');
  if (!el) return;
  el.innerHTML = '<div>check-in <span style="color:var(--text-body)">'+(s.checkin_time||'—')+'</span></div>'+
    '<div>check-out <span style="color:var(--text-body)">'+(s.checkout_time||'—')+'</span></div>'+
    '<div>late &gt; <span style="color:var(--text-body)">'+(s.late_threshold||'—')+'</span></div>'+
    '<div>early &lt; <span style="color:var(--text-body)">'+(s.early_leave_threshold||'—')+'</span></div>'+
    '<div>work days <span style="color:var(--text-body)">'+(s.working_days_per_month||'26')+'</span>/mo</div>';
}
function updateOrgBranding() {
  var name = (State.settings && State.settings.org_name) || '';
  var el   = document.getElementById('org-name-display');
  if (!el) return;
  if (name) { el.textContent = name; el.classList.remove('hidden'); } else el.classList.add('hidden');
}

/* ── QUERY LOG ──────────────────────────────────────────────── */
function loadQueryLog() {
  var c = document.getElementById('query-log-list');
  if (!c) return;
  apiCall('get_query_log').then(function(logs) {
    if (!logs || !logs.length) { c.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;color:var(--text-dim)">No queries logged yet.</div>'; return; }
    c.innerHTML = '';
    logs.forEach(function(log) {
      var row = document.createElement('div'); row.className = 'qlog-row';
      var time = (log.ran_at || '').slice(0,16).replace('T',' ');
      row.innerHTML = '<div class="qlog-sql">'+escHtml(log.sql_text)+'</div>'+
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">'+
        '<span class="qlog-meta">'+time+'<br>'+(log.row_count||0)+' rows</span>'+
        '<button class="qlog-copy" onclick="copyToClipboard('+JSON.stringify(log.sql_text)+')">Copy</button></div>';
      c.appendChild(row);
    });
  }).catch(function(e){ c.innerHTML = '<div style="padding:10px;color:var(--danger);font-size:11px">'+escHtml(e.message)+'</div>'; });
}
function clearQueryLog() {
  apiCall('clear_query_log').then(function(){ loadQueryLog(); toast('Query log cleared.','ok'); }).catch(function(e){ toast(e.message,'error'); });
}
function copyToClipboard(text) {
  try {
    var ta = document.createElement('textarea'); ta.value = text;
    ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    toast('Copied to clipboard','ok');
  } catch(e){ toast('Copy failed: '+e.message,'error'); }
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── IMPORT ─────────────────────────────────────────────────── */
var _selectedFilePath = null;
function browseFile() {
  apiCall('open_file_dialog').then(function(path){ if (path) setSelectedFile(path); }).catch(function(e){ toast('File picker error: '+e.message,'error'); });
}
function setSelectedFile(path, isAutoLoad) {
  _selectedFilePath = path;
  var name = path.replace(/\\/g,'/').split('/').pop();
  var fn   = document.getElementById('import-filename');
  var btn  = document.getElementById('btn-import');
  var ri   = document.getElementById('btn-reimport');
  if (fn)  fn.textContent = name + (isAutoLoad ? ' (last session — click Import ▶ to reload)' : '');
  if (btn) btn.disabled = false;
  if (ri)  ri.classList.toggle('hidden', !isAutoLoad);
}
function triggerImport() {
  if (!_selectedFilePath) return;
  var name = _selectedFilePath.replace(/\\/g,'/').split('/').pop();
  apiCall('check_already_imported', name).then(function(existing) {
    if (existing) {
      var msg = document.getElementById('overwrite-msg');
      if (msg) msg.innerHTML = '<strong>'+escHtml(name)+'</strong> was imported on '+(existing.imported_at||'').slice(0,10)+' ('+( existing.rows_imported||'?')+' records).';
      State.pendingFile = _selectedFilePath; openModal('modal-overwrite');
    } else { doImport(_selectedFilePath, false); }
  }).catch(function(e){ toast('Error: '+e.message,'error'); });
}
function confirmImport(overwrite) { closeModal(); if (State.pendingFile) { doImport(State.pendingFile, overwrite); State.pendingFile = null; } }
function doImport(filepath, overwrite) {
  var prog = document.getElementById('import-progress'), btnI = document.getElementById('btn-import'), st = document.getElementById('import-status');
  if (prog) prog.classList.remove('hidden');
  if (btnI) btnI.disabled = true;
  setSqlStatus('Parsing file…', 'info');
  apiCall('import_file', filepath, overwrite).then(function(r) {
    if (prog) prog.classList.add('hidden'); if (btnI) btnI.disabled = false;
    if (st) { st.textContent = '✓ '+r.inserted+' records · '+r.employees+' employees · '+r.period_start+'→'+r.period_end; st.style.color='var(--ok)'; }
    refreshDbStatus(); toast('Import complete: '+r.inserted+' records.', 'ok');
    if (r.employee_diff) showEmployeeDiff(r.employee_diff);
    if (r.warnings && r.warnings.length) toast('⚠ '+r.warnings.length+' warning(s): '+r.warnings[0], 'warning');
  }).catch(function(e) {
    if (prog) prog.classList.add('hidden'); if (btnI) btnI.disabled = false;
    if (st) { st.textContent = '✗ '+e.message; st.style.color='var(--danger)'; }
    toast('Import failed: '+e.message, 'error');
  });
}
function showEmployeeDiff(diff) {
  var added = diff.added||[], removed = diff.removed||[];
  if (!added.length && !removed.length) return;
  var html = '';
  if (added.length) html += '<strong>'+added.length+' new employee'+(added.length>1?'s':'')+' detected:</strong> '+added.slice(0,3).join(', ')+(added.length>3?' +'+(added.length-3)+' more':'')+'. <button style="text-decoration:underline;font-weight:600;background:none;border:none;cursor:pointer;color:inherit" onclick="openEmployees()">Add details →</button>  ';
  if (removed.length) html += '<strong>'+removed.length+' employee'+(removed.length>1?'s':'')+' no longer in file:</strong> '+removed.slice(0,3).join(', ')+(removed.length>3?' +'+(removed.length-3)+' more':'');
  var te = document.getElementById('emp-diff-text'), bn = document.getElementById('emp-diff-banner');
  if (te) te.innerHTML = html; if (bn) bn.classList.remove('hidden');
}
function handleDragOver(e) { e.preventDefault(); var dz=document.getElementById('drop-zone'); if(dz) dz.classList.add('drag-over'); }
function handleDragLeave() { var dz=document.getElementById('drop-zone'); if(dz) dz.classList.remove('drag-over'); }
function handleDrop(e) {
  e.preventDefault(); var dz=document.getElementById('drop-zone'); if(dz) dz.classList.remove('drag-over');
  var files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length > 0) { var f=files[0], path=f.path||f.name; if(/\.(xls|xlsx|xlsm)$/i.test(path)) setSelectedFile(path); else toast('Please drop an Excel file (.xls / .xlsx)','error'); }
}

/* ── FILTER BUILDER ─────────────────────────────────────────── */
var FIELDS = [
  { label:'Employee Name',  col:'emp_name',   cat:'text',   ops:['contains','equals','starts with','ends with','not equals'] },
  { label:'Employee ID',    col:'emp_code',   cat:'text',   ops:['equals','contains'] },
  { label:'Date',           col:'work_date',  cat:'date',   ops:['on','before','after','on or before','on or after','between'] },
  { label:'Status',         col:'status',     cat:'status', ops:['is','is not'], opts:['PRESENT','ABSENT','WEEKLY_OFF','HALF_DAY'] },
  { label:'Arrival Time',   col:'punch_in',   cat:'time',   ops:['before','after','equals'] },
  { label:'Departure Time', col:'punch_out',  cat:'time',   ops:['before','after','equals'] },
  { label:'Hours Worked',   col:'work_hours', cat:'number', ops:['greater than','less than','equals','at least','at most'] },
  { label:'Arrived Late?',  col:'is_late',    cat:'bool',   ops:['is'], opts:['Yes','No'] },
  { label:'Left Early?',    col:'left_early', cat:'bool',   ops:['is'], opts:['Yes','No'] },
];

var _filterRows = [], _filterIdCounter = 0;

function addFilterRow() {
  var id=++_filterIdCounter, isFirst=_filterRows.length===0, field=FIELDS[0];
  _filterRows.push({id:id, field:field.label, op:field.ops[0], value:'', value2:'', joiner:'AND'});
  var c=document.getElementById('filter-rows'); if(!c) return;
  var row=document.createElement('div'); row.className='filter-row'; row.dataset.id=id;
  row.innerHTML=renderFilterRow(id, isFirst, field);
  c.appendChild(row); bindFilterRow(row, id); updateFilterSQL();
}

function renderFilterRow(id, isFirst, field) {
  var joiner = isFirst
    ? '<span style="font-size:10px;color:var(--text-dim);flex-shrink:0;width:34px;text-align:center">WHERE</span>'
    : '<button class="joiner-pill active" data-id="'+id+'">AND</button>';
  var fo = FIELDS.map(function(f){ return '<option value="'+f.label+'"'+(f.label===field.label?' selected':'')+'>'+f.label+'</option>'; }).join('');
  var oo = field.ops.map(function(o){ return '<option value="'+o+'">'+o+'</option>'; }).join('');
  return joiner+
    '<select class="field-sel" style="width:100px;flex-shrink:0" data-id="'+id+'">'+fo+'</select>'+
    '<select class="op-sel"    style="width:85px;flex-shrink:0" data-id="'+id+'">'+oo+'</select>'+
    '<div class="value-wrap"   style="flex:1;display:flex;gap:3px;min-width:0" data-id="'+id+'">'+buildValueHTML(id,field,field.ops[0])+'</div>'+
    '<button class="remove-filter" data-id="'+id+'">✕</button>';
}

function buildValueHTML(id, field, op) {
  var today=new Date().toISOString().slice(0,10);
  if (field.opts) return '<select class="val-inp" data-id="'+id+'" style="flex:1">'+field.opts.map(function(o){ return '<option>'+o+'</option>'; }).join('')+'</select>';
  if (field.cat==='date') {
    if (op==='between') return '<input class="val-inp" data-id="'+id+'" type="text" value="'+today+'" style="flex:1;min-width:70px" placeholder="YYYY-MM-DD">'+
      '<span style="font-size:10px;color:var(--text-dim);flex-shrink:0">to</span>'+
      '<input class="val2-inp" data-id="'+id+'" type="text" value="'+today+'" style="flex:1;min-width:70px" placeholder="YYYY-MM-DD">';
    return '<input class="val-inp" data-id="'+id+'" type="text" value="'+today+'" style="flex:1" placeholder="YYYY-MM-DD">';
  }
  if (field.cat==='time')   return '<input class="val-inp" data-id="'+id+'" type="text" value="09:00" style="flex:1;max-width:70px" placeholder="HH:MM">';
  if (field.cat==='number') return '<input class="val-inp" data-id="'+id+'" type="number" value="6" style="flex:1;max-width:70px">';
  return '<input class="val-inp" data-id="'+id+'" type="text" style="flex:1" placeholder="Search…">';
}

function bindFilterRow(row, id) {
  var joinerBtn = row.querySelector('.joiner-pill');
  if (joinerBtn) joinerBtn.addEventListener('click', function() {
    var fr=_filterRows.find(function(r){ return r.id===id; }); if(!fr) return;
    fr.joiner = fr.joiner==='AND'?'OR':'AND';
    joinerBtn.textContent=fr.joiner; joinerBtn.classList.toggle('active', fr.joiner==='AND');
    updateFilterSQL();
  });
  var fieldSel = row.querySelector('.field-sel');
  if (fieldSel) fieldSel.addEventListener('change', function() {
    var fr=_filterRows.find(function(r){ return r.id===id; }); if(!fr) return;
    fr.field=fieldSel.value; fr.value=''; fr.value2='';
    var field=FIELDS.find(function(f){ return f.label===fr.field; }); fr.op=field.ops[0];
    var op=row.querySelector('.op-sel'); if(op){ op.innerHTML=field.ops.map(function(o){ return '<option value="'+o+'">'+o+'</option>'; }).join(''); op.value=fr.op; }
    var vw=row.querySelector('.value-wrap'); if(vw) vw.innerHTML=buildValueHTML(id,field,fr.op);
    bindValueEvents(row,id); updateFilterSQL();
  });
  var opSel = row.querySelector('.op-sel');
  if (opSel) opSel.addEventListener('change', function() {
    var fr=_filterRows.find(function(r){ return r.id===id; }); if(!fr) return;
    fr.op=opSel.value;
    var field=FIELDS.find(function(f){ return f.label===fr.field; });
    var vw=row.querySelector('.value-wrap'); if(vw) vw.innerHTML=buildValueHTML(id,field,fr.op);
    bindValueEvents(row,id); updateFilterSQL();
  });
  bindValueEvents(row, id);
  var removeBtn = row.querySelector('.remove-filter');
  if (removeBtn) removeBtn.addEventListener('click', function(){ row.remove(); _filterRows=_filterRows.filter(function(r){ return r.id!==id; }); updateFilterSQL(); });
}
function bindValueEvents(row, id) {
  row.querySelectorAll('.val-inp,.val2-inp').forEach(function(el) {
    el.addEventListener('input', function() {
      var fr=_filterRows.find(function(r){ return r.id===id; }); if(!fr) return;
      if(el.classList.contains('val-inp'))  fr.value  = el.value;
      if(el.classList.contains('val2-inp')) fr.value2 = el.value;
      updateFilterSQL();
    });
  });
}
function clearFilters() {
  var c=document.getElementById('filter-rows'); if(c) c.innerHTML='';
  _filterRows=[]; _filterIdCounter=0;
  State.selectFields=[]; State.groupByFields=[];
  renderSelectPills(); renderGroupByPills(); checkConflict();
  var hv=document.getElementById('having-val'); if(hv) hv.value='';
  addFilterRow();
}
function buildFiltersPayload() {
  return _filterRows.map(function(fr){ return {field:fr.field, operator:fr.op, value:fr.value, value2:fr.value2||'', joiner:fr.joiner}; });
}

/* ── SQL preview with REAL values (no ?) ───────────────────── */
var OP_SQL = {
  'contains':     function(c,v){ return "LOWER("+c+") LIKE LOWER('%"+v+"%')"; },
  'equals':       function(c,v){ return "LOWER("+c+") = LOWER('"+v+"')"; },
  'starts with':  function(c,v){ return "LOWER("+c+") LIKE LOWER('"+v+"%')"; },
  'ends with':    function(c,v){ return "LOWER("+c+") LIKE LOWER('%"+v+"')"; },
  'not equals':   function(c,v){ return "LOWER("+c+") != LOWER('"+v+"')"; },
  'on':           function(c,v){ return c+" = '"+v+"'"; },
  'before':       function(c,v){ return c+" < '"+v+"'"; },
  'after':        function(c,v){ return c+" > '"+v+"'"; },
  'on or before': function(c,v){ return c+" <= '"+v+"'"; },
  'on or after':  function(c,v){ return c+" >= '"+v+"'"; },
  'between':      function(c,v,v2){ return c+" BETWEEN '"+v+"' AND '"+v2+"'"; },
  'greater than': function(c,v){ return c+" > "+v; },
  'less than':    function(c,v){ return c+" < "+v; },
  'at least':     function(c,v){ return c+" >= "+v; },
  'at most':      function(c,v){ return c+" <= "+v; },
  'is':           function(c,v){ return c+" = '"+(v==='Yes'?'1':v==='No'?'0':v.toUpperCase())+"'"; },
  'is not':       function(c,v){ return c+" != '"+v.toUpperCase()+"'"; },
};

function updateFilterSQL() {
  try {
    var sortCol = (document.getElementById('sort-col')||{}).value||'work_date';
    var sortDir = (document.getElementById('sort-dir')||{}).value||'ASC';
    var lim     = (document.getElementById('result-limit')||{}).value||'5000';
    var having  = getHaving();

    /* SELECT clause */
    var selParts;
    if (State.selectFields.length > 0) {
      selParts = State.selectFields.map(function(f){ return '  '+f.expr+' AS "'+f.label+'"'; });
    } else {
      selParts = [
        '  emp_code, emp_name, work_date, status,',
        '  punch_in AS "In", punch_out AS "Out",',
        '  work_hours AS "Hours", is_late AS "Late", left_early AS "Left Early"'
      ];
    }

    /* WHERE clause */
    var whereParts = [];
    _filterRows.forEach(function(fr, i) {
      var field = FIELDS.find(function(fd){ return fd.label===fr.field; });
      if (!field || !fr.value && fr.op!=='between') return;
      var fn = OP_SQL[fr.op]; if (!fn) return;
      var clause = fn(field.col, fr.value||'', fr.value2||'');
      whereParts.push((i===0?'WHERE ':'  '+(fr.joiner||'AND')+' ')+clause);
    });

    /* GROUP BY */
    var grpParts = State.groupByFields.length
      ? ['GROUP BY '+State.groupByFields.map(function(f){ return f.expr; }).join(', ')]
      : [];

    /* HAVING */
    var havingParts = (having && State.groupByFields.length) ? ['HAVING '+having] : [];

    /* ORDER BY (skip if grouped) */
    var orderParts = (!State.groupByFields.length) ? ['ORDER BY '+sortCol+' '+sortDir] : [];
    var limitParts = ['LIMIT '+lim];

    var lines = ['SELECT'].concat(selParts).concat(['FROM attendance_raw']).concat(whereParts).concat(grpParts).concat(havingParts).concat(orderParts).concat(limitParts);
    var sql = lines.join('\n');
    State.lastSqlDisplay = sql;
    setSqlEditor(sql);
  } catch(e) {}
}

/* ── RUN FILTER ─────────────────────────────────────────────── */
function runFilter() {
  var filters   = JSON.stringify(buildFiltersPayload());
  var sc        = (document.getElementById('sort-col')||{}).value||'work_date';
  var sd        = (document.getElementById('sort-dir')||{}).value||'ASC';
  var lim       = parseInt((document.getElementById('result-limit')||{}).value||'5000', 10);
  var selExprs  = JSON.stringify(State.selectFields.map(function(f){ return f.expr; }));
  var selLabels = JSON.stringify(State.selectFields.map(function(f){ return f.label; }));
  var selIsAgg  = JSON.stringify(State.selectFields.map(function(f){ return f.isAgg; }));
  var grpExprs  = JSON.stringify(State.groupByFields.map(function(f){ return f.expr; }));
  var having    = getHaving();

  setSqlStatus('Running…', 'info');
  apiCall('run_filter', filters, sc, sd, lim, selExprs, selLabels, selIsAgg, grpExprs, having).then(function(res) {
    // Update SQL with server-generated display SQL
    if (res.sql) { State.lastSqlDisplay = res.sql; setSqlEditor(res.sql); }

    if (res.mode === 'dual') {
      setSqlStatus('⚡ Dual-table mode: '+res.summary.count+' summary rows, '+res.detail.count+' detail rows', 'warning');
      showDualResults(res);
    } else {
      setSqlStatus('✓ '+res.count+' records', 'ok');
      showResults(res.columns, res.rows, 'Search Results');
    }
  }).catch(function(e){ setSqlStatus('✗ '+e.message,'error'); toast(e.message,'error'); });
}

/* ── SQL PANEL ──────────────────────────────────────────────── */
function setSqlEditor(sql) {
  var ta=document.getElementById('sql-editor'); if(ta) ta.value=sql;
  updateLineNumbers('sql-editor','sql-lines');
}
function updateLineNumbers(edId, lnId) {
  var ta=document.getElementById(edId), ln=document.getElementById(lnId); if(!ta||!ln) return;
  var n=ta.value.split('\n').length, html='';
  for(var i=1;i<=n;i++) html+=i+'<br>';
  ln.innerHTML=html;
}
function setSqlStatus(msg, type) {
  var el=document.getElementById('sql-status'); if(!el) return;
  var c={info:'var(--text-dim)',ok:'var(--ok)',error:'var(--danger)',warning:'var(--warn)'}[type]||'var(--text-dim)';
  el.textContent=msg; el.style.color=c;
}
function runSql() {
  var ta=document.getElementById('sql-editor'); if(!ta) return;
  var sql=ta.value.split('\n').filter(function(l){ return !l.trim().startsWith('--'); }).join('\n').trim();
  if(!sql){ setSqlStatus('Enter a SELECT query.','error'); return; }
  State.lastSqlDisplay = sql;
  setSqlStatus('Running…','info');
  apiCall('run_sql', sql).then(function(res){
    setSqlStatus('✓ '+res.count+' records','ok');
    showResults(res.columns, res.rows, 'Query Results');
  }).catch(function(e){ setSqlStatus('✗ '+e.message,'error'); toast(e.message,'error'); });
}
function clearSql() { var ta=document.getElementById('sql-editor'); if(ta) ta.value=''; updateLineNumbers('sql-editor','sql-lines'); setSqlStatus(''); }

/* ── SCHEMA ─────────────────────────────────────────────────── */
var SCHEMA = [
  {table:'attendance_raw', cols:[['emp_code','TEXT','Employee ID'],['emp_name','TEXT','Name from file'],['work_date','DATE','YYYY-MM-DD'],['status','TEXT','PRESENT|ABSENT|WEEKLY_OFF|HALF_DAY'],['punch_in','TEXT','HH:MM arrival'],['punch_out','TEXT','HH:MM departure'],['work_hours','REAL','Decimal hours'],['is_late','INTEGER','1=late'],['left_early','INTEGER','1=left early'],['report_file','TEXT','Source file'],['company_name','TEXT','School/org']]},
  {table:'employee_salary',cols:[['emp_code','TEXT','PK'],['emp_name_override','TEXT','Admin full name'],['monthly_salary','REAL','₹/month'],['daily_rate','REAL','Auto'],['working_days','INTEGER','Days/month']]},
  {table:'import_log',     cols:[['filename','TEXT','Imported file'],['imported_at','DATETIME','Timestamp'],['rows_imported','INTEGER','Records'],['period_start','DATE','From'],['period_end','DATE','To']]},
];
var EXAMPLES = [
  "SELECT * FROM attendance_raw\nWHERE LOWER(emp_name) LIKE '%anita%'",
  "SELECT emp_name, COUNT(*) AS absent\nFROM attendance_raw WHERE status='ABSENT'\nGROUP BY emp_code ORDER BY absent DESC",
  "SELECT emp_name, SUM(is_late) AS late_days\nFROM attendance_raw\nGROUP BY emp_code\nHAVING SUM(is_late) > 2",
];
function buildSchemaContent(c) {
  if(!c) return; c.innerHTML='';
  SCHEMA.forEach(function(s){
    var b=document.createElement('span'); b.className='schema-table-badge'; b.textContent=s.table; c.appendChild(b);
    s.cols.forEach(function(col){
      var r=document.createElement('div'); r.className='schema-col-row';
      r.innerHTML='<span class="schema-col-name">'+col[0]+'</span><span class="schema-col-type type-'+col[1]+'">'+col[1]+'</span><span class="schema-col-hint">'+col[2]+'</span>';
      c.appendChild(r);
    });
  });
  var eb=document.createElement('span'); eb.className='schema-table-badge'; eb.style.cssText='color:var(--ok);background:var(--ok-bg)'; eb.textContent='examples'; c.appendChild(eb);
  EXAMPLES.forEach(function(ex){
    var pre=document.createElement('pre'); pre.style.cssText='font-size:9px;color:var(--text-mid);padding:3px 8px;cursor:pointer;border-radius:3px;white-space:pre-wrap;transition:background 100ms'; pre.textContent=ex; pre.title='Click to insert';
    pre.addEventListener('mouseenter',function(){ pre.style.background='var(--bg-muted)'; });
    pre.addEventListener('mouseleave',function(){ pre.style.background=''; });
    pre.addEventListener('click',function(){ setSqlEditor(ex); toast('Query inserted','info'); });
    c.appendChild(pre);
  });
}
function toggleSchema() {
  var p=document.getElementById('schema-panel'), b=document.getElementById('btn-schema-toggle'); if(!p) return;
  var h=p.classList.toggle('hidden');
  if(b) b.textContent=h?'📋 Schema':'✕ Schema';
  if(!h && !p.children.length) buildSchemaContent(p);
}

/* ── RESULTS GRID ───────────────────────────────────────────── */
function showResults(columns, rows, title) {
  State.results={columns:columns, rows:rows.slice(), title:title||'Results'};
  State.dualResults = null;
  State.sortCol=null; State.sortAsc=true;

  // Switch to single view
  var s=document.getElementById('results-single'), d=document.getElementById('results-dual');
  if(s) s.classList.remove('hidden'); if(d) d.classList.add('hidden');

  renderGrid();
  var rt=document.getElementById('results-title'); if(rt) rt.textContent=title||'Results';
  var rc=document.getElementById('results-count'); if(rc) rc.textContent='— '+rows.length.toLocaleString()+' record'+(rows.length!==1?'s':'');
  var ec=document.getElementById('btn-export-csv'), ep=document.getElementById('btn-export-pdf');
  if(ec) ec.disabled=!rows.length; if(ep) ep.disabled=!rows.length;
}

function renderGrid() {
  var cols=State.results.columns, rows=State.results.rows;
  var hd=document.getElementById('results-head'), bd=document.getElementById('results-body'), em=document.getElementById('results-empty');
  if(!hd||!bd) return; hd.innerHTML=''; bd.innerHTML='';
  if(!cols||!cols.length){ if(em) em.classList.remove('hidden'); return; }
  if(em) em.classList.add('hidden');
  var tr=document.createElement('tr');
  cols.forEach(function(col){
    var th=document.createElement('th'); th.textContent=col;
    if(col===State.sortCol) th.className=State.sortAsc?'sort-asc':'sort-desc';
    th.addEventListener('click',function(){ sortGrid(col); }); tr.appendChild(th);
  }); hd.appendChild(tr);
  var frag=document.createDocumentFragment();
  rows.forEach(function(row){
    var tr2=document.createElement('tr');
    cols.forEach(function(col){
      var td=document.createElement('td'), val=(row[col]!==undefined&&row[col]!==null)?row[col]:'';
      if(col.toLowerCase()==='status'){ var sp=document.createElement('span'); sp.className='status-'+String(val).toUpperCase().replace(/ /g,'_'); sp.textContent=val; td.appendChild(sp); }
      else td.textContent=val;
      tr2.appendChild(td);
    }); frag.appendChild(tr2);
  }); bd.appendChild(frag);
}

function sortGrid(col) {
  State.sortAsc=(State.sortCol===col)?!State.sortAsc:true; State.sortCol=col;
  State.results.rows.sort(function(a,b){
    var va=a[col]!==null&&a[col]!==undefined?a[col]:'', vb=b[col]!==null&&b[col]!==undefined?b[col]:'';
    var na=parseFloat(String(va).replace(/[₹,]/g,'')), nb=parseFloat(String(vb).replace(/[₹,]/g,''));
    if(!isNaN(na)&&!isNaN(nb)) return State.sortAsc?na-nb:nb-na;
    return State.sortAsc?String(va).localeCompare(String(vb)):String(vb).localeCompare(String(va));
  }); renderGrid();
}

/* ── DUAL TABLE ─────────────────────────────────────────────── */
function showDualResults(res) {
  State.dualResults = res;
  State.results = { columns: res.detail.columns, rows: res.detail.rows, title: 'Detail' };

  var s=document.getElementById('results-single'), d=document.getElementById('results-dual');
  if(s) s.classList.add('hidden'); if(d) d.classList.remove('hidden');

  var msg=document.getElementById('conflict-msg');
  if(msg) msg.textContent = res.conflict_reason || 'Smart dual-table mode.';

  renderDualTable('summary', 'dual-summary-head', 'dual-summary-body', 'dual-summary-count', res.summary);
  renderDualTable('detail',  'dual-detail-head',  'dual-detail-body',  'dual-detail-count',  res.detail);

  var rt=document.getElementById('results-title'); if(rt) rt.textContent='Dual Results';
  var rc=document.getElementById('results-count'); if(rc) rc.textContent='— '+res.summary.count+' groups, '+res.detail.count+' records';
  var ec=document.getElementById('btn-export-csv'), ep=document.getElementById('btn-export-pdf');
  if(ec) ec.disabled=false; if(ep) ep.disabled=false;
}

function renderDualTable(which, headId, bodyId, countId, data) {
  var hd=document.getElementById(headId), bd=document.getElementById(bodyId), cnt=document.getElementById(countId);
  if(!hd||!bd) return; hd.innerHTML=''; bd.innerHTML='';
  if(cnt) cnt.textContent='— '+data.count+' row'+(data.count!==1?'s':'');
  var tr=document.createElement('tr');
  data.columns.forEach(function(col){ var th=document.createElement('th'); th.textContent=col; tr.appendChild(th); });
  hd.appendChild(tr);
  var frag=document.createDocumentFragment();
  data.rows.forEach(function(row){
    var tr2=document.createElement('tr');
    data.columns.forEach(function(col){
      var td=document.createElement('td'), val=(row[col]!==undefined&&row[col]!==null)?row[col]:'';
      if(col.toLowerCase()==='status'){ var sp=document.createElement('span'); sp.className='status-'+String(val).toUpperCase().replace(/ /g,'_'); sp.textContent=val; td.appendChild(sp); }
      else td.textContent=val;
      tr2.appendChild(td);
    }); frag.appendChild(tr2);
  }); bd.appendChild(frag);
}

function exportDualCsv(which) {
  if (!State.dualResults) return;
  var data = which === 'summary' ? State.dualResults.summary : State.dualResults.detail;
  apiCall('save_file_dialog', which+'_'+State.results.title, 'csv').then(function(path){
    if(!path) return null;
    return apiCall('export_csv', data.columns, data.rows, path);
  }).then(function(){ if(arguments[0]) toast('CSV saved.','ok'); }).catch(function(e){ toast(e.message,'error'); });
}

/* ── QUICK REPORTS ──────────────────────────────────────────── */
function runQuickReport(report, extra) {
  var from=(document.getElementById('quick-from')||{}).value||'';
  var to  =(document.getElementById('quick-to')  ||{}).value||'';
  setSqlStatus('Running…','info');
  apiCall('quick_report', report, from, to, extra||'').then(function(res){
    var titles={monthly_summary:'Monthly Summary',late:'Late Arrivals',early:'Early Leavers',absent:'Absentees',days_worked:'Days Worked',salary:'Salary Report',grid:'Full Attendance Grid',perfect:'Perfect Attendance',chronic:'Frequent Absentees (≥'+(extra||3)+')'};
    var title=(titles[report]||report)+(from?' ('+from+'→'+to+')':'');
    setSqlStatus('✓ '+res.count+' records','ok');
    showResults(res.columns, res.rows, title);
    toast((titles[report]||report)+': '+res.count+' records','ok');
  }).catch(function(e){ setSqlStatus('✗ '+e.message,'error'); toast(e.message,'error'); });
}
function runChronicReport() { var v=(document.getElementById('chronic-input')||{}).value||'3'; closeModal(); runQuickReport('chronic', v); }

/* ── CUSTOM SHORTCUTS ───────────────────────────────────────── */
function loadCustomReports() {
  var raw=memGet('ap_custom_reports', null);
  if(raw) { try{ State.customReports=typeof raw==='string'?JSON.parse(raw):raw; }catch(e){ State.customReports=[]; } } else State.customReports=[];
  renderCustomReports();
}
function saveCustomReportsToDisk() {
  var json=JSON.stringify(State.customReports);
  memSet('ap_custom_reports', json);
  apiCall('save_settings',{ap_custom_reports:json}).catch(function(){});
}
function renderCustomReports() {
  var c=document.getElementById('quick-custom'); if(!c) return;
  if(!State.customReports.length){ c.innerHTML=''; return; }
  c.innerHTML='<div class="quick-section-label mt-1">Custom</div>';
  State.customReports.forEach(function(cr){
    var o=document.createElement('div'); o.className='quick-btn custom-shortcut';
    o.innerHTML='<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escHtml((cr.icon||'📌')+' '+cr.title)+'</span>'+
      '<span class="cr-actions" style="display:none;gap:4px">'+
      '<button style="font-size:10px;color:var(--accent);background:none;border:none;cursor:pointer" data-edit="'+cr.id+'">✏</button>'+
      '<button style="font-size:10px;color:var(--danger);background:none;border:none;cursor:pointer" data-del="'+cr.id+'">✕</button></span>';
    o.addEventListener('mouseenter',function(){ var a=o.querySelector('.cr-actions'); if(a) a.style.display='flex'; });
    o.addEventListener('mouseleave',function(){ var a=o.querySelector('.cr-actions'); if(a) a.style.display='none'; });
    o.addEventListener('click',function(e){
      if(e.target.dataset.edit){ openCustomReportModal(e.target.dataset.edit); return; }
      if(e.target.dataset.del) { deleteCustomReport(e.target.dataset.del);     return; }
      runCustomReport(cr);
    }); c.appendChild(o);
  });
}
function runCustomReport(cr) {
  setSqlStatus('Running…','info');
  State.lastSqlDisplay = cr.sql;
  apiCall('run_sql', cr.sql).then(function(res){
    setSqlStatus('✓ '+res.count+' records','ok');
    showResults(res.columns, res.rows, (cr.icon||'📌')+' '+cr.title);
    toast(cr.title+': '+res.count+' records','ok');
  }).catch(function(e){ setSqlStatus('✗ '+e.message,'error'); toast(e.message,'error'); });
}
function openCustomReportModal(editId) {
  var cr=editId?State.customReports.find(function(r){ return r.id===editId; }):null;
  var te=document.getElementById('cr-title'), ic=document.getElementById('cr-icon'), sq=document.getElementById('cr-sql');
  if(te) te.value=cr?cr.title:''; if(ic) ic.value=cr?(cr.icon||'📌'):'📌';
  if(sq){ sq.value=cr?cr.sql:''; sq.dataset.editId=editId||''; }
  updateLineNumbers('cr-sql','cr-lines');
  buildSchemaContent(document.getElementById('cr-schema-ref'));
  openModal('modal-custom-report');
}
function deleteCustomReport(id){ State.customReports=State.customReports.filter(function(r){ return r.id!==id; }); saveCustomReportsToDisk(); renderCustomReports(); toast('Shortcut removed.','ok'); }
function saveCustomReport() {
  var title=((document.getElementById('cr-title')||{}).value||'').trim();
  var icon =((document.getElementById('cr-icon') ||{}).value||'📌').trim();
  var sql  =((document.getElementById('cr-sql')  ||{}).value||'').trim();
  var editId=((document.getElementById('cr-sql')||{}).dataset||{}).editId||'';
  if(!title){ toast('Please enter a report title.','error'); return; }
  if(!sql)  { toast('Please enter a SQL query.','error'); return; }
  if(editId){ var idx=State.customReports.findIndex(function(r){ return r.id===editId; }); if(idx>=0) State.customReports[idx]={id:editId,title:title,icon:icon,sql:sql}; }
  else State.customReports.push({id:Date.now().toString(),title:title,icon:icon,sql:sql});
  saveCustomReportsToDisk(); renderCustomReports(); closeModal(); toast('"'+title+'" shortcut saved.','ok');
}

/* ── EMPLOYEES ──────────────────────────────────────────────── */
function openEmployees() { openModal('modal-employees'); loadEmployees(); }
function loadEmployees() {
  apiCall('get_employees').then(function(emps){
    var tbody=document.getElementById('emp-tbody'); if(!tbody) return; tbody.innerHTML='';
    emps.forEach(function(e){
      var sal=e.monthly_salary||0, wd=e.working_days||26, dr=sal>0?(sal/wd).toFixed(2):'—', name=e.emp_name_override||'';
      var tr=document.createElement('tr');
      tr.innerHTML='<td class="tbl-head" style="font-family:monospace">'+escHtml(e.emp_code||'')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;color:var(--text-dim)">'+escHtml(e.emp_name||'')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;'+(name?'font-weight:500':'font-style:italic;color:var(--text-dim)')+'">'+escHtml(name||'not set')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;text-align:right;font-family:monospace">'+(sal?'₹'+Number(sal).toLocaleString():'—')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;text-align:center">'+wd+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;text-align:right;font-family:monospace;color:var(--text-dim)">'+(dr!=='—'?'₹'+dr:'—')+'</td>'+
        '<td style="padding:5px 8px"><button style="font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer" '+
        'data-code="'+escHtml(e.emp_code||'')+'" data-name="'+escHtml(e.emp_name||'')+'" data-override="'+escHtml(name)+'" data-sal="'+sal+'" data-wd="'+wd+'" onclick="editEmployee(this)">Edit</button></td>';
      tbody.appendChild(tr);
    });
  }).catch(function(e){ toast('Failed to load employees: '+e.message,'error'); });
}
function editEmployee(btn) {
  State.editingEmp={code:btn.dataset.code||'',name:btn.dataset.name||''};
  var er=document.getElementById('emp-edit-row'), el=document.getElementById('emp-edit-label');
  var fn=document.getElementById('emp-fullname'), sal=document.getElementById('emp-salary'), wd=document.getElementById('emp-wdays');
  if(er) er.classList.remove('hidden'); if(el) el.textContent='['+btn.dataset.code+'] '+btn.dataset.name;
  if(fn)  fn.value=btn.dataset.override||''; if(sal) sal.value=btn.dataset.sal||'0'; if(wd) wd.value=btn.dataset.wd||'26';
}
function cancelEmpEdit() { State.editingEmp=null; var er=document.getElementById('emp-edit-row'); if(er) er.classList.add('hidden'); }
function saveEmployee() {
  var emp=State.editingEmp; if(!emp) return;
  var fn=((document.getElementById('emp-fullname')||{}).value||'').trim();
  var sal=parseFloat((document.getElementById('emp-salary')||{}).value||'0')||0;
  var wdays=parseInt((document.getElementById('emp-wdays')||{}).value||'26',10)||26;
  apiCall('upsert_employee',emp.code,emp.name,fn,sal,wdays).then(function(){ cancelEmpEdit(); loadEmployees(); toast('Employee updated.','ok'); }).catch(function(e){ toast('Save failed: '+e.message,'error'); });
}

/* ── IMPORT HISTORY ─────────────────────────────────────────── */
function openHistory() {
  openModal('modal-history');
  apiCall('get_import_history').then(function(history){
    var tbody=document.getElementById('history-tbody'), empty=document.getElementById('history-empty');
    if(!tbody) return; tbody.innerHTML='';
    if(!history||!history.length){ if(empty) empty.classList.remove('hidden'); return; }
    if(empty) empty.classList.add('hidden');
    history.forEach(function(r){
      var tr=document.createElement('tr');
      tr.innerHTML='<td style="padding:5px 8px;font-size:11px;font-family:monospace">'+escHtml(r.filename||'')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;color:var(--text-dim)">'+(r.imported_at||'').slice(0,16).replace('T',' ')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;text-align:right;font-family:monospace">'+(r.rows_imported||0)+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;color:var(--text-dim)">'+(r.period_start||'')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;color:var(--text-dim)">'+(r.period_end||'')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;color:var(--text-dim)">'+escHtml(r.company_name||'')+'</td>';
      tbody.appendChild(tr);
    });
  }).catch(function(e){ toast('Could not load history: '+e.message,'error'); });
}

/* ── EXPORT ─────────────────────────────────────────────────── */
function exportCsv() {
  var cols=State.results.columns, rows=State.results.rows, title=State.results.title||'export';
  if(!rows.length){ toast('No data to export','warning'); return; }
  var def=title.replace(/[^a-z0-9]+/gi,'_').slice(0,40);
  apiCall('save_file_dialog', def, 'csv').then(function(path){
    if(!path) return null;
    return apiCall('export_csv', cols, rows, path).then(function(){ toast('CSV saved.','ok'); });
  }).catch(function(e){ toast('Export failed: '+e.message,'error'); });
}
function exportPdf() {
  var cols=State.results.columns, rows=State.results.rows, title=State.results.title||'Report';
  if(!rows.length){ toast('No data to export','warning'); return; }
  var def=title.replace(/[^a-z0-9]+/gi,'_').slice(0,40);
  apiCall('save_file_dialog', def, 'pdf').then(function(path){
    if(!path) return null;
    var orgName=(State.settings&&State.settings.org_name)||'';
    var logo=(State.settings&&State.settings.org_logo_b64)||'';
    var sql=State.lastSqlDisplay||'';
    return apiCall('export_pdf', cols, rows, path, title, orgName, logo, sql).then(function(){ toast('PDF saved.','ok'); });
  }).catch(function(e){ toast('Export failed: '+e.message,'error'); });
}

/* ── AUTO-LOAD LAST FILE ────────────────────────────────────── */
function tryAutoLoadLastFile() {
  apiCall('get_last_import').then(function(last) {
    if (!last || !last.filepath_hint) return null;
    return apiCall('check_filepath_exists', last.filepath_hint).then(function(exists) {
      if (!exists) return null;
      setSelectedFile(last.filepath_hint, true);
      var st = document.getElementById('import-status');
      if (st) {
        st.textContent = 'Last: ' + last.filename + ' (' + (last.period_start||'') + ')';
        st.style.color = 'var(--text-dim)';
      }
    });
  }).catch(function(){});
}

/* ── INIT ───────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {

  initZoom();
  loadPanelWidths();
  initResizableHandles();
  populateAggDropdowns();

  var on = function(id, ev, fn) { var el=document.getElementById(id); if(el) el.addEventListener(ev,fn); };
  on('btn-browse',       'click', browseFile);
  on('btn-reimport',     'click', triggerImport);
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

  var sqlEd = document.getElementById('sql-editor');
  if (sqlEd) {
    sqlEd.addEventListener('input', function(){ updateLineNumbers('sql-editor','sql-lines'); });
    sqlEd.addEventListener('keydown', function(e) {
      if(e.ctrlKey&&e.key==='Enter'){ e.preventDefault(); runSql(); }
      if(e.key==='Tab'){ e.preventDefault(); var s=sqlEd.selectionStart; sqlEd.value=sqlEd.value.slice(0,s)+'  '+sqlEd.value.slice(sqlEd.selectionEnd); sqlEd.selectionStart=sqlEd.selectionEnd=s+2; updateLineNumbers('sql-editor','sql-lines'); }
    });
  }
  on('cr-sql','input', function(){ updateLineNumbers('cr-sql','cr-lines'); });
  on('sort-col',     'change', updateFilterSQL);
  on('sort-dir',     'change', updateFilterSQL);
  on('result-limit', 'input',  updateFilterSQL);
  on('having-agg',   'change', function(){ checkConflict(); updateFilterSQL(); });
  on('having-op',    'change', function(){ checkConflict(); updateFilterSQL(); });
  on('having-val',   'input',  function(){ checkConflict(); updateFilterSQL(); });

  document.querySelectorAll('.quick-btn[data-report]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var r=btn.dataset.report;
      if(r==='chronic') openModal('modal-chronic');
      else runQuickReport(r);
    });
  });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeModal(); });

  addFilterRow();

  /* Bootstrap from API — load all persisted state */
  waitForApi().then(function() {
    return window.pywebview.api.get_settings();
  }).then(function(res) {
    if (!res.ok) return;
    var s = res.data || {};
    State.settings = s;

    // Theme
    var theme = s.ap_theme || 'mono';
    memSet('ap_theme', theme);
    if (typeof loadSavedTheme === 'function') loadSavedTheme(theme);

    // Zoom
    var z = parseFloat(s.ap_zoom);
    if (!isNaN(z)) { memSet('ap_zoom', z); setZoom(z); } else setZoom(ZOOM_DEFAULT);

    // Panels
    if (s.ap_panels) { memSet('ap_panels', s.ap_panels); loadPanelWidths(); }

    // Custom reports
    if (s.ap_custom_reports) { memSet('ap_custom_reports', s.ap_custom_reports); }
    loadCustomReports();

    refreshThreshDisplay();
    updateOrgBranding();
    if (s.org_logo_b64) State.orgLogo = s.org_logo_b64;

    return refreshDbStatus();
  }).then(function() {
    // Auto-load last file after DB status is ready
    tryAutoLoadLastFile();
  }).catch(function(e) {
    console.error('Init error:', e);
    loadCustomReports();
  });
});
