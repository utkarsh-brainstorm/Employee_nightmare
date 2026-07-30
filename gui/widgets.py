"""
gui/widgets.py
==============
Reusable styled widget helpers built on top of CustomTkinter + vanilla tkinter.
All widgets follow the professional light-grey palette from theme.py.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from typing import Callable, Optional

import customtkinter as ctk

from gui.theme import C, FONTS

# Configure CTk appearance once
ctk.set_appearance_mode("light")
ctk.set_default_color_theme("blue")


# ---------------------------------------------------------------------------
# Card — white rounded box with subtle shadow effect
# ---------------------------------------------------------------------------

class Card(tk.Frame):
    """A flat white card with a 1px border."""
    def __init__(self, parent, pad_x=0, pad_y=0, **kwargs):
        super().__init__(
            parent,
            bg=C["bg_card"],
            highlightbackground=C["border_light"],
            highlightthickness=1,
            **kwargs
        )


# ---------------------------------------------------------------------------
# Section header label
# ---------------------------------------------------------------------------

def section_label(parent, text: str, bg=None) -> tk.Label:
    return tk.Label(
        parent,
        text=text,
        bg=bg or C["bg"],
        fg=C["text"],
        font=FONTS.h2,
    )


def caption_label(parent, text: str, bg=None) -> tk.Label:
    return tk.Label(
        parent,
        text=text,
        bg=bg or C["bg"],
        fg=C["text_3"],
        font=FONTS.caption,
    )


# ---------------------------------------------------------------------------
# Primary Button (CTk rounded)
# ---------------------------------------------------------------------------

class PrimaryButton(ctk.CTkButton):
    def __init__(self, parent, text: str, command: Callable, width=120, **kwargs):
        super().__init__(
            parent,
            text=text,
            command=command,
            width=width,
            height=34,
            corner_radius=8,
            fg_color=C["accent"],
            hover_color=C["accent_hover"],
            text_color=C["text_inv"],
            font=FONTS.btn_sm,
            **kwargs,
        )


class SecondaryButton(ctk.CTkButton):
    def __init__(self, parent, text: str, command: Callable, width=110, **kwargs):
        super().__init__(
            parent,
            text=text,
            command=command,
            width=width,
            height=34,
            corner_radius=8,
            fg_color=C["bg_hover"],
            hover_color=C["border"],
            text_color=C["text"],
            font=FONTS.btn_sm,
            **kwargs,
        )


class GhostButton(ctk.CTkButton):
    def __init__(self, parent, text: str, command: Callable, width=100, **kwargs):
        super().__init__(
            parent,
            text=text,
            command=command,
            width=width,
            height=30,
            corner_radius=6,
            fg_color="transparent",
            hover_color=C["accent_light"],
            text_color=C["accent"],
            font=FONTS.btn_sm,
            border_width=1,
            border_color=C["accent"],
            **kwargs,
        )


class DangerButton(ctk.CTkButton):
    def __init__(self, parent, text: str, command: Callable, width=110, **kwargs):
        super().__init__(
            parent,
            text=text,
            command=command,
            width=width,
            height=34,
            corner_radius=8,
            fg_color=C["red"],
            hover_color="#C23B3E",
            text_color=C["text_inv"],
            font=FONTS.btn_sm,
            **kwargs,
        )


# ---------------------------------------------------------------------------
# Styled Entry (CTk rounded)
# ---------------------------------------------------------------------------

class StyledEntry(ctk.CTkEntry):
    def __init__(self, parent, placeholder="", width=200, **kwargs):
        super().__init__(
            parent,
            placeholder_text=placeholder,
            width=width,
            height=34,
            corner_radius=7,
            fg_color=C["bg_input"],
            border_color=C["border"],
            border_width=1,
            text_color=C["text"],
            placeholder_text_color=C["text_4"],
            font=FONTS.body_sm,
            **kwargs,
        )


# ---------------------------------------------------------------------------
# Divider
# ---------------------------------------------------------------------------

def hdivider(parent, bg=None) -> tk.Frame:
    return tk.Frame(parent, bg=bg or C["divider"], height=1)


def vdivider(parent, bg=None) -> tk.Frame:
    return tk.Frame(parent, bg=bg or C["divider"], width=1)


# ---------------------------------------------------------------------------
# Tag badge
# ---------------------------------------------------------------------------

STATUS_COLORS = {
    "PRESENT":    (C["green_bg"],  C["green"]),
    "ABSENT":     (C["red_bg"],    C["red"]),
    "WEEKLY_OFF": (C["blue_bg"],   C["blue"]),
    "HALF_DAY":   (C["orange_bg"], C["orange"]),
}


def status_badge_colors(status: str):
    return STATUS_COLORS.get(status.upper(), (C["bg_card"], C["text_3"]))


# ---------------------------------------------------------------------------
# Tooltip
# ---------------------------------------------------------------------------

class Tooltip:
    def __init__(self, widget: tk.Widget, text: str):
        self._widget = widget
        self._text = text
        self._tip = None
        widget.bind("<Enter>", self._show)
        widget.bind("<Leave>", self._hide)

    def _show(self, event=None):
        x = self._widget.winfo_rootx() + 20
        y = self._widget.winfo_rooty() + self._widget.winfo_height() + 4
        self._tip = tk.Toplevel(self._widget)
        self._tip.wm_overrideredirect(True)
        self._tip.wm_geometry(f"+{x}+{y}")
        lbl = tk.Label(self._tip, text=self._text,
                       bg="#1C1C1E", fg="#FFFFFF",
                       font=FONTS.caption,
                       padx=8, pady=4,
                       relief="flat")
        lbl.pack()

    def _hide(self, event=None):
        if self._tip:
            self._tip.destroy()
            self._tip = None
