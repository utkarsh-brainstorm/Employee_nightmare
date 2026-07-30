"""
gui/results_panel.py  (v2 — CTk)
===================================
Results table with color-coded status rows, sortable columns, export buttons.
Displays employee full names (override) when available.
"""

from __future__ import annotations

import os
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from typing import Dict, List, Optional

import customtkinter as ctk

from core import exporter
import core.db as db
from gui.theme import C, FONTS
from gui.widgets import PrimaryButton, SecondaryButton, GhostButton, status_badge_colors


class ResultsPanel(tk.Frame):
    def __init__(self, parent, **kwargs):
        super().__init__(parent, bg=C["bg"], **kwargs)
        self._columns: List[str] = []
        self._rows: List[Dict] = []
        self._title: str = "Results"
        self._sort_col: Optional[str] = None
        self._sort_asc: bool = True
        self._build_ui()

    def _build_ui(self):
        # ---- Header ----
        hdr = tk.Frame(self, bg=C["bg"])
        hdr.pack(fill="x", padx=20, pady=(8, 4))

        self._title_lbl = tk.Label(hdr, text="Results",
                                   bg=C["bg"], fg=C["text"],
                                   font=FONTS.h3)
        self._title_lbl.pack(side="left")

        self._count_lbl = tk.Label(hdr, text="",
                                   bg=C["bg"], fg=C["text_3"],
                                   font=FONTS.label)
        self._count_lbl.pack(side="left", padx=(10, 0))

        # Export buttons
        exports = tk.Frame(hdr, bg=C["bg"])
        exports.pack(side="right")

        SecondaryButton(exports, "⬇  CSV",
                        command=self._export_csv,
                        width=80).pack(side="left", padx=(0, 6))
        SecondaryButton(exports, "📄  PDF",
                        command=self._export_pdf,
                        width=80).pack(side="left")

        # ---- Table container ----
        tbl = tk.Frame(self, bg=C["bg_card"],
                       highlightbackground=C["border"],
                       highlightthickness=1)
        tbl.pack(fill="both", expand=True, padx=20, pady=(0, 12))

        # Style the treeview
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("Results.Treeview",
                        background=C["bg_card"],
                        fieldbackground=C["bg_card"],
                        foreground=C["text"],
                        font=FONTS.table,
                        rowheight=28,
                        borderwidth=0,
                        relief="flat")
        style.configure("Results.Treeview.Heading",
                        background=C["bg_sidebar"],
                        foreground=C["text_2"],
                        font=FONTS.table_hd,
                        relief="flat",
                        borderwidth=0,
                        padding=(6, 6))
        style.map("Results.Treeview",
                  background=[("selected", C["bg_selected"])],
                  foreground=[("selected", C["accent"])])
        style.map("Results.Treeview.Heading",
                  background=[("active", C["border"])])

        self._tree = ttk.Treeview(tbl, show="headings",
                                  selectmode="browse",
                                  style="Results.Treeview")

        vsb = ttk.Scrollbar(tbl, orient="vertical", command=self._tree.yview)
        hsb = ttk.Scrollbar(tbl, orient="horizontal", command=self._tree.xview)
        self._tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)

        self._tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")
        hsb.grid(row=1, column=0, sticky="ew")
        tbl.grid_rowconfigure(0, weight=1)
        tbl.grid_columnconfigure(0, weight=1)

        # Row tags
        self._tree.tag_configure("even",    background=C["bg_card"])
        self._tree.tag_configure("odd",     background=C["bg_row_alt"])
        self._tree.tag_configure("present", background=C["green_bg"],  foreground=C["green"])
        self._tree.tag_configure("absent",  background=C["red_bg"],    foreground=C["red"])
        self._tree.tag_configure("weekly",  background=C["blue_bg"],   foreground=C["blue"])
        self._tree.tag_configure("half",    background=C["orange_bg"], foreground=C["orange"])

        # Empty state
        self._empty = tk.Label(tbl,
                               text="No results yet.\nUse Search above or click a Quick Report button.",
                               bg=C["bg_card"], fg=C["text_4"],
                               font=FONTS.body,
                               justify="center")
        self._empty.place(relx=0.5, rely=0.42, anchor="center")

        # Status bar
        self._status_var = tk.StringVar()
        tk.Label(self, textvariable=self._status_var,
                 bg=C["bg"], fg=C["text_3"],
                 font=FONTS.caption, anchor="w").pack(
            fill="x", padx=20, pady=(0, 4))

    def show_results(self, columns: List[str], rows: List[Dict], title: str = "Results"):
        self._columns = columns
        self._rows = list(rows)  # copy
        self._title = title
        self._sort_col = None
        self._sort_asc = True
        self._render()

    def _render(self):
        self._tree.delete(*self._tree.get_children())

        if not self._columns:
            self._empty.lift()
            self._count_lbl.configure(text="")
            return

        self._empty.lower()

        self._tree["columns"] = self._columns
        for col in self._columns:
            arrow = (" ↑" if self._sort_asc else " ↓") if col == self._sort_col else ""
            self._tree.heading(col, text=col + arrow,
                               command=lambda c=col: self._sort_by(c))
            max_len = max(len(col),
                         max((len(str(r.get(col, "") or "")) for r in self._rows), default=0))
            w = min(max(max_len * 8 + 20, 70), 240)
            self._tree.column(col, width=w, minwidth=50,
                              anchor="center" if col.lower() in
                              ("status", "in", "out", "hours", "late",
                               "left early", "date", "emp code",
                               "present", "absent", "weekly off", "half day",
                               "late days", "early leaves")
                              else "w")

        for i, row in enumerate(self._rows):
            values = [row.get(col, "") or "" for col in self._columns]
            status = str(row.get("Status", row.get("status", ""))).upper()
            tag = {
                "PRESENT":    "present",
                "ABSENT":     "absent",
                "WEEKLY_OFF": "weekly",
                "HALF_DAY":   "half",
            }.get(status, "even" if i % 2 == 0 else "odd")
            self._tree.insert("", "end", values=values, tags=(tag,))

        n = len(self._rows)
        self._title_lbl.configure(text=self._title)
        self._count_lbl.configure(text=f"— {n} record{'s' if n != 1 else ''}")
        self._status_var.set(f"Query returned {n} record{'s' if n != 1 else ''}.")

    def _sort_by(self, col: str):
        if self._sort_col == col:
            self._sort_asc = not self._sort_asc
        else:
            self._sort_col = col
            self._sort_asc = True

        def key(row):
            v = row.get(col, "") or ""
            try:
                return (0, float(str(v).replace("₹", "").replace(",", "").strip()))
            except (ValueError, TypeError):
                return (1, str(v).lower())

        self._rows.sort(key=key, reverse=not self._sort_asc)
        self._render()

    def set_status(self, msg: str, color: str = None):
        self._status_var.set(msg)

    def _export_csv(self):
        if not self._rows:
            messagebox.showwarning("No Data", "No results to export.")
            return
        path = filedialog.asksaveasfilename(
            title="Export as CSV",
            defaultextension=".csv",
            initialfile=self._title.replace(" ", "_") + ".csv",
            filetypes=[("CSV Files", "*.csv"), ("All Files", "*.*")],
        )
        if not path:
            return
        try:
            exporter.export_csv(self._columns, self._rows, path)
            messagebox.showinfo("Exported", f"CSV saved:\n{path}")
        except Exception as e:
            messagebox.showerror("Export Failed", str(e))

    def _export_pdf(self):
        if not self._rows:
            messagebox.showwarning("No Data", "No results to export.")
            return
        path = filedialog.asksaveasfilename(
            title="Export as PDF",
            defaultextension=".pdf",
            initialfile=self._title.replace(" ", "_") + ".pdf",
            filetypes=[("PDF Files", "*.pdf"), ("All Files", "*.*")],
        )
        if not path:
            return

        def do_pdf():
            try:
                exporter.export_pdf(self._columns, self._rows, path,
                                    title=self._title,
                                    subtitle="AttendanceProcessor")
                self.after(0, lambda: messagebox.showinfo("Exported", f"PDF saved:\n{path}"))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Export Failed", str(e)))

        threading.Thread(target=do_pdf, daemon=True).start()

    def clear(self):
        self._columns = []
        self._rows = []
        self._tree["columns"] = []
        self._tree.delete(*self._tree.get_children())
        self._title_lbl.configure(text="Results")
        self._count_lbl.configure(text="")
        self._status_var.set("")
        self._empty.lift()
