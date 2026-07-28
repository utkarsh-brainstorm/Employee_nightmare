"""
gui/settings_panel.py
=====================
Global settings panel (modal): check-in time, check-out time, late threshold,
working days. All saved to DB and used on every import and report.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import messagebox

import customtkinter as ctk

import core.db as db
from gui.theme import C, FONTS
from gui.widgets import Card, PrimaryButton, SecondaryButton, hdivider


class SettingsPanel(tk.Toplevel):
    """Modal settings window."""

    def __init__(self, parent):
        super().__init__(parent)
        self.title("Settings")
        self.configure(bg=C["bg"])
        self.resizable(False, False)
        self.minsize(460, 0)
        self._build_ui()
        self._load()
        self.transient(parent)
        self.grab_set()

    def _build_ui(self):
        # Title
        tk.Label(self, text="Application Settings",
                 bg=C["bg"], fg=C["text"],
                 font=FONTS.h2).pack(padx=28, pady=(24, 4), anchor="w")
        tk.Label(self,
                 text="These values are saved and applied to every import and report.",
                 bg=C["bg"], fg=C["text_3"],
                 font=FONTS.label).pack(padx=28, anchor="w")

        hdivider(self, C["divider"]).pack(fill="x", padx=28, pady=(12, 16))

        form = tk.Frame(self, bg=C["bg"])
        form.pack(padx=28, fill="x")

        def row(label: str, hint: str, row_idx: int):
            tk.Label(form, text=label, bg=C["bg"], fg=C["text"],
                     font=FONTS.body_sm, anchor="w", width=26).grid(
                row=row_idx, column=0, sticky="w", pady=8)
            var = tk.StringVar()
            entry = ctk.CTkEntry(form, textvariable=var, width=120, height=32,
                                 corner_radius=7,
                                 fg_color=C["bg_input"],
                                 border_color=C["border"],
                                 border_width=1,
                                 text_color=C["text"],
                                 font=FONTS.body_sm)
            entry.grid(row=row_idx, column=1, sticky="w", padx=(0, 10))
            tk.Label(form, text=hint, bg=C["bg"], fg=C["text_3"],
                     font=FONTS.caption, anchor="w").grid(
                row=row_idx, column=2, sticky="w")
            return var

        self._checkin_var  = row("Check-in time (default):", "HH:MM  e.g. 09:00", 0)
        self._checkout_var = row("Check-out time (default):", "HH:MM  e.g. 15:30", 1)
        self._late_var     = row("Late arrival threshold:", "Punch-in AFTER this = late", 2)
        self._early_var    = row("Early leave threshold:", "Punch-out BEFORE this = early leave", 3)
        self._wdays_var    = row("Working days / month:", "Used for salary calculation (e.g. 26)", 4)

        hdivider(self, C["divider"]).pack(fill="x", padx=28, pady=(16, 16))

        # Buttons
        btn_row = tk.Frame(self, bg=C["bg"])
        btn_row.pack(padx=28, pady=(0, 24), anchor="e")

        SecondaryButton(btn_row, "Cancel",
                        command=self.destroy,
                        width=100).pack(side="left", padx=(0, 10))
        PrimaryButton(btn_row, "Save Settings",
                      command=self._save,
                      width=140).pack(side="left")

    def _load(self):
        self._checkin_var.set(db.get_setting("checkin_time",  "09:00"))
        self._checkout_var.set(db.get_setting("checkout_time", "15:30"))
        self._late_var.set(db.get_setting("late_threshold",   "09:15"))
        self._early_var.set(db.get_setting("early_leave_threshold", "15:30"))
        self._wdays_var.set(db.get_setting("working_days_per_month", "26"))

    def _save(self):
        import re
        time_re = re.compile(r"^\d{1,2}:\d{2}$")

        def validate_time(v, name):
            v = v.strip()
            if not time_re.match(v):
                messagebox.showerror("Invalid Input",
                                     f"{name} must be in HH:MM format (e.g. 09:15).")
                return None
            return v

        ci  = validate_time(self._checkin_var.get(),  "Check-in time")
        co  = validate_time(self._checkout_var.get(), "Check-out time")
        lt  = validate_time(self._late_var.get(),     "Late threshold")
        el  = validate_time(self._early_var.get(),    "Early leave threshold")
        wd  = self._wdays_var.get().strip()

        if not all([ci, co, lt, el]):
            return
        try:
            wd_int = int(wd)
            if wd_int <= 0:
                raise ValueError
        except ValueError:
            messagebox.showerror("Invalid Input",
                                 "Working days must be a positive integer (e.g. 26).")
            return

        db.set_setting("checkin_time",           ci)
        db.set_setting("checkout_time",          co)
        db.set_setting("late_threshold",         lt)
        db.set_setting("early_leave_threshold",  el)
        db.set_setting("working_days_per_month", str(wd_int))

        messagebox.showinfo("Saved",
                            "Settings saved.\n\nThey will be applied on the next file import.")
        self.destroy()
