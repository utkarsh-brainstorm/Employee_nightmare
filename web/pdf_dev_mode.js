/* ═══════════════════════════════════════════════════════════════════════════
   pdf_dev_mode.js — Querii Ultra Dev Mode PDF Editor
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

/* ── State ──────────────────────────────────────────────────────────────── */
var _dev = {
  open:        false,
  cols:        [],          // original column names from last result
  colWidths:   {},          // col -> width% (0 = auto)
  colHeaders:  {},          // col -> custom label
  colVisible:  null,        // null = all visible; Set = visible cols
  title:       'Query Results',
  orgName:     '',
  logo:        '',
  pageSize:    'A4',
  orient:      'portrait',
  css:         '',
  inclSql:     false,
  inclSource:  false,
  fullOverride:false,
  boldData:    false,
  showGridLines:false,
  fileTab:     'style.css', // active file tab
  fileBuf:     {},          // name -> content (in-memory edits)
  devPaths:    {},          // {dir, csv, css, script}
  watching:    false,
  watchTid:    null,
  prevTid:     null,        // debounce timer
  previewPage: 1,
  previewTotal:1,
  zoom:        'fit',       // 'fit' | '75' | '100'
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function _dEsc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function _dToast(msg, type) {
  if (typeof toast === 'function') toast(msg, type);
}
function _dApi(method) {
  var args = Array.prototype.slice.call(arguments, 1);
  if (typeof apiCall === 'function') return apiCall.apply(null, [method].concat(args));
  if (window.pywebview && window.pywebview.api && window.pywebview.api[method]) {
    return Promise.resolve(window.pywebview.api[method].apply(window.pywebview.api, args)).then(function(r) {
      return (r && r.ok !== undefined) ? (r.ok ? r.data : Promise.reject(new Error(r.error || 'API error'))) : r;
    });
  }
  return Promise.reject(new Error('API not available'));
}

/* ══════════════════════════════════════════════════════════════════════════
   OPEN / CLOSE
   ══════════════════════════════════════════════════════════════════════════ */
function _devComputeDefaultSpecs(cols, rows) {
  var widths = {};
  var headers = {};
  var weights = {};
  cols.forEach(function(c) {
    var hStr = String(c);
    var hLen = hStr.length;
    var maxContentLen = 0;
    if (rows && rows.length) {
      for (var i = 0; i < rows.length; i++) {
        var val = rows[i][c];
        if (val !== undefined && val !== null) {
          var sLen = String(val).length;
          if (sLen > maxContentLen) maxContentLen = sLen;
        }
      }
    }

    var dispName = hStr;
    var effW = 3;
    if (hLen < 5 && maxContentLen < 5) {
      dispName = hStr;
      effW = Math.max(hLen, maxContentLen, 3);
    } else if (maxContentLen < hLen && hLen > 5) {
      var truncLen = Math.max(3, Math.min(hLen - 2, Math.max(4, maxContentLen)));
      dispName = hStr.substring(0, truncLen) + '..';
      effW = Math.max(dispName.length, maxContentLen, 3);
    } else {
      dispName = hStr;
      effW = Math.max(maxContentLen, 3);
    }
    weights[c] = { w: effW, name: dispName };
  });

  var totalW = 0;
  cols.forEach(function(c) { totalW += weights[c].w; });
  if (totalW <= 0) totalW = 1;

  var rem = 100.0;
  cols.forEach(function(c, i) {
    if (i === cols.length - 1) {
      widths[c] = Math.max(3, Math.round(rem * 10) / 10);
    } else {
      var pct = Math.max(3, Math.round((weights[c].w / totalW) * 1000) / 10);
      widths[c] = pct;
      rem -= pct;
    }
    headers[c] = weights[c].name;
  });
  return { widths: widths, headers: headers };
}

function openUltraDevMode() {
  // Seed state from export dialog if open
  var titleEl = document.getElementById('pdf-title');
  var sizeEl  = document.getElementById('pdf-page-size');
  var orntEl  = document.getElementById('pdf-orientation');
  var scaleEl = document.getElementById('pdf-scale');
  var sqEl    = document.getElementById('logo-sq-img');
  var imgEl   = document.getElementById('logo-img');
  var orgEl   = document.getElementById('s-org-name');
  var cssEl   = document.getElementById('s-pdf-custom-css');
  var devCssEl= document.getElementById('pdf-custom-css-input');
  var boldEl  = document.getElementById('pdf-bold-data');
  var gridEl  = document.getElementById('pdf-grid-lines');

  _dev.title   = (titleEl && titleEl.value) || 'Query Results';
  _dev.pageSize= (sizeEl  && sizeEl.value)  || 'A4';
  _dev.orient  = (orntEl  && orntEl.value)  || 'portrait';
  _dev.scale   = scaleEl ? (parseFloat(scaleEl.value) || 1.0) : 1.0;
  _dev.orgName = (orgEl   && orgEl.value)   || (typeof State !== 'undefined' && State.settings && State.settings.org_name) || '';
  _dev.css     = (devCssEl && devCssEl.value) || (cssEl && cssEl.value) || (typeof _pdfCustomCss !== 'undefined' ? _pdfCustomCss : '');
  _dev.boldData= boldEl ? boldEl.checked : false;
  _dev.showGridLines = gridEl ? gridEl.checked : false;
  _dev.logo    = (sqEl  && sqEl.src  && sqEl.src.indexOf('base64,')  !== -1) ? sqEl.src.replace(/^data:[^;]+;base64,/, '')  :
                 (imgEl && imgEl.src && imgEl.src.indexOf('base64,') !== -1) ? imgEl.src.replace(/^data:[^;]+;base64,/, '') :
                 ((typeof State !== 'undefined' && State.orgLogo) ? State.orgLogo : '');

  // Columns from last result
  _dev.cols = (typeof _lastResults !== 'undefined' && _lastResults && _lastResults.columns) ? _lastResults.columns.slice() :
              ((typeof State !== 'undefined' && State.results && State.results.columns) ? State.results.columns.slice() : []);
  if (!_dev.cols.length && typeof _lastResultCols !== 'undefined') _dev.cols = (_lastResultCols || []).slice();
  var resultRows = (typeof _lastResults !== 'undefined' && _lastResults && _lastResults.rows) ? _lastResults.rows :
                   ((typeof State !== 'undefined' && State.results && State.results.rows) ? State.results.rows : []);

  // Reset col state only if cols changed or empty
  var needReset = !_dev.colVisible || Object.keys(_dev.colWidths).length === 0 || Object.keys(_dev.colWidths).some(function(k){ return _dev.cols.indexOf(k) < 0; });
  if (needReset) {
    var defaultSpecs = _devComputeDefaultSpecs(_dev.cols, resultRows);
    _dev.colWidths  = defaultSpecs.widths;
    _dev.colHeaders = defaultSpecs.headers;
    _dev.colVisible = null;
  }

  // Show overlay
  var ov = document.getElementById('ultra-dev-overlay');
  if (!ov) { _dToast('Ultra Dev Mode overlay not found', 'error'); return; }
  ov.classList.remove('hidden');
  ov.classList.add('dev-open');
  ov.style.display = 'flex';
  _dev.open = true;
  document.body.classList.add('overflow-hidden');

  // Write dev files in background
  _dApi('open_dev_files', _dev.css, _dev.title, _dev.orgName, _dev.pageSize, _dev.orient, _dev.fullOverride)
    .then(function(r) {
      if (r) {
        _dev.devPaths = r;
        _devLoadAllFiles();
      }
    }).catch(function(){});

  _devRenderAll();
  _devUpdatePaperBadge();
  window._devSetZoom(_dev.zoom || 'fit');
  _devRefreshPreviewDebounced(300);
}

function closeUltraDevMode(saveCss) {
  var ov = document.getElementById('ultra-dev-overlay');
  if (ov) {
    ov.classList.add('hidden');
    ov.classList.remove('dev-open');
    ov.style.display = 'none';
  }
  _dev.open = false;
  document.body.classList.remove('overflow-hidden');
  _devStopWatcher();
  if (saveCss !== false) {
    // Save CSS back to settings textarea
    var cssEl = document.getElementById('s-pdf-custom-css');
    if (cssEl) cssEl.value = _dev.css;
    var devCssEl = document.getElementById('pdf-custom-css-input');
    if (devCssEl) devCssEl.value = _dev.css;
    if (typeof _pdfCustomCss !== 'undefined') _pdfCustomCss = _dev.css;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   RENDER LEFT PANEL
   ══════════════════════════════════════════════════════════════════════════ */
function _devRenderAll() {
  _devRenderDocControls();
  _devRenderColControls();
  _devRenderCssEditor();
  _devRenderFilePanel();
}

function _devRenderDocControls() {
  var el = document.getElementById('dev-doc-controls');
  if (!el) return;
  el.innerHTML =
    '<div class="dev-field-row">' +
      '<label class="dev-lbl">Title</label>' +
      '<input id="dev-title" class="dev-input" value="' + _dEsc(_dev.title) + '" oninput="window._devOnTitleChange(this.value)">' +
    '</div>' +
    '<div class="dev-field-row">' +
      '<label class="dev-lbl">Organisation</label>' +
      '<input id="dev-orgname" class="dev-input" value="' + _dEsc(_dev.orgName) + '" oninput="window._devOnOrgChange(this.value)">' +
    '</div>' +
    '<div class="dev-field-row">' +
      '<label class="dev-lbl">Page size</label>' +
      '<select id="dev-page-size" class="dev-select" onchange="window._devOnPageSize(this.value)">' +
        ['A4','A3','Letter'].map(function(s){ return '<option' + (s===_dev.pageSize?' selected':'') + '>' + s + '</option>'; }).join('') +
      '</select>' +
    '</div>' +
    '<div class="dev-field-row">' +
      '<label class="dev-lbl">Orientation</label>' +
      '<div class="dev-radio-group">' +
        '<label class="dev-radio' + (_dev.orient==='portrait'  ?' active':'') + '"><input type="radio" name="dev-orient" value="portrait"'  + (_dev.orient==='portrait' ?' checked':'') + ' onchange="window._devOnOrient(this.value)"> Portrait</label>' +
        '<label class="dev-radio' + (_dev.orient==='landscape' ?' active':'') + '"><input type="radio" name="dev-orient" value="landscape"' + (_dev.orient==='landscape'?' checked':'') + ' onchange="window._devOnOrient(this.value)"> Landscape</label>' +
      '</div>' +
    '</div>' +
    '<div class="dev-field-row">' +
      '<label class="dev-lbl">Content Scale</label>' +
      '<select id="dev-content-scale" class="dev-select" onchange="window._devOnScale(this.value)">' +
        [['1.0','100% (normal)'],['0.8','80% (compact)'],['0.6','60% (tiny)'],['1.2','120% (large)']].map(function(s){
          return '<option value="' + s[0] + '"' + (parseFloat(s[0]) === (_dev.scale || 1.0) ? ' selected' : '') + '>' + s[1] + '</option>';
        }).join('') +
      '</select>' +
    '</div>' +
    '<div class="dev-field-row">' +
      '<label class="dev-lbl">Table Text</label>' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;cursor:pointer">' +
        '<input type="checkbox" id="dev-bold-data" class="dev-cb"' + (_dev.boldData?' checked':'') + ' onchange="window._devOnBoldData(this.checked)">' +
        ' <strong>B</strong> Bold table text' +
      '</label>' +
    '</div>' +
    '<div class="dev-field-row">' +
      '<label class="dev-lbl">Vertical Lines</label>' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;cursor:pointer">' +
        '<input type="checkbox" id="dev-grid-lines" class="dev-cb"' + (_dev.showGridLines?' checked':'') + ' onchange="window._devOnGridLines(this.checked)">' +
        ' Render vertical lines in PDF' +
      '</label>' +
    '</div>' +
    '<div class="dev-field-row">' +
      '<label class="dev-lbl">Include SQL</label>' +
      '<input type="checkbox" id="dev-incl-sql" class="dev-cb"' + (_dev.inclSql?' checked':'') + ' onchange="window._devOnInclSql(this.checked)">' +
    '</div>' +
    '<div class="dev-field-row" style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px">' +
      '<label class="dev-lbl" title="If checked, your Custom CSS fully controls page size. If unchecked, Querii enforces the selected size/orientation.">CSS Override</label>' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:10px;cursor:pointer">' +
        '<input type="checkbox" class="dev-cb" ' + (_dev.fullOverride?'checked':'') + ' onchange="window._devOnFullOverride(this.checked)"> Full Override (Allow CSS @page)' +
      '</label>' +
    '</div>';
}

function _devRenderColControls() {
  var el = document.getElementById('dev-col-controls');
  if (!el) return;
  if (!_dev.cols.length) {
    el.innerHTML = '<div class="dev-empty">Run a query first to see columns.</div>';
    return;
  }
  var visColsCount = _dev.cols.filter(function(c) { return _dev.colVisible === null || _dev.colVisible.has(c); }).length;
  var avgWidth = visColsCount > 0 ? Math.floor(100 / visColsCount) : 20;

  var toolbar = '<div style="display:flex;gap:6px;margin-bottom:8px">' +
    '<button class="dev-btn dev-btn-sm" onclick="window._devDistributeEvenly()" style="flex:1;background:#f8fafc;border:1px solid #cbd5e1;padding:5px 8px;border-radius:6px;cursor:pointer;font-weight:600;font-size:10px;color:#334155" title="Distribute widths equally across all visible columns">⚖ Equal Widths</button>' +
    '<button class="dev-btn dev-btn-sm" onclick="window._devResetColumns()" style="flex:1;background:#f8fafc;border:1px solid #cbd5e1;padding:5px 8px;border-radius:6px;cursor:pointer;font-weight:600;font-size:10px;color:#64748b" title="Reset all custom widths and headers">↺ Reset All</button>' +
  '</div>' +
  '<div style="font-size:9.5px;color:#64748b;margin-bottom:10px;background:#f8fafc;padding:6px 8px;border-radius:6px;border:1px solid #e2e8f0;line-height:1.35">' +
    '💡 <em>Tip: You can also hover &amp; drag vertical column borders directly on the table header with your mouse!</em>' +
  '</div>';

  var html = toolbar + '<div class="dev-col-list">';
  _dev.cols.forEach(function(c) {
    var vis    = _dev.colVisible === null || _dev.colVisible.has(c);
    var width  = _dev.colWidths[c] !== undefined ? _dev.colWidths[c] : avgWidth;
    var header = _dev.colHeaders[c] || '';
    html += '<div class="dev-col-row' + (vis?'':' dev-col-hidden') + '">' +
      '<label class="dev-col-vis" title="Show/hide column">' +
        '<input type="checkbox" ' + (vis?'checked':'') + ' onchange="window._devToggleCol(\'' + _dEsc(c) + '\', this.checked)">' +
        '<span class="dev-col-name" title="' + _dEsc(c) + '">' + _dEsc(c) + '</span>' +
      '</label>' +
      '<input class="dev-col-hdr" placeholder="Label override…" value="' + _dEsc(header) + '" oninput="window._devSetHeader(\'' + _dEsc(c) + '\', this.value)" title="Custom column header">' +
      '<div class="dev-col-width-wrap" style="display:flex;align-items:center;gap:6px">' +
        '<input type="range" min="1" max="100" step="1" value="' + width + '" class="dev-slider" style="flex:1" id="slider-' + _dEsc(c) + '" oninput="window._devSetWidth(\'' + _dEsc(c) + '\', this.value)">' +
        '<div style="display:flex;align-items:center;gap:2px">' +
          '<input type="number" min="1" max="100" step="1" value="' + width + '" class="dev-width-input" id="input-' + _dEsc(c) + '" style="width:44px;height:22px;text-align:right;font-size:11px;font-weight:700;padding:2px 4px;border:1px solid #cbd5e1;border-radius:4px;color:#0f172a;background:#fff" oninput="window._devSetWidthInput(\'' + _dEsc(c) + '\', this.value)">' +
          '<span style="font-size:10px;font-weight:600;color:#64748b">%</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

window._devDistributeEvenly = function() {
  var visCols = _dev.cols.filter(function(c) { return _dev.colVisible === null || _dev.colVisible.has(c); });
  if (!visCols.length) return;
  var equalW = Math.floor(100 / visCols.length);
  visCols.forEach(function(c) {
    _dev.colWidths[c] = equalW;
  });
  _devRenderColControls();
  _devRefreshPreviewDebounced(150);
  _dToast('Columns distributed evenly (' + equalW + '%)');
};

window._devOnScale = function(val) {
  _dev.scale = parseFloat(val) || 1.0;
  _devRefreshPreviewDebounced(150);
};

window._devResetColumns = function() {
  var resultRows = (typeof _lastResults !== 'undefined' && _lastResults && _lastResults.rows) ? _lastResults.rows : [];
  var defaultSpecs = _devComputeDefaultSpecs(_dev.cols, resultRows);
  _dev.colWidths  = defaultSpecs.widths;
  _dev.colHeaders = defaultSpecs.headers;
  _dev.colVisible = null;
  _devRenderColControls();
  _devRefreshPreviewDebounced(150);
  _dToast('Column widths and headers reset');
};

function _devRenderCssEditor() {
  var el = document.getElementById('dev-css-editor');
  if (!el) return;
  if (el.value !== undefined) {
    if (document.activeElement !== el) el.value = _dev.css;
  }
}

window._devApplyPreset = function(presetName) {
  var presets = (typeof window.PDF_PRESETS !== 'undefined') ? window.PDF_PRESETS : (typeof PDF_PRESETS !== 'undefined' ? PDF_PRESETS : {});
  if (presets && presets[presetName]) {
    _dev.css = presets[presetName];
    var editor = document.getElementById('dev-css-editor');
    if (editor) editor.value = _dev.css;
    var fileEd = document.getElementById('dev-file-editor');
    if (fileEd && _dev.fileTab === 'style.css') fileEd.value = _dev.css;
    var sInp = document.getElementById('s-pdf-custom-css');
    if (sInp) sInp.value = _dev.css;
    var pdfCssInp = document.getElementById('pdf-custom-css');
    if (pdfCssInp) pdfCssInp.value = _dev.css;
    if (typeof _pdfCustomCss !== 'undefined') _pdfCustomCss = _dev.css;
    _devRefreshPreviewDebounced(150);
    _dToast('Applied complete preset: ' + presetName);
  }
};

function _devRenderFilePanel() {
  var el = document.getElementById('dev-file-panel');
  if (!el) return;
  var files = ['style.css', 'data.csv', 'render.py'];
  var tabs = files.map(function(f) {
    return '<button class="dev-file-tab' + (f===_dev.fileTab?' active':'') + '" onclick="window._devOpenFileTab(\'' + f + '\')">' + f + '</button>';
  }).join('');
  var dirLine = _dev.devPaths.dir
    ? '<div class="dev-dir-path" title="' + _dEsc(_dev.devPaths.dir) + '">📁 ' + _dEsc(_dev.devPaths.dir) + '</div>'
    : '<div class="dev-dir-path">Dev files not yet written</div>';
  var content = _dev.fileBuf[_dev.fileTab] || '';
  el.innerHTML =
    dirLine +
    '<div class="dev-file-tabs">' + tabs + '</div>' +
    '<textarea id="dev-file-editor" class="dev-file-area" spellcheck="false" ' +
      'oninput="window._devOnFileEdit(this.value)">' + _dEsc(content) + '</textarea>' +
    '<div class="dev-file-actions">' +
      '<button class="dev-btn dev-btn-primary" onclick="window._devSaveFile()">💾 Save</button>' +
      '<button class="dev-btn" onclick="window._devOpenPath(\'' + _dEsc(_dev.devPaths.dir || '') + '\')" title="Open folder">📂 Open folder</button>' +
      (_dev.fileTab === 'render.py' ? '<button class="dev-btn" onclick="window._devRunScript()">▶ Run Script</button>' : '') +
      '<button class="dev-btn dev-btn-sm" onclick="window._devStartWatcher()" title="Auto-reload CSS when file changes on disk">👁 Watch' + (_dev.watching ? ' (on)' : '') + '</button>' +
    '</div>';
}

/* ══════════════════════════════════════════════════════════════════════════
   CONTROL EVENT HANDLERS
   ══════════════════════════════════════════════════════════════════════════ */
window._devOnTitleChange = function(v) { _dev.title = v; _devRefreshPreviewDebounced(); };
window._devOnOrgChange   = function(v) { _dev.orgName = v; _devRefreshPreviewDebounced(); };
function _devSyncPageSizeInCode(size, orient) {
  var pageStr = size + (orient === 'landscape' ? ' landscape' : '');
  var regex = /(@page\s*\{[^}]*size\s*:\s*)([^;\}]+)/i;
  if (_dev.css && regex.test(_dev.css)) {
    _dev.css = _dev.css.replace(regex, '$1' + pageStr);
    var cssEd = document.getElementById('dev-css-editor');
    if (cssEd && document.activeElement !== cssEd) cssEd.value = _dev.css;
  }
  if (_dev.fileBuf && _dev.fileBuf['style.css'] && regex.test(_dev.fileBuf['style.css'])) {
    _dev.fileBuf['style.css'] = _dev.fileBuf['style.css'].replace(regex, '$1' + pageStr);
    var fileEd = document.getElementById('dev-file-editor');
    if (fileEd && _dev.fileTab === 'style.css' && document.activeElement !== fileEd) {
      fileEd.value = _dev.fileBuf['style.css'];
    }
  }
  if (_dev.fileBuf && _dev.fileBuf['render.py']) {
    _dev.fileBuf['render.py'] = _dev.fileBuf['render.py']
      .replace(/page_size=['"][^'"]*['"]/, "page_size='" + size + "'")
      .replace(/orientation=['"][^'"]*['"]/, "orientation='" + orient + "'");
    _dApi('write_dev_file', 'render.py', _dev.fileBuf['render.py']).catch(function(){});
    var fileEd2 = document.getElementById('dev-file-editor');
    if (fileEd2 && _dev.fileTab === 'render.py' && document.activeElement !== fileEd2) {
      fileEd2.value = _dev.fileBuf['render.py'];
    }
  }
}

window._devOnPageSize    = function(v) {
  _dev.pageSize = v;
  _devSyncPageSizeInCode(v, _dev.orient || 'portrait');
  _devUpdatePaperBadge();
  _devRefreshPreviewDebounced(200);
};
window._devOnOrient      = function(v) {
  _dev.orient = v;
  document.querySelectorAll('.dev-radio').forEach(function(r) { r.classList.toggle('active', r.querySelector('input').value === v); });
  _devSyncPageSizeInCode(_dev.pageSize || 'A4', v);
  _devUpdatePaperBadge();
  _devRefreshPreviewDebounced(200);
};
window._devOnInclSql     = function(v) { _dev.inclSql = v; _devRefreshPreviewDebounced(); };
window._devOnFullOverride= function(v) { _dev.fullOverride = v; _devRefreshPreviewDebounced(200); };
window._devOnBoldData    = function(v) { _dev.boldData = v; _devRefreshPreviewDebounced(150); };
window._devOnGridLines   = function(v) { _dev.showGridLines = v; _devRefreshPreviewDebounced(150); };

window._devToggleCol = function(col, vis) {
  if (_dev.colVisible === null) {
    _dev.colVisible = new Set(_dev.cols);
  }
  if (vis) _dev.colVisible.add(col);
  else     _dev.colVisible.delete(col);
  _devRefreshPreviewDebounced();
};

window._devSetWidth = function(col, val) {
  var n = Math.max(1, Math.min(100, parseInt(val, 10) || 1));
  _dev.colWidths[col] = n;
  var inp = document.getElementById('input-' + col);
  if (inp && document.activeElement !== inp) inp.value = n;
  _devRefreshPreviewDebounced(250);
};

window._devSetWidthInput = function(col, val) {
  var n = Math.max(1, Math.min(100, parseInt(val, 10) || 1));
  _dev.colWidths[col] = n;
  var sld = document.getElementById('slider-' + col);
  if (sld) sld.value = n;
  _devRefreshPreviewDebounced(300);
};

window._devOnColumnsResized = function(colA, pctA, colB, pctB) {
  if (colA) {
    _dev.colWidths[colA] = pctA;
    var sldA = document.getElementById('slider-' + colA);
    if (sldA) sldA.value = pctA;
    var inpA = document.getElementById('input-' + colA);
    if (inpA) inpA.value = pctA;
  }
  if (colB) {
    _dev.colWidths[colB] = pctB;
    var sldB = document.getElementById('slider-' + colB);
    if (sldB) sldB.value = pctB;
    var inpB = document.getElementById('input-' + colB);
    if (inpB) inpB.value = pctB;
  }
};

window._devOnColumnDragged = function(col, newPct) {
  if (col) {
    _dev.colWidths[col] = newPct;
    var sld = document.getElementById('slider-' + col);
    if (sld) sld.value = newPct;
    var inp = document.getElementById('input-' + col);
    if (inp) inp.value = newPct;
  }
};

window._devOnColumnDragEnd = function(colA, colB) {
  _devRefreshPreviewDebounced(100);
  if (colA && colB) {
    _dToast('Resized: ' + colA + ' (' + (_dev.colWidths[colA] || '') + '%), ' + colB + ' (' + (_dev.colWidths[colB] || '') + '%)');
  } else if (colA) {
    _dToast('Column ' + colA + ' width: ' + (_dev.colWidths[colA] || '') + '%');
  }
};

window._devSetHeader = function(col, val) {
  _dev.colHeaders[col] = val;
  _devRefreshPreviewDebounced();
};

window._devCssChanged = function(val) {
  _dev.css = val;
  _devRefreshPreviewDebounced(400);
};

window._devOnFileEdit = function(val) {
  _dev.fileBuf[_dev.fileTab] = val;
  if (_dev.fileTab === 'style.css') {
    _dev.css = val;
    _devRefreshPreviewDebounced(500);
  }
};

window._devSaveCssAsDefault = function() {
  var css = _dev.css || '';
  if (typeof _pdfCustomCss !== 'undefined') _pdfCustomCss = css;
  var sInp = document.getElementById('s-pdf-custom-css');
  if (sInp) sInp.value = css;
  var pdfCssInp = document.getElementById('pdf-custom-css');
  if (pdfCssInp) pdfCssInp.value = css;
  _dApi('save_settings', { pdf_custom_css: css })
    .then(function() {
      _dToast('✓ Saved as default PDF style');
    })
    .catch(function(e) {
      _dToast('Failed to save default style: ' + (e.message || e), 'error');
    });
};

/* ── Paper Dimensions & Zoom ───────────────────────────────────────────── */
function _devUpdatePaperBadge() {
  var badge = document.getElementById('dev-paper-badge');
  if (!badge) return;
  var orient = _dev.orient || 'portrait';
  var size = _dev.pageSize || 'A4';
  var landscape = orient === 'landscape';
  var dims = {
    'A4': ['210', '297'],
    'A3': ['297', '420'],
    'Letter': ['216', '279']
  }[size] || ['210', '297'];
  var w = landscape ? dims[1] : dims[0];
  var h = landscape ? dims[0] : dims[1];
  badge.textContent = '📄 ' + size + ' ' + (landscape ? 'Landscape' : 'Portrait') + ' (' + w + ' × ' + h + ' mm)';
}

function _devGetCurrentScale() {
  var iframe = document.getElementById('dev-preview-frame');
  if (!iframe) return 1.0;
  try {
    var doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
    var sheet = doc && doc.getElementById('pdfPageSheet');
    if (sheet && sheet.style.transform) {
      var match = sheet.style.transform.match(/scale\(([^)]+)\)/);
      if (match) return parseFloat(match[1]) || 1.0;
    }
  } catch (e) {}
  return 1.0;
}

window._devSetZoom = function(mode) {
  _dev.zoom = mode;
  _dev.customZoomScale = null;
  _devUpdateZoomUi();
  _devApplyZoomToIframe();
};

window._devZoomStep = function(delta) {
  var cur = _devGetCurrentScale();
  var next = Math.max(0.2, Math.min(3.0, Math.round((cur + delta) * 10) / 10));
  _dev.zoom = 'custom';
  _dev.customZoomScale = next;
  _devUpdateZoomUi();
  _devApplyZoomToIframe();
};

function _devUpdateZoomUi() {
  var mode = _dev.zoom || 'fit';
  var fitBtn = document.getElementById('dev-zoom-fit');
  var p100Btn = document.getElementById('dev-zoom-100');
  var lbl = document.getElementById('dev-zoom-level');

  if (fitBtn) {
    var isFit = mode === 'fit';
    fitBtn.style.background = isFit ? '#2563eb' : '#ffffff';
    fitBtn.style.color = isFit ? '#ffffff' : '#64748b';
    fitBtn.style.borderColor = isFit ? '#2563eb' : '#cbd5e1';
  }
  if (p100Btn) {
    var is100 = mode === '100' || (mode === 'custom' && Math.abs((_dev.customZoomScale || 1) - 1.0) < 0.01);
    p100Btn.style.background = is100 ? '#2563eb' : '#ffffff';
    p100Btn.style.color = is100 ? '#ffffff' : '#64748b';
    p100Btn.style.borderColor = is100 ? '#2563eb' : '#cbd5e1';
  }
  if (lbl) {
    if (mode === 'fit') {
      var s = _devGetCurrentScale();
      lbl.textContent = Math.round(s * 100) + '%';
    } else if (mode === '100') {
      lbl.textContent = '100%';
    } else if (_dev.customZoomScale) {
      lbl.textContent = Math.round(_dev.customZoomScale * 100) + '%';
    } else {
      lbl.textContent = '100%';
    }
  }
}

function _devApplyZoomToIframe() {
  var iframe = document.getElementById('dev-preview-frame');
  if (!iframe) return;
  try {
    var doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
    if (!doc) return;
    var sheet = doc.getElementById('pdfPageSheet');
    if (!sheet) return;
    var mode = _dev.zoom || 'fit';
    if (mode === '100') {
      sheet.style.transform = 'none';
    } else if (mode === 'custom' && _dev.customZoomScale) {
      sheet.style.transform = 'scale(' + _dev.customZoomScale.toFixed(3) + ')';
    } else if (mode === 'fit') {
      var availW = (iframe.clientWidth || 800) - 64;
      var availH = (iframe.clientHeight || 700) - 80;
      var sheetW = sheet.offsetWidth || 1;
      var sheetH = sheet.offsetHeight || 1;
      var scale = Math.min(availW / sheetW, availH / sheetH, 1.0);
      sheet.style.transform = 'scale(' + Math.max(0.2, scale).toFixed(3) + ')';
    }
    _devUpdateZoomUi();
  } catch (e) {}
}

function _devAttachIframeZoomListeners(iframe) {
  try {
    var win = iframe.contentWindow;
    if (!win) return;
    win.addEventListener('keydown', function(e) {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd' || e.keyCode === 187 || e.keyCode === 107) {
          e.preventDefault();
          e.stopPropagation();
          window._devZoomStep(0.1);
        } else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract' || e.keyCode === 189 || e.keyCode === 109) {
          e.preventDefault();
          e.stopPropagation();
          window._devZoomStep(-0.1);
        } else if (e.key === '0' || e.code === 'Numpad0' || e.keyCode === 48 || e.keyCode === 96) {
          e.preventDefault();
          e.stopPropagation();
          window._devSetZoom('fit');
        }
      }
    }, true);

    win.addEventListener('wheel', function(e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        window._devZoomStep(e.deltaY < 0 ? 0.08 : -0.08);
      }
    }, { passive: false });
  } catch (err) {}
}

window.addEventListener('resize', function() {
  if (_dev.open && (_dev.zoom === 'fit' || !_dev.zoom)) {
    _devApplyZoomToIframe();
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   PREVIEW (Smooth & Scroll-Preserved with True Paper Geometry)
   ══════════════════════════════════════════════════════════════════════════ */
function _devRefreshPreviewDebounced(delay) {
  if (_dev.prevTid) clearTimeout(_dev.prevTid);
  _dev.prevTid = setTimeout(_devRefreshPreview, delay || 300);
}

function _devRefreshPreview() {
  var iframe = document.getElementById('dev-preview-frame');
  if (!iframe) return;
  var visArr = _dev.colVisible ? Array.from(_dev.colVisible) : null;

  // Preserve scroll offset
  var scrollY = 0;
  var scrollX = 0;
  try {
    if (iframe.contentWindow) {
      scrollY = iframe.contentWindow.scrollY || 0;
      scrollX = iframe.contentWindow.scrollX || 0;
    }
  } catch (e) {}

  _dApi('get_pdf_html_preview',
    _dev.title, _dev.orgName, _dev.logo, _dev.css,
    _dev.pageSize, _dev.orient, _dev.scale || 1.0,
    _dev.colWidths, _dev.colHeaders, visArr, _dev.fullOverride,
    _dev.boldData, _dev.showGridLines
  ).then(function(r) {
    if (!r) return;
    iframe.srcdoc = r;

    iframe.onload = function() {
      try {
        if (iframe.contentWindow && (scrollY > 0 || scrollX > 0)) {
          iframe.contentWindow.scrollTo(scrollX, scrollY);
        }
      } catch (e) {}
      _devUpdatePaperBadge();
      _devApplyZoomToIframe();
      _devAttachIframeZoomListeners(iframe);
    };

    var spin = document.getElementById('dev-preview-spinner');
    if (spin) spin.classList.add('hidden');
  }).catch(function(e) {
    console.warn('[Ultra Dev Mode] Preview error:', e);
  });

  var spin = document.getElementById('dev-preview-spinner');
  if (spin) spin.classList.remove('hidden');
}

/* ══════════════════════════════════════════════════════════════════════════
   FILE EDITOR
   ══════════════════════════════════════════════════════════════════════════ */
function _devLoadAllFiles() {
  ['style.css', 'data.csv', 'render.py'].forEach(function(name) {
    _dApi('read_dev_file', name).then(function(r) {
      if (r !== undefined) {
        _dev.fileBuf[name] = r;
        if (name === _dev.fileTab) _devRenderFilePanel();
      }
    }).catch(function(){});
  });
}

window._devOpenFileTab = function(name) {
  _dev.fileTab = name;
  _devRenderFilePanel();
};

window._devSaveFile = function() {
  var content = _dev.fileBuf[_dev.fileTab] || '';
  _dApi('write_dev_file', _dev.fileTab, content)
    .then(function(r) {
      _dToast('✓ ' + _dev.fileTab + ' saved');
      if (_dev.fileTab === 'style.css') {
        _dev.css = content;
        _devRefreshPreviewDebounced(200);
      }
    })
    .catch(function(e) { _dToast('Save failed: ' + e.message, 'error'); });
};

window._devOpenPath = function(path) {
  if (!path) return;
  _dApi('open_path', path).catch(function(){});
};

window._devRunScript = function() {
  _dToast('Running render.py…');
  var content = _dev.fileBuf['render.py'] || '';
  // Save first, then open folder so user can see output.pdf
  _dApi('write_dev_file', 'render.py', content).then(function() {
    return _dApi('open_path', _dev.devPaths.dir || '');
  }).then(function() {
    _dToast('Script saved. Open a terminal in the folder and run: python3 render.py', 'info');
  }).catch(function(e){ _dToast(e.message, 'error'); });
};

/* ── File watcher ──────────────────────────────────────────────────────── */
window._devStartWatcher = function() {
  if (_dev.watching) { _devStopWatcher(); return; }
  _dev.watching = true;
  _dToast('👁 Watching style.css for changes…');
  _dev.watchTid = setInterval(function() {
    _dApi('read_dev_file', 'style.css').then(function(r) {
      if (r !== undefined && r !== _dev.fileBuf['style.css']) {
        _dev.fileBuf['style.css'] = r;
        _dev.css = r;
        if (_dev.fileTab === 'style.css') {
          var ta = document.getElementById('dev-file-editor');
          if (ta && document.activeElement !== ta) ta.value = r;
          var cssEd = document.getElementById('dev-css-editor');
          if (cssEd && document.activeElement !== cssEd) cssEd.value = r;
        }
        _devRefreshPreviewDebounced(200);
      }
    }).catch(function(){});
  }, 2000);
  _devRenderFilePanel(); // update button label
};

function _devStopWatcher() {
  if (_dev.watchTid) clearInterval(_dev.watchTid);
  _dev.watchTid = null;
  _dev.watching = false;
}

/* ══════════════════════════════════════════════════════════════════════════
   EXPORT PDF from dev mode
   ══════════════════════════════════════════════════════════════════════════ */
window._devExportPdf = function() {
  var visArr = _dev.colVisible ? Array.from(_dev.colVisible) : null;
  _dApi('save_file_dialog', _dev.title || 'export', 'pdf').then(function(r) {
    if (!r) return;
    var filepath = r;
    var orgEl = document.getElementById('s-org-name');
    var org = (orgEl && orgEl.value) || _dev.orgName;
    _dToast('⚡ Generating PDF…', 'info');
    return _dApi('export_pdf_html',
      filepath, _dev.title, org, _dev.logo,
      _dev.inclSql ? ((document.getElementById('sql-editor')||{}).value||'') : '',
      '', _dev.css, _dev.pageSize, _dev.orient, _dev.scale || 1.0,
      _dev.colWidths, _dev.colHeaders, visArr, _dev.fullOverride,
      _dev.boldData, _dev.showGridLines
    );
  }).then(function(r) {
    if (r) _dToast('✓ PDF exported!');
  }).catch(function(e){ if (e) _dToast(e.message||'Export failed', 'error'); });
};

/* ══════════════════════════════════════════════════════════════════════════
   COPY AI REQUIREMENT (dynamic, context-aware)
   ══════════════════════════════════════════════════════════════════════════ */
window._devCopyAiRequirement = function() {
  var visArr = _dev.colVisible ? Array.from(_dev.colVisible) : _dev.cols;
  var orient  = _dev.orient || 'portrait';
  var size    = _dev.pageSize || 'A4';
  var landscape = orient === 'landscape';
  var w = size === 'A3' ? '297mm' : size === 'Letter' ? '216mm' : '210mm';
  var h = size === 'A3' ? '420mm' : size === 'Letter' ? '279mm' : '297mm';
  if (landscape) { var tmp = w; w = h; h = tmp; }

  var avgPct = visArr.length > 0 ? Math.floor(100 / visArr.length) : 20;
  var widthLines = visArr.map(function(c, i) {
    var widthVal = (_dev.colWidths && _dev.colWidths[c]) ? _dev.colWidths[c] + '%' : avgPct + '%';
    return '  - Column ' + (i + 1) + ' (`' + c + '`): ' + widthVal;
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
    '- Document Title: "' + (_dev.title || 'Query Results') + '"',
    '- Organisation: "' + (_dev.orgName || 'Querii') + '"',
    '- Total Visible Columns (' + visArr.length + '): ' + visArr.join(', '),
    '',
    '### Active Columns & Current Proportional Widths:',
    widthLines,
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
    '      <div class="watermark-row"><span class="watermark-item">' + (_dev.orgName || 'QUERII').toUpperCase() + ' • </span>...</div>',
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
    '      <h2 class="org-title">' + (_dev.orgName || 'Querii') + '</h2>',
    '    </div>',
    '  </header>',
    '',
    '  <!-- Document Heading (Accent Bar + Report Title ONLY) -->',
    '  <section class="document-heading">',
    '    <div class="heading-accent"></div>',
    '    <h1 class="title report-title">' + (_dev.title || 'Query Results') + '</h1>',
    '  </section>',
    '',
    '  <!-- Data Table (Compact formation engineered to fit 7-8 columns cleanly) -->',
    '  <div class="data-table-wrap">',
    '    <table class="data-table (optional .grid-lines)">',
    '      <colgroup>',
    visArr.map(function(c, i) {
      var wVal = (_dev.colWidths && _dev.colWidths[c]) ? _dev.colWidths[c] : avgPct;
      return '        <col class="col-' + i + '" data-col="' + c + '" style="width:' + wVal + '%">';
    }).join('\n'),
    '      </colgroup>',
    '      <thead>',
    '        <tr>',
    visArr.map(function(c, i) { return '          <th data-col="' + c + '" data-idx="' + i + '"><span class="th-content">' + c + '</span></th>'; }).join('\n'),
    '        </tr>',
    '      </thead>',
    '      <tbody>',
    '        <tr class="even">',
    visArr.map(function(c) { return '          <td data-col="' + c + '">Data</td>'; }).join('\n'),
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
    '  --row-alt: #f8fafc;          /* Alternating zebra row tint */',
    '  --table-head-bg: #0f172a;    /* Table header background */',
    '  --table-head-text: #ffffff;  /* Table header text color */',
    '  --header-bg: #f8fafc;        /* School/Organisation masthead background */',
    '  --data-font-weight: 400;     /* Table body text weight (400 regular, 700 bold) */',
    '}',
    '```',
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
    '  --row-alt: #f8fafc;',
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
    '.data-table tbody tr:nth-child(even) {',
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
    '```'
  ].join('\n');

  _devFallbackCopy(prompt);
};

function _devFallbackCopy(text) {
  if (typeof copyToClipboard === 'function') {
    copyToClipboard(text, '✓ AI requirement copied to clipboard!');
  } else {
    _dApi('copy_to_clipboard', text)
      .then(function() {
        _dToast('✓ AI requirement copied to clipboard!');
      })
      .catch(function() {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          ta.style.top = '-9999px';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          _dToast('✓ AI requirement copied to clipboard!');
        } catch (e) {
          _dToast('Copy failed: ' + e.message, 'error');
        }
      });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS — Ultra Dev Mode
   ══════════════════════════════════════════════════════════════════════════ */
window.addEventListener('keydown', function(e) {
  if (!_dev.open) return;
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 's') {
      e.preventDefault();
      var active = document.activeElement;
      if (active && active.id === 'dev-css-editor') {
        _dev.css = active.value;
        _devRefreshPreviewDebounced(100);
        _dToast('Preview refreshed (Ctrl+S)');
      } else if (active && active.id === 'dev-file-editor') {
        window._devSaveFile();
      }
      return;
    }
    // Zoom shortcuts on Ultra Dev Mode preview page only (does NOT zoom the whole app!)
    if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd' || e.keyCode === 187 || e.keyCode === 107) {
      e.preventDefault();
      e.stopPropagation();
      window._devZoomStep(0.1);
    } else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract' || e.keyCode === 189 || e.keyCode === 109) {
      e.preventDefault();
      e.stopPropagation();
      window._devZoomStep(-0.1);
    } else if (e.key === '0' || e.code === 'Numpad0' || e.keyCode === 48 || e.keyCode === 96) {
      e.preventDefault();
      e.stopPropagation();
      window._devSetZoom('fit');
    }
  }
  if (e.key === 'Escape' && _dev.open) {
    closeUltraDevMode();
  }
}, true);

/* ── Global window exports ── */
window.openUltraDevMode = openUltraDevMode;
window.closeUltraDevMode = closeUltraDevMode;
window._devRefreshPreview = _devRefreshPreview;
