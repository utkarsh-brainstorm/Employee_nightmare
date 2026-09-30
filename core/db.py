"""
core/db.py
==========
SQLite database layer for AttendanceProcessor Pro (V12).

Tables:
  - attendance_raw        : normalised per-employee per-day records
  - employee_salary       : permanent salary info (survives re-imports)
  - employee_day_overrides: per-employee per-day in/out time overrides
  - import_log            : tracks which files have been imported
  - app_settings          : key/value settings
  - calendar_days         : holidays, weekly-offs, and optional day-specific times
  - query_log             : audit trail of executed queries
"""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime, date
from typing import Any, Dict, List, Optional, Tuple

from core.parser import AttendanceRecord, ParseResult

# ---------------------------------------------------------------------------
# DB Location
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
    work_minutes         INTEGER,
    is_late              INTEGER DEFAULT 0,
    left_early           INTEGER DEFAULT 0,
    source               TEXT DEFAULT 'excel',
    UNIQUE(emp_code, work_date, report_file)
);

CREATE TABLE IF NOT EXISTS employee_salary (
    emp_code           TEXT PRIMARY KEY,
    emp_name           TEXT,
    emp_name_override  TEXT,
    monthly_salary     REAL DEFAULT 0,
    custom_arrival     TEXT,
    custom_departure   TEXT,
    uses_transport     INTEGER DEFAULT 0,
    is_disabled        INTEGER DEFAULT 0,
    updated_at         DATETIME
);

CREATE TABLE IF NOT EXISTS employee_day_overrides (
    emp_code   TEXT NOT NULL,
    date       DATE NOT NULL,
    custom_in  TEXT,
    custom_out TEXT,
    PRIMARY KEY (emp_code, date)
);

CREATE TABLE IF NOT EXISTS calendar_days (
    date      DATE PRIMARY KEY,
    day_type  TEXT NOT NULL,
    day_in    TEXT,
    day_out   TEXT
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
CREATE INDEX IF NOT EXISTS idx_edo_emp_date   ON employee_day_overrides(emp_code, date);
"""


def init_db() -> None:
    """Create tables if they do not exist. Safe to call multiple times."""
    conn = _connect()
    try:
        conn.executescript(_SCHEMA)
        conn.commit()

        # Seed default settings
        defaults = {
            "late_threshold":          "09:15",
            "early_leave_threshold":   "15:30",
            "checkin_time":            "09:00",
            "checkout_time":           "15:30",
            "holidays_paid":           "yes",
            "weeklyoff_paid":          "yes",
        }
        for key, val in defaults.items():
            conn.execute(
                "INSERT OR IGNORE INTO app_settings(key, value) VALUES (?, ?)", (key, val)
            )

        # ── Migrations (safe on existing DBs) ──────────────────────────────

        for col_sql in [
            "ALTER TABLE employee_salary ADD COLUMN emp_name_override TEXT",
            "ALTER TABLE employee_salary ADD COLUMN is_disabled INTEGER DEFAULT 0",
            "ALTER TABLE employee_salary ADD COLUMN custom_arrival TEXT",
            "ALTER TABLE employee_salary ADD COLUMN custom_departure TEXT",
            "ALTER TABLE employee_salary ADD COLUMN uses_transport INTEGER DEFAULT 0",
            "ALTER TABLE attendance_raw ADD COLUMN source TEXT DEFAULT 'excel'",
            "ALTER TABLE attendance_raw ADD COLUMN work_minutes INTEGER",
            "ALTER TABLE attendance_raw ADD COLUMN req_in TEXT",
            "ALTER TABLE attendance_raw ADD COLUMN req_out TEXT",
            "ALTER TABLE calendar_days ADD COLUMN day_in TEXT",
            "ALTER TABLE calendar_days ADD COLUMN day_out TEXT",
        ]:
            try:
                conn.execute(col_sql)
            except Exception:
                pass

        # Migrate work_hours -> work_minutes for existing rows
        try:
            conn.execute("""
                UPDATE attendance_raw
                SET work_minutes = CAST(ROUND(work_hours * 60) AS INTEGER)
                WHERE work_minutes IS NULL AND work_hours IS NOT NULL
            """)
        except Exception:
            pass

        # Create new tables if they were missing
        try:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS query_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sql_text TEXT NOT NULL,
                    ran_at DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
                    row_count INTEGER DEFAULT 0,
                    source TEXT DEFAULT 'manual'
                );
                CREATE TABLE IF NOT EXISTS calendar_days (
                    date DATE PRIMARY KEY,
                    day_type TEXT NOT NULL,
                    day_in TEXT,
                    day_out TEXT
                );
                CREATE TABLE IF NOT EXISTS employee_day_overrides (
                    emp_code TEXT NOT NULL,
                    date DATE NOT NULL,
                    custom_in TEXT,
                    custom_out TEXT,
                    PRIMARY KEY (emp_code, date)
                );
            """)
        except Exception:
            pass

        # Deduplicate attendance_raw (keep most relevant row)
        try:
            conn.execute("""
                DELETE FROM attendance_raw WHERE id NOT IN (
                    SELECT COALESCE(
                        MAX(CASE WHEN source='manual' THEN id END),
                        MAX(id)
                    )
                    FROM attendance_raw
                    GROUP BY emp_code, work_date
                )
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
    """
    import shutil
    import glob
    db_path = get_db_path()
    if os.path.exists(db_path):
        backup_dir = os.path.join(os.path.dirname(db_path), "backups")
        os.makedirs(backup_dir, exist_ok=True)
        backup_name = f"attendance_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
        try:
            shutil.copy2(db_path, os.path.join(backup_dir, backup_name))
            backups = sorted(glob.glob(os.path.join(backup_dir, "attendance_backup_*.db")))
            while len(backups) > 12:
                oldest = backups.pop(0)
                os.remove(oldest)
        except Exception:
            pass

    conn = _connect()
    inserted = 0
    skipped = 0
    try:
        if overwrite:
            conn.execute(
                "DELETE FROM attendance_raw WHERE report_file=? AND source='excel'",
                (result.filename,)
            )
            conn.commit()

        for rec in result.records:
            try:
                existing = conn.execute(
                    "SELECT id, punch_in, punch_out FROM attendance_raw WHERE emp_code=? AND work_date=?",
                    (rec.emp_code, str(rec.work_date))
                ).fetchone()

                if existing:
                    if not existing["punch_in"] or not existing["punch_out"]:
                        conn.execute(
                            """
                            UPDATE attendance_raw
                            SET punch_in=?, punch_out=?, work_hours=?, work_minutes=?,
                                status=?, is_late=?, left_early=?
                            WHERE id=?
                            """,
                            (
                                existing["punch_in"] or rec.punch_in,
                                existing["punch_out"] or rec.punch_out,
                                rec.work_hours,
                                rec.work_minutes,
                                rec.status,
                                rec.is_late,
                                rec.left_early,
                                existing["id"]
                            )
                        )
                    skipped += 1
                else:
                    conn.execute(
                        """
                        INSERT INTO attendance_raw
                        (report_file, report_period_start, report_period_end, company_name,
                         emp_code, emp_name, work_date, status, punch_in, punch_out,
                         work_hours, work_minutes, is_late, left_early, source)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'excel')
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
                            rec.work_minutes,
                            rec.is_late,
                            rec.left_early,
                        ),
                    )
                    inserted += 1
            except sqlite3.Error:
                skipped += 1

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

    # Recompute req_in/req_out/is_late/left_early for all newly imported employees
    try:
        from core.recompute import recompute_for_employee
        emp_codes = {rec.emp_code for rec in result.records}
        for ec in emp_codes:
            recompute_for_employee(ec)
    except Exception:
        pass

    return inserted, skipped


# ---------------------------------------------------------------------------
# Employee / Salary overrides
# ---------------------------------------------------------------------------

def get_all_employees() -> List[Dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT
                a.emp_code,
                a.emp_name,
                COALESCE(s.emp_name_override, '') AS emp_name_override,
                COALESCE(s.monthly_salary, 0)     AS monthly_salary,
                COALESCE(s.is_disabled, 0)        AS is_disabled,
                COALESCE(s.uses_transport, 0)     AS uses_transport,
                s.custom_arrival,
                s.custom_departure,
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
    emp_name_override: str = "",
    custom_arrival: Optional[str] = None,
    custom_departure: Optional[str] = None,
    uses_transport: int = 0,
) -> None:
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO employee_salary
              (emp_code, emp_name, emp_name_override, monthly_salary,
               custom_arrival, custom_departure, uses_transport, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(emp_code) DO UPDATE SET
                emp_name          = excluded.emp_name,
                emp_name_override = excluded.emp_name_override,
                monthly_salary    = excluded.monthly_salary,
                custom_arrival    = excluded.custom_arrival,
                custom_departure  = excluded.custom_departure,
                uses_transport    = excluded.uses_transport,
                updated_at        = excluded.updated_at
            """,
            (emp_code, emp_name, emp_name_override or "",
             monthly_salary, custom_arrival, custom_departure,
             uses_transport, datetime.now().isoformat()),
        )
        conn.commit()
    finally:
        conn.close()

    # Recompute all attendance flags for this employee (schedule may have changed)
    try:
        from core.recompute import recompute_for_employee
        recompute_for_employee(emp_code)
    except Exception:
        pass


def toggle_employee_disabled(emp_code: str, is_disabled: int) -> None:
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO employee_salary (emp_code, is_disabled, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(emp_code) DO UPDATE SET is_disabled = excluded.is_disabled
            """,
            (emp_code, is_disabled, datetime.now().isoformat())
        )
        conn.commit()
    finally:
        conn.close()


def upsert_manual_punch(
    emp_code: str, work_date: str,
    punch_in: str, punch_out: str,
    status: str, work_minutes: int,
    is_late: int, left_early: int,
    emp_name: str = "Manual"
) -> None:
    conn = _connect()
    try:
        conn.execute(
            "DELETE FROM attendance_raw WHERE emp_code=? AND work_date=?",
            (emp_code, work_date)
        )
        conn.execute(
            """
            INSERT INTO attendance_raw
            (report_file, report_period_start, report_period_end, company_name,
             emp_code, emp_name, work_date, status, punch_in, punch_out,
             work_hours, work_minutes, is_late, left_early, source)
            VALUES ('Manual Entry', ?, ?, 'Manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
            """,
            (
                work_date, work_date,
                emp_code, emp_name, work_date,
                status, punch_in, punch_out,
                round(work_minutes / 60.0, 2),  # keep work_hours in sync
                work_minutes,
                is_late, left_early,
            )
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Employee Day Overrides (per-employee per-day in/out time)
# ---------------------------------------------------------------------------

def upsert_employee_day_override(
    emp_code: str, date_str: str,
    custom_in: Optional[str], custom_out: Optional[str]
) -> None:
    conn = _connect()
    try:
        if not custom_in and not custom_out:
            conn.execute(
                "DELETE FROM employee_day_overrides WHERE emp_code=? AND date=?",
                (emp_code, date_str)
            )
        else:
            conn.execute(
                """
                INSERT INTO employee_day_overrides (emp_code, date, custom_in, custom_out)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(emp_code, date) DO UPDATE SET
                    custom_in  = excluded.custom_in,
                    custom_out = excluded.custom_out
                """,
                (emp_code, date_str, custom_in or None, custom_out or None)
            )
        conn.commit()
    finally:
        conn.close()

    # Recompute flags for this employee on this specific date
    try:
        from core.recompute import recompute_single
        recompute_single(emp_code, date_str)
    except Exception:
        pass


def get_employee_day_overrides(emp_code: str) -> List[Dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT date, custom_in, custom_out FROM employee_day_overrides WHERE emp_code=? ORDER BY date",
            (emp_code,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_employee_day_override_single(emp_code: str, date_str: str) -> Optional[Dict]:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT custom_in, custom_out FROM employee_day_overrides WHERE emp_code=? AND date=?",
            (emp_code, date_str)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Calendar (Holidays / Weekly Offs / Day-Specific Times)
# ---------------------------------------------------------------------------

def toggle_calendar_day(
    date_str: str, day_type: str,
    day_in: Optional[str] = None,
    day_out: Optional[str] = None
) -> None:
    conn = _connect()
    try:
        if not day_type:
            conn.execute("DELETE FROM calendar_days WHERE date=?", (date_str,))
        else:
            conn.execute(
                """
                INSERT INTO calendar_days (date, day_type, day_in, day_out)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(date) DO UPDATE SET
                    day_type = excluded.day_type,
                    day_in   = excluded.day_in,
                    day_out  = excluded.day_out
                """,
                (date_str, day_type, day_in or None, day_out or None)
            )
        conn.commit()
    finally:
        conn.close()

    # Recompute flags for ALL employees on this date
    try:
        from core.recompute import recompute_for_date
        recompute_for_date(date_str)
    except Exception:
        pass


def get_calendar_days(year: int, month: int) -> List[Dict]:
    conn = _connect()
    try:
        start = f"{year:04d}-{month:02d}-01"
        end   = f"{year:04d}-{month:02d}-31"
        rows = conn.execute(
            "SELECT date, day_type, day_in, day_out FROM calendar_days WHERE date BETWEEN ? AND ?",
            (start, end)
        ).fetchall()
        return [{"date": r["date"], "day_type": r["day_type"],
                 "day_in": r["day_in"], "day_out": r["day_out"]} for r in rows]
    finally:
        conn.close()


def get_calendar_day(date_str: str) -> Optional[Dict]:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT date, day_type, day_in, day_out FROM calendar_days WHERE date=?",
            (date_str,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_calendar_range(start_date: str, end_date: str) -> List[Dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT date, day_type, day_in, day_out FROM calendar_days WHERE date BETWEEN ? AND ?",
            (start_date, end_date)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Generic query executor
# ---------------------------------------------------------------------------

def execute_query(sql: str, params: tuple = ()) -> Tuple[List[str], List[Dict]]:
    stripped = sql.strip().upper()
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


def get_date_range() -> Tuple[Optional[str], Optional[str]]:
    conn = _connect()
    try:
        row = conn.execute("SELECT MIN(work_date), MAX(work_date) FROM attendance_raw").fetchone()
        return row[0], row[1]
    finally:
        conn.close()


def get_import_history() -> List[Dict]:
    conn = _connect()
    try:
        rows = conn.execute("SELECT * FROM import_log ORDER BY imported_at DESC").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Query Log
# ---------------------------------------------------------------------------

def log_query(sql: str, row_count: int = 0, source: str = "manual") -> None:
    sql_stripped = sql.strip()
    if not sql_stripped or len(sql_stripped) < 10:
        return
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO query_log (sql_text, row_count, source) VALUES (?, ?, ?)",
            (sql_stripped, row_count, source)
        )
        conn.execute("""
            DELETE FROM query_log WHERE id NOT IN (
                SELECT id FROM query_log ORDER BY id DESC LIMIT 100
            )
        """)
        conn.commit()
    finally:
        conn.close()


def get_query_log() -> List[Dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, sql_text, ran_at, row_count, source FROM query_log ORDER BY id DESC LIMIT 100"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def clear_query_log() -> None:
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
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM import_log ORDER BY imported_at DESC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        result = dict(row)
        fp = conn.execute(
            "SELECT value FROM app_settings WHERE key='last_import_filepath'"
        ).fetchone()
        result['filepath_hint'] = fp['value'] if fp else ''
        return result
    finally:
        conn.close()


def store_last_filepath(filepath: str) -> None:
    conn = _connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO app_settings(key, value) VALUES ('last_import_filepath', ?)",
            (filepath,)
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Salary engine helpers — get employee info for salary computation
# ---------------------------------------------------------------------------

def get_employee_salary_info(emp_code: str) -> Optional[Dict]:
    conn = _connect()
    try:
        row = conn.execute(
            """SELECT emp_code, emp_name_override, monthly_salary,
                      custom_arrival, custom_departure, uses_transport, is_disabled
               FROM employee_salary WHERE emp_code=?""",
            (emp_code,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_attendance_for_period(emp_code: str, start_date: str, end_date: str) -> List[Dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            """SELECT work_date, status, punch_in, punch_out, work_minutes,
                      is_late, left_early
               FROM attendance_raw
               WHERE emp_code=? AND work_date BETWEEN ? AND ?
               ORDER BY work_date""",
            (emp_code, start_date, end_date)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_all_active_emp_codes() -> List[str]:
    conn = _connect()
    try:
        rows = conn.execute(
            """SELECT DISTINCT a.emp_code FROM attendance_raw a
               LEFT JOIN employee_salary s ON a.emp_code = s.emp_code
               WHERE COALESCE(s.is_disabled, 0) = 0
               ORDER BY CAST(a.emp_code AS INTEGER)"""
        ).fetchall()
        return [r['emp_code'] for r in rows]
    finally:
        conn.close()
