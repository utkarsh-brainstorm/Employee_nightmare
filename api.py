"""
api.py (v4)
===========
Python API exposed to the webview frontend via window.pywebview.api.
Every public method returns { ok: bool, data: any, error: str | None }

V4 additions:
  - run_filter supports select_exprs, select_labels, select_is_agg,
    group_by_exprs, having; returns mode='dual' on conflict
  - get_last_import / check_filepath_exists for auto-load last file
  - export_pdf passes sql_display to exporter
  - import_file calls store_last_filepath
"""

from __future__ import annotations

import base64
import json
import os
import threading
import traceback
from typing import Any, Dict, List, Optional

import webview

import core.db as db
from core.parser import parse_file
from core import exporter
from core.exporter import (
    export_pdf_html, get_pdf_html_preview,
    write_dev_files, read_dev_file, write_dev_file_content,
)
from core.salary_engine import compute_salary_report, compute_salary_for_employee
from core.query_builder import (
    FilterRow, QuerySpec, build_sql, build_detail_sql,
    detect_group_conflict,
    format_sql_readable,
    FIELD_MAP, FIELD_CATEGORIES, get_operators_for_field, get_value_options_for_field,
    SELECT_COLS, GROUPBY_COLS,
)


def _ok(data: Any = None) -> dict:
    return {"ok": True, "data": data, "error": None}


def _err(msg: Any) -> dict:
    return {"ok": False, "data": None, "error": str(msg)}


class Api:
    def __init__(self):
        self._window: Optional[webview.Window] = None
        self._import_lock = threading.Lock()
        self._last_result_cols: List[str] = []
        self._last_result_rows: List[dict] = []

    def set_window(self, window: webview.Window):
        self._window = window

    # ----------------------------------------------------------------
    # Settings
    # ----------------------------------------------------------------

    def get_settings(self) -> dict:
        try:
            keys = [
                "checkin_time", "checkout_time",
                "late_threshold", "early_leave_threshold",
                "working_days_per_month",
                "org_name", "org_logo_b64", "org_logo_sq_b64",
                "ap_theme", "ap_zoom", "ap_panels", "ap_custom_reports",
                "holidays_paid", "weeklyoff_paid", "sandwich_rule",
                "ap_pdf_dir", "pdf_custom_css", "pdf_dev_mode",
                "pdf_custom_styles",
            ]
            return _ok({k: db.get_setting(k) for k in keys})
        except Exception as e:
            return _err(e)

    def save_settings(self, settings: dict) -> dict:
        try:
            time_keys = {"checkin_time", "checkout_time"}
            needs_recompute = any(k in time_keys for k in settings.keys())
            for k, v in settings.items():
                db.set_setting(str(k), str(v) if v is not None else "")
            if needs_recompute:
                try:
                    from core.recompute import recompute_all
                    recompute_all()
                except Exception as ex:
                    print(f"[save_settings recompute error] {ex}")
            return _ok("Saved.")
        except Exception as e:
            return _err(e)


    # ----------------------------------------------------------------
    # Database info
    # ----------------------------------------------------------------

    def get_db_status(self) -> dict:
        try:
            mn, mx = db.get_date_range()
            return _ok({"min_date": mn, "max_date": mx})
        except Exception as e:
            return _err(e)

    def get_import_history(self) -> dict:
        try:
            return _ok(db.get_import_history())
        except Exception as e:
            return _err(e)

    def get_app_data_path(self) -> dict:
        try:
            return _ok(os.path.dirname(db.get_db_path()))
        except Exception as e:
            return _err(e)

    def get_last_import(self) -> dict:
        """Return the most recent import_log row + filepath_hint."""
        try:
            return _ok(db.get_last_import())
        except Exception as e:
            return _err(e)

    def check_filepath_exists(self, filepath: str) -> dict:
        """Check if a file path exists on disk."""
        try:
            return _ok(os.path.isfile(filepath))
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # File dialogs
    # ----------------------------------------------------------------

    def open_file_dialog(self) -> dict:
        try:
            if self._window is None:
                return _err("Window not ready.")
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=("Excel Files (*.xls;*.xlsx;*.xlsm)", "All files (*.*)"),
            )
            if result:
                return _ok(result[0])
            return _ok(None)
        except Exception as e:
            return _err(e)

    def open_file_dialog_type(self, file_type: str = "image") -> dict:
        try:
            if self._window is None:
                return _err("Window not ready.")
            if file_type == "image":
                types = ("PNG Images (*.png)", "All files (*.*)",)
            else:
                types = ("All files (*.*)",)
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=types,
            )
            if result:
                return _ok(result[0])
            return _ok(None)
        except Exception as e:
            return _err(e)

    def read_file_as_b64(self, filepath: str) -> dict:
        try:
            if not os.path.isfile(filepath):
                return _err(f"File not found: {filepath}")
            size = os.path.getsize(filepath)
            if size > 5 * 1024 * 1024:
                return _err("File too large (max 5 MB for logo).")
            with open(filepath, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
            return _ok(data)
        except Exception as e:
            return _err(e)

    def save_file_dialog(self, default_name: str = "export", ext: str = "csv") -> dict:
        try:
            if self._window is None:
                return _err("Window not ready.")
            if ext == "pdf":
                types = ("PDF Files (*.pdf)",)
                default = default_name + ".pdf"
            else:
                types = ("CSV Files (*.csv)",)
                default = default_name + ".csv"
            result = self._window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=default,
                file_types=types,
            )
            if result:
                path = result if isinstance(result, str) else result[0]
                return _ok(path)
            return _ok(None)
        except Exception as e:
            return _err(e)

    def get_default_downloads_dir(self) -> dict:
        """Return the platform-default Downloads folder."""
        try:
            home = os.path.expanduser("~")
            downloads = os.path.join(home, "Downloads")
            xdg_dirs = os.path.join(home, ".config", "user-dirs.dirs")
            if os.path.isfile(xdg_dirs):
                with open(xdg_dirs) as f:
                    for line in f:
                        if line.startswith("XDG_DOWNLOAD_DIR"):
                            val = line.split("=", 1)[1].strip().strip('"').replace("$HOME", home)
                            if os.path.isdir(val):
                                downloads = val
            if not os.path.isdir(downloads):
                downloads = home
            return _ok(downloads)
        except Exception as e:
            return _err(e)

    def choose_folder_dialog(self) -> dict:
        """Open a native folder picker and return selected path."""
        try:
            if self._window is None:
                return _err("Window not ready.")
            result = self._window.create_file_dialog(
                webview.FOLDER_DIALOG,
            )
            if result:
                path = result if isinstance(result, str) else result[0]
                return _ok(path)
            return _ok(None)
        except Exception as e:
            return _err(e)

    def set_last_results(self, columns: list, rows: list) -> dict:
        """Cache the last query/report results for PDF export."""
        try:
            self._last_result_cols = list(columns or [])
            self._last_result_rows = list(rows or [])
            return _ok(True)
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Import
    # ----------------------------------------------------------------

    def import_file(self, filepath: str, overwrite: bool = False) -> dict:
        try:
            if not os.path.isfile(filepath):
                return _err(f"File not found: {filepath}")

            known_before = db.get_known_emp_codes()

            late  = db.get_setting("late_threshold",        "09:15")
            early = db.get_setting("early_leave_threshold", "15:30")

            result = parse_file(filepath, late, early)
            inserted, skipped = db.import_records(result, overwrite=overwrite)

            # Store filepath for auto-load next session
            db.store_last_filepath(filepath)

            file_codes = {r.emp_code for r in result.records}
            file_names: Dict[str, str] = {}
            for r in result.records:
                if r.emp_code not in file_names:
                    file_names[r.emp_code] = r.emp_name

            known_after = db.get_known_emp_codes()
            added_codes   = file_codes - set(known_before.keys())
            removed_codes = set(known_before.keys()) - file_codes

            employee_diff = {
                "added":   [f"{c}: {known_after.get(c, file_names.get(c, c))}" for c in sorted(added_codes)],
                "removed": [f"{c}: {known_before[c]}" for c in sorted(removed_codes)],
            }

            return _ok({
                "filename":      result.filename,
                "company":       result.company_name,
                "period_start":  str(result.period_start or ""),
                "period_end":    str(result.period_end   or ""),
                "inserted":      inserted,
                "skipped":       skipped,
                "employees":     len(file_codes),
                "warnings":      result.warnings[:20],
                "employee_diff": employee_diff,
            })
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"Import failed: {traceback.format_exc()}")

    def check_already_imported(self, filename: str) -> dict:
        try:
            row = db.check_already_imported(filename)
            return _ok(row)
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Employees / Salary
    # ----------------------------------------------------------------

    def get_employees(self) -> dict:
        try:
            return _ok(db.get_all_employees())
        except Exception as e:
            return _err(e)

    def upsert_employee(self, emp_code: str, emp_name: str,
                        emp_name_override: str, monthly_salary: float,
                        custom_arrival: str = None, custom_departure: str = None,
                        uses_transport: int = 0) -> dict:
        try:
            db.upsert_salary(
                emp_code=emp_code,
                emp_name=emp_name,
                monthly_salary=float(monthly_salary),
                emp_name_override=emp_name_override,
                custom_arrival=custom_arrival if custom_arrival else None,
                custom_departure=custom_departure if custom_departure else None,
                uses_transport=int(uses_transport),
            )
            return _ok("Saved.")
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Filter metadata
    # ----------------------------------------------------------------

    def get_filter_fields(self) -> dict:
        try:
            fields = []
            for label in FIELD_MAP:
                cat  = FIELD_CATEGORIES.get(label, "text")
                ops  = get_operators_for_field(label)
                opts = get_value_options_for_field(label)
                fields.append({
                    "label":     label,
                    "column":    FIELD_MAP[label],
                    "category":  cat,
                    "operators": ops,
                    "options":   opts,
                })
            return _ok(fields)
        except Exception as e:
            return _err(e)

    def get_aggregate_defs(self) -> dict:
        """Return SELECT_COLS and GROUPBY_COLS for the frontend aggregate builder."""
        try:
            return _ok({"select_cols": SELECT_COLS, "groupby_cols": GROUPBY_COLS})
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Filter / Query  (V4: GROUP BY + conflict dual-table)
    # ----------------------------------------------------------------

    def run_filter(self, filters_json: str,
                   sort_col: str = "work_date", sort_dir: str = "ASC",
                   limit: int = 5000,
                   select_exprs_json: str = "[]",
                   select_labels_json: str = "[]",
                   select_is_agg_json: str = "[]",
                   group_by_exprs_json: str = "[]",
                   having: str = "") -> dict:
        try:
            raw      = json.loads(filters_json) if isinstance(filters_json, str) else filters_json
            sel_e    = json.loads(select_exprs_json)  if isinstance(select_exprs_json, str)  else select_exprs_json
            sel_l    = json.loads(select_labels_json) if isinstance(select_labels_json, str) else select_labels_json
            sel_a    = json.loads(select_is_agg_json) if isinstance(select_is_agg_json, str) else select_is_agg_json
            grp_e    = json.loads(group_by_exprs_json) if isinstance(group_by_exprs_json, str) else group_by_exprs_json

            rows_in = [
                FilterRow(
                    field=r["field"], operator=r["operator"],
                    value=r.get("value", ""), value2=r.get("value2", ""),
                    joiner=r.get("joiner", "AND"),
                )
                for r in raw
            ]

            # Detect GROUP BY conflict
            conflict = detect_group_conflict(sel_e, sel_a, grp_e) if grp_e else False

            if conflict:
                # ── Dual-table mode ──────────────────────────────────────────
                # Query A: grouped summary
                spec_a = QuerySpec(
                    filters=rows_in, limit=limit,
                    select_exprs=sel_e, select_labels=sel_l,
                    group_by_exprs=grp_e, having=having,
                )
                sql_a, params_a, sql_a_display = build_sql(spec_a)
                cols_a, data_a = db.execute_query(sql_a, params_a)

                # Query B: detailed records
                spec_b = QuerySpec(
                    filters=rows_in,
                    order_by=sort_col, order_dir=sort_dir,
                    limit=limit,
                )
                sql_b, params_b, sql_b_display = build_sql(spec_b)
                cols_b, data_b = db.execute_query(sql_b, params_b)

                combined_display = (
                    "-- SUMMARY (grouped):\n" + sql_a_display +
                    "\n\n-- DETAIL (all records):\n" + sql_b_display
                )

                self._last_result_cols = cols_b
                self._last_result_rows = data_b

                return _ok({
                    "mode": "dual",
                    "summary": {
                        "columns": cols_a, "rows": data_a, "count": len(data_a),
                        "sql": sql_a_display,
                    },
                    "detail": {
                        "columns": cols_b, "rows": data_b, "count": len(data_b),
                        "sql": sql_b_display,
                    },
                    "sql": combined_display,
                    "conflict_reason": "Mixed aggregate and non-grouped columns detected. Running both views.",
                })
            else:
                # ── Single-table mode ────────────────────────────────────────
                spec = QuerySpec(
                    filters=rows_in,
                    order_by=sort_col, order_dir=sort_dir,
                    limit=limit,
                    select_exprs=sel_e, select_labels=sel_l,
                    group_by_exprs=grp_e, having=having,
                )
                sql, params, sql_display = build_sql(spec)
                cols, data = db.execute_query(sql, params)
                self._last_result_cols = cols
                self._last_result_rows = data
                return _ok({
                    "mode": "single",
                    "columns": cols, "rows": data,
                    "sql": sql_display, "count": len(data),
                })
        except Exception as e:
            return _err(str(e))

    def run_sql(self, sql: str) -> dict:
        try:
            cols, data = db.execute_query(sql)
            self._last_result_cols = cols
            self._last_result_rows = data
            return _ok({"columns": cols, "rows": data, "count": len(data)})
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(str(e))

    # ----------------------------------------------------------------
    # Query log
    # ----------------------------------------------------------------

    def get_query_log(self) -> dict:
        try:
            return _ok(db.get_query_log())
        except Exception as e:
            return _err(e)

    def clear_query_log(self) -> dict:
        try:
            db.clear_query_log()
            return _ok("Cleared.")
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Export
    # ----------------------------------------------------------------

    def toggle_employee_disabled(self, emp_code: str, is_disabled: int) -> dict:
        try:
            db.toggle_employee_disabled(emp_code, is_disabled)
            return _ok("Saved.")
        except Exception as e:
            return _err(e)

    def upsert_manual_punch(self, emp_code: str, work_date: str, punch_in: str, punch_out: str,
                            status: str, work_minutes: int, is_late: int, left_early: int,
                            emp_name: str = "Manual") -> dict:
        try:
            db.upsert_manual_punch(
                emp_code, work_date, punch_in, punch_out,
                status, int(work_minutes), is_late, left_early, emp_name
            )
            return _ok("Manual punch saved.")
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Calendar
    # ----------------------------------------------------------------

    def get_calendar_days(self, year: int, month: int) -> dict:
        try:
            return _ok(db.get_calendar_days(year, month))
        except Exception as e:
            return _err(e)

    def toggle_calendar_day(self, date_str: str, day_type: str,
                            day_in: str = None, day_out: str = None) -> dict:
        try:
            db.toggle_calendar_day(
                date_str, day_type,
                day_in=day_in or None,
                day_out=day_out or None,
            )
            return _ok("Calendar updated.")
        except Exception as e:
            return _err(e)

    def export_csv(self, columns: list, rows: list, filepath: str) -> dict:
        try:
            exporter.export_csv(columns, rows, filepath)
            return _ok(filepath)
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Employee Day Overrides
    # ----------------------------------------------------------------

    def upsert_employee_day_override(self, emp_code: str, date_str: str,
                                     custom_in: str, custom_out: str) -> dict:
        try:
            db.upsert_employee_day_override(
                emp_code, date_str,
                custom_in or None, custom_out or None
            )
            return _ok("Day override saved.")
        except Exception as e:
            return _err(e)

    def get_employee_day_overrides(self, emp_code: str) -> dict:
        try:
            return _ok(db.get_employee_day_overrides(emp_code))
        except Exception as e:
            return _err(e)

    def delete_employee_day_override(self, emp_code: str, date_str: str) -> dict:
        try:
            db.upsert_employee_day_override(emp_code, date_str, None, None)
            return _ok("Override deleted.")
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Salary Engine (V12)
    # ----------------------------------------------------------------

    def run_salary_report(self, year: int, month: int) -> dict:
        try:
            rows = compute_salary_report(int(year), int(month))
            if not rows:
                self._last_result_cols = []
                self._last_result_rows = []
                return _ok({"columns": [], "rows": [], "count": 0})
            columns = list(rows[0].keys())
            self._last_result_cols = columns
            self._last_result_rows = rows
            return _ok({"columns": columns, "rows": rows, "count": len(rows)})
        except Exception as e:
            return _err(str(e))

    def export_pdf(
        self,
        *args,
        **kwargs,
    ) -> dict:
        """
        Export results to PDF using the high-speed native Rust engine with ReportLab fallback.
        Accepts either (filepath, title, ...) or (columns, rows, filepath, title, ...).
        """
        try:
            cols = self._last_result_cols
            rows = self._last_result_rows
            filepath = ""
            title = kwargs.get("title", "Attendance Report")
            org_name = kwargs.get("org_name", "")
            logo_b64 = kwargs.get("logo_b64", "")
            sql_display = kwargs.get("sql_display", "")
            theme_colors = kwargs.get("theme_colors", None)
            page_size = kwargs.get("page_size", "A4")
            orientation = kwargs.get("orientation", "portrait")
            scale = kwargs.get("scale", 1.0)
            continuous = kwargs.get("continuous", False)
            source_label = kwargs.get("source_label", "")

            if args:
                if isinstance(args[0], (list, tuple)) and len(args) >= 3:
                    # Legacy signature: (columns, rows, filepath, title, ...)
                    cols = args[0] or cols
                    rows = args[1] or rows
                    filepath = args[2]
                    if len(args) > 3 and args[3]: title = args[3]
                    if len(args) > 4 and args[4]: org_name = args[4]
                    if len(args) > 5 and args[5]: logo_b64 = args[5]
                    if len(args) > 6 and args[6]: sql_display = args[6]
                    if len(args) > 7 and args[7]: theme_colors = args[7]
                    if len(args) > 8 and args[8]: page_size = args[8]
                    if len(args) > 9 and args[9]: orientation = args[9]
                    if len(args) > 10 and args[10]: scale = float(args[10])
                    if len(args) > 11 and args[11] is not None: continuous = bool(args[11])
                    if len(args) > 12 and args[12]: source_label = args[12]
                elif isinstance(args[0], str):
                    # Signature: (filepath, title, subtitle, org, logo, sql, ...)
                    filepath = args[0]
                    if len(args) > 1 and args[1]: title = args[1]
                    if len(args) > 3 and args[3]: org_name = args[3]
                    if len(args) > 4 and args[4]: logo_b64 = args[4]
                    if len(args) > 5 and args[5]: sql_display = args[5]
                    if len(args) > 6 and args[6]: theme_colors = args[6]
                    if len(args) > 7 and args[7]: page_size = args[7]
                    if len(args) > 8 and args[8]: orientation = args[8]
                    if len(args) > 9 and args[9]: scale = float(args[9])
                    if len(args) > 10 and args[10] is not None: continuous = bool(args[10])
                    if len(args) > 11 and args[11]: source_label = args[11]

            if not filepath:
                filepath = kwargs.get("filepath", "")

            if not filepath:
                return _err("No output filepath provided")

            def _do():
                try:
                    exporter.export_pdf(
                        columns=cols,
                        rows=rows,
                        filepath=filepath,
                        title=title,
                        subtitle="",
                        org_name=org_name,
                        logo_b64=logo_b64,
                        sql_display=sql_display,
                        theme_colors=theme_colors,
                        page_size=page_size,
                        orientation=orientation,
                        scale=scale,
                        continuous=continuous,
                        source_label=source_label,
                    )
                except Exception as ex:
                    print(f"[PDF export error] {ex}")

            threading.Thread(target=_do, daemon=True).start()
            return _ok(filepath)
        except Exception as e:
            return _err(e)

    def export_pdf_html(
        self,
        filepath: str,
        title: str = "Attendance Report",
        org_name: str = "",
        logo_b64: str = "",
        sql_display: str = "",
        source_label: str = "",
        custom_css: str = "",
        page_size: str = "A4",
        orientation: str = "portrait",
        scale: float = 1.0,
        col_widths: dict = None,
        col_headers: dict = None,
        col_visible: list = None,
        full_override: bool = False,
        bold_data: bool = False,
        show_grid_lines: bool = False,
    ) -> dict:
        """Render PDF using custom HTML/CSS template via headless Chromium."""
        try:
            def _do():
                try:
                    export_pdf_html(
                        self._last_result_cols, self._last_result_rows, filepath,
                        title=title,
                        org_name=org_name,
                        logo_b64=logo_b64,
                        sql_display=sql_display,
                        source_label=source_label,
                        custom_css=custom_css,
                        page_size=page_size,
                        orientation=orientation,
                        scale=scale,
                        col_widths=col_widths,
                        col_headers=col_headers,
                        col_visible=col_visible,
                        full_override=full_override,
                        bold_data=bold_data,
                        show_grid_lines=show_grid_lines,
                    )
                except Exception as ex:
                    print(f"[PDF HTML export error] {ex}")

            threading.Thread(target=_do, daemon=True).start()
            return _ok(filepath)
        except Exception as e:
            return _err(e)

    def get_pdf_html_preview(
        self,
        title: str = "Preview",
        org_name: str = "",
        logo_b64: str = "",
        custom_css: str = "",
        page_size: str = "A4",
        orientation: str = "portrait",
        scale: float = 1.0,
        col_widths: dict = None,
        col_headers: dict = None,
        col_visible: list = None,
        full_override: bool = False,
        bold_data: bool = False,
        show_grid_lines: bool = False,
        sql_display: str = "",
    ) -> dict:
        """Return HTML string for the live iframe preview (ultra dev mode)."""
        try:
            cols = self._last_result_cols or []
            rows = self._last_result_rows or []
            html = get_pdf_html_preview(
                columns=cols, rows=rows,
                title=title, org_name=org_name, logo_b64=logo_b64,
                sql_display=sql_display,
                custom_css=custom_css, page_size=page_size, orientation=orientation,
                scale=scale,
                col_widths=col_widths or {}, col_headers=col_headers or {},
                col_visible=col_visible, full_override=full_override,
                bold_data=bold_data, show_grid_lines=show_grid_lines,
            )
            return _ok(html)
        except Exception as e:
            return _err(e)


    # ── Ultra Dev Mode ────────────────────────────────────────────────────────

    def open_dev_files(
        self,
        custom_css: str = "",
        title: str = "Attendance Report",
        org_name: str = "",
        page_size: str = "A4",
        orientation: str = "portrait",
        full_override: bool = False,
    ) -> dict:
        """Write the three dev files and return their paths."""
        try:
            import os
            cols = self._last_result_cols or []
            rows = self._last_result_rows or []
            paths = write_dev_files(
                columns=cols, rows=rows,
                custom_css=custom_css, title=title, org_name=org_name,
                page_size=page_size, orientation=orientation,
                querii_path=os.path.dirname(os.path.abspath(__file__)),
                full_override=full_override,
            )
            return _ok(paths)
        except Exception as e:
            return _err(e)

    def read_dev_file(self, name: str) -> dict:
        """Read a dev file by name (data.csv / style.css / render.py)."""
        try:
            return _ok(read_dev_file(name))
        except Exception as e:
            return _err(e)

    def write_dev_file(self, name: str, content: str) -> dict:
        """Save updated content to a dev file."""
        try:
            write_dev_file_content(name, content)
            return _ok(True)
        except Exception as e:
            return _err(e)

    def open_path(self, path: str) -> dict:
        """Open a file or directory in the system default application."""
        try:
            import subprocess, sys as _sys
            if _sys.platform.startswith("linux"):
                subprocess.Popen(["xdg-open", path])
            elif _sys.platform == "darwin":
                subprocess.Popen(["open", path])
            else:
                subprocess.Popen(["explorer", path])
            return _ok(True)
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Custom PDF Styles (named user presets)
    # ----------------------------------------------------------------

    def get_pdf_styles(self) -> dict:
        """Return all custom user-saved PDF styles: [{name, css}]"""
        try:
            import json
            raw = db.get_setting("pdf_custom_styles", "[]")
            styles = json.loads(raw) if raw else []
            return _ok(styles)
        except Exception as e:
            return _err(str(e))

    def save_pdf_style(self, name: str, css: str) -> dict:
        """Save or update a named custom PDF style."""
        try:
            import json
            name = str(name).strip()
            if not name:
                return _err("Style name cannot be empty")
            raw = db.get_setting("pdf_custom_styles", "[]")
            styles = json.loads(raw) if raw else []
            # Update existing or append
            found = False
            for s in styles:
                if s.get("name") == name:
                    s["css"] = css
                    found = True
                    break
            if not found:
                styles.append({"name": name, "css": css})
            db.set_setting("pdf_custom_styles", json.dumps(styles))
            return _ok("Saved")
        except Exception as e:
            return _err(str(e))

    def delete_pdf_style(self, name: str) -> dict:
        """Delete a named custom PDF style."""
        try:
            import json
            raw = db.get_setting("pdf_custom_styles", "[]")
            styles = json.loads(raw) if raw else []
            styles = [s for s in styles if s.get("name") != name]
            db.set_setting("pdf_custom_styles", json.dumps(styles))
            return _ok("Deleted")
        except Exception as e:
            return _err(str(e))

    def rename_pdf_style(self, old_name: str, new_name: str) -> dict:
        """Rename a saved custom PDF style."""
        try:
            import json
            new_name = str(new_name).strip()
            if not new_name:
                return _err("New name cannot be empty")
            raw = db.get_setting("pdf_custom_styles", "[]")
            styles = json.loads(raw) if raw else []
            for s in styles:
                if s.get("name") == old_name:
                    s["name"] = new_name
                    break
            db.set_setting("pdf_custom_styles", json.dumps(styles))
            return _ok("Renamed")
        except Exception as e:
            return _err(str(e))


