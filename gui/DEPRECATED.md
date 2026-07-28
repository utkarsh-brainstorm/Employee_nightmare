# GUI Module — Deprecated

The `gui/` directory (tkinter + customtkinter implementation) has been **superseded** by the `web/` frontend in v3.

All GUI Python files are kept for reference but are **no longer loaded** by `main.py`.

## Current architecture (v3)

```
main.py          → launches pywebview native window
api.py           → Python API exposed to JS via window.pywebview.api
web/index.html   → single-page app (HTML + Tailwind CSS)
web/app.js       → all frontend logic (filter builder, SQL, results grid)
web/style.css    → minimal monochrome stylesheet
core/            → unchanged backend (parser, db, query_builder, exporter)
```

## Why pywebview?

- Uses the **native OS WebView** (WebKit2GTK on Linux, WKWebView on macOS, EdgeWebView2 on Windows)
- No Chromium bundled → minimal binary footprint
- Full HTML/CSS/JS stack → far richer UI than tkinter allows
- `window.pywebview.api` bridges Python and JS with zero boilerplate
