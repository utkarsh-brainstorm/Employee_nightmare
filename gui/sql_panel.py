"""
gui/sql_panel.py
================
SQL query panel — auto-populated from filter builder, editable by user.
Shows generated SQL and allows manual SQL entry.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk, scrolledtext
from typing import Callable

from gui.theme import C, FONTS


class SqlPanel(tk.Frame):
    """
    SQL bar at the bottom-center:
    - Displays auto-generated SQL (from filter builder or quick buttons)
    - Allows user to edit and run arbitrary SELECT queries
    - Shows error messages inline
    """

    def __init__(self, parent,
                 on_run: Callable[[str], None],
                 **kwargs):
        super().__init__(parent, bg=C["bg"], **kwargs)
        self._on_run = on_run
        self._build_ui()

    def _build_ui(self):
        # Header
        hdr = tk.Frame(self, bg=C["bg"])
        hdr.pack(fill="x", padx=20, pady=(8, 4))

        tk.Label(hdr, text="SQL Query",
                 bg=C["bg"], fg=C["text_primary"],
                 font=FONTS["h3"]).pack(side="left")

        tk.Label(hdr,
                 text="— auto-generated from filters above, or type your own SELECT",
                 bg=C["bg"], fg=C["text_secondary"],
                 font=FONTS["body_sm"]).pack(side="left", padx=(8, 0))

        btn_row = tk.Frame(hdr, bg=C["bg"])
        btn_row.pack(side="right")

        ttk.Button(btn_row, text="▶  Run",
                   style="Accent.TButton",
                   command=self._run).pack(side="left", padx=(0, 6))

        ttk.Button(btn_row, text="Clear",
                   style="TButton",
                   command=self._clear).pack(side="left", padx=(0, 6))

        ttk.Button(btn_row, text="?  Help",
                   style="Ghost.TButton",
                   command=self._show_help).pack(side="left")

        # SQL text area
        editor_frame = tk.Frame(self, bg=C["bg"],
                                highlightbackground=C["border"],
                                highlightthickness=1)
        editor_frame.pack(fill="x", padx=20, pady=(0, 4))

        # Line numbers gutter
        self._line_nums = tk.Text(editor_frame,
                                  width=3,
                                  bg=C["bg_secondary"],
                                  fg=C["text_tertiary"],
                                  font=FONTS["mono"],
                                  state="disabled",
                                  relief="flat",
                                  padx=4,
                                  pady=6,
                                  bd=0)
        self._line_nums.pack(side="left", fill="y")

        self._sql_text = tk.Text(editor_frame,
                                 height=5,
                                 bg=C["bg"],
                                 fg=C["text_primary"],
                                 font=FONTS["mono"],
                                 relief="flat",
                                 padx=8,
                                 pady=6,
                                 bd=0,
                                 wrap="none",
                                 insertbackground=C["accent"],
                                 selectbackground=C["accent_light"],
                                 selectforeground=C["accent"])
        self._sql_text.pack(side="left", fill="both", expand=True)

        hsb = ttk.Scrollbar(editor_frame, orient="horizontal",
                            command=self._sql_text.xview)
        self._sql_text.configure(xscrollcommand=hsb.set)

        self._sql_text.bind("<KeyRelease>", self._update_line_numbers)
        self._sql_text.bind("<Control-Return>", lambda e: self._run())

        # Error / info message
        self._msg_var = tk.StringVar()
        self._msg_label = tk.Label(self,
                                   textvariable=self._msg_var,
                                   bg=C["bg"],
                                   fg=C["text_secondary"],
                                   font=FONTS["caption"],
                                   anchor="w",
                                   justify="left",
                                   wraplength=900)
        self._msg_label.pack(fill="x", padx=20, pady=(0, 8))

        # Hint text
        self._set_placeholder()

    def _set_placeholder(self):
        self._sql_text.insert("1.0",
            "-- Type a SELECT query here, or use the Filter Builder / Quick Summaries above.\n"
            "-- Example: SELECT emp_name, COUNT(*) as days FROM attendance_raw GROUP BY emp_name\n"
            "-- Shortcut: Ctrl+Enter to run"
        )
        self._sql_text.configure(fg=C["text_tertiary"])
        self._sql_text.bind("<FocusIn>", self._clear_placeholder)

    def _clear_placeholder(self, event=None):
        if self._sql_text.cget("fg") == C["text_tertiary"]:
            self._sql_text.delete("1.0", "end")
            self._sql_text.configure(fg=C["text_primary"])
            self._sql_text.unbind("<FocusIn>")
            self._update_line_numbers()

    def _update_line_numbers(self, event=None):
        content = self._sql_text.get("1.0", "end-1c")
        lines = content.count("\n") + 1
        self._line_nums.configure(state="normal")
        self._line_nums.delete("1.0", "end")
        self._line_nums.insert("1.0", "\n".join(str(i) for i in range(1, lines + 1)))
        self._line_nums.configure(state="disabled")

    def set_sql(self, sql: str):
        """Set SQL text (called from filter builder or quick buttons)."""
        self._sql_text.configure(fg=C["text_primary"])
        self._sql_text.unbind("<FocusIn>")
        self._sql_text.delete("1.0", "end")
        self._sql_text.insert("1.0", sql)
        self._update_line_numbers()
        self.clear_message()

    def get_sql(self) -> str:
        """Get current SQL text, stripping comments and whitespace."""
        text = self._sql_text.get("1.0", "end-1c").strip()
        if self._sql_text.cget("fg") == C["text_tertiary"]:
            return ""
        return text

    def set_message(self, msg: str, is_error: bool = False):
        self._msg_var.set(msg)
        self._msg_label.configure(fg=C["danger"] if is_error else C["success"])

    def clear_message(self):
        self._msg_var.set("")

    def _run(self):
        sql = self.get_sql()
        if not sql or sql.startswith("--"):
            self.set_message("Please enter a SQL SELECT query.", is_error=True)
            return
        self._on_run(sql)

    def _clear(self):
        self._sql_text.delete("1.0", "end")
        self._sql_text.configure(fg=C["text_tertiary"])
        self._set_placeholder()
        self.clear_message()

    def _show_help(self):
        help_win = tk.Toplevel(self.winfo_toplevel())
        help_win.title("SQL Help")
        help_win.configure(bg=C["bg"])
        help_win.resizable(True, True)
        help_win.minsize(600, 450)

        tk.Label(help_win, text="SQL Query Help",
                 bg=C["bg"], fg=C["text_primary"],
                 font=FONTS["h2"]).pack(padx=24, pady=(20, 8))

        help_text = scrolledtext.ScrolledText(
            help_win,
            bg=C["bg_secondary"],
            fg=C["text_primary"],
            font=FONTS["mono_sm"],
            relief="flat",
            padx=12,
            pady=8,
            wrap="word",
            state="normal",
        )
        help_text.pack(fill="both", expand=True, padx=24, pady=(0, 20))

        help_content = """
AVAILABLE TABLE: attendance_raw

COLUMNS:
  emp_code          - Employee code (text)
  emp_name          - Employee name (text)
  work_date         - Date (YYYY-MM-DD)
  status            - PRESENT | ABSENT | WEEKLY_OFF | HALF_DAY
  punch_in          - Punch-in time (HH:MM)
  punch_out         - Punch-out time (HH:MM)
  work_hours        - Hours worked (decimal, e.g. 6.5)
  is_late           - 1 if arrived late, 0 otherwise
  left_early        - 1 if left early, 0 otherwise
  report_file       - Source filename
  company_name      - Company/school name

OTHER TABLES:
  employee_salary   - emp_code, emp_name, monthly_salary, working_days, updated_at
  import_log        - id, filename, imported_at, rows_imported, period_start, period_end

EXAMPLE QUERIES:

-- All records for a specific employee
SELECT * FROM attendance_raw WHERE emp_name LIKE '%anita%'

-- Count present days per employee in July
SELECT emp_code, emp_name,
       COUNT(CASE WHEN status='PRESENT' THEN 1 END) AS days_present
FROM attendance_raw
WHERE work_date BETWEEN '2026-07-01' AND '2026-07-31'
GROUP BY emp_code
ORDER BY days_present DESC

-- Who came after 9:30 AM?
SELECT emp_name, work_date, punch_in
FROM attendance_raw
WHERE punch_in > '09:30'
  AND status IN ('PRESENT', 'HALF_DAY')
ORDER BY work_date, punch_in

-- Salary report join
SELECT a.emp_name,
       COUNT(CASE WHEN status='PRESENT' THEN 1 END) AS days,
       s.monthly_salary,
       ROUND(s.monthly_salary / 26.0 * COUNT(CASE WHEN status='PRESENT' THEN 1 END), 2) AS earned
FROM attendance_raw a
LEFT JOIN employee_salary s ON a.emp_code = s.emp_code
GROUP BY a.emp_code

-- Who has been absent more than 5 days?
SELECT emp_name, COUNT(*) AS absent_days
FROM attendance_raw
WHERE status = 'ABSENT'
GROUP BY emp_code
HAVING absent_days > 5
ORDER BY absent_days DESC

TIPS:
• Only SELECT queries are allowed (no INSERT/UPDATE/DELETE)
• Use Ctrl+Enter to run the query
• Times are stored as text 'HH:MM' so comparisons work lexicographically
• Dates are stored as 'YYYY-MM-DD'
• Use LOWER() for case-insensitive name searches
"""
        help_text.insert("1.0", help_content.strip())
        help_text.configure(state="disabled")

        ttk.Button(help_win, text="Close", style="TButton",
                   command=help_win.destroy).pack(pady=(0, 16))
