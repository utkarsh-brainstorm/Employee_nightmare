"""
core/exporter.py
================
Export query results to CSV and PDF.
V12 Pro — Minimal, clean PDF design.
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
# PDF (ReportLab) — V12 Pro minimal design
# ---------------------------------------------------------------------------

# Brand palette
_NAVY    = "#1a1f4e"   # dark navy — header bar
_WHITE   = "#ffffff"
_LIGHT   = "#f8f9fc"   # alternate row
_BORDER  = "#dde1eb"   # thin grid lines
_DIM     = "#6b7280"   # caption / footer text
_BODY    = "#1f2937"   # body text


def export_pdf(
    columns: List[str],
    rows: List[Dict],
    filepath: str,
    title: str = "Attendance Report",
    subtitle: str = "",
    org_name: str = "",
    logo_b64: str = "",
    sql_display: str = "",
    theme_colors: dict = None,
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
        from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
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
    C_LIGHT  = colors.HexColor(_LIGHT)
    C_BORDER = colors.HexColor(_BORDER)
    C_DIM    = colors.HexColor(_DIM)
    C_BODY   = colors.HexColor(_BODY)

    # ── Page setup — landscape if many columns ──────────────────────────────
    pagesize = landscape(A4) if len(columns) > 7 else A4
    page_w = pagesize[0] - 24 * mm
    top_margin = 16 * mm

    doc = SimpleDocTemplate(
        filepath,
        pagesize=pagesize,
        rightMargin=12 * mm, leftMargin=12 * mm,
        topMargin=top_margin, bottomMargin=16 * mm,
    )

    styles = getSampleStyleSheet()

    # ── Text styles ─────────────────────────────────────────────────────────
    def style(name, **kw):
        s = ParagraphStyle(name, parent=styles["Normal"], **kw)
        return s

    title_s  = style("T", fontSize=15, fontName="Helvetica-Bold",
                     textColor=C_NAVY, alignment=TA_CENTER, spaceAfter=1)
    org_s    = style("O", fontSize=10, fontName="Helvetica",
                     textColor=C_DIM,  alignment=TA_CENTER, spaceAfter=1)
    meta_s   = style("M", fontSize=8,  fontName="Helvetica",
                     textColor=C_DIM,  alignment=TA_CENTER, spaceAfter=0)
    cell_s   = style("C", fontSize=7.5, fontName="Helvetica",
                     textColor=C_BODY, wordWrap="CJK", leading=10)
    hdr_s    = style("H", fontSize=7.5, fontName="Helvetica-Bold",
                     textColor=C_WHITE, wordWrap="CJK", leading=10)
    footer_s = style("F", fontSize=7, fontName="Helvetica",
                     textColor=C_DIM, alignment=TA_CENTER)
    sql_s    = style("S", fontSize=6.5, fontName="Courier",
                     textColor=C_DIM, leading=9, leftIndent=2)

    story = []

    # ── Logo ────────────────────────────────────────────────────────────────
    _logo_tmp = None
    if logo_b64:
        try:
            from reportlab.platypus import Image as RLImage
            from reportlab.lib.utils import ImageReader
            logo_bytes = base64.b64decode(logo_b64)
            _logo_tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
            _logo_tmp.write(logo_bytes)
            _logo_tmp.flush(); _logo_tmp.close()
            ir = ImageReader(_logo_tmp.name)
            iw, ih = ir.getSize()
            aspect = iw / float(ih)
            tgt_h = 22 * mm; tgt_w = min(tgt_h * aspect, page_w)
            if tgt_w > page_w: tgt_h = page_w / aspect; tgt_w = page_w
            img = RLImage(_logo_tmp.name, width=tgt_w, height=tgt_h)
            img.hAlign = "CENTER"
            story.append(img)
            story.append(Spacer(1, 3 * mm))
        except Exception:
            pass

    # ── Header ──────────────────────────────────────────────────────────────
    if org_name:
        story.append(Paragraph(org_name, org_s))
    story.append(Paragraph(title, title_s))
    story.append(Paragraph(
        f"Generated: {datetime.now().strftime('%d %B %Y, %I:%M %p')}  |  "
        f"{len(rows)} record{'s' if len(rows) != 1 else ''}",
        meta_s
    ))
    story.append(Spacer(1, 3 * mm))
    story.append(HRFlowable(width="100%", thickness=1.5, color=C_NAVY))
    story.append(Spacer(1, 3 * mm))

    if not rows:
        story.append(Paragraph("No records found.", meta_s))
        doc.build(story)
        return

    # ── Column widths — proportional to max content length ──────────────────
    col_max_lens = []
    for col in columns:
        max_len = max(
            len(str(col)),
            *[len(str(row.get(col, "") or "")) for row in rows]
        ) if rows else len(str(col))
        col_max_lens.append(max(5, min(max_len, 45)))
    total_chars = sum(col_max_lens)
    col_widths = [page_w * (ml / total_chars) for ml in col_max_lens]

    # ── Table data ──────────────────────────────────────────────────────────
    header_row = [Paragraph(str(col), hdr_s) for col in columns]
    data = [header_row]
    for row in rows:
        data.append([
            Paragraph(str(row.get(col, "") or ""), cell_s)
            for col in columns
        ])

    # ── Table style — clean, minimal ────────────────────────────────────────
    tbl_style = TableStyle([
        # Header bar — navy
        ("BACKGROUND",    (0, 0), (-1, 0),  C_NAVY),
        ("TEXTCOLOR",     (0, 0), (-1, 0),  C_WHITE),
        ("FONTNAME",      (0, 0), (-1, 0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0, 0), (-1, 0),  7.5),
        ("TOPPADDING",    (0, 0), (-1, 0),  5),
        ("BOTTOMPADDING", (0, 0), (-1, 0),  5),
        ("LEFTPADDING",   (0, 0), (-1, 0),  5),
        ("RIGHTPADDING",  (0, 0), (-1, 0),  5),
        # Body rows — alternating white / light grey
        ("FONTNAME",      (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE",      (0, 1), (-1, -1), 7.5),
        ("TOPPADDING",    (0, 1), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 4),
        ("LEFTPADDING",   (0, 1), (-1, -1), 5),
        ("RIGHTPADDING",  (0, 1), (-1, -1), 5),
        ("TEXTCOLOR",     (0, 1), (-1, -1), C_BODY),
        ("ROWBACKGROUNDS",(0, 1), (-1, -1), [C_WHITE, C_LIGHT]),
        # Thin horizontal lines only (no vertical gridlines for clean look)
        ("LINEBELOW",     (0, 0), (-1, 0),  0.5, C_BORDER),
        ("LINEBELOW",     (0, 1), (-1, -1), 0.3, C_BORDER),
        # Valign middle
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
    ])

    table = Table(data, colWidths=col_widths, repeatRows=1)
    table.setStyle(tbl_style)
    story.append(table)

    # ── Footer ──────────────────────────────────────────────────────────────
    story.append(Spacer(1, 5 * mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=C_BORDER))
    story.append(Spacer(1, 2 * mm))

    footer_text = "AttendanceProcessor Pro V12"
    if any(k in " ".join(columns).lower() for k in ("earned", "salary", "payable")):
        footer_text += "  |  Earned = (Base Salary ÷ Total Required Mins) × Payable Mins"
    story.append(Paragraph(footer_text, footer_s))

    # ── SQL query at bottom ─────────────────────────────────────────────────
    if sql_display:
        story.append(Spacer(1, 3 * mm))
        story.append(Paragraph("Query:", style("QL", fontSize=7, fontName="Helvetica-Bold",
                                               textColor=C_DIM)))
        for line in sql_display.split("\n")[:20]:  # cap at 20 lines
            story.append(Paragraph(line or " ", sql_s))

    doc.build(story)

    # Cleanup temp logo
    if _logo_tmp is not None:
        try:
            os.unlink(_logo_tmp.name)
        except Exception:
            pass
