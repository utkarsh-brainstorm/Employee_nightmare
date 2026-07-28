"""
gui/app.py  (v2 — CTk)
========================
Main application window. Completely redesigned using CustomTkinter.
Layout: top navbar → import strip → middle (filter + quick) → SQL → results
"""

from __future__ import annotations

import os
import sqlite3
import threading
import tkinter as tk
from tkinter import ttk, messagebox
from typing import Dict, List, Optional

try:
    from tkinterdnd2 import TkinterDnD
    _HAS_DND = True
except ImportError:
    _HAS_DND = False

import customtkinter as ctk

import core.db as db
from core.parser import parse_file

from gui.theme import C, FONTS, load_fonts
from gui.widgets import PrimaryButton, SecondaryButton, GhostButton, hdivider
from gui.import_panel   import ImportPanel
from gui.filter_panel   import FilterPanel
from gui.quick_panel    import QuickPanel
from gui.results_panel  import ResultsPanel
from gui.sql_panel      import SqlPanel
from gui.salary_panel   import SalaryPanel
from gui.settings_panel import SettingsPanel


class AttendanceApp:

    def __init__(self):
        # Root window FIRST (needed before font detection)
        if _HAS_DND:
            self.root = TkinterDnD.Tk()
        else:
            self.root = tk.Tk()

        self.root.title("AttendanceProcessor")
        self.root.geometry("1380x900")
        self.root.minsize(1100, 720)
        self.root.configure(bg=C["bg"])

        # Set CTk appearance
        ctk.set_appearance_mode("light")

        # Now detect fonts (root must exist for tkfont.families() to work)
        family = load_fonts(self.root)
        FONTS.init(family)

        self._apply_ttk_base()
        self._build_ui()

    def _apply_ttk_base(self):
        """Apply base ttk styles that CTk doesn't handle."""
        s = ttk.Style(self.root)
        try:
            s.theme_use("clam")
        except Exception:
            pass
        s.configure("TSeparator", background=C["divider"])
        s.configure("TScrollbar",
                    background=C["bg_sidebar"],
                    troughcolor=C["bg_sidebar"],
                    borderwidth=0, arrowsize=10,
                    relief="flat")

    def _build_ui(self):
        # ==============================================================
        # NAVBAR
        # ==============================================================
        nav = tk.Frame(self.root, bg=C["bg_card"],
                       highlightbackground=C["border"],
                       highlightthickness=1)
        nav.pack(fill="x", side="top")

        nav_inner = tk.Frame(nav, bg=C["bg_card"])
        nav_inner.pack(fill="x", padx=20, pady=10)

        # Brand
        brand = tk.Frame(nav_inner, bg=C["bg_card"])
        brand.pack(side="left")
        tk.Label(brand, text="🏫",
                 bg=C["bg_card"],
                 font=(FONTS.display[0], 20)).pack(side="left", padx=(0, 8))

        brand_text = tk.Frame(brand, bg=C["bg_card"])
        brand_text.pack(side="left")
        tk.Label(brand_text, text="AttendanceProcessor",
                 bg=C["bg_card"], fg=C["text"],
                 font=FONTS.h1).pack(anchor="w")
        tk.Label(brand_text, text="School Staff Attendance Analytics",
                 bg=C["bg_card"], fg=C["text_3"],
                 font=FONTS.caption).pack(anchor="w")

        # Spacer
        tk.Frame(nav_inner, bg=C["bg_card"]).pack(side="left", expand=True, fill="x")

        # DB status
        self._db_status_lbl = tk.Label(nav_inner, text="",
                                       bg=C["bg_card"], fg=C["text_3"],
                                       font=FONTS.caption)
        self._db_status_lbl.pack(side="left", padx=(0, 20))

        # Nav buttons
        for txt, cmd in [
            ("⚙  Settings",        self._open_settings),
            ("👥  Employees",       self._open_salary),
            ("📥  Import History",  self._show_history),
        ]:
            SecondaryButton(nav_inner, txt, cmd, width=130).pack(
                side="left", padx=(0, 8))

        # ==============================================================
        # IMPORT STRIP
        # ==============================================================
        self._import_panel = ImportPanel(self.root,
                                         on_import_success=self._handle_import)
        self._import_panel.pack(fill="x", side="top")

        hdivider(self.root, C["border"]).pack(fill="x", side="top")

        # ==============================================================
        # MIDDLE SECTION — Filter (left) + Quick Panel (right)
        # ==============================================================
        middle = tk.Frame(self.root, bg=C["bg"])
        middle.pack(fill="both", side="top", expand=False)

        # Filter panel — 65%
        filter_card = tk.Frame(middle, bg=C["bg"],
                               highlightbackground=C["border_light"],
                               highlightthickness=1)
        filter_card.pack(side="left", fill="both", expand=True)

        self._filter_panel = FilterPanel(
            filter_card,
            on_run=self._handle_filter_run,
            on_sql_generated=self._handle_sql_generated,
        )
        self._filter_panel.pack(fill="both", expand=True)

        tk.Frame(middle, bg=C["divider"], width=1).pack(side="left", fill="y")

        # Quick panel — fixed width scrollable
        quick_wrap = tk.Frame(middle, bg=C["bg_sidebar"], width=320)
        quick_wrap.pack(side="right", fill="y")
        quick_wrap.pack_propagate(False)

        q_canvas = tk.Canvas(quick_wrap, bg=C["bg_sidebar"],
                             highlightthickness=0)
        q_canvas.pack(side="left", fill="both", expand=True)
        q_vsb = ttk.Scrollbar(quick_wrap, orient="vertical",
                              command=q_canvas.yview)
        q_vsb.pack(side="right", fill="y")
        q_canvas.configure(yscrollcommand=q_vsb.set)

        self._quick_panel = QuickPanel(
            q_canvas,
            on_run=self._handle_quick_run,
            on_sql_generated=self._handle_sql_generated,
        )
        q_win = q_canvas.create_window((0, 0), window=self._quick_panel, anchor="nw")
        self._quick_panel.bind("<Configure>",
                               lambda e: q_canvas.configure(
                                   scrollregion=q_canvas.bbox("all")))
        q_canvas.bind("<Configure>",
                      lambda e: q_canvas.itemconfig(q_win, width=e.width))
        # Mousewheel on quick panel
        q_canvas.bind("<MouseWheel>",
                      lambda e: q_canvas.yview_scroll(-1 * (e.delta // 120), "units"))

        # ==============================================================
        # SQL PANEL
        # ==============================================================
        hdivider(self.root, C["border"]).pack(fill="x", side="top")

        self._sql_panel = SqlPanel(self.root, on_run=self._handle_sql_run)
        self._sql_panel.pack(fill="x", side="top")

        # ==============================================================
        # RESULTS PANEL (expands)
        # ==============================================================
        hdivider(self.root, C["border"]).pack(fill="x", side="top")

        self._results_panel = ResultsPanel(self.root)
        self._results_panel.pack(fill="both", expand=True, side="top")

        self._refresh_db_status()

    # ----------------------------------------------------------------
    # Import
    # ----------------------------------------------------------------

    def _handle_import(self, filepath: str):
        existing = db.check_already_imported(os.path.basename(filepath))
        if existing:
            answer = messagebox.askyesnocancel(
                "File Already Imported",
                f"This file was already imported on {existing.get('imported_at', '?')[:10]}.\n\n"
                f"Records imported then: {existing.get('rows_imported', '?')}\n\n"
                "Yes  = Re-import and overwrite records from this file\n"
                "No   = Import and skip duplicate records\n"
                "Cancel = Do nothing",
                icon="question"
            )
            if answer is None:
                return
            overwrite = bool(answer)
        else:
            overwrite = False

        self._import_panel.show_progress(True)
        self._import_panel.set_status("Parsing file…", C["accent"])

        def _do():
            try:
                late  = db.get_setting("late_threshold",         "09:15")
                early = db.get_setting("early_leave_threshold",  "15:30")
                result = parse_file(filepath, late, early)
                inserted, skipped = db.import_records(result, overwrite=overwrite)

                def _ok():
                    self._import_panel.show_progress(False)
                    emp_count = len(set(r.emp_code for r in result.records))
                    self._import_panel.set_status(
                        f"✅  {inserted} records imported  ({skipped} skipped)  "
                        f"—  {emp_count} employees  —  {result.period_start} to {result.period_end}",
                        C["green"]
                    )
                    self._import_panel.set_last_import_info(
                        f"Last: {result.filename}  |  {result.company_name}"
                    )
                    self._refresh_db_status()
                    self._quick_panel.refresh_dates()
                    if result.warnings:
                        messagebox.showwarning(
                            "Import Warnings",
                            "Import completed with warnings:\n\n" +
                            "\n".join(f"• {w}" for w in result.warnings[:10])
                        )

                self.root.after(0, _ok)

            except ValueError as e:
                self.root.after(0, lambda: (
                    self._import_panel.show_progress(False),
                    self._import_panel.set_status(f"❌  {e}", C["red"]),
                    messagebox.showerror("Import Error", str(e))
                ))
            except Exception as e:
                self.root.after(0, lambda: (
                    self._import_panel.show_progress(False),
                    self._import_panel.set_status(f"❌  Error: {e}", C["red"]),
                    messagebox.showerror("Import Error",
                                         f"Unexpected error:\n\n{e}\n\n"
                                         "Please ensure this is a valid ONtime attendance export.")
                ))

        threading.Thread(target=_do, daemon=True).start()

    # ----------------------------------------------------------------
    # Filter callbacks
    # ----------------------------------------------------------------

    def _handle_filter_run(self, sql: str, params: tuple):
        self._execute(sql, params, "Search Results")

    def _handle_sql_generated(self, sql: str):
        self._sql_panel.set_sql(sql)

    # ----------------------------------------------------------------
    # Quick panel callbacks
    # ----------------------------------------------------------------

    def _handle_quick_run(self, cols: List[str], rows: List[Dict], title: str, sql: str):
        self._sql_panel.set_sql(sql)
        self._results_panel.show_results(cols, rows, title)
        self._sql_panel.set_message(f"✅  {len(rows)} records returned.", is_error=False)

    # ----------------------------------------------------------------
    # SQL panel callbacks
    # ----------------------------------------------------------------

    def _handle_sql_run(self, sql: str):
        self._execute(sql, (), "Query Results")

    # ----------------------------------------------------------------
    # Query executor
    # ----------------------------------------------------------------

    def _execute(self, sql: str, params: tuple, title: str):
        try:
            cols, rows = db.execute_query(sql, params)
            self._results_panel.show_results(cols, rows, title)
            if rows:
                self._sql_panel.set_message(f"✅  {len(rows)} records returned.", is_error=False)
            else:
                self._sql_panel.set_message(
                    "ℹ  No records match your criteria.", is_error=False)

        except ValueError as e:
            self._sql_panel.set_message(f"⚠  {e}", is_error=True)
            messagebox.showwarning("Not Allowed", str(e))

        except sqlite3.OperationalError as e:
            friendly = self._sql_error_msg(str(e))
            self._sql_panel.set_message(f"❌  {e}", is_error=True)
            messagebox.showerror("SQL Error",
                                 f"{friendly}\n\nDetail: {e}\n\n"
                                 "Tip: Click '📋 Field Reference' in the SQL section for column names.")

        except Exception as e:
            self._sql_panel.set_message(f"❌  {e}", is_error=True)
            messagebox.showerror("Error", str(e))

    def _sql_error_msg(self, err: str) -> str:
        e = err.lower()
        if "no such table"  in e: return f"Table '{err.split(':')[-1].strip()}' does not exist.\nAvailable: attendance_raw, employee_salary, import_log"
        if "no such column" in e: return f"Column '{err.split(':')[-1].strip()}' does not exist.\nSee Field Reference for column names."
        if "syntax error"   in e: return "Syntax error in query.\nCheck for missing quotes, commas or brackets."
        if "ambiguous"      in e: return "Ambiguous column name — add table prefix, e.g. attendance_raw.emp_name"
        return "Query error. Check the SQL syntax."

    # ----------------------------------------------------------------
    # Utility
    # ----------------------------------------------------------------

    def _refresh_db_status(self):
        try:
            mn, mx = db.get_date_range()
            if mn:
                self._db_status_lbl.configure(
                    text=f"Database: {mn}  →  {mx}", fg=C["green"])
            else:
                self._db_status_lbl.configure(
                    text="No data in database", fg=C["text_4"])
        except Exception:
            self._db_status_lbl.configure(text="", fg=C["text_4"])

    def _open_settings(self):
        dlg = SettingsPanel(self.root)
        self.root.wait_window(dlg)
        # Refresh threshold display on quick panel
        try:
            self._quick_panel._refresh_thresh_display()
        except Exception:
            pass

    def _open_salary(self):
        SalaryPanel(self.root)

    def _show_history(self):
        history = db.get_import_history()
        win = tk.Toplevel(self.root)
        win.title("Import History")
        win.configure(bg=C["bg"])
        win.minsize(780, 380)

        tk.Label(win, text="Import History",
                 bg=C["bg"], fg=C["text"],
                 font=FONTS.h1).pack(padx=24, pady=(20, 12))

        frame = tk.Frame(win, bg=C["bg"])
        frame.pack(fill="both", expand=True, padx=24, pady=(0, 20))

        style = ttk.Style()
        style.configure("Hist.Treeview",
                        background=C["bg_card"], fieldbackground=C["bg_card"],
                        foreground=C["text"], font=FONTS.table, rowheight=28)
        style.configure("Hist.Treeview.Heading",
                        background=C["bg_sidebar"], foreground=C["text_2"],
                        font=FONTS.table_hd, relief="flat")

        cols = ("filename", "imported_at", "rows_imported", "period_start", "period_end", "company_name")
        hdrs = ("File", "Imported At", "Records", "From", "To", "Company")
        widths = [220, 160, 80, 100, 100, 220]

        tree = ttk.Treeview(frame, columns=cols, show="headings",
                            style="Hist.Treeview")
        for col, hdr, w in zip(cols, hdrs, widths):
            tree.heading(col, text=hdr)
            tree.column(col, width=w, minwidth=50)

        for i, row in enumerate(history):
            tree.insert("", "end",
                        values=[row.get(c, "") for c in cols],
                        tags=("even" if i % 2 == 0 else "odd",))

        tree.tag_configure("even", background=C["bg_card"])
        tree.tag_configure("odd",  background=C["bg_row_alt"])

        vsb = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=vsb.set)
        tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")

        if not history:
            tk.Label(win, text="No files have been imported yet.",
                     bg=C["bg"], fg=C["text_4"],
                     font=FONTS.body).pack(pady=20)

        SecondaryButton(win, "Close", command=win.destroy, width=90).pack(pady=(0, 16))

    def run(self):
        self.root.mainloop()
