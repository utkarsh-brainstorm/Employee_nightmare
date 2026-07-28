"""
gui/salary_panel.py  (v2 — CTk)
==================================
Salary editor: persistent name overrides + salary entry.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk, messagebox
from datetime import datetime
from typing import Dict, List

import customtkinter as ctk

import core.db as db
from gui.theme import C, FONTS
from gui.widgets import PrimaryButton, SecondaryButton, hdivider


class SalaryPanel(tk.Toplevel):

    def __init__(self, parent):
        super().__init__(parent)
        self.title("Employee Manager")
        self.configure(bg=C["bg"])
        self.minsize(800, 560)
        self.resizable(True, True)
        self._rows_data: List[Dict] = []
        self._build_ui()
        self._load()
        self.transient(parent)
        self.grab_set()

    def _build_ui(self):
        # ---- Title ----
        hdr = tk.Frame(self, bg=C["bg"])
        hdr.pack(fill="x", padx=24, pady=(20, 0))

        tk.Label(hdr, text="Employee Manager",
                 bg=C["bg"], fg=C["text"],
                 font=FONTS.h1).pack(side="left")

        PrimaryButton(hdr, "💾  Save Selected",
                      command=self._save_selected,
                      width=150).pack(side="right")

        tk.Label(self,
                 text="Set full names and monthly salaries. Names entered here will appear in all reports instead of the truncated file names.",
                 bg=C["bg"], fg=C["text_3"],
                 font=FONTS.label, wraplength=740, justify="left").pack(
            padx=24, pady=(6, 10), anchor="w")

        # ---- Working days global ----
        wd_row = tk.Frame(self, bg=C["bg_sidebar"],
                          highlightbackground=C["border_light"],
                          highlightthickness=1)
        wd_row.pack(fill="x", padx=24, pady=(0, 12))

        wd_inner = tk.Frame(wd_row, bg=C["bg_sidebar"])
        wd_inner.pack(fill="x", padx=16, pady=10)

        tk.Label(wd_inner, text="Default working days / month:",
                 bg=C["bg_sidebar"], fg=C["text_2"],
                 font=FONTS.body_sm).pack(side="left")

        self._wd_var = tk.StringVar(value=db.get_setting("working_days_per_month", "26"))
        ctk.CTkEntry(wd_inner, textvariable=self._wd_var, width=60, height=28,
                     corner_radius=5,
                     fg_color=C["bg_input"],
                     border_color=C["border"],
                     text_color=C["text"],
                     font=FONTS.body_sm).pack(side="left", padx=(8, 12))

        tk.Label(wd_inner, text="(affects daily rate for all employees unless overridden per-employee)",
                 bg=C["bg_sidebar"], fg=C["text_4"],
                 font=FONTS.caption).pack(side="left")

        SecondaryButton(wd_inner, "Save",
                        command=self._save_wd, width=70).pack(side="right")

        # ---- Table ----
        style = ttk.Style()
        style.configure("Emp.Treeview",
                        background=C["bg_card"],
                        fieldbackground=C["bg_card"],
                        foreground=C["text"],
                        font=FONTS.table,
                        rowheight=30)
        style.configure("Emp.Treeview.Heading",
                        background=C["bg_sidebar"],
                        foreground=C["text_2"],
                        font=FONTS.table_hd,
                        relief="flat")
        style.map("Emp.Treeview",
                  background=[("selected", C["bg_selected"])],
                  foreground=[("selected", C["accent"])])

        tbl_frame = tk.Frame(self, bg=C["bg_card"],
                             highlightbackground=C["border"],
                             highlightthickness=1)
        tbl_frame.pack(fill="both", expand=True, padx=24, pady=(0, 8))

        cols = ("emp_code", "emp_name", "full_name", "monthly_salary",
                "working_days", "daily_rate", "updated_at")
        hdrs = ("Code", "File Name (truncated)", "Full Name (editable)",
                "Monthly Salary (₹)", "Working Days", "Daily Rate (₹)", "Last Saved")
        widths = [60, 150, 180, 140, 110, 120, 160]

        self._tree = ttk.Treeview(tbl_frame, columns=cols,
                                  show="headings", selectmode="browse",
                                  style="Emp.Treeview")
        for col, hdr, w in zip(cols, hdrs, widths):
            self._tree.heading(col, text=hdr)
            self._tree.column(col, width=w, minwidth=50, anchor="center")

        vsb = ttk.Scrollbar(tbl_frame, orient="vertical", command=self._tree.yview)
        self._tree.configure(yscrollcommand=vsb.set)
        self._tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")

        self._tree.tag_configure("even", background=C["bg_card"])
        self._tree.tag_configure("odd",  background=C["bg_row_alt"])
        self._tree.bind("<<TreeviewSelect>>", self._on_select)

        # ---- Edit form ----
        edit_card = tk.Frame(self, bg=C["bg_card"],
                             highlightbackground=C["border_light"],
                             highlightthickness=1)
        edit_card.pack(fill="x", padx=24, pady=(0, 8))

        edit_inner = tk.Frame(edit_card, bg=C["bg_card"])
        edit_inner.pack(fill="x", padx=16, pady=12)

        tk.Label(edit_inner, text="Edit Selected Employee:",
                 bg=C["bg_card"], fg=C["text_2"],
                 font=FONTS.body_sm).grid(row=0, column=0, columnspan=8,
                                          sticky="w", pady=(0, 8))

        labels = ["Code", "File Name", "Full Name (override)", "Monthly Salary (₹)", "Working Days"]
        self._ev = {k: tk.StringVar() for k in
                    ["emp_code", "emp_name", "emp_name_override",
                     "monthly_salary", "working_days"]}
        keys = list(self._ev.keys())
        states = ["disabled", "disabled", "normal", "normal", "normal"]
        widths_e = [70, 130, 170, 130, 80]

        for i, (lbl, key, st, w) in enumerate(zip(labels, keys, states, widths_e)):
            col_off = i * 2
            tk.Label(edit_inner, text=lbl + ":",
                     bg=C["bg_card"], fg=C["text_3"],
                     font=FONTS.label, anchor="e").grid(
                row=1, column=col_off, padx=(0, 4), pady=2, sticky="e")
            e = ctk.CTkEntry(edit_inner, textvariable=self._ev[key],
                             width=w, height=28,
                             corner_radius=5,
                             fg_color=C["bg_input"] if st == "normal" else C["bg_sidebar"],
                             border_color=C["border"],
                             text_color=C["text"] if st == "normal" else C["text_3"],
                             font=FONTS.body_sm,
                             state=st)
            e.grid(row=1, column=col_off + 1, padx=(0, 12), pady=2)

        PrimaryButton(edit_inner, "Update",
                      command=self._update_selected,
                      width=90).grid(row=1, column=10, padx=(8, 0))

        # Footer note
        tk.Label(self,
                 text="✅  Salary and name data are saved permanently and will not be affected by importing new files.",
                 bg=C["bg"], fg=C["green"],
                 font=FONTS.caption).pack(padx=24, pady=(0, 16))

    def _load(self):
        self._rows_data = db.get_all_employees()
        self._tree.delete(*self._tree.get_children())

        for i, row in enumerate(self._rows_data):
            sal  = row.get("monthly_salary", 0) or 0
            wd   = row.get("working_days", 26) or 26
            dr   = round(sal / max(wd, 1), 2) if sal > 0 else ""
            upd  = row.get("updated_at", "") or "—"
            if upd and "T" in str(upd):
                upd = str(upd).split("T")[0]

            override = row.get("emp_name_override", "") or ""

            self._tree.insert("", "end",
                              iid=row["emp_code"],
                              values=(
                                  row["emp_code"],
                                  row["emp_name"],
                                  override or "—  (click to set)",
                                  f"₹ {sal:,.0f}" if sal else "—",
                                  wd,
                                  f"₹ {dr:,.2f}" if dr else "—",
                                  upd,
                              ),
                              tags=("even" if i % 2 == 0 else "odd",))

    def _on_select(self, event):
        sel = self._tree.selection()
        if not sel:
            return
        code = sel[0]
        for r in self._rows_data:
            if r["emp_code"] == code:
                self._ev["emp_code"].set(r["emp_code"])
                self._ev["emp_name"].set(r["emp_name"])
                self._ev["emp_name_override"].set(r.get("emp_name_override", "") or "")
                self._ev["monthly_salary"].set(str(r.get("monthly_salary", 0) or ""))
                self._ev["working_days"].set(str(r.get("working_days", 26) or 26))
                break

    def _update_selected(self):
        code = self._ev["emp_code"].get().strip()
        if not code:
            messagebox.showwarning("No Selection", "Please select an employee from the table.")
            return

        name         = self._ev["emp_name"].get().strip()
        override     = self._ev["emp_name_override"].get().strip()
        sal_str      = self._ev["monthly_salary"].get().strip()
        wd_str       = self._ev["working_days"].get().strip()

        salary = 0.0
        if sal_str:
            try:
                salary = float(sal_str.replace(",", "").replace("₹", "").strip())
            except ValueError:
                messagebox.showerror("Invalid", f"'{sal_str}' is not a valid salary number.")
                return

        wd = 26
        if wd_str:
            try:
                wd = int(wd_str)
                if wd <= 0: raise ValueError
            except ValueError:
                messagebox.showerror("Invalid", "Working days must be a positive number.")
                return

        db.upsert_salary(code, name, salary, wd, override)
        self._load()
        try: self._tree.selection_set(code)
        except Exception: pass

    def _save_selected(self):
        self._update_selected()

    def _save_wd(self):
        wd_str = self._wd_var.get().strip()
        try:
            wd = int(wd_str)
            if wd <= 0: raise ValueError
            db.set_setting("working_days_per_month", str(wd))
            messagebox.showinfo("Saved", "Default working days saved.")
        except ValueError:
            messagebox.showerror("Invalid", "Working days must be a positive integer.")
