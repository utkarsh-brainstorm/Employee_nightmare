"""
gui/theme.py
============
Central design system — Apple/Samsung-inspired clean light theme.
All colors, fonts, and widget styles are defined here.
"""

import tkinter as tk
from tkinter import ttk
import platform


# ---------------------------------------------------------------------------
# Color Palette
# ---------------------------------------------------------------------------

C = {
    "bg":           "#FFFFFF",
    "bg_secondary": "#F5F5F7",
    "bg_card":      "#FFFFFF",
    "bg_hover":     "#E8E8ED",
    "border":       "#D2D2D7",
    "border_light": "#E5E5EA",

    "accent":       "#0071E3",
    "accent_hover": "#0077ED",
    "accent_dark":  "#005BB5",
    "accent_light": "#E8F2FF",

    "text_primary":   "#1D1D1F",
    "text_secondary": "#6E6E73",
    "text_tertiary":  "#AEAEB2",
    "text_on_accent": "#FFFFFF",

    "success":    "#34C759",
    "warning":    "#FF9500",
    "danger":     "#FF3B30",
    "info":       "#5AC8FA",

    "present_bg":     "#E8F8EE",
    "present_fg":     "#1C7A3B",
    "absent_bg":      "#FFEBE8",
    "absent_fg":      "#C0392B",
    "weeklyoff_bg":   "#EEF2FF",
    "weeklyoff_fg":   "#3B4ED8",
    "halfday_bg":     "#FFF4E0",
    "halfday_fg":     "#9A5700",

    "sidebar_bg":     "#F5F5F7",
    "panel_shadow":   "#00000010",
}

# ---------------------------------------------------------------------------
# Fonts
# ---------------------------------------------------------------------------

def _system_font():
    sys = platform.system()
    if sys == "Darwin":
        return "SF Pro Display"
    elif sys == "Windows":
        return "Segoe UI"
    else:
        # Linux — try Inter, fall back
        return "Inter"


BASE_FONT = _system_font()

FONTS = {
    "h1":      (BASE_FONT, 22, "bold"),
    "h2":      (BASE_FONT, 16, "bold"),
    "h3":      (BASE_FONT, 13, "bold"),
    "body":    (BASE_FONT, 12),
    "body_sm": (BASE_FONT, 11),
    "label":   (BASE_FONT, 10),
    "mono":    ("Courier New", 11),
    "mono_sm": ("Courier New", 10),
    "btn":     (BASE_FONT, 12),
    "btn_sm":  (BASE_FONT, 11),
    "caption": (BASE_FONT, 9),
}


# ---------------------------------------------------------------------------
# Apply ttk styles
# ---------------------------------------------------------------------------

def apply_theme(root: tk.Tk) -> ttk.Style:
    style = ttk.Style(root)

    # Use a cross-platform base theme
    available = style.theme_names()
    for preferred in ("clam", "alt", "default"):
        if preferred in available:
            style.theme_use(preferred)
            break

    # Root window
    root.configure(bg=C["bg"])

    # --- Frame / LabelFrame ---
    style.configure("TFrame", background=C["bg"])
    style.configure("Card.TFrame", background=C["bg_card"],
                    relief="flat", borderwidth=0)
    style.configure("Sidebar.TFrame", background=C["sidebar_bg"])
    style.configure("TLabelframe", background=C["bg"], relief="flat",
                    borderwidth=1)
    style.configure("TLabelframe.Label",
                    background=C["bg"],
                    foreground=C["text_secondary"],
                    font=FONTS["body_sm"])

    # --- Label ---
    style.configure("TLabel",
                    background=C["bg"],
                    foreground=C["text_primary"],
                    font=FONTS["body"])
    style.configure("Secondary.TLabel",
                    background=C["bg"],
                    foreground=C["text_secondary"],
                    font=FONTS["body_sm"])
    style.configure("Caption.TLabel",
                    background=C["bg"],
                    foreground=C["text_tertiary"],
                    font=FONTS["caption"])
    style.configure("H1.TLabel",
                    background=C["bg"],
                    foreground=C["text_primary"],
                    font=FONTS["h1"])
    style.configure("H2.TLabel",
                    background=C["bg"],
                    foreground=C["text_primary"],
                    font=FONTS["h2"])
    style.configure("H3.TLabel",
                    background=C["bg"],
                    foreground=C["text_primary"],
                    font=FONTS["h3"])
    style.configure("Accent.TLabel",
                    background=C["bg"],
                    foreground=C["accent"],
                    font=FONTS["body_sm"])
    style.configure("Sidebar.TLabel",
                    background=C["sidebar_bg"],
                    foreground=C["text_primary"],
                    font=FONTS["body"])
    style.configure("SidebarCaption.TLabel",
                    background=C["sidebar_bg"],
                    foreground=C["text_secondary"],
                    font=FONTS["caption"])

    # --- Button ---
    style.configure("Accent.TButton",
                    background=C["accent"],
                    foreground=C["text_on_accent"],
                    font=FONTS["btn"],
                    relief="flat",
                    borderwidth=0,
                    padding=(16, 8))
    style.map("Accent.TButton",
              background=[("active", C["accent_hover"]), ("pressed", C["accent_dark"])],
              foreground=[("active", C["text_on_accent"])])

    style.configure("TButton",
                    background=C["bg_secondary"],
                    foreground=C["text_primary"],
                    font=FONTS["btn_sm"],
                    relief="flat",
                    borderwidth=0,
                    padding=(12, 6))
    style.map("TButton",
              background=[("active", C["bg_hover"]), ("pressed", C["border"])])

    style.configure("Ghost.TButton",
                    background=C["bg"],
                    foreground=C["accent"],
                    font=FONTS["btn_sm"],
                    relief="flat",
                    borderwidth=0,
                    padding=(8, 4))
    style.map("Ghost.TButton",
              background=[("active", C["accent_light"])],
              foreground=[("active", C["accent"])])

    style.configure("Danger.TButton",
                    background=C["danger"],
                    foreground=C["text_on_accent"],
                    font=FONTS["btn_sm"],
                    relief="flat",
                    borderwidth=0,
                    padding=(10, 6))
    style.map("Danger.TButton",
              background=[("active", "#CC2F24")])

    style.configure("Success.TButton",
                    background=C["success"],
                    foreground=C["text_on_accent"],
                    font=FONTS["btn_sm"],
                    relief="flat",
                    borderwidth=0,
                    padding=(10, 6))

    # --- Combobox ---
    style.configure("TCombobox",
                    fieldbackground=C["bg"],
                    background=C["bg"],
                    foreground=C["text_primary"],
                    font=FONTS["body"],
                    relief="flat",
                    borderwidth=1,
                    arrowsize=12)
    style.map("TCombobox",
              fieldbackground=[("readonly", C["bg"])],
              selectbackground=[("readonly", C["accent"])],
              selectforeground=[("readonly", C["text_on_accent"])])

    # --- Entry ---
    style.configure("TEntry",
                    fieldbackground=C["bg"],
                    foreground=C["text_primary"],
                    font=FONTS["body"],
                    relief="flat",
                    borderwidth=1,
                    padding=(6, 4))
    style.map("TEntry",
              fieldbackground=[("focus", C["bg"])],
              relief=[("focus", "flat")])

    # --- Treeview (results table) ---
    style.configure("Treeview",
                    background=C["bg"],
                    fieldbackground=C["bg"],
                    foreground=C["text_primary"],
                    font=FONTS["body_sm"],
                    rowheight=26,
                    relief="flat",
                    borderwidth=0)
    style.configure("Treeview.Heading",
                    background=C["bg_secondary"],
                    foreground=C["text_secondary"],
                    font=FONTS["body_sm"],
                    relief="flat",
                    borderwidth=0,
                    padding=(4, 6))
    style.map("Treeview",
              background=[("selected", C["accent_light"])],
              foreground=[("selected", C["accent"])])
    style.map("Treeview.Heading",
              background=[("active", C["border_light"])])

    # --- Scrollbar ---
    style.configure("TScrollbar",
                    background=C["bg_secondary"],
                    troughcolor=C["bg_secondary"],
                    borderwidth=0,
                    arrowsize=10,
                    relief="flat")
    style.map("TScrollbar",
              background=[("active", C["border"])])

    # --- Notebook ---
    style.configure("TNotebook",
                    background=C["bg"],
                    borderwidth=0,
                    relief="flat")
    style.configure("TNotebook.Tab",
                    background=C["bg_secondary"],
                    foreground=C["text_secondary"],
                    font=FONTS["body_sm"],
                    padding=(14, 7),
                    borderwidth=0)
    style.map("TNotebook.Tab",
              background=[("selected", C["bg"])],
              foreground=[("selected", C["accent"])],
              font=[("selected", FONTS["body"])])

    # --- Separator ---
    style.configure("TSeparator", background=C["border_light"])

    # --- Progressbar ---
    style.configure("Accent.Horizontal.TProgressbar",
                    troughcolor=C["bg_secondary"],
                    background=C["accent"],
                    borderwidth=0,
                    thickness=4)

    # --- Checkbutton ---
    style.configure("TCheckbutton",
                    background=C["bg"],
                    foreground=C["text_primary"],
                    font=FONTS["body_sm"])

    # --- Radiobutton ---
    style.configure("TRadiobutton",
                    background=C["bg"],
                    foreground=C["text_primary"],
                    font=FONTS["body_sm"])

    return style


def make_rounded_frame(parent, **kwargs):
    """A tk.Frame styled as a card."""
    f = tk.Frame(parent, bg=C["bg_card"],
                 highlightbackground=C["border_light"],
                 highlightthickness=1,
                 relief="flat", **kwargs)
    return f
