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
  orgLogoSq: null,
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
    State.dbStatus = data;
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
  if (tabName==='calendar') loadCalendar();
}
function openSettings() {
  apiCall('get_settings').then(function(s) {
    State.settings=s||{};
    var set=function(id,k){ var el=document.getElementById(id); if(el) el.value=s[k]||''; };
    set('s-checkin','checkin_time'); set('s-checkout','checkout_time');
    set('s-late', 'late_threshold'); set('s-early', 'early_leave_threshold');
    set('s-org-name','org_name');
    // Paid leave checkboxes
    var hp = document.getElementById('s-holidays-paid');
    var wp = document.getElementById('s-weeklyoff-paid');
    var sr = document.getElementById('s-sandwich-rule');
    if (hp) hp.checked = (s.holidays_paid || 'yes') === 'yes';
    if (wp) wp.checked = (s.weeklyoff_paid || 'yes') === 'yes';
    if (sr) sr.checked = (s.sandwich_rule !== 'no');
    State.orgLogo=s.org_logo_b64||null; updateLogoPreview(s.org_logo_b64||'');
    State.orgLogoSq=s.org_logo_sq_b64||null; updateLogoSqPreview(s.org_logo_sq_b64||'');

    // PDF Style settings
    var pdfDevMode = s.pdf_dev_mode === '1' || s.pdf_dev_mode === 'true' || s.pdf_dev_mode === true;
    _pdfDevMode = pdfDevMode;
    var devEl = document.getElementById('s-pdf-dev-mode');
    if (devEl) devEl.checked = pdfDevMode;
    var css = s.pdf_custom_css || '';
    _pdfCustomCss = css;
    var sCssEl = document.getElementById('s-pdf-custom-css');
    if (sCssEl) sCssEl.value = css;
    if (s.ap_pdf_dir) _pdfDefaultDir = s.ap_pdf_dir;

    // Default calendar month/year to active attendance dataset
    if (State.dbStatus && State.dbStatus.max_date) {
      var parts = State.dbStatus.max_date.split('-');
      var ym = parseInt(parts[0], 10);
      var mm = parseInt(parts[1], 10);
      var cmEl = document.getElementById('cal-month');
      var cyEl = document.getElementById('cal-year');
      if (cmEl && mm) cmEl.value = String(mm);
      if (cyEl && ym) cyEl.value = String(ym);
    }
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
function updateLogoSqPreview(b64) {
  var pv=document.getElementById('logo-sq-preview'), img=document.getElementById('logo-sq-img');
  if (!pv||!img) return;
  if (b64) { img.src='data:image/png;base64,'+b64; pv.classList.remove('hidden'); }
  else { pv.classList.add('hidden'); img.src=''; }
}
function pickLogoSq() {
  apiCall('open_file_dialog_type','image').then(function(path){ if (!path) return null; return apiCall('read_file_as_b64',path); })
  .then(function(b64){ if (!b64) return; State.orgLogoSq=b64; updateLogoSqPreview(b64); })
  .catch(function(e){ toast('Could not load logo: '+e.message,'error'); });
}
function clearLogoSq() {
  State.orgLogoSq=null;
  updateLogoSqPreview(null);
  apiCall('save_settings', { org_logo_sq_b64: '' }).catch(function(){});
}
function saveSettings() {
  var ci=((document.getElementById('s-checkin')||{}).value||'').trim();
  var co=((document.getElementById('s-checkout')||{}).value||'').trim();
  var lt=((document.getElementById('s-late')||{}).value||'').trim();
  var el=((document.getElementById('s-early')||{}).value||'').trim();
  var on=((document.getElementById('s-org-name')||{}).value||'').trim();
  var hp=document.getElementById('s-holidays-paid');
  var wp=document.getElementById('s-weeklyoff-paid');
  var sr=document.getElementById('s-sandwich-rule');
  var tr=/^\d{2}:\d{2}$/;
  var fields=[[ci,'Check-in'],[co,'Check-out'],[lt,'Late'],[el,'Early']];
  for (var i=0;i<fields.length;i++) { if (!tr.test(fields[i][0])) { toast(fields[i][1]+' must be HH:MM','error'); return; } }
  var payload={checkin_time:ci,checkout_time:co,late_threshold:lt,early_leave_threshold:el,
    org_name:on,org_logo_b64:State.orgLogo||'',org_logo_sq_b64:State.orgLogoSq||'',
    holidays_paid: hp&&hp.checked ? 'yes' : 'no',
    weeklyoff_paid: wp&&wp.checked ? 'yes' : 'no',
    sandwich_rule: sr&&sr.checked ? 'yes' : 'no',
    pdf_dev_mode: (document.getElementById('s-pdf-dev-mode') || {}).checked ? '1' : '0',
    pdf_custom_css: ((document.getElementById('s-pdf-custom-css') || {}).value || '').trim()
  };
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
function copyToClipboard(text, msg) {
  try { var ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); toast(msg || 'Copied','ok'); }
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
  window._lastResults = State.results;
  window._lastResultCols = columns;
  window._lastResultRows = rows;
  apiCall('set_last_results', columns, rows).catch(function(){});
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

  // Compute sandwich keys for visual highlighting in the web table
  var swKeys = new Set();
  if (!State.settings || State.settings.sandwich_rule !== 'no') {
    try {
      var byEmp = {};
      rows.forEach(function(r) {
        var id = String(r['emp_code'] || r['Code'] || r['emp_name'] || r['Name'] || '').trim().toLowerCase();
        var dt = String(r['work_date'] || r['Date'] || '').trim();
        var st = String(r['status'] || r['Status'] || '').trim().toUpperCase();
        if (!id || !dt || !st) return;
        if (!byEmp[id]) byEmp[id] = [];
        byEmp[id].push({ date: dt, status: st, id: id });
      });
      Object.keys(byEmp).forEach(function(id) {
        var list = byEmp[id];
        list.sort(function(a, b) { return a.date.localeCompare(b.date); });
        var n = list.length;
        for (var i = 0; i < n; i++) {
          var curSt = list[i].status;
          if (curSt === 'WEEKLY_OFF' || curSt === 'HOLIDAY' || curSt === 'WEEKLY OFF' || curSt === 'OFF') {
            var hasPrevAbsent = false;
            for (var j = i - 1; j >= 0; j--) {
              if (list[j].status === 'ABSENT') { hasPrevAbsent = true; break; }
              if (list[j].status !== 'WEEKLY_OFF' && list[j].status !== 'HOLIDAY' && list[j].status !== 'WEEKLY OFF' && list[j].status !== 'OFF') break;
            }
            var hasNextAbsent = false;
            for (var k = i + 1; k < n; k++) {
              if (list[k].status === 'ABSENT') { hasNextAbsent = true; break; }
              if (list[k].status !== 'WEEKLY_OFF' && list[k].status !== 'HOLIDAY' && list[k].status !== 'WEEKLY OFF' && list[k].status !== 'OFF') break;
            }
            if (hasPrevAbsent || hasNextAbsent) {
              swKeys.add(id + '|' + list[i].date);
            }
          }
        }
      });
    } catch(e) {}
  }

  var tr=document.createElement('tr');
  cols.forEach(function(col) {
    var th=document.createElement('th'); th.textContent=col;
    if (col===State.sortCol) th.className=State.sortAsc?'sort-asc':'sort-desc';
    th.addEventListener('click',function(){ sortGrid(col); }); tr.appendChild(th);
  }); hd.appendChild(tr);
  var frag=document.createDocumentFragment();
  rows.forEach(function(row) {
    var tr2=document.createElement('tr');
    if (row['Name'] === 'TOTAL') {
      tr2.className = 'total-row font-bold';
    }
    tr2.addEventListener('click', function() {
      var prev = bd.querySelector('tr.selected-row');
      if (prev && prev !== tr2) prev.classList.remove('selected-row');
      tr2.classList.toggle('selected-row');
    });
    cols.forEach(function(col) {
      var td=document.createElement('td'), val=(row[col]!==undefined&&row[col]!==null)?row[col]:'';
      if (col.toLowerCase()==='status') {
        var valUpper = String(val).toUpperCase();
        var sp=document.createElement('span');
        var rowId = String(row['emp_code'] || row['Code'] || row['emp_name'] || row['Name'] || '').trim().toLowerCase();
        var rowDt = String(row['work_date'] || row['Date'] || '').trim();
        if ((valUpper === 'WEEKLY_OFF' || valUpper === 'HOLIDAY' || valUpper === 'WEEKLY OFF' || valUpper === 'OFF') && swKeys.has(rowId + '|' + rowDt)) {
          sp.className = 'status-SANDWICH';
          sp.title = 'Sandwich rule: absorbed holiday/weekly-off';
        } else {
          sp.className='status-'+valUpper.replace(/ /g,'_');
        }
        sp.textContent=val;
        td.appendChild(sp);
      }
      else td.textContent=val;
      tr2.appendChild(td);
    }); frag.appendChild(tr2);
  }); bd.appendChild(frag);
}
function sortGrid(col) {
  State.sortAsc=(State.sortCol===col)?!State.sortAsc:true; State.sortCol=col;
  var totalRows = State.results.rows.filter(function(r){ return r['Name'] === 'TOTAL'; });
  var dataRows = State.results.rows.filter(function(r){ return r['Name'] !== 'TOTAL'; });
  dataRows.sort(function(a,b){
    var va=a[col]!=null?a[col]:'', vb=b[col]!=null?b[col]:'';
    var na=parseFloat(String(va).replace(/[₹,\/-]/g,'')), nb=parseFloat(String(vb).replace(/[₹,\/-]/g,''));
    if (!isNaN(na)&&!isNaN(nb)) return State.sortAsc?na-nb:nb-na;
    return State.sortAsc?String(va).localeCompare(String(vb)):String(vb).localeCompare(String(va));
  });
  State.results.rows = dataRows.concat(totalRows);
  renderGrid();
}

/* ── CUSTOM REPORTS ─────────────────────────────────────────── */
const DEFAULT_MACROS = [
  {
    id: 'def_raw_attendance',
    title: 'Full Attendance Raw',
    icon: '📋',
    sql: "-- =========================================================================\n-- EDIT PARAMETERS BELOW:\n-- Example Reference Dates: 1 to 30 Sept 2026 ('2026-09-01' to '2026-09-30')\n-- =========================================================================\nWITH params AS (\n  SELECT \n    '2026-09-01' AS from_date,\n    '2026-09-30' AS to_date\n)\nSELECT \n  a.emp_code AS \"Code\",\n  COALESCE(s.emp_name_override, a.emp_name) AS \"Name\",\n  a.work_date AS \"Date\",\n  a.status AS \"Status\",\n  a.punch_in AS \"In\",\n  a.punch_out AS \"Out\",\n  a.req_in AS \"Req In\",\n  a.req_out AS \"Req Out\",\n  a.work_minutes AS \"Worked Mins\",\n  CASE WHEN a.is_late=1 AND COALESCE(s.uses_transport,0)=0 THEN 1 ELSE 0 END AS \"Late\",\n  CASE WHEN a.left_early=1 AND COALESCE(s.uses_transport,0)=0 THEN 1 ELSE 0 END AS \"Left Early\",\n  a.source AS \"Source\"\nFROM attendance_raw a\nJOIN params p ON a.work_date BETWEEN p.from_date AND p.to_date\nLEFT JOIN employee_salary s ON a.emp_code = s.emp_code\nWHERE COALESCE(s.is_disabled,0)=0\nORDER BY a.work_date DESC, CAST(a.emp_code AS INTEGER)"
  },

  {
    id: 'def_punctuality',
    title: 'Punctuality Report',
    icon: '⏰',
    sql: "-- =========================================================================\n-- EDIT PARAMETERS BELOW:\n-- Example Reference Dates: 1 to 30 Sept 2026 ('2026-09-01' to '2026-09-30')\n-- =========================================================================\nWITH params AS (\n  SELECT \n    '2026-09-01' AS from_date,\n    '2026-09-30' AS to_date\n)\nSELECT \n  COALESCE(s.emp_name_override, a.emp_name) AS \"Name\",\n  SUM(CASE WHEN a.is_late = 1 AND COALESCE(s.uses_transport,0) = 0 THEN 1 ELSE 0 END) AS \"Late Arrivals\",\n  SUM(CASE WHEN a.left_early = 1 AND COALESCE(s.uses_transport,0) = 0 THEN 1 ELSE 0 END) AS \"Early Leaves\",\n  SUM(CASE WHEN a.status = 'PRESENT' AND COALESCE(s.uses_transport,0) = 0 THEN\n    MAX(0, (CAST(substr(a.punch_in,1,2) AS INT)*60 + CAST(substr(a.punch_in,4,2) AS INT)) - (CAST(substr(a.req_in,1,2) AS INT)*60 + CAST(substr(a.req_in,4,2) AS INT))) +\n    MAX(0, (CAST(substr(a.req_out,1,2) AS INT)*60 + CAST(substr(a.req_out,4,2) AS INT)) - (CAST(substr(a.punch_out,1,2) AS INT)*60 + CAST(substr(a.punch_out,4,2) AS INT)))\n    ELSE 0 END) AS \"Total Late/Early Mins\",\n  SUM(CASE WHEN a.status = 'ABSENT' AND a.work_date NOT IN (SELECT date FROM calendar_days WHERE day_type IN ('HOLIDAY','WEEKLY_OFF')) THEN 1 ELSE 0 END) AS \"Absents\"\nFROM attendance_raw a\nJOIN params p ON a.work_date BETWEEN p.from_date AND p.to_date\nLEFT JOIN employee_salary s ON a.emp_code = s.emp_code\nWHERE COALESCE(s.is_disabled, 0) = 0\nGROUP BY a.emp_code\nORDER BY \"Total Late/Early Mins\" DESC"
  },

  {
    id: 'def_employee_daily',
    title: 'Employee Wise Info',
    icon: '👤',
    sql: "-- =========================================================================\n-- EDIT PARAMETERS BELOW (Change dates or employee name):\n-- Example Dates: '2026-09-01' to '2026-09-30' (1 to 30 Sept reference)\n-- Example Employee Name: '%Alka%' or '%Sharma%' (matches any name containing pattern)\n-- =========================================================================\nWITH params AS (\n  SELECT \n    '2026-09-01' AS from_date,\n    '2026-09-30' AS to_date,\n    '%Alka%'     AS emp_name_pattern\n),\nmatched_emp AS (\n  SELECT emp_code, COALESCE(emp_name_override, emp_name) AS emp_name\n  FROM (\n    SELECT emp_code, emp_name_override, emp_name FROM employee_salary\n    UNION\n    SELECT emp_code, emp_name AS emp_name_override, emp_name FROM attendance_raw\n  ), params\n  WHERE COALESCE(emp_name_override, emp_name) LIKE params.emp_name_pattern\n     OR emp_code LIKE params.emp_name_pattern\n  UNION ALL\n  SELECT emp_code, COALESCE(emp_name_override, emp_name) AS emp_name\n  FROM employee_salary\n),\ntarget_emp AS (\n  SELECT emp_code, emp_name FROM matched_emp LIMIT 1\n),\nemp_days AS (\n  SELECT \n    COALESCE(s.emp_name_override, a.emp_name) AS emp_name,\n    a.emp_code,\n    a.work_date, a.status,\n    COALESCE(a.req_in, '') AS req_in, COALESCE(a.punch_in, '') AS punch_in,\n    COALESCE(a.req_out, '') AS req_out, COALESCE(a.punch_out, '') AS punch_out,\n    CASE \n      WHEN a.req_in IS NOT NULL AND a.req_out IS NOT NULL THEN\n        MAX(0, (CAST(substr(a.req_out,1,2) AS INT)*60 + CAST(substr(a.req_out,4,2) AS INT)) - (CAST(substr(a.req_in,1,2) AS INT)*60 + CAST(substr(a.req_in,4,2) AS INT)))\n      ELSE 0\n    END AS req_mins,\n    COALESCE(a.work_minutes, 0) AS worked_mins,\n    CASE\n      WHEN a.status = 'PRESENT' AND COALESCE(s.uses_transport,0) = 0 THEN\n        MAX(0, (CAST(substr(a.punch_in,1,2) AS INT)*60 + CAST(substr(a.punch_in,4,2) AS INT)) - (CAST(substr(a.req_in,1,2) AS INT)*60 + CAST(substr(a.req_in,4,2) AS INT))) +\n        MAX(0, (CAST(substr(a.req_out,1,2) AS INT)*60 + CAST(substr(a.req_out,4,2) AS INT)) - (CAST(substr(a.punch_out,1,2) AS INT)*60 + CAST(substr(a.punch_out,4,2) AS INT)))\n      ELSE 0\n    END AS late_early_mins\n  FROM attendance_raw a\n  JOIN params p ON a.work_date BETWEEN p.from_date AND p.to_date\n  JOIN target_emp t ON a.emp_code = t.emp_code\n  LEFT JOIN employee_salary s ON a.emp_code = s.emp_code\n)\nSELECT * FROM (\n  SELECT \n    emp_name AS \"Name\", work_date AS \"Date\", status AS \"Status\",\n    req_in AS \"Req In\", punch_in AS \"In\", req_out AS \"Req Out\", punch_out AS \"Out\",\n    req_mins AS \"Required Min\", worked_mins AS \"Worked Min\", late_early_mins AS \"Deducted Mins\"\n  FROM emp_days\n  ORDER BY work_date ASC\n)\nUNION ALL\nSELECT \n  'TOTAL' AS \"Name\", '' AS \"Date\",\n  'Total Absents: ' || CAST(COALESCE(SUM(CASE \n    WHEN ed.status = 'ABSENT' THEN 1\n    WHEN ed.status IN ('HOLIDAY','WEEKLY_OFF') AND (\n      EXISTS (\n        SELECT 1 FROM attendance_raw a_prev\n        WHERE a_prev.emp_code = ed.emp_code\n          AND a_prev.work_date < ed.work_date\n          AND a_prev.status = 'ABSENT'\n          AND NOT EXISTS (\n            SELECT 1 FROM attendance_raw mid\n            WHERE mid.emp_code = ed.emp_code\n              AND mid.work_date > a_prev.work_date\n              AND mid.work_date < ed.work_date\n              AND mid.status NOT IN ('HOLIDAY', 'WEEKLY_OFF')\n          )\n      )\n      OR\n      EXISTS (\n        SELECT 1 FROM attendance_raw a_next\n        WHERE a_next.emp_code = ed.emp_code\n          AND a_next.work_date > ed.work_date\n          AND a_next.status = 'ABSENT'\n          AND NOT EXISTS (\n            SELECT 1 FROM attendance_raw mid\n            WHERE mid.emp_code = ed.emp_code\n              AND mid.work_date > ed.work_date\n              AND mid.work_date < a_next.work_date\n              AND mid.status NOT IN ('HOLIDAY', 'WEEKLY_OFF')\n          )\n      )\n    ) THEN 1\n    ELSE 0\n  END), 0) AS TEXT) AS \"Status\",\n  '' AS \"Req In\", '' AS \"In\", '' AS \"Req Out\", '' AS \"Out\",\n  COALESCE(SUM(req_mins), 0) AS \"Required Min\", COALESCE(SUM(worked_mins), 0) AS \"Worked Min\", COALESCE(SUM(late_early_mins), 0) AS \"Deducted Mins\"\nFROM emp_days ed"
  },

  {
    id: 'def_all_employees_daily',
    title: 'All Staff Daily Breakdown',
    icon: '👥',
    sql: "-- =========================================================================\n-- EDIT PARAMETERS BELOW (Change dates across all staff):\n-- Example Dates: '2026-09-01' to '2026-09-30' (1 to 30 Sept reference)\n-- =========================================================================\nWITH params AS (\n  SELECT \n    '2026-09-01' AS from_date,\n    '2026-09-30' AS to_date\n)\nSELECT \n  COALESCE(s.emp_name_override, a.emp_name) AS \"Name\",\n  a.work_date AS \"Date\", a.status AS \"Status\",\n  COALESCE(a.req_in, '') AS \"Req In\", COALESCE(a.punch_in, '') AS \"In\",\n  COALESCE(a.req_out, '') AS \"Req Out\", COALESCE(a.punch_out, '') AS \"Out\",\n  CASE \n    WHEN a.req_in IS NOT NULL AND a.req_out IS NOT NULL THEN\n      MAX(0, (CAST(substr(a.req_out,1,2) AS INT)*60 + CAST(substr(a.req_out,4,2) AS INT)) - (CAST(substr(a.req_in,1,2) AS INT)*60 + CAST(substr(a.req_in,4,2) AS INT)))\n    ELSE 0\n  END AS \"Required Min\",\n  COALESCE(a.work_minutes, 0) AS \"Worked Min\",\n  CASE\n    WHEN a.status = 'PRESENT' AND COALESCE(s.uses_transport,0) = 0 THEN\n      MAX(0, (CAST(substr(a.punch_in,1,2) AS INT)*60 + CAST(substr(a.punch_in,4,2) AS INT)) - (CAST(substr(a.req_in,1,2) AS INT)*60 + CAST(substr(a.req_in,4,2) AS INT))) +\n      MAX(0, (CAST(substr(a.req_out,1,2) AS INT)*60 + CAST(substr(a.req_out,4,2) AS INT)) - (CAST(substr(a.punch_out,1,2) AS INT)*60 + CAST(substr(a.punch_out,4,2) AS INT)))\n    ELSE 0\n  END AS \"Deducted Mins\"\nFROM attendance_raw a\nJOIN params p ON a.work_date BETWEEN p.from_date AND p.to_date\nLEFT JOIN employee_salary s ON a.emp_code = s.emp_code\nWHERE COALESCE(s.is_disabled, 0) = 0\nORDER BY \"Name\" ASC, a.work_date ASC"
  }
];

function loadCustomReports() {
  var raw=memGet('ap_custom_reports',null);
  if (raw) { try{ State.customReports=typeof raw==='string'?JSON.parse(raw):raw; }catch(e){ State.customReports=[]; } } else State.customReports=[];

  // Force reset IDs that no longer exist in DEFAULT_MACROS (upgrade old saved lists)
  var defIds = DEFAULT_MACROS.map(function(d){return d.id;});
  // Remove any old default macros not in new set
  State.customReports = State.customReports.filter(function(cr){
    return !cr.id.startsWith('def_') || defIds.indexOf(cr.id) >= 0;
  });
  // Ensure all current defaults are present (upsert)
  DEFAULT_MACROS.forEach(function(dm) {
    var existing = State.customReports.find(function(cr){ return cr.id === dm.id; });
    if (existing) { existing.sql = dm.sql; existing.title = dm.title; existing.icon = dm.icon; }
    else { State.customReports.unshift(JSON.parse(JSON.stringify(dm))); }
  });
  if (!State.customReports.length) State.customReports = JSON.parse(JSON.stringify(DEFAULT_MACROS));

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
  // Keep permanent header buttons (salary macros and date-range), clear only dynamic part
  var dynamicDiv = document.getElementById('quick-dynamic');
  if (!dynamicDiv) {
    dynamicDiv = document.createElement('div');
    dynamicDiv.id = 'quick-dynamic';
    c.appendChild(dynamicDiv);
  }
  dynamicDiv.innerHTML = '';
  if (!State.customReports.length) { dynamicDiv.innerHTML='<div style="padding:10px;text-align:center;color:var(--text-dim)">No reports saved</div>'; return; }
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
    }); dynamicDiv.appendChild(o);
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
      var transport = e.uses_transport ? '🚌' : '';
      var tr=document.createElement('tr');
      tr.innerHTML='<td class="tbl-head" style="font-family:monospace">'+escHtml(e.emp_code||'')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;color:var(--text-dim)">'+escHtml(e.emp_name||'')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;'+(name?'font-weight:500':'font-style:italic;color:var(--text-dim)')+'">'+escHtml(name||'not set')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;text-align:right;font-family:monospace">'+(sal?'₹'+Number(sal).toLocaleString():'—')+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;text-align:center">'+transport+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;text-align:center"><label style="cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px"><input type="checkbox" '+disabled+' onchange="toggleEmployeeDisabled(\''+escHtml(e.emp_code)+'\', this.checked)"> Disabled</label></td>'+
        '<td style="padding:5px 8px;text-align:center;white-space:nowrap;">'+
        '<button style="font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer;margin-right:8px" '+
        'data-code="'+escHtml(e.emp_code||'')+'" data-name="'+escHtml(e.emp_name||'')+'" data-override="'+escHtml(name)+'" data-sal="'+sal+'" data-cin="'+escHtml(e.custom_arrival||'')+'" data-cout="'+escHtml(e.custom_departure||'')+'" data-transport="'+(e.uses_transport?'1':'0')+'" onclick="editEmployee(this)">Edit</button>'+
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
  var transport=document.getElementById('emp-uses-transport');
  if (er) er.classList.remove('hidden'); if (el) el.textContent='['+btn.dataset.code+'] '+btn.dataset.name;
  if (fn) fn.value=btn.dataset.override||''; if (sal) sal.value=btn.dataset.sal||'0';
  if (cin) cin.value=btn.dataset.cin||''; if (cout) cout.value=btn.dataset.cout||'';
  if (transport) transport.checked = btn.dataset.transport === '1';
  // Load day overrides for this employee
  loadEmployeeDayOverrides(btn.dataset.code);
}
function cancelEmpEdit() { State.editingEmp=null; var er=document.getElementById('emp-edit-row'); if (er) er.classList.add('hidden'); }
function saveEmployee() {
  var emp=State.editingEmp; if (!emp) return;
  var fn=((document.getElementById('emp-fullname')||{}).value||'').trim();
  var sal=parseFloat((document.getElementById('emp-salary')||{}).value||'0')||0;
  var cin=((document.getElementById('emp-custom-arrival')||{}).value||'').trim();
  var cout=((document.getElementById('emp-custom-departure')||{}).value||'').trim();
  var transport = (document.getElementById('emp-uses-transport')||{}).checked ? 1 : 0;
  apiCall('upsert_employee',emp.code,emp.name,fn,sal,cin,cout,transport)
    .then(function(){ cancelEmpEdit(); loadEmployees(); toast('Employee updated.','ok'); })
    .catch(function(e){ toast('Save failed: '+e.message,'error'); });
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
  var mins = (pIn && pOut) ? diff : 0;
  var status = (pIn || pOut) ? 'PRESENT' : 'ABSENT';
  apiCall('upsert_manual_punch', code, date, pIn, pOut, status, mins, 0, 0, 'Manual')
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
  var firstDay = new Date(y, m-1, 1).getDay();
  var totalDays = new Date(y, m, 0).getDate();
  var offset = firstDay === 0 ? 6 : firstDay - 1;
  for (var i = 0; i < offset; i++) { grid.innerHTML += '<div></div>'; }
  for (var d = 1; d <= totalDays; d++) {
    var dateStr = y + '-' + String(m).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    var dayData = days.find(function(x){ return x.date === dateStr; });
    var type = dayData ? dayData.day_type : '';
    var hasTime = dayData && (dayData.day_in || dayData.day_out);
    var bg = 'bg-[var(--bg-surface)]';
    var text = '';
    if (type === 'WEEKLY_OFF') { bg = 'bg-blue-900/20'; text = '<br/><span class="text-[8px] text-blue-400">OFF</span>'; }
    else if (type === 'HOLIDAY') { bg = 'bg-red-900/20'; text = '<br/><span class="text-[8px] text-red-400">HOLIDAY</span>'; }
    if (hasTime) text += '<br/><span class="text-[8px] text-yellow-400">⏱</span>';
    var btn = document.createElement('div');
    btn.className = 'border border-[var(--border)] rounded py-1 cursor-pointer hover:bg-[var(--bg-muted)] ' + bg;
    btn.innerHTML = d + text;
    btn.title = 'Left-click: cycle type | Right-click: edit times';
    // Left click: cycle WORKING -> WEEKLY_OFF -> HOLIDAY -> normal/remove
    btn.onclick = (function(ds, dd) {
      return function(e) {
        e.preventDefault();
        var t = dd ? dd.day_type : '';
        var nt = '';
        if (!t || t === 'WORKING') nt = 'WEEKLY_OFF';
        else if (t === 'WEEKLY_OFF') nt = 'HOLIDAY';
        else nt = '';
        var din = dd ? dd.day_in : '';
        var dout = dd ? dd.day_out : '';
        apiCall('toggle_calendar_day', ds, nt, din, dout).then(loadCalendar);
      };
    })(dateStr, dayData);
    // Right click: open editor panel

    btn.oncontextmenu = (function(ds, dd) {
      return function(e) {
        e.preventDefault();
        var ed = document.getElementById('cal-day-editor');
        var edDate = document.getElementById('cal-edit-date');
        var edType = document.getElementById('cal-edit-type');
        var edIn  = document.getElementById('cal-edit-in');
        var edOut = document.getElementById('cal-edit-out');
        if (edDate) edDate.textContent = ds;
        if (edType) edType.value = (dd && dd.day_type) || '';
        if (edIn)  edIn.value  = (dd && dd.day_in)  || '';
        if (edOut) edOut.value = (dd && dd.day_out) || '';
        ed.dataset.editDate = ds;
        if (ed) ed.classList.remove('hidden');
      };
    })(dateStr, dayData);
    grid.appendChild(btn);
  }
}
function saveCalendarDay() {
  var ed = document.getElementById('cal-day-editor');
  var ds   = ed ? ed.dataset.editDate : '';
  var type = ((document.getElementById('cal-edit-type')||{}).value||'');
  var din  = ((document.getElementById('cal-edit-in')||{}).value||'').trim();
  var dout = ((document.getElementById('cal-edit-out')||{}).value||'').trim();
  if (!ds) return;
  apiCall('toggle_calendar_day', ds, type, din, dout).then(function(){
    loadCalendar();
    document.getElementById('cal-day-editor').classList.add('hidden');
    toast('Day saved.', 'ok');
  }).catch(function(e){ toast(e.message, 'error'); });
}


/* ── EMPLOYEE DAY OVERRIDES ─────────────────────────────────── */
function loadEmployeeDayOverrides(empCode) {
  if (!empCode) return;
  var list = document.getElementById('emp-override-list');
  if (!list) return;
  apiCall('get_employee_day_overrides', empCode).then(function(overrides) {
    list.innerHTML = '';
    if (!overrides || !overrides.length) {
      list.innerHTML = '<div style="font-size:10px;color:var(--text-dim);padding:2px 0">No day-specific overrides set.</div>';
      return;
    }
    overrides.forEach(function(ov) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text-body);padding:1px 0';
      row.innerHTML = '<span style="font-family:monospace;color:var(--accent)">' + escHtml(ov.date) + '</span>' +
        '<span>' + escHtml(ov.custom_in || '—') + ' → ' + escHtml(ov.custom_out || '—') + '</span>' +
        '<button style="font-size:10px;color:var(--danger);background:none;border:none;cursor:pointer" ' +
        'onclick="deleteEmpDayOverride(\'' + escHtml(State.editingEmp && State.editingEmp.code || '') + '\',\'' + escHtml(ov.date) + '\')">✕</button>';
      list.appendChild(row);
    });
  }).catch(function() {});
}
function saveEmployeeDayOverride() {
  var emp = State.editingEmp; if (!emp) return toast('Select an employee to edit first.', 'error');
  var d   = ((document.getElementById('emp-override-date')||{}).value||'').trim();
  var cin = ((document.getElementById('emp-override-in')||{}).value||'').trim();
  var cout= ((document.getElementById('emp-override-out')||{}).value||'').trim();
  if (!d) return toast('Please select a date.', 'error');
  apiCall('upsert_employee_day_override', emp.code, d, cin, cout)
    .then(function() { loadEmployeeDayOverrides(emp.code); toast('Day override saved.', 'ok'); })
    .catch(function(e) { toast(e.message, 'error'); });
}
function deleteEmpDayOverride(empCode, dateStr) {
  apiCall('delete_employee_day_override', empCode, dateStr)
    .then(function() { loadEmployeeDayOverrides(empCode); toast('Override removed.', 'ok'); })
    .catch(function(e) { toast(e.message, 'error'); });
}

/* ── MONTHLY SALARY MACROS ──────────────────────────────────── */
function runMonthlySalary(monthOffset) {
  var now = new Date();
  var y = now.getFullYear();
  var m = now.getMonth() + 1 + parseInt(monthOffset || 0);
  if (m < 1)  { m += 12; y -= 1; }
  if (m > 12) { m -= 12; y += 1; }
  var monthName = ['January','February','March','April','May','June','July',
                   'August','September','October','November','December'][m-1];
  var title = monthName + ' ' + y + ' Salary Report';
  setSqlStatus('Computing salary…', 'info');
  apiCall('run_salary_report', y, m).then(function(res) {
    if (!res || !res.columns || !res.columns.length) {
      toast('No salary data found for ' + monthName + ' ' + y, 'warning');
      setSqlStatus('No data.', 'warning');
      return;
    }
    setSqlStatus('✓ ' + (res.count > 1 ? res.count - 1 : res.count) + ' employees', 'ok');
    showResults(res.columns, res.rows, title);
    var srStatus = (State.settings && State.settings.sandwich_rule === 'no') ? 'disabled' : 'applied';
    State.lastSqlDisplay = '-- ' + title + '\n' +
      '-- Salary Engine Formulas:\n' +
      '-- • Per-Minute Rate = Base Salary / Total Required Minutes\n' +
      '-- • Earned Amount = Per-Minute Rate × Payable Minutes (Worked + Holiday + Leave Credit)\n' +
      '-- • Deducted Minutes = Absent Minutes + Late/Early Minutes\n' +
      '-- • Deducted Amount = Deducted Minutes × Per-Minute Rate\n' +
      '-- • Sandwich rule (' + srStatus + '), transport exemption applied.';
    setSqlEditor(State.lastSqlDisplay);
  }).catch(function(e) {
    setSqlStatus('✗ ' + e.message, 'error');
    toast(e.message, 'error');
  });
}

function openDateRangeSalary() {
  // Pre-fill with current month start/end
  var now = new Date();
  var y = now.getFullYear(), m = now.getMonth();
  var firstDay = new Date(y, m, 1).toISOString().slice(0,10);
  var lastDay  = new Date(y, m+1, 0).toISOString().slice(0,10);
  var df = document.getElementById('drs-from'), dt = document.getElementById('drs-to');
  if (df) df.value = firstDay;
  if (dt) dt.value = lastDay;
  openModal('modal-date-salary');
}

function runDateRangeSalary() {
  var fromVal = (document.getElementById('drs-from') || {}).value || '';
  var toVal   = (document.getElementById('drs-to')   || {}).value || '';
  if (!fromVal || !toVal) { toast('Please select both From and To dates.', 'error'); return; }
  var fromDate = new Date(fromVal), toDate = new Date(toVal);
  if (fromDate > toDate) { toast('From date must be before To date.', 'error'); return; }

  // Collect all year/month combos in range
  var months = [];
  var cur = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
  var end = new Date(toDate.getFullYear(), toDate.getMonth(), 1);
  while (cur <= end) {
    months.push({ y: cur.getFullYear(), m: cur.getMonth() + 1 });
    cur.setMonth(cur.getMonth() + 1);
  }

  closeModal();
  setSqlStatus('Computing date range salary…', 'info');

  // Run salary for each month and merge
  var promises = months.map(function(mo) {
    return apiCall('run_salary_report', mo.y, mo.m).then(function(res) {
      if (!res || !res.rows) return [];
      // Tag each non-TOTAL row with month
      return res.rows.filter(function(r) { return r['Name'] !== 'TOTAL'; }).map(function(r) {
        return Object.assign({}, r, { month: mo.y + '-' + String(mo.m).padStart(2,'0') });
      });
    });
  });

  Promise.all(promises).then(function(allRows) {
    var combined = [].concat.apply([], allRows);
    if (!combined.length) { toast('No data found for selected range.', 'warning'); setSqlStatus('No data.', 'warning'); return; }

    // Sort combined rows alphabetically by Name
    combined.sort(function(a, b) {
      return String(a['Name']||'').localeCompare(String(b['Name']||''));
    });

    var totSal = 0, totEarn = 0, totDed = 0, totAbsent = 0;
    combined.forEach(function(r) {
      totSal += parseFloat(String(r['Salary']||'').replace(/[₹,\/-]/g, '')) || 0;
      totEarn += parseFloat(String(r['Earned']||'').replace(/[₹,\/-]/g, '')) || 0;
      totDed += parseFloat(String(r['Deducted Amount']||'').replace(/[₹,\/-]/g, '')) || 0;
      totAbsent += parseInt(r['Absent']) || 0;
    });

    var totalRow = {
      'month': '',
      'Code': '',
      'Name': 'TOTAL',
      'Salary': '₹' + totSal.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2}) + '/-',
      'Working Days': '',
      'Absent': totAbsent,
      'Req Minutes': '',
      'Worked Mins': '',
      'Holiday Mins': '',
      'Leave Credit Mins': '',
      'Payable Mins': '',
      'Per Min Rate': '',
      'Earned': '₹' + totEarn.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2}) + '/-',
      'Deducted Mins': '',
      'Deducted Amount': '₹' + totDed.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2}) + '/-'
    };
    combined.push(totalRow);

    var cols = ['month'].concat(Object.keys(combined[0]).filter(function(k){ return k !== 'month'; }));
    var title = 'Salary: ' + fromVal + ' → ' + toVal;
    setSqlStatus('✓ ' + (combined.length - 1) + ' records', 'ok');
    showResults(cols, combined, title);
    State.lastSqlDisplay = '-- Date Range Salary: ' + fromVal + ' to ' + toVal + '\n' +
      '-- Salary Engine Formulas:\n' +
      '-- • Per-Minute Rate = Base Salary / Total Required Minutes\n' +
      '-- • Earned Amount = Per-Minute Rate × Payable Minutes (Worked + Holiday + Leave Credit)\n' +
      '-- • Deducted Minutes = Absent Minutes + Late/Early Minutes\n' +
      '-- • Deducted Amount = Deducted Minutes × Per-Minute Rate\n' +
      '-- Months: ' + months.map(function(m){return m.y+'-'+m.m;}).join(', ');
    setSqlEditor(State.lastSqlDisplay);
  }).catch(function(e) {
    setSqlStatus('✗ ' + e.message, 'error');
    toast(e.message, 'error');
  });
}

function openSchemaInfoModal() {
  var content = `=== ATTENDANCE PROCESSOR PRO V17 (ZENITH) — AI AGENT SCHEMA REFERENCE ===

PURPOSE: Use this to understand how to write correct SQL queries for this database.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TABLE: attendance_raw
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
id               INTEGER  Primary key
report_file      TEXT     Source Excel filename
report_period_start DATE  Period start from the Excel header
report_period_end   DATE  Period end from the Excel header
company_name     TEXT     Company from Excel
emp_code         TEXT     Employee code (always numeric string, e.g. '42')
emp_name         TEXT     Name from the Excel file
work_date        DATE     YYYY-MM-DD format
status           TEXT     One of: PRESENT | ABSENT | WEEKLY_OFF | HALF_DAY
punch_in         TEXT     HH:MM or NULL
punch_out        TEXT     HH:MM or NULL
work_hours       REAL     Hours worked (legacy, use work_minutes instead)
work_minutes     INTEGER  Minutes actually worked (primary column)
is_late          INTEGER  1 if punch_in > late_threshold, else 0
left_early       INTEGER  1 if punch_out < early_leave_threshold, else 0
source           TEXT     'excel' or 'manual'

UNIQUE KEY: (emp_code, work_date, report_file)
NOTE: Use status='PRESENT' to find attendance. Any punch = PRESENT.
ABSENT = no punch at all. WEEKLY_OFF = file marked WO.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TABLE: employee_salary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
emp_code          TEXT PRIMARY KEY
emp_name          TEXT     Original name from Excel
emp_name_override TEXT     User-set display name (use COALESCE with emp_name)
monthly_salary    REAL     Base monthly salary in ₹
custom_arrival    TEXT     Employee-specific required in time HH:MM (overrides global)
custom_departure  TEXT     Employee-specific required out time HH:MM (overrides global)
uses_transport    INTEGER  1=uses school bus (exempt from late/early deductions)
is_disabled       INTEGER  1=excluded from all reports
updated_at        DATETIME

ALWAYS JOIN:
  LEFT JOIN employee_salary s ON a.emp_code = s.emp_code
  WHERE COALESCE(s.is_disabled,0)=0

GET DISPLAY NAME:
  COALESCE(s.emp_name_override, a.emp_name) AS "Name"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TABLE: employee_day_overrides
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
emp_code   TEXT     (references employee_salary)
date       DATE     YYYY-MM-DD
custom_in  TEXT     HH:MM — required arrival for this day
custom_out TEXT     HH:MM — required departure for this day
PRIMARY KEY (emp_code, date)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TABLE: calendar_days
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
date      DATE     PRIMARY KEY
day_type  TEXT     'HOLIDAY' or 'WEEKLY_OFF'
day_in    TEXT     HH:MM — required in time for all staff on this day
day_out   TEXT     HH:MM — required out time for all staff on this day

USE: WHERE a.work_date NOT IN (SELECT date FROM calendar_days WHERE day_type IN ('HOLIDAY','WEEKLY_OFF'))
     → filters out holidays and weekly-offs from absent counts

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TABLE: app_settings (key/value store)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
key                     | typical value
checkin_time            | '09:00'
checkout_time           | '15:30'
late_threshold          | '09:15'
early_leave_threshold   | '15:30'
sandwich_rule           | 'yes' or 'no' (default 'yes')
holidays_paid           | 'yes' or 'no'
weeklyoff_paid          | 'yes' or 'no'
org_name                | School name string

READ: SELECT value FROM app_settings WHERE key='checkin_time'
CTX:  COALESCE((SELECT value FROM app_settings WHERE key='checkin_time'),'09:00')

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TABLE: query_log
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
id, sql_text, ran_at, row_count, source — auto-populated

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMMON QUERY PATTERNS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- All present employees on a specific date:
SELECT emp_code, emp_name, punch_in, punch_out, work_minutes
FROM attendance_raw
WHERE work_date='2026-09-15' AND status='PRESENT';

-- Employees absent on working days (not holidays):
SELECT emp_code, emp_name, work_date FROM attendance_raw
WHERE status='ABSENT'
  AND work_date NOT IN (SELECT date FROM calendar_days WHERE day_type IN ('HOLIDAY','WEEKLY_OFF'));

-- Monthly attendance count per employee:
SELECT emp_code, COUNT(CASE WHEN status='PRESENT' THEN 1 END) AS present,
       COUNT(CASE WHEN status='ABSENT' THEN 1 END) AS absent
FROM attendance_raw
WHERE strftime('%Y-%m', work_date)='2026-09'
GROUP BY emp_code;

-- Late arrivals (excluding bus employees):
SELECT a.emp_code, a.emp_name, a.work_date, a.punch_in
FROM attendance_raw a
LEFT JOIN employee_salary s ON a.emp_code=s.emp_code
WHERE a.is_late=1 AND COALESCE(s.uses_transport,0)=0;

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
API METHODS (Python → JS bridge via window.pywebview.api)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
run_salary_report(year, month)       → Full salary computation for a month
run_filter(filters_json, ...)        → Filter builder query with GROUP BY support
run_sql(sql)                         → Execute any SELECT query
get_employees()                      → All employee records
upsert_employee(code,name,override,salary,in,out,transport)
get_calendar_days(year, month)       → Calendar entries with day_in/day_out
toggle_calendar_day(date,type,in,out)
upsert_employee_day_override(code,date,in,out)
get_employee_day_overrides(emp_code)
import_file(filepath, overwrite)     → Parse & import Excel attendance file
export_pdf_html(...)                 → Chromium Paged Media engine with custom CSS
export_pdf(...)                      → Fast native Rust vector exporter
export_csv(columns,rows,path)
get_settings() / save_settings(obj)
get_query_log() / clear_query_log()
get_holidays_and_custom_timings()   → Calendar days with holiday/custom in/out timings

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMPORTANT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. emp_code is TEXT but numerically sortable: ORDER BY CAST(emp_code AS INTEGER)
2. Only SELECT queries are allowed in the SQL editor (no INSERT/UPDATE/DELETE)
3. work_minutes = actual worked minutes (int). work_hours = legacy float (hours).
4. PRESENT = any punch. ABSENT = no punch at all for that date.
5. uses_transport=1 employees are EXEMPT from is_late/left_early salary docks.
6. The Sandwich Rule: absent days adjacent to holidays/weekly-offs expand the deduction block. Configurable in Settings (on/off).
7. 4-tier Priority for required in/out times:
   Day-Specific Time Override (Staff Directory) >
   Employee Custom Arrival/Departure (Staff Directory) >
   Calendar Day Required Time (Calendar Settings) >
   General Settings (Check-in/Check-out).
8. PDF Status Badges & Styles:
   Present = Green (.status-present), Absent = Red (.status-absent),
   Weekly-Off/Holiday = Blue (.status-weeklyoff),
   Sandwich-absorbed days = Red (.status-sandwich with dashed border).
   Alternating row contrast configured via --row-alt.
9. V17 Exact Mathematical Balance Invariant:
   Payable Mins + Deducted Mins ≡ Total Required Minutes.
   Earned Amount + Deducted Amount ≡ Base Monthly Salary.
   Deducted Amount = round(Deducted Mins × Per-Minute Rate, 2).
   Net Absent Mins = max(0, Gross Absent Mins - Leave Credit Mins).
   Shortfall on present/half-days = max(0, Required Shift - Worked Mins).
10. V17 Contiguous Sandwich Multi-Day Rule:
   If an absence is adjacent to a sequence of holidays/weekly-offs, ALL contiguous
   holidays/weekdays in that block are absorbed under the sandwich rule and marked in Red.
   Absorbed days are included in the Absent count across all 3 salary reports (This Month,
   Previous Month, Date Range) and the Employee Wise Info macro total row.`;


  var el = document.getElementById('schema-ai-content');
  if (el) el.textContent = content;
  openModal('modal-schema-info');
  copyToClipboard(content, '✓ Schema & SQL instructions copied to clipboard!');
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
/* ── PDF Export Pipeline (V14.4 Ultra Dev Mode) ────────────────────────── */
var _pdfDefaultDir = '';
var _pdfCustomCss = '';
var _pdfDevMode = false;

function exportPdf() {
  var cols = (typeof State !== 'undefined' && State.results && State.results.columns) ? State.results.columns : [];
  var rows = (typeof State !== 'undefined' && State.results && State.results.rows) ? State.results.rows : [];
  if (!rows.length && (!window._lastResults || !window._lastResults.rows || !window._lastResults.rows.length)) {
    toast('Run a query or report first to have data to export.', 'warning');
    return;
  }

  // Sync to global _lastResults for dev mode
  if (typeof State !== 'undefined' && State.results) {
    window._lastResults = State.results;
    window._lastResultCols = State.results.columns;
    window._lastResultRows = State.results.rows;
    apiCall('set_last_results', State.results.columns, State.results.rows).catch(function(){});
  }

  // Pre-fill the title with active report title
  var titleEl = document.getElementById('pdf-title');
  if (titleEl) {
    var autoTitle = (typeof State !== 'undefined' && State.results && State.results.title)
      ? State.results.title
      : 'Attendance Report';
    titleEl.value = autoTitle;
    var qLbl = document.getElementById('pdf-include-query-label');
    if (qLbl) {
      qLbl.textContent = (autoTitle.toLowerCase().indexOf('salary') >= 0)
        ? 'Include Salary calculation formula at bottom'
        : 'Include SQL query at the bottom';
    }
  }

  // Fill the save path with stored default or request one from backend
  var pathEl = document.getElementById('pdf-save-path');
  if (pathEl) {
    if (_pdfDefaultDir) {
      pathEl.value = _pdfDefaultDir;
    } else {
      apiCall('get_default_downloads_dir').then(function(dir) {
        if (dir) { _pdfDefaultDir = dir; pathEl.value = dir; }
      }).catch(function() {});
    }
  }

  // Pre-fill CSS editor with saved default CSS
  var cssEl = document.getElementById('pdf-custom-css');
  if (cssEl) cssEl.value = _pdfCustomCss;

  // Show/hide CSS section based on dev mode
  var cssSection = document.getElementById('pdf-css-section');
  if (cssSection) cssSection.classList.toggle('hidden', !_pdfDevMode);

  // Default to HTML mode so rich templates, presets, and scaling are active
  var useHtmlEl = document.getElementById('pdf-use-html');
  if (useHtmlEl) useHtmlEl.checked = true;

  openModal('modal-pdf-export');
}

var PDF_PRESETS = {
  'executive': `/* ==========================================================================
   🏢 EXECUTIVE SLATE — Complete Style Template
   Inspired by Document_Template.html — High Data Density & Clean Elegance
   ========================================================================== */
:root {
  --paper: #ffffff;
  --screen-bg: #e7ebf0;
  --navy: #0f172a;
  --navy-light: #1e293b;
  --gold: #b7791f;
  --accent: #b7791f;
  --text: #111827;
  --muted: #64748b;
  --border: #cbd5e1;
  --border-light: #e2e8f0;
  --border-dark: #94a3b8;
  --row-alt: #f1f5f9;
  --table-head-bg: #0f172a;
  --table-head-text: #ffffff;
  --header-bg: #f8fafc;
  --data-font-weight: 400;
}

.pdf-page-sheet, .page {
  background: var(--paper);
  color: var(--text);
  font-family: "Libron", Georgia, serif;
}
.document-frame {
  border: 1.2px solid #9ca8b7;
}
.document-frame::after {
  border: 0.5px solid #e1e6eb;
}

.school-header, .masthead {
  background: var(--header-bg);
  border: 1px solid var(--border);
  border-top: 3px solid var(--gold);
  border-radius: 10px;
  padding: 12px 20px;
  margin-bottom: 14px;
}
.school-logo, .report-logo {
  width: 60px;
  height: 60px;
}
.school-info h2, .org-title {
  color: var(--navy);
  font-family: "Libron", Georgia, serif;
  font-size: 21px;
  font-weight: 800;
  letter-spacing: -0.01em;
}

.document-heading {
  border-bottom: 2px solid var(--navy);
  padding: 2px 0 10px;
  margin-bottom: 14px;
}
.heading-accent {
  background: var(--gold);
  width: 48px;
  height: 3px;
  border-radius: 4px;
}
.title, .report-title {
  color: var(--navy);
  font-family: "Libron", Georgia, serif;
  font-size: 22px;
  font-weight: 800;
}

.data-table-wrap {
  margin-bottom: 12px;
}
.data-table {
  background: var(--paper, #ffffff);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 8.5pt;
  line-height: 1.3;
}
.data-table thead th {
  background: var(--table-head-bg);
  color: var(--table-head-text);
  border-bottom: 2px solid var(--gold);
  padding: 6px 7px;
  font-size: 8pt;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.data-table tbody td {
  padding: 5px 7px;
  border-bottom: 1px solid var(--border-light);
  color: var(--text);
  font-variant-numeric: tabular-nums;
  word-break: break-word;
  background: #ffffff;
}
.data-table tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.data-table tbody tr:hover td {
  background: #f1f5f9;
}

.report-footer {
  border-top: 1px solid var(--border-light);
  color: var(--muted);
  font-size: 7.5pt;
  padding-top: 8px;
  margin-top: 10px;
}

.status-cell {
  display: inline-block;
  font-weight: 700;
  border-radius: 4px;
  padding: 1.5px 6px;
  font-size: 7.5pt;
  line-height: 1.25;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.status-present {
  color: #15803d !important;
  background: #dcfce7 !important;
  border: 1px solid #86efac;
}
.status-absent {
  color: #b91c1c !important;
  background: #fee2e2 !important;
  border: 1px solid #fca5a5;
}
.status-weeklyoff, .status-holiday {
  color: #1d4ed8 !important;
  background: #dbeafe !important;
  border: 1px solid #93c5fd;
}
.status-sandwich {
  color: #b91c1c !important;
  background: #fee2e2 !important;
  border: 1px dashed #ef4444;
  font-weight: 800;
}
.status-halfday {
  color: #b45309 !important;
  background: #fef3c7 !important;
  border: 1px solid #fde68a;
}`,

  'minimal': `/* ==========================================================================
   📰 FINANCIAL MINIMAL — Complete Style Template
   High-Clarity Monospace Tabular Design with Crisp Borders
   ========================================================================== */
:root {
  --paper: #ffffff;
  --navy: #1e293b;
  --navy-light: #334155;
  --gold: #64748b;
  --accent: #64748b;
  --text: #0f172a;
  --muted: #64748b;
  --border: #cbd5e1;
  --border-light: #e2e8f0;
  --border-dark: #94a3b8;
  --row-alt: #f1f5f9;
  --table-head-bg: #f1f5f9;
  --table-head-text: #0f172a;
  --header-bg: #ffffff;
  --data-font-weight: 400;
}

.pdf-page-sheet, .page {
  background: var(--paper);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.document-frame {
  border: 1px solid #cbd5e1;
}
.document-frame::after {
  display: none;
}

.school-header, .masthead {
  background: var(--header-bg);
  border: 1px solid var(--border);
  border-top: 3px solid var(--navy);
  border-radius: 6px;
  padding: 10px 18px;
  margin-bottom: 12px;
}
.school-info h2, .org-title {
  color: var(--navy);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.document-heading {
  border-bottom: 1.5px solid var(--border);
  padding: 2px 0 8px;
  margin-bottom: 12px;
}
.heading-accent {
  background: var(--navy);
  width: 36px;
  height: 2px;
}
.title, .report-title {
  color: var(--navy);
  font-size: 20px;
  font-weight: 700;
}

.data-table-wrap {
  margin-bottom: 12px;
}
.data-table {
  background: var(--paper, #ffffff);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 8pt;
  line-height: 1.35;
}
.data-table thead th {
  background: var(--table-head-bg);
  color: var(--table-head-text);
  border-bottom: 2px solid #94a3b8;
  padding: 5.5px 7px;
  font-size: 7.5pt;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.data-table tbody td {
  padding: 4.5px 7px;
  border-bottom: 1px solid var(--border-light);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  word-break: break-word;
  background: #ffffff;
}
.data-table tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.data-table tbody tr:hover td {
  background: #f1f5f9;
}

.report-footer {
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 7pt;
  padding-top: 6px;
  margin-top: 8px;
  font-family: ui-monospace, monospace;
}

.status-cell {
  display: inline-block;
  font-weight: 700;
  border-radius: 4px;
  padding: 1.5px 6px;
  font-size: 7.5pt;
  line-height: 1.25;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.status-present {
  color: #15803d !important;
  background: #dcfce7 !important;
  border: 1px solid #86efac;
}
.status-absent {
  color: #b91c1c !important;
  background: #fee2e2 !important;
  border: 1px solid #fca5a5;
}
.status-weeklyoff, .status-holiday {
  color: #1d4ed8 !important;
  background: #dbeafe !important;
  border: 1px solid #93c5fd;
}
.status-sandwich {
  color: #b91c1c !important;
  background: #fee2e2 !important;
  border: 1px dashed #ef4444;
  font-weight: 800;
}
.status-halfday {
  color: #b45309 !important;
  background: #fef3c7 !important;
  border: 1px solid #fde68a;
}`,

  'emerald': `/* ==========================================================================
   🌲 EMERALD CORPORATE — Complete Style Template
   Prestigious Deep Forest Emerald with Mint Accents
   ========================================================================== */
:root {
  --paper: #ffffff;
  --navy: #064e3b;
  --navy-light: #065f46;
  --gold: #059669;
  --accent: #059669;
  --text: #062b21;
  --muted: #047857;
  --border: #a7f3d0;
  --border-light: #d1fae5;
  --border-dark: #6ee7b7;
  --row-alt: #e6fcf0;
  --table-head-bg: #064e3b;
  --table-head-text: #ffffff;
  --header-bg: #f0fdf4;
  --data-font-weight: 400;
}

.pdf-page-sheet, .page {
  background: var(--paper);
  color: var(--text);
  font-family: "Libron", Georgia, serif;
}
.document-frame {
  border: 1.2px solid #6ee7b7;
}
.document-frame::after {
  border: 0.5px solid #a7f3d0;
}

.school-header, .masthead {
  background: var(--header-bg);
  border: 1px solid var(--border);
  border-top: 3px solid #059669;
  border-radius: 10px;
  padding: 12px 20px;
  margin-bottom: 14px;
}
.school-info h2, .org-title {
  color: var(--navy);
  font-family: "Libron", Georgia, serif;
  font-size: 21px;
  font-weight: 800;
}
.document-heading {
  border-bottom: 2px solid var(--navy);
  padding: 2px 0 10px;
  margin-bottom: 14px;
}
.heading-accent {
  background: #059669;
  width: 48px;
  height: 3px;
  border-radius: 4px;
}
.title, .report-title {
  color: var(--navy);
  font-family: "Libron", Georgia, serif;
  font-size: 22px;
  font-weight: 800;
}

.data-table-wrap {
  margin-bottom: 12px;
}
.data-table {
  background: var(--paper, #ffffff);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 8.5pt;
  line-height: 1.3;
}
.data-table thead th {
  background: var(--table-head-bg);
  color: var(--table-head-text);
  border-bottom: 2px solid #059669;
  padding: 6px 7px;
  font-size: 8pt;
  font-weight: 700;
  text-transform: uppercase;
}
.data-table tbody td {
  padding: 5px 7px;
  border-bottom: 1px solid var(--border-light);
  color: var(--text);
  font-variant-numeric: tabular-nums;
  word-break: break-word;
  background: #ffffff;
}
.data-table tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.data-table tbody tr:hover td {
  background: #e6fcf0;
}

.report-footer {
  border-top: 1px solid var(--border);
  color: #065f46;
  font-size: 7.5pt;
  padding-top: 8px;
  margin-top: 10px;
}

.status-cell {
  display: inline-block;
  font-weight: 700;
  border-radius: 4px;
  padding: 1.5px 6px;
  font-size: 7.5pt;
  line-height: 1.25;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.status-present {
  color: #15803d !important;
  background: #dcfce7 !important;
  border: 1px solid #86efac;
}
.status-absent {
  color: #b91c1c !important;
  background: #fee2e2 !important;
  border: 1px solid #fca5a5;
}
.status-weeklyoff, .status-holiday {
  color: #1d4ed8 !important;
  background: #dbeafe !important;
  border: 1px solid #93c5fd;
}
.status-sandwich {
  color: #b91c1c !important;
  background: #fee2e2 !important;
  border: 1px dashed #ef4444;
  font-weight: 800;
}
.status-halfday {
  color: #b45309 !important;
  background: #fef3c7 !important;
  border: 1px solid #fde68a;
}`,

  'tech': `/* ==========================================================================
   🟣 MODERN TECH — Complete Style Template
   Indigo & Violet Executive Theme Inspired by Stripe and Linear
   ========================================================================== */
:root {
  --paper: #ffffff;
  --navy: #312e81;
  --navy-light: #3730a3;
  --gold: #6366f1;
  --accent: #6366f1;
  --text: #1e1b4b;
  --muted: #6366f1;
  --border: #c7d2fe;
  --border-light: #e0e7ff;
  --border-dark: #a5b4fc;
  --row-alt: #f3f0ff;
  --table-head-bg: #312e81;
  --table-head-text: #ffffff;
  --header-bg: #f5f3ff;
  --data-font-weight: 400;
}

.pdf-page-sheet, .page {
  background: var(--paper);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.document-frame {
  border: 1.2px solid #a5b4fc;
}
.document-frame::after {
  border: 0.5px solid #c7d2fe;
}

.school-header, .masthead {
  background: var(--header-bg);
  border: 1px solid var(--border);
  border-top: 3px solid #6366f1;
  border-radius: 10px;
  padding: 12px 20px;
  margin-bottom: 14px;
}
.school-info h2, .org-title {
  color: var(--navy);
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.02em;
}
.document-heading {
  border-bottom: 2px solid var(--navy);
  padding: 2px 0 10px;
  margin-bottom: 14px;
}
.heading-accent {
  background: #6366f1;
  width: 44px;
  height: 3px;
  border-radius: 4px;
}
.title, .report-title {
  color: var(--navy);
  font-size: 21px;
  font-weight: 800;
}

.data-table-wrap {
  margin-bottom: 12px;
}
.data-table {
  background: var(--paper, #ffffff);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 8.5pt;
  line-height: 1.3;
}
.data-table thead th {
  background: var(--table-head-bg);
  color: var(--table-head-text);
  border-bottom: 2px solid #6366f1;
  padding: 6px 7px;
  font-size: 8pt;
  font-weight: 700;
  text-transform: uppercase;
}
.data-table tbody td {
  padding: 5px 7px;
  border-bottom: 1px solid var(--border-light);
  color: var(--text);
  font-variant-numeric: tabular-nums;
  word-break: break-word;
  background: #ffffff;
}
.data-table tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.data-table tbody tr:hover td {
  background: #ede9fe;
}

.report-footer {
  border-top: 1px solid var(--border);
  color: #4338ca;
  font-size: 7.5pt;
  padding-top: 8px;
  margin-top: 10px;
}

.status-cell {
  display: inline-block;
  font-weight: 700;
  border-radius: 4px;
  padding: 1.5px 6px;
  font-size: 7.5pt;
  line-height: 1.25;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.status-present {
  color: #15803d !important;
  background: #dcfce7 !important;
  border: 1px solid #86efac;
}
.status-absent {
  color: #b91c1c !important;
  background: #fee2e2 !important;
  border: 1px solid #fca5a5;
}
.status-weeklyoff, .status-holiday {
  color: #1d4ed8 !important;
  background: #dbeafe !important;
  border: 1px solid #93c5fd;
}
.status-sandwich {
  color: #b91c1c !important;
  background: #fee2e2 !important;
  border: 1px dashed #ef4444;
  font-weight: 800;
}
.status-halfday {
  color: #b45309 !important;
  background: #fef3c7 !important;
  border: 1px solid #fde68a;
}`,

  'compact': `/* ==========================================================================
   📏 DENSE COMPACT — Complete Style Template
   Engineered for Maximum Data Density (7-12 Columns on A4 Portrait)
   ========================================================================== */
:root {
  --paper: #ffffff;
  --navy: #0f172a;
  --navy-light: #1e293b;
  --gold: #b7791f;
  --accent: #b7791f;
  --text: #0f172a;
  --muted: #64748b;
  --border: #cbd5e1;
  --border-light: #e2e8f0;
  --border-dark: #94a3b8;
  --row-alt: #f1f5f9;
  --table-head-bg: #0f172a;
  --table-head-text: #ffffff;
  --header-bg: #f8fafc;
  --data-font-weight: 400;
}

.pdf-page-sheet, .page {
  background: var(--paper);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  padding: 8mm 10mm;
}
.document-frame {
  border: 1px solid #cbd5e1;
}

.school-header, .masthead {
  background: var(--header-bg);
  border: 1px solid var(--border);
  border-top: 2.5px solid var(--gold);
  border-radius: 6px;
  padding: 8px 14px;
  margin-bottom: 8px;
}
.school-info h2, .org-title {
  color: var(--navy);
  font-size: 16px;
  font-weight: 700;
}
.document-heading {
  border-bottom: 1.5px solid var(--navy);
  padding: 1px 0 6px;
  margin-bottom: 8px;
}
.heading-accent {
  background: var(--gold);
  width: 36px;
  height: 2px;
}
.title, .report-title {
  color: var(--navy);
  font-size: 17px;
  font-weight: 700;
}

.data-table-wrap {
  margin-bottom: 8px;
}
.data-table {
  background: var(--paper, #ffffff);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 8pt;
  line-height: 1.25;
}
.data-table thead th {
  background: var(--table-head-bg);
  color: var(--table-head-text);
  border-bottom: 1.5px solid var(--gold);
  padding: 4px 5px;
  font-size: 7.5pt;
  font-weight: 700;
  text-transform: uppercase;
}
.data-table tbody td {
  padding: 3.5px 5px;
  border-bottom: 1px solid var(--border-light);
  color: var(--text);
  font-variant-numeric: tabular-nums;
  word-break: break-word;
  background: #ffffff;
}
.data-table tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.data-table tbody tr:hover td {
  background: #f1f5f9;
}

.report-footer {
  border-top: 1px solid var(--border-light);
  color: var(--muted);
  font-size: 7pt;
  padding-top: 5px;
  margin-top: 6px;
}

.status-cell {
  display: inline-block;
  font-weight: 700;
  border-radius: 4px;
  padding: 1.5px 6px;
  font-size: 7.5pt;
  line-height: 1.25;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.status-present {
  color: #15803d !important;
  background: #dcfce7 !important;
  border: 1px solid #86efac;
}
.status-absent {
  color: #b91c1c !important;
  background: #fee2e2 !important;
  border: 1px solid #fca5a5;
}
.status-weeklyoff, .status-holiday {
  color: #1d4ed8 !important;
  background: #dbeafe !important;
  border: 1px solid #93c5fd;
}
.status-sandwich {
  color: #b91c1c !important;
  background: #fee2e2 !important;
  border: 1px dashed #ef4444;
  font-weight: 800;
}
.status-halfday {
  color: #b45309 !important;
  background: #fef3c7 !important;
  border: 1px solid #fde68a;
}`,
};
window.PDF_PRESETS = PDF_PRESETS;

function applyPdfPreset(name) {
  if (!PDF_PRESETS[name]) return;
  var cssText = PDF_PRESETS[name];
  var useHtml = document.getElementById('pdf-use-html');
  if (useHtml) useHtml.checked = true;
  var section = document.getElementById('pdf-css-section');
  if (section) section.classList.remove('hidden');
  var cssEl = document.getElementById('pdf-custom-css');
  if (cssEl) cssEl.value = cssText;
  var sInp = document.getElementById('s-pdf-custom-css');
  if (sInp) sInp.value = cssText;
  _pdfCustomCss = cssText;
  toast('Applied complete preset: ' + name);
}

function resetPdfCustomCssToDefault() {
  var defCss = PDF_PRESETS['executive'];
  var sInp = document.getElementById('s-pdf-custom-css');
  if (sInp) sInp.value = defCss;
  var pdfCssInp = document.getElementById('pdf-custom-css');
  if (pdfCssInp) pdfCssInp.value = defCss;
  _pdfCustomCss = defCss;
  toast('Reset to default executive template');
}

function savePdfCssAsDefault() {
  var cssEl = document.getElementById('pdf-custom-css');
  var css = cssEl ? cssEl.value : '';
  _pdfCustomCss = css;
  var sInp = document.getElementById('s-pdf-custom-css');
  if (sInp) sInp.value = css;
  apiCall('save_settings', { pdf_custom_css: css })
    .then(function() {
      toast('✓ Saved as default PDF style');
    })
    .catch(function(e) {
      toast('Failed to save default style: ' + (e.message || e), 'error');
    });
}

/* ── PDF Dev mode / HTML mode toggles ───────────────────────────────── */
function togglePdfDevMode(checked) {
  _pdfDevMode = checked;
  var cssSection = document.getElementById('pdf-css-section');
  if (cssSection && checked) cssSection.classList.remove('hidden');
}
function togglePdfHtmlMode(checked) {
  var cssSection = document.getElementById('pdf-css-section');
  if (cssSection) cssSection.classList.toggle('hidden', !checked && !_pdfDevMode);
}

/* ── Copy PDF Requirement (AI template) ─────────────────────────────── */
function copyPdfRequirement() {
  var titleEl = document.getElementById('pdf-title');
  var sizeEl  = document.getElementById('pdf-page-size');
  var orntEl  = document.getElementById('pdf-orientation');
  var orgEl   = document.getElementById('s-org-name');

  var title   = (titleEl && titleEl.value) || 'Query Results';
  var size    = (sizeEl  && sizeEl.value)  || 'A4';
  var orient  = (orntEl  && orntEl.value)  || 'portrait';
  var orgName = (orgEl   && orgEl.value)   || '';
  var landscape = orient === 'landscape';
  var dims = { 'A4': ['210mm', '297mm'], 'A3': ['297mm', '420mm'], 'Letter': ['216mm', '279mm'] }[size] || ['210mm', '297mm'];
  var w = landscape ? dims[1] : dims[0];
  var h = landscape ? dims[0] : dims[1];

  var cols = (_lastResults && _lastResults.columns && _lastResults.columns.length)
    ? _lastResults.columns
    : ((typeof _lastResultCols !== 'undefined' && _lastResultCols && _lastResultCols.length) ? _lastResultCols : ['id', 'name', 'value']);

  var avgPct = cols.length > 0 ? Math.floor(100 / cols.length) : 20;
  var colWidthList = cols.map(function(c, i) {
    return '  - Column ' + (i + 1) + ' (`' + c + '`): ' + avgPct + '%';
  }).join('\n');

  var prompt = [
    '# Querii Executive PDF Custom CSS — AI Generation Specification',
    '',
    'You are generating custom CSS for an executive-grade PDF export in Querii. The report is rendered with headless Chromium via strict CSS Paged Media standards.',
    'Your custom CSS is injected at the very end of the stylesheet, giving you 100% cascade power to customize styling, layout, colors, element positions, borders, and typography.',
    '',
    '## 1. Document Context & Geometry (MUST Honor Selected Paper)',
    '- Page Size: ' + size + ' (' + w + ' × ' + h + ')',
    '- Orientation: ' + orient + (landscape ? ' (Landscape mode)' : ' (Portrait mode)'),
    '- Mandatory @page Rule: `@page { size: ' + size + ' ' + orient + '; margin: 10mm 12mm 12mm 12mm; }`',
    '- Document Title: "' + title + '"',
    '- Organisation: "' + (orgName || 'Querii') + '"',
    '- Total Columns (' + cols.length + '): ' + cols.join(', '),
    '',
    '### Active Columns & Recommended Proportional Widths:',
    colWidthList,
    '',
    '## 2. Complete HTML Architecture (Classes & Hierarchy)',
    '```html',
    '<main class="pdf-page-sheet page">',
    '  <!-- Outer Decorative Frame -->',
    '  <div class="document-frame" aria-hidden="true"></div>',
    '',
    '  <!-- Dense Repeating Watermark (Repeats across all pages in print) -->',
    '  <div class="watermark-area" id="watermarkArea" aria-hidden="true">',
    '    <div class="watermark-text" id="watermarkText">',
    '      <div class="watermark-row"><span class="watermark-item">' + (orgName || 'QUERII').toUpperCase() + ' • </span>...</div>',
    '    </div>',
    '    <div class="logo-watermark-zone">',
    '      <img src="..." class="logo-watermark" alt="">',
    '    </div>',
    '  </div>',
    '',
    '  <!-- Organisation Header (Clean Masthead: Logo + Organisation Name ONLY) -->',
    '  <header class="school-header masthead">',
    '    <img src="..." class="school-logo report-logo" alt="Logo">',
    '    <div class="school-info">',
    '      <h2 class="org-title">' + (orgName || 'Querii') + '</h2>',
    '    </div>',
    '  </header>',
    '',
    '  <!-- Document Heading (Accent Bar + Report Title ONLY) -->',
    '  <section class="document-heading">',
    '    <div class="heading-accent"></div>',
    '    <h1 class="title report-title">' + title + '</h1>',
    '  </section>',
    '',
    '  <!-- Data Table (Compact formation engineered to fit 7-8 columns cleanly) -->',
    '  <div class="data-table-wrap">',
    '    <table class="data-table (optional .grid-lines)">',
    '      <colgroup>',
    cols.map(function(c, i) { return '        <col class="col-' + i + '" data-col="' + c + '" style="width:' + avgPct + '%">'; }).join('\n'),
    '      </colgroup>',
    '      <thead>',
    '        <tr>',
    cols.map(function(c, i) { return '          <th data-col="' + c + '" data-idx="' + i + '"><span class="th-content">' + c + '</span></th>'; }).join('\n'),
    '        </tr>',
    '      </thead>',
    '      <tbody>',
    '        <tr class="even">',
    cols.map(function(c) { return '          <td data-col="' + c + '">Data</td>'; }).join('\n'),
    '        </tr>',
    '        <tr class="odd">...</tr>',
    '      </tbody>',
    '    </table>',
    '  </div>',
    '',
    '  <!-- Footer (Timestamp & Page Number only in small font) -->',
    '  <footer class="report-footer">',
    '    <div class="footer-timestamp">Generated: 10 Oct 2026, 07:05 PM</div>',
    '    <div class="footer-page">Page 1 of 1</div>',
    '  </footer>',
    '',
    '  <!-- Optional SQL Query Box -->',
    '  <section class="sql-block">',
    '    <div class="sql-label">SQL Query</div>',
    '    <pre class="sql-pre">SELECT * FROM ...</pre>',
    '  </section>',
    '</main>',
    '```',
    '',
    '## 3. Formatting Guidelines for High Data Density (7-8 Columns on A4)',
    '- Table Font Size: Use `8.5pt` to `9pt` (11px to 12px) for high readability.',
    '- Cell Padding: Use compact padding (`4.5px 6px` to `5px 7px`) so text fills columns nicely with minimal wasted margin.',
    '- Header: Keep ONLY organisation name and report title (NO extra kickers or audit sub-lines).',
    '- Footer: Keep ONLY timestamp on left and page number on right in small font.',
    '- Watermark: Dense repeating text filling the background across all pages.',
    '- Container width: Always use `width: 100%; max-width: 100%;` so it scales automatically with ' + size + ' ' + orient + '.',
    '',
    '## 4. CSS Variables Available to Override (:root)',
    '```css',
    ':root {',
    '  --paper: #ffffff;',
    '  --navy: #0f172a;             /* Primary brand color for headings & masthead */',
    '  --navy-light: #1e293b;       /* Secondary brand tint */',
    '  --gold: #b7791f;             /* Accent line bar and highlight borders */',
    '  --accent: #b7791f;',
    '  --text: #111827;             /* Base body text */',
    '  --muted: #64748b;            /* Secondary labels & timestamp */',
    '  --border: #cbd5e1;           /* Table cell borders */',
    '  --border-light: #e2e8f0;     /* Hairline table rows */',
    '  --row-alt: #f1f5f9;          /* Alternating zebra row tint */',
    '  --table-head-bg: #0f172a;    /* Table header background */',
    '  --table-head-text: #ffffff;  /* Table header text color */',
    '  --header-bg: #f8fafc;        /* School/Organisation masthead background */',
    '  --data-font-weight: 400;     /* Table body text weight (400 regular, 700 bold) */',
    '}',
    '```',
    '',
    '## 4.5 Visual Status Badges & Alternating Row Classes',
    'The attendance reports render structured semantic status badges inside `.status-cell` spans:',
    '- Base Badge: `.status-cell` (padding: 1.5px 6px, border-radius: 4px, font-weight: 700, font-size: 7.5pt)',
    '- Present: `.status-present` (green: #15803d, bg: #dcfce7, border: 1px solid #86efac)',
    '- Absent: `.status-absent` (red: #b91c1c, bg: #fee2e2, border: 1px solid #fca5a5)',
    '- Weekly-Off / Holiday: `.status-weeklyoff`, `.status-holiday` (blue: #1d4ed8, bg: #dbeafe, border: 1px solid #93c5fd)',
    '- Sandwich Rule Absorbed: `.status-sandwich` (red: #b91c1c, bg: #fee2e2, border: 1px dashed #ef4444, font-weight: 800)',
    '- Half Day: `.status-halfday` (amber: #b45309, bg: #fef3c7, border: 1px solid #fde68a)',
    '- Alternating Zebra Rows: `.data-table tbody tr:nth-child(even) td { background: var(--row-alt, #f1f5f9); }`',
    '- Watermark Background: controlled by `.watermark-area`, `.watermark-text`, `.watermark-item`',
    '- Calendar Days & Custom Day Timings: printed in notes block when enabled.',
    '',
    '## 5. HARD EXCEPTIONS & CRITICAL RULES (Follow Strictly)',
    '1. ⛔ NO `position: fixed` or `position: absolute` on table elements (`table`, `thead`, `tbody`, `tr`, `td`): Chromium Paged Media pagination breaks completely across page boundaries if table rows or cells are positioned absolutely.',
    '2. ⛔ NO external web fonts via `@import url(...)` or `<link>`: PDF compilation runs offline. Use bundled `Libron, Georgia, serif` or modern sans-serif: `ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`.',
    '3. ⛔ NO fixed pixel table widths (e.g. `width: 900px`): Always use `width: 100%` or percentage column widths to scale with ' + size + ' ' + orient + '.',
    '4. ⛔ NO `break-inside: avoid` on the entire `.data-table` or `.data-table-wrap`: The table MUST be allowed to paginate cleanly across multiple pages (`page-break-inside: auto`). Only individual rows `<tr>` have `break-inside: avoid;`.',
    '5. ⛔ NO `overflow: hidden` on `html` or `body`: Setting `overflow: hidden` on root elements disables Chromium print pagination and clips the entire document to page 1.',
    '6. ⛔ Pure Declarative CSS Only: Do NOT include `<script>`, HTML markup, or markdown explanations outside the code block. Output valid CSS inside ```css ... ```.',
    '',
    '## 6. Complete Working Baseline CSS Reference Template:',
    '```css',
    '@page {',
    '  size: ' + size + ' ' + orient + ';',
    '  margin: 10mm 12mm 12mm 12mm;',
    '}',
    '',
    ':root {',
    '  --paper: #ffffff;',
    '  --navy: #0f172a;',
    '  --gold: #b7791f;',
    '  --text: #111827;',
    '  --muted: #64748b;',
    '  --border: #cbd5e1;',
    '  --border-light: #e2e8f0;',
    '  --row-alt: #f1f5f9;',
    '  --table-head-bg: #0f172a;',
    '  --table-head-text: #ffffff;',
    '  --header-bg: #f8fafc;',
    '}',
    '',
    '.pdf-page-sheet, .page {',
    '  background: var(--paper);',
    '  color: var(--text);',
    '  font-family: "Libron", Georgia, serif;',
    '}',
    '',
    '.school-header, .masthead {',
    '  background: var(--header-bg);',
    '  border: 1px solid var(--border);',
    '  border-top: 3px solid var(--gold);',
    '  border-radius: 10px;',
    '  padding: 12px 20px;',
    '  margin-bottom: 14px;',
    '}',
    '.school-info h2, .org-title {',
    '  color: var(--navy);',
    '  font-family: "Libron", Georgia, serif;',
    '  font-size: 21px;',
    '  font-weight: 800;',
    '}',
    '',
    '.document-heading {',
    '  border-bottom: 2px solid var(--navy);',
    '  padding: 2px 0 10px;',
    '  margin-bottom: 14px;',
    '}',
    '.heading-accent {',
    '  background: var(--gold);',
    '  width: 48px;',
    '  height: 3px;',
    '  border-radius: 4px;',
    '}',
    '.title, .report-title {',
    '  color: var(--navy);',
    '  font-family: "Libron", Georgia, serif;',
    '  font-size: 22px;',
    '  font-weight: 800;',
    '}',
    '',
    '.data-table {',
    '  border: 1px solid var(--border);',
    '  border-radius: 8px;',
    '  font-size: 8.5pt;',
    '  line-height: 1.3;',
    '}',
    '.data-table thead th {',
    '  background: var(--table-head-bg);',
    '  color: var(--table-head-text);',
    '  border-bottom: 2px solid var(--gold);',
    '  padding: 6px 7px;',
    '  font-size: 8pt;',
    '  font-weight: 700;',
    '  text-transform: uppercase;',
    '}',
    '.data-table tbody td {',
    '  padding: 5px 7px;',
    '  border-bottom: 1px solid var(--border-light);',
    '  color: var(--text);',
    '  font-variant-numeric: tabular-nums;',
    '}',
    '.data-table tbody tr:nth-child(even) td {',
    '  background: var(--row-alt);',
    '}',
    '',
    '.report-footer {',
    '  border-top: 1px solid var(--border-light);',
    '  color: var(--muted);',
    '  font-size: 7.5pt;',
    '  padding-top: 8px;',
    '  margin-top: 10px;',
    '}',
    '',
    '.status-cell {',
    '  display: inline-block;',
    '  font-weight: 700;',
    '  border-radius: 4px;',
    '  padding: 1.5px 6px;',
    '  font-size: 7.5pt;',
    '  line-height: 1.25;',
    '  letter-spacing: 0.02em;',
    '  white-space: nowrap;',
    '}',
    '.status-present {',
    '  color: #15803d !important;',
    '  background: #dcfce7 !important;',
    '  border: 1px solid #86efac;',
    '}',
    '.status-absent {',
    '  color: #b91c1c !important;',
    '  background: #fee2e2 !important;',
    '  border: 1px solid #fca5a5;',
    '}',
    '.status-weeklyoff, .status-holiday {',
    '  color: #1d4ed8 !important;',
    '  background: #dbeafe !important;',
    '  border: 1px solid #93c5fd;',
    '}',
    '.status-sandwich {',
    '  color: #b91c1c !important;',
    '  background: #fee2e2 !important;',
    '  border: 1px dashed #ef4444;',
    '  font-weight: 800;',
    '}',
    '.status-halfday {',
    '  color: #b45309 !important;',
    '  background: #fef3c7 !important;',
    '  border: 1px solid #fde68a;',
    '}',
    '```'
  ].join('\n');

  copyToClipboard(prompt, '✓ AI requirement copied to clipboard! Paste it into any AI to generate custom PDF CSS.');
}

/* ── PDF folder chooser ────────────────────────────────────────────── */
function choosePdfFolder() {
  apiCall('choose_folder_dialog').then(function(dir) {
    if (!dir) return;
    _pdfDefaultDir = dir;
    var pathEl = document.getElementById('pdf-save-path');
    if (pathEl) pathEl.value = dir;
    // Persist as setting
    apiCall('save_settings', { ap_pdf_dir: dir }).catch(function() {});
  }).catch(function(e) { toast('Could not open folder dialog: ' + e.message, 'error'); });
}

function toggleContinuousMode(checked) {
  var sizeEl   = document.getElementById('pdf-page-size');
  var orientEl = document.getElementById('pdf-orientation');
  if (sizeEl)   { sizeEl.disabled   = checked; sizeEl.style.opacity   = checked ? '0.4' : '1'; }
  if (orientEl) { orientEl.disabled = checked; orientEl.style.opacity = checked ? '0.4' : '1'; }
}

function confirmExportPdf() {
  var titleEl   = document.getElementById('pdf-title');
  var pathEl    = document.getElementById('pdf-save-path');
  var sizeEl    = document.getElementById('pdf-page-size');
  var orientEl  = document.getElementById('pdf-orientation');
  var scaleEl   = document.getElementById('pdf-scale');
  var contEl    = document.getElementById('pdf-continuous');
  var inclQEl   = document.getElementById('pdf-include-query');
  var inclSEl   = document.getElementById('pdf-include-source');
  var useHtmlEl = document.getElementById('pdf-use-html');
  var cssEl     = document.getElementById('pdf-custom-css');
  var inclWatermarkEl = document.getElementById('pdf-include-watermark');
  var inclHolidaysEl  = document.getElementById('pdf-include-holidays');

  var title     = (titleEl ? titleEl.value.trim() : '') || 'Query Results';
  var saveDir   = pathEl ? pathEl.value.trim() : '';
  var pageSize  = sizeEl ? sizeEl.value : 'A4';
  var orient    = orientEl ? orientEl.value : 'portrait';
  var scale     = parseFloat(scaleEl ? scaleEl.value : '1.0') || 1.0;
  var continuous = contEl ? contEl.checked : false;
  var inclQuery = inclQEl ? inclQEl.checked : true;
  var inclSource = inclSEl ? inclSEl.checked : true;
  var useHtml   = useHtmlEl ? useHtmlEl.checked : false;
  var customCss = cssEl ? cssEl.value.trim() : '';
  var inclWatermark = inclWatermarkEl ? inclWatermarkEl.checked : true;
  var inclHolidays  = inclHolidaysEl ? inclHolidaysEl.checked : true;

  if (!saveDir) { toast('Please choose a save location first.', 'warn'); return; }

  // Sanitize file name from title
  var safeName = title.replace(/[^a-zA-Z0-9 _\-().]/g, '_').trim() || 'querii_export';
  // Build path safely: strip trailing sep, then re-join with OS separator detected from the path
  var sep = (saveDir.indexOf('\\') !== -1) ? '\\' : '/';
  var filepath  = saveDir.replace(/[\/\\]$/, '') + sep + safeName + '.pdf';

  // Save folder as default
  _pdfDefaultDir = saveDir;
  apiCall('save_settings', { ap_pdf_dir: saveDir }).catch(function() {});

  var org   = (document.getElementById('s-org-name') || {}).value || (typeof State !== 'undefined' && State.settings && State.settings.org_name) || '';
  // Prefer square logo for PDF (it's used as the circular header logo)
  var sqEl  = document.getElementById('logo-sq-img');
  var imgEl = document.getElementById('logo-img');
  var logo  = (sqEl && sqEl.src && sqEl.src.indexOf('base64,') !== -1) ? sqEl.src.replace(/^data:[^;]+;base64,/, '') :
              ((typeof State !== 'undefined' && State.orgLogoSq) ? State.orgLogoSq :
              ((imgEl && imgEl.src && imgEl.src.indexOf('base64,') !== -1) ? imgEl.src.replace(/^data:[^;]+;base64,/, '') :
              ((typeof State !== 'undefined' && State.orgLogo) ? State.orgLogo : '')));
  var sql   = inclQuery ? ((typeof State !== 'undefined' && State.lastSqlDisplay) ? State.lastSqlDisplay : '') : '';
  var sourceLabel = inclSource ? ((typeof State !== 'undefined' && State.results && State.results.title) || 'Attendance Processor') : '';


  var boldEl    = document.getElementById('pdf-bold-data');
  var gridEl    = document.getElementById('pdf-grid-lines');
  var boldData  = boldEl ? boldEl.checked : false;
  var gridLines = gridEl ? gridEl.checked : false;

  closeModal();
  /* showProgress(true) */
  toast('⚡ Generating PDF…', 'info');

  var apiMethod = useHtml ? 'export_pdf_html' : 'export_pdf';
  if (useHtml) {
    var visArr = (typeof _dev !== 'undefined' && _dev.colVisible) ? Array.from(_dev.colVisible) : null;
    var cWidths = (typeof _dev !== 'undefined') ? _dev.colWidths : {};
    var cHeads  = (typeof _dev !== 'undefined') ? _dev.colHeaders : {};
    var cFullO  = (typeof _dev !== 'undefined') ? _dev.fullOverride : false;
    var cBold   = (typeof _dev !== 'undefined' && _dev.boldData !== undefined) ? _dev.boldData : boldData;
    var cGrid   = (typeof _dev !== 'undefined' && _dev.showGridLines !== undefined) ? _dev.showGridLines : gridLines;

    apiCall('export_pdf_html', filepath, title, org, logo, sql, sourceLabel, customCss, pageSize, orient, scale, cWidths, cHeads, visArr, cFullO, cBold, cGrid, inclWatermark, inclHolidays)
      .then(function(r) { /* showProgress(false) */ if (r) toast('✓ PDF saved: ' + safeName + '.pdf'); })
      .catch(function(e) { /* showProgress(false) */ toast('Export failed: ' + e.message, 'error'); });
  } else {
    apiCall('export_pdf', filepath, title, "", org, logo, sql, null, pageSize, orient, scale, continuous, sourceLabel)
      .then(function(r) { /* showProgress(false) */ if (r) toast('✓ PDF saved: ' + safeName + '.pdf'); })
      .catch(function(e) { /* showProgress(false) */ toast('Export failed: ' + e.message, 'error'); });
  }
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
    if (s.org_logo_sq_b64) State.orgLogoSq=s.org_logo_sq_b64;
    return refreshDbStatus();
  }).then(function(){ tryAutoLoadLastFile(); })
  .catch(function(e){ console.error('Init error:',e); loadCustomReports(); });
});
