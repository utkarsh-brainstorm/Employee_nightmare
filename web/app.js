/**
 * app.js — AttendanceProcessor v4.1
 * ====================================
 * FIXES: filter values always read from DOM (not stale state),
 *        GROUP BY validation with clear error (no dual-table mode),
 *        HAVING only runs if user typed a real value.
 */

'use strict';

/* ── In-memory store (replaces localStorage) ────────────────── */
window._apMem = window._apMem || {};
function memGet(k, d) { var v = window._apMem[k]; return (v !== undefined && v !== null) ? v : (d !== undefined ? d : null); }
function memSet(k, v) { window._apMem[k] = v; }

/* ── API bridge ─────────────────────────────────────────────── */
function waitForApi() {
  return new Promise(function(res) {
    if (window.pywebview && window.pywebview.api) return res();
    var t = setInterval(function() { if (window.pywebview && window.pywebview.api) { clearInterval(t); res(); } }, 60);
  });
}
function apiCall(method) {
  var args = Array.prototype.slice.call(arguments, 1);
  return waitForApi().then(function() {
    return window.pywebview.api[method].apply(window.pywebview.api, args);
  }).then(function(r) {
    if (!r.ok) throw new Error(r.error || 'API error');
    return r.data;
  });
}

/* ── Global state ───────────────────────────────────────────── */
var State = {
  results: { columns: [], rows: [], title: '' },
  lastSqlDisplay: '',
  sortCol: null, sortAsc: true,
  pendingFile: null, editingEmp: null,
  settings: {}, customReports: [], activeModal: null,
  orgLogo: null,
  selectFields: [],   // [{label, expr, isAgg}]
  groupByFields: [],  // [{label, expr}]
};

/* ── Field definitions ──────────────────────────────────────── */
var FIELDS = [
  { label:'Employee Name',  col:'COALESCE(s.emp_name_override, a.emp_name)',   cat:'text',   ops:['contains','equals','starts with','ends with','not equals'] },
  { label:'Employee ID',    col:'a.emp_code',   cat:'text',   ops:['equals','contains'] },
  { label:'Date',           col:'a.work_date',  cat:'date',   ops:['on','before','after','on or before','on or after','between'] },
  { label:'Status',         col:'a.status',     cat:'status', ops:['is','is not'], opts:['PRESENT','ABSENT','WEEKLY_OFF','HALF_DAY'] },
  { label:'Arrival Time',   col:'a.punch_in',   cat:'time',   ops:['before','after','equals'] },
  { label:'Departure Time', col:'a.punch_out',  cat:'time',   ops:['before','after','equals'] },
  { label:'Hours Worked',   col:'a.work_hours', cat:'number', ops:['greater than','less than','equals','at least','at most'] },
  { label:'Arrived Late?',  col:'a.is_late',    cat:'bool',   ops:['is'], opts:['Yes','No'] },
  { label:'Left Early?',    col:'a.left_early', cat:'bool',   ops:['is'], opts:['Yes','No'] },
];

var SELECT_FIELDS = [
  { label:'Employee Name',    expr:'COALESCE(s.emp_name_override, a.emp_name)',    isAgg:false },
  { label:'Employee ID',      expr:'a.emp_code',    isAgg:false },
  { label:'Date',             expr:'a.work_date',   isAgg:false },
  { label:'Status',           expr:'a.status',      isAgg:false },
  { label:'Arrival Time',     expr:'a.punch_in',    isAgg:false },
  { label:'Departure Time',   expr:'a.punch_out',   isAgg:false },
  { label:'Hours Worked',     expr:'a.work_hours',  isAgg:false },
  { label:'Late?',            expr:'a.is_late',     isAgg:false },
  { label:'Left Early?',      expr:'a.left_early',  isAgg:false },
  { label:'# Records',        expr:'COUNT(*)',                                             isAgg:true },
  { label:'# Days Present',   expr:"SUM(CASE WHEN a.status='PRESENT' THEN 1 ELSE 0 END)",   isAgg:true },
  { label:'# Days Absent',    expr:"SUM(CASE WHEN a.status='ABSENT' THEN 1 ELSE 0 END)",    isAgg:true },
  { label:'# Late Days',      expr:'SUM(a.is_late)',                                         isAgg:true },
  { label:'Total Hours',      expr:'SUM(a.work_hours)',                                      isAgg:true },
  { label:'Avg Hours/Day',    expr:'ROUND(AVG(a.work_hours),2)',                             isAgg:true },
  { label:'Earliest Arrival', expr:'MIN(a.punch_in)',                                        isAgg:true },
  { label:'Latest Arrival',   expr:'MAX(a.punch_in)',                                        isAgg:true },
];

var GROUPBY_FIELDS = [
  { label:'Employee Name', expr:'COALESCE(s.emp_name_override, a.emp_name)' },
  { label:'Employee ID',   expr:'a.emp_code' },
  { label:'Date',          expr:'a.work_date' },
  { label:'Status',        expr:'a.status' },
  { label:'Month',         expr:"strftime('%Y-%m', a.work_date)" },
  { label:'Year',          expr:"strftime('%Y', a.work_date)" },
  { label:'Late?',         expr:'a.is_late' },
];

/* ── SQL clause builders (with real interpolated values) ────── */
var OP_SQL = {
  'contains':    function(c,v){ return "LOWER("+c+") LIKE LOWER('%"+esc(v)+"%')"; },
  'equals':      function(c,v){ return "LOWER("+c+") = LOWER('"+esc(v)+"')"; },
  'starts with': function(c,v){ return "LOWER("+c+") LIKE LOWER('"+esc(v)+"%')"; },
  'ends with':   function(c,v){ return "LOWER("+c+") LIKE LOWER('%"+esc(v)+"')"; },
  'not equals':  function(c,v){ return "LOWER("+c+") != LOWER('"+esc(v)+"')"; },
  'on':          function(c,v){ return c+" = '"+esc(v)+"'"; },
  'before':      function(c,v){ return c+" < '"+esc(v)+"'"; },
  'after':       function(c,v){ return c+" > '"+esc(v)+"'"; },
  'on or before':function(c,v){ return c+" <= '"+esc(v)+"'"; },
  'on or after': function(c,v){ return c+" >= '"+esc(v)+"'"; },
  'between':     function(c,v,v2){ return c+" BETWEEN '"+esc(v)+"' AND '"+esc(v2)+"'"; },
  'greater than':function(c,v){ return c+" > "+v; },
  'less than':   function(c,v){ return c+" < "+v; },
  'equals':      function(c,v,_,cat){ return cat==='number'?c+" = "+v:"LOWER("+c+") = LOWER('"+esc(v)+"')"; },
  'at least':    function(c,v){ return c+" >= "+v; },
  'at most':     function(c,v){ return c+" <= "+v; },
  'is':          function(c,v){ return v==='Yes'?c+" = 1":v==='No'?c+" = 0":c+" = '"+v.toUpperCase()+"'"; },
  'is not':      function(c,v){ return c+" != '"+v.toUpperCase()+"'"; },
};
function esc(s){ return String(s||'').replace(/'/g,"''"); }

/* ── Critical fix: always read filter values FROM DOM ───────── */
function readFilterFromDOM() {
  var rows = [];
  document.querySelectorAll('#filter-rows .filter-row').forEach(function(rowEl) {
    var id  = parseInt(rowEl.dataset.id, 10);
    var fr  = _filterRows.find(function(r){ return r.id===id; });
    if (!fr) return;
    var valEl  = rowEl.querySelector('.val-inp');
    var val2El = rowEl.querySelector('.val2-inp');
    rows.push({
      field:    fr.field,
      operator: fr.op,
      value:    valEl  ? valEl.value  : '',
      value2:   val2El ? val2El.value : '',
      joiner:   fr.joiner
    });
  });
  return rows;
}

/* ── GROUP BY validation ────────────────────────────────────── */
function validateGroupBy() {
  /* Returns null if valid, or an error string to show the user. */
  if (!State.groupByFields.length) return null;       // No GROUP BY — fine
  if (!State.selectFields.length)  return null;       // Default SELECT — fine
  var hasAgg = State.selectFields.some(function(f){ return f.isAgg; });
  if (!hasAgg) return null;                           // GROUP BY without aggregates = de-dupe, fine
  var grpSet = {};
  State.groupByFields.forEach(function(f){ grpSet[f.expr.trim()] = true; });
  var bad = State.selectFields.filter(function(f){ return !f.isAgg && !grpSet[f.expr.trim()]; });
  if (!bad.length) return null;
  return 'Invalid GROUP BY: "' + bad.map(function(f){ return f.label; }).join('", "') +
         '" ' + (bad.length===1?'is':'are') +
         ' in SELECT but not in GROUP BY and not an aggregate. Remove from SELECT or add to GROUP BY.';
}

/* ── Live conflict indicator (non-blocking) ─────────────────── */
function checkConflict() {
  var err  = validateGroupBy();
  var note = document.getElementById('conflict-note');
  if (note) {
    if (err) {
      note.classList.remove('hidden');
      note.textContent = '⚠ ' + err;
    } else {
      note.classList.add('hidden');
    }
  }
}

/* ── Aggregate & Group section ──────────────────────────────── */
function populateAggDropdowns() {
  var sel = document.getElementById('select-add');
  var grp = document.getElementById('groupby-add');
  if (!sel || !grp) return;
  sel.innerHTML = '<option value="">+ Add field or aggregate…</option>';
  var plain = SELECT_FIELDS.filter(function(f){ return !f.isAgg; });
  var agg   = SELECT_FIELDS.filter(function(f){ return f.isAgg; });
  var og1 = document.createElement('optgroup'); og1.label = 'Regular Fields';
  plain.forEach(function(f){ og1.appendChild(new Option(f.label, f.label)); });
  sel.appendChild(og1);
  var og2 = document.createElement('optgroup'); og2.label = 'Aggregates';
  agg.forEach(function(f){ og2.appendChild(new Option(f.label, f.label)); });
  sel.appendChild(og2);

  grp.innerHTML = '<option value="">+ Add group field…</option>';
  GROUPBY_FIELDS.forEach(function(f){ grp.appendChild(new Option(f.label, f.label)); });
}

function addSelectField(select) {
  var label = select.value; if (!label) return; select.value = '';
  if (State.selectFields.find(function(f){ return f.label===label; })) { toast('Already added: '+label,'info'); return; }
  var def = SELECT_FIELDS.find(function(f){ return f.label===label; }); if (!def) return;
  State.selectFields.push({ label:def.label, expr:def.expr, isAgg:def.isAgg });
  renderSelectPills(); checkConflict(); updateFilterSQL();
}

function addGroupByField(select) {
  var label = select.value; if (!label) return; select.value = '';
  if (State.groupByFields.find(function(f){ return f.label===label; })) { toast('Already grouped: '+label,'info'); return; }
  var def = GROUPBY_FIELDS.find(function(f){ return f.label===label; }); if (!def) return;
  State.groupByFields.push({ label:def.label, expr:def.expr });
  renderGroupByPills(); checkConflict(); updateFilterSQL();
}

function removeSelectField(label) {
  State.selectFields = State.selectFields.filter(function(f){ return f.label!==label; });
  renderSelectPills(); checkConflict(); updateFilterSQL();
}
function removeGroupByField(label) {
  State.groupByFields = State.groupByFields.filter(function(f){ return f.label!==label; });
  renderGroupByPills(); checkConflict(); updateFilterSQL();
}

function renderSelectPills() {
  var area = document.getElementById('select-pills'); if (!area) return;
  area.innerHTML = '';
  State.selectFields.forEach(function(f) {
    var p = document.createElement('span');
    p.className = 'pill' + (f.isAgg ? ' pill-agg' : '');
    p.innerHTML = escHtml(f.label) + ' <button onclick="removeSelectField(\''+escHtml(f.label)+'\')">×</button>';
    area.appendChild(p);
  });
}
function renderGroupByPills() {
  var area = document.getElementById('groupby-pills'); if (!area) return;
  area.innerHTML = '';
  State.groupByFields.forEach(function(f) {
    var p = document.createElement('span');
    p.className = 'pill pill-group';
    p.innerHTML = escHtml(f.label) + ' <button onclick="removeGroupByField(\''+escHtml(f.label)+'\')">×</button>';
    area.appendChild(p);
  });
}

function clearHaving() {
  var v = document.getElementById('having-val'); if (v) v.value = '';
  checkConflict(); updateFilterSQL();
}

function getHaving() {
  /* Only returns a clause if user has typed a real numeric value */
  var aggEl = document.getElementById('having-agg');
  var opEl  = document.getElementById('having-op');
  var valEl = document.getElementById('having-val');
  var agg = aggEl ? aggEl.value : '';
  var op  = opEl  ? opEl.value  : '>';
  var val = valEl ? valEl.value.trim() : '';
  if (!agg || val === '' || isNaN(parseFloat(val))) return '';
  if (!State.groupByFields.length) return '';
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
var ZOOM_MIN=0.7, ZOOM_MAX=2.0, ZOOM_DEFAULT=1.3;
function getCurrentZoom() { return parseFloat(memGet('ap_zoom', ZOOM_DEFAULT)); }
function setZoom(z) {
  z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z*100)/100));
  document.documentElement.style.zoom = String(z);
  var lbl = document.getElementById('zoom-label'); if (lbl) lbl.textContent = Math.round(z*100)+'%';
  memSet('ap_zoom', z);
  apiCall('save_settings',{ap_zoom:String(z)}).catch(function(){});
}
function adjustZoom(d) { setZoom(getCurrentZoom()+d); }
function resetZoom() { setZoom(ZOOM_DEFAULT); }
function initZoom() {
  document.documentElement.style.zoom = String(getCurrentZoom());
  var lbl = document.getElementById('zoom-label'); if (lbl) lbl.textContent = Math.round(getCurrentZoom()*100)+'%';
  document.addEventListener('keydown', function(e) {
    if (!e.ctrlKey) return;
    if (e.key==='='||e.key==='+') { e.preventDefault(); adjustZoom(0.1); }
    else if (e.key==='-')         { e.preventDefault(); adjustZoom(-0.1); }
    else if (e.key==='0')         { e.preventDefault(); resetZoom(); }
  });
}

/* ── RESIZABLE PANELS ───────────────────────────────────────── */
function loadPanelWidths() {
  var raw = memGet('ap_panels', null); if (!raw) return;
  try {
    var saved = typeof raw==='string' ? JSON.parse(raw) : raw;
    var pf = document.getElementById('panel-filter'), pq = document.getElementById('panel-quick');
    if (saved.left  && pf) pf.style.width = saved.left;
    if (saved.right && pq) pq.style.width  = saved.right;
  } catch(e){}
}
function savePanelWidths() {
  var pf = document.getElementById('panel-filter'), pq = document.getElementById('panel-quick');
  if (!pf||!pq) return;
  var obj = { left:pf.offsetWidth+'px', right:pq.offsetWidth+'px' };
  memSet('ap_panels', JSON.stringify(obj));
  apiCall('save_settings',{ap_panels:JSON.stringify(obj)}).catch(function(){});
}
function initResizableHandles() {
  setupHandle('rh-left','panel-filter','left');
  setupHandle('rh-right','panel-quick','right');
}
function setupHandle(hId, pId, side) {
  var handle=document.getElementById(hId), panel=document.getElementById(pId);
  if (!handle||!panel) return;
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    var sx=e.clientX, sw=panel.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.userSelect='none'; document.body.style.cursor='col-resize';
    function onMove(ev) {
      var dx=ev.clientX-sx, nw=side==='left'?sw+dx:sw-dx;
      var mn=parseInt(panel.style.minWidth||'220',10), mx=parseInt(panel.style.maxWidth||'560',10);
      panel.style.width=Math.max(mn,Math.min(mx,nw))+'px';
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.style.userSelect=''; document.body.style.cursor='';
      document.removeEventListener('mousemove',onMove);
      document.removeEventListener('mouseup',onUp);
      savePanelWidths();
    }
    document.addEventListener('mousemove',onMove);
    document.addEventListener('mouseup',onUp);
  });
}

/* ── TOAST ──────────────────────────────────────────────────── */
var _tt = null;
function toast(msg, type) {
  var el=document.getElementById('toast'); if (!el) return;
  var c={info:'var(--text-head)',ok:'var(--ok)',error:'var(--danger)',warning:'var(--warn)'}[type]||'var(--text-head)';
  el.style.background=c; el.style.color=type==='warning'?'#000':'var(--text-inv)';
  el.textContent=msg; el.classList.remove('hidden','fade-out');
  clearTimeout(_tt);
  _tt=setTimeout(function(){ el.classList.add('fade-out'); setTimeout(function(){ el.classList.add('hidden'); },320); },3400);
}

/* ── MODAL ──────────────────────────────────────────────────── */
function openModal(id) {
  closeModal(); State.activeModal=id;
  var bd=document.getElementById('modal-backdrop'), m=document.getElementById(id);
  if (bd) bd.classList.remove('hidden'); if (m) m.classList.remove('hidden');
  if (id==='modal-settings') { var t=document.querySelector('.settings-tab'); if(t) switchSettingsTab(t,'general'); }
}
function closeModal() {
  if (State.activeModal) { var m=document.getElementById(State.activeModal); if(m) m.classList.add('hidden'); State.activeModal=null; }
  var bd=document.getElementById('modal-backdrop'); if(bd) bd.classList.add('hidden');
}

/* ── DB STATUS ──────────────────────────────────────────────── */
function refreshDbStatus() {
  return apiCall('get_db_status').then(function(data) {
    var el=document.getElementById('db-status'); if (!el) return;
    if (data&&data.min_date) {
      el.textContent=data.min_date+' → '+data.max_date;
      var qf=document.getElementById('quick-from'); if(qf) qf.value=data.min_date;
      var qt=document.getElementById('quick-to');   if(qt) qt.value=data.max_date;
    } else el.textContent='no data';
  }).catch(function(){});
}

/* ── SETTINGS ───────────────────────────────────────────────── */
function switchSettingsTab(btn, tabName) {
  if (!btn) return;
  document.querySelectorAll('.settings-tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('.settings-tab-body').forEach(function(t){ t.classList.add('hidden'); });
  btn.classList.add('active');
  var tab=document.getElementById('tab-'+tabName); if(tab) tab.classList.remove('hidden');
  if (tabName==='theme')    buildThemeGrid();
  if (tabName==='querylog') loadQueryLog();
}
function openSettings() {
  apiCall('get_settings').then(function(s) {
    State.settings=s||{};
    var set=function(id,k){ var el=document.getElementById(id); if(el) el.value=s[k]||''; };
    set('s-checkin','checkin_time'); set('s-checkout','checkout_time');
    set('s-late', 'late_threshold'); set('s-early', 'early_leave_threshold');
    set('s-org-name','org_name');
    State.orgLogo=s.org_logo_b64||null; updateLogoPreview(s.org_logo_b64||'');
  }).catch(function(e){ toast('Failed to load settings: '+e.message,'error'); });
  openModal('modal-settings');
}
function updateLogoPreview(b64) {
  var pv=document.getElementById('logo-preview'), img=document.getElementById('logo-img');
  if (!pv||!img) return;
  if (b64) { img.src='data:image/png;base64,'+b64; pv.classList.remove('hidden'); }
  else { pv.classList.add('hidden'); img.src=''; }
}
function pickLogo() {
  apiCall('open_file_dialog_type','image').then(function(path){ if (!path) return null; return apiCall('read_file_as_b64',path); })
  .then(function(b64){ if (!b64) return; State.orgLogo=b64; updateLogoPreview(b64); })
  .catch(function(e){ toast('Could not load logo: '+e.message,'error'); });
}
function clearLogo() { State.orgLogo=null; updateLogoPreview(null); }
function saveSettings() {
  var ci=((document.getElementById('s-checkin')||{}).value||'').trim();
  var co=((document.getElementById('s-checkout')||{}).value||'').trim();
  var lt=((document.getElementById('s-late')||{}).value||'').trim();
  var el=((document.getElementById('s-early')||{}).value||'').trim();
  var on=((document.getElementById('s-org-name')||{}).value||'').trim();
  var tr=/^\d{2}:\d{2}$/;
  var fields=[[ci,'Check-in'],[co,'Check-out'],[lt,'Late'],[el,'Early']];
  for (var i=0;i<fields.length;i++) { if (!tr.test(fields[i][0])) { toast(fields[i][1]+' must be HH:MM','error'); return; } }
  var payload={checkin_time:ci,checkout_time:co,late_threshold:lt,early_leave_threshold:el,org_name:on,org_logo_b64:State.orgLogo||''};
  apiCall('save_settings',payload).then(function(){ State.settings=Object.assign({},State.settings,payload); refreshThreshDisplay(); updateOrgBranding(); closeModal(); toast('Settings saved.','ok'); })
  .catch(function(e){ toast('Save failed: '+e.message,'error'); });
}
function refreshThreshDisplay() {
  var s=State.settings, el=document.getElementById('thresh-display'); if (!el) return;
  el.innerHTML='<div>check-in <span style="color:var(--text-body)">'+(s.checkin_time||'—')+'</span></div>'+
    '<div>check-out <span style="color:var(--text-body)">'+(s.checkout_time||'—')+'</span></div>'+
    '<div>late &gt; <span style="color:var(--text-body)">'+(s.late_threshold||'—')+'</span></div>'+
    '<div>early &lt; <span style="color:var(--text-body)">'+(s.early_leave_threshold||'—')+'</span></div>';
}
function updateOrgBranding() {
  var name=(State.settings&&State.settings.org_name)||'', el=document.getElementById('org-name-display'); if (!el) return;
  if (name) { el.textContent=name; el.classList.remove('hidden'); } else el.classList.add('hidden');
}

/* ── QUERY LOG ──────────────────────────────────────────────── */
function loadQueryLog() {
  var c=document.getElementById('query-log-list'); if (!c) return;
  apiCall('get_query_log').then(function(logs) {
    if (!logs||!logs.length) { c.innerHTML='<div style="padding:20px;text-align:center;font-size:11px;color:var(--text-dim)">No queries logged yet.</div>'; return; }
    c.innerHTML='';
    logs.forEach(function(log) {
      var row=document.createElement('div'); row.className='qlog-row';
      var time=(log.ran_at||'').slice(0,16).replace('T',' ');
      row.innerHTML='<div class="qlog-sql">'+escHtml(log.sql_text)+'</div>'+
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">'+
        '<span class="qlog-meta">'+time+'<br>'+(log.row_count||0)+' rows</span>'+
        '<button class="qlog-copy" onclick="copyToClipboard('+JSON.stringify(log.sql_text)+')">Copy</button></div>';
      c.appendChild(row);
    });
  }).catch(function(e){ c.innerHTML='<div style="padding:10px;color:var(--danger);font-size:11px">'+escHtml(e.message)+'</div>'; });
}
function clearQueryLog() { apiCall('clear_query_log').then(function(){ loadQueryLog(); toast('Query log cleared.','ok'); }).catch(function(e){ toast(e.message,'error'); }); }
function copyToClipboard(text) {
  try { var ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); toast('Copied','ok'); }
  catch(e){ toast('Copy failed: '+e.message,'error'); }
}
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ── IMPORT ─────────────────────────────────────────────────── */
var _selectedFilePath = null;
function browseFile() { apiCall('open_file_dialog').then(function(path){ if (path) setSelectedFile(path); }).catch(function(e){ toast('File picker error: '+e.message,'error'); }); }
function setSelectedFile(path, isAutoLoad) {
  _selectedFilePath=path;
  var name=path.replace(/\\/g,'/').split('/').pop();
  var fn=document.getElementById('import-filename'), btn=document.getElementById('btn-import'), ri=document.getElementById('btn-reimport');
  if (fn) fn.textContent=name+(isAutoLoad?' (last session — click Import ▶ to reload)':'');
  if (btn) btn.disabled=false;
  if (ri) ri.classList.toggle('hidden',!isAutoLoad);
}
function triggerImport() {
  if (!_selectedFilePath) return;
  var name=_selectedFilePath.replace(/\\/g,'/').split('/').pop();
  apiCall('check_already_imported',name).then(function(existing) {
    if (existing) { var msg=document.getElementById('overwrite-msg'); if(msg) msg.innerHTML='<strong>'+escHtml(name)+'</strong> was imported on '+(existing.imported_at||'').slice(0,10)+' ('+( existing.rows_imported||'?')+' records).'; State.pendingFile=_selectedFilePath; openModal('modal-overwrite'); }
    else doImport(_selectedFilePath,false);
  }).catch(function(e){ toast('Error: '+e.message,'error'); });
}
function confirmImport(overwrite) { closeModal(); if (State.pendingFile) { doImport(State.pendingFile,overwrite); State.pendingFile=null; } }
function doImport(filepath, overwrite) {
  var prog=document.getElementById('import-progress'), btnI=document.getElementById('btn-import'), st=document.getElementById('import-status');
  if (prog) prog.classList.remove('hidden'); if (btnI) btnI.disabled=true; setSqlStatus('Parsing file…','info');
  apiCall('import_file',filepath,overwrite).then(function(r) {
    if (prog) prog.classList.add('hidden'); if (btnI) btnI.disabled=false;
    if (st) { st.textContent='✓ '+r.inserted+' records · '+r.employees+' employees · '+r.period_start+'→'+r.period_end; st.style.color='var(--ok)'; }
    refreshDbStatus(); toast('Import complete: '+r.inserted+' records.','ok');
    if (r.employee_diff) showEmployeeDiff(r.employee_diff);
    if (r.warnings&&r.warnings.length) toast('⚠ '+r.warnings.length+' warning(s): '+r.warnings[0],'warning');
  }).catch(function(e){ if (prog) prog.classList.add('hidden'); if (btnI) btnI.disabled=false; if (st) { st.textContent='✗ '+e.message; st.style.color='var(--danger)'; } toast('Import failed: '+e.message,'error'); });
}
function showEmployeeDiff(diff) {
  var added=diff.added||[], removed=diff.removed||[];
  if (!added.length&&!removed.length) return;
  var html='';
  if (added.length) html+='<strong>'+added.length+' new employee'+(added.length>1?'s':'')+' detected:</strong> '+added.slice(0,3).join(', ')+(added.length>3?' +'+(added.length-3)+' more':'')+'. <button style="text-decoration:underline;font-weight:600;background:none;border:none;cursor:pointer;color:inherit" onclick="openEmployees()">Add details →</button>  ';
  if (removed.length) html+='<strong>'+removed.length+' employee'+(removed.length>1?'s':'')+' no longer in file:</strong> '+removed.slice(0,3).join(', ')+(removed.length>3?' +'+(removed.length-3)+' more':'');
  var te=document.getElementById('emp-diff-text'), bn=document.getElementById('emp-diff-banner');
  if (te) te.innerHTML=html; if (bn) bn.classList.remove('hidden');
}
function handleDragOver(e) { e.preventDefault(); var dz=document.getElementById('drop-zone'); if(dz) dz.classList.add('drag-over'); }
function handleDragLeave() { var dz=document.getElementById('drop-zone'); if(dz) dz.classList.remove('drag-over'); }
function handleDrop(e) {
  e.preventDefault(); var dz=document.getElementById('drop-zone'); if(dz) dz.classList.remove('drag-over');
  var files=e.dataTransfer&&e.dataTransfer.files;
  if (files&&files.length>0) { var f=files[0], path=f.path||f.name; if(/\.(xls|xlsx|xlsm)$/i.test(path)) setSelectedFile(path); else toast('Please drop an Excel file (.xls / .xlsx)','error'); }
}

/* ── FILTER BUILDER ─────────────────────────────────────────── */
var _filterRows = [], _filterIdCounter = 0;

function fieldDefaultValue(field, op) {
  var today = new Date().toISOString().slice(0,10);
  if (field.opts)             return field.opts[0];
  if (field.cat==='date')     return today;
  if (field.cat==='time')     return '09:00';
  if (field.cat==='number')   return '6';
  return '';
}
function fieldDefaultValue2(field) {
  return field.cat==='date' ? new Date().toISOString().slice(0,10) : '';
}

function addFilterRow() {
  var id=++_filterIdCounter, isFirst=_filterRows.length===0, field=FIELDS[0];
  var defVal = fieldDefaultValue(field, field.ops[0]);
  _filterRows.push({ id:id, field:field.label, op:field.ops[0], value:defVal, value2:fieldDefaultValue2(field), joiner:'AND' });
  var c=document.getElementById('filter-rows'); if (!c) return;
  var row=document.createElement('div'); row.className='filter-row'; row.dataset.id=id;
  row.innerHTML=buildFilterRowHTML(id, isFirst, field, field.ops[0]);
  c.appendChild(row); bindFilterRow(row,id); updateFilterSQL();
}

function buildFilterRowHTML(id, isFirst, field, op) {
  var joiner = isFirst
    ? '<span style="font-size:10px;color:var(--text-dim);flex-shrink:0;width:34px;text-align:center">WHERE</span>'
    : '<button class="joiner-pill active" data-id="'+id+'">AND</button>';
  var fo=FIELDS.map(function(f){ return '<option value="'+f.label+'"'+(f.label===field.label?' selected':'')+'>'+f.label+'</option>'; }).join('');
  var oo=field.ops.map(function(o){ return '<option value="'+o+'">'+o+'</option>'; }).join('');
  return joiner+
    '<select class="field-sel" style="width:100px;flex-shrink:0" data-id="'+id+'">'+fo+'</select>'+
    '<select class="op-sel" style="width:85px;flex-shrink:0" data-id="'+id+'">'+oo+'</select>'+
    '<div class="value-wrap" style="flex:1;display:flex;gap:3px;min-width:0" data-id="'+id+'">'+buildValueHTML(id,field,op)+'</div>'+
    '<button class="remove-filter" data-id="'+id+'">✕</button>';
}

function buildValueHTML(id, field, op) {
  var today=new Date().toISOString().slice(0,10);
  if (field.opts) {
    return '<select class="val-inp" data-id="'+id+'" style="flex:1">'+
      field.opts.map(function(o){ return '<option value="'+o+'">'+o+'</option>'; }).join('')+'</select>';
  }
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
  var joinerBtn=row.querySelector('.joiner-pill');
  if (joinerBtn) joinerBtn.addEventListener('click',function() {
    var fr=_filterRows.find(function(r){ return r.id===id; }); if (!fr) return;
    fr.joiner=fr.joiner==='AND'?'OR':'AND';
    joinerBtn.textContent=fr.joiner; joinerBtn.classList.toggle('active',fr.joiner==='AND');
    updateFilterSQL();
  });

  var fieldSel=row.querySelector('.field-sel');
  if (fieldSel) fieldSel.addEventListener('change',function() {
    var fr=_filterRows.find(function(r){ return r.id===id; }); if (!fr) return;
    var field=FIELDS.find(function(f){ return f.label===fieldSel.value; }); if (!field) return;
    fr.field=field.label; fr.op=field.ops[0];
    fr.value=fieldDefaultValue(field,fr.op); fr.value2=fieldDefaultValue2(field);
    var opSel=row.querySelector('.op-sel');
    if (opSel) opSel.innerHTML=field.ops.map(function(o){ return '<option value="'+o+'">'+o+'</option>'; }).join('');
    var vw=row.querySelector('.value-wrap'); if (vw) vw.innerHTML=buildValueHTML(id,field,fr.op);
    bindValueInputs(row,id); updateFilterSQL();
  });

  var opSel=row.querySelector('.op-sel');
  if (opSel) opSel.addEventListener('change',function() {
    var fr=_filterRows.find(function(r){ return r.id===id; }); if (!fr) return;
    fr.op=opSel.value;
    var field=FIELDS.find(function(f){ return f.label===fr.field; });
    var vw=row.querySelector('.value-wrap'); if (vw) vw.innerHTML=buildValueHTML(id,field,fr.op);
    bindValueInputs(row,id); updateFilterSQL();
  });

  bindValueInputs(row,id);

  var removeBtn=row.querySelector('.remove-filter');
  if (removeBtn) removeBtn.addEventListener('click',function(){
    row.remove(); _filterRows=_filterRows.filter(function(r){ return r.id!==id; }); updateFilterSQL();
  });
}

function bindValueInputs(row, id) {
  /* Listen on both 'input' (text/number) and 'change' (select) */
  row.querySelectorAll('.val-inp,.val2-inp').forEach(function(el) {
    var handler = function() {
      var fr=_filterRows.find(function(r){ return r.id===id; }); if (!fr) return;
      if (el.classList.contains('val-inp'))  fr.value  = el.value;
      if (el.classList.contains('val2-inp')) fr.value2 = el.value;
      updateFilterSQL();
    };
    el.addEventListener('input',  handler);
    el.addEventListener('change', handler);
  });
}

function clearFilters() {
  var c=document.getElementById('filter-rows'); if (c) c.innerHTML='';
  _filterRows=[]; _filterIdCounter=0;
  State.selectFields=[]; State.groupByFields=[];
  renderSelectPills(); renderGroupByPills(); checkConflict();
  var hv=document.getElementById('having-val'); if (hv) hv.value='';
  addFilterRow();
}

/* ── SQL preview: always reads live DOM values ───────────────── */
function updateFilterSQL() {
  try {
    var filters = readFilterFromDOM();
    var sortCol = (document.getElementById('sort-col')||{}).value||'work_date';
    var sortDir = (document.getElementById('sort-dir')||{}).value||'ASC';
    var lim     = (document.getElementById('result-limit')||{}).value||'5000';
    var having  = getHaving();

    /* SELECT clause */
    var selLines;
    if (State.selectFields.length > 0) {
      selLines = State.selectFields.map(function(f, i){ 
        return '  '+f.expr+' AS "'+f.label+'"' + (i < State.selectFields.length - 1 ? ',' : ''); 
      });
    } else {
      selLines = [
        '  a.emp_code, COALESCE(s.emp_name_override, a.emp_name) AS "Employee Name", a.work_date, a.status,',
        '  a.punch_in AS "In", a.punch_out AS "Out",',
        '  a.work_hours AS "Hours", a.is_late AS "Late", a.left_early AS "Left Early"'
      ];
    }

    /* WHERE clause — reads live from DOM via readFilterFromDOM() */
    var whereParts = [];
    filters.forEach(function(fr, i) {
      var field=FIELDS.find(function(fd){ return fd.label===fr.field; }); if (!field) return;
      var val=fr.value||'', val2=fr.value2||'';
      if (!val && fr.op!=='between') return;
      var fn=OP_SQL[fr.op]; if (!fn) return;
      var clause=fn(field.col, val, val2, field.cat);
      whereParts.push((i===0?'WHERE ':'  '+(fr.joiner||'AND')+' ')+clause);
    });

    /* GROUP BY */
    var grpLines = State.groupByFields.length
      ? ['GROUP BY '+State.groupByFields.map(function(f){ return f.expr; }).join(', ')] : [];

    /* HAVING */
    var havingLines = (having && State.groupByFields.length) ? ['HAVING '+having] : [];

    /* ORDER BY (skip if GROUP BY present) */
    var orderLines = (!State.groupByFields.length) ? ['ORDER BY '+sortCol+' '+sortDir] : [];
    var limitLines = ['LIMIT '+lim];

    var parts = ['SELECT'].concat(selLines).concat(['FROM attendance_raw'])
                .concat(whereParts).concat(grpLines).concat(havingLines)
                .concat(orderLines).concat(limitLines);
    var sql = parts.join('\n');
    State.lastSqlDisplay = sql;
    setSqlEditor(sql);
  } catch(e){}
}

/* ── RUN FILTER ─────────────────────────────────────────────── */
function runFilter() {
  /* 1. Validate GROUP BY logic BEFORE calling API */
  var gbErr = validateGroupBy();
  if (gbErr) {
    setSqlStatus('⚠ ' + gbErr, 'error');
    toast('Fix GROUP BY configuration', 'error');
    return;
  }

  var filters   = JSON.stringify(readFilterFromDOM());
  var sc        = (document.getElementById('sort-col')||{}).value||'a.work_date';
  var sd        = (document.getElementById('sort-dir')||{}).value||'ASC';
  var lim       = parseInt((document.getElementById('result-limit')||{}).value||'5000',10);
  var selExprs  = JSON.stringify(State.selectFields.map(function(f){ return f.expr; }));
  var selLabels = JSON.stringify(State.selectFields.map(function(f){ return f.label; }));
  var selIsAgg  = JSON.stringify(State.selectFields.map(function(f){ return f.isAgg; }));
  var grpExprs  = JSON.stringify(State.groupByFields.map(function(f){ return f.expr; }));
  var having    = getHaving();

  setSqlStatus('Running…','info');
  apiCall('run_filter', filters, sc, sd, lim, selExprs, selLabels, selIsAgg, grpExprs, having)
  .then(function(res) {
    if (res.sql) { State.lastSqlDisplay = res.sql; setSqlEditor(res.sql); }
    setSqlStatus('✓ '+res.count+' records','ok');
    showResults(res.columns, res.rows, 'Search Results');
  }).catch(function(e){ setSqlStatus('✗ '+e.message,'error'); toast(e.message,'error'); });
}

/* ── SQL PANEL ──────────────────────────────────────────────── */
function setSqlEditor(sql) {
  var ta=document.getElementById('sql-editor'); if (ta) ta.value=sql;
  updateLineNumbers('sql-editor','sql-lines');
}
function updateLineNumbers(edId, lnId) {
  var ta=document.getElementById(edId), ln=document.getElementById(lnId); if (!ta||!ln) return;
  var n=ta.value.split('\n').length, h='';
  for (var i=1;i<=n;i++) h+=i+'<br>';
  ln.innerHTML=h;
}
function setSqlStatus(msg, type) {
  var el=document.getElementById('sql-status'); if (!el) return;
  var c={info:'var(--text-dim)',ok:'var(--ok)',error:'var(--danger)',warning:'var(--warn)'}[type]||'var(--text-dim)';
  el.textContent=msg; el.style.color=c;
}
function runSql() {
  var ta=document.getElementById('sql-editor'); if (!ta) return;
  var sql=ta.value.split('\n').filter(function(l){ return !l.trim().startsWith('--'); }).join('\n').trim();
  if (!sql) { setSqlStatus('Enter a SELECT query.','error'); return; }
  State.lastSqlDisplay=sql; setSqlStatus('Running…','info');
  apiCall('run_sql',sql).then(function(res){
    setSqlStatus('✓ '+res.count+' records','ok'); showResults(res.columns,res.rows,'Query Results');
  }).catch(function(e){ setSqlStatus('✗ '+e.message,'error'); toast(e.message,'error'); });
}
function clearSql() { var ta=document.getElementById('sql-editor'); if (ta) ta.value=''; updateLineNumbers('sql-editor','sql-lines'); setSqlStatus(''); }

/* ── SCHEMA ─────────────────────────────────────────────────── */
var SCHEMA=[
  {table:'attendance_raw',cols:[['emp_code','TEXT','Employee ID'],['emp_name','TEXT','Name from file'],['work_date','DATE','YYYY-MM-DD'],['status','TEXT','PRESENT|ABSENT|WEEKLY_OFF|HALF_DAY'],['punch_in','TEXT','HH:MM arrival'],['punch_out','TEXT','HH:MM departure'],['work_hours','REAL','Decimal hours'],['is_late','INTEGER','1=late'],['left_early','INTEGER','1=left early']]},
  {table:'employee_salary',cols:[['emp_code','TEXT','PK'],['emp_name_override','TEXT','Admin full name'],['monthly_salary','REAL','₹/month'],['daily_rate','REAL','Auto']]},
  {table:'import_log',cols:[['filename','TEXT','Imported file'],['imported_at','DATETIME','Timestamp'],['rows_imported','INTEGER','Records']]},
];
var EXAMPLES=[
  "SELECT * FROM attendance_raw\nWHERE LOWER(emp_name) LIKE '%anita%'",
  "SELECT emp_name, COUNT(*) AS days\nFROM attendance_raw\nWHERE status='ABSENT'\nGROUP BY emp_code\nORDER BY days DESC",
  "SELECT emp_name, SUM(is_late) AS late_days\nFROM attendance_raw\nGROUP BY emp_code\nHAVING SUM(is_late) > 2",
  "SELECT emp_name, work_date, punch_in\nFROM attendance_raw\nWHERE status='PRESENT'\n  AND punch_in > '09:15'\nORDER BY work_date",
];
function buildSchemaContent(c) {
  if (!c) return; c.innerHTML='';
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
  var p=document.getElementById('schema-panel'), b=document.getElementById('btn-schema-toggle'); if (!p) return;
  var h=p.classList.toggle('hidden'); if (b) b.textContent=h?'📋 Schema':'✕ Schema';
  if (!h&&!p.children.length) buildSchemaContent(p);
}

/* ── RESULTS GRID ───────────────────────────────────────────── */
function showResults(columns, rows, title) {
  State.results={columns:columns,rows:rows.slice(),title:title||'Results'};
  State.sortCol=null; State.sortAsc=true;
  renderGrid();
  var rt=document.getElementById('results-title'); if (rt) rt.textContent=title||'Results';
  var rc=document.getElementById('results-count'); if (rc) rc.textContent='— '+rows.length.toLocaleString()+' record'+(rows.length!==1?'s':'');
  var ec=document.getElementById('btn-export-csv'), ep=document.getElementById('btn-export-pdf');
  if (ec) ec.disabled=!rows.length; if (ep) ep.disabled=!rows.length;
}
function renderGrid() {
  var cols=State.results.columns, rows=State.results.rows;
  var hd=document.getElementById('results-head'), bd=document.getElementById('results-body'), em=document.getElementById('results-empty');
  if (!hd||!bd) return; hd.innerHTML=''; bd.innerHTML='';
  if (!cols||!cols.length) { if (em) em.classList.remove('hidden'); return; }
  if (em) em.classList.add('hidden');
  var tr=document.createElement('tr');
  cols.forEach(function(col) {
    var th=document.createElement('th'); th.textContent=col;
    if (col===State.sortCol) th.className=State.sortAsc?'sort-asc':'sort-desc';
    th.addEventListener('click',function(){ sortGrid(col); }); tr.appendChild(th);
  }); hd.appendChild(tr);
  var frag=document.createDocumentFragment();
  rows.forEach(function(row) {
    var tr2=document.createElement('tr');
    cols.forEach(function(col) {
      var td=document.createElement('td'), val=(row[col]!==undefined&&row[col]!==null)?row[col]:'';
      if (col.toLowerCase()==='status') { var sp=document.createElement('span'); sp.className='status-'+String(val).toUpperCase().replace(/ /g,'_'); sp.textContent=val; td.appendChild(sp); }
      else td.textContent=val;
      tr2.appendChild(td);
    }); frag.appendChild(tr2);
  }); bd.appendChild(frag);
}
function sortGrid(col) {
  State.sortAsc=(State.sortCol===col)?!State.sortAsc:true; State.sortCol=col;
  State.results.rows.sort(function(a,b){
    var va=a[col]!=null?a[col]:'', vb=b[col]!=null?b[col]:'';
    var na=parseFloat(String(va).replace(/[₹,]/g,'')), nb=parseFloat(String(vb).replace(/[₹,]/g,''));
    if (!isNaN(na)&&!isNaN(nb)) return State.sortAsc?na-nb:nb-na;
    return State.sortAsc?String(va).localeCompare(String(vb)):String(vb).localeCompare(String(va));
  }); renderGrid();
}

/* ── CUSTOM REPORTS ─────────────────────────────────────────── */
const DEFAULT_MACROS = [
  { id: 'def_monthly', title: 'Monthly Summary', icon: '📊', sql: 'WITH bounds AS (SELECT MIN(work_date) as mn, MAX(work_date) as mx FROM attendance_raw),\nconfig AS (\n    SELECT \n        CAST(julianday((SELECT mx FROM bounds)) - julianday((SELECT mn FROM bounds)) + 1 AS INTEGER) AS total_days,\n        (SELECT COUNT(*) FROM calendar_days WHERE date BETWEEN (SELECT mn FROM bounds) AND (SELECT mx FROM bounds)) AS holidays\n)\nSELECT\n    a.emp_code AS "Emp Code", COALESCE(s.emp_name_override, a.emp_name) AS "Name",\n    (SELECT MAX(total_days - holidays, 1) FROM config) AS "Working Days",\n    COUNT(CASE WHEN a.status=\'PRESENT\' THEN 1 END) AS "Days Present",\n    COUNT(CASE WHEN a.status=\'ABSENT\' AND a.work_date NOT IN (SELECT date FROM calendar_days) THEN 1 END) AS "Days Absent",\n    COUNT(CASE WHEN a.status=\'WEEKLY_OFF\' THEN 1 END) AS "Weekly Off",\n    COUNT(CASE WHEN a.status=\'HALF_DAY\' THEN 1 END) AS "Half Day",\n    COUNT(CASE WHEN a.is_late=1 THEN 1 END) AS "Late Days",\n    COUNT(CASE WHEN a.left_early=1 THEN 1 END) AS "Early Leaves",\n    ROUND(AVG(CASE WHEN a.work_hours IS NOT NULL THEN a.work_hours END), 2) AS "Avg Hours/Day",\n    ROUND(SUM(COALESCE(a.work_hours, 0)), 2) AS "Total Hours"\nFROM attendance_raw a\nLEFT JOIN employee_salary s ON a.emp_code = s.emp_code\nWHERE COALESCE(s.is_disabled, 0) = 0\nGROUP BY a.emp_code, a.emp_name\nORDER BY CAST(a.emp_code AS INTEGER)' },
  { id: 'def_late', title: 'Late Arrivals', icon: '⏰', sql: 'WITH config AS (\n    SELECT \n        COALESCE((SELECT value FROM app_settings WHERE key=\'late_threshold\'), \'09:15\') AS def_late_thresh\n)\nSELECT\n    a.emp_code AS "Emp Code", COALESCE(s.emp_name_override, a.emp_name) AS "Name",\n    a.work_date AS "Date", a.punch_in AS "Arrived At", a.punch_out AS "Left At",\n    a.work_hours AS "Hours Worked"\nFROM attendance_raw a\nLEFT JOIN employee_salary s ON a.emp_code = s.emp_code\nCROSS JOIN config c\nWHERE a.status IN (\'PRESENT\', \'HALF_DAY\')\n  AND a.punch_in IS NOT NULL\n  AND strftime(\'%s\', \'1970-01-01 \' || a.punch_in || \':00\') > strftime(\'%s\', \'1970-01-01 \' || COALESCE(s.custom_arrival, c.def_late_thresh) || \':00\')\n  AND COALESCE(s.is_disabled, 0) = 0\nORDER BY a.work_date, a.emp_name' },
  { id: 'def_early', title: 'Early Leavers', icon: '🏃', sql: 'WITH config AS (\n    SELECT \n        COALESCE((SELECT value FROM app_settings WHERE key=\'early_leave_threshold\'), \'15:30\') AS def_early_thresh\n)\nSELECT\n    a.emp_code AS "Emp Code", COALESCE(s.emp_name_override, a.emp_name) AS "Name",\n    a.work_date AS "Date", a.punch_in AS "Arrived At", a.punch_out AS "Left At",\n    a.work_hours AS "Hours Worked"\nFROM attendance_raw a\nLEFT JOIN employee_salary s ON a.emp_code = s.emp_code\nCROSS JOIN config c\nWHERE a.status IN (\'PRESENT\', \'HALF_DAY\')\n  AND a.punch_out IS NOT NULL\n  AND strftime(\'%s\', \'1970-01-01 \' || a.punch_out || \':00\') < strftime(\'%s\', \'1970-01-01 \' || COALESCE(s.custom_departure, c.def_early_thresh) || \':00\')\n  AND COALESCE(s.is_disabled, 0) = 0\nORDER BY a.work_date, a.emp_name' },
  { id: 'def_absent', title: 'Absentees', icon: '❌', sql: 'SELECT\n    a.emp_code AS "Emp Code", COALESCE(s.emp_name_override, a.emp_name) AS "Name", a.work_date AS "Absent Date"\nFROM attendance_raw a\nLEFT JOIN employee_salary s ON a.emp_code = s.emp_code\nWHERE a.status = \'ABSENT\'\n  AND a.work_date NOT IN (SELECT date FROM calendar_days)\n  AND COALESCE(s.is_disabled, 0) = 0\nORDER BY a.work_date, a.emp_name' },
  { id: 'def_salary', title: 'Salary Report', icon: '💰', sql: 'WITH bounds AS (SELECT MIN(work_date) as mn, MAX(work_date) as mx FROM attendance_raw),\nconfig AS (\n    SELECT \n        COALESCE((SELECT value FROM app_settings WHERE key=\'checkin_time\'), \'09:00\') AS def_in,\n        COALESCE((SELECT value FROM app_settings WHERE key=\'checkout_time\'), \'17:00\') AS def_out,\n        CAST(julianday((SELECT mx FROM bounds)) - julianday((SELECT mn FROM bounds)) + 1 AS INTEGER) AS total_days,\n        (SELECT COUNT(*) FROM calendar_days WHERE date BETWEEN (SELECT mn FROM bounds) AND (SELECT mx FROM bounds)) AS holidays\n),\ndaily_calc AS (\n    SELECT \n        a.emp_code,\n        a.emp_name,\n        a.status,\n        a.work_date,\n        COALESCE(s.custom_arrival, c.def_in) AS sched_in,\n        COALESCE(s.custom_departure, c.def_out) AS sched_out,\n        a.punch_in,\n        a.punch_out,\n        MAX(a.punch_in, COALESCE(s.custom_arrival, c.def_in)) AS eff_in,\n        MIN(a.punch_out, COALESCE(s.custom_departure, c.def_out)) AS eff_out,\n        CASE WHEN a.punch_in IS NOT NULL AND a.punch_out IS NOT NULL THEN\n             MAX(0, (strftime(\'%s\', \'1970-01-01 \' || MIN(a.punch_out, COALESCE(s.custom_departure, c.def_out)) || \':00\') - \n                     strftime(\'%s\', \'1970-01-01 \' || MAX(a.punch_in, COALESCE(s.custom_arrival, c.def_in)) || \':00\')) / 60)\n             WHEN (a.punch_in IS NOT NULL OR a.punch_out IS NOT NULL) THEN\n             (strftime(\'%s\', \'1970-01-01 \' || COALESCE(s.custom_departure, c.def_out) || \':00\') - \n              strftime(\'%s\', \'1970-01-01 \' || COALESCE(s.custom_arrival, c.def_in) || \':00\')) / 120\n        ELSE 0 END AS valid_worked_mins,\n        (strftime(\'%s\', \'1970-01-01 \' || COALESCE(s.custom_departure, c.def_out) || \':00\') - \n         strftime(\'%s\', \'1970-01-01 \' || COALESCE(s.custom_arrival, c.def_in) || \':00\')) / 60 AS shift_mins\n    FROM attendance_raw a\n    LEFT JOIN employee_salary s ON a.emp_code = s.emp_code\n    CROSS JOIN config c\n    WHERE COALESCE(s.is_disabled, 0) = 0\n)\nSELECT \n    d.emp_code AS "Emp Code",\n    COALESCE((SELECT emp_name_override FROM employee_salary WHERE emp_code=d.emp_code), d.emp_name) AS "Name",\n    COALESCE((SELECT monthly_salary FROM employee_salary WHERE emp_code=d.emp_code), 0) AS "Base Salary (₹)",\n    (SELECT MAX(total_days - holidays, 1) FROM config) AS "Working Days",\n    COUNT(CASE WHEN d.status=\'ABSENT\' AND d.work_date NOT IN (SELECT date FROM calendar_days) THEN 1 END) AS "Absent",\n    CASE \n        WHEN COUNT(CASE WHEN d.status=\'ABSENT\' AND d.work_date NOT IN (SELECT date FROM calendar_days) THEN 1 END) > 0 \n        THEN 1 ELSE 0 \n    END AS "Leave Credit",\n    MAX(d.shift_mins) * (SELECT MAX(total_days - holidays, 1) FROM config) AS "Total Req Mins",\n    ROUND(COALESCE((SELECT monthly_salary FROM employee_salary WHERE emp_code=d.emp_code), 0) * 1.0 / (MAX(d.shift_mins) * (SELECT MAX(total_days - holidays, 1) FROM config)), 2) AS "Per-Minute Rate (₹)",\n    SUM(d.valid_worked_mins) AS "Worked Mins",\n    SUM(d.valid_worked_mins) + \n      (CASE WHEN COUNT(CASE WHEN d.status=\'ABSENT\' AND d.work_date NOT IN (SELECT date FROM calendar_days) THEN 1 END) > 0 THEN MAX(d.shift_mins) ELSE 0 END) \n      AS "Payable Mins",\n    CASE \n        WHEN COALESCE((SELECT monthly_salary FROM employee_salary WHERE emp_code=d.emp_code), 0) > 0 THEN \n            ROUND(\n                (COALESCE((SELECT monthly_salary FROM employee_salary WHERE emp_code=d.emp_code), 0) * 1.0 / \n                (MAX(d.shift_mins) * (SELECT MAX(total_days - holidays, 1) FROM config))) * \n                (SUM(d.valid_worked_mins) + \n                  (CASE WHEN COUNT(CASE WHEN d.status=\'ABSENT\' AND d.work_date NOT IN (SELECT date FROM calendar_days) THEN 1 END) > 0 THEN MAX(d.shift_mins) ELSE 0 END)\n                )\n            , 2)\n        ELSE \'N/A\' \n    END AS "Earned (₹)"\nFROM daily_calc d\nGROUP BY d.emp_code, d.emp_name\nORDER BY CAST(d.emp_code AS INTEGER)' },
  { id: 'def_perfect', title: 'Perfect Attendance', icon: '🌟', sql: 'WITH bounds AS (SELECT MIN(work_date) as mn, MAX(work_date) as mx FROM attendance_raw),\nconfig AS (\n    SELECT \n        CAST(julianday((SELECT mx FROM bounds)) - julianday((SELECT mn FROM bounds)) + 1 AS INTEGER) AS total_days,\n        (SELECT COUNT(*) FROM calendar_days WHERE date BETWEEN (SELECT mn FROM bounds) AND (SELECT mx FROM bounds)) AS holidays\n)\nSELECT\n    a.emp_code AS "Emp Code", COALESCE(s.emp_name_override, a.emp_name) AS "Name",\n    (SELECT MAX(total_days - holidays, 1) FROM config) AS "Working Days",\n    COUNT(CASE WHEN a.status=\'PRESENT\' THEN 1 END) AS "Days Present"\nFROM attendance_raw a\nLEFT JOIN employee_salary s ON a.emp_code = s.emp_code\nWHERE COALESCE(s.is_disabled, 0) = 0\nGROUP BY a.emp_code, a.emp_name\nHAVING COUNT(CASE WHEN a.status=\'ABSENT\' AND a.work_date NOT IN (SELECT date FROM calendar_days) THEN 1 END) = 0\n   AND COUNT(CASE WHEN a.status=\'HALF_DAY\' THEN 1 END) = 0\nORDER BY a.emp_name' },
  { id: 'def_grid', title: 'Full Grid', icon: '📋', sql: 'SELECT\n    a.emp_code AS "Emp Code", COALESCE(s.emp_name_override, a.emp_name) AS "Name",\n    a.work_date AS "Date", a.status AS "Status", a.punch_in AS "In", a.punch_out AS "Out", a.work_hours AS "Hours"\nFROM attendance_raw a\nLEFT JOIN employee_salary s ON a.emp_code = s.emp_code\nWHERE COALESCE(s.is_disabled, 0) = 0\nORDER BY a.work_date, CAST(a.emp_code AS INTEGER)' }
];

function loadCustomReports() {
  var raw=memGet('ap_custom_reports',null);
  if (raw) { try{ State.customReports=typeof raw==='string'?JSON.parse(raw):raw; }catch(e){ State.customReports=[]; } } else State.customReports=[];
  
  if (!State.customReports.length) { 
      State.customReports = JSON.parse(JSON.stringify(DEFAULT_MACROS)); 
  } else {
      // Force upgrade default macros to ensure users get the new V5 logic
      DEFAULT_MACROS.forEach(function(dm) {
          var existing = State.customReports.find(function(cr) { return cr.id === dm.id; });
          if (existing) { existing.sql = dm.sql; } 
          else { State.customReports.push(JSON.parse(JSON.stringify(dm))); }
      });
  }
  
  saveCustomReportsToDisk();
  renderCustomReports();
}
function saveCustomReportsToDisk() {
  var json=JSON.stringify(State.customReports);
  memSet('ap_custom_reports',json);
  apiCall('save_settings',{ap_custom_reports:json}).catch(function(){});
}
function renderCustomReports() {
  var c=document.getElementById('quick-custom'); if (!c) return;
  if (!State.customReports.length) { c.innerHTML='<div style="padding:10px;text-align:center;color:var(--text-dim)">No reports saved</div>'; return; }
  c.innerHTML='';
  State.customReports.forEach(function(cr){
    var o=document.createElement('div'); o.className='quick-btn custom-shortcut';
    o.innerHTML='<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escHtml((cr.icon||'📌')+' '+cr.title)+'</span>'+
      '<span class="cr-actions" style="display:none;gap:4px">'+
      '<button style="font-size:10px;color:var(--accent);background:none;border:none;cursor:pointer" data-edit="'+cr.id+'">✏</button>'+
      '<button style="font-size:10px;color:var(--danger);background:none;border:none;cursor:pointer" data-del="'+cr.id+'">✕</button></span>';
    o.addEventListener('mouseenter',function(){ var a=o.querySelector('.cr-actions'); if(a) a.style.display='flex'; });
    o.addEventListener('mouseleave',function(){ var a=o.querySelector('.cr-actions'); if(a) a.style.display='none'; });
    o.addEventListener('click',function(e){
      if (e.target.dataset.edit) { openCustomReportModal(e.target.dataset.edit); return; }
      if (e.target.dataset.del)  { deleteCustomReport(e.target.dataset.del);     return; }
      runCustomReport(cr);
    }); c.appendChild(o);
  });
}
function runCustomReport(cr) {
  var ed = document.getElementById('sql-editor');
  if (ed) {
    ed.value = cr.sql;
    updateLineNumbers('sql-editor', 'sql-lines');
    runRawSql();
  }
}
function openCustomReportModal(editId) {
  var cr=editId?State.customReports.find(function(r){ return r.id===editId; }):null;
  var te=document.getElementById('cr-title'), ic=document.getElementById('cr-icon'), sq=document.getElementById('cr-sql');
  if (te) te.value=cr?cr.title:''; if (ic) ic.value=cr?(cr.icon||'📌'):'📌';
  if (sq) { sq.value=cr?cr.sql:''; sq.dataset.editId=editId||''; }
  updateLineNumbers('cr-sql','cr-lines');
  buildSchemaContent(document.getElementById('cr-schema-ref'));
  openModal('modal-custom-report');
}
function deleteCustomReport(id) { State.customReports=State.customReports.filter(function(r){ return r.id!==id; }); saveCustomReportsToDisk(); renderCustomReports(); toast('Shortcut removed.','ok'); }
function saveCustomReport() {
  var title=((document.getElementById('cr-title')||{}).value||'').trim();
  var icon =((document.getElementById('cr-icon') ||{}).value||'📌').trim();
  var sql  =((document.getElementById('cr-sql')  ||{}).value||'').trim();
  var editId=((document.getElementById('cr-sql')||{}).dataset||{}).editId||'';
  if (!title) { toast('Please enter a report title.','error'); return; }
  if (!sql)   { toast('Please enter a SQL query.','error'); return; }
  if (editId) { var idx=State.customReports.findIndex(function(r){ return r.id===editId; }); if (idx>=0) State.customReports[idx]={id:editId,title:title,icon:icon,sql:sql}; }
  else State.customReports.push({id:Date.now().toString(),title:title,icon:icon,sql:sql});
  saveCustomReportsToDisk(); renderCustomReports(); closeModal(); toast('"'+title+'" saved.','ok');
}

/* ── EMPLOYEES ──────────────────────────────────────────────── */
function openEmployees() { openModal('modal-employees'); loadEmployees(); }
function loadEmployees() {
  apiCall('get_employees').then(function(emps){
    var tbody=document.getElementById('emp-tbody'); if (!tbody) return; tbody.innerHTML='';
    emps.forEach(function(e){
      var sal=e.monthly_salary||0, name=e.emp_name_override||'';
      var disabled = e.is_disabled ? 'checked' : '';
      var tr=document.createElement('tr');
      tr.innerHTML='<td class="tbl-head" style="font-family:monospace">'+escHtml(e.emp_code||'')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;color:var(--text-dim)">'+escHtml(e.emp_name||'')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;'+(name?'font-weight:500':'font-style:italic;color:var(--text-dim)')+'">'+escHtml(name||'not set')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;text-align:right;font-family:monospace">'+(sal?'₹'+Number(sal).toLocaleString():'—')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;text-align:center"><label style="cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px"><input type="checkbox" '+disabled+' onchange="toggleEmployeeDisabled(\''+escHtml(e.emp_code)+'\', this.checked)"> Disabled</label></td>'+
        '<td style="padding:5px 8px;text-align:center;white-space:nowrap;">'+
        '<button style="font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer;margin-right:8px" '+
        'data-code="'+escHtml(e.emp_code||'')+'" data-name="'+escHtml(e.emp_name||'')+'" data-override="'+escHtml(name)+'" data-sal="'+sal+'" data-cin="'+escHtml(e.custom_arrival||'')+'" data-cout="'+escHtml(e.custom_departure||'')+'" onclick="editEmployee(this)">Edit</button>'+
        '<button style="font-size:11px;color:var(--ok);background:none;border:none;cursor:pointer" '+
        'data-code="'+escHtml(e.emp_code||'')+'" data-name="'+escHtml(e.emp_name||'')+'" onclick="openPunchModal(this)">+ Punch</button></td>';
      tbody.appendChild(tr);
    });
  }).catch(function(e){ toast('Failed: '+e.message,'error'); });
}
function toggleEmployeeDisabled(code, checked) {
  apiCall('toggle_employee_disabled', code, checked?1:0).then(function(){ toast('Status updated','ok'); }).catch(function(e){ toast(e.message,'error'); });
}
function editEmployee(btn) {
  State.editingEmp={code:btn.dataset.code||'',name:btn.dataset.name||''};
  var er=document.getElementById('emp-edit-row'), el=document.getElementById('emp-edit-label');
  var fn=document.getElementById('emp-fullname'), sal=document.getElementById('emp-salary');
  var cin=document.getElementById('emp-custom-arrival'), cout=document.getElementById('emp-custom-departure');
  if (er) er.classList.remove('hidden'); if (el) el.textContent='['+btn.dataset.code+'] '+btn.dataset.name;
  if (fn) fn.value=btn.dataset.override||''; if (sal) sal.value=btn.dataset.sal||'0';
  if (cin) cin.value=btn.dataset.cin||''; if (cout) cout.value=btn.dataset.cout||'';
}
function cancelEmpEdit() { State.editingEmp=null; var er=document.getElementById('emp-edit-row'); if (er) er.classList.add('hidden'); }
function saveEmployee() {
  var emp=State.editingEmp; if (!emp) return;
  var fn=((document.getElementById('emp-fullname')||{}).value||'').trim();
  var sal=parseFloat((document.getElementById('emp-salary')||{}).value||'0')||0;
  var cin=((document.getElementById('emp-custom-arrival')||{}).value||'').trim();
  var cout=((document.getElementById('emp-custom-departure')||{}).value||'').trim();
  apiCall('upsert_employee',emp.code,emp.name,fn,sal,cin,cout).then(function(){ cancelEmpEdit(); loadEmployees(); toast('Employee updated.','ok'); }).catch(function(e){ toast('Save failed: '+e.message,'error'); });
}

/* ── MANUAL PUNCH ────────────────────────────────────────────── */
function openPunchModal(btn) {
  var code = btn.dataset.code;
  var name = btn.dataset.name;
  var m = document.getElementById('modal-punch');
  var bd = document.getElementById('modal-backdrop');
  if (m) m.classList.remove('hidden');
  if (bd) bd.style.zIndex = '50'; // Above other modals
  document.getElementById('punch-emp-code').value = code;
  document.getElementById('punch-emp-name').textContent = '[' + code + '] ' + name;
  document.getElementById('punch-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('punch-in').value = '09:00';
  document.getElementById('punch-out').value = '17:00';
}
function closePunchModal() {
  var m = document.getElementById('modal-punch');
  if (m) m.classList.add('hidden');
}
function saveManualPunch() {
  var code = document.getElementById('punch-emp-code').value;
  var date = document.getElementById('punch-date').value;
  var pIn = document.getElementById('punch-in').value;
  var pOut = document.getElementById('punch-out').value;
  if (!date) return toast('Date is required', 'error');
  var hm1 = pIn ? pIn.split(':') : [0,0];
  var hm2 = pOut ? pOut.split(':') : [0,0];
  var diff = (parseInt(hm2[0])*60+parseInt(hm2[1])) - (parseInt(hm1[0])*60+parseInt(hm1[1]));
  if (diff < 0) diff += 24*60;
  var hrs = pIn && pOut ? (diff / 60) : 0;
  var status = (pIn || pOut) ? 'PRESENT' : 'ABSENT';
  apiCall('upsert_manual_punch', code, date, pIn, pOut, status, hrs, 0, 0, 'Manual')
    .then(function(){ closePunchModal(); toast('Punch saved','ok'); })
    .catch(function(e){ toast(e.message, 'error'); });
}

/* ── CALENDAR ────────────────────────────────────────────────── */
function loadCalendar() {
  var m = parseInt(document.getElementById('cal-month').value, 10);
  var y = parseInt(document.getElementById('cal-year').value, 10);
  if (!m || !y) return;
  apiCall('get_calendar_days', y, m).then(function(days) {
    renderCalendar(y, m, days);
  });
}
function renderCalendar(y, m, days) {
  var grid = document.getElementById('calendar-grid'); if (!grid) return;
  grid.innerHTML = '<div class="font-bold">Mon</div><div class="font-bold">Tue</div><div class="font-bold">Wed</div><div class="font-bold">Thu</div><div class="font-bold">Fri</div><div class="font-bold text-[var(--danger)]">Sat</div><div class="font-bold text-[var(--danger)]">Sun</div>';
  var firstDay = new Date(y, m-1, 1).getDay(); // 0 is Sunday
  var totalDays = new Date(y, m, 0).getDate();
  var offset = firstDay === 0 ? 6 : firstDay - 1; // Mon = 0
  
  for (var i = 0; i < offset; i++) {
    grid.innerHTML += '<div></div>';
  }
  
  for (var d = 1; d <= totalDays; d++) {
    var dateStr = y + '-' + String(m).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    var dayData = days.find(function(x){ return x.date === dateStr; });
    var type = dayData ? dayData.day_type : '';
    
    var bg = 'bg-[var(--bg-surface)]';
    var text = '';
    if (type === 'WEEKLY_OFF') { bg = 'bg-blue-900/20'; text = '<br/><span class="text-[8px] text-blue-400">OFF</span>'; }
    else if (type === 'HOLIDAY') { bg = 'bg-red-900/20'; text = '<br/><span class="text-[8px] text-red-400">HOLIDAY</span>'; }
    
    var btn = document.createElement('div');
    btn.className = 'border border-[var(--border)] rounded py-1 cursor-pointer hover:bg-[var(--bg-muted)] ' + bg;
    btn.innerHTML = d + text;
    btn.onclick = (function(ds, t) {
      return function() {
        var nt = '';
        if (!t) nt = 'WEEKLY_OFF';
        else if (t === 'WEEKLY_OFF') nt = 'HOLIDAY';
        else nt = '';
        apiCall('toggle_calendar_day', ds, nt).then(loadCalendar);
      }
    })(dateStr, type);
    grid.appendChild(btn);
  }
}

/* ── IMPORT HISTORY ─────────────────────────────────────────── */
function openHistory() {
  openModal('modal-history');
  apiCall('get_import_history').then(function(history){
    var tbody=document.getElementById('history-tbody'), empty=document.getElementById('history-empty');
    if (!tbody) return; tbody.innerHTML='';
    if (!history||!history.length) { if (empty) empty.classList.remove('hidden'); return; }
    if (empty) empty.classList.add('hidden');
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
  var cols=State.results.columns, rows=State.results.rows, defaultTitle=State.results.title||'export';
  if (!rows.length) { toast('No data to export','warning'); return; }
  var userTitle = prompt('Enter a title for this CSV export:', defaultTitle);
  if (userTitle === null) return;
  if (userTitle.trim() === '') userTitle = defaultTitle;
  apiCall('save_file_dialog',userTitle.replace(/[^a-z0-9]+/gi,'_').slice(0,40),'csv').then(function(path){
    if (!path) return; return apiCall('export_csv',cols,rows,path).then(function(){ toast('CSV saved.','ok'); });
  }).catch(function(e){ toast('Export failed: '+e.message,'error'); });
}
function exportPdf() {
  var cols=State.results.columns, rows=State.results.rows, defaultTitle=State.results.title||'Report';
  if (!rows.length) { toast('No data to export','warning'); return; }
  var userTitle = prompt('Enter a title for this PDF report:', defaultTitle);
  if (userTitle === null) return;
  if (userTitle.trim() === '') userTitle = defaultTitle;
  apiCall('save_file_dialog',userTitle.replace(/[^a-z0-9]+/gi,'_').slice(0,40),'pdf').then(function(path){
    if (!path) return;
    var computed = getComputedStyle(document.documentElement);
    var themeColors = {
      bg: computed.getPropertyValue('--bg-surface').trim(),
      text: computed.getPropertyValue('--text-body').trim(),
      head: computed.getPropertyValue('--text-head').trim(),
      border: computed.getPropertyValue('--border').trim()
    };
    return apiCall('export_pdf',cols,rows,path,userTitle,(State.settings&&State.settings.org_name)||'',(State.settings&&State.settings.org_logo_b64)||'',State.lastSqlDisplay||'', themeColors).then(function(){ toast('PDF saved.','ok'); });
  }).catch(function(e){ toast('Export failed: '+e.message,'error'); });
}

/* ── AUTO-LOAD LAST FILE ────────────────────────────────────── */
function tryAutoLoadLastFile() {
  apiCall('get_last_import').then(function(last) {
    if (!last||!last.filepath_hint) return null;
    return apiCall('check_filepath_exists',last.filepath_hint).then(function(exists) {
      if (!exists) return;
      setSelectedFile(last.filepath_hint,true);
      var st=document.getElementById('import-status');
      if (st) { st.textContent='Last: '+last.filename+' ('+(last.period_start||'')+')'; st.style.color='var(--text-dim)'; }
    });
  }).catch(function(){});
}

/* ── INIT ───────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
  initZoom(); loadPanelWidths(); initResizableHandles(); populateAggDropdowns();

  function on(id,ev,fn){ var el=document.getElementById(id); if(el) el.addEventListener(ev,fn); }
  on('btn-browse','click',browseFile);
  on('btn-reimport','click',triggerImport);
  on('btn-import','click',triggerImport);
  on('btn-settings','click',openSettings);
  on('btn-employees','click',openEmployees);
  on('btn-history','click',openHistory);
  on('btn-add-filter','click',addFilterRow);
  on('btn-run-filter','click',runFilter);
  on('btn-clear-filter','click',clearFilters);
  on('btn-sql-run','click',runSql);
  on('btn-sql-clear','click',clearSql);
  on('btn-schema-toggle','click',toggleSchema);
  on('btn-export-csv','click',exportCsv);
  on('btn-export-pdf','click',exportPdf);

  var sqlEd=document.getElementById('sql-editor');
  if (sqlEd) {
    sqlEd.addEventListener('input',function(){ updateLineNumbers('sql-editor','sql-lines'); });
    sqlEd.addEventListener('scroll',function(){ document.getElementById('sql-lines').scrollTop=this.scrollTop; });
    sqlEd.addEventListener('keydown',function(e){
      if (e.ctrlKey&&e.key==='Enter') { e.preventDefault(); runSql(); }
      if (e.key==='Tab') { e.preventDefault(); var s=sqlEd.selectionStart; sqlEd.value=sqlEd.value.slice(0,s)+'  '+sqlEd.value.slice(sqlEd.selectionEnd); sqlEd.selectionStart=sqlEd.selectionEnd=s+2; updateLineNumbers('sql-editor','sql-lines'); }
    });
  }
  var crSql=document.getElementById('cr-sql');
  if (crSql) {
    crSql.addEventListener('input',function(){ updateLineNumbers('cr-sql','cr-lines'); });
    crSql.addEventListener('scroll',function(){ document.getElementById('cr-lines').scrollTop=this.scrollTop; });
  }

  // Vertical Resizing for SQL panel
  var rhSql = document.getElementById('rh-sql');
  var sqlPanel = document.getElementById('sql-panel');
  if (rhSql && sqlPanel) {
    var isResizingSql = false, startY, startH;
    rhSql.addEventListener('mousedown', function(e) {
      isResizingSql = true; startY = e.clientY; startH = sqlPanel.offsetHeight;
      rhSql.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!isResizingSql) return;
      var h = startH + (e.clientY - startY);
      if (h < 60) h = 60;
      if (h > window.innerHeight - 150) h = window.innerHeight - 150;
      sqlPanel.style.height = h + 'px';
    });
    document.addEventListener('mouseup', function(e) {
      if (isResizingSql) {
        isResizingSql = false;
        rhSql.classList.remove('dragging');
        document.body.style.cursor = '';
      }
    });
  }
  on('sort-col','change',updateFilterSQL);
  on('sort-dir','change',updateFilterSQL);
  on('result-limit','input',updateFilterSQL);
  on('having-agg','change',function(){ checkConflict(); updateFilterSQL(); });
  on('having-op','change',function(){ checkConflict(); updateFilterSQL(); });
  on('having-val','input',function(){ checkConflict(); updateFilterSQL(); });

  document.querySelectorAll('.quick-btn[data-report]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var r=btn.dataset.report;
      if (r==='chronic') openModal('modal-chronic'); else runQuickReport(r);
    });
  });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') closeModal(); });

  addFilterRow();

  waitForApi().then(function() {
    return window.pywebview.api.get_settings();
  }).then(function(res) {
    if (!res.ok) return;
    var s=res.data||{}; State.settings=s;
    var theme=s.ap_theme||'mono'; memSet('ap_theme',theme);
    if (typeof loadSavedTheme==='function') loadSavedTheme(theme);
    var z=parseFloat(s.ap_zoom); if (!isNaN(z)) { memSet('ap_zoom',z); setZoom(z); } else setZoom(ZOOM_DEFAULT);
    if (s.ap_panels) { memSet('ap_panels',s.ap_panels); loadPanelWidths(); }
    if (s.ap_custom_reports) memSet('ap_custom_reports',s.ap_custom_reports);
    loadCustomReports(); refreshThreshDisplay(); updateOrgBranding();
    if (s.org_logo_b64) State.orgLogo=s.org_logo_b64;
    return refreshDbStatus();
  }).then(function(){ tryAutoLoadLastFile(); })
  .catch(function(e){ console.error('Init error:',e); loadCustomReports(); });
});
