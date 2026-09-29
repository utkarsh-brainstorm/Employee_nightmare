"""
core/exporter.py
================
Export query results to CSV and PDF.
V12 Pro — Minimal clean PDF, no org name, no footer query, no formula.
"""

from __future__ import annotations

import csv
import os
from datetime import datetime
from typing import Dict, List


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------

def export_csv(columns: List[str], rows: List[Dict], filepath: str) -> None:
    """Write columns + rows to a CSV file."""
    with open(filepath, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({col: row.get(col, "") for col in columns})


# ---------------------------------------------------------------------------
# PDF  — V12 Pro minimal design
# ---------------------------------------------------------------------------

# Brand palette
_NAVY   = "#1a1f4e"   # header bar
_WHITE  = "#ffffff"
_SOFT   = "#f2f4f8"   # alternate row tint
_BORDER = "#d0d5e8"   # subtle grid
_DIM    = "#6b7280"   # meta / footer text
_BODY   = "#1f2937"   # body text


def export_pdf(
    columns: List[str],
    rows: List[Dict],
    filepath: str,
    title: str = "Attendance Report",
    subtitle: str = "",
    org_name: str = "",        # kept in signature for API compat — intentionally unused
    logo_b64: str = "",
    sql_display: str = "",     # intentionally unused in output
    theme_colors: dict = None, # kept for API compat — using fixed palette
) -> None:
    """Render a minimal, clean PDF using ReportLab."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate, Table, TableStyle,
            Paragraph, Spacer, HRFlowable
        )
        from reportlab.lib.enums import TA_CENTER
        import base64
        import tempfile
    except ImportError:
        raise ImportError(
            "reportlab is required for PDF export. "
            "Install it with: pip install reportlab"
        )

    # ── Palette ────────────────────────────────────────────────────────────
    C_NAVY   = colors.HexColor(_NAVY)
    C_WHITE  = colors.HexColor(_WHITE)
    C_SOFT   = colors.HexColor(_SOFT)
    C_BORDER = colors.HexColor(_BORDER)
    C_DIM    = colors.HexColor(_DIM)
    C_BODY   = colors.HexColor(_BODY)

    # ── Page setup — landscape when many columns ────────────────────────────
    pagesize = landscape(A4) if len(columns) > 7 else A4
    page_w   = pagesize[0] - 24 * mm

    doc = SimpleDocTemplate(
        filepath,
        pagesize   = pagesize,
        rightMargin  = 12 * mm,
        leftMargin   = 12 * mm,
        topMargin    = 16 * mm,
        bottomMargin = 14 * mm,
    )

    styles = getSampleStyleSheet()

    def _style(name, **kw):
        return ParagraphStyle(name, parent=styles["Normal"], **kw)

    title_s  = _style("T",  fontSize=14, fontName="Helvetica-Bold",
                      textColor=C_NAVY,  alignment=TA_CENTER, spaceAfter=3)
    meta_s   = _style("M",  fontSize=8,  fontName="Helvetica",
                      textColor=C_DIM,   alignment=TA_CENTER, spaceAfter=0)
    cell_s   = _style("C",  fontSize=7.5, fontName="Helvetica",
                      textColor=C_BODY,  wordWrap="CJK", leading=10)
    hdr_s    = _style("H",  fontSize=7.5, fontName="Helvetica-Bold",
                      textColor=C_WHITE, wordWrap="CJK", leading=10)
    footer_s = _style("F",  fontSize=7,  fontName="Helvetica",
                      textColor=C_DIM,   alignment=TA_CENTER)

    story = []

    # ── Logo (optional) ─────────────────────────────────────────────────────
    _logo_tmp = None
    if logo_b64:
        try:
            from reportlab.platypus import Image as RLImage
            from reportlab.lib.utils import ImageReader
            logo_bytes = base64.b64decode(logo_b64)
            _logo_tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
            _logo_tmp.write(logo_bytes); _logo_tmp.flush(); _logo_tmp.close()
            ir = ImageReader(_logo_tmp.name)
            iw, ih = ir.getSize()
            aspect = iw / float(ih)
            tgt_h = 18 * mm
            tgt_w = min(tgt_h * aspect, page_w)
            img = RLImage(_logo_tmp.name, width=tgt_w, height=tgt_h)
            img.hAlign = "CENTER"
            story.append(img)
            story.append(Spacer(1, 3 * mm))
        except Exception:
            pass

    # ── Title + single meta line ─────────────────────────────────────────────
    story.append(Paragraph(title, title_s))
    story.append(Paragraph(
        f"Generated  {datetime.now().strftime('%d %B %Y  %I:%M %p')}  ·  {len(rows)} record{'s' if len(rows) != 1 else ''}",
        meta_s
    ))
    story.append(Spacer(1, 4 * mm))
    story.append(HRFlowable(width="100%", thickness=1.5, color=C_NAVY, spaceAfter=4 * mm))

    if not rows:
        story.append(Paragraph("No records found.", meta_s))
        doc.build(story)
        return

    # ── Dynamic column widths ────────────────────────────────────────────────
    col_lens = []
    for col in columns:
        mx = max(
            len(str(col)),
            *[len(str(row.get(col, "") or "")) for row in rows]
        ) if rows else len(str(col))
        col_lens.append(max(5, min(mx, 40)))
    total = sum(col_lens)
    col_widths = [page_w * (l / total) for l in col_lens]

    # ── Table data ───────────────────────────────────────────────────────────
    data = [[Paragraph(f"<b>{col}</b>", hdr_s) for col in columns]]
    for row in rows:
        data.append([
            Paragraph(str(row.get(col, "") or ""), cell_s)
            for col in columns
        ])

    # ── Table style  (no inner vertical lines → clean look) ─────────────────
    row_count = len(data)
    ts = TableStyle([
        # Header
        ("BACKGROUND",    (0, 0), (-1, 0),  C_NAVY),
        ("FONTNAME",      (0, 0), (-1, 0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0, 0), (-1, 0),  7.5),
        ("TOPPADDING",    (0, 0), (-1, 0),  6),
        ("BOTTOMPADDING", (0, 0), (-1, 0),  6),
        ("LEFTPADDING",   (0, 0), (-1, 0),  6),
        ("RIGHTPADDING",  (0, 0), (-1, 0),  6),
        # Body
        ("FONTNAME",      (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE",      (0, 1), (-1, -1), 7.5),
        ("TOPPADDING",    (0, 1), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 4),
        ("LEFTPADDING",   (0, 1), (-1, -1), 6),
        ("RIGHTPADDING",  (0, 1), (-1, -1), 6),
        ("TEXTCOLOR",     (0, 1), (-1, -1), C_BODY),
        # Alternating row background
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [C_WHITE, C_SOFT]),
        # Outer border only
        ("BOX",           (0, 0), (-1, -1), 0.6, C_BORDER),
        # Horizontal rule after header
        ("LINEBELOW",     (0, 0), (-1, 0),  1.0, C_NAVY),
        # Thin horizontal separators between body rows
        ("LINEBELOW",     (0, 1), (-1, -2), 0.25, C_BORDER),
        # Vertical align
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
    ])

    table = Table(data, colWidths=col_widths, repeatRows=1)
    table.setStyle(ts)
    story.append(table)

    # ── Footer ───────────────────────────────────────────────────────────────
    story.append(Spacer(1, 5 * mm))
    story.append(HRFlowable(width="100%", thickness=0.4, color=C_BORDER))
    story.append(Spacer(1, 2 * mm))
    story.append(Paragraph("AttendanceProcessor Pro", footer_s))

    doc.build(story)

    # Cleanup temp logo
    if _logo_tmp is not None:
        try:
            os.unlink(_logo_tmp.name)
        except Exception:
            pass
