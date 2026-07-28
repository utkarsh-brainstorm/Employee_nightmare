"""
core/exporter.py
================
Export query results to CSV and PDF.
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
# PDF (ReportLab)
# ---------------------------------------------------------------------------

def export_pdf(
    columns: List[str],
    rows: List[Dict],
    filepath: str,
    title: str = "Attendance Report",
    subtitle: str = "",
    org_name: str = "",
    logo_b64: str = "",
) -> None:
    """Render a table to PDF using ReportLab."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable
        )
        from reportlab.lib.enums import TA_LEFT, TA_CENTER
        import base64
        import tempfile
    except ImportError:
        raise ImportError("reportlab is required for PDF export. Install it with: pip install reportlab")

    # Use landscape if many columns
    pagesize = landscape(A4) if len(columns) > 7 else A4
    top_margin = 32 * mm if logo_b64 else 20 * mm
    doc = SimpleDocTemplate(
        filepath,
        pagesize=pagesize,
        rightMargin=12 * mm,
        leftMargin=12 * mm,
        topMargin=top_margin,
        bottomMargin=20 * mm,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "Title",
        parent=styles["Normal"],
        fontSize=16,
        fontName="Helvetica-Bold",
        textColor=colors.HexColor("#1d1d1f"),
        spaceAfter=4,
        alignment=TA_CENTER,
    )
    sub_style = ParagraphStyle(
        "Sub",
        parent=styles["Normal"],
        fontSize=9,
        fontName="Helvetica",
        textColor=colors.HexColor("#6e6e73"),
        spaceAfter=2,
        alignment=TA_CENTER,
    )
    cell_style = ParagraphStyle(
        "Cell",
        parent=styles["Normal"],
        fontSize=8,
        fontName="Helvetica",
        textColor=colors.HexColor("#1d1d1f"),
        wordWrap="CJK",
    )

    story = []

    # ── Org logo (if provided) ──
    _logo_tmp = None
    if logo_b64:
        try:
            from reportlab.platypus import Image as RLImage
            logo_bytes = base64.b64decode(logo_b64)
            _logo_tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.png')
            _logo_tmp.write(logo_bytes)
            _logo_tmp.flush()
            _logo_tmp.close()
            # Fit logo within page width, max height 28mm
            page_w = pagesize[0] - 24 * mm
            img = RLImage(_logo_tmp.name, width=page_w, height=28 * mm)
            img.hAlign = 'CENTER'
            story.append(img)
            story.append(Spacer(1, 3 * mm))
        except Exception:
            pass  # Logo decode failed — skip silently

    # ── Org name (if provided) ──
    if org_name:
        org_style = ParagraphStyle(
            "OrgName",
            parent=styles["Normal"],
            fontSize=11,
            fontName="Helvetica-Bold",
            textColor=colors.HexColor("#1d1d1f"),
            spaceAfter=2,
            alignment=TA_CENTER,
        )
        story.append(Paragraph(org_name, org_style))

    story.append(Paragraph(title, title_style))
    if subtitle:
        story.append(Paragraph(subtitle, sub_style))
    story.append(Paragraph(f"Generated: {datetime.now().strftime('%d %b %Y, %I:%M %p')}", sub_style))
    story.append(Spacer(1, 4 * mm))
    story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#d2d2d7")))
    story.append(Spacer(1, 4 * mm))

    if not rows:
        story.append(Paragraph("No records found.", styles["Normal"]))
        doc.build(story)
        return

    # Build table data
    header = [Paragraph(f"<b>{col}</b>", cell_style) for col in columns]
    data = [header]
    for row in rows:
        data.append([
            Paragraph(str(row.get(col, "") or ""), cell_style)
            for col in columns
        ])

    # Column widths — distribute available width
    page_w = pagesize[0] - 24 * mm
    col_w = page_w / max(len(columns), 1)
    col_widths = [col_w] * len(columns)

    table = Table(data, colWidths=col_widths, repeatRows=1)
    table.setStyle(TableStyle([
        # Header
        ("BACKGROUND",   (0, 0), (-1, 0), colors.HexColor("#0071E3")),
        ("TEXTCOLOR",    (0, 0), (-1, 0), colors.white),
        ("FONTNAME",     (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",     (0, 0), (-1, 0), 8),
        ("BOTTOMPADDING",(0, 0), (-1, 0), 6),
        ("TOPPADDING",   (0, 0), (-1, 0), 6),
        # Body
        ("FONTNAME",     (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE",     (0, 1), (-1, -1), 7),
        ("ROWBACKGROUNDS",(0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F5F7")]),
        ("BOTTOMPADDING",(0, 1), (-1, -1), 4),
        ("TOPPADDING",   (0, 1), (-1, -1), 4),
        ("LEFTPADDING",  (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        # Grid
        ("GRID",         (0, 0), (-1, -1), 0.25, colors.HexColor("#d2d2d7")),
        ("VALIGN",       (0, 0), (-1, -1), "MIDDLE"),
    ]))

    story.append(table)
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph(
        f"Total Records: {len(rows)}  |  AttendanceProcessor",
        sub_style
    ))

    doc.build(story)

    # Cleanup temp logo file
    if _logo_tmp is not None:
        try:
            import os as _os
            _os.unlink(_logo_tmp.name)
        except Exception:
            pass
