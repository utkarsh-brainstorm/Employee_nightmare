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

# ── Linux platform fixes (X11/XWayland + Full GPU Acceleration) ─────────────
# On Linux (specifically under Wayland sessions with Intel/NVIDIA hybrid GPUs),
# WebKit2GTK's native Wayland DMA-BUF pipeline frequently deadlocks and drops
# damage/frame update notifications, causing the UI to freeze until resized.
# Disabling compositing mode completely (CPU software rendering) fixes the freeze
# but drops framerates to 8-10 FPS and causes severe typing/input latency.
# Instead, routing GTK through the X11 / XWayland backend bypasses the Wayland
# DMA-BUF deadlock entirely while keeping full hardware-accelerated 60+ FPS GPU
# rendering active and responsive.
if sys.platform == "linux":
    if os.environ.get("DISPLAY"):
        os.environ["GDK_BACKEND"] = "x11"

    # Remove any software-fallback flags so WebKitGTK uses full GPU acceleration
    os.environ.pop("WEBKIT_DISABLE_COMPOSITING_MODE", None)
    os.environ.pop("WEBKIT_DISABLE_DMABUF_RENDERER", None)
    os.environ.pop("WEBKIT_DMABUF_RENDERER_FORCE_SHM", None)

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
        title     = "AttendanceProcessor Pro V17",
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

    # ── Start the event loop (picks best available native renderer) ─────────
    webview.start(
        debug   = "--debug" in sys.argv,
        icon    = icon_path if os.path.isfile(icon_path) else None,
        # gui=None → auto-select: gtk on Linux, cocoa on macOS, edgechromium on Windows
    )


if __name__ == "__main__":
    main()
