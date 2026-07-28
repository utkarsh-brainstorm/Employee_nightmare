"""
gui/quick_panel.py  (v2 — CTk)
================================
Quick report buttons. Clean vertical list with icon + label + subtitle.
Date range picker built inline.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk, simpledialog
from typing import Callable, List, Optional, Tuple
from datetime import date

import customtkinter as ctk

import core.db as db
from gui.theme import C, FONTS
from gui.widgets import PrimaryButton, SecondaryButton, hdivider


class DateRangeBar(tk.Frame):
    """Compact from/to date bar used in quick panel."""

    def __init__(self, parent, **kwargs):
        super().__init__(parent, bg=C["bg_sidebar"], **kwargs)
        self._build()

    def _build(self):
        tk.Label(self, text="Period:", bg=C["bg_sidebar"],
                 fg=C["text_3"], font=FONTS.caption).pack(side="left", padx=(0, 4))

        self._start_var = tk.StringVar()
        self._end_var   = tk.StringVar()

        min_d, max_d = db.get_date_range()
        self._start_var.set(min_d or str(date.today().replace(day=1)))
        self._end_var.set(max_d or str(date.today()))

        for lbl, var in [("From", self._start_var), ("To", self._end_var)]:
            tk.Label(self, text=lbl, bg=C["bg_sidebar"],
                     fg=C["text_3"], font=FONTS.caption).pack(side="left", padx=(4, 2))
            e = ctk.CTkEntry(self, textvariable=var, width=96, height=26,
                             corner_radius=5,
                             fg_color=C["bg_input"],
                             border_color=C["border"],
                             text_color=C["text"],
                             font=FONTS.caption)
            e.pack(side="left", padx=(0, 4))

    def get(self) -> Tuple[str, str]:
        return self._start_var.get().strip(), self._end_var.get().strip()

    def refresh(self):
        min_d, max_d = db.get_date_range()
        if min_d: self._start_var.set(min_d)
        if max_d: self._end_var.set(max_d)


class QuickPanel(tk.Frame):
    """
    Right panel: quick report buttons, each runs a pre-built query.
    Calls on_run(columns, rows, title, sql_hint).
    """

    def __init__(self, parent,
                 on_run: Callable,
                 on_sql_generated: Callable[[str], None],
                 **kwargs):
        super().__init__(parent, bg=C["bg_sidebar"], **kwargs)
        self._on_run = on_run
        self._on_sql_generated = on_sql_generated
        self._build_ui()

    def _build_ui(self):
        tk.Label(self, text="Quick Reports",
                 bg=C["bg_sidebar"], fg=C["text"],
                 font=FONTS.h2).pack(anchor="w", padx=16, pady=(14, 2))
        tk.Label(self, text="One-click summaries for admin",
                 bg=C["bg_sidebar"], fg=C["text_3"],
                 font=FONTS.caption).pack(anchor="w", padx=16, pady=(0, 8))

        # Period bar
        self._date_bar = DateRangeBar(self)
        self._date_bar.pack(fill="x", padx=16, pady=(0, 10))

        hdivider(self, C["border"]).pack(fill="x", padx=12, pady=(0, 6))

        reports = [
            ("📊", "Monthly Summary",      "Present / Absent / Hours per employee",  self._monthly),
            ("⏰", "Late Arrivals",         "Who came after the threshold",           self._late),
            ("🏃", "Early Leavers",         "Who left before the threshold",          self._early),
            ("❌", "Absentees",             "All absent records in period",           self._absent),
            ("📅", "Days Worked",           "Working day count per employee",         self._days_worked),
            ("💰", "Salary Report",         "Estimated earnings based on attendance", self._salary),
            ("📋", "Full Attendance Grid",  "All records sorted by date",             self._grid),
            ("🌟", "Perfect Attendance",    "Zero absences in the period",            self._perfect),
            ("⚠️", "Frequent Absentees",   "3 or more absences in the period",       self._chronic),
        ]

        for icon, label, sub, cmd in reports:
            self._make_btn(icon, label, sub, cmd)

        hdivider(self, C["border"]).pack(fill="x", padx=12, pady=(8, 6))

        # Threshold info
        tk.Label(self, text="⚙  Active thresholds",
                 bg=C["bg_sidebar"], fg=C["text_3"],
                 font=FONTS.caption).pack(anchor="w", padx=16)

        self._thresh_lbl = tk.Label(self, text="",
                                    bg=C["bg_sidebar"], fg=C["text_3"],
                                    font=FONTS.caption, justify="left")
        self._thresh_lbl.pack(anchor="w", padx=16, pady=(2, 14))

        self._refresh_thresh_display()

    def _make_btn(self, icon: str, label: str, sub: str, cmd: Callable):
        frame = tk.Frame(self, bg=C["bg_sidebar"], cursor="hand2")
        frame.pack(fill="x", padx=12, pady=2)

        inner = tk.Frame(frame, bg=C["bg_card"],
                         highlightbackground=C["border_light"],
                         highlightthickness=1)
        inner.pack(fill="x")

        icon_lbl = tk.Label(inner, text=icon,
                            bg=C["bg_card"],
                            font=(FONTS.h2[0], 16),
                            width=3)
        icon_lbl.pack(side="left", padx=(10, 0), pady=8)

        txt = tk.Frame(inner, bg=C["bg_card"])
        txt.pack(side="left", padx=(6, 10), pady=6, fill="x", expand=True)

        tk.Label(txt, text=label, bg=C["bg_card"], fg=C["text"],
                 font=FONTS.body_sm, anchor="w").pack(anchor="w")
        tk.Label(txt, text=sub, bg=C["bg_card"], fg=C["text_3"],
                 font=FONTS.caption, anchor="w").pack(anchor="w")

        # Hover
        def on_enter(e):
            inner.configure(highlightbackground=C["accent"])
            for w in [inner, icon_lbl, txt] + txt.winfo_children():
                try: w.configure(bg=C["accent_light"])
                except Exception: pass

        def on_leave(e):
            inner.configure(highlightbackground=C["border_light"])
            for w in [inner, icon_lbl, txt] + txt.winfo_children():
                try: w.configure(bg=C["bg_card"])
                except Exception: pass

        for w in [inner, icon_lbl, txt] + txt.winfo_children():
            w.bind("<Enter>", on_enter)
            w.bind("<Leave>", on_leave)
            w.bind("<Button-1>", lambda e, c=cmd: c())

    def _get_period(self) -> Tuple[str, str]:
        return self._date_bar.get()

    def _run_query(self, cols, rows, title, sql_hint):
        self._on_sql_generated(sql_hint)
        self._on_run(cols, rows, title, sql_hint)

    def refresh_dates(self):
        self._date_bar.refresh()

    def _refresh_thresh_display(self):
        lt = db.get_setting("late_threshold",         "09:15")
        el = db.get_setting("early_leave_threshold",  "15:30")
        ci = db.get_setting("checkin_time",           "09:00")
        co = db.get_setting("checkout_time",          "15:30")
        self._thresh_lbl.configure(
            text=f"Check-in: {ci}  |  Check-out: {co}\nLate after: {lt}  |  Early before: {el}"
        )

    # ---- Report methods ----

    def _monthly(self):
        s, e = self._get_period()
        cols, rows = db.query_monthly_summary(s, e)
        sql = f"SELECT emp_code, emp_name,\n  COUNT(CASE WHEN status='PRESENT' THEN 1 END) AS Present, ...\nFROM attendance_raw\nWHERE work_date BETWEEN '{s}' AND '{e}'\nGROUP BY emp_code"
        self._run_query(cols, rows, f"Monthly Summary  ({s} → {e})", sql)

    def _late(self):
        s, e = self._get_period()
        cols, rows = db.query_late_arrivals(s, e)
        sql = f"SELECT emp_name, work_date, punch_in\nFROM attendance_raw\nWHERE is_late = 1 AND work_date BETWEEN '{s}' AND '{e}'"
        self._run_query(cols, rows, f"Late Arrivals  ({s} → {e})", sql)

    def _early(self):
        s, e = self._get_period()
        cols, rows = db.query_early_leavers(s, e)
        sql = f"SELECT emp_name, work_date, punch_out\nFROM attendance_raw\nWHERE left_early = 1 AND work_date BETWEEN '{s}' AND '{e}'"
        self._run_query(cols, rows, f"Early Leavers  ({s} → {e})", sql)

    def _absent(self):
        s, e = self._get_period()
        cols, rows = db.query_absentees(s, e)
        sql = f"SELECT emp_name, work_date\nFROM attendance_raw\nWHERE status = 'ABSENT'\n  AND work_date BETWEEN '{s}' AND '{e}'"
        self._run_query(cols, rows, f"Absentees  ({s} → {e})", sql)

    def _days_worked(self):
        s, e = self._get_period()
        cols, rows = db.query_monthly_summary(s, e)
        sql = f"SELECT emp_name,\n  COUNT(CASE WHEN status='PRESENT' THEN 1 END) AS Present\nFROM attendance_raw\nWHERE work_date BETWEEN '{s}' AND '{e}'\nGROUP BY emp_code"
        self._run_query(cols, rows, f"Days Worked  ({s} → {e})", sql)

    def _salary(self):
        s, e = self._get_period()
        cols, rows = db.query_salary_report(s, e)
        sql = (f"SELECT a.emp_name, COUNT(CASE WHEN status='PRESENT' THEN 1 END) AS Present,\n"
               f"  s.monthly_salary, ROUND(s.monthly_salary/26 * Present, 2) AS Earned\n"
               f"FROM attendance_raw a\nLEFT JOIN employee_salary s ON a.emp_code=s.emp_code\n"
               f"WHERE work_date BETWEEN '{s}' AND '{e}'\nGROUP BY a.emp_code")
        self._run_query(cols, rows, f"Salary Report  ({s} → {e})", sql)

    def _grid(self):
        s, e = self._get_period()
        cols, rows = db.query_full_grid(s, e)
        sql = f"SELECT emp_name, work_date, status, punch_in, punch_out, work_hours\nFROM attendance_raw\nWHERE work_date BETWEEN '{s}' AND '{e}'\nORDER BY work_date, emp_code"
        self._run_query(cols, rows, f"Full Attendance Grid  ({s} → {e})", sql)

    def _perfect(self):
        s, e = self._get_period()
        cols, rows = db.query_perfect_attendance(s, e)
        sql = (f"SELECT emp_name, COUNT(*) AS Total\nFROM attendance_raw\n"
               f"WHERE work_date BETWEEN '{s}' AND '{e}'\nGROUP BY emp_code\n"
               f"HAVING COUNT(CASE WHEN status='ABSENT' THEN 1 END) = 0")
        self._run_query(cols, rows, f"Perfect Attendance  ({s} → {e})", sql)

    def _chronic(self):
        s, e = self._get_period()
        try:
            thr = simpledialog.askinteger("Threshold",
                                          "Min absent days to flag:",
                                          initialvalue=3, minvalue=1,
                                          parent=self.winfo_toplevel())
            if thr is None:
                return
        except Exception:
            thr = 3
        cols, rows = db.query_chronic_absentees(thr, s, e)
        sql = (f"SELECT emp_name, COUNT(CASE WHEN status='ABSENT' THEN 1 END) AS Absent\n"
               f"FROM attendance_raw\nWHERE work_date BETWEEN '{s}' AND '{e}'\n"
               f"GROUP BY emp_code\nHAVING Absent >= {thr}")
        self._run_query(cols, rows, f"Frequent Absentees (≥{thr})  ({s} → {e})", sql)
