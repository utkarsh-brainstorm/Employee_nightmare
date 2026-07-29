"""
core/db.py
==========
SQLite database layer for AttendanceProcessor.

Tables:
  - attendance_raw   : normalised per-employee per-day records
  - employee_salary  : permanent salary info (survives re-imports)
  - import_log       : tracks which files have been imported
  - app_settings     : key/value settings (late threshold, working days, etc.)
"""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime, date
from typing import Any, Dict, List, Optional, Tuple

from core.parser import AttendanceRecord, ParseResult

# ---------------------------------------------------------------------------
# DB Location — stored in the data/ subdir next to main.py
# ---------------------------------------------------------------------------

_DB_PATH: Optional[str] = None


def set_db_path(path: str) -> None:
    global _DB_PATH
    _DB_PATH = path


def get_db_path() -> str:
    if _DB_PATH:
        return _DB_PATH
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "data", "attendance.db")


def _connect() -> sqlite3.Connection:
    db_path = get_db_path()
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS attendance_raw (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    report_file          TEXT NOT NULL,
    report_period_start  DATE,
    report_period_end    DATE,
    company_name         TEXT,
    emp_code             TEXT NOT NULL,
    emp_name             TEXT NOT NULL,
    work_date            DATE NOT NULL,
    status               TEXT NOT NULL,
    punch_in             TEXT,
    punch_out            TEXT,
    work_hours           REAL,
    is_late              INTEGER DEFAULT 0,
    left_early           INTEGER DEFAULT 0,
    UNIQUE(emp_code, work_date, report_file)
);

CREATE TABLE IF NOT EXISTS employee_salary (
    emp_code           TEXT PRIMARY KEY,
    emp_name           TEXT,
    emp_name_override  TEXT,
    monthly_salary     REAL DEFAULT 0,
    daily_rate         REAL GENERATED ALWAYS AS (
                          CASE WHEN monthly_salary > 0 THEN ROUND(monthly_salary / 26.0, 2) ELSE 0 END
                       ) VIRTUAL,
    working_days       INTEGER DEFAULT 26,
    updated_at         DATETIME
);

CREATE TABLE IF NOT EXISTS import_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    filename        TEXT NOT NULL,
    imported_at     DATETIME NOT NULL,
    rows_imported   INTEGER,
    period_start    DATE,
    period_end      DATE,
    company_name    TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS query_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sql_text   TEXT NOT NULL,
    ran_at     DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
    row_count  INTEGER DEFAULT 0,
    source     TEXT DEFAULT 'manual'
);

CREATE INDEX IF NOT EXISTS idx_att_emp_code   ON attendance_raw(emp_code);
CREATE INDEX IF NOT EXISTS idx_att_work_date  ON attendance_raw(work_date);
CREATE INDEX IF NOT EXISTS idx_att_status     ON attendance_raw(status);
CREATE INDEX IF NOT EXISTS idx_att_emp_date   ON attendance_raw(emp_code, work_date);
"""


def init_db() -> None:
    """Create tables if they do not exist. Safe to call multiple times."""
    conn = _connect()
    try:
        conn.executescript(_SCHEMA)
        conn.commit()
        # Seed default settings if not present
        defaults = {
            "late_threshold":          "09:15",
            "early_leave_threshold":   "15:30",
            "working_days_per_month":  "26",
            "checkin_time":            "09:00",
            "checkout_time":           "15:30",
        }
        for key, val in defaults.items():
            conn.execute(
                "INSERT OR IGNORE INTO app_settings(key, value) VALUES (?, ?)", (key, val)
            )
        # Migrate: add emp_name_override column if missing (safe on existing DBs)
        try:
            conn.execute("ALTER TABLE employee_salary ADD COLUMN emp_name_override TEXT")
            conn.commit()
        except Exception:
            pass  # Column already exists

        # Migrate: add query_log table if not exists (safe on old DBs)
        try:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS query_log (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    sql_text   TEXT NOT NULL,
                    ran_at     DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
                    row_count  INTEGER DEFAULT 0,
                    source     TEXT DEFAULT 'manual'
                );
            """)
        except Exception:
            pass

        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def get_setting(key: str, default: str = "") -> str:
    conn = _connect()
    try:
        row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default
    finally:
        conn.close()


def set_setting(key: str, value: str) -> None:
    conn = _connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (key, value)
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

def check_already_imported(filename: str) -> Optional[Dict]:
    """Returns import log row if this filename was already imported, else None."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM import_log WHERE filename=? ORDER BY imported_at DESC LIMIT 1",
            (filename,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def import_records(result: ParseResult, overwrite: bool = False) -> Tuple[int, int]:
    """
    Import ParseResult records into attendance_raw.
    Returns (inserted_count, skipped_count).
    If overwrite=True, deletes old records for this file first.
    """
    conn = _connect()
    inserted = 0
    skipped = 0
    try:
        if overwrite:
            conn.execute(
                "DELETE FROM attendance_raw WHERE report_file=?", (result.filename,)
            )
            conn.commit()

        for rec in result.records:
            try:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO attendance_raw
                    (report_file, report_period_start, report_period_end, company_name,
                     emp_code, emp_name, work_date, status, punch_in, punch_out,
                     work_hours, is_late, left_early)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        rec.report_file,
                        str(rec.report_period_start) if rec.report_period_start else None,
                        str(rec.report_period_end) if rec.report_period_end else None,
                        rec.company_name,
                        rec.emp_code,
                        rec.emp_name,
                        str(rec.work_date),
                        rec.status,
                        rec.punch_in,
                        rec.punch_out,
                        rec.work_hours,
                        rec.is_late,
                        rec.left_early,
                    ),
                )
                if conn.execute("SELECT changes()").fetchone()[0]:
                    inserted += 1
                else:
                    skipped += 1
            except sqlite3.Error:
                skipped += 1

        # Log the import
        conn.execute(
            """
            INSERT INTO import_log (filename, imported_at, rows_imported, period_start, period_end, company_name)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                result.filename,
                datetime.now().isoformat(),
                inserted,
                str(result.period_start) if result.period_start else None,
                str(result.period_end) if result.period_end else None,
                result.company_name,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return inserted, skipped


# ---------------------------------------------------------------------------
# Salary
# ---------------------------------------------------------------------------

def get_all_employees() -> List[Dict]:
    """Returns all employees known from attendance_raw, merged with salary data."""
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT
                a.emp_code,
                a.emp_name,
                COALESCE(s.emp_name_override, '') AS emp_name_override,
                COALESCE(s.monthly_salary, 0)     AS monthly_salary,
                COALESCE(s.working_days, 26)      AS working_days,
                s.updated_at
            FROM (
                SELECT emp_code, emp_name,
                       ROW_NUMBER() OVER (PARTITION BY emp_code ORDER BY work_date DESC) AS rn
                FROM attendance_raw
            ) a
            LEFT JOIN employee_salary s ON a.emp_code = s.emp_code
            WHERE a.rn = 1
            ORDER BY CAST(a.emp_code AS INTEGER)
            """
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_display_name(emp_code: str, fallback: str) -> str:
    """Returns the user-entered full name for emp_code, or the fallback (truncated) name."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT emp_name_override FROM employee_salary WHERE emp_code=?",
            (emp_code,)
        ).fetchone()
        if row and row[0] and str(row[0]).strip():
            return str(row[0]).strip()
        return fallback
    finally:
        conn.close()


def upsert_salary(
    emp_code: str,
    emp_name: str,
    monthly_salary: float,
    working_days: int = 26,
    emp_name_override: str = "",
) -> None:
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO employee_salary
              (emp_code, emp_name, emp_name_override, monthly_salary, working_days, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(emp_code) DO UPDATE SET
                emp_name          = excluded.emp_name,
                emp_name_override = excluded.emp_name_override,
                monthly_salary    = excluded.monthly_salary,
                working_days      = excluded.working_days,
                updated_at        = excluded.updated_at
            """,
            (emp_code, emp_name, emp_name_override or "",
             monthly_salary, working_days, datetime.now().isoformat()),
        )
        conn.commit()
    finally:
        conn.close()


def bulk_upsert_salaries(salary_rows: List[Dict]) -> None:
    """Save multiple salary rows at once. Each dict: emp_code, emp_name, monthly_salary, working_days."""
    conn = _connect()
    try:
        for row in salary_rows:
            conn.execute(
                """
                INSERT INTO employee_salary (emp_code, emp_name, monthly_salary, working_days, updated_at)
                VALUES (:emp_code, :emp_name, :monthly_salary, :working_days, :updated_at)
                ON CONFLICT(emp_code) DO UPDATE SET
                    emp_name       = excluded.emp_name,
                    monthly_salary = excluded.monthly_salary,
                    working_days   = excluded.working_days,
                    updated_at     = excluded.updated_at
                """,
                {**row, "updated_at": datetime.now().isoformat()},
            )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Generic query executor
# ---------------------------------------------------------------------------

def execute_query(sql: str, params: tuple = ()) -> Tuple[List[str], List[Dict]]:
    """
    Execute any SELECT SQL. Returns (column_names, rows).
    Raises sqlite3.OperationalError on bad SQL (let caller handle).
    Non-SELECT queries are blocked for safety.
    """
    stripped = sql.strip().upper()
    # Allow SELECT, WITH (CTEs), and PRAGMA selects
    if not (stripped.startswith("SELECT") or stripped.startswith("WITH") or stripped.startswith("PRAGMA")):
        raise ValueError(
            "Only SELECT queries are allowed here.\n"
            "To modify data, use the Import or Salary sections of the application."
        )

    conn = _connect()
    try:
        cur = conn.execute(sql, params)
        cols = [d[0] for d in cur.description] if cur.description else []
        rows = [dict(r) for r in cur.fetchall()]
        log_query(sql.strip(), len(rows), source="manual")
        return cols, rows
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Pre-built summary queries (used by quick panel)
# ---------------------------------------------------------------------------

def query_monthly_summary(period_start: str = None, period_end: str = None) -> Tuple[List[str], List[Dict]]:
    where = ""
    params = []
    if period_start and period_end:
        where = "WHERE a.work_date BETWEEN ? AND ?"
        params = [period_start, period_end]
    elif period_start:
        where = "WHERE a.work_date >= ?"
        params = [period_start]

    sql = f"""
    SELECT
        a.emp_code                                        AS "Emp Code",
        a.emp_name                                        AS "Name",
        COUNT(CASE WHEN a.status='PRESENT'    THEN 1 END) AS "Present",
        COUNT(CASE WHEN a.status='ABSENT'     THEN 1 END) AS "Absent",
        COUNT(CASE WHEN a.status='WEEKLY_OFF' THEN 1 END) AS "Weekly Off",
        COUNT(CASE WHEN a.status='HALF_DAY'   THEN 1 END) AS "Half Day",
        COUNT(CASE WHEN a.is_late=1           THEN 1 END) AS "Late Days",
        COUNT(CASE WHEN a.left_early=1        THEN 1 END) AS "Early Leaves",
        ROUND(AVG(CASE WHEN a.work_hours IS NOT NULL THEN a.work_hours END), 2) AS "Avg Hours/Day",
        ROUND(SUM(COALESCE(a.work_hours, 0)), 2)          AS "Total Hours"
    FROM attendance_raw a
    {where}
    GROUP BY a.emp_code, a.emp_name
    ORDER BY CAST(a.emp_code AS INTEGER)
    """
    return execute_query(sql, tuple(params))


def query_late_arrivals(date_start: str = None, date_end: str = None) -> Tuple[List[str], List[Dict]]:
    where_parts = ["a.is_late = 1", "a.status IN ('PRESENT', 'HALF_DAY')"]
    params = []
    if date_start:
        where_parts.append("a.work_date >= ?")
        params.append(date_start)
    if date_end:
        where_parts.append("a.work_date <= ?")
        params.append(date_end)
    where = "WHERE " + " AND ".join(where_parts)

    sql = f"""
    SELECT
        a.emp_code AS "Emp Code", a.emp_name AS "Name",
        a.work_date AS "Date", a.punch_in AS "Arrived At", a.punch_out AS "Left At",
        a.work_hours AS "Hours Worked"
    FROM attendance_raw a
    {where}
    ORDER BY a.work_date, a.emp_name
    """
    return execute_query(sql, tuple(params))


def query_early_leavers(date_start: str = None, date_end: str = None) -> Tuple[List[str], List[Dict]]:
    where_parts = ["a.left_early = 1", "a.status = 'PRESENT'"]
    params = []
    if date_start:
        where_parts.append("a.work_date >= ?")
        params.append(date_start)
    if date_end:
        where_parts.append("a.work_date <= ?")
        params.append(date_end)
    where = "WHERE " + " AND ".join(where_parts)

    sql = f"""
    SELECT
        a.emp_code AS "Emp Code", a.emp_name AS "Name",
        a.work_date AS "Date", a.punch_in AS "Arrived At", a.punch_out AS "Left At",
        a.work_hours AS "Hours Worked"
    FROM attendance_raw a
    {where}
    ORDER BY a.work_date, a.emp_name
    """
    return execute_query(sql, tuple(params))


def query_absentees(date_start: str = None, date_end: str = None) -> Tuple[List[str], List[Dict]]:
    where_parts = ["a.status = 'ABSENT'"]
    params = []
    if date_start:
        where_parts.append("a.work_date >= ?")
        params.append(date_start)
    if date_end:
        where_parts.append("a.work_date <= ?")
        params.append(date_end)
    where = "WHERE " + " AND ".join(where_parts)

    sql = f"""
    SELECT
        a.emp_code AS "Emp Code", a.emp_name AS "Name", a.work_date AS "Absent Date"
    FROM attendance_raw a
    {where}
    ORDER BY a.work_date, a.emp_name
    """
    return execute_query(sql, tuple(params))


def query_salary_report(period_start: str = None, period_end: str = None) -> Tuple[List[str], List[Dict]]:
    where = ""
    params = []
    if period_start and period_end:
        where = "WHERE a.work_date BETWEEN ? AND ?"
        params = [period_start, period_end]

    sql = f"""
    SELECT
        a.emp_code                                         AS "Emp Code",
        a.emp_name                                         AS "Name",
        COUNT(CASE WHEN a.status='PRESENT'    THEN 1 END)  AS "Days Present",
        COUNT(CASE WHEN a.status='HALF_DAY'   THEN 1 END)  AS "Half Days",
        COUNT(CASE WHEN a.status='ABSENT'     THEN 1 END)  AS "Days Absent",
        COALESCE(s.monthly_salary, 0)                      AS "Monthly Salary (₹)",
        COALESCE(s.working_days, 26)                       AS "Working Days",
        CASE
            WHEN COALESCE(s.monthly_salary, 0) > 0
            THEN ROUND(
                (s.monthly_salary / s.working_days) *
                (COUNT(CASE WHEN a.status='PRESENT' THEN 1 END) +
                 COUNT(CASE WHEN a.status='HALF_DAY' THEN 1 END) * 0.5),
                2)
            ELSE 'N/A (Salary not set)'
        END AS "Earned Salary (₹)"
    FROM attendance_raw a
    LEFT JOIN employee_salary s ON a.emp_code = s.emp_code
    {where}
    GROUP BY a.emp_code, a.emp_name
    ORDER BY CAST(a.emp_code AS INTEGER)
    """
    return execute_query(sql, tuple(params))


def query_perfect_attendance(period_start: str = None, period_end: str = None) -> Tuple[List[str], List[Dict]]:
    where = ""
    params = []
    if period_start and period_end:
        where = "WHERE a.work_date BETWEEN ? AND ?"
        params = [period_start, period_end]

    sql = f"""
    SELECT
        a.emp_code AS "Emp Code", a.emp_name AS "Name",
        COUNT(*) AS "Total Days Recorded",
        COUNT(CASE WHEN a.status='PRESENT' THEN 1 END) AS "Days Present"
    FROM attendance_raw a
    {where}
    GROUP BY a.emp_code, a.emp_name
    HAVING COUNT(CASE WHEN a.status='ABSENT' THEN 1 END) = 0
       AND COUNT(CASE WHEN a.status='HALF_DAY' THEN 1 END) = 0
    ORDER BY a.emp_name
    """
    return execute_query(sql, tuple(params))


def query_chronic_absentees(min_absences: int = 3, period_start: str = None, period_end: str = None) -> Tuple[List[str], List[Dict]]:
    where = ""
    params = []
    if period_start and period_end:
        where = "WHERE a.work_date BETWEEN ? AND ?"
        params = [period_start, period_end]

    sql = f"""
    SELECT
        a.emp_code AS "Emp Code", a.emp_name AS "Name",
        COUNT(CASE WHEN a.status='ABSENT' THEN 1 END) AS "Days Absent",
        COUNT(CASE WHEN a.status='PRESENT' THEN 1 END) AS "Days Present",
        COUNT(*) AS "Total Days"
    FROM attendance_raw a
    {where}
    GROUP BY a.emp_code, a.emp_name
    HAVING COUNT(CASE WHEN a.status='ABSENT' THEN 1 END) >= {int(min_absences)}
    ORDER BY "Days Absent" DESC
    """
    return execute_query(sql, tuple(params))


def query_full_grid(period_start: str = None, period_end: str = None) -> Tuple[List[str], List[Dict]]:
    """Returns a flat attendance grid (emp vs date)."""
    where = ""
    params = []
    if period_start and period_end:
        where = "AND a.work_date BETWEEN ? AND ?"
        params = [period_start, period_end]

    sql = f"""
    SELECT
        a.emp_code AS "Emp Code",
        a.emp_name AS "Name",
        a.work_date AS "Date",
        a.status AS "Status",
        a.punch_in AS "In",
        a.punch_out AS "Out",
        a.work_hours AS "Hours"
    FROM attendance_raw a
    WHERE 1=1 {where}
    ORDER BY a.work_date, CAST(a.emp_code AS INTEGER)
    """
    return execute_query(sql, tuple(params))


def get_date_range() -> Tuple[Optional[str], Optional[str]]:
    """Returns (min_date, max_date) of all records in the DB."""
    conn = _connect()
    try:
        row = conn.execute("SELECT MIN(work_date), MAX(work_date) FROM attendance_raw").fetchone()
        return row[0], row[1]
    finally:
        conn.close()


def get_import_history() -> List[Dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM import_log ORDER BY imported_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Query Log
# ---------------------------------------------------------------------------

def log_query(sql: str, row_count: int = 0, source: str = "manual") -> None:
    """Insert a query into the log, keeping only the last 100 entries."""
    # Skip trivial / meta queries
    sql_stripped = sql.strip()
    if not sql_stripped or len(sql_stripped) < 10:
        return
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO query_log (sql_text, row_count, source) VALUES (?, ?, ?)",
            (sql_stripped, row_count, source)
        )
        # Prune to last 100
        conn.execute("""
            DELETE FROM query_log WHERE id NOT IN (
                SELECT id FROM query_log ORDER BY id DESC LIMIT 100
            )
        """)
        conn.commit()
    finally:
        conn.close()


def get_query_log() -> List[Dict]:
    """Return the last 100 logged queries, newest first."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, sql_text, ran_at, row_count, source FROM query_log ORDER BY id DESC LIMIT 100"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def clear_query_log() -> None:
    """Delete all query log entries."""
    conn = _connect()
    try:
        conn.execute("DELETE FROM query_log")
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Known employees snapshot (for diff on import)
# ---------------------------------------------------------------------------

def get_known_emp_codes() -> Dict[str, str]:
    """Return {emp_code: emp_name} for all employees in employee_salary."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT emp_code, COALESCE(emp_name_override, emp_name, emp_code) AS display FROM employee_salary"
        ).fetchall()
        return {r['emp_code']: r['display'] for r in rows}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Last import tracking
# ---------------------------------------------------------------------------

def get_last_import() -> Optional[Dict]:
    """Return the most recent import_log row, with filepath_hint if stored."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM import_log ORDER BY imported_at DESC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        result = dict(row)
        # Also try to fetch the stored filepath
        fp = conn.execute(
            "SELECT value FROM app_settings WHERE key='last_import_filepath'"
        ).fetchone()
        result['filepath_hint'] = fp['value'] if fp else ''
        return result
    finally:
        conn.close()


def store_last_filepath(filepath: str) -> None:
    """Remember the full filepath of the most recently imported file."""
    conn = _connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO app_settings(key, value) VALUES ('last_import_filepath', ?)",
            (filepath,)
        )
        conn.commit()
    finally:
        conn.close()
