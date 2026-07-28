"""
gui/salary_panel.py
===================
Salary editor panel — persistent per-employee salary management.
Opens as a Toplevel modal window.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk, messagebox
from typing import Dict, List, Optional

import core.db as db
from gui.theme import C, FONTS


class SalaryPanel(tk.Toplevel):
    """
    Modal window for editing employee salaries.
    Data is stored in employee_salary table and survives re-imports.
    """

    def __init__(self, parent):
        super().__init__(parent)
        self.title("Employee Salary Manager")
        self.configure(bg=C["bg"])
        self.minsize(720, 500)
        self.resizable(True, True)

        # Track editable cells
        self._edit_widgets: Dict[str, Dict[str, tk.Widget]] = {}
        self._rows_data: List[Dict] = []

        self._build_ui()
        self._load_data()

        self.transient(parent)
        self.grab_set()

    def _build_ui(self):
        # Header
        hdr = tk.Frame(self, bg=C["bg"])
        hdr.pack(fill="x", padx=24, pady=(20, 4))

        tk.Label(hdr, text="💰  Employee Salary Manager",
                 bg=C["bg"], fg=C["text_primary"],
                 font=FONTS["h2"]).pack(side="left")

        ttk.Button(hdr, text="💾  Save All",
                   style="Accent.TButton",
                   command=self._save_all).pack(side="right")

        tk.Label(self,
                 text="Enter monthly salary (₹) for each employee. "
                      "Leave blank if not applicable. Daily rate is auto-calculated (Salary ÷ Working Days).",
                 bg=C["bg"], fg=C["text_secondary"],
                 font=FONTS["body_sm"],
                 wraplength=680, justify="left").pack(padx=24, pady=(0, 12), anchor="w")

        # Working days global setting
        wd_frame = tk.Frame(self, bg=C["bg_secondary"],
                            highlightbackground=C["border_light"],
                            highlightthickness=1)
        wd_frame.pack(fill="x", padx=24, pady=(0, 12))

        inner = tk.Frame(wd_frame, bg=C["bg_secondary"])
        inner.pack(fill="x", padx=16, pady=10)

        tk.Label(inner, text="Default Working Days / Month:",
                 bg=C["bg_secondary"], fg=C["text_secondary"],
                 font=FONTS["body_sm"]).pack(side="left")

        self._working_days_var = tk.StringVar(
            value=db.get_setting("working_days_per_month", "26")
        )
        ttk.Entry(inner, textvariable=self._working_days_var,
                  width=6, font=FONTS["body"]).pack(side="left", padx=8)

        tk.Label(inner,
                 text="(Used for salary prorating. Can be overridden per employee.)",
                 bg=C["bg_secondary"], fg=C["text_tertiary"],
                 font=FONTS["caption"]).pack(side="left")

        # Treeview table
        tree_frame = tk.Frame(self, bg=C["bg"])
        tree_frame.pack(fill="both", expand=True, padx=24, pady=(0, 8))

        cols = ("emp_code", "emp_name", "monthly_salary", "working_days", "daily_rate", "updated_at")
        hdrs = ("Emp Code", "Name", "Monthly Salary (₹)", "Working Days", "Daily Rate (₹)", "Last Updated")

        self._tree = ttk.Treeview(tree_frame, columns=cols,
                                  show="headings", selectmode="browse",
                                  style="Treeview")
        col_widths = [80, 160, 150, 110, 120, 160]
        for col, hdr, w in zip(cols, hdrs, col_widths):
            self._tree.heading(col, text=hdr)
            self._tree.column(col, width=w, minwidth=60, anchor="center")

        vsb = ttk.Scrollbar(tree_frame, orient="vertical",
                            command=self._tree.yview)
        self._tree.configure(yscrollcommand=vsb.set)

        self._tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")

        # Edit frame (appears below table on row click)
        self._edit_frame = tk.Frame(self, bg=C["bg_secondary"],
                                    highlightbackground=C["border_light"],
                                    highlightthickness=1)
        self._edit_frame.pack(fill="x", padx=24, pady=(0, 8))

        ef_inner = tk.Frame(self._edit_frame, bg=C["bg_secondary"])
        ef_inner.pack(fill="x", padx=16, pady=12)

        tk.Label(ef_inner, text="Edit Selected Employee:",
                 bg=C["bg_secondary"], fg=C["text_secondary"],
                 font=FONTS["body_sm"]).grid(row=0, column=0, columnspan=4, sticky="w", pady=(0, 8))

        labels = ["Employee Code:", "Name:", "Monthly Salary (₹):", "Working Days:"]
        self._edit_vars = {
            "emp_code":       tk.StringVar(),
            "emp_name":       tk.StringVar(),
            "monthly_salary": tk.StringVar(),
            "working_days":   tk.StringVar(),
        }
        keys = list(self._edit_vars.keys())
        for i, (lbl, key) in enumerate(zip(labels, keys)):
            col_offset = (i % 2) * 2
            row = i // 2 + 1
            tk.Label(ef_inner, text=lbl,
                     bg=C["bg_secondary"], fg=C["text_secondary"],
                     font=FONTS["body_sm"]).grid(row=row, column=col_offset,
                                                  padx=(0, 6), pady=4, sticky="e")
            state = "disabled" if key in ("emp_code",) else "normal"
            entry = ttk.Entry(ef_inner, textvariable=self._edit_vars[key],
                              width=18, font=FONTS["body"],
                              state=state)
            entry.grid(row=row, column=col_offset + 1, padx=(0, 16), pady=4)

        ttk.Button(ef_inner, text="Update Row",
                   style="Accent.TButton",
                   command=self._update_selected).grid(row=3, column=0, pady=(8, 0))

        # Bind tree selection
        self._tree.bind("<<TreeviewSelect>>", self._on_select)

        # Bottom info
        tk.Label(self,
                 text="✅ Salary data is stored permanently and will not be lost when you import new files.",
                 bg=C["bg"], fg=C["success"],
                 font=FONTS["caption"]).pack(padx=24, pady=(0, 16))

    def _load_data(self):
        self._rows_data = db.get_all_employees()
        self._tree.delete(*self._tree.get_children())

        default_wd = self._working_days_var.get().strip() or "26"

        for row in self._rows_data:
            salary = row.get("monthly_salary", 0) or 0
            wd = row.get("working_days") or int(default_wd)
            daily = round(salary / max(wd, 1), 2) if salary > 0 else ""
            updated = row.get("updated_at", "") or "Never"
            if updated and updated != "Never" and "T" in str(updated):
                updated = str(updated).split("T")[0]

            self._tree.insert("", "end",
                              iid=row["emp_code"],
                              values=(
                                  row["emp_code"],
                                  row["emp_name"],
                                  f"₹ {salary:,.2f}" if salary else "Not set",
                                  wd,
                                  f"₹ {daily:,.2f}" if daily else "N/A",
                                  updated,
                              ))

    def _on_select(self, event):
        sel = self._tree.selection()
        if not sel:
            return
        iid = sel[0]
        for row in self._rows_data:
            if row["emp_code"] == iid:
                self._edit_vars["emp_code"].set(row["emp_code"])
                self._edit_vars["emp_name"].set(row["emp_name"])
                salary = row.get("monthly_salary", 0) or 0
                self._edit_vars["monthly_salary"].set(str(salary) if salary else "")
                wd = row.get("working_days") or self._working_days_var.get() or "26"
                self._edit_vars["working_days"].set(str(wd))
                break

    def _update_selected(self):
        code = self._edit_vars["emp_code"].get().strip()
        name = self._edit_vars["emp_name"].get().strip()
        salary_str = self._edit_vars["monthly_salary"].get().strip()
        wd_str = self._edit_vars["working_days"].get().strip()

        if not code:
            messagebox.showwarning("No Selection", "Please select an employee first.")
            return

        salary = 0.0
        if salary_str:
            try:
                salary = float(salary_str.replace(",", "").replace("₹", "").strip())
            except ValueError:
                messagebox.showerror("Invalid Input",
                                     f"'{salary_str}' is not a valid salary number.")
                return

        wd = 26
        if wd_str:
            try:
                wd = int(wd_str)
                if wd <= 0:
                    raise ValueError
            except ValueError:
                messagebox.showerror("Invalid Input", "Working days must be a positive number.")
                return

        db.upsert_salary(code, name, salary, wd)
        self._load_data()
        # Re-select
        try:
            self._tree.selection_set(code)
        except Exception:
            pass

    def _save_all(self):
        """Save default working days setting and refresh."""
        wd_str = self._working_days_var.get().strip()
        try:
            wd = int(wd_str)
            if wd <= 0:
                raise ValueError
            db.set_setting("working_days_per_month", str(wd))
        except ValueError:
            messagebox.showerror("Invalid Input",
                                 "Working days must be a positive integer.")
            return

        # Trigger update for currently selected if salary is filled
        sel = self._tree.selection()
        if sel:
            self._update_selected()
        else:
            messagebox.showinfo("Saved",
                                "Default working days saved.\nSelect an employee to update their salary.")
        self._load_data()
