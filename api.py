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
                "org_name", "org_logo_b64",
                "ap_theme", "ap_zoom", "ap_panels", "ap_custom_reports",
            ]
            return _ok({k: db.get_setting(k) for k in keys})
        except Exception as e:
            return _err(e)

    def save_settings(self, settings: dict) -> dict:
        try:
            for k, v in settings.items():
                db.set_setting(str(k), str(v) if v is not None else "")
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
                        working_days: int) -> dict:
        try:
            db.upsert_salary(
                emp_code=emp_code,
                emp_name=emp_name,
                monthly_salary=float(monthly_salary),
                working_days=int(working_days),
                emp_name_override=emp_name_override,
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
            return _ok({"columns": cols, "rows": data, "count": len(data)})
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(str(e))

    # ----------------------------------------------------------------
    # Quick reports
    # ----------------------------------------------------------------

    def quick_report(self, report: str, date_start: str = "",
                     date_end: str = "", extra: str = "") -> dict:
        try:
            s = date_start or None
            e = date_end   or None

            if   report == "monthly_summary": cols, rows = db.query_monthly_summary(s, e)
            elif report == "late":            cols, rows = db.query_late_arrivals(s, e)
            elif report == "early":           cols, rows = db.query_early_leavers(s, e)
            elif report == "absent":          cols, rows = db.query_absentees(s, e)
            elif report == "salary":          cols, rows = db.query_salary_report(s, e)
            elif report == "grid":            cols, rows = db.query_full_grid(s, e)
            elif report == "perfect":         cols, rows = db.query_perfect_attendance(s, e)
            elif report == "chronic":
                mins = int(extra) if extra and str(extra).isdigit() else 3
                cols, rows = db.query_chronic_absentees(mins, s, e)
            elif report == "days_worked":     cols, rows = db.query_monthly_summary(s, e)
            else:
                return _err(f"Unknown report: {report}")

            db.log_query(f"-- quick_report: {report}\n-- period: {s} → {e}", len(rows), "quick")
            return _ok({"columns": cols, "rows": rows, "count": len(rows)})
        except Exception as ex:
            return _err(str(ex))

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

    def export_csv(self, columns: list, rows: list, filepath: str) -> dict:
        try:
            exporter.export_csv(columns, rows, filepath)
            return _ok(filepath)
        except Exception as e:
            return _err(e)

    def export_pdf(self, columns: list, rows: list, filepath: str,
                   title: str = "Report",
                   org_name: str = "",
                   logo_b64: str = "",
                   sql_display: str = "") -> dict:
        try:
            def _do():
                try:
                    exporter.export_pdf(
                        columns, rows, filepath,
                        title=title,
                        subtitle="",
                        org_name=org_name,
                        logo_b64=logo_b64,
                        sql_display=sql_display,
                    )
                except Exception as ex:
                    print(f"[PDF export error] {ex}")

            threading.Thread(target=_do, daemon=True).start()
            return _ok(filepath)
        except Exception as e:
            return _err(e)
