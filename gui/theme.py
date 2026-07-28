"""
gui/theme.py  (v2 — CustomTkinter)
====================================
Central design system using CustomTkinter for modern rounded UI.
SF Pro Display font loaded from local OTF files.
Professional light-grey palette.
"""

from __future__ import annotations

import os
import platform
import tkinter as tk
from tkinter import font as tkfont

# ---------------------------------------------------------------------------
# Font Registration
# ---------------------------------------------------------------------------

FONT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "sf-pro-display"
)

FONT_FAMILY = "SF Pro Display"
_FONT_LOADED = False


def load_fonts(root=None) -> str:
    """
    Load SF Pro Display if available, else pick best available clean sans-serif.
    Must be called AFTER the root Tk window is created so font families are available.
    Returns the font family name to use.
    """
    global _FONT_LOADED, FONT_FAMILY
    if _FONT_LOADED:
        return FONT_FAMILY

    # Priority list of clean, readable sans-serif families
    # SF Pro Display is loaded from local OTF files via pyglet if possible
    try:
        import pyglet
        if os.path.isdir(FONT_DIR):
            for f in os.listdir(FONT_DIR):
                if f.lower().endswith((".otf", ".ttf")):
                    pyglet.font.add_file(os.path.join(FONT_DIR, f))
        FONT_FAMILY = "SF Pro Display"
        _FONT_LOADED = True
        return FONT_FAMILY
    except ImportError:
        pass

    # Check which fonts are actually available to tkinter
    try:
        available = set(tkfont.families(root) if root else tkfont.families())
        priority = [
            "SF Pro Display",
            "SF Pro Text",
            "Helvetica Neue",
            "Segoe UI",
            "Inter",
            "Ubuntu",
            "Cantarell",
            "Open Sans",
            "texgyreheros",   # Helvetica-compatible, available on most Linux
            "nimbus sans l",
            "helvetica",
        ]
        for fam in priority:
            if fam.lower() in {a.lower() for a in available}:
                # Get exact case from available set
                for a in available:
                    if a.lower() == fam.lower():
                        FONT_FAMILY = a
                        break
                _FONT_LOADED = True
                return FONT_FAMILY
    except Exception:
        pass

    # Hard fallback per OS
    sys_name = platform.system()
    FONT_FAMILY = ("SF Pro Display" if sys_name == "Darwin"
                   else "Segoe UI" if sys_name == "Windows"
                   else "TkDefaultFont")
    _FONT_LOADED = True
    return FONT_FAMILY


# ---------------------------------------------------------------------------
# Color Palette — Professional Light Grey
# ---------------------------------------------------------------------------

C = {
    # Backgrounds
    "bg":             "#F2F2F7",   # main window — iOS system grey6
    "bg_card":        "#FFFFFF",   # card / panel surface
    "bg_input":       "#FFFFFF",   # input fields
    "bg_sidebar":     "#E5E5EA",   # sidebar / quick panel
    "bg_hover":       "#D1D1D6",   # hover state
    "bg_selected":    "#E8F0FE",   # selected row / active
    "bg_row_alt":     "#F8F8FA",   # alternating table row

    # Borders
    "border":         "#C7C7CC",   # standard border
    "border_light":   "#E5E5EA",   # subtle border
    "border_focus":   "#636366",   # focus ring

    # Accent (muted professional blue)
    "accent":         "#3C7DD9",   # primary action
    "accent_hover":   "#2F68C0",
    "accent_light":   "#EBF2FF",   # accent tinted bg
    "accent_text":    "#FFFFFF",

    # Text
    "text":           "#1C1C1E",   # primary text
    "text_2":         "#48484A",   # secondary text
    "text_3":         "#8E8E93",   # placeholder / caption
    "text_4":         "#AEAEB2",   # disabled / tertiary
    "text_inv":       "#FFFFFF",   # text on dark bg

    # Status colours (muted)
    "green":          "#30A46C",
    "green_bg":       "#EDFAF4",
    "orange":         "#F76808",
    "orange_bg":      "#FFF4ED",
    "red":            "#E5484D",
    "red_bg":         "#FFEFEF",
    "blue":           "#3C7DD9",
    "blue_bg":        "#EBF2FF",
    "purple_bg":      "#F3EFFE",
    "purple":         "#6E56CF",

    # Special
    "divider":        "#D1D1D6",
    "shadow":         "#00000012",
}

# ---------------------------------------------------------------------------
# Font Sizes
# ---------------------------------------------------------------------------

def F(size: int, weight: str = "normal"):
    """Return a font tuple using the loaded family."""
    return (FONT_FAMILY, size, weight)


# Named font shortcuts (populated after load_fonts() is called)
class FONTS:
    display  = None   # 22 bold
    h1       = None   # 18 bold
    h2       = None   # 15 bold
    h3       = None   # 13 bold
    body     = None   # 13 normal
    body_sm  = None   # 12 normal
    label    = None   # 11 normal
    caption  = None   # 10 normal
    mono     = None   # 11 mono
    mono_sm  = None   # 10 mono
    btn      = None   # 13 bold
    btn_sm   = None   # 12 normal
    table    = None   # 12 normal
    table_hd = None   # 12 bold

    @classmethod
    def init(cls, family: str):
        cls.display  = (family, 22, "bold")
        cls.h1       = (family, 18, "bold")
        cls.h2       = (family, 15, "bold")
        cls.h3       = (family, 13, "bold")
        cls.body     = (family, 13)
        cls.body_sm  = (family, 12)
        cls.label    = (family, 11)
        cls.caption  = (family, 10)
        cls.mono     = ("Courier New", 11)
        cls.mono_sm  = ("Courier New", 10)
        cls.btn      = (family, 13, "bold")
        cls.btn_sm   = (family, 12)
        cls.table    = (family, 12)
        cls.table_hd = (family, 12, "bold")
