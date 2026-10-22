"""
core/recompute.py
=================
Recomputes req_in, req_out, is_late, left_early, and status for
attendance_raw rows whenever calendar or employee settings change.

Priority chain (highest wins):
  1. employee_day_overrides for this (emp_code, date)  ← specific day in employee manager
  2. employee_salary.custom_arrival / custom_departure  ← employee custom timing (all days)
  3. calendar_days.day_in / day_out for this date       ← calendar day-specific time (all staff)
  4. Global checkin_time / checkout_time                ← general settings fallback

Rules:
  - status is re-derived from punch data + calendar:
      * Any punch present               → status = PRESENT
      * calendar day_type = WEEKLY_OFF  → status = WEEKLY_OFF  (if no punch)
      * calendar day_type = HOLIDAY     → status = HOLIDAY      (if no punch)
      * No punch, no special day        → status = ABSENT
  - is_late = 1 if punch_in > req_in  AND NOT uses_transport
  - left_early = 1 if punch_out < req_out AND NOT uses_transport
"""

from __future__ import annotations

import sqlite3
from typing import Optional


def _hhmm(t: Optional[str]) -> int:
    """Convert 'HH:MM' string to total minutes. Returns -1 on failure."""
    if not t:
        return -1
    try:
        h, m = map(int, t.strip().split(":"))
        return h * 60 + m
    except Exception:
        return -1


def _resolve_req_times(
    conn: sqlite3.Connection,
    emp_code: str,
    date_str: str,
    global_in: str,
    global_out: str,
) -> tuple[str, str]:
    """
    Resolve the required in/out times for (emp_code, date_str).
    Returns (req_in, req_out) as HH:MM strings.

    Priority (highest wins):
      1. Employee Day-Specific Override (set in employee manager for specific date)
      2. Employee Custom Arrival / Departure (set in employee manager for all days)
      3. Calendar Day Required Time (all staff required time from calendar section)
      4. General Settings Check-In / Check-Out Time
    """
    req_in  = (global_in or "09:00").strip()
    req_out = (global_out or "15:30").strip()

    # Priority 3: Calendar day setting (all staff required time from calendar)
    cal = conn.execute(
        "SELECT day_in, day_out FROM calendar_days WHERE date=?",
        (date_str,)
    ).fetchone()
    if cal:
        din  = (cal["day_in"] or "").strip()
        dout = (cal["day_out"] or "").strip()
        if din:  req_in  = din
        if dout: req_out = dout

    # Priority 2: Employee custom arrival / departure (set in employee manager for all days)
    # Overrides calendar day timing! Staff with custom schedule keep their custom schedule.
    emp = conn.execute(
        "SELECT custom_arrival, custom_departure FROM employee_salary WHERE emp_code=?",
        (emp_code,)
    ).fetchone()
    if emp:
        ca = (emp["custom_arrival"] or "").strip()
        cd = (emp["custom_departure"] or "").strip()
        if ca: req_in  = ca
        if cd: req_out = cd

    # Priority 1 (top priority): Day-Specific Time Override (set in employee manager for this day)
    # Overrides everything for this employee on this day!
    edo = conn.execute(
        "SELECT custom_in, custom_out FROM employee_day_overrides WHERE emp_code=? AND date=?",
        (emp_code, date_str)
    ).fetchone()
    if edo:
        cin  = (edo["custom_in"] or "").strip()
        cout = (edo["custom_out"] or "").strip()
        if cin:  req_in  = cin
        if cout: req_out = cout

    return req_in, req_out


def recompute_row(
    conn: sqlite3.Connection,
    emp_code: str,
    date_str: str,
    global_in: str,
    global_out: str,
) -> None:
    """
    Recompute req_in, req_out, is_late, left_early, status for one
    (emp_code, date_str) row in attendance_raw. No-op if row doesn't exist.
    """
    row = conn.execute(
        """SELECT id, punch_in, punch_out, status
           FROM attendance_raw
           WHERE emp_code=? AND work_date=?""",
        (emp_code, date_str)
    ).fetchone()

    # Get calendar day type for status derivation
    cal = conn.execute(
        "SELECT day_type FROM calendar_days WHERE date=?",
        (date_str,)
    ).fetchone()
    day_type = cal["day_type"] if cal else None

    # Get transport flag
    emp = conn.execute(
        "SELECT uses_transport FROM employee_salary WHERE emp_code=?",
        (emp_code,)
    ).fetchone()
    uses_transport = bool(emp and emp["uses_transport"])

    req_in, req_out = _resolve_req_times(conn, emp_code, date_str, global_in, global_out)

    if row is None:
        # No attendance row yet — nothing to update for flags,
        # but if this is a calendar day we may need to insert a synthetic row
        # Only create for WEEKLY_OFF / HOLIDAY so salary engine sees them
        if day_type in ("WEEKLY_OFF", "HOLIDAY"):
            # Check if employee is active
            active = conn.execute(
                "SELECT emp_code, emp_name FROM employee_salary WHERE emp_code=? AND COALESCE(is_disabled,0)=0",
                (emp_code,)
            ).fetchone()
            if active:
                conn.execute(
                    """INSERT OR IGNORE INTO attendance_raw
                       (report_file, report_period_start, report_period_end,
                        company_name, emp_code, emp_name, work_date, status,
                        punch_in, punch_out, work_hours, work_minutes,
                        is_late, left_early, req_in, req_out, source)
                       VALUES ('calendar', ?, ?, 'calendar', ?, ?, ?, ?, NULL, NULL, NULL, NULL,
                               0, 0, ?, ?, 'calendar')""",
                    (date_str, date_str, emp_code,
                     active["emp_name"], date_str, day_type,
                     req_in, req_out)
                )
        return

    row_id     = row["id"]
    punch_in   = row["punch_in"]
    punch_out  = row["punch_out"]
    cur_status = row["status"]

    # ── Derive new status ──────────────────────────────────────────────────
    has_punch = bool(punch_in or punch_out)
    if has_punch:
        new_status = "PRESENT"
    elif day_type == "WEEKLY_OFF":
        new_status = "WEEKLY_OFF"
    elif day_type == "HOLIDAY":
        new_status = "HOLIDAY"
    elif cur_status in ("WEEKLY_OFF", "HOLIDAY") and day_type not in ("WEEKLY_OFF", "HOLIDAY"):
        # Calendar entry was REMOVED or changed to WORKING — revert to ABSENT if no punch
        new_status = "ABSENT"
    else:
        new_status = cur_status  # preserve ABSENT / HALF_DAY set by import

    # ── Compute is_late / left_early ───────────────────────────────────────
    is_late   = 0
    left_early = 0
    if not uses_transport and new_status == "PRESENT":
        ri = _hhmm(req_in)
        ro = _hhmm(req_out)
        pi = _hhmm(punch_in)
        po = _hhmm(punch_out)
        if ri >= 0 and pi >= 0:
            is_late   = 1 if pi > ri else 0
        if ro >= 0 and po >= 0:
            left_early = 1 if po < ro else 0

    conn.execute(
        """UPDATE attendance_raw
           SET req_in=?, req_out=?, is_late=?, left_early=?, status=?
           WHERE id=?""",
        (req_in, req_out, is_late, left_early, new_status, row_id)
    )


def recompute_for_date(date_str: str) -> None:
    """
    Recompute flags for ALL employees on a given date.
    Called when a calendar day is saved/deleted.
    """
    import core.db as db
    conn = db._connect()
    try:
        global_in  = db.get_setting("checkin_time",  "09:00")
        global_out = db.get_setting("checkout_time", "15:30")

        # All employees who have an attendance row on this date
        rows_on_date = conn.execute(
            "SELECT DISTINCT emp_code FROM attendance_raw WHERE work_date=?",
            (date_str,)
        ).fetchall()
        emps_with_rows = {r["emp_code"] for r in rows_on_date}

        # Also include active employees in employee_salary (for synthetic HOLIDAY/WEEKLY_OFF rows)
        active_emps = conn.execute(
            "SELECT emp_code FROM employee_salary WHERE COALESCE(is_disabled,0)=0"
        ).fetchall()
        all_emps = emps_with_rows | {r["emp_code"] for r in active_emps}

        for ec in all_emps:
            recompute_row(conn, ec, date_str, global_in, global_out)

        conn.commit()
    finally:
        conn.close()


def recompute_for_employee(emp_code: str) -> None:
    """
    Recompute flags for ALL attendance rows of a given employee.
    Called when employee salary info (arrival/departure/transport) is saved.
    Only alters rows for today and future dates to preserve historical data.
    Actually, since schedule changes are forward-looking, we recompute ALL rows
    (the user confirmed old data can change with bus option; time changes are day-specific).
    """
    import core.db as db
    from datetime import date
    conn = db._connect()
    try:
        global_in  = db.get_setting("checkin_time",  "09:00")
        global_out = db.get_setting("checkout_time", "15:30")

        rows = conn.execute(
            "SELECT DISTINCT work_date FROM attendance_raw WHERE emp_code=?",
            (emp_code,)
        ).fetchall()

        for row in rows:
            recompute_row(conn, emp_code, row["work_date"], global_in, global_out)

        conn.commit()
    finally:
        conn.close()


def recompute_single(emp_code: str, date_str: str) -> None:
    """
    Recompute flags for exactly one (emp_code, date_str) row.
    Called when an employee day override is saved/deleted.
    """
    import core.db as db
    conn = db._connect()
    try:
        global_in  = db.get_setting("checkin_time",  "09:00")
        global_out = db.get_setting("checkout_time", "15:30")
        recompute_row(conn, emp_code, date_str, global_in, global_out)
        conn.commit()
    finally:
        conn.close()


def recompute_all() -> None:
    """
    Recompute flags for ALL attendance rows in the database.
    Called when global settings (checkin_time, checkout_time) are modified or on full reload.
    """
    import core.db as db
    conn = db._connect()
    try:
        global_in  = db.get_setting("checkin_time",  "09:00")
        global_out = db.get_setting("checkout_time", "15:30")
        rows = conn.execute("SELECT DISTINCT emp_code, work_date FROM attendance_raw").fetchall()
        for r in rows:
            recompute_row(conn, r["emp_code"], r["work_date"], global_in, global_out)
        conn.commit()
    finally:
        conn.close()

