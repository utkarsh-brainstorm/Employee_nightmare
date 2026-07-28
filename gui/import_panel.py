"""
gui/import_panel.py  (v2 — CTk)
================================
Import panel: drag-and-drop + file picker, clean card design.
"""

from __future__ import annotations

import os
import tkinter as tk
from tkinter import filedialog, messagebox
from typing import Callable, Optional

import customtkinter as ctk

from gui.theme import C, FONTS
from gui.widgets import Card, PrimaryButton, SecondaryButton, hdivider


class ImportPanel(tk.Frame):
    """Top panel: file drop zone, picker, import button, status."""

    def __init__(self, parent, on_import_success: Callable[[str], None], **kwargs):
        super().__init__(parent, bg=C["bg"], **kwargs)
        self._on_import_success = on_import_success
        self._selected_file: Optional[str] = None
        self._build_ui()

    def _build_ui(self):
        wrapper = tk.Frame(self, bg=C["bg"])
        wrapper.pack(fill="x", padx=20, pady=(14, 10))

        # ---- Drop zone card ----
        drop_card = tk.Frame(wrapper, bg=C["bg_card"],
                             highlightbackground=C["border"],
                             highlightthickness=1,
                             cursor="hand2")
        drop_card.pack(fill="x")

        inner = tk.Frame(drop_card, bg=C["bg_card"])
        inner.pack(fill="x", padx=20, pady=14)

        # Left: icon + text
        left = tk.Frame(inner, bg=C["bg_card"])
        left.pack(side="left", fill="x", expand=True)

        self._icon_lbl = tk.Label(left, text="📂",
                                  bg=C["bg_card"],
                                  font=(FONTS.h1[0], 26))
        self._icon_lbl.pack(side="left", padx=(0, 14))

        text_col = tk.Frame(left, bg=C["bg_card"])
        text_col.pack(side="left")

        self._title_lbl = tk.Label(text_col,
                                   text="Drop attendance file here",
                                   bg=C["bg_card"], fg=C["text"],
                                   font=FONTS.h3)
        self._title_lbl.pack(anchor="w")

        self._sub_lbl = tk.Label(text_col,
                                 text="Supports ONtime (Secureye) XLS / XLSX exports",
                                 bg=C["bg_card"], fg=C["text_3"],
                                 font=FONTS.label)
        self._sub_lbl.pack(anchor="w")

        # Right: buttons
        right = tk.Frame(inner, bg=C["bg_card"])
        right.pack(side="right")

        SecondaryButton(right, "Browse File…",
                        command=self._browse,
                        width=120).pack(side="left", padx=(0, 8))

        self._import_btn = PrimaryButton(right, "Import  ▶",
                                         command=self._trigger_import,
                                         width=120)
        self._import_btn.pack(side="left")
        self._import_btn.configure(state="disabled",
                                   fg_color=C["border"],
                                   text_color=C["text_3"])

        # Progress bar (hidden)
        self._prog = ctk.CTkProgressBar(drop_card,
                                        mode="indeterminate",
                                        height=3,
                                        fg_color=C["border_light"],
                                        progress_color=C["accent"],
                                        corner_radius=0)

        # Status bar below card
        self._status_var = tk.StringVar(value="No file selected")
        self._status_lbl = tk.Label(wrapper,
                                    textvariable=self._status_var,
                                    bg=C["bg"],
                                    fg=C["text_3"],
                                    font=FONTS.label,
                                    anchor="w")
        self._status_lbl.pack(anchor="w", pady=(6, 0))

        # Drag-and-drop binding
        self._setup_dnd(drop_card)

    def _setup_dnd(self, widget: tk.Widget):
        try:
            widget.drop_target_register("DND_Files")  # type: ignore
            widget.dnd_bind("<<Drop>>", self._on_drop)  # type: ignore
            self._title_lbl.configure(text="Drop attendance file here  —  or click Browse")
        except Exception:
            pass

    def _on_drop(self, event):
        path = event.data.strip()
        if path.startswith("{") and path.endswith("}"):
            path = path[1:-1]
        if os.path.isfile(path) and path.lower().endswith((".xls", ".xlsx", ".xlsm")):
            self._set_file(path)
        else:
            messagebox.showerror("Wrong File Type",
                                 "Please drop an Excel file (.xls or .xlsx).")

    def _browse(self):
        path = filedialog.askopenfilename(
            title="Select Attendance File",
            filetypes=[("Excel Files", "*.xls *.xlsx *.xlsm"), ("All Files", "*.*")],
        )
        if path:
            self._set_file(path)

    def _set_file(self, path: str):
        self._selected_file = path
        fname = os.path.basename(path)
        self._status_var.set(f"Selected: {fname}")
        self._status_lbl.configure(fg=C["text"])
        self._import_btn.configure(state="normal",
                                   fg_color=C["accent"],
                                   text_color=C["text_inv"])
        self._icon_lbl.configure(text="✅")

    def _trigger_import(self):
        if self._selected_file:
            self._on_import_success(self._selected_file)

    def set_status(self, msg: str, color: str = None):
        self._status_var.set(msg)
        self._status_lbl.configure(fg=color or C["text_3"])

    def set_last_import_info(self, text: str):
        self._status_lbl.configure(fg=C["text_3"])
        self._status_var.set(text)

    def show_progress(self, show: bool):
        if show:
            self._prog.pack(fill="x", before=self._status_lbl)
            self._prog.start()
        else:
            self._prog.stop()
            self._prog.pack_forget()

    def reset(self):
        self._selected_file = None
        self._status_var.set("No file selected")
        self._status_lbl.configure(fg=C["text_3"])
        self._import_btn.configure(state="disabled",
                                   fg_color=C["border"],
                                   text_color=C["text_3"])
        self._icon_lbl.configure(text="📂")
