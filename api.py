"""
api.py
======
Python API exposed to the webview frontend via window.pywebview.api.
Every public method becomes an async JS call.

All methods return a dict: { ok: bool, data: any, error: str|None }
"""

from __future__ import annotations

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
    FilterRow, QuerySpec, build_sql, format_sql_readable,
    FIELD_MAP, FIELD_CATEGORIES, get_operators_for_field, get_value_options_for_field,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ok(data: Any = None) -> dict:
    return {"ok": True, "data": data, "error": None}


def _err(msg: str) -> dict:
    return {"ok": False, "data": None, "error": str(msg)}


# ---------------------------------------------------------------------------
# API class
# ---------------------------------------------------------------------------

class Api:
    """
    Bound to window.pywebview.api in the webview.
    All methods are called from JS as:
        const res = await window.pywebview.api.method_name(args)
        if (res.ok) { ... } else { showError(res.error) }
    """

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
            ]
            return _ok({k: db.get_setting(k) for k in keys})
        except Exception as e:
            return _err(e)

    def save_settings(self, settings: dict) -> dict:
        """settings: { key: value, ... }"""
        try:
            for k, v in settings.items():
                db.set_setting(str(k), str(v))
            return _ok("Settings saved.")
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

    # ----------------------------------------------------------------
    # File import
    # ----------------------------------------------------------------

    def open_file_dialog(self) -> dict:
        """Open native file picker, return chosen path."""
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
            return _ok(None)  # User cancelled
        except Exception as e:
            return _err(e)

    def import_file(self, filepath: str, overwrite: bool = False) -> dict:
        """
        Parse and import an attendance XLS/XLSX file.
        Returns import summary or error.
        """
        try:
            if not os.path.isfile(filepath):
                return _err(f"File not found: {filepath}")

            late  = db.get_setting("late_threshold",        "09:15")
            early = db.get_setting("early_leave_threshold", "15:30")

            result = parse_file(filepath, late, early)
            inserted, skipped = db.import_records(result, overwrite=overwrite)

            emp_count = len(set(r.emp_code for r in result.records))
            return _ok({
                "filename":    result.filename,
                "company":     result.company_name,
                "period_start": str(result.period_start or ""),
                "period_end":   str(result.period_end   or ""),
                "inserted":    inserted,
                "skipped":     skipped,
                "employees":   emp_count,
                "warnings":    result.warnings[:20],
            })
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"Import failed: {traceback.format_exc()}")

    def check_already_imported(self, filename: str) -> dict:
        try:
            row = db.check_already_imported(filename)
            return _ok(row)  # None or dict
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Employee / Salary
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
    # Query / Filter builder
    # ----------------------------------------------------------------

    def get_filter_fields(self) -> dict:
        """Return field metadata for the filter builder UI."""
        try:
            fields = []
            for label in FIELD_MAP:
                cat  = FIELD_CATEGORIES.get(label, "text")
                ops  = get_operators_for_field(label)
                opts = get_value_options_for_field(label)
                fields.append({
                    "label":    label,
                    "column":   FIELD_MAP[label],
                    "category": cat,
                    "operators": ops,
                    "options":   opts,
                })
            return _ok(fields)
        except Exception as e:
            return _err(e)

    def run_filter(self, filters_json: str, sort_col: str = "work_date",
                   sort_dir: str = "ASC", limit: int = 5000) -> dict:
        """
        filters_json: JSON array of { field, operator, value, value2, joiner }
        Returns { columns, rows, sql }
        """
        try:
            raw = json.loads(filters_json) if isinstance(filters_json, str) else filters_json
            rows_in = [
                FilterRow(
                    field=r["field"], operator=r["operator"],
                    value=r.get("value", ""), value2=r.get("value2", ""),
                    joiner=r.get("joiner", "AND"),
                )
                for r in raw
            ]
            spec = QuerySpec(filters=rows_in, order_by=sort_col,
                             order_dir=sort_dir, limit=int(limit))
            sql, params = build_sql(spec)
            cols, data = db.execute_query(sql, params)
            return _ok({"columns": cols, "rows": data,
                        "sql": format_sql_readable(sql), "count": len(data)})
        except Exception as e:
            return _err(str(e))

    def run_sql(self, sql: str) -> dict:
        """Execute an arbitrary SELECT query."""
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
        """
        report: one of monthly_summary | late | early | absent |
                salary | grid | perfect | chronic | days_worked
        extra:  for chronic = min_absences (str int)
        """
        try:
            s = date_start or None
            e = date_end   or None

            if report == "monthly_summary":
                cols, rows = db.query_monthly_summary(s, e)
            elif report == "late":
                cols, rows = db.query_late_arrivals(s, e)
            elif report == "early":
                cols, rows = db.query_early_leavers(s, e)
            elif report == "absent":
                cols, rows = db.query_absentees(s, e)
            elif report == "salary":
                cols, rows = db.query_salary_report(s, e)
            elif report == "grid":
                cols, rows = db.query_full_grid(s, e)
            elif report == "perfect":
                cols, rows = db.query_perfect_attendance(s, e)
            elif report == "chronic":
                mins = int(extra) if extra and extra.isdigit() else 3
                cols, rows = db.query_chronic_absentees(mins, s, e)
            elif report == "days_worked":
                cols, rows = db.query_monthly_summary(s, e)
            else:
                return _err(f"Unknown report: {report}")

            return _ok({"columns": cols, "rows": rows, "count": len(rows)})
        except Exception as ex:
            return _err(str(ex))

    # ----------------------------------------------------------------
    # Export
    # ----------------------------------------------------------------

    def save_file_dialog(self, default_name: str = "export",
                         ext: str = "csv") -> dict:
        """Open native save-as dialog. Returns chosen path or None."""
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

    def export_csv(self, columns: list, rows: list, filepath: str) -> dict:
        try:
            exporter.export_csv(columns, rows, filepath)
            return _ok(filepath)
        except Exception as e:
            return _err(e)

    def export_pdf(self, columns: list, rows: list, filepath: str,
                   title: str = "Report") -> dict:
        try:
            def _do():
                exporter.export_pdf(columns, rows, filepath,
                                    title=title,
                                    subtitle="AttendanceProcessor")
            threading.Thread(target=_do, daemon=True).start()
            return _ok(filepath)
        except Exception as e:
            return _err(e)
