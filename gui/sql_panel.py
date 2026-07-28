"""
gui/sql_panel.py  (v2 — CTk)
=============================
SQL panel for developers.
- Left side: editable SQL textarea with line numbers
- Right side (toggle): schema reference showing all columns and types
- Toggle button top-right reveals/hides the reference panel
- Auto-populated from filter builder; developer can also type manually
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk, scrolledtext
from typing import Callable

import customtkinter as ctk

from gui.theme import C, FONTS
from gui.widgets import PrimaryButton, SecondaryButton, GhostButton, hdivider

# ---------------------------------------------------------------------------
# Schema reference content
# ---------------------------------------------------------------------------

SCHEMA_REFERENCE = [
    ("attendance_raw", [
        ("emp_code",           "TEXT",    "Employee ID from the file (e.g. '7')"),
        ("emp_name",           "TEXT",    "Employee name from the file (may be truncated)"),
        ("work_date",          "DATE",    "Date of the record  — format: YYYY-MM-DD"),
        ("status",             "TEXT",    "PRESENT | ABSENT | WEEKLY_OFF | HALF_DAY"),
        ("punch_in",           "TEXT",    "Arrival time  — format: HH:MM  (or NULL)"),
        ("punch_out",          "TEXT",    "Departure time — format: HH:MM  (or NULL)"),
        ("work_hours",         "REAL",    "Decimal hours worked (e.g. 6.5). NULL if absent."),
        ("is_late",            "INTEGER", "1 if arrived after late_threshold, else 0"),
        ("left_early",         "INTEGER", "1 if left before early_leave_threshold, else 0"),
        ("report_file",        "TEXT",    "Source filename (e.g. 'atted.xls')"),
        ("report_period_start","DATE",    "Report period start date"),
        ("report_period_end",  "DATE",    "Report period end date"),
        ("company_name",       "TEXT",    "Company/school name from report header"),
    ]),
    ("employee_salary", [
        ("emp_code",           "TEXT",    "Employee ID — primary key, links to attendance_raw"),
        ("emp_name",           "TEXT",    "Name from file"),
        ("emp_name_override",  "TEXT",    "Full name entered by admin (shown in results)"),
        ("monthly_salary",     "REAL",    "Monthly salary in ₹ (0 if not set)"),
        ("daily_rate",         "REAL",    "Auto-calculated: monthly_salary ÷ working_days"),
        ("working_days",       "INTEGER", "Working days per month (default 26)"),
        ("updated_at",         "DATETIME","Last update timestamp"),
    ]),
    ("import_log", [
        ("id",                 "INTEGER", "Auto-increment primary key"),
        ("filename",           "TEXT",    "Imported filename"),
        ("imported_at",        "DATETIME","Timestamp of import"),
        ("rows_imported",      "INTEGER", "Number of records inserted"),
        ("period_start",       "DATE",    "Report period start"),
        ("period_end",         "DATE",    "Report period end"),
        ("company_name",       "TEXT",    "Company name from report"),
    ]),
]

EXAMPLE_QUERIES = """-- Example 1: All records for an employee
SELECT * FROM attendance_raw
WHERE LOWER(emp_name) LIKE '%anita%'
ORDER BY work_date

-- Example 2: Who arrived late this month?
SELECT emp_name, work_date, punch_in
FROM attendance_raw
WHERE is_late = 1
  AND work_date BETWEEN '2026-07-01' AND '2026-07-31'
ORDER BY work_date

-- Example 3: Days present per employee
SELECT emp_name,
       COUNT(CASE WHEN status='PRESENT' THEN 1 END) AS days_present
FROM attendance_raw
GROUP BY emp_code
ORDER BY days_present DESC

-- Example 4: Salary report
SELECT a.emp_name,
       COUNT(CASE WHEN status='PRESENT' THEN 1 END) AS present,
       s.monthly_salary,
       ROUND(s.monthly_salary / 26.0 *
         COUNT(CASE WHEN status='PRESENT' THEN 1 END), 2) AS earned
FROM attendance_raw a
LEFT JOIN employee_salary s ON a.emp_code = s.emp_code
GROUP BY a.emp_code
"""


class SqlPanel(tk.Frame):
    """Split-view SQL panel with schema reference toggle."""

    def __init__(self, parent, on_run: Callable[[str], None], **kwargs):
        super().__init__(parent, bg=C["bg"], **kwargs)
        self._on_run = on_run
        self._ref_visible = False
        self._build_ui()

    def _build_ui(self):
        # ---- Header ----
        hdr = tk.Frame(self, bg=C["bg"])
        hdr.pack(fill="x", padx=20, pady=(10, 6))

        # Left: title + subtitle
        title_col = tk.Frame(hdr, bg=C["bg"])
        title_col.pack(side="left")
        tk.Label(title_col, text="Advanced Query  (SQL)",
                 bg=C["bg"], fg=C["text"],
                 font=FONTS.h3).pack(anchor="w")
        tk.Label(title_col,
                 text="Auto-filled from Search above. Developers can also write their own SELECT queries.",
                 bg=C["bg"], fg=C["text_3"],
                 font=FONTS.caption).pack(anchor="w")

        # Right: toggle + action buttons
        btn_col = tk.Frame(hdr, bg=C["bg"])
        btn_col.pack(side="right")

        self._ref_btn = GhostButton(btn_col, "📋  Field Reference",
                                    command=self._toggle_ref,
                                    width=150)
        self._ref_btn.pack(side="left", padx=(0, 8))

        SecondaryButton(btn_col, "Clear",
                        command=self._clear,
                        width=70).pack(side="left", padx=(0, 8))

        PrimaryButton(btn_col, "▶  Run",
                      command=self._run,
                      width=90).pack(side="left")

        # Ctrl+Enter hint
        tk.Label(hdr, text="Ctrl+Enter to run",
                 bg=C["bg"], fg=C["text_4"],
                 font=FONTS.caption).pack(side="right", padx=(0, 14))

        # ---- Body (editor + optional reference) ----
        self._body = tk.Frame(self, bg=C["bg"])
        self._body.pack(fill="both", expand=True, padx=20, pady=(0, 4))

        # Editor side
        self._editor_frame = tk.Frame(self._body, bg=C["bg_card"],
                                      highlightbackground=C["border"],
                                      highlightthickness=1)
        self._editor_frame.pack(side="left", fill="both", expand=True)

        # Line numbers
        self._line_nums = tk.Text(self._editor_frame,
                                  width=3,
                                  bg=C["bg_sidebar"],
                                  fg=C["text_4"],
                                  font=FONTS.mono_sm,
                                  state="disabled",
                                  relief="flat",
                                  bd=0, padx=4, pady=6)
        self._line_nums.pack(side="left", fill="y")

        tk.Frame(self._editor_frame, bg=C["divider"], width=1).pack(side="left", fill="y")

        # SQL textarea
        self._sql_text = tk.Text(self._editor_frame,
                                 height=6,
                                 bg=C["bg_card"],
                                 fg=C["text"],
                                 font=FONTS.mono,
                                 relief="flat",
                                 bd=0, padx=10, pady=8,
                                 wrap="none",
                                 insertbackground=C["accent"],
                                 selectbackground=C["accent_light"],
                                 selectforeground=C["accent"],
                                 undo=True)
        self._sql_text.pack(side="left", fill="both", expand=True)

        # Horizontal scroll
        hsb = ttk.Scrollbar(self._editor_frame, orient="horizontal",
                            command=self._sql_text.xview)
        self._sql_text.configure(xscrollcommand=hsb.set)

        self._sql_text.bind("<KeyRelease>", self._update_line_numbers)
        self._sql_text.bind("<Control-Return>", lambda e: self._run())
        self._sql_text.bind("<FocusIn>", self._clear_placeholder)

        # Reference panel (hidden initially)
        self._ref_frame = tk.Frame(self._body, bg=C["bg_card"],
                                   highlightbackground=C["border"],
                                   highlightthickness=1,
                                   width=340)

        # Message label
        self._msg_var = tk.StringVar()
        self._msg_lbl = tk.Label(self, textvariable=self._msg_var,
                                 bg=C["bg"], fg=C["text_3"],
                                 font=FONTS.caption, anchor="w")
        self._msg_lbl.pack(fill="x", padx=20, pady=(0, 8))

        self._set_placeholder()
        self._build_ref_panel()

    def _build_ref_panel(self):
        """Build the schema reference panel content."""
        tk.Label(self._ref_frame, text="Database Reference",
                 bg=C["bg_card"], fg=C["text"],
                 font=FONTS.h3).pack(padx=14, pady=(12, 2), anchor="w")
        tk.Label(self._ref_frame,
                 text="All available tables and columns",
                 bg=C["bg_card"], fg=C["text_3"],
                 font=FONTS.caption).pack(padx=14, anchor="w")

        hdivider(self._ref_frame, C["border_light"]).pack(fill="x", padx=10, pady=8)

        # Scrollable content
        ref_canvas = tk.Canvas(self._ref_frame, bg=C["bg_card"],
                               highlightthickness=0)
        ref_vsb = ttk.Scrollbar(self._ref_frame, orient="vertical",
                                command=ref_canvas.yview)
        ref_canvas.configure(yscrollcommand=ref_vsb.set)
        ref_vsb.pack(side="right", fill="y")
        ref_canvas.pack(side="left", fill="both", expand=True)

        inner = tk.Frame(ref_canvas, bg=C["bg_card"])
        ref_canvas.create_window((0, 0), window=inner, anchor="nw")
        inner.bind("<Configure>",
                   lambda e: ref_canvas.configure(scrollregion=ref_canvas.bbox("all")))
        ref_canvas.bind("<Configure>",
                        lambda e: ref_canvas.itemconfig(
                            ref_canvas.find_withtag("all")[0] if ref_canvas.find_withtag("all") else 1,
                            width=e.width))

        for table_name, columns in SCHEMA_REFERENCE:
            # Table name badge
            tbl_frame = tk.Frame(inner, bg=C["accent_light"],
                                 highlightbackground=C["accent"],
                                 highlightthickness=1)
            tbl_frame.pack(fill="x", padx=10, pady=(8, 2))
            tk.Label(tbl_frame, text=f"  {table_name}",
                     bg=C["accent_light"], fg=C["accent"],
                     font=FONTS.body_sm,
                     anchor="w").pack(fill="x", padx=4, pady=4)

            # Columns
            for col_name, col_type, col_hint in columns:
                col_row = tk.Frame(inner, bg=C["bg_card"])
                col_row.pack(fill="x", padx=10, pady=1)

                # Column name
                tk.Label(col_row, text=col_name,
                         bg=C["bg_card"], fg=C["text"],
                         font=FONTS.mono_sm, anchor="w",
                         width=22).pack(side="left")

                # Type badge
                type_bg = C["blue_bg"] if col_type == "TEXT" else \
                          C["orange_bg"] if col_type in ("REAL", "INTEGER") else \
                          C["purple_bg"]
                type_fg = C["blue"] if col_type == "TEXT" else \
                          C["orange"] if col_type in ("REAL", "INTEGER") else \
                          C["purple"]
                tk.Label(col_row, text=col_type,
                         bg=type_bg, fg=type_fg,
                         font=FONTS.caption,
                         padx=5, pady=1).pack(side="left", padx=(0, 8))

                # Hint
                tk.Label(col_row, text=col_hint,
                         bg=C["bg_card"], fg=C["text_3"],
                         font=FONTS.caption,
                         anchor="w").pack(side="left")

        # Examples section
        hdivider(inner, C["border_light"]).pack(fill="x", padx=10, pady=(12, 4))
        tk.Label(inner, text="Example Queries",
                 bg=C["bg_card"], fg=C["text_2"],
                 font=FONTS.body_sm).pack(padx=10, anchor="w")

        ex_text = tk.Text(inner, height=18, bg=C["bg_sidebar"],
                          fg=C["text_2"], font=FONTS.mono_sm,
                          relief="flat", bd=0, padx=8, pady=8,
                          wrap="none", state="normal")
        ex_text.pack(fill="x", padx=10, pady=(4, 12))
        ex_text.insert("1.0", EXAMPLE_QUERIES.strip())
        ex_text.configure(state="disabled")

    def _toggle_ref(self):
        self._ref_visible = not self._ref_visible
        if self._ref_visible:
            self._ref_frame.pack(side="right", fill="y", padx=(8, 0))
            self._ref_btn.configure(text="✕  Close Reference",
                                    fg_color=C["accent_light"],
                                    text_color=C["accent"])
        else:
            self._ref_frame.pack_forget()
            self._ref_btn.configure(text="📋  Field Reference",
                                    fg_color="transparent",
                                    text_color=C["accent"])

    def _set_placeholder(self):
        self._sql_text.insert("1.0",
            "-- Type a SELECT query here, or use Search above to auto-generate one.\n"
            "-- Press Ctrl+Enter to run. Click '📋 Field Reference' for column names.\n"
        )
        self._sql_text.configure(fg=C["text_3"])
        self._update_line_numbers()

    def _clear_placeholder(self, event=None):
        if self._sql_text.cget("fg") == C["text_3"]:
            self._sql_text.delete("1.0", "end")
            self._sql_text.configure(fg=C["text"])
            self._sql_text.unbind("<FocusIn>")
            self._update_line_numbers()

    def _update_line_numbers(self, event=None):
        content = self._sql_text.get("1.0", "end-1c")
        n = content.count("\n") + 1
        self._line_nums.configure(state="normal")
        self._line_nums.delete("1.0", "end")
        self._line_nums.insert("1.0", "\n".join(str(i) for i in range(1, n + 1)))
        self._line_nums.configure(state="disabled")

    def set_sql(self, sql: str):
        self._sql_text.configure(fg=C["text"])
        try:
            self._sql_text.unbind("<FocusIn>")
        except Exception:
            pass
        self._sql_text.delete("1.0", "end")
        self._sql_text.insert("1.0", sql)
        self._update_line_numbers()
        self.clear_message()

    def get_sql(self) -> str:
        if self._sql_text.cget("fg") == C["text_3"]:
            return ""
        return self._sql_text.get("1.0", "end-1c").strip()

    def set_message(self, msg: str, is_error: bool = False):
        self._msg_var.set(msg)
        self._msg_lbl.configure(fg=C["red"] if is_error else C["green"])

    def clear_message(self):
        self._msg_var.set("")

    def _run(self):
        sql = self.get_sql()
        lines = [l for l in sql.splitlines() if not l.strip().startswith("--")]
        clean = "\n".join(lines).strip()
        if not clean:
            self.set_message("Please enter a SQL query before running.", is_error=True)
            return
        self._on_run(clean)

    def _clear(self):
        self._sql_text.delete("1.0", "end")
        self._sql_text.configure(fg=C["text_3"])
        self._set_placeholder()
        self.clear_message()
