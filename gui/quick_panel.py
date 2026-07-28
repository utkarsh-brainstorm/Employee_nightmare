"""
gui/quick_panel.py
==================
Right panel: one-click summary buttons for school admin needs.
Each button triggers a pre-built query and shows results.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk, simpledialog
from typing import Callable, List, Tuple, Optional
from datetime import date, timedelta

import core.db as db
from gui.theme import C, FONTS


# ---------------------------------------------------------------------------
# Date range picker dialog
# ---------------------------------------------------------------------------

class DateRangeDialog(tk.Toplevel):
    """Simple dialog to pick start/end dates."""

    def __init__(self, parent, title="Select Date Range",
                 default_start: str = None, default_end: str = None):
        super().__init__(parent)
        self.title(title)
        self.resizable(False, False)
        self.configure(bg=C["bg"])
        self.result_start: Optional[str] = None
        self.result_end: Optional[str] = None

        tk.Label(self, text=title, bg=C["bg"], fg=C["text_primary"],
                 font=FONTS["h3"]).pack(padx=24, pady=(20, 12))

        form = tk.Frame(self, bg=C["bg"])
        form.pack(padx=24, pady=4)

        tk.Label(form, text="From:", bg=C["bg"],
                 fg=C["text_secondary"], font=FONTS["body_sm"],
                 width=8, anchor="e").grid(row=0, column=0, padx=(0, 8), pady=4)
        self._start_var = tk.StringVar(value=default_start or str(date.today().replace(day=1)))
        ttk.Entry(form, textvariable=self._start_var, width=14,
                  font=FONTS["body"]).grid(row=0, column=1, pady=4)

        tk.Label(form, text="To:", bg=C["bg"],
                 fg=C["text_secondary"], font=FONTS["body_sm"],
                 width=8, anchor="e").grid(row=1, column=0, padx=(0, 8), pady=4)
        self._end_var = tk.StringVar(value=default_end or str(date.today()))
        ttk.Entry(form, textvariable=self._end_var, width=14,
                  font=FONTS["body"]).grid(row=1, column=1, pady=4)

        tk.Label(form, text="Format: YYYY-MM-DD", bg=C["bg"],
                 fg=C["text_tertiary"], font=FONTS["caption"]).grid(
                     row=2, column=0, columnspan=2, pady=(0, 8))

        btn_row = tk.Frame(self, bg=C["bg"])
        btn_row.pack(padx=24, pady=(4, 20))
        ttk.Button(btn_row, text="Apply", style="Accent.TButton",
                   command=self._ok).pack(side="left", padx=(0, 8))
        ttk.Button(btn_row, text="Cancel", style="TButton",
                   command=self.destroy).pack(side="left")

        self.transient(parent)
        self.grab_set()
        self.wait_window()

    def _ok(self):
        self.result_start = self._start_var.get().strip()
        self.result_end = self._end_var.get().strip()
        self.destroy()


# ---------------------------------------------------------------------------
# Quick Panel
# ---------------------------------------------------------------------------

class QuickPanel(tk.Frame):
    """
    Right panel with quick-access summary buttons.
    Each button calls on_run(columns, rows, title, sql_hint).
    """

    def __init__(self, parent,
                 on_run: Callable[[List[str], List[dict], str, str], None],
                 on_sql_generated: Callable[[str], None],
                 **kwargs):
        super().__init__(parent, bg=C["sidebar_bg"], **kwargs)
        self._on_run = on_run
        self._on_sql_generated = on_sql_generated
        self._build_ui()

    def _build_ui(self):
        tk.Label(self, text="Quick Summaries",
                 bg=C["sidebar_bg"], fg=C["text_primary"],
                 font=FONTS["h3"]).pack(anchor="w", padx=16, pady=(14, 6))

        tk.Label(self, text="One-click reports for school admin",
                 bg=C["sidebar_bg"], fg=C["text_secondary"],
                 font=FONTS["caption"]).pack(anchor="w", padx=16, pady=(0, 10))

        buttons = [
            ("📊", "Monthly Summary",       "All employees: present/absent/hours",   self._monthly_summary),
            ("⏰", "Late Arrivals",          "Who arrived after the threshold",        self._late_arrivals),
            ("🏃", "Early Leavers",          "Who left before the threshold",          self._early_leavers),
            ("❌", "Absentees",             "Employees marked absent",               self._absentees),
            ("📅", "Days Worked",            "Count of working days per employee",    self._days_worked),
            ("💰", "Salary Report",          "Estimated salary based on attendance",  self._salary_report),
            ("📋", "Full Attendance Grid",   "All records in date order",             self._full_grid),
            ("🌟", "Perfect Attendance",     "Zero absences in selected period",      self._perfect_attendance),
            ("⚠️", "Chronic Absentees",     "3 or more absences in period",          self._chronic_absentees),
        ]

        for icon, label, tooltip, cmd in buttons:
            self._make_button(icon, label, tooltip, cmd)

        # Settings row
        ttk.Separator(self, orient="horizontal").pack(
            fill="x", padx=16, pady=10
        )
        tk.Label(self, text="⚙️  Thresholds",
                 bg=C["sidebar_bg"], fg=C["text_secondary"],
                 font=FONTS["body_sm"]).pack(anchor="w", padx=16)

        thr_frame = tk.Frame(self, bg=C["sidebar_bg"])
        thr_frame.pack(fill="x", padx=16, pady=6)

        tk.Label(thr_frame, text="Late after:",
                 bg=C["sidebar_bg"], fg=C["text_secondary"],
                 font=FONTS["caption"]).grid(row=0, column=0, sticky="w")

        self._late_thr_var = tk.StringVar(value=db.get_setting("late_threshold", "09:15"))
        late_entry = ttk.Entry(thr_frame, textvariable=self._late_thr_var,
                               width=7, font=FONTS["body_sm"])
        late_entry.grid(row=0, column=1, padx=(6, 0))

        tk.Label(thr_frame, text="Early before:",
                 bg=C["sidebar_bg"], fg=C["text_secondary"],
                 font=FONTS["caption"]).grid(row=1, column=0, sticky="w", pady=(4, 0))

        self._early_thr_var = tk.StringVar(value=db.get_setting("early_leave_threshold", "15:30"))
        early_entry = ttk.Entry(thr_frame, textvariable=self._early_thr_var,
                                width=7, font=FONTS["body_sm"])
        early_entry.grid(row=1, column=1, padx=(6, 0), pady=(4, 0))

        ttk.Button(self, text="Save Thresholds",
                   style="TButton",
                   command=self._save_thresholds).pack(anchor="w", padx=16, pady=(4, 16))

    def _make_button(self, icon: str, label: str, tooltip: str, cmd: Callable):
        btn_frame = tk.Frame(self, bg=C["sidebar_bg"], cursor="hand2")
        btn_frame.pack(fill="x", padx=12, pady=2)

        inner = tk.Frame(btn_frame, bg=C["sidebar_bg"],
                         highlightbackground=C["border_light"],
                         highlightthickness=1)
        inner.pack(fill="x")

        icon_lbl = tk.Label(inner, text=icon,
                            bg=C["sidebar_bg"], fg=C["accent"],
                            font=(FONTS["body"][0], 15),
                            width=3)
        icon_lbl.pack(side="left", padx=(10, 0), pady=8)

        text_frame = tk.Frame(inner, bg=C["sidebar_bg"])
        text_frame.pack(side="left", padx=(6, 10), pady=6, fill="x", expand=True)
        tk.Label(text_frame, text=label,
                 bg=C["sidebar_bg"], fg=C["text_primary"],
                 font=FONTS["body_sm"], anchor="w").pack(anchor="w")
        tk.Label(text_frame, text=tooltip,
                 bg=C["sidebar_bg"], fg=C["text_tertiary"],
                 font=FONTS["caption"], anchor="w").pack(anchor="w")

        # Hover effect
        def on_enter(e, f=inner):
            f.configure(highlightbackground=C["accent"])
            for child in f.winfo_children():
                try:
                    child.configure(bg=C["accent_light"])
                    for sub in child.winfo_children():
                        sub.configure(bg=C["accent_light"])
                except Exception:
                    pass

        def on_leave(e, f=inner):
            f.configure(highlightbackground=C["border_light"])
            for child in f.winfo_children():
                try:
                    child.configure(bg=C["sidebar_bg"])
                    for sub in child.winfo_children():
                        sub.configure(bg=C["sidebar_bg"])
                except Exception:
                    pass

        inner.bind("<Enter>", on_enter)
        inner.bind("<Leave>", on_leave)
        inner.bind("<Button-1>", lambda e: cmd())
        for child in inner.winfo_children():
            child.bind("<Enter>", on_enter)
            child.bind("<Leave>", on_leave)
            child.bind("<Button-1>", lambda e: cmd())
            for sub in child.winfo_children():
                sub.bind("<Enter>", on_enter)
                sub.bind("<Leave>", on_leave)
                sub.bind("<Button-1>", lambda e: cmd())

    def _get_date_range(self, title="Select Period") -> Tuple[Optional[str], Optional[str]]:
        min_d, max_d = db.get_date_range()
        dlg = DateRangeDialog(
            self.winfo_toplevel(), title,
            default_start=min_d, default_end=max_d
        )
        return dlg.result_start, dlg.result_end

    def _run_query(self, cols, rows, title, sql_hint):
        self._on_sql_generated(sql_hint)
        self._on_run(cols, rows, title, sql_hint)

    def _monthly_summary(self):
        start, end = self._get_date_range("Monthly Summary — Select Period")
        if start is None:
            return
        cols, rows = db.query_monthly_summary(start, end)
        sql_hint = f"-- Monthly Summary\n-- Period: {start} to {end}\n" + \
                   "SELECT emp_code, emp_name,\n  COUNT(CASE WHEN status='PRESENT' THEN 1 END) AS Present,\n  ... FROM attendance_raw GROUP BY emp_code"
        self._run_query(cols, rows, f"Monthly Summary ({start} → {end})", sql_hint)

    def _late_arrivals(self):
        start, end = self._get_date_range("Late Arrivals — Select Period")
        if start is None:
            return
        cols, rows = db.query_late_arrivals(start, end)
        sql_hint = f"SELECT emp_code, emp_name, work_date, punch_in\nFROM attendance_raw\nWHERE is_late = 1 AND status IN ('PRESENT','HALF_DAY')\n  AND work_date BETWEEN '{start}' AND '{end}'\nORDER BY work_date, emp_name"
        self._run_query(cols, rows, f"Late Arrivals ({start} → {end})", sql_hint)

    def _early_leavers(self):
        start, end = self._get_date_range("Early Leavers — Select Period")
        if start is None:
            return
        cols, rows = db.query_early_leavers(start, end)
        sql_hint = f"SELECT emp_code, emp_name, work_date, punch_out\nFROM attendance_raw\nWHERE left_early = 1 AND status = 'PRESENT'\n  AND work_date BETWEEN '{start}' AND '{end}'\nORDER BY work_date, emp_name"
        self._run_query(cols, rows, f"Early Leavers ({start} → {end})", sql_hint)

    def _absentees(self):
        start, end = self._get_date_range("Absentees — Select Period")
        if start is None:
            return
        cols, rows = db.query_absentees(start, end)
        sql_hint = f"SELECT emp_code, emp_name, work_date\nFROM attendance_raw\nWHERE status = 'ABSENT'\n  AND work_date BETWEEN '{start}' AND '{end}'\nORDER BY work_date, emp_name"
        self._run_query(cols, rows, f"Absentees ({start} → {end})", sql_hint)

    def _days_worked(self):
        start, end = self._get_date_range("Days Worked — Select Period")
        if start is None:
            return
        cols, rows = db.query_monthly_summary(start, end)
        sql_hint = f"SELECT emp_code, emp_name,\n  COUNT(CASE WHEN status='PRESENT' THEN 1 END) AS Present\nFROM attendance_raw\nWHERE work_date BETWEEN '{start}' AND '{end}'\nGROUP BY emp_code"
        self._run_query(cols, rows, f"Days Worked ({start} → {end})", sql_hint)

    def _salary_report(self):
        start, end = self._get_date_range("Salary Report — Select Period")
        if start is None:
            return
        cols, rows = db.query_salary_report(start, end)
        sql_hint = ("SELECT a.emp_code, a.emp_name,\n  COUNT(CASE WHEN status='PRESENT' THEN 1 END) AS Present,\n"
                    "  s.monthly_salary,\n  ROUND(s.monthly_salary/s.working_days * days_present, 2) AS Earned\n"
                    f"FROM attendance_raw a\nLEFT JOIN employee_salary s ON a.emp_code=s.emp_code\n"
                    f"WHERE work_date BETWEEN '{start}' AND '{end}'\nGROUP BY a.emp_code")
        self._run_query(cols, rows, f"Salary Report ({start} → {end})", sql_hint)

    def _full_grid(self):
        start, end = self._get_date_range("Full Attendance Grid — Select Period")
        if start is None:
            return
        cols, rows = db.query_full_grid(start, end)
        sql_hint = f"SELECT emp_code, emp_name, work_date, status, punch_in, punch_out, work_hours\nFROM attendance_raw\nWHERE work_date BETWEEN '{start}' AND '{end}'\nORDER BY work_date, emp_code"
        self._run_query(cols, rows, f"Full Attendance Grid ({start} → {end})", sql_hint)

    def _perfect_attendance(self):
        start, end = self._get_date_range("Perfect Attendance — Select Period")
        if start is None:
            return
        cols, rows = db.query_perfect_attendance(start, end)
        sql_hint = (f"SELECT emp_code, emp_name, COUNT(*) AS Total_Days\nFROM attendance_raw\n"
                    f"WHERE work_date BETWEEN '{start}' AND '{end}'\n"
                    "GROUP BY emp_code\nHAVING COUNT(CASE WHEN status='ABSENT' THEN 1 END) = 0")
        self._run_query(cols, rows, f"Perfect Attendance ({start} → {end})", sql_hint)

    def _chronic_absentees(self):
        start, end = self._get_date_range("Chronic Absentees — Select Period")
        if start is None:
            return
        try:
            threshold = simpledialog.askinteger(
                "Threshold",
                "Minimum absent days to flag as chronic:",
                initialvalue=3, minvalue=1, parent=self.winfo_toplevel()
            )
            if threshold is None:
                return
        except Exception:
            threshold = 3

        cols, rows = db.query_chronic_absentees(threshold, start, end)
        sql_hint = (f"SELECT emp_code, emp_name,\n  COUNT(CASE WHEN status='ABSENT' THEN 1 END) AS Absent\n"
                    f"FROM attendance_raw\nWHERE work_date BETWEEN '{start}' AND '{end}'\n"
                    f"GROUP BY emp_code\nHAVING Absent >= {threshold}\nORDER BY Absent DESC")
        self._run_query(cols, rows, f"Chronic Absentees (≥{threshold} days, {start} → {end})", sql_hint)

    def _save_thresholds(self):
        db.set_setting("late_threshold", self._late_thr_var.get().strip())
        db.set_setting("early_leave_threshold", self._early_thr_var.get().strip())
        from tkinter import messagebox
        messagebox.showinfo("Saved", "Thresholds saved.\nThey will apply on next file import.")
