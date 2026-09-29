#!/usr/bin/python3
"""
main.py  (v3 — pywebview / WebKit2GTK)
========================================
Launches AttendanceProcessor in a native OS WebView window.
  • Linux   → GTK3 + WebKit2GTK  (requires libwebkit2gtk-4.1)
  • macOS   → WKWebView (built-in, zero install)
  • Windows → Edge WebView2     (ships with Windows 11 / auto-installs)

No Chromium bundled. Footprint < 3 MB of Python code.
"""

from __future__ import annotations

import os
import sys

# Ensure project root is importable regardless of CWD
if getattr(sys, 'frozen', False):
    ROOT = sys._MEIPASS
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

# Bypass Windows proxy auto-detection which causes 2-minute WebView2 startup lags
os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--proxy-server='direct://' --proxy-bypass-list=*"

# ── Verify WebKit2GTK is reachable on Linux before importing webview ──────
def _check_linux_backend() -> None:
    if sys.platform != "linux":
        return
    try:
        import gi                                   # noqa: F401
        gi.require_version("WebKit2", "4.1")
        from gi.repository import WebKit2           # noqa: F401
    except Exception:
        try:
            import gi                               # noqa: F401
            gi.require_version("WebKit2", "4.0")
            from gi.repository import WebKit2       # noqa: F401
        except Exception:
            print(
                "\n[ERROR] WebKit2GTK not found.\n"
                "Install it with:\n"
                "  sudo apt install python3-gi python3-gi-cairo gir1.2-webkit2-4.1\n"
                "Then re-run the app.\n"
            )
            sys.exit(1)

_check_linux_backend()

import webview                      # noqa: E402  (after backend check)
import core.db as db                # noqa: E402
from api import Api                 # noqa: E402


def main() -> None:
    # ── Initialise database (creates tables & seeds defaults on first run) ──
    db.init_db()

    api = Api()

    # ── Resolve frontend HTML path ──────────────────────────────────────────
    html_path = os.path.join(ROOT, "web", "index.html")
    if not os.path.isfile(html_path):
        raise FileNotFoundError(
            f"Frontend not found at {html_path}\n"
            "Ensure the 'web/' directory is present alongside main.py."
        )

    icon_path = os.path.join(ROOT, "app_icon.png")

    # ── Create the native window ────────────────────────────────────────────
    window = webview.create_window(
        title     = "AttendanceProcessor Pro",
        url       = f"file://{html_path}",
        js_api    = api,
        width     = 1400,
        height    = 900,
        min_size  = (1100, 720),
        easy_drag = False,
        background_color = "#0f1117",
    )

    # Give api a back-reference for file dialogs
    api.set_window(window)

    # ── Start the event loop ────────────────────────────────────────────────
    # icon= sets the taskbar / dock / title-bar icon on all platforms
    start_kwargs = dict(debug="--debug" in sys.argv)
    if os.path.isfile(icon_path):
        start_kwargs["icon"] = icon_path

    webview.start(**start_kwargs)


if __name__ == "__main__":
    main()
