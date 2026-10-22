"""
core/exporter.py
================
Export query results to CSV and PDF.

Engines:
  1. export_pdf_rust() — Blazing-fast native Rust PDF engine (sub-50ms, executive vector layout)
  2. export_pdf_html() — Modern HTML/CSS template rendered via headless Chromium/Chrome
  3. export_pdf()      — Rust native engine with ReportLab fallback
"""

from __future__ import annotations

import base64
import csv
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------

def export_csv(columns: List[str], rows: List[Dict], filepath: str) -> None:
    """Write columns + rows to a CSV file."""
    out = Path(filepath)
    with out.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({col: row.get(col, "") for col in columns})


# ---------------------------------------------------------------------------
# Rust Native PDF Engine (Blazing Fast, sub-50ms)
# ---------------------------------------------------------------------------

def _find_rust_engine() -> Optional[str]:
    """Find the compiled native Rust PDF generator binary."""
    here = Path(__file__).parent
    candidates = [
        here / "querii-pdf",
        here / "rust_engine" / "target" / "release" / "rust_engine",
        here / "rust_engine" / "target" / "debug" / "rust_engine",
        Path("/home/heisenberg/BuilderValley/querii/core/querii-pdf"),
    ]
    for c in candidates:
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)
    return None


def export_pdf_rust(
    columns: List[str],
    rows: List[Dict],
    filepath: str,
    title: str = "Query Results",
    org_name: str = "",
    source_label: str = "",
    sql_display: str = "",
    page_size: str = "A4",
    orientation: str = "portrait",
    scale: float = 1.0,
    theme: str = "modern",
    col_widths: Optional[Dict[str, float]] = None,
    col_headers: Optional[Dict[str, str]] = None,
    col_visible: Optional[List[str]] = None,
) -> bool:
    """
    Render query results to PDF using the high-performance Rust native engine.
    Returns True on success, False if binary is not found or fails.
    """
    rust_bin = _find_rust_engine()
    if not rust_bin:
        return False

    out_path = str(Path(filepath).resolve())
    job = {
        "output_path": out_path,
        "title": title or "Query Results",
        "org_name": org_name or "Querii Analytics",
        "source_label": source_label or "",
        "sql_display": sql_display or "",
        "page_size": page_size or "A4",
        "orientation": orientation or "portrait",
        "scale": scale or 1.0,
        "theme": theme or "modern",
        "columns": columns,
        "col_headers": col_headers or {},
        "col_widths": col_widths or {},
        "col_visible": col_visible,
        "rows": rows,
    }

    try:
        proc = subprocess.run(
            [rust_bin, "--stdin"],
            input=json.dumps(job),
            capture_output=True,
            text=True,
            timeout=30,
        )
        if proc.returncode == 0 and Path(out_path).exists() and Path(out_path).stat().st_size > 500:
            return True
        else:
            print(f"[PDF Rust Engine Error] Exit {proc.returncode}: {proc.stderr[:300]}")
            return False
    except Exception as exc:
        print(f"[PDF Rust Engine Exception] {exc}")
        return False


# ---------------------------------------------------------------------------
# HTML/CSS PDF renderer (Chromium / Chrome headless)
# ---------------------------------------------------------------------------

_CHROMIUM_CANDIDATES = [
    # Prioritize native Google Chrome to avoid Snap sandbox / AppArmor confinement on Linux
    "google-chrome",
    "google-chrome-stable",
    "chrome",
    "chromium",
    "chromium-browser",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]


# ---------------------------------------------------------------------------
# Libron Font Embedding (Base64 WOFF2)
# ---------------------------------------------------------------------------

_FONT_DIR = Path(__file__).parent.parent / "web" / "fonts"
if not _FONT_DIR.exists():
    _FONT_DIR = Path(__file__).parent.parent / "Libron_Web"

_LIBRON_REG_B64 = ""
_LIBRON_BOLD_B64 = ""
_LIBRON_ITALIC_B64 = ""
_LIBRON_BOLD_ITALIC_B64 = ""

try:
    reg_p = _FONT_DIR / "Libron-Regular.woff2"
    bold_p = _FONT_DIR / "Libron-Bold.woff2"
    italic_p = _FONT_DIR / "Libron-Italic.woff2"
    bold_italic_p = _FONT_DIR / "Libron-BoldItalic.woff2"
    if reg_p.exists():
        _LIBRON_REG_B64 = base64.b64encode(reg_p.read_bytes()).decode("ascii")
    if bold_p.exists():
        _LIBRON_BOLD_B64 = base64.b64encode(bold_p.read_bytes()).decode("ascii")
    if italic_p.exists():
        _LIBRON_ITALIC_B64 = base64.b64encode(italic_p.read_bytes()).decode("ascii")
    if bold_italic_p.exists():
        _LIBRON_BOLD_ITALIC_B64 = base64.b64encode(bold_italic_p.read_bytes()).decode("ascii")
except Exception as _font_err:
    print(f"[Libron font] Warning loading fonts: {_font_err}")


def _find_chromium() -> Optional[str]:
    """Return path to a usable native Chromium/Chrome binary, or None."""
    import shutil
    for c in _CHROMIUM_CANDIDATES:
        if Path(c).is_file() and os.access(c, os.X_OK):
            return c
        found = shutil.which(c)
        if found:
            return found
    return None


def compute_default_col_specs(
    columns: List[str],
    rows: List[Dict],
) -> tuple[Dict[str, float], Dict[str, str]]:
    """
    Compute default column widths and header labels:
    1. Base column width is decided by the longest string that column has (not the header).
    2. If header has < 5 chars AND largest content is also < 5 chars:
       Keep width according to header (label remains unchanged).
    3. If content is smaller than header AND header is > 5 chars:
       Name the header as abbreviated 'abcd..' so long headers don't bloat the column.
    4. Otherwise: width is decided by largest content string.
    """
    col_widths: Dict[str, float] = {}
    col_headers: Dict[str, str] = {}
    char_weights: Dict[str, tuple[float, str]] = {}

    for c in columns:
        h_str = str(c)
        h_len = len(h_str)
        max_content_len = 0
        if rows:
            for r in rows:
                val = r.get(c, "")
                if val is not None:
                    s_len = len(str(val))
                    if s_len > max_content_len:
                        max_content_len = s_len

        # Rule 1: header < 5 chars AND largest content < 5 chars -> keep width according to header
        if h_len < 5 and max_content_len < 5:
            display_name = h_str
            effective_w = max(h_len, max_content_len, 3)
        # Rule 2: content < header AND header > 5 chars -> name header as 'abcd..'
        elif max_content_len < h_len and h_len > 5:
            trunc_len = max(3, min(h_len - 2, max(4, max_content_len)))
            display_name = h_str[:trunc_len] + ".."
            effective_w = max(len(display_name), max_content_len, 3)
        # Rule 3: general case -> width according to longest string in content
        else:
            display_name = h_str
            effective_w = max(max_content_len, 3)

        char_weights[c] = (effective_w, display_name)

    total_weight = sum(w for w, _ in char_weights.values()) or 1.0
    rem = 100.0
    for i, c in enumerate(columns):
        w, disp = char_weights[c]
        if i == len(columns) - 1:
            pct = round(max(3.0, rem), 1)
        else:
            pct = round((w / total_weight) * 100.0, 1)
            pct = max(3.0, pct)
            rem -= pct
        col_widths[c] = pct
        col_headers[c] = disp

    return col_widths, col_headers


def _build_pdf_html(
    columns: List[str],
    rows: List[Dict],
    title: str = "Query Results",
    org_name: str = "",
    logo_b64: str = "",
    sql_display: str = "",
    source_label: str = "",
    custom_css: str = "",
    page_size: str = "A4",
    orientation: str = "portrait",
    scale: float = 1.0,
    col_widths: Optional[Dict[str, float]] = None,
    col_headers: Optional[Dict[str, str]] = None,
    col_visible: Optional[List[str]] = None,
    full_override: bool = False,
    bold_data: bool = False,
    show_grid_lines: bool = False,
    is_preview: bool = False,
    include_watermark: bool = True,
    include_holidays: bool = True,
) -> str:
    """
    Build a complete, standalone, executive-grade HTML string for high-fidelity printing.
    Uses Libron font typography, executive masthead, and exact physical page sheet geometry.
    """
    scale = max(0.4, min(2.0, float(scale or 1.0)))
    if custom_css and "\\n" in custom_css and "\n" not in custom_css:
        custom_css = custom_css.replace("\\n", "\n")

    # ── column filtering & labelling ──────────────────────────────────────────
    if col_visible is not None:
        vis_set = set(col_visible)
        columns = [c for c in columns if c in vis_set]

    default_widths, default_headers = compute_default_col_specs(columns, rows)
    if not col_widths:
        col_widths = default_widths
    else:
        col_widths = dict(col_widths)
        for c in columns:
            if c not in col_widths:
                col_widths[c] = default_widths.get(c, round(100.0 / max(len(columns), 1), 1))

    if not col_headers:
        col_headers = default_headers
    else:
        col_headers = dict(col_headers)
        for c in columns:
            if c not in col_headers:
                col_headers[c] = default_headers.get(c, c)

    total_records = len(rows)

    # In live dev preview: render page 1 only so it's super responsive and doesn't lag
    if is_preview:
        max_preview_rows = 18 if orientation == "landscape" else 26
        rows = rows[:max_preview_rows]

    # ── page dimensions for true paper geometry ──────────────────────────────
    dim_map = {
        "A4": ("210mm", "297mm"),
        "A3": ("297mm", "420mm"),
        "Letter": ("216mm", "279mm"),
    }
    pw, ph = dim_map.get(page_size, ("210mm", "297mm"))
    if orientation == "landscape":
        pw, ph = ph, pw

    # ── page size for @page rule ──────────────────────────────────────────────
    page_size_map = {"A4": "A4", "A3": "A3", "Letter": "letter"}
    css_page_size = page_size_map.get(page_size, "A4")
    if orientation == "landscape":
        css_page_size += " landscape"

    # ── logo data URI ─────────────────────────────────────────────────────────
    logo_src = ""
    if logo_b64:
        logo_src = "data:image/png;base64," + logo_b64

    # ── HTML escape ───────────────────────────────────────────────────────────
    def he(s: str) -> str:
        return (
            str(s)
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
        )

    # ── Sandwich-absorbed dates cache for visual highlighting ─────────────────
    sandwich_set = set()
    try:
        import core.db as db_mod
        sr = db_mod.get_setting("sandwich_rule", "yes").strip().lower()
        if sr != "no":
            conn_sw = db_mod._connect()
            try:
                sw_rows = conn_sw.execute('''
                    SELECT a.emp_code, COALESCE(s.emp_name_override, a.emp_name) AS emp_name, a.work_date 
                    FROM attendance_raw a
                    LEFT JOIN employee_salary s ON a.emp_code = s.emp_code
                    WHERE a.status IN ('HOLIDAY', 'WEEKLY_OFF')
                      AND (
                        EXISTS (SELECT 1 FROM attendance_raw a2 WHERE a2.emp_code = a.emp_code AND a2.work_date = date(a.work_date, '+1 day') AND a2.status = 'ABSENT')
                        OR
                        EXISTS (SELECT 1 FROM attendance_raw a2 WHERE a2.emp_code = a.emp_code AND a2.work_date = date(a.work_date, '-1 day') AND a2.status = 'ABSENT')
                      )
                ''').fetchall()
                for r_sw in sw_rows:
                    sandwich_set.add((str(r_sw['emp_code']).strip(), str(r_sw['work_date']).strip()))
                    if r_sw['emp_name']:
                        sandwich_set.add((str(r_sw['emp_name']).strip().lower(), str(r_sw['work_date']).strip()))
            finally:
                conn_sw.close()
    except Exception:
        pass

    # ── table cells HTML ──────────────────────────────────────────────────────
    def _th(idx: int, c: str) -> str:
        label = col_headers.get(c, c)
        w = col_widths.get(c)
        style = f' style="width:{w}%"' if w else ""
        handle = (
            f'<div class="col-resize-handle" data-col="{he(c)}" data-idx="{idx}" title="Drag with mouse to adjust column width"></div>'
            if is_preview
            else ""
        )
        return f'<th{style} data-col="{he(c)}" data-idx="{idx}"><span class="th-content">{he(label)}</span>{handle}</th>'

    def _td(c: str, row: dict) -> str:
        val = row.get(c, "")
        if val is None:
            text = '<span class="cell-null">—</span>'
        else:
            val_str = str(val).strip()
            val_upper = val_str.upper()
            c_lower = c.lower()

            if c_lower in ("status", "att_status") or val_upper in ("PRESENT", "ABSENT", "WEEKLY_OFF", "WEEKLY OFF", "WEEKLY-OFF", "OFF", "HOLIDAY", "HALF_DAY"):
                if val_upper == "PRESENT":
                    text = f'<span class="status-cell status-present">{he(val_str)}</span>'
                elif val_upper == "ABSENT":
                    text = f'<span class="status-cell status-absent">{he(val_str)}</span>'
                elif val_upper in ("WEEKLY_OFF", "WEEKLY OFF", "WEEKLY-OFF", "OFF", "HOLIDAY"):
                    emp_code_val = str(row.get('emp_code') or row.get('Code') or '').strip()
                    emp_name_val = str(row.get('emp_name') or row.get('Name') or '').strip().lower()
                    date_val = str(row.get('work_date') or row.get('Date') or '').strip()
                    is_sandwiched = (emp_code_val, date_val) in sandwich_set or (emp_name_val, date_val) in sandwich_set
                    if is_sandwiched:
                        text = f'<span class="status-cell status-sandwich" title="Sandwich rule: absorbed holiday/weekly-off">{he(val_str)}</span>'
                    elif "WEEK" in val_upper or "OFF" in val_upper:
                        text = f'<span class="status-cell status-weeklyoff">{he(val_str)}</span>'
                    else:
                        text = f'<span class="status-cell status-holiday">{he(val_str)}</span>'
                elif val_upper == "HALF_DAY":
                    text = f'<span class="status-cell status-halfday">{he(val_str)}</span>'
                else:
                    text = he(val_str)
            else:
                text = he(val_str)

        w = col_widths.get(c)
        style = f' style="width:{w}%"' if w else ""
        return f'<td{style} data-col="{he(c)}">{text}</td>'

    thead_cells = "".join(_th(i, c) for i, c in enumerate(columns))
    col_group = "".join(
        f'<col class="col-{i}" data-col="{he(c)}"'
        + (f' style="width:{col_widths[c]}%"' if c in col_widths else "")
        + ">"
        for i, c in enumerate(columns)
    )

    tbody_rows_html = ""
    for i, row in enumerate(rows):
        row_class = "even" if i % 2 == 0 else "odd"
        cells = "".join(_td(c, row) for c in columns)
        tbody_rows_html += f'<tr class="{row_class}">{cells}</tr>\n'

    # ── Holidays & Custom schedule note generation ────────────────────────────
    if include_holidays:
        try:
            import core.db as db_mod
            special_days = db_mod.get_holidays_and_custom_timings()
            if special_days:
                hol_lines = ["Special Calendar Days & Custom Schedule:"]
                for sd in special_days:
                    dt = sd.get("date", "")
                    dtype = sd.get("day_type", "WORKING")
                    din = sd.get("day_in", "")
                    dout = sd.get("day_out", "")
                    if dtype == "HOLIDAY":
                        sched = f" (Schedule: {din} → {dout})" if din and dout else ""
                        hol_lines.append(f"• {dt}: HOLIDAY{sched}")
                    elif din or dout:
                        hol_lines.append(f"• {dt}: Custom Timings {din or '—'} → {dout or '—'} ({dtype})")
                hol_text = "\n".join(hol_lines)
                if "Special Calendar Days" not in sql_display:
                    if sql_display.strip():
                        sql_display = sql_display.strip() + "\n\n" + hol_text
                    else:
                        sql_display = hol_text
        except Exception:
            pass

    # ── SQL block ─────────────────────────────────────────────────────────────
    sql_block = ""
    if sql_display:
        sql_lines = he(sql_display[:3500])
        sql_label_text = (
            "CALCULATION RULES & SCHEDULE NOTES"
            if ("formula" in sql_display.lower() or "schedule" in sql_display.lower() or "salary" in title.lower())
            else "SQL QUERY"
        )
        sql_block = f"""
        <section class="sql-block">
          <div class="sql-label">{sql_label_text}</div>
          <pre class="sql-pre">{sql_lines}</pre>
        </section>"""


    # ── generated date & watermark text ───────────────────────────────────────
    gen_date = datetime.now().strftime("%d %b %Y, %I:%M %p")
    org_display = he(org_name) if org_name else "Querii"
    wm_text = (org_name.upper() + " • ") if org_name else "QUERII • "
    logo_img_header = (
        f'<img src="{logo_src}" alt="Logo" class="school-logo report-logo" onerror="this.style.visibility=\'hidden\';">'
        if logo_src
        else ""
    )
    logo_img_watermark = (
        f'<img src="{logo_src}" class="logo-watermark" alt="">'
        if logo_src
        else ""
    )

    body_data_weight = "700" if bold_data else "400"
    grid_lines_class = " grid-lines" if show_grid_lines else ""

    watermark_script = f"""
  <script>
    (function generateDenseWatermark() {{
      var area = document.getElementById('watermarkArea');
      var text = document.getElementById('watermarkText');
      if (!area || !text) return;
      var w = (area.clientWidth || 800) * 2.2;
      var h = (area.clientHeight || 1150) * 2.2;
      text.style.width = w + 'px';
      text.style.height = h + 'px';
      var wt = {json.dumps(wm_text)};
      var probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-family:"Plus Jakarta Sans",sans-serif;font-size:12px;font-weight:800;letter-spacing:.5px;';
      probe.textContent = wt;
      document.body.appendChild(probe);
      var tw = probe.getBoundingClientRect().width || 180;
      probe.remove();
      var rowH = 22;
      var rows = Math.ceil(h / rowH) + 14;
      var cols = Math.ceil(w / tw) + 14;
      var frag = document.createDocumentFragment();
      for (var r = 0; r < rows; r++) {{
        var row = document.createElement('div');
        row.className = 'watermark-row';
        if (r % 2) row.style.transform = 'translateX(-40px)';
        for (var c = 0; c < cols; c++) {{
          var sp = document.createElement('span');
          sp.className = 'watermark-item';
          sp.textContent = wt;
          row.appendChild(sp);
        }}
        frag.appendChild(row);
      }}
      text.appendChild(frag);
    }})();
  </script>
"""

    resize_script = """
  <script>
    (function initColResizer() {
      var handles = document.querySelectorAll('.col-resize-handle');
      if (!handles.length) return;
      var table = document.querySelector('.data-table');
      if (!table) return;

      handles.forEach(function(handle) {
        handle.addEventListener('mousedown', function(e) {
          e.preventDefault();
          e.stopPropagation();

          var idx = parseInt(handle.getAttribute('data-idx'), 10);
          var thA = handle.parentElement;
          var thElements = Array.from(table.querySelectorAll('thead th'));
          var colElements = Array.from(table.querySelectorAll('colgroup col'));
          var colNameA = handle.getAttribute('data-col');
          var thB = (idx + 1 < thElements.length) ? thElements[idx + 1] : null;
          var colNameB = thB ? thB.getAttribute('data-col') : null;

          var tableRect = table.getBoundingClientRect();
          var tableW = tableRect.width || 1;

          var rectA = thA.getBoundingClientRect();
          var startPctA = (rectA.width / tableW) * 100;
          var startPctB = thB ? (thB.getBoundingClientRect().width / tableW) * 100 : 0;
          var combinedPct = startPctA + startPctB;

          var startScreenX = e.screenX;
          handle.classList.add('resizing');
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';

          function onMouseMove(me) {
            var deltaScreen = me.screenX - startScreenX;
            var deltaPct = (deltaScreen / tableW) * 100;

            if (thB && colElements[idx + 1]) {
              var newPctA = Math.max(3, Math.min(combinedPct - 3, Math.round(startPctA + deltaPct)));
              var newPctB = Math.max(3, Math.round(combinedPct - newPctA));

              if (colElements[idx]) colElements[idx].style.width = newPctA + '%';
              thA.style.width = newPctA + '%';

              colElements[idx + 1].style.width = newPctB + '%';
              thB.style.width = newPctB + '%';

              if (window.parent && window.parent._devOnColumnsResized) {
                window.parent._devOnColumnsResized(colNameA, newPctA, colNameB, newPctB);
              }
            } else {
              var newPctSingle = Math.max(3, Math.min(95, Math.round(startPctA + deltaPct)));
              if (colElements[idx]) colElements[idx].style.width = newPctSingle + '%';
              thA.style.width = newPctSingle + '%';

              if (window.parent && window.parent._devOnColumnDragged) {
                window.parent._devOnColumnDragged(colNameA, newPctSingle);
              }
            }
          }

          function onMouseUp() {
            handle.classList.remove('resizing');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('mousemove', onMouseMove, true);
            window.removeEventListener('mouseup', onMouseUp, true);
            document.removeEventListener('mousemove', onMouseMove, true);
            document.removeEventListener('mouseup', onMouseUp, true);
            try {
              if (window.parent && window.parent !== window) {
                window.parent.removeEventListener('mousemove', onMouseMove, true);
                window.parent.removeEventListener('mouseup', onMouseUp, true);
              }
            } catch(err) {}

            if (window.parent && window.parent._devOnColumnDragEnd) {
              window.parent._devOnColumnDragEnd(colNameA, colNameB);
            }
          }

          window.addEventListener('mousemove', onMouseMove, true);
          window.addEventListener('mouseup', onMouseUp, true);
          document.addEventListener('mousemove', onMouseMove, true);
          document.addEventListener('mouseup', onMouseUp, true);
          try {
            if (window.parent && window.parent !== window) {
              window.parent.addEventListener('mousemove', onMouseMove, true);
              window.parent.addEventListener('mouseup', onMouseUp, true);
            }
          } catch(err) {}
        });
      });
    })();
  </script>
"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{he(title)}</title>
  <style>
    @font-face {{
      font-family: 'Libron';
      src: url('data:font/woff2;base64,{_LIBRON_REG_B64}') format('woff2');
      font-weight: 400;
      font-style: normal;
    }}
    @font-face {{
      font-family: 'Libron';
      src: url('data:font/woff2;base64,{_LIBRON_BOLD_B64}') format('woff2');
      font-weight: 700;
      font-style: normal;
    }}
    @font-face {{
      font-family: 'Libron';
      src: url('data:font/woff2;base64,{_LIBRON_ITALIC_B64}') format('woff2');
      font-weight: 400;
      font-style: italic;
    }}
    @font-face {{
      font-family: 'Libron';
      src: url('data:font/woff2;base64,{_LIBRON_BOLD_ITALIC_B64}') format('woff2');
      font-weight: 700;
      font-style: italic;
    }}

    :root {{
      --page-w: {pw};
      --page-h: {ph};
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
      --row-alt: #f8fafc;
      --table-head-bg: #0f172a;
      --table-head-text: #ffffff;
      --header-bg: #f8fafc;
      --data-font-weight: {body_data_weight};
    }}

    * {{
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }}

    html, body {{
      margin: 0;
      padding: 0;
      background: {'#334155' if is_preview else '#ffffff'};
      color: var(--text);
      font-family: 'Libron', Georgia, serif;
      font-size: 8.5pt;
      line-height: 1.35;
      -webkit-font-smoothing: antialiased;
      {'width: 100%; height: 100%; overflow: auto;' if is_preview else ''}
    }}

    {'/* Studio Viewport for Preview */ .preview-viewport { display: block; text-align: center; padding: 28px 24px 48px; min-width: max-content; margin: 0 auto; box-sizing: border-box; }' if is_preview else ''}

    /* Paper Page Sheet (Authentic Physical Preview) */
    .pdf-page-sheet, .page {{
      {'display: inline-block; vertical-align: top; text-align: left;' if is_preview else ''}
      width: {'var(--page-w)' if is_preview else '100%'};
      {'height: var(--page-h); max-height: var(--page-h); overflow: hidden; transform-origin: top center; transition: transform 0.15s ease-out;' if is_preview else 'min-height: 0;'}
      max-width: {'var(--page-w)' if is_preview else '100%'};
      background: #ffffff;
      padding: {'12mm 14mm' if is_preview else '0'};
      box-sizing: border-box;
      position: relative;
      {'border: 1px solid #94a3b8; box-shadow: 0 16px 40px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.15); border-radius: 2px;' if is_preview else ''}
    }}

    /* Scalable Document Content Container (Scales content without shrinking the physical paper sheet) */
    .sheet-content {{
      position: relative;
      z-index: 10;
      width: 100%;
      box-sizing: border-box;
      zoom: {scale};
      transform-origin: top left;
    }}

    /* Document border frame */
    .document-frame {{
      position: absolute;
      top: 6mm;
      right: 6mm;
      bottom: 6mm;
      left: 6mm;
      border: 1.2px solid #9ca8b7;
      pointer-events: none;
      z-index: 30;
    }}
    .document-frame::after {{
      content: "";
      position: absolute;
      top: 2mm;
      right: 2mm;
      bottom: 2mm;
      left: 2mm;
      border: .5px solid #e1e6eb;
    }}

    /* Watermark */
    .watermark-area {{
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      overflow: hidden;
      pointer-events: none;
      z-index: 0;
    }}
    .watermark-text {{
      position: absolute;
      left: -30%;
      top: -30%;
      display: flex;
      flex-direction: column;
      transform: rotate(-28deg);
      opacity: .055;
      z-index: 1;
    }}
    .watermark-row {{
      display: flex;
      flex-shrink: 0;
      align-items: center;
      height: 22px;
      white-space: nowrap;
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      font-size: 12px;
      font-weight: 800;
      line-height: 22px;
      letter-spacing: .5px;
      color: #475569;
    }}
    .watermark-item {{
      flex-shrink: 0;
    }}
    .logo-watermark-zone {{
      position: absolute;
      width: 140mm;
      height: 140mm;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border-radius: 50%;
      z-index: 5;
    }}
    .logo-watermark {{
      width: 140mm;
      height: 140mm;
      object-fit: contain;
      opacity: .045;
      filter: grayscale(100%);
    }}

    /* Keep content above watermark */
    .pdf-page-sheet > *:not(.watermark-area):not(.document-frame) {{
      position: relative;
      z-index: 10;
    }}

    /* Organisation Header */
    .school-header, .masthead {{
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 18px;
      padding: 12px 20px;
      background: var(--header-bg);
      border: 1px solid var(--border);
      border-top: 3px solid var(--gold);
      border-radius: 10px;
      margin-bottom: 14px;
      text-align: center;
      break-inside: avoid;
    }}
    .school-logo, .report-logo {{
      width: 60px;
      height: 60px;
      object-fit: contain;
      flex-shrink: 0;
      border-radius: 6px;
    }}
    .school-info {{
      display: flex;
      flex-direction: column;
      align-items: center;
    }}
    .school-info h2, .org-title {{
      margin: 0;
      font-family: 'Libron', Georgia, serif;
      font-size: 21px;
      line-height: 1.2;
      font-weight: 800;
      color: var(--navy);
      letter-spacing: -0.01em;
    }}

    /* Document Heading */
    .document-heading {{
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2px 0 10px;
      margin-bottom: 14px;
      text-align: center;
      border-bottom: 2px solid var(--navy);
      break-inside: avoid;
    }}
    .heading-accent {{
      width: 48px;
      height: 3px;
      margin-bottom: 6px;
      background: var(--gold);
      border-radius: 4px;
    }}
    .title, .report-title {{
      margin: 0;
      width: 100%;
      font-family: 'Libron', Georgia, serif;
      font-size: 22px;
      line-height: 1.2;
      font-weight: 800;
      color: var(--navy);
    }}

    /* Data Table — Compact Apple-style with high density */
    .data-table-wrap {{
      width: 100%;
      margin-bottom: 12px;
    }}
    .data-table {{
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-family: 'Libron', Georgia, serif;
      font-size: 8.5pt;
      line-height: 1.3;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      table-layout: auto;
    }}
    .data-table thead {{
      display: table-header-group;
    }}
    .data-table thead th {{
      position: relative;
      background: var(--table-head-bg);
      color: var(--table-head-text);
      padding: 6px 7px;
      font-weight: 700;
      font-size: 8pt;
      text-align: left;
      border-bottom: 2px solid var(--gold);
      letter-spacing: 0.03em;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }}
    .data-table thead th:first-child {{ border-top-left-radius: 7px; }}
    .data-table thead th:last-child  {{ border-top-right-radius: 7px; }}

    .data-table tbody tr {{
      break-inside: avoid;
      page-break-inside: avoid;
    }}
    .data-table tbody td {{
      padding: 5px 7px;
      border-bottom: 1px solid var(--border-light);
      color: var(--text);
      vertical-align: middle;
      font-variant-numeric: tabular-nums;
      font-weight: var(--data-font-weight);
      word-break: break-word;
      overflow-wrap: break-word;
      background: #ffffff;
    }}
    .data-table tbody tr:nth-child(even) td,
    .data-table tbody tr.even td {{
      background: var(--row-alt, #f1f5f9);
    }}
    .data-table tbody tr:hover td {{
      background: #f1f5f9;
    }}
    .data-table tbody tr:last-child td {{
      border-bottom: none;
    }}
    .data-table tbody tr:last-child td:first-child {{ border-bottom-left-radius: 7px; }}
    .data-table tbody tr:last-child td:last-child  {{ border-bottom-right-radius: 7px; }}

    /* Status Badges with High Contrast Visual Feedback */
    .status-cell {{
      display: inline-block;
      font-weight: 700;
      border-radius: 4px;
      padding: 1.5px 6px;
      font-size: 7.5pt;
      line-height: 1.25;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }}
    .status-present {{
      color: #15803d !important;
      background: #dcfce7 !important;
      border: 1px solid #86efac;
    }}
    .status-absent {{
      color: #b91c1c !important;
      background: #fee2e2 !important;
      border: 1px solid #fca5a5;
    }}
    .status-weeklyoff, .status-holiday {{
      color: #1d4ed8 !important;
      background: #dbeafe !important;
      border: 1px solid #93c5fd;
    }}
    .status-sandwich {{
      color: #b91c1c !important;
      background: #fee2e2 !important;
      border: 1px dashed #ef4444;
      font-weight: 800;
    }}
    .status-halfday {{
      color: #b45309 !important;
      background: #fef3c7 !important;
      border: 1px solid #fde68a;
    }}

    /* Vertical grid lines when enabled */
    .data-table.grid-lines th,
    .data-table.grid-lines td {{
      border-right: 1px solid var(--border);
    }}
    .data-table.grid-lines th:last-child,
    .data-table.grid-lines td:last-child {{
      border-right: none;
    }}

    /* Interactive Column Resize Handles in Dev Preview */
    .col-resize-handle {{
      position: absolute;
      top: 0;
      right: -3px;
      bottom: 0;
      width: 7px;
      cursor: col-resize;
      z-index: 10;
      user-select: none;
      background: transparent;
      transition: background 0.15s;
    }}
    .col-resize-handle:hover,
    .col-resize-handle.resizing {{
      background: rgba(37, 99, 235, 0.7);
    }}

    /* Footer — Timestamp and Page Number only */
    .report-footer {{
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--border-light);
      font-size: 7.5pt;
      color: var(--muted);
      font-weight: 600;
      break-inside: avoid;
    }}

    /* SQL Box */
    .sql-block {{
      margin-top: 12px;
      background: #f8fafc;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px;
      break-inside: avoid;
    }}
    .sql-label {{
      font-size: 7pt;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--muted);
      letter-spacing: 0.05em;
      margin-bottom: 4px;
    }}
    .sql-pre {{
      margin: 0;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 7pt;
      color: #334155;
      white-space: pre-wrap;
      word-break: break-all;
    }}

    /* Print Rules */
    @page {{
      size: {css_page_size};
      margin: 10mm 12mm 12mm 12mm;
    }}
    @media print {{
      html, body {{
        background: #ffffff !important;
        padding: 0 !important;
        margin: 0 !important;
        display: block !important;
        zoom: 1 !important;
      }}
      .preview-viewport {{
        padding: 0 !important;
        display: block !important;
        min-width: 0 !important;
      }}
      .pdf-page-sheet, .page {{
        width: 100% !important;
        max-width: 100% !important;
        height: auto !important;
        max-height: none !important;
        box-shadow: none !important;
        border: none !important;
        border-radius: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        overflow: visible !important;
        transform: none !important;
        zoom: 1 !important;
      }}
      .sheet-content {{
        zoom: {scale} !important;
        width: 100% !important;
      }}
      .document-frame {{
        display: none !important;
      }}
      .watermark-area {{
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        width: 100% !important;
        height: 100% !important;
        overflow: hidden !important;
        pointer-events: none !important;
        z-index: 0 !important;
        zoom: 1 !important;
      }}
      .watermark-text {{
        opacity: .055 !important;
      }}
      .col-resize-handle, .page-indicator {{
        display: none !important;
      }}
      .school-header, .document-heading, .report-footer {{
        break-inside: avoid;
      }}
      .data-table {{
        page-break-inside: auto;
      }}
      .data-table tr {{
        page-break-inside: avoid;
        break-inside: avoid;
      }}
    }}

    /* ── USER CUSTOM CSS (Injected) ── */
{custom_css}

{"" if full_override else f'''
    /* ── ENFORCED PAGE GEOMETRY & ORIENTATION (Wins Cascade Over Pasted CSS) ── */
    :root {{
      --page-w: {pw} !important;
      --page-h: {ph} !important;
    }}
    @page {{
      size: {css_page_size};
    }}
    .pdf-page-sheet, .page {{
      width: {pw if is_preview else "100%"} !important;
      max-width: {pw if is_preview else "100%"} !important;
      {"height: " + ph + " !important; max-height: " + ph + " !important;" if is_preview else ""}
    }}
'''}
  </style>
</head>
{"<body>" if not is_preview else '<body><div class="preview-viewport">'}
  <main class="pdf-page-sheet page" id="pdfPageSheet">
    <!-- Document border frame -->
    <div class="document-frame" aria-hidden="true"></div>

    {f'''<!-- Background Watermark -->
    <div class="watermark-area" id="watermarkArea" aria-hidden="true">
      <div class="watermark-text" id="watermarkText"></div>
      <div class="logo-watermark-zone">
        {logo_img_watermark}
      </div>
    </div>''' if include_watermark else ""}

    <!-- Scalable Document Content Container -->
    <div class="sheet-content" id="sheetContent">
      <!-- Organisation Header -->
      <header class="school-header masthead">
        {logo_img_header}
        <div class="school-info">
          <h2 class="org-title">{org_display}</h2>
        </div>
      </header>

      <!-- Document Heading -->
      <section class="document-heading">
        <div class="heading-accent"></div>
        <h1 class="title report-title">{he(title)}</h1>
      </section>

      <!-- Data Table -->
      <div class="data-table-wrap">
        <table class="data-table{grid_lines_class}">
          <colgroup>{col_group}</colgroup>
          <thead><tr>{thead_cells}</tr></thead>
          <tbody>{tbody_rows_html}</tbody>
        </table>
      </div>

      <!-- Footer -->
      <footer class="report-footer">
        <div class="footer-timestamp">Generated: {gen_date}</div>
        <div class="footer-page">Page 1 of 1</div>
      </footer>

      {sql_block}
    </div>
  </main>
{f'''  <div class="page-indicator" style="margin-top:14px;font-family:system-ui,-apple-system,sans-serif;font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:0.04em">
    ── Page 1 Physical Paper Boundary ({pw} × {ph}) ──
  </div>
</div>''' if is_preview else ""}
  {watermark_script if include_watermark else ""}
  {resize_script if is_preview else ""}
</body>
</html>"""
    return html


def export_pdf_html(
    columns: List[str],
    rows: List[Dict],
    filepath: str,
    title: str = "Query Results",
    org_name: str = "",
    logo_b64: str = "",
    sql_display: str = "",
    source_label: str = "",
    custom_css: str = "",
    page_size: str = "A4",
    orientation: str = "portrait",
    scale: float = 1.0,
    col_widths: Dict[str, float] = None,
    col_headers: Dict[str, str] = None,
    col_visible: List[str] = None,
    full_override: bool = False,
    bold_data: bool = False,
    show_grid_lines: bool = False,
    include_watermark: bool = True,
    include_holidays: bool = True,
) -> None:
    """
    Render query results to PDF using headless native Chromium/Chrome.
    Falls back to export_pdf() (which uses Rust native engine) if Chromium is unavailable.
    """
    chromium = _find_chromium()
    if not chromium:
        print("[PDF HTML] Chromium not found — using fast native Rust/ReportLab engine.")
        export_pdf(
            columns=columns, rows=rows, filepath=filepath,
            title=title, org_name=org_name, logo_b64=logo_b64,
            sql_display=sql_display, source_label=source_label,
            page_size=page_size, orientation=orientation, scale=scale,
            col_widths=col_widths, col_headers=col_headers, col_visible=col_visible,
        )
        return

    html_content = _build_pdf_html(
        columns=columns, rows=rows, title=title, org_name=org_name,
        logo_b64=logo_b64, sql_display=sql_display, source_label=source_label,
        custom_css=custom_css, page_size=page_size, orientation=orientation,
        scale=scale,
        col_widths=col_widths, col_headers=col_headers, col_visible=col_visible,
        full_override=full_override, bold_data=bold_data, show_grid_lines=show_grid_lines,
        is_preview=False,
        include_watermark=include_watermark,
        include_holidays=include_holidays,
    )

    out_path = str(Path(filepath).resolve())

    # Write HTML to temp file
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".html", encoding="utf-8", delete=False
    ) as tmp:
        tmp.write(html_content)
        tmp_html = tmp.name

    try:
        cmd = [
            chromium,
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            f"--print-to-pdf={out_path}",
            "--no-pdf-header-footer",
            f"file://{tmp_html}",
        ]
        result = subprocess.run(
            cmd,
            timeout=45,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 or not Path(out_path).exists() or Path(out_path).stat().st_size < 500:
            raise RuntimeError(f"Chromium exit {result.returncode}: {result.stderr[:300]}")
        print(f"[PDF HTML] Successfully exported to {out_path} via Chromium.")
    except Exception as exc:
        print(f"[PDF HTML] Chromium error: {exc}. Falling back to Rust/ReportLab engine.")
        export_pdf(
            columns=columns, rows=rows, filepath=filepath,
            title=title, org_name=org_name, logo_b64=logo_b64,
            sql_display=sql_display, source_label=source_label,
            page_size=page_size, orientation=orientation, scale=scale,
            col_widths=col_widths, col_headers=col_headers, col_visible=col_visible,
        )
    finally:
        try:
            os.unlink(tmp_html)
        except Exception:
            pass


def get_pdf_html_preview(
    columns: List[str],
    rows: List[Dict],
    title: str = "Query Results",
    org_name: str = "",
    logo_b64: str = "",
    sql_display: str = "",
    source_label: str = "",
    custom_css: str = "",
    page_size: str = "A4",
    orientation: str = "portrait",
    scale: float = 1.0,
    col_widths: Optional[Dict[str, float]] = None,
    col_headers: Optional[Dict[str, str]] = None,
    col_visible: Optional[List[str]] = None,
    full_override: bool = False,
    bold_data: bool = False,
    show_grid_lines: bool = False,
    include_watermark: bool = True,
    include_holidays: bool = True,
) -> str:
    """Return the HTML string for in-app preview (iframe srcdoc) with exact paper geometry."""
    return _build_pdf_html(
        columns=columns, rows=rows, title=title, org_name=org_name,
        logo_b64=logo_b64, sql_display=sql_display, source_label=source_label,
        custom_css=custom_css, page_size=page_size, orientation=orientation,
        scale=scale,
        col_widths=col_widths, col_headers=col_headers, col_visible=col_visible,
        full_override=full_override, bold_data=bold_data, show_grid_lines=show_grid_lines,
        is_preview=True,
        include_watermark=include_watermark,
        include_holidays=include_holidays,
    )



# ---------------------------------------------------------------------------
# Dev-mode three-file workflow
# ---------------------------------------------------------------------------

_DEV_DIR = Path(tempfile.gettempdir()) / "querii_dev"


def open_dev_files(
    columns: List[str],
    rows: List[Dict],
    title: str = "Query Results",
    org_name: str = "",
    custom_css: str = "",
    page_size: str = "A4",
    orientation: str = "portrait",
    querii_path: str = "",
    full_override: bool = False,
) -> dict:
    """Write data.csv, style.css, render.py to the temporary dev directory."""
    import csv as csv_mod
    _DEV_DIR.mkdir(parents=True, exist_ok=True)
    qpath = querii_path or str(Path(__file__).parent.parent)
    orient_suffix = " landscape" if orientation == "landscape" else ""

    # 1) data.csv
    csv_path = _DEV_DIR / "data.csv"
    with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv_mod.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        w.writeheader()
        for row in rows:
            w.writerow({c: row.get(c, "") for c in columns})

    # 2) style.css
    css_path = _DEV_DIR / "style.css"
    header = f"""\
/*
 * Querii Dev Mode — Custom CSS
 * Page: {page_size} {orientation}
 *
 * Styleable classes:
 *   .report-header, .report-logo, .org-title, .report-title, .gen-date
 *   .badge, .badge-records, .badge-source
 *   .data-table, .data-table thead th, .data-table tbody td
 *   .data-table tbody tr.even, .data-table tbody tr.odd
 *   .report-footer, .sql-block, .sql-pre
 *
 * Override @page for {page_size}{orient_suffix}:
 *   @page {{ size: {page_size}{orient_suffix}; margin: 12mm 14mm; }}
 */

"""
    css_path.write_text(header + (custom_css or ""), encoding="utf-8")

    # 3) render.py
    script_path = _DEV_DIR / "render.py"
    script_path.write_text(f"""\
#!/usr/bin/env python3
\"\"\"Querii Dev Mode — Fast Standalone PDF renderer using Chromium.\"\"\"
import csv, sys, subprocess
from pathlib import Path
HERE = Path(__file__).parent
sys.path.insert(0, {qpath!r})
from core.exporter import export_pdf_html

rows, columns = [], []
with open(HERE / 'data.csv', encoding='utf-8-sig') as f:
    r = csv.DictReader(f); columns = list(r.fieldnames or []); rows = list(r)
css = (HERE / 'style.css').read_text(encoding='utf-8')
out = HERE / 'output.pdf'

export_pdf_html(
    columns=columns, rows=rows, filepath=str(out),
    title={title!r}, org_name={org_name!r},
    custom_css=css, page_size={page_size!r}, orientation={orientation!r},
    full_override={full_override}
)
print(f'PDF saved: {{out}}')
""", encoding="utf-8")
    script_path.chmod(0o755)
    return {"dir": str(_DEV_DIR), "csv": str(csv_path), "css": str(css_path), "script": str(script_path)}


write_dev_files = open_dev_files


def read_dev_file(name: str) -> str:
    allowed = {"data.csv", "style.css", "render.py"}
    if name not in allowed:
        raise ValueError(f"Unknown dev file: {name}")
    p = _DEV_DIR / name
    return p.read_text(encoding="utf-8") if p.exists() else ""


def write_dev_file_content(name: str, content: str) -> None:
    allowed = {"data.csv", "style.css", "render.py"}
    if name not in allowed:
        raise ValueError(f"Unknown dev file: {name}")
    _DEV_DIR.mkdir(parents=True, exist_ok=True)
    (_DEV_DIR / name).write_text(content, encoding="utf-8")


# ---------------------------------------------------------------------------
# PDF Main Exporter: Rust Native Engine (Primary) + ReportLab (Fallback)
# ---------------------------------------------------------------------------

def export_pdf(
    columns: List[str],
    rows: List[Dict],
    filepath: str,
    title: str = "Query Results",
    subtitle: str = "",
    org_name: str = "",
    logo_b64: str = "",
    sql_display: str = "",
    theme_colors: Optional[dict] = None,
    page_size: str = "A4",
    orientation: str = "portrait",
    scale: float = 1.0,
    continuous: bool = False,
    source_label: str = "",
    col_widths: Optional[Dict[str, float]] = None,
    col_headers: Optional[Dict[str, str]] = None,
    col_visible: Optional[List[str]] = None,
) -> None:
    """
    Render query results to PDF.
    First tries the ultra-fast native Rust engine (<50ms).
    Falls back to ReportLab classic renderer if Rust engine is unavailable.
    """
    # 1. Try Rust native engine
    if export_pdf_rust(
        columns=columns,
        rows=rows,
        filepath=filepath,
        title=title,
        org_name=org_name,
        source_label=source_label,
        sql_display=sql_display,
        page_size=page_size,
        orientation=orientation,
        scale=scale,
        theme="modern",
        col_widths=col_widths,
        col_headers=col_headers,
        col_visible=col_visible,
    ):
        print(f"[PDF Export] Successfully exported to {filepath} using native Rust engine.")
        return

    # 2. ReportLab Fallback
    print(f"[PDF Export] Rust engine unavailable; using ReportLab fallback.")
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, A3, letter
        from reportlab.lib.pagesizes import landscape as rl_landscape
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate, Table, TableStyle,
            Paragraph, Spacer, HRFlowable,
        )
        from reportlab.lib.enums import TA_CENTER
        import tempfile as _tmp
    except ImportError:
        raise ImportError("Neither querii-pdf nor reportlab is available.")

    out_path = str(Path(filepath).resolve())
    tc = theme_colors or {}
    c_bg = colors.HexColor(tc.get("bg", "#ffffff"))
    c_text = colors.HexColor(tc.get("text", "#0f172a"))
    c_head = colors.HexColor(tc.get("head", "#0f172a"))
    c_border = colors.HexColor(tc.get("border", "#cbd5e1"))
    scale = max(0.4, min(2.0, float(scale or 1.0)))

    has_logo = bool(logo_b64)
    top_margin = int((20 if has_logo else 14) * mm * scale)
    h_margin = int(12 * mm * scale)
    b_margin = int(14 * mm * scale)

    PAGE_SIZES = {"A4": A4, "A3": A3, "Letter": letter}
    base_pagesize = PAGE_SIZES.get(page_size, A4)
    if orientation == "landscape":
        base_pagesize = rl_landscape(base_pagesize)

    if continuous:
        est_row_h = int(6 * mm * scale)
        header_block = int(40 * mm * scale)
        footer_block = int(20 * mm * scale)
        buffer = int(20 * mm)
        table_height = (len(rows) + 1) * est_row_h
        est_height = top_margin + header_block + table_height + footer_block + b_margin + buffer
        page_w = base_pagesize[0]
        page_h = max(297 * mm, est_height)
        pagesize = (page_w, page_h)
    else:
        pagesize = base_pagesize

    doc = SimpleDocTemplate(
        out_path, pagesize=pagesize,
        rightMargin=h_margin, leftMargin=h_margin,
        topMargin=top_margin, bottomMargin=b_margin,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "QTitle", parent=styles["Normal"],
        fontSize=int(14 * scale), fontName="Helvetica-Bold",
        textColor=c_head, spaceAfter=3, alignment=TA_CENTER
    )
    sub_style = ParagraphStyle(
        "QSub", parent=styles["Normal"],
        fontSize=int(8 * scale), fontName="Helvetica",
        textColor=c_text, spaceAfter=2, alignment=TA_CENTER
    )
    cell_style = ParagraphStyle(
        "QCell", parent=styles["Normal"],
        fontSize=int(7.5 * scale), fontName="Helvetica",
        textColor=c_text, wordWrap="CJK"
    )
    hdr_cell_style = ParagraphStyle(
        "QHdrCell", parent=styles["Normal"],
        fontSize=int(7.5 * scale), fontName="Helvetica-Bold",
        textColor=colors.white, wordWrap="CJK"
    )

    story: list = []
    _logo_tmp = None
    if logo_b64:
        try:
            from reportlab.platypus import Image as RLImage
            from reportlab.lib.utils import ImageReader
            import base64 as b64
            logo_bytes = b64.b64decode(logo_b64)
            _logo_tmp = _tmp.NamedTemporaryFile(delete=False, suffix=".png")
            _logo_tmp.write(logo_bytes)
            _logo_tmp.flush()
            _logo_tmp.close()
            img_reader = ImageReader(_logo_tmp.name)
            img_w, img_h = img_reader.getSize()
            aspect = img_w / float(img_h)
            target_h = int(20 * mm * scale)
            target_w = target_h * aspect
            page_w_avail = pagesize[0] - 2 * h_margin
            if target_w > page_w_avail:
                target_w = page_w_avail
                target_h = int(target_w / aspect)
            img = RLImage(_logo_tmp.name, width=target_w, height=target_h)
            img.hAlign = "CENTER"
            story.append(img)
            story.append(Spacer(1, int(2 * mm)))
        except Exception:
            pass

    display_title = title or "Query Results"
    if org_name:
        story.append(Paragraph(org_name.upper(), sub_style))
    story.append(Paragraph(display_title, title_style))
    story.append(Paragraph(f"Generated: {datetime.now().strftime('%d %b %Y, %I:%M %p')}", sub_style))
    story.append(Spacer(1, int(2 * mm)))
    story.append(HRFlowable(width="100%", thickness=1, color=c_border))
    story.append(Spacer(1, int(3 * mm)))

    if not rows:
        story.append(Paragraph("No records found.", styles["Normal"]))
        doc.build(story)
        return

    # Filter columns
    active_cols = columns
    if col_visible:
        vis_set = set(col_visible)
        active_cols = [c for c in columns if c in vis_set]

    headers_dict = col_headers or {}
    header_row = [
        Paragraph(f"<b>{he(headers_dict.get(col, col))}</b>", hdr_cell_style)
        for col in active_cols
    ]
    data = [header_row]
    for row in rows:
        data.append([
            Paragraph(he(str(row.get(col, "") if row.get(col) is not None else "—")), cell_style)
            for col in active_cols
        ])

    avail_w = pagesize[0] - 2 * h_margin
    col_w = avail_w / max(len(active_cols), 1)
    col_widths_list = [col_w] * len(active_cols)
    pad = int(4 * scale)

    table = Table(data, colWidths=col_widths_list, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), c_head),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), int(7.5 * scale)),
        ("BOTTOMPADDING", (0, 0), (-1, 0), pad + 1),
        ("TOPPADDING", (0, 0), (-1, 0), pad + 1),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 1), (-1, -1), int(7 * scale)),
        ("BOTTOMPADDING", (0, 1), (-1, -1), pad),
        ("TOPPADDING", (0, 1), (-1, -1), pad),
        ("LEFTPADDING", (0, 0), (-1, -1), pad),
        ("RIGHTPADDING", (0, 0), (-1, -1), pad),
        ("GRID", (0, 0), (-1, -1), 0.35, c_border),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
    ]))
    story.append(table)
    story.append(Spacer(1, int(4 * mm)))

    footer_parts = [f"Total Records: {len(rows):,}", "Querii Analytics"]
    if source_label:
        footer_parts.insert(1, f"Source: {source_label}")
    story.append(Paragraph("  |  ".join(footer_parts), sub_style))

    if sql_display:
        sql_style = ParagraphStyle(
            "QSql", parent=styles["Normal"],
            fontSize=int(6.5 * scale), fontName="Courier",
            textColor=colors.HexColor("#475569"),
            spaceAfter=2, leftIndent=4, leading=int(8 * scale)
        )
        sql_lbl = ParagraphStyle(
            "QSqlLbl", parent=styles["Normal"],
            fontSize=int(6.5 * scale), fontName="Courier-Bold",
            textColor=colors.HexColor("#1e293b"), spaceAfter=1
        )
        story.append(HRFlowable(width="100%", thickness=0.5, color=c_border))
        story.append(Spacer(1, int(2 * mm)))
        story.append(Paragraph("SQL Query:", sql_lbl))
        for line in sql_display.split("\n")[:25]:
            if line.strip():
                story.append(Paragraph(he(line).replace(" ", "&nbsp;"), sql_style))

    doc.build(story)
    if _logo_tmp is not None:
        try:
            os.unlink(_logo_tmp.name)
        except Exception:
            pass
