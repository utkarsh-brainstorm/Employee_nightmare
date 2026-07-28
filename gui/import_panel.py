"""
gui/import_panel.py
===================
File import panel with drag-and-drop support and a file picker.
"""

from __future__ import annotations

import os
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from typing import Callable, Optional

from gui.theme import C, FONTS


class ImportPanel(tk.Frame):
    """
    Top panel: drag-and-drop zone + Browse button + import status.
    Calls `on_import_success(filepath)` after a successful import trigger.
    """

    def __init__(self, parent, on_import_success: Callable[[str], None], **kwargs):
        super().__init__(parent, bg=C["bg"], **kwargs)
        self._on_import_success = on_import_success
        self._build_ui()

    def _build_ui(self):
        # Section header
        hdr = tk.Label(self, text="Import Attendance File",
                       bg=C["bg"], fg=C["text_primary"],
                       font=FONTS["h3"])
        hdr.pack(anchor="w", padx=20, pady=(16, 6))

        # Card container
        card = tk.Frame(self, bg=C["bg_secondary"],
                        highlightbackground=C["border"],
                        highlightthickness=1)
        card.pack(fill="x", padx=20, pady=(0, 12))

        # Drop zone
        self._drop_frame = tk.Frame(card, bg=C["bg_secondary"],
                                    height=100, cursor="hand2")
        self._drop_frame.pack(fill="x", padx=12, pady=12)
        self._drop_frame.pack_propagate(False)

        self._drop_icon = tk.Label(self._drop_frame,
                                   text="📂",
                                   font=(FONTS["h1"][0], 28),
                                   bg=C["bg_secondary"], fg=C["accent"])
        self._drop_icon.pack(pady=(14, 4))

        self._drop_label = tk.Label(
            self._drop_frame,
            text="Drag & Drop XLS / XLSX file here",
            bg=C["bg_secondary"],
            fg=C["text_secondary"],
            font=FONTS["body_sm"],
        )
        self._drop_label.pack()

        # Buttons row
        btn_row = tk.Frame(card, bg=C["bg_secondary"])
        btn_row.pack(fill="x", padx=12, pady=(0, 12))

        browse_btn = ttk.Button(btn_row, text="Browse File…",
                                command=self._browse, style="TButton")
        browse_btn.pack(side="left", padx=(0, 8))

        self._import_btn = ttk.Button(btn_row, text="Import ▶",
                                      command=self._trigger_import,
                                      style="Accent.TButton",
                                      state="disabled")
        self._import_btn.pack(side="left")

        # Status label
        self._status_var = tk.StringVar(value="No file selected")
        self._status_label = tk.Label(btn_row,
                                      textvariable=self._status_var,
                                      bg=C["bg_secondary"],
                                      fg=C["text_secondary"],
                                      font=FONTS["body_sm"])
        self._status_label.pack(side="left", padx=(16, 0))

        # Progress bar (hidden initially)
        self._progress = ttk.Progressbar(card,
                                         style="Accent.Horizontal.TProgressbar",
                                         mode="indeterminate")

        # Last import info
        self._last_info = tk.Label(self, text="",
                                   bg=C["bg"],
                                   fg=C["text_secondary"],
                                   font=FONTS["caption"])
        self._last_info.pack(anchor="w", padx=20, pady=(0, 4))

        # Selected filepath
        self._selected_file: Optional[str] = None

        # Try to set up drag-and-drop
        self._setup_dnd()

    def _setup_dnd(self):
        """Set up tkinterdnd2 drag-and-drop if available."""
        try:
            # The root window must be a TkinterDnD.Tk for dnd to work
            root = self.winfo_toplevel()
            self._drop_frame.drop_target_register("DND_Files")  # type: ignore
            self._drop_frame.dnd_bind("<<Drop>>", self._on_drop)  # type: ignore
            self._drop_label.configure(text="Drag & Drop XLS / XLSX here  —  or click Browse")
        except Exception:
            # DND not available (non-TkinterDnD.Tk root)
            self._drop_label.configure(
                text="Click Browse to select XLS / XLSX file"
            )

    def _on_drop(self, event):
        """Handle drag-and-drop file."""
        path = event.data.strip()
        # tkinterdnd2 wraps paths with {} on some platforms
        if path.startswith("{") and path.endswith("}"):
            path = path[1:-1]
        if os.path.isfile(path) and path.lower().endswith((".xls", ".xlsx", ".xlsm")):
            self._set_file(path)
        else:
            messagebox.showerror(
                "Invalid File",
                "Please drop an Excel file (.xls or .xlsx)."
            )

    def _browse(self):
        path = filedialog.askopenfilename(
            title="Select Attendance File",
            filetypes=[
                ("Excel Files", "*.xls *.xlsx *.xlsm"),
                ("All Files", "*.*"),
            ],
        )
        if path:
            self._set_file(path)

    def _set_file(self, path: str):
        self._selected_file = path
        fname = os.path.basename(path)
        self._status_var.set(f"Selected: {fname}")
        self._status_label.configure(fg=C["text_primary"])
        self._import_btn.configure(state="normal")
        self._drop_icon.configure(text="✅")

    def _trigger_import(self):
        if not self._selected_file:
            return
        self._on_import_success(self._selected_file)

    def set_status(self, msg: str, color: str = None):
        self._status_var.set(msg)
        self._status_label.configure(fg=color or C["text_secondary"])

    def set_last_import_info(self, text: str):
        self._last_info.configure(text=text)

    def show_progress(self, show: bool):
        if show:
            self._progress.pack(fill="x", padx=12, pady=(0, 8))
            self._progress.start(10)
        else:
            self._progress.stop()
            self._progress.pack_forget()

    def reset(self):
        self._selected_file = None
        self._status_var.set("No file selected")
        self._status_label.configure(fg=C["text_secondary"])
        self._import_btn.configure(state="disabled")
        self._drop_icon.configure(text="📂")
