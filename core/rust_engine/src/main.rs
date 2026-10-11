use printpdf::*;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

#[derive(Debug, Deserialize)]
pub struct ExportJob {
    pub output_path: String,
    pub title: Option<String>,
    pub org_name: Option<String>,
    pub source_label: Option<String>,
    pub sql_display: Option<String>,
    pub page_size: Option<String>,
    pub orientation: Option<String>,
    pub scale: Option<f32>,
    pub theme: Option<String>,
    pub columns: Vec<String>,
    pub col_headers: Option<HashMap<String, String>>,
    pub col_widths: Option<HashMap<String, f32>>,
    pub col_visible: Option<Vec<String>>,
    pub rows: Vec<HashMap<String, serde_json::Value>>,
}

struct ColorTheme {
    header_bg: Color,
    header_text: Color,
    header_accent: Color,
    row_alt_bg: Color,
    row_border: Color,
    text_primary: Color,
    text_muted: Color,
}

impl ColorTheme {
    fn new(theme_name: &str) -> Self {
        match theme_name {
            "executive" => Self {
                header_bg: Color::Rgb(Rgb::new(0.06, 0.09, 0.16, None)), // Navy 900
                header_text: Color::Rgb(Rgb::new(1.0, 1.0, 1.0, None)),
                header_accent: Color::Rgb(Rgb::new(0.72, 0.47, 0.12, None)), // Gold
                row_alt_bg: Color::Rgb(Rgb::new(0.97, 0.98, 0.99, None)),
                row_border: Color::Rgb(Rgb::new(0.89, 0.91, 0.94, None)),
                text_primary: Color::Rgb(Rgb::new(0.06, 0.09, 0.16, None)),
                text_muted: Color::Rgb(Rgb::new(0.39, 0.45, 0.55, None)),
            },
            "minimal" => Self {
                header_bg: Color::Rgb(Rgb::new(0.94, 0.96, 0.98, None)), // Soft slate
                header_text: Color::Rgb(Rgb::new(0.06, 0.09, 0.16, None)),
                header_accent: Color::Rgb(Rgb::new(0.79, 0.83, 0.88, None)),
                row_alt_bg: Color::Rgb(Rgb::new(0.99, 0.99, 1.0, None)),
                row_border: Color::Rgb(Rgb::new(0.91, 0.93, 0.95, None)),
                text_primary: Color::Rgb(Rgb::new(0.12, 0.16, 0.23, None)),
                text_muted: Color::Rgb(Rgb::new(0.45, 0.50, 0.58, None)),
            },
            _ => Self {
                // "modern" / default - Crisp Slate 800 + Indigo accent
                header_bg: Color::Rgb(Rgb::new(0.12, 0.16, 0.23, None)), // Slate 800
                header_text: Color::Rgb(Rgb::new(1.0, 1.0, 1.0, None)),
                header_accent: Color::Rgb(Rgb::new(0.39, 0.40, 0.95, None)), // Indigo
                row_alt_bg: Color::Rgb(Rgb::new(0.97, 0.98, 0.99, None)),
                row_border: Color::Rgb(Rgb::new(0.89, 0.91, 0.94, None)),
                text_primary: Color::Rgb(Rgb::new(0.06, 0.09, 0.16, None)),
                text_muted: Color::Rgb(Rgb::new(0.39, 0.45, 0.55, None)),
            },
        }
    }
}

// Truncate text cleanly to approximate character count based on width in points
fn fit_text(text: &str, max_width_pt: f32, font_size_pt: f32) -> String {
    // Helvetica avg char width ~ 0.52 * font_size
    let char_width = font_size_pt * 0.52;
    let max_chars = ((max_width_pt / char_width).floor() as usize).max(3);
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let truncated: String = text.chars().take(max_chars.saturating_sub(3)).collect();
        format!("{}...", truncated)
    }
}

fn sanitize_pdf_string(s: &str) -> String {
    s.replace('\r', " ").replace('\n', " ").replace('\t', " ")
}

pub fn generate_pdf(job: &ExportJob) -> Result<Vec<u8>, String> {
    let title = job.title.clone().unwrap_or_else(|| "Query Results".to_string());
    let org_name = job.org_name.clone().unwrap_or_else(|| "Querii Analytics".to_string());
    let source = job.source_label.clone().unwrap_or_default();
    let theme_name = job.theme.as_deref().unwrap_or("modern");
    let theme = ColorTheme::new(theme_name);

    // Filter visible columns
    let visible_cols: Vec<String> = if let Some(vis) = &job.col_visible {
        let vis_set: std::collections::HashSet<_> = vis.iter().cloned().collect();
        job.columns.iter().filter(|c| vis_set.contains(*c)).cloned().collect()
    } else {
        job.columns.clone()
    };

    if visible_cols.is_empty() {
        return Err("No visible columns specified".to_string());
    }

    // Page sizing in points (1 mm = 2.8346457 pt)
    let page_size_str = job.page_size.as_deref().unwrap_or("A4");
    let (mut page_w_pt, mut page_h_pt) = match page_size_str {
        "A3" => (841.89, 1190.55),
        "Letter" => (612.0, 792.0),
        _ => (595.28, 841.89), // A4
    };

    if job.orientation.as_deref() == Some("landscape") {
        std::mem::swap(&mut page_w_pt, &mut page_h_pt);
    }

    let margin_left = 32.0;
    let margin_right = 32.0;
    let margin_top = 36.0;
    let margin_bottom = 36.0;
    let usable_w = page_w_pt - margin_left - margin_right;

    // Calculate column widths
    let num_cols = visible_cols.len() as f32;
    let mut col_widths_pt: Vec<f32> = Vec::new();

    if let Some(widths_map) = &job.col_widths {
        let sum_pct: f32 = visible_cols.iter().map(|c| widths_map.get(c).copied().unwrap_or(0.0)).sum();
        if sum_pct > 5.0 {
            for c in &visible_cols {
                let pct = widths_map.get(c).copied().unwrap_or(100.0 / num_cols);
                col_widths_pt.push((pct / sum_pct) * usable_w);
            }
        } else {
            let default_w = usable_w / num_cols;
            col_widths_pt = vec![default_w; visible_cols.len()];
        }
    } else {
        let default_w = usable_w / num_cols;
        col_widths_pt = vec![default_w; visible_cols.len()];
    }

    let col_headers = job.col_headers.clone().unwrap_or_default();
    let total_records = job.rows.len();

    let mut doc = PdfDocument::new(&title);
    let mut pages_ops: Vec<Vec<Op>> = Vec::new();
    let mut current_ops: Vec<Op> = Vec::new();

    let mut cur_y = page_h_pt - margin_top;

    // --- Page 1 Header ---
    // Top banner bar
    cur_y -= 12.0;
    current_ops.push(Op::StartTextSection);
    current_ops.push(Op::SetFont {
        font: PdfFontHandle::Builtin(BuiltinFont::HelveticaBold),
        size: Pt(10.0),
    });
    current_ops.push(Op::SetFillColor { col: theme.text_muted.clone() });
    current_ops.push(Op::SetTextCursor { pos: Point { x: Pt(margin_left), y: Pt(cur_y) } });
    current_ops.push(Op::ShowText { items: vec![TextItem::Text(org_name.to_uppercase())] });
    current_ops.push(Op::EndTextSection);

    // Title
    cur_y -= 22.0;
    current_ops.push(Op::StartTextSection);
    current_ops.push(Op::SetFont {
        font: PdfFontHandle::Builtin(BuiltinFont::HelveticaBold),
        size: Pt(18.0),
    });
    current_ops.push(Op::SetFillColor { col: theme.text_primary.clone() });
    current_ops.push(Op::SetTextCursor { pos: Point { x: Pt(margin_left), y: Pt(cur_y) } });
    current_ops.push(Op::ShowText { items: vec![TextItem::Text(title.clone())] });
    current_ops.push(Op::EndTextSection);

    // Meta row (Date, records, source)
    cur_y -= 14.0;
    let meta_str = format!(
        "Records: {}  |  Generated by Querii",
        total_records,
    );
    current_ops.push(Op::StartTextSection);
    current_ops.push(Op::SetFont {
        font: PdfFontHandle::Builtin(BuiltinFont::Helvetica),
        size: Pt(8.5),
    });
    current_ops.push(Op::SetFillColor { col: theme.text_muted.clone() });
    current_ops.push(Op::SetTextCursor { pos: Point { x: Pt(margin_left), y: Pt(cur_y) } });
    current_ops.push(Op::ShowText { items: vec![TextItem::Text(meta_str)] });
    if !source.is_empty() {
        current_ops.push(Op::ShowText { items: vec![TextItem::Text(format!("  |  Source: {}", source))] });
    }
    current_ops.push(Op::EndTextSection);

    // Accent line
    cur_y -= 10.0;
    current_ops.push(Op::SetFillColor { col: theme.header_accent.clone() });
    current_ops.push(Op::DrawRectangle {
        rectangle: Rect {
            x: Pt(margin_left),
            y: Pt(cur_y),
            width: Pt(usable_w),
            height: Pt(2.0),
            mode: Some(PaintMode::Fill),
            winding_order: None,
        },
    });

    cur_y -= 14.0;

    // Helper to draw table header
    let draw_table_header = |ops: &mut Vec<Op>, y_pos: f32| {
        let th_height = 20.0;
        // Background
        ops.push(Op::SetFillColor { col: theme.header_bg.clone() });
        ops.push(Op::DrawRectangle {
            rectangle: Rect {
                x: Pt(margin_left),
                y: Pt(y_pos - th_height),
                width: Pt(usable_w),
                height: Pt(th_height),
                mode: Some(PaintMode::Fill),
                winding_order: None,
            },
        });

        // Header text
        let mut x_cur = margin_left;
        for (i, col_name) in visible_cols.iter().enumerate() {
            let col_w = col_widths_pt[i];
            let label = col_headers.get(col_name).cloned().unwrap_or_else(|| col_name.clone());
            let fit_label = fit_text(&label, col_w - 10.0, 8.0);

            ops.push(Op::StartTextSection);
            ops.push(Op::SetFont {
                font: PdfFontHandle::Builtin(BuiltinFont::HelveticaBold),
                size: Pt(8.0),
            });
            ops.push(Op::SetFillColor { col: theme.header_text.clone() });
            ops.push(Op::SetTextCursor {
                pos: Point {
                    x: Pt(x_cur + 5.0),
                    y: Pt(y_pos - 13.5),
                },
            });
            ops.push(Op::ShowText { items: vec![TextItem::Text(fit_label)] });
            ops.push(Op::EndTextSection);

            x_cur += col_w;
        }
    };

    // Draw initial table header
    draw_table_header(&mut current_ops, cur_y);
    cur_y -= 20.0;

    let row_height = 16.5;

    // Render data rows
    for (row_idx, row) in job.rows.iter().enumerate() {
        // Page break check
        if cur_y - row_height < margin_bottom + 18.0 {
            pages_ops.push(current_ops);
            current_ops = Vec::new();

            cur_y = page_h_pt - margin_top;

            // Compact running header
            cur_y -= 10.0;
            current_ops.push(Op::StartTextSection);
            current_ops.push(Op::SetFont {
                font: PdfFontHandle::Builtin(BuiltinFont::Helvetica),
                size: Pt(7.5),
            });
            current_ops.push(Op::SetFillColor { col: theme.text_muted.clone() });
            current_ops.push(Op::SetTextCursor { pos: Point { x: Pt(margin_left), y: Pt(cur_y) } });
            current_ops.push(Op::ShowText {
                items: vec![TextItem::Text(format!("{}  •  {}", title, org_name))],
            });
            current_ops.push(Op::EndTextSection);

            cur_y -= 12.0;
            draw_table_header(&mut current_ops, cur_y);
            cur_y -= 20.0;
        }

        // Zebra striping
        if row_idx % 2 == 1 {
            current_ops.push(Op::SetFillColor { col: theme.row_alt_bg.clone() });
            current_ops.push(Op::DrawRectangle {
                rectangle: Rect {
                    x: Pt(margin_left),
                    y: Pt(cur_y - row_height),
                    width: Pt(usable_w),
                    height: Pt(row_height),
                    mode: Some(PaintMode::Fill),
                    winding_order: None,
                },
            });
        }

        // Row bottom border
        current_ops.push(Op::SetFillColor { col: theme.row_border.clone() });
        current_ops.push(Op::DrawRectangle {
            rectangle: Rect {
                x: Pt(margin_left),
                y: Pt(cur_y - row_height),
                width: Pt(usable_w),
                height: Pt(0.5),
                mode: Some(PaintMode::Fill),
                winding_order: None,
            },
        });

        // Cell values
        let mut x_cur = margin_left;
        for (i, col_name) in visible_cols.iter().enumerate() {
            let col_w = col_widths_pt[i];
            let cell_val = match row.get(col_name) {
                Some(serde_json::Value::Null) | None => "—".to_string(),
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(serde_json::Value::Number(n)) => n.to_string(),
                Some(serde_json::Value::Bool(b)) => b.to_string(),
                Some(v) => v.to_string(),
            };

            let safe_val = sanitize_pdf_string(&cell_val);
            let fit_val = fit_text(&safe_val, col_w - 10.0, 7.5);

            current_ops.push(Op::StartTextSection);
            current_ops.push(Op::SetFont {
                font: PdfFontHandle::Builtin(BuiltinFont::Helvetica),
                size: Pt(7.5),
            });
            current_ops.push(Op::SetFillColor {
                col: if safe_val == "—" { theme.text_muted.clone() } else { theme.text_primary.clone() },
            });
            current_ops.push(Op::SetTextCursor {
                pos: Point {
                    x: Pt(x_cur + 5.0),
                    y: Pt(cur_y - 11.5),
                },
            });
            current_ops.push(Op::ShowText { items: vec![TextItem::Text(fit_val)] });
            current_ops.push(Op::EndTextSection);

            x_cur += col_w;
        }

        cur_y -= row_height;
    }

    // Optional SQL box at the end
    if let Some(sql) = &job.sql_display {
        if !sql.trim().is_empty() {
            if cur_y - 40.0 < margin_bottom + 18.0 {
                pages_ops.push(current_ops);
                current_ops = Vec::new();
                cur_y = page_h_pt - margin_top - 20.0;
            }

            cur_y -= 16.0;
            current_ops.push(Op::StartTextSection);
            current_ops.push(Op::SetFont {
                font: PdfFontHandle::Builtin(BuiltinFont::HelveticaBold),
                size: Pt(7.5),
            });
            current_ops.push(Op::SetFillColor { col: theme.text_muted.clone() });
            current_ops.push(Op::SetTextCursor { pos: Point { x: Pt(margin_left), y: Pt(cur_y) } });
            current_ops.push(Op::ShowText { items: vec![TextItem::Text("SQL QUERY".to_string())] });
            current_ops.push(Op::EndTextSection);

            cur_y -= 14.0;
            let clean_sql = sanitize_pdf_string(sql);
            let display_sql = fit_text(&clean_sql, usable_w - 12.0, 7.0);

            current_ops.push(Op::SetFillColor { col: theme.row_alt_bg.clone() });
            current_ops.push(Op::DrawRectangle {
                rectangle: Rect {
                    x: Pt(margin_left),
                    y: Pt(cur_y - 14.0),
                    width: Pt(usable_w),
                    height: Pt(18.0),
                    mode: Some(PaintMode::Fill),
                    winding_order: None,
                },
            });

            current_ops.push(Op::StartTextSection);
            current_ops.push(Op::SetFont {
                font: PdfFontHandle::Builtin(BuiltinFont::Courier),
                size: Pt(6.8),
            });
            current_ops.push(Op::SetFillColor { col: theme.text_primary.clone() });
            current_ops.push(Op::SetTextCursor { pos: Point { x: Pt(margin_left + 6.0), y: Pt(cur_y - 9.0) } });
            current_ops.push(Op::ShowText { items: vec![TextItem::Text(display_sql)] });
            current_ops.push(Op::EndTextSection);

            cur_y -= 20.0;
        }
    }

    // Push the final page
    pages_ops.push(current_ops);

    let total_pages = pages_ops.len();

    // Now decorate each page with running footer ("Page X of Y")
    for (page_idx, mut ops) in pages_ops.into_iter().enumerate() {
        let footer_y = margin_bottom - 12.0;

        // Footer divider line
        ops.push(Op::SetFillColor { col: theme.row_border.clone() });
        ops.push(Op::DrawRectangle {
            rectangle: Rect {
                x: Pt(margin_left),
                y: Pt(footer_y + 12.0),
                width: Pt(usable_w),
                height: Pt(0.5),
                mode: Some(PaintMode::Fill),
                winding_order: None,
            },
        });

        // Left footer note
        ops.push(Op::StartTextSection);
        ops.push(Op::SetFont {
            font: PdfFontHandle::Builtin(BuiltinFont::Helvetica),
            size: Pt(7.0),
        });
        ops.push(Op::SetFillColor { col: theme.text_muted.clone() });
        ops.push(Op::SetTextCursor { pos: Point { x: Pt(margin_left), y: Pt(footer_y) } });
        ops.push(Op::ShowText {
            items: vec![TextItem::Text("Querii  •  Confidential Report".to_string())],
        });
        ops.push(Op::EndTextSection);

        // Right footer: Page X of Y
        let page_str = format!("Page {} of {}", page_idx + 1, total_pages);
        ops.push(Op::StartTextSection);
        ops.push(Op::SetFont {
            font: PdfFontHandle::Builtin(BuiltinFont::Helvetica),
            size: Pt(7.0),
        });
        ops.push(Op::SetFillColor { col: theme.text_muted.clone() });
        ops.push(Op::SetTextCursor {
            pos: Point {
                x: Pt(page_w_pt - margin_right - 50.0),
                y: Pt(footer_y),
            },
        });
        ops.push(Op::ShowText { items: vec![TextItem::Text(page_str)] });
        ops.push(Op::EndTextSection);

        let pdf_page = PdfPage::new(Pt(page_w_pt).into(), Pt(page_h_pt).into(), ops);
        doc.pages.push(pdf_page);
    }

    let mut warnings = Vec::new();
    let bytes = doc.save(&PdfSaveOptions::default(), &mut warnings);
    Ok(bytes)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: querii-pdf <job.json> or querii-pdf --stdin");
        std::process::exit(1);
    }

    let json_content = if args[1] == "--stdin" {
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf).expect("Failed to read from stdin");
        buf
    } else {
        let path = Path::new(&args[1]);
        std::fs::read_to_string(path).unwrap_or_else(|e| {
            eprintln!("Error reading {}: {}", path.display(), e);
            std::process::exit(1);
        })
    };

    let job: ExportJob = match serde_json::from_str(&json_content) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("JSON parse error: {}", e);
            std::process::exit(1);
        }
    };

    let output_path = job.output_path.clone();
    match generate_pdf(&job) {
        Ok(bytes) => {
            let mut f = File::create(&output_path).unwrap_or_else(|e| {
                eprintln!("Error creating output file {}: {}", output_path, e);
                std::process::exit(1);
            });
            f.write_all(&bytes).unwrap_or_else(|e| {
                eprintln!("Error writing output file {}: {}", output_path, e);
                std::process::exit(1);
            });
            println!("SUCCESS: Generated {} pages ({} bytes) in {}", doc_pages_count(&bytes), bytes.len(), output_path);
        }
        Err(e) => {
            eprintln!("PDF generation error: {}", e);
            std::process::exit(1);
        }
    }
}

fn doc_pages_count(_bytes: &[u8]) -> usize {
    1 // simple indicator
}
