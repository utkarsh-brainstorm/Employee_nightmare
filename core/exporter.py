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
    sql_display: str = "",
    theme_colors: dict = None,
) -> None:
    """Render a table to PDF using ReportLab with dynamic theming."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable, PageTemplate, BaseDocTemplate, Frame
        )
        from reportlab.lib.enums import TA_LEFT, TA_CENTER
        import base64
        import tempfile
    except ImportError:
        raise ImportError("reportlab is required for PDF export. Install it with: pip install reportlab")

    tc = theme_colors or {}
    c_bg = colors.HexColor(tc.get("bg", "#ffffff"))
    c_text = colors.HexColor(tc.get("text", "#1d1d1f"))
    c_head = colors.HexColor(tc.get("head", "#1d1d1f"))
    c_border = colors.HexColor(tc.get("border", "#d2d2d7"))
    c_alt_bg = colors.HexColor(tc.get("bg", "#f5f5f7")) # Fallback alternate row
    
    pagesize = A4
    top_margin = 32 * mm if logo_b64 else 20 * mm
    
    # Custom DocTemplate to draw background
    class ThemeDocTemplate(SimpleDocTemplate):
        def beforePage(self):
            self.canv.saveState()
            self.canv.setFillColor(c_bg)
            self.canv.rect(0, 0, self.pagesize[0], self.pagesize[1], fill=1, stroke=0)
            self.canv.restoreState()

    doc = ThemeDocTemplate(
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
        fontSize=13,
        fontName="Helvetica-Bold",
        textColor=c_head,
        spaceAfter=4,
        alignment=TA_CENTER,
    )
    sub_style = ParagraphStyle(
        "Sub",
        parent=styles["Normal"],
        fontSize=9,
        fontName="Helvetica",
        textColor=c_text,
        spaceAfter=2,
        alignment=TA_CENTER,
    )
    cell_style = ParagraphStyle(
        "Cell",
        parent=styles["Normal"],
        fontSize=8,
        fontName="Helvetica",
        textColor=c_text,
        wordWrap="CJK",
    )
    header_cell_style = ParagraphStyle(
        "HeaderCell",
        parent=styles["Normal"],
        fontSize=8,
        fontName="Helvetica-Bold",
        textColor=c_bg,
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
            from reportlab.lib.utils import ImageReader
            img_reader = ImageReader(_logo_tmp.name)
            img_w, img_h = img_reader.getSize()
            aspect = img_w / float(img_h)
            
            target_h = 28 * mm
            target_w = target_h * aspect
            page_w = pagesize[0] - 24 * mm
            
            if target_w > page_w:
                target_w = page_w
                target_h = target_w / aspect

            img = RLImage(_logo_tmp.name, width=target_w, height=target_h)
            img.hAlign = 'CENTER'
            story.append(img)
            story.append(Spacer(1, 3 * mm))
        except Exception:
            pass  # Logo decode failed — skip silently

    # ── Org name (if provided) ──
    # Removed per user request since name is embedded in logo banner

    story.append(Paragraph(title, title_style))
    story.append(Paragraph(f"Generated: {datetime.now().strftime('%d %b %Y, %I:%M %p')}", sub_style))
    story.append(Spacer(1, 4 * mm))
    story.append(HRFlowable(width="100%", thickness=1, color=c_border))
    story.append(Spacer(1, 4 * mm))

    if not rows:
        story.append(Paragraph("No records found.", styles["Normal"]))
        doc.build(story)
        return

    # Build table data
    header = [Paragraph(f"<b>{col}</b>", header_cell_style) for col in columns]
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
        ("BACKGROUND",   (0, 0), (-1, 0), c_head),
        ("TEXTCOLOR",    (0, 0), (-1, 0), c_bg),
        ("FONTNAME",     (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",     (0, 0), (-1, 0), 8),
        ("BOTTOMPADDING",(0, 0), (-1, 0), 6),
        ("TOPPADDING",   (0, 0), (-1, 0), 6),
        # Body
        ("FONTNAME",     (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE",     (0, 1), (-1, -1), 7),
        ("ROWBACKGROUNDS",(0, 1), (-1, -1), [c_bg, c_bg]),
        ("BOTTOMPADDING",(0, 1), (-1, -1), 4),
        ("TOPPADDING",   (0, 1), (-1, -1), 4),
        ("LEFTPADDING",  (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        # Grid
        ("GRID",         (0, 0), (-1, -1), 0.25, c_border),
        ("VALIGN",       (0, 0), (-1, -1), "MIDDLE"),
    ]))

    story.append(table)
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph(
        f"Total Records: {len(rows)}  |  AttendanceProcessor",
        sub_style
    ))

    if any("Earned" in c for c in columns) or any("Salary" in c for c in columns):
        story.append(Spacer(1, 4 * mm))
        formula_style = ParagraphStyle(
            "Formula",
            parent=styles["Normal"],
            fontSize=8,
            fontName="Helvetica-Oblique",
            textColor=colors.HexColor("#333333"),
        )
        story.append(Paragraph("<b>Formula:</b> Earned (₹) = (Base Salary ÷ Working Days) × [ Present + (0.5 × Half) - (Late × Penalty %) ]", formula_style))

    # ── SQL query at bottom (if provided) ──
    if sql_display:
        sql_style = ParagraphStyle(
            "SqlBlock",
            parent=styles["Normal"],
            fontSize=7,
            fontName="Courier",
            textColor=colors.HexColor("#555555"),
            spaceAfter=2,
            leftIndent=4,
            leading=9,
        )
        sql_label_style = ParagraphStyle(
            "SqlLabel",
            parent=styles["Normal"],
            fontSize=7,
            fontName="Courier-Bold",
            textColor=colors.HexColor("#333333"),
            spaceAfter=1,
        )
        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#d2d2d7")))
        story.append(Spacer(1, 2 * mm))
        story.append(Paragraph("Query:", sql_label_style))
        # Split SQL into lines to preserve formatting
        for line in sql_display.split('\n')[:20]:  # Max 20 lines
            if line.strip():
                story.append(Paragraph(line.replace(' ', '&nbsp;'), sql_style))

    doc.build(story)

    # Cleanup temp logo file
    if _logo_tmp is not None:
        try:
            import os as _os
            _os.unlink(_logo_tmp.name)
        except Exception:
            pass
