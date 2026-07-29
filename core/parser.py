"""
core/parser.py
==============
Parses ONtime (Secureye) XLS/XLSX attendance export files.

The file format:
  - Rows 0–7: title / company / location metadata (skip)
  - Row with 'Emp Code' in col 0 = header row (detect dynamically)
  - Data rows: col0=emp_code, col2=emp_name, col4+ = date columns
  - Cell values: 'A' = Absent, 'WO-I' = Weekly Off,
                 'HH:MM' = punch-in only, 'HH:MM\\nHH:MM' = in\\nout
  - Page-break headers repeat mid-sheet (same pattern) — must be skipped
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import List, Optional, Tuple

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class AttendanceRecord:
    report_file: str
    report_period_start: Optional[date]
    report_period_end: Optional[date]
    company_name: str
    emp_code: str
    emp_name: str
    work_date: date
    status: str          # PRESENT | ABSENT | WEEKLY_OFF | HALF_DAY
    punch_in: Optional[str]   # HH:MM or None
    punch_out: Optional[str]  # HH:MM or None
    work_hours: Optional[float]
    is_late: int          # 0 or 1
    left_early: int       # 0 or 1


@dataclass
class ParseResult:
    filename: str
    company_name: str
    location: str
    period_start: Optional[date]
    period_end: Optional[date]
    records: List[AttendanceRecord] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Thresholds (configurable)
# ---------------------------------------------------------------------------

DEFAULT_LATE_THRESHOLD = "09:15"    # punch-in after this = late
DEFAULT_EARLY_LEAVE = "15:30"       # punch-out before this = early leave


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

MONTH_MAP = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _parse_period(title: str) -> Tuple[Optional[date], Optional[date]]:
    """Extract start and end dates from report title string."""
    # Expected pattern: "For Period   : 15-Jul-2026 To 28-Jul-2026"
    pattern = r"(\d{1,2})[-/\s]+([A-Za-z]{3,9})[-/\s]+(\d{4})\s+[Tt]o\s+(\d{1,2})[-/\s]+([A-Za-z]{3,9})[-/\s]+(\d{4})"
    m = re.search(pattern, title)
    if not m:
        return None, None
    try:
        d1, m1, y1, d2, m2, y2 = m.groups()
        start = date(int(y1), MONTH_MAP[m1[:3].lower()], int(d1))
        end = date(int(y2), MONTH_MAP[m2[:3].lower()], int(d2))
        return start, end
    except Exception:
        return None, None


def _parse_time(t: str) -> Optional[str]:
    """Normalise a time string to HH:MM or return None."""
    t = t.strip()
    if not t:
        return None
    # Accept HH:MM or H:MM
    m = re.match(r"^(\d{1,2}):(\d{2})$", t)
    if m:
        hh, mm = int(m.group(1)), int(m.group(2))
        if 0 <= hh < 24 and 0 <= mm < 60:
            return f"{hh:02d}:{mm:02d}"
    return None


def _time_to_minutes(t: str) -> int:
    """Convert HH:MM to total minutes."""
    hh, mm = map(int, t.split(":"))
    return hh * 60 + mm


def _compute_work_hours(pin: Optional[str], pout: Optional[str]) -> Optional[float]:
    if not pin or not pout:
        return None
    try:
        diff = _time_to_minutes(pout) - _time_to_minutes(pin)
        if diff < 0:
            diff += 24 * 60  # overnight shift
        return round(diff / 60, 2)
    except Exception:
        return None


def _decode_cell(cell_val: str, late_thresh: str, early_thresh: str, full_day_hours: float, half_day_hours: float,
                 work_date: date, emp_code: str, emp_name: str, report_file: str,
                 period_start: Optional[date], period_end: Optional[date],
                 company: str) -> Optional[AttendanceRecord]:
    """Decode a single attendance cell and return an AttendanceRecord using our custom logic."""
    raw = str(cell_val).strip()
    if not raw or raw in ("nan", "None", "NaN"):
        return None

    punch_in: Optional[str] = None
    punch_out: Optional[str] = None
    status: str

    if raw.upper().startswith("WO"):
        status = "WEEKLY_OFF"
    else:
        # Extract all HH:MM patterns
        matches = re.findall(r'\b\d{1,2}:\d{2}\b', raw)
        valid_punches = []
        for p in matches:
            t = _parse_time(p)
            if t:
                valid_punches.append(t)
        
        if len(valid_punches) >= 2:
            punch_in = valid_punches[0]
            punch_out = valid_punches[-1]
        elif len(valid_punches) == 1:
            t = valid_punches[0]
            # Heuristic: if time < 12:00 → punch-in; else → punch-out
            mins = _time_to_minutes(t)
            if mins < 12 * 60:
                punch_in = t
            else:
                punch_out = t

        work_hours = _compute_work_hours(punch_in, punch_out)

        # Dynamic status logic based strictly on hours and punches
        if work_hours is not None:
            if work_hours >= full_day_hours:
                status = "PRESENT"
            elif work_hours >= half_day_hours:
                status = "HALF_DAY"
            else:
                status = "ABSENT" 
        else:
            if punch_in or punch_out:
                status = "HALF_DAY"
            else:
                status = "ABSENT"

    # Only calculate late/early if they actually attended
    is_late = 0
    if punch_in and status in ("PRESENT", "HALF_DAY"):
        is_late = 1 if _time_to_minutes(punch_in) > _time_to_minutes(late_thresh) else 0

    left_early = 0
    if punch_out and status in ("PRESENT", "HALF_DAY"):
        left_early = 1 if _time_to_minutes(punch_out) < _time_to_minutes(early_thresh) else 0

    return AttendanceRecord(
        report_file=report_file,
        report_period_start=period_start,
        report_period_end=period_end,
        company_name=company,
        emp_code=str(emp_code).strip(),
        emp_name=str(emp_name).strip(),
        work_date=work_date,
        status=status,
        punch_in=punch_in,
        punch_out=punch_out,
        work_hours=work_hours,
        is_late=is_late,
        left_early=left_early,
    )


# ---------------------------------------------------------------------------
# Raw row reader — abstracts xlrd vs openpyxl
# ---------------------------------------------------------------------------

def _read_raw_rows(filepath: str):
    """
    Returns (list_of_rows, nrows, ncols) where each row is a list of strings.
    Tries xlrd first (.xls), then openpyxl (.xlsx/.xlsm).
    """
    ext = os.path.splitext(filepath)[1].lower()
    rows = []

    if ext in (".xls",):
        import xlrd
        wb = xlrd.open_workbook(filepath)
        ws = wb.sheets()[0]
        for r in range(ws.nrows):
            row = []
            for c in range(ws.ncols):
                v = ws.cell_value(r, c)
                row.append(str(v) if v != "" else "")
            rows.append(row)
    else:
        # openpyxl for .xlsx / .xlsm
        import openpyxl
        wb = openpyxl.load_workbook(filepath, data_only=True)
        ws = wb.active
        for row in ws.iter_rows(values_only=True):
            rows.append([str(c) if c is not None else "" for c in row])

    return rows


# ---------------------------------------------------------------------------
# Main parse function
# ---------------------------------------------------------------------------

def parse_file(
    filepath: str,
    late_threshold: str = DEFAULT_LATE_THRESHOLD,
    early_threshold: str = DEFAULT_EARLY_LEAVE,
    full_day_hours: float = 5.5,
    half_day_hours: float = 3.5,
) -> ParseResult:
    """
    Parse an attendance XLS/XLSX file and return a ParseResult.
    Raises ValueError with a descriptive message on fatal errors.
    """
    filename = os.path.basename(filepath)

    try:
        rows = _read_raw_rows(filepath)
    except Exception as e:
        raise ValueError(f"Cannot read file '{filename}': {e}")

    # -----------------------------------------------------------------------
    # Phase 1: extract metadata from header rows
    # -----------------------------------------------------------------------
    company_name = ""
    location = ""
    period_start: Optional[date] = None
    period_end: Optional[date] = None
    title_found = False

    for row in rows[:10]:
        joined = " ".join(r for r in row if r.strip())
        if not title_found and "Period" in joined and ("To" in joined or "to" in joined):
            period_start, period_end = _parse_period(joined)
            title_found = True
        if "Company Name" in joined and not company_name:
            # Extract after the colon
            m = re.search(r"Company Name\s*:\s*(.+?)(?:\s{3,}|$)", joined)
            if m:
                company_name = m.group(1).strip()
        if "Location" in joined and not location:
            m = re.search(r"Location\s*:\s*(.+?)(?:\s{3,}|$)", joined)
            if m:
                location = m.group(1).strip()

    # -----------------------------------------------------------------------
    # Phase 2: find all header rows (Emp Code rows) and data segments
    # -----------------------------------------------------------------------
    # A header row has 'Emp Code' (or similar) in col 0 and date numbers in cols 4+

    def _is_header_row(row):
        """Return True if this row looks like the column header row."""
        r0 = row[0].strip().lower() if row else ""
        return "emp code" in r0 or "emp. code" in r0

    def _is_date_header_row(row):
        """Return True if row has only date numbers (like '15 16 17...') no names."""
        non_empty = [c.strip() for c in row if c.strip()]
        if len(non_empty) < 3:
            return False
        return all(re.match(r"^\d{1,2}$", v) for v in non_empty)

    def _is_metadata_row(row):
        """Skip company/location/generated-by rows."""
        joined = " ".join(r for r in row if r.strip())
        return any(k in joined for k in ("Company Name", "Location", "Generated By", "Printed On"))

    def _is_empty_row(row):
        return not any(r.strip() for r in row)

    # -----------------------------------------------------------------------
    # Phase 3: Find header rows and extract date columns mapping
    # -----------------------------------------------------------------------
    # We need to build a list of (header_row_index, date_columns_map)
    # date_columns_map: {col_index: date}

    header_indices = []
    for i, row in enumerate(rows):
        if _is_header_row(row):
            header_indices.append(i)

    if not header_indices:
        raise ValueError(
            "Could not find the 'Emp Code' header row in this file. "
            "Please ensure this is an ONtime attendance export."
        )

    warnings: List[str] = []
    all_records: List[AttendanceRecord] = []

    def _build_date_map(header_row: list, period_start: Optional[date], period_end: Optional[date]):
        """
        Map column indices to actual dates.
        Columns 4+ contain day numbers (like '15', '16', …).
        Uses period_start year/month as reference.
        """
        date_map = {}
        for c in range(4, len(header_row)):
            v = header_row[c].strip()
            if re.match(r"^\d{1,2}$", v):
                day = int(v)
                if period_start:
                    # Determine if this day belongs to start month or spills into next
                    try:
                        candidate = date(period_start.year, period_start.month, day)
                        # If candidate < period_start, try next month
                        if candidate < period_start:
                            if period_start.month == 12:
                                candidate = date(period_start.year + 1, 1, day)
                            else:
                                candidate = date(period_start.year, period_start.month + 1, day)
                        date_map[c] = candidate
                    except ValueError:
                        # Invalid day for that month, try next month
                        try:
                            if period_start.month == 12:
                                candidate = date(period_start.year + 1, 1, day)
                            else:
                                candidate = date(period_start.year, period_start.month + 1, day)
                            date_map[c] = candidate
                        except ValueError:
                            pass
                else:
                    # No period info — store day as placeholder
                    date_map[c] = day  # will be int, handled below
        return date_map

    # -----------------------------------------------------------------------
    # Phase 4: Walk segments between header rows
    # -----------------------------------------------------------------------
    # Add a sentinel so last segment is processed
    header_indices_with_end = header_indices + [len(rows)]

    for seg_idx, h_idx in enumerate(header_indices):
        seg_end = header_indices_with_end[seg_idx + 1]
        header_row = rows[h_idx]
        date_map = _build_date_map(header_row, period_start, period_end)

        if not date_map:
            warnings.append(f"Header row at index {h_idx} has no recognisable date columns — skipped.")
            continue

        # Walk data rows in this segment
        for r_idx in range(h_idx + 1, seg_end):
            row = rows[r_idx]

            if _is_empty_row(row):
                continue
            if _is_metadata_row(row):
                continue
            if _is_header_row(row):
                continue
            if _is_date_header_row(row):
                continue

            emp_code = row[0].strip() if len(row) > 0 else ""
            emp_name = row[2].strip() if len(row) > 2 else ""

            # Skip rows that are clearly not employee rows
            if not emp_code or not re.match(r"^\d+", emp_code):
                continue
            if not emp_name:
                emp_name = f"Emp-{emp_code}"

            # Decode each date column
            for col, work_date in date_map.items():
                if col >= len(row):
                    continue
                cell_val = row[col]
                if not cell_val.strip():
                    continue

                # If work_date is an int (no period info), skip
                if isinstance(work_date, int):
                    warnings.append(
                        f"Could not resolve full date for day {work_date} — period info missing."
                    )
                    continue

                record = _decode_cell(
                    cell_val=cell_val,
                    late_thresh=late_threshold,
                    early_thresh=early_threshold,
                    full_day_hours=full_day_hours,
                    half_day_hours=half_day_hours,
                    work_date=work_date,
                    emp_code=emp_code,
                    emp_name=emp_name,

                    report_file=filename,
                    period_start=period_start,
                    period_end=period_end,
                    company=company_name,
                )
                if record:
                    all_records.append(record)

    if not all_records:
        raise ValueError(
            "No attendance records could be extracted from this file. "
            "The file may be empty, in an unsupported format, or all rows were skipped."
        )

    return ParseResult(
        filename=filename,
        company_name=company_name,
        location=location,
        period_start=period_start,
        period_end=period_end,
        records=all_records,
        warnings=warnings,
    )
