"""
gui/results_panel.py
====================
Results display panel — sortable Treeview table + CSV/PDF export buttons.
"""

from __future__ import annotations

import os
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from typing import Dict, List, Optional, Callable

from core import exporter
from gui.theme import C, FONTS


class ResultsPanel(tk.Frame):
    """
    Bottom panel: displays query results in a sortable treeview.
    Provides Export CSV and Export PDF buttons.
    """

    def __init__(self, parent, **kwargs):
        super().__init__(parent, bg=C["bg"], **kwargs)
        self._columns: List[str] = []
        self._rows: List[Dict] = []
        self._title: str = "Results"
        self._sort_col: Optional[str] = None
        self._sort_asc: bool = True
        self._build_ui()

    def _build_ui(self):
        # Header row
        hdr = tk.Frame(self, bg=C["bg"])
        hdr.pack(fill="x", padx=20, pady=(10, 4))

        self._title_label = tk.Label(hdr, text="Results",
                                     bg=C["bg"], fg=C["text_primary"],
                                     font=FONTS["h3"])
        self._title_label.pack(side="left")

        self._count_label = tk.Label(hdr, text="",
                                     bg=C["bg"], fg=C["text_secondary"],
                                     font=FONTS["body_sm"])
        self._count_label.pack(side="left", padx=(12, 0))

        # Export buttons
        btn_frame = tk.Frame(hdr, bg=C["bg"])
        btn_frame.pack(side="right")

        ttk.Button(btn_frame, text="⬇ Export CSV",
                   style="TButton",
                   command=self._export_csv).pack(side="left", padx=(0, 6))
        ttk.Button(btn_frame, text="📄 Export PDF",
                   style="TButton",
                   command=self._export_pdf).pack(side="left")

        # Status badge
        self._status_frame = tk.Frame(self, bg=C["bg"])
        self._status_frame.pack(fill="x", padx=20, pady=(0, 4))
        self._status_label = tk.Label(self._status_frame, text="",
                                      bg=C["bg"], fg=C["text_secondary"],
                                      font=FONTS["caption"])
        self._status_label.pack(side="left")

        # Treeview frame with both scrollbars
        tree_container = tk.Frame(self, bg=C["bg"],
                                  highlightbackground=C["border_light"],
                                  highlightthickness=1)
        tree_container.pack(fill="both", expand=True, padx=20, pady=(0, 16))

        self._tree = ttk.Treeview(tree_container,
                                  show="headings",
                                  selectmode="browse",
                                  style="Treeview")

        vsb = ttk.Scrollbar(tree_container, orient="vertical",
                            command=self._tree.yview)
        hsb = ttk.Scrollbar(tree_container, orient="horizontal",
                            command=self._tree.xview)
        self._tree.configure(yscrollcommand=vsb.set,
                             xscrollcommand=hsb.set)

        self._tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")
        hsb.grid(row=1, column=0, sticky="ew")
        tree_container.grid_rowconfigure(0, weight=1)
        tree_container.grid_columnconfigure(0, weight=1)

        # Alternating row tags
        self._tree.tag_configure("even", background=C["bg"])
        self._tree.tag_configure("odd", background=C["bg_secondary"])
        self._tree.tag_configure("present", background=C["present_bg"],
                                 foreground=C["present_fg"])
        self._tree.tag_configure("absent", background=C["absent_bg"],
                                 foreground=C["absent_fg"])
        self._tree.tag_configure("weeklyoff", background=C["weeklyoff_bg"],
                                 foreground=C["weeklyoff_fg"])
        self._tree.tag_configure("halfday", background=C["halfday_bg"],
                                 foreground=C["halfday_fg"])

        # Empty state label (overlay)
        self._empty_label = tk.Label(tree_container,
                                     text="No results yet.\nUse the Filter Builder or Quick Summaries to query data.",
                                     bg=C["bg"], fg=C["text_tertiary"],
                                     font=FONTS["body"],
                                     justify="center")
        self._empty_label.place(relx=0.5, rely=0.45, anchor="center")

    def show_results(self, columns: List[str], rows: List[Dict], title: str = "Results"):
        """Update the table with new query results."""
        self._columns = columns
        self._rows = rows
        self._title = title
        self._title_label.configure(text=title)
        self._sort_col = None
        self._sort_asc = True
        self._render_table()

    def _render_table(self):
        self._tree.delete(*self._tree.get_children())

        if not self._columns:
            self._empty_label.lift()
            self._count_label.configure(text="")
            return

        self._empty_label.lower()

        # Configure columns
        self._tree["columns"] = self._columns
        for col in self._columns:
            self._tree.heading(col, text=col,
                               command=lambda c=col: self._sort_by(c))
            # Auto width
            max_len = max(len(col), max((len(str(r.get(col, "") or "")) for r in self._rows), default=0))
            w = min(max(max_len * 8 + 16, 60), 220)
            self._tree.column(col, width=w, minwidth=50,
                              anchor="center" if col.lower() in
                              ("status", "in", "out", "hours", "late", "left early", "date", "emp code")
                              else "w")

        # Add sort arrow to column heading
        for col in self._columns:
            arrow = ""
            if col == self._sort_col:
                arrow = " ↑" if self._sort_asc else " ↓"
            self._tree.heading(col, text=col + arrow,
                               command=lambda c=col: self._sort_by(c))

        # Populate rows
        for i, row in enumerate(self._rows):
            values = [row.get(col, "") or "" for col in self._columns]

            # Determine tag for color coding
            status = str(row.get("Status", row.get("status", ""))).upper()
            if status == "PRESENT":
                tag = "present"
            elif status == "ABSENT":
                tag = "absent"
            elif status == "WEEKLY_OFF":
                tag = "weeklyoff"
            elif status == "HALF_DAY":
                tag = "halfday"
            else:
                tag = "even" if i % 2 == 0 else "odd"

            self._tree.insert("", "end", values=values, tags=(tag,))

        count = len(self._rows)
        self._count_label.configure(
            text=f"— {count} row{'s' if count != 1 else ''}"
        )
        self._status_label.configure(text=f"Query returned {count} records")

    def _sort_by(self, col: str):
        """Sort table by column."""
        if self._sort_col == col:
            self._sort_asc = not self._sort_asc
        else:
            self._sort_col = col
            self._sort_asc = True

        def sort_key(row):
            val = row.get(col, "") or ""
            # Try numeric sort
            try:
                return (0, float(str(val).replace("₹", "").replace(",", "").strip()))
            except (ValueError, TypeError):
                return (1, str(val).lower())

        self._rows.sort(key=sort_key, reverse=not self._sort_asc)
        self._render_table()

    def set_status(self, msg: str, color: str = None):
        self._status_label.configure(text=msg, fg=color or C["text_secondary"])

    def _export_csv(self):
        if not self._rows:
            messagebox.showwarning("No Data", "No results to export.")
            return
        path = filedialog.asksaveasfilename(
            title="Export as CSV",
            defaultextension=".csv",
            initialfile=f"{self._title.replace(' ', '_')}.csv",
            filetypes=[("CSV Files", "*.csv"), ("All Files", "*.*")],
        )
        if not path:
            return
        try:
            exporter.export_csv(self._columns, self._rows, path)
            messagebox.showinfo("Exported", f"CSV saved to:\n{path}")
        except Exception as e:
            messagebox.showerror("Export Failed", str(e))

    def _export_pdf(self):
        if not self._rows:
            messagebox.showwarning("No Data", "No results to export.")
            return
        path = filedialog.asksaveasfilename(
            title="Export as PDF",
            defaultextension=".pdf",
            initialfile=f"{self._title.replace(' ', '_')}.pdf",
            filetypes=[("PDF Files", "*.pdf"), ("All Files", "*.*")],
        )
        if not path:
            return

        def do_export():
            try:
                exporter.export_pdf(
                    self._columns, self._rows, path,
                    title=self._title,
                    subtitle="AttendanceProcessor — School Admin Report"
                )
                self.after(0, lambda: messagebox.showinfo("Exported", f"PDF saved to:\n{path}"))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Export Failed", str(e)))

        threading.Thread(target=do_export, daemon=True).start()

    def clear(self):
        self._columns = []
        self._rows = []
        self._tree["columns"] = []
        self._tree.delete(*self._tree.get_children())
        self._title_label.configure(text="Results")
        self._count_label.configure(text="")
        self._empty_label.lift()
