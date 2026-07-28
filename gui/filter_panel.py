"""
gui/filter_panel.py  (v2 — CTk)
================================
Human-readable filter builder. No SQL terminology visible to the user.
Fields presented as plain English with friendly operator labels.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from typing import Callable, List, Optional
from datetime import date, timedelta

import customtkinter as ctk

from core.query_builder import (
    FilterRow, QuerySpec, build_sql, format_sql_readable,
    FIELD_MAP, FIELD_CATEGORIES, get_operators_for_field, get_value_options_for_field
)
from gui.theme import C, FONTS
from gui.widgets import PrimaryButton, SecondaryButton, GhostButton, hdivider


# Human-friendly field labels
FRIENDLY_FIELDS = {
    "Employee Name":  "Employee Name",
    "Employee Code":  "Employee ID",
    "Date":           "Date",
    "Status":         "Attendance Status",
    "Punch In Time":  "Arrival Time",
    "Punch Out Time": "Departure Time",
    "Hours Worked":   "Hours Worked",
    "Late Arrival":   "Arrived Late?",
    "Early Leave":    "Left Early?",
}

# Human-friendly operator labels
FRIENDLY_OPS = {
    "contains":      "contains",
    "equals":        "is exactly",
    "starts with":   "starts with",
    "ends with":     "ends with",
    "not equals":    "is not",
    "on":            "on",
    "before":        "before",
    "after":         "after",
    "on or before":  "on or before",
    "on or after":   "on or after",
    "between":       "between",
    "greater than":  "more than",
    "less than":     "less than",
    "greater or equal": "at least",
    "less or equal": "at most",
    "is":            "is",
    "is not":        "is not",
}

STATUS_FRIENDLY = {
    "PRESENT":    "Present",
    "ABSENT":     "Absent",
    "WEEKLY_OFF": "Weekly Off",
    "HALF_DAY":   "Half Day",
}


class FilterRowWidget(tk.Frame):
    """One human-readable filter condition row."""

    def __init__(self, parent, row_index: int,
                 on_remove: Callable, on_change: Callable,
                 show_joiner: bool = True, **kwargs):
        super().__init__(parent, bg=C["bg_card"], **kwargs)
        self._row_index = row_index
        self._on_remove = on_remove
        self._on_change = on_change
        self._show_joiner = show_joiner
        self._build()

    def _build(self):
        self.configure(
            highlightbackground=C["border_light"],
            highlightthickness=1,
        )

        row = tk.Frame(self, bg=C["bg_card"])
        row.pack(fill="x", padx=10, pady=8)

        # Joiner pill (AND/OR)
        self._joiner_var = tk.StringVar(value="AND")
        if self._show_joiner:
            join_frame = tk.Frame(row, bg=C["bg_sidebar"],
                                  highlightbackground=C["border"],
                                  highlightthickness=1)
            join_frame.pack(side="left", padx=(0, 8))
            for j in ("AND", "OR"):
                bg_fn = lambda j=j: C["accent"] if self._joiner_var.get() == j else C["bg_sidebar"]
                fg_fn = lambda j=j: C["text_inv"] if self._joiner_var.get() == j else C["text_2"]
                rb = tk.Label(join_frame, text=j,
                              bg=C["bg_sidebar"], fg=C["text_2"],
                              font=FONTS.caption,
                              padx=8, pady=4,
                              cursor="hand2")
                rb.pack(side="left")
                rb.bind("<Button-1>", lambda e, jj=j, lbl=rb: self._set_joiner(jj))

            self._joiner_labels = {j: join_frame.winfo_children()[i]
                                   for i, j in enumerate(["AND", "OR"])}
            self._update_joiner_ui()
        else:
            # Placeholder so layout aligns
            tk.Label(row, text="WHERE", bg=C["bg_card"],
                     fg=C["text_3"], font=FONTS.caption).pack(side="left", padx=(0, 8))

        # Field dropdown
        fields = list(FRIENDLY_FIELDS.keys())
        self._field_var = tk.StringVar(value=fields[0])

        field_cb = ctk.CTkComboBox(
            row,
            variable=self._field_var,
            values=fields,
            state="readonly",
            width=160,
            height=30,
            corner_radius=6,
            fg_color=C["bg_input"],
            border_color=C["border"],
            text_color=C["text"],
            font=FONTS.body_sm,
            dropdown_fg_color=C["bg_card"],
            dropdown_text_color=C["text"],
            command=lambda v: self._on_field_change(),
        )
        field_cb.pack(side="left", padx=(0, 8))

        # Operator dropdown
        self._op_var = tk.StringVar()
        self._op_cb = ctk.CTkComboBox(
            row,
            variable=self._op_var,
            values=[],
            state="readonly",
            width=130,
            height=30,
            corner_radius=6,
            fg_color=C["bg_input"],
            border_color=C["border"],
            text_color=C["text"],
            font=FONTS.body_sm,
            dropdown_fg_color=C["bg_card"],
            dropdown_text_color=C["text"],
            command=lambda v: (self._on_change(), self._update_value_widget()),
        )
        self._op_cb.pack(side="left", padx=(0, 8))

        # Value container
        self._value_container = tk.Frame(row, bg=C["bg_card"])
        self._value_container.pack(side="left", padx=(0, 8))

        self._value_var  = tk.StringVar()
        self._value2_var = tk.StringVar()

        # Remove button
        rm = tk.Label(row, text="✕",
                      bg=C["bg_card"], fg=C["text_3"],
                      font=FONTS.body,
                      cursor="hand2",
                      padx=4)
        rm.pack(side="left")
        rm.bind("<Button-1>", lambda e: self._on_remove())
        rm.bind("<Enter>", lambda e: rm.configure(fg=C["red"]))
        rm.bind("<Leave>", lambda e: rm.configure(fg=C["text_3"]))

        self._update_operators()

    def _set_joiner(self, j: str):
        self._joiner_var.set(j)
        self._update_joiner_ui()
        self._on_change()

    def _update_joiner_ui(self):
        if not self._show_joiner:
            return
        try:
            for jj, lbl in self._joiner_labels.items():
                if jj == self._joiner_var.get():
                    lbl.configure(bg=C["accent"], fg=C["text_inv"])
                else:
                    lbl.configure(bg=C["bg_sidebar"], fg=C["text_2"])
        except Exception:
            pass

    def _on_field_change(self):
        self._update_operators()
        self._update_value_widget()
        self._on_change()

    def _update_operators(self):
        field = self._field_var.get()
        raw_ops = get_operators_for_field(field)
        friendly = [FRIENDLY_OPS.get(op, op) for op in raw_ops]
        self._raw_ops = raw_ops
        self._op_cb.configure(values=friendly)
        if friendly:
            self._op_cb.set(friendly[0])
            self._op_var.set(friendly[0])
        self._update_value_widget()

    def _get_raw_op(self) -> str:
        """Convert friendly operator label back to internal key."""
        friendly = self._op_var.get()
        for raw, fr in FRIENDLY_OPS.items():
            if fr == friendly:
                return raw
        return friendly

    def _update_value_widget(self):
        for w in self._value_container.winfo_children():
            w.destroy()

        field = self._field_var.get()
        op    = self._get_raw_op()
        opts  = get_value_options_for_field(field)
        cat   = FIELD_CATEGORIES.get(field, "text")

        def mk_entry(width=120, placeholder="", var=None):
            v = var or self._value_var
            e = ctk.CTkEntry(
                self._value_container,
                textvariable=v,
                width=width, height=30,
                corner_radius=6,
                fg_color=C["bg_input"],
                border_color=C["border"],
                text_color=C["text"],
                placeholder_text=placeholder,
                placeholder_text_color=C["text_4"],
                font=FONTS.body_sm,
            )
            return e

        if opts:
            # Convert internal status codes to friendly
            friendly_opts = [STATUS_FRIENDLY.get(o, o) for o in opts]
            if not self._value_var.get() or self._value_var.get() not in friendly_opts:
                self._value_var.set(friendly_opts[0])
            cb = ctk.CTkComboBox(
                self._value_container,
                variable=self._value_var,
                values=friendly_opts,
                state="readonly",
                width=130, height=30,
                corner_radius=6,
                fg_color=C["bg_input"],
                border_color=C["border"],
                text_color=C["text"],
                font=FONTS.body_sm,
                dropdown_fg_color=C["bg_card"],
                dropdown_text_color=C["text"],
            )
            cb.pack(side="left")

        elif cat == "date":
            if not self._value_var.get():
                self._value_var.set(str(date.today()))
            e1 = mk_entry(110, "YYYY-MM-DD")
            e1.pack(side="left")
            if op == "between":
                if not self._value2_var.get():
                    self._value2_var.set(str(date.today()))
                tk.Label(self._value_container, text=" to ",
                         bg=C["bg_card"], fg=C["text_3"],
                         font=FONTS.label).pack(side="left", padx=4)
                mk_entry(110, "YYYY-MM-DD", self._value2_var).pack(side="left")

        elif cat == "time":
            if not self._value_var.get():
                self._value_var.set("09:00")
            mk_entry(80, "HH:MM").pack(side="left")

        elif cat == "number":
            if not self._value_var.get():
                self._value_var.set("6")
            mk_entry(70, "hours").pack(side="left")

        else:
            mk_entry(150, "Type to search…").pack(side="left")

    def get_filter_row(self) -> FilterRow:
        # Convert friendly status back to internal
        val = self._value_var.get()
        # Reverse STATUS_FRIENDLY
        rev = {v: k for k, v in STATUS_FRIENDLY.items()}
        val = rev.get(val, val)

        return FilterRow(
            field=self._field_var.get(),
            operator=self._get_raw_op(),
            value=val,
            value2=self._value2_var.get(),
            joiner=self._joiner_var.get(),
        )


class FilterPanel(tk.Frame):
    """
    Left panel: visual filter builder.
    No SQL shown here — SQL only in the SQL panel below.
    """

    def __init__(self, parent,
                 on_run: Callable[[str, tuple], None],
                 on_sql_generated: Callable[[str], None],
                 **kwargs):
        super().__init__(parent, bg=C["bg"], **kwargs)
        self._on_run = on_run
        self._on_sql_generated = on_sql_generated
        self._filter_widgets: List[FilterRowWidget] = []
        self._build_ui()

    def _build_ui(self):
        # ---- Header ----
        hdr = tk.Frame(self, bg=C["bg"])
        hdr.pack(fill="x", padx=18, pady=(14, 8))

        tk.Label(hdr, text="Search & Filter",
                 bg=C["bg"], fg=C["text"],
                 font=FONTS.h2).pack(side="left")

        GhostButton(hdr, "＋  Add Condition",
                    command=self._add_filter,
                    width=140).pack(side="right")

        # ---- Scrollable filter rows ----
        scroll_outer = tk.Frame(self, bg=C["bg"])
        scroll_outer.pack(fill="both", expand=True, padx=18)

        self._canvas = tk.Canvas(scroll_outer, bg=C["bg"],
                                 highlightthickness=0)
        self._canvas.pack(side="left", fill="both", expand=True)

        vsb = ttk.Scrollbar(scroll_outer, orient="vertical",
                            command=self._canvas.yview)
        vsb.pack(side="right", fill="y")
        self._canvas.configure(yscrollcommand=vsb.set)

        self._rows_frame = tk.Frame(self._canvas, bg=C["bg"])
        self._win = self._canvas.create_window(
            (0, 0), window=self._rows_frame, anchor="nw")
        self._rows_frame.bind("<Configure>",
                              lambda e: self._canvas.configure(
                                  scrollregion=self._canvas.bbox("all")))
        self._canvas.bind("<Configure>",
                          lambda e: self._canvas.itemconfig(self._win, width=e.width))

        # Mousewheel scroll
        self._canvas.bind_all("<MouseWheel>",
                              lambda e: self._canvas.yview_scroll(-1 * (e.delta // 120), "units"))

        # ---- Controls row ----
        ctrl = tk.Frame(self, bg=C["bg"])
        ctrl.pack(fill="x", padx=18, pady=(8, 4))

        tk.Label(ctrl, text="Sort by:", bg=C["bg"],
                 fg=C["text_3"], font=FONTS.label).pack(side="left")

        sort_labels = {
            "Date":           "work_date",
            "Employee Name":  "emp_name",
            "Employee ID":    "emp_code",
            "Arrival Time":   "punch_in",
            "Departure Time": "punch_out",
            "Hours Worked":   "work_hours",
        }
        self._sort_display = list(sort_labels.keys())
        self._sort_internal = list(sort_labels.values())
        self._sort_var = tk.StringVar(value=self._sort_display[0])

        ctk.CTkComboBox(ctrl, variable=self._sort_var,
                        values=self._sort_display,
                        state="readonly", width=140, height=28,
                        corner_radius=6,
                        fg_color=C["bg_input"],
                        border_color=C["border"],
                        text_color=C["text"],
                        font=FONTS.label,
                        dropdown_fg_color=C["bg_card"],
                        dropdown_text_color=C["text"],
                        ).pack(side="left", padx=(6, 8))

        self._sort_dir_var = tk.StringVar(value="Oldest first")
        ctk.CTkComboBox(ctrl, variable=self._sort_dir_var,
                        values=["Oldest first", "Newest first"],
                        state="readonly", width=120, height=28,
                        corner_radius=6,
                        fg_color=C["bg_input"],
                        border_color=C["border"],
                        text_color=C["text"],
                        font=FONTS.label,
                        dropdown_fg_color=C["bg_card"],
                        dropdown_text_color=C["text"],
                        ).pack(side="left", padx=(0, 16))

        tk.Label(ctrl, text="Max results:", bg=C["bg"],
                 fg=C["text_3"], font=FONTS.label).pack(side="left")
        self._limit_var = tk.StringVar(value="5000")
        ctk.CTkEntry(ctrl, textvariable=self._limit_var,
                     width=70, height=28,
                     corner_radius=6,
                     fg_color=C["bg_input"],
                     border_color=C["border"],
                     text_color=C["text"],
                     font=FONTS.label).pack(side="left", padx=(6, 0))

        # ---- Action row ----
        act = tk.Frame(self, bg=C["bg"])
        act.pack(fill="x", padx=18, pady=(6, 14))

        PrimaryButton(act, "▶   Search",
                      command=self._run,
                      width=130).pack(side="left", padx=(0, 8))
        SecondaryButton(act, "Reset",
                        command=self._clear_all,
                        width=80).pack(side="left")

        # Add first filter row
        self._add_filter()

    def _add_filter(self):
        idx = len(self._filter_widgets)
        w = FilterRowWidget(
            self._rows_frame,
            row_index=idx,
            on_remove=lambda i=idx: self._remove_filter(i),
            on_change=self._on_filter_change,
            show_joiner=(idx > 0),
        )
        w.pack(fill="x", pady=(0, 4))
        self._filter_widgets.append(w)

    def _remove_filter(self, idx: int):
        to_rm = next((w for w in self._filter_widgets if w._row_index == idx), None)
        if to_rm:
            to_rm.destroy()
            self._filter_widgets.remove(to_rm)
            for i, w in enumerate(self._filter_widgets):
                w._row_index = i

    def _clear_all(self):
        for w in self._filter_widgets:
            w.destroy()
        self._filter_widgets.clear()
        self._add_filter()

    def _on_filter_change(self):
        try:
            sql, _ = self._build_spec()
            self._on_sql_generated(format_sql_readable(sql))
        except Exception:
            pass

    def _build_spec(self):
        filters = [w.get_filter_row() for w in self._filter_widgets]
        sort_idx = self._sort_display.index(self._sort_var.get()) \
            if self._sort_var.get() in self._sort_display else 0
        sort_col = self._sort_internal[sort_idx]
        sort_dir = "DESC" if "Newest" in self._sort_dir_var.get() else "ASC"
        limit_s  = self._limit_var.get().strip()
        limit    = int(limit_s) if limit_s.isdigit() else 5000
        spec = QuerySpec(filters=filters, order_by=sort_col,
                         order_dir=sort_dir, limit=limit)
        return build_sql(spec)

    def _run(self):
        try:
            sql, params = self._build_spec()
            self._on_sql_generated(format_sql_readable(sql))
            self._on_run(sql, params)
        except Exception as e:
            from tkinter import messagebox
            messagebox.showerror("Filter Error", str(e))
