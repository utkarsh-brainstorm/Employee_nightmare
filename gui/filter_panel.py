"""
gui/filter_panel.py
===================
Dynamic filter builder: users add filter rows, choose field/operator/value,
chain with AND/OR, then click Run to execute.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from typing import Callable, List, Optional
from datetime import date

from core.query_builder import (
    FilterRow, QuerySpec, build_sql, format_sql_readable,
    FIELD_MAP, FIELD_CATEGORIES, get_operators_for_field, get_value_options_for_field
)
from gui.theme import C, FONTS


class FilterRowWidget(tk.Frame):
    """One row in the filter builder."""

    def __init__(self, parent, row_index: int, on_remove: Callable,
                 on_change: Callable, show_joiner: bool = True, **kwargs):
        super().__init__(parent, bg=C["bg"], **kwargs)
        self._row_index = row_index
        self._on_remove = on_remove
        self._on_change = on_change
        self._show_joiner = show_joiner
        self._build()

    def _build(self):
        # Joiner (AND/OR) - shown between rows
        self._joiner_var = tk.StringVar(value="AND")
        if self._show_joiner:
            joiner_frame = tk.Frame(self, bg=C["bg_secondary"], padx=4, pady=2)
            joiner_frame.pack(side="left", padx=(0, 6))
            for j in ("AND", "OR"):
                rb = ttk.Radiobutton(joiner_frame, text=j, value=j,
                                     variable=self._joiner_var,
                                     style="TRadiobutton",
                                     command=self._on_change)
                rb.pack(side="left", padx=2)

        fields = list(FIELD_MAP.keys())

        # Field selector
        self._field_var = tk.StringVar(value=fields[0])
        field_cb = ttk.Combobox(self, textvariable=self._field_var,
                                values=fields, state="readonly", width=16,
                                font=FONTS["body_sm"])
        field_cb.pack(side="left", padx=(0, 4))
        field_cb.bind("<<ComboboxSelected>>", self._on_field_change)

        # Operator selector
        self._op_var = tk.StringVar()
        self._op_cb = ttk.Combobox(self, textvariable=self._op_var,
                                   state="readonly", width=14,
                                   font=FONTS["body_sm"])
        self._op_cb.pack(side="left", padx=(0, 4))
        self._op_cb.bind("<<ComboboxSelected>>", lambda e: (self._on_change(), self._update_value_widget()))

        # Value widget container
        self._value_container = tk.Frame(self, bg=C["bg"])
        self._value_container.pack(side="left", padx=(0, 4))

        self._value_var = tk.StringVar()
        self._value2_var = tk.StringVar()
        self._value_widget = None
        self._value2_label = None
        self._value2_widget = None

        # Remove button
        rm_btn = tk.Button(self, text="✕",
                           bg=C["bg"], fg=C["text_secondary"],
                           font=FONTS["body_sm"],
                           relief="flat", bd=0, cursor="hand2",
                           command=self._on_remove)
        rm_btn.pack(side="left", padx=(4, 0))

        # Initial populate
        self._update_operators()

    def _on_field_change(self, event=None):
        self._update_operators()
        self._update_value_widget()
        self._on_change()

    def _update_operators(self):
        field = self._field_var.get()
        ops = get_operators_for_field(field)
        self._op_cb["values"] = ops
        if ops:
            self._op_var.set(ops[0])
        self._update_value_widget()

    def _update_value_widget(self):
        # Clear container
        for w in self._value_container.winfo_children():
            w.destroy()
        self._value2_label = None
        self._value2_widget = None

        field = self._field_var.get()
        op = self._op_var.get()
        opts = get_value_options_for_field(field)
        cat = FIELD_CATEGORIES.get(field, "text")

        if opts:
            # Dropdown
            if not self._value_var.get() or self._value_var.get() not in opts:
                self._value_var.set(opts[0])
            w = ttk.Combobox(self._value_container, textvariable=self._value_var,
                             values=opts, state="readonly", width=14,
                             font=FONTS["body_sm"])
            w.pack(side="left")
        elif cat == "date":
            # Date entry YYYY-MM-DD
            w = ttk.Entry(self._value_container, textvariable=self._value_var,
                          width=12, font=FONTS["body_sm"])
            w.pack(side="left")
            w.insert(0, str(date.today()))
            if op == "between":
                tk.Label(self._value_container, text=" to ",
                         bg=C["bg"], fg=C["text_secondary"],
                         font=FONTS["body_sm"]).pack(side="left")
                w2 = ttk.Entry(self._value_container, textvariable=self._value2_var,
                               width=12, font=FONTS["body_sm"])
                w2.pack(side="left")
                w2.insert(0, str(date.today()))
        elif cat == "time":
            # Time entry HH:MM
            if not self._value_var.get():
                self._value_var.set("09:00")
            w = ttk.Entry(self._value_container, textvariable=self._value_var,
                          width=8, font=FONTS["body_sm"])
            w.pack(side="left")
        elif cat == "number":
            if not self._value_var.get():
                self._value_var.set("6")
            w = ttk.Entry(self._value_container, textvariable=self._value_var,
                          width=8, font=FONTS["body_sm"])
            w.pack(side="left")
        else:
            # Free text
            w = ttk.Entry(self._value_container, textvariable=self._value_var,
                          width=18, font=FONTS["body_sm"])
            w.pack(side="left")

        self._value_widget = w

    def get_filter_row(self) -> FilterRow:
        return FilterRow(
            field=self._field_var.get(),
            operator=self._op_var.get(),
            value=self._value_var.get(),
            value2=self._value2_var.get(),
            joiner=self._joiner_var.get(),
        )


class FilterPanel(tk.Frame):
    """
    Left panel: filter builder.
    Calls `on_run(sql, params)` when user clicks Run.
    Also provides `set_sql_callback` to push generated SQL to the SQL panel.
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
        # Header
        hdr_frame = tk.Frame(self, bg=C["bg"])
        hdr_frame.pack(fill="x", padx=16, pady=(14, 6))

        tk.Label(hdr_frame, text="Filter Builder",
                 bg=C["bg"], fg=C["text_primary"],
                 font=FONTS["h3"]).pack(side="left")

        ttk.Button(hdr_frame, text="＋ Add Filter",
                   command=self._add_filter,
                   style="Ghost.TButton").pack(side="right")

        # Scrollable filter rows container
        self._scroll_canvas = tk.Canvas(self, bg=C["bg"],
                                        highlightthickness=0,
                                        height=220)
        self._scroll_canvas.pack(fill="both", expand=True, padx=16)

        vsb = ttk.Scrollbar(self, orient="vertical",
                            command=self._scroll_canvas.yview)
        vsb.pack(side="right", fill="y")
        self._scroll_canvas.configure(yscrollcommand=vsb.set)

        self._rows_frame = tk.Frame(self._scroll_canvas, bg=C["bg"])
        self._canvas_window = self._scroll_canvas.create_window(
            (0, 0), window=self._rows_frame, anchor="nw"
        )
        self._rows_frame.bind("<Configure>", self._on_rows_configure)
        self._scroll_canvas.bind("<Configure>", self._on_canvas_configure)

        # Controls row
        ctrl = tk.Frame(self, bg=C["bg"])
        ctrl.pack(fill="x", padx=16, pady=(8, 4))

        # Sort / Limit
        tk.Label(ctrl, text="Sort by:", bg=C["bg"],
                 fg=C["text_secondary"], font=FONTS["body_sm"]).pack(side="left")

        self._sort_var = tk.StringVar(value="work_date")
        sort_fields = ["work_date", "emp_name", "emp_code", "punch_in", "punch_out", "work_hours"]
        sort_cb = ttk.Combobox(ctrl, textvariable=self._sort_var,
                               values=sort_fields, state="readonly", width=12,
                               font=FONTS["body_sm"])
        sort_cb.pack(side="left", padx=(4, 8))

        self._sort_dir_var = tk.StringVar(value="ASC")
        ttk.Combobox(ctrl, textvariable=self._sort_dir_var,
                     values=["ASC", "DESC"], state="readonly", width=6,
                     font=FONTS["body_sm"]).pack(side="left", padx=(0, 12))

        tk.Label(ctrl, text="Max rows:", bg=C["bg"],
                 fg=C["text_secondary"], font=FONTS["body_sm"]).pack(side="left")
        self._limit_var = tk.StringVar(value="5000")
        ttk.Entry(ctrl, textvariable=self._limit_var, width=7,
                  font=FONTS["body_sm"]).pack(side="left", padx=(4, 0))

        # Run button + Clear button
        btn_row = tk.Frame(self, bg=C["bg"])
        btn_row.pack(fill="x", padx=16, pady=(4, 12))

        ttk.Button(btn_row, text="▶  Run Query",
                   command=self._run,
                   style="Accent.TButton").pack(side="left", padx=(0, 8))

        ttk.Button(btn_row, text="Clear All",
                   command=self._clear_all,
                   style="TButton").pack(side="left")

        # Add a default first filter
        self._add_filter()

    def _on_rows_configure(self, event):
        self._scroll_canvas.configure(
            scrollregion=self._scroll_canvas.bbox("all")
        )

    def _on_canvas_configure(self, event):
        self._scroll_canvas.itemconfig(
            self._canvas_window, width=event.width
        )

    def _add_filter(self):
        idx = len(self._filter_widgets)
        show_joiner = idx > 0

        row_w = FilterRowWidget(
            self._rows_frame,
            row_index=idx,
            on_remove=lambda i=idx: self._remove_filter(i),
            on_change=self._on_filter_change,
            show_joiner=show_joiner,
        )
        row_w.pack(fill="x", pady=3)
        self._filter_widgets.append(row_w)

    def _remove_filter(self, idx: int):
        # Find and destroy widget by its row_index match
        to_remove = None
        for w in self._filter_widgets:
            if w._row_index == idx:
                to_remove = w
                break
        if to_remove:
            to_remove.destroy()
            self._filter_widgets.remove(to_remove)
            # Re-index
            for i, w in enumerate(self._filter_widgets):
                w._row_index = i

    def _clear_all(self):
        for w in self._filter_widgets:
            w.destroy()
        self._filter_widgets.clear()
        self._add_filter()

    def _on_filter_change(self):
        """Auto-update the SQL preview."""
        try:
            filters = [w.get_filter_row() for w in self._filter_widgets]
            spec = QuerySpec(
                filters=filters,
                order_by=self._sort_var.get(),
                order_dir=self._sort_dir_var.get(),
                limit=int(self._limit_var.get() or 5000),
            )
            sql, _ = build_sql(spec)
            self._on_sql_generated(format_sql_readable(sql))
        except Exception:
            pass

    def _run(self):
        try:
            filters = [w.get_filter_row() for w in self._filter_widgets]
            limit_str = self._limit_var.get().strip()
            limit = int(limit_str) if limit_str.isdigit() else 5000

            spec = QuerySpec(
                filters=filters,
                order_by=self._sort_var.get(),
                order_dir=self._sort_dir_var.get(),
                limit=limit,
            )
            sql, params = build_sql(spec)
            readable = format_sql_readable(sql)
            self._on_sql_generated(readable)
            self._on_run(sql, params)
        except Exception as e:
            from tkinter import messagebox
            messagebox.showerror("Filter Error", str(e))

    def get_current_sql(self) -> tuple:
        """Returns (sql, params) for the current filters."""
        filters = [w.get_filter_row() for w in self._filter_widgets]
        limit_str = self._limit_var.get().strip()
        limit = int(limit_str) if limit_str.isdigit() else 5000
        spec = QuerySpec(
            filters=filters,
            order_by=self._sort_var.get(),
            order_dir=self._sort_dir_var.get(),
            limit=limit,
        )
        return build_sql(spec)
