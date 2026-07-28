"""
gui/app.py
==========
Main application window — orchestrates all panels and handles
all cross-panel communication.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import tkinter as tk
from tkinter import ttk, messagebox
from typing import List, Dict, Optional

try:
    from tkinterdnd2 import TkinterDnD, DND_FILES
    _HAS_DND = True
except ImportError:
    _HAS_DND = False

import core.db as db
from core.parser import parse_file
from core import exporter

from gui.theme import C, FONTS, apply_theme
from gui.import_panel import ImportPanel
from gui.filter_panel import FilterPanel
from gui.quick_panel import QuickPanel
from gui.results_panel import ResultsPanel
from gui.sql_panel import SqlPanel
from gui.salary_panel import SalaryPanel


class AttendanceApp:
    """
    Main application class. Creates the root window and assembles all panels.
    """

    def __init__(self):
        # Create root window — use TkinterDnD if available
        if _HAS_DND:
            self.root = TkinterDnD.Tk()
        else:
            self.root = tk.Tk()

        self.root.title("AttendanceProcessor")
        self.root.geometry("1280x860")
        self.root.minsize(1024, 700)

        # Apply theme
        self._style = apply_theme(self.root)

        # Try to set window icon
        try:
            icon_path = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                "assets", "icon.png"
            )
            if os.path.exists(icon_path):
                img = tk.PhotoImage(file=icon_path)
                self.root.iconphoto(True, img)
        except Exception:
            pass

        self._build_ui()

    def _build_ui(self):
        # ----------------------------------------------------------------
        # Title Bar (custom)
        # ----------------------------------------------------------------
        title_bar = tk.Frame(self.root, bg=C["bg"],
                             highlightbackground=C["border_light"],
                             highlightthickness=1)
        title_bar.pack(fill="x", side="top")

        # Left: App brand
        brand_frame = tk.Frame(title_bar, bg=C["bg"])
        brand_frame.pack(side="left", padx=20, pady=10)

        tk.Label(brand_frame,
                 text="🏫",
                 bg=C["bg"],
                 font=(FONTS["h2"][0], 20)).pack(side="left", padx=(0, 8))
        tk.Label(brand_frame,
                 text="AttendanceProcessor",
                 bg=C["bg"], fg=C["text_primary"],
                 font=FONTS["h2"]).pack(side="left")
        tk.Label(brand_frame,
                 text="  School Staff Attendance Analytics",
                 bg=C["bg"], fg=C["text_secondary"],
                 font=FONTS["body_sm"]).pack(side="left", padx=(4, 0))

        # Right: action buttons
        action_frame = tk.Frame(title_bar, bg=C["bg"])
        action_frame.pack(side="right", padx=20, pady=8)

        ttk.Button(action_frame, text="💰  Salary Manager",
                   style="TButton",
                   command=self._open_salary).pack(side="left", padx=(0, 8))

        ttk.Button(action_frame, text="📥  Import History",
                   style="Ghost.TButton",
                   command=self._show_import_history).pack(side="left", padx=(0, 8))

        self._db_status = tk.Label(action_frame, text="",
                                   bg=C["bg"], fg=C["success"],
                                   font=FONTS["caption"])
        self._db_status.pack(side="left")

        # ----------------------------------------------------------------
        # Import Panel (top)
        # ----------------------------------------------------------------
        self._import_panel = ImportPanel(
            self.root,
            on_import_success=self._handle_import,
        )
        self._import_panel.pack(fill="x", side="top",
                                padx=0, pady=0)

        ttk.Separator(self.root, orient="horizontal").pack(fill="x", side="top")

        # ----------------------------------------------------------------
        # Middle section: Filter Builder (left) + Quick Panel (right)
        # ----------------------------------------------------------------
        middle = tk.Frame(self.root, bg=C["bg"])
        middle.pack(fill="both", side="top", expand=False)

        # Filter panel (left ~60%)
        filter_container = tk.Frame(middle, bg=C["bg"],
                                    highlightbackground=C["border_light"],
                                    highlightthickness=1)
        filter_container.pack(side="left", fill="both", expand=True)

        self._filter_panel = FilterPanel(
            filter_container,
            on_run=self._handle_filter_run,
            on_sql_generated=self._handle_sql_generated,
        )
        self._filter_panel.pack(fill="both", expand=True)

        # Divider
        ttk.Separator(middle, orient="vertical").pack(side="left", fill="y")

        # Quick panel (right ~35%)
        quick_scroll_frame = tk.Frame(middle, bg=C["sidebar_bg"], width=310)
        quick_scroll_frame.pack(side="right", fill="y")
        quick_scroll_frame.pack_propagate(False)

        # Scrollable quick panel
        qcanvas = tk.Canvas(quick_scroll_frame, bg=C["sidebar_bg"],
                            highlightthickness=0, width=308)
        qcanvas.pack(side="left", fill="both", expand=True)
        qvsb = ttk.Scrollbar(quick_scroll_frame, orient="vertical",
                             command=qcanvas.yview)
        qvsb.pack(side="right", fill="y")
        qcanvas.configure(yscrollcommand=qvsb.set)

        self._quick_panel = QuickPanel(
            qcanvas,
            on_run=self._handle_quick_run,
            on_sql_generated=self._handle_sql_generated,
        )
        qcanvas.create_window((0, 0), window=self._quick_panel, anchor="nw")
        self._quick_panel.bind("<Configure>",
                               lambda e: qcanvas.configure(
                                   scrollregion=qcanvas.bbox("all")))
        qcanvas.bind("<Configure>",
                     lambda e: qcanvas.itemconfig(
                         qcanvas.find_withtag("all")[0] if qcanvas.find_withtag("all") else 1,
                         width=e.width))

        # ----------------------------------------------------------------
        # SQL Panel
        # ----------------------------------------------------------------
        ttk.Separator(self.root, orient="horizontal").pack(fill="x", side="top")

        sql_container = tk.Frame(self.root, bg=C["bg"])
        sql_container.pack(fill="x", side="top")

        self._sql_panel = SqlPanel(
            sql_container,
            on_run=self._handle_sql_run,
        )
        self._sql_panel.pack(fill="x")

        # ----------------------------------------------------------------
        # Results Panel (bottom, expands)
        # ----------------------------------------------------------------
        ttk.Separator(self.root, orient="horizontal").pack(fill="x", side="top")

        self._results_panel = ResultsPanel(self.root)
        self._results_panel.pack(fill="both", expand=True, side="top")

        # ----------------------------------------------------------------
        # Update DB status
        # ----------------------------------------------------------------
        self._refresh_db_status()

    # ----------------------------------------------------------------
    # Import handling
    # ----------------------------------------------------------------

    def _handle_import(self, filepath: str):
        """Called when user clicks Import. Runs in background thread."""
        # Check for duplicate
        existing = db.check_already_imported(os.path.basename(filepath))
        if existing:
            answer = messagebox.askyesnocancel(
                "File Already Imported",
                f"This file was imported on {existing.get('imported_at', 'earlier')}.\n\n"
                f"Records imported then: {existing.get('rows_imported', '?')}\n\n"
                "• Yes = Re-import and overwrite existing records\n"
                "• No = Import and merge (skip duplicates)\n"
                "• Cancel = Do nothing",
                icon="question"
            )
            if answer is None:
                return
            overwrite = answer
        else:
            overwrite = False

        self._import_panel.show_progress(True)
        self._import_panel.set_status("Parsing file…", C["accent"])

        def _do_import():
            try:
                late_thr = db.get_setting("late_threshold", "09:15")
                early_thr = db.get_setting("early_leave_threshold", "15:30")
                result = parse_file(filepath, late_thr, early_thr)

                inserted, skipped = db.import_records(result, overwrite=overwrite)

                def _on_success():
                    self._import_panel.show_progress(False)
                    msg = (
                        f"✅  Imported {inserted} records"
                        f" ({skipped} skipped/duplicate)"
                        f"  —  {len(set(r.emp_code for r in result.records))} employees"
                        f"  —  Period: {result.period_start} to {result.period_end}"
                    )
                    self._import_panel.set_status(msg, C["success"])
                    self._import_panel.set_last_import_info(
                        f"Last import: {result.filename}  "
                        f"| Company: {result.company_name}"
                        f"| {inserted} records inserted"
                    )
                    self._refresh_db_status()

                    if result.warnings:
                        messagebox.showwarning(
                            "Import Warnings",
                            "Import completed with warnings:\n\n" +
                            "\n".join(f"• {w}" for w in result.warnings[:10])
                        )

                self.root.after(0, _on_success)

            except ValueError as e:
                def _on_err():
                    self._import_panel.show_progress(False)
                    self._import_panel.set_status(f"❌  {e}", C["danger"])
                    messagebox.showerror("Import Error", str(e))
                self.root.after(0, _on_err)

            except Exception as e:
                def _on_err():
                    self._import_panel.show_progress(False)
                    self._import_panel.set_status(f"❌  Unexpected error: {e}", C["danger"])
                    messagebox.showerror("Import Error",
                                         f"An unexpected error occurred:\n\n{e}\n\n"
                                         "Please ensure the file is a valid ONtime attendance export.")
                self.root.after(0, _on_err)

        threading.Thread(target=_do_import, daemon=True).start()

    # ----------------------------------------------------------------
    # Filter panel callbacks
    # ----------------------------------------------------------------

    def _handle_filter_run(self, sql: str, params: tuple):
        """Run a query generated by the filter builder."""
        self._execute_and_show(sql, params, title="Filter Results")

    def _handle_sql_generated(self, sql: str):
        """Push auto-generated SQL to the SQL panel."""
        self._sql_panel.set_sql(sql)

    # ----------------------------------------------------------------
    # Quick panel callbacks
    # ----------------------------------------------------------------

    def _handle_quick_run(self, columns: List[str], rows: List[Dict], title: str, sql_hint: str):
        """Display results from quick buttons directly."""
        self._sql_panel.set_sql(sql_hint)
        self._results_panel.show_results(columns, rows, title)
        self._sql_panel.set_message(
            f"✅  {len(rows)} records returned.", is_error=False
        )

    # ----------------------------------------------------------------
    # SQL panel callbacks
    # ----------------------------------------------------------------

    def _handle_sql_run(self, sql: str):
        """Execute user-typed SQL query."""
        # Strip comments for execution but keep original in panel
        import re
        clean_sql = "\n".join(
            line for line in sql.splitlines()
            if not line.strip().startswith("--")
        ).strip()
        if not clean_sql:
            self._sql_panel.set_message("Please enter a SQL query.", is_error=True)
            return
        self._execute_and_show(clean_sql, (), title="Custom Query")

    # ----------------------------------------------------------------
    # Core query executor
    # ----------------------------------------------------------------

    def _execute_and_show(self, sql: str, params: tuple, title: str):
        """Execute SQL and display results. Shows errors gracefully."""
        try:
            columns, rows = db.execute_query(sql, params)

            if not rows:
                self._results_panel.show_results(columns, [], title)
                self._sql_panel.set_message(
                    "ℹ️  Query executed successfully — no records match your criteria.",
                    is_error=False
                )
            else:
                self._results_panel.show_results(columns, rows, title)
                self._sql_panel.set_message(
                    f"✅  {len(rows)} records returned.", is_error=False
                )

        except ValueError as e:
            # Non-SELECT query or user-friendly error
            self._sql_panel.set_message(f"⚠️  {e}", is_error=True)
            messagebox.showwarning("Query Not Allowed", str(e))

        except sqlite3.OperationalError as e:
            err_msg = str(e)
            # Make the error message user-friendly
            friendly = self._friendly_sql_error(err_msg, sql)
            self._sql_panel.set_message(f"❌  SQL Error: {err_msg}", is_error=True)
            messagebox.showerror(
                "SQL Error",
                f"{friendly}\n\n"
                f"Technical detail:\n{err_msg}\n\n"
                "Tip: Click the '? Help' button for example queries."
            )

        except Exception as e:
            self._sql_panel.set_message(f"❌  Error: {e}", is_error=True)
            messagebox.showerror("Query Error", str(e))

    def _friendly_sql_error(self, error: str, sql: str) -> str:
        """Convert sqlite3 error messages to user-friendly text."""
        e_lower = error.lower()
        if "no such table" in e_lower:
            table = error.split(":")[-1].strip()
            return (
                f"Table '{table}' does not exist.\n\n"
                "Available tables:\n"
                "  • attendance_raw\n"
                "  • employee_salary\n"
                "  • import_log"
            )
        if "no such column" in e_lower:
            col = error.split(":")[-1].strip()
            return (
                f"Column '{col}' does not exist.\n\n"
                "Click '? Help' to see all available columns."
            )
        if "syntax error" in e_lower:
            return (
                "There is a syntax error in your SQL query.\n\n"
                "Common mistakes:\n"
                "  • Missing quotes around text values\n"
                "  • Mismatched parentheses\n"
                "  • Missing comma between column names"
            )
        if "ambiguous column" in e_lower:
            return (
                "Column name is ambiguous — please prefix with table name.\n"
                "Example: attendance_raw.emp_name instead of emp_name"
            )
        return "There was an error running your query. Please check the syntax."

    # ----------------------------------------------------------------
    # Utility
    # ----------------------------------------------------------------

    def _refresh_db_status(self):
        try:
            min_d, max_d = db.get_date_range()
            if min_d:
                self._db_status.configure(
                    text=f"📁  DB: {min_d} → {max_d}",
                    fg=C["success"]
                )
            else:
                self._db_status.configure(
                    text="📁  DB: No data yet",
                    fg=C["text_tertiary"]
                )
        except Exception:
            self._db_status.configure(text="", fg=C["text_tertiary"])

    def _open_salary(self):
        SalaryPanel(self.root)

    def _show_import_history(self):
        history = db.get_import_history()
        win = tk.Toplevel(self.root)
        win.title("Import History")
        win.configure(bg=C["bg"])
        win.minsize(700, 350)

        tk.Label(win, text="Import History",
                 bg=C["bg"], fg=C["text_primary"],
                 font=FONTS["h2"]).pack(padx=24, pady=(20, 12))

        frame = tk.Frame(win, bg=C["bg"])
        frame.pack(fill="both", expand=True, padx=24, pady=(0, 20))

        cols = ("filename", "imported_at", "rows_imported", "period_start", "period_end", "company_name")
        hdrs = ("File", "Imported At", "Records", "Period Start", "Period End", "Company")

        tree = ttk.Treeview(frame, columns=cols, show="headings",
                            style="Treeview")
        widths = [200, 160, 80, 100, 100, 200]
        for col, hdr, w in zip(cols, hdrs, widths):
            tree.heading(col, text=hdr)
            tree.column(col, width=w, minwidth=50)

        for i, row in enumerate(history):
            tree.insert("", "end",
                        values=[row.get(c, "") for c in cols],
                        tags=("even" if i % 2 == 0 else "odd",))

        tree.tag_configure("even", background=C["bg"])
        tree.tag_configure("odd", background=C["bg_secondary"])

        vsb = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=vsb.set)
        tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")

        if not history:
            tk.Label(win, text="No files imported yet.",
                     bg=C["bg"], fg=C["text_tertiary"],
                     font=FONTS["body"]).pack(pady=20)

        ttk.Button(win, text="Close", style="TButton",
                   command=win.destroy).pack(pady=(0, 16))

    def run(self):
        self.root.mainloop()
