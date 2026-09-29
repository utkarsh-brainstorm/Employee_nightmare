"""
core/salary_engine.py
=====================
V12 Salary Computation Engine.

Priority chain for required In/Out time (highest priority wins):
  1. Employee Day Override for that specific date
  2. Employee Default custom_arrival / custom_departure
  3. Calendar Day In/Out for that date
  4. Global checkin_time / checkout_time from app_settings

Key rules:
  - Transport employees (uses_transport=1) are EXEMPT from is_late and
    left_early salary deductions. Their salary is only docked for full absences.
  - Sandwich Rule: Absent days adjacent (before/after) to Holidays or Weekly
    Offs are expanded — the whole contiguous block is deducted.
  - Paid Leave Settings: if holidays_paid='yes', holiday minutes are added
    to payable minutes. Same for weeklyoff_paid.
  - Per-Minute Rate: Base Salary ÷ (Total Required Minutes for the period).
  - Single punch = 50% of required shift minutes for that day.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta
from typing import Dict, List, Optional, Set, Tuple

import core.db as db


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def _hhmm_to_minutes(t: Optional[str]) -> int:
    """Convert 'HH:MM' to integer minutes. Returns 0 on failure."""
    if not t:
        return 0
    try:
        hh, mm = map(int, t.strip().split(":"))
        return hh * 60 + mm
    except Exception:
        return 0


def _shift_minutes(in_time: str, out_time: str) -> int:
    """Return the number of minutes between in_time and out_time."""
    diff = _hhmm_to_minutes(out_time) - _hhmm_to_minutes(in_time)
    return max(0, diff)


# ---------------------------------------------------------------------------
# Priority-chain: get required In/Out times for a given emp + date
# ---------------------------------------------------------------------------

def get_required_times(
    emp_code: str,
    date_str: str,
    emp_info: Dict,
    calendar_map: Dict[str, Dict],
    global_in: str,
    global_out: str,
) -> Tuple[str, str]:
    """
    Return (required_in, required_out) for a specific employee on a specific date.

    Priority (highest wins):
      1. employee_day_overrides for this (emp_code, date)
      2. employee_salary.custom_arrival / custom_departure
      3. calendar_days.day_in / day_out for this date
      4. Global checkin_time / checkout_time
    """
    req_in  = global_in
    req_out = global_out

    # Layer 3: Calendar day-specific override
    cal = calendar_map.get(date_str)
    if cal:
        if cal.get("day_in"):
            req_in  = cal["day_in"]
        if cal.get("day_out"):
            req_out = cal["day_out"]

    # Layer 2: Employee default schedule
    if emp_info.get("custom_arrival"):
        req_in  = emp_info["custom_arrival"]
    if emp_info.get("custom_departure"):
        req_out = emp_info["custom_departure"]

    # Layer 1 (highest): Employee day-specific override
    edo = db.get_employee_day_override_single(emp_code, date_str)
    if edo:
        if edo.get("custom_in"):
            req_in  = edo["custom_in"]
        if edo.get("custom_out"):
            req_out = edo["custom_out"]

    return req_in, req_out


# ---------------------------------------------------------------------------
# Sandwich Rule
# ---------------------------------------------------------------------------

def expand_sandwich(
    absent_dates: Set[str],
    calendar_map: Dict[str, Dict],
    period_start: date,
    period_end: date,
) -> Set[str]:
    """
    Apply the Sandwich Rule.

    If an employee is absent on any day that is directly adjacent (before or
    after) to one or more Holidays or Weekly Offs, the entire contiguous block
    (absent + attached holidays/weeklyoffs) becomes deductible.

    Example:
      Holiday: Sep 20, 21
      Employee absent Sep 19 and Sep 23
      -> Full block Sep 19..21 deductible + Sep 23 (standalone, but if Sep 22
         is also a holiday, then Sep 22+23 also deductible).

    Returns an expanded set of dates to deduct.
    """
    special = {d for d, v in calendar_map.items()
                 if v.get("day_type") in ("HOLIDAY", "WEEKLY_OFF")}

    deduct: Set[str] = set(absent_dates)

    # For every absent date, walk in both directions absorbing adjacent specials
    changed = True
    while changed:
        changed = False
        for ab in list(deduct):
            ab_date = date.fromisoformat(ab)
            # Walk backwards
            prev = ab_date - timedelta(days=1)
            while period_start <= prev <= period_end:
                ps = prev.isoformat()
                if ps in special and ps not in deduct:
                    deduct.add(ps)
                    changed = True
                    prev -= timedelta(days=1)
                else:
                    break
            # Walk forward
            nxt = ab_date + timedelta(days=1)
            while period_start <= nxt <= period_end:
                ns = nxt.isoformat()
                if ns in special and ns not in deduct:
                    deduct.add(ns)
                    changed = True
                    nxt += timedelta(days=1)
                else:
                    break

    return deduct


# ---------------------------------------------------------------------------
# Per-employee salary computation
# ---------------------------------------------------------------------------

def compute_salary_for_employee(
    emp_code: str,
    year: int,
    month: int,
) -> Optional[Dict]:
    """
    Compute the full salary for one employee for a given year/month.

    Returns a dict with all relevant columns, or None if no data.
    """
    # Date range for the month
    _, last_day = calendar.monthrange(year, month)
    start_str = f"{year}-{month:02d}-01"
    end_str   = f"{year}-{month:02d}-{last_day:02d}"
    period_start = date(year, month, 1)
    period_end   = date(year, month, last_day)

    # Load settings
    global_in  = db.get_setting("checkin_time",  "09:00")
    global_out = db.get_setting("checkout_time", "15:30")
    holidays_paid   = db.get_setting("holidays_paid",   "yes").strip().lower() == "yes"
    weeklyoff_paid  = db.get_setting("weeklyoff_paid",  "yes").strip().lower() == "yes"

    # Load employee info
    emp_info = db.get_employee_salary_info(emp_code)
    if not emp_info:
        # Build a minimal record from attendance
        emp_info = {
            "emp_code": emp_code,
            "emp_name_override": None,
            "monthly_salary": 0,
            "custom_arrival": None,
            "custom_departure": None,
            "uses_transport": 0,
            "is_disabled": 0,
        }

    if emp_info.get("is_disabled"):
        return None

    base_salary    = float(emp_info.get("monthly_salary") or 0)
    uses_transport = bool(emp_info.get("uses_transport"))

    # Load calendar for the full month
    cal_rows = db.get_calendar_days(year, month)
    calendar_map: Dict[str, Dict] = {
        r["date"]: r for r in cal_rows
    }

    # Load attendance
    att_rows = db.get_attendance_for_period(emp_code, start_str, end_str)
    att_map: Dict[str, Dict] = {r["work_date"]: r for r in att_rows}

    # ── Walk every day of the month ────────────────────────────────────────
    total_req_mins   = 0    # sum of required shift minutes across the period
    total_worked_mins = 0   # sum of actual worked minutes
    days_present     = 0
    days_absent      = 0
    days_holiday     = 0
    days_weeklyoff   = 0
    days_late        = 0
    days_early       = 0
    absent_dates: Set[str] = set()

    for d in range(1, last_day + 1):
        day_date = date(year, month, d)
        date_str = day_date.isoformat()

        cal_day = calendar_map.get(date_str)
        day_type = cal_day.get("day_type") if cal_day else None

        # Compute required in/out for this day
        req_in, req_out = get_required_times(
            emp_code, date_str, emp_info, calendar_map, global_in, global_out
        )
        shift_mins = _shift_minutes(req_in, req_out)

        att = att_map.get(date_str)
        status = att["status"] if att else ("WEEKLY_OFF" if day_type == "WEEKLY_OFF" else None)

        if day_type == "WEEKLY_OFF":
            days_weeklyoff += 1
            if weeklyoff_paid:
                total_req_mins += shift_mins
        elif day_type == "HOLIDAY":
            days_holiday += 1
            if holidays_paid:
                total_req_mins += shift_mins
        else:
            # Regular working day
            total_req_mins += shift_mins

            if not att:
                # No attendance record → treat as absent
                days_absent += 1
                absent_dates.add(date_str)
                continue

            st = att["status"]
            if st == "PRESENT":
                days_present += 1
                punch_in  = att.get("punch_in")
                punch_out = att.get("punch_out")

                if att.get("work_minutes") is not None:
                    # Both punches present — use actual worked minutes
                    # but cap at required shift
                    raw_mins = att["work_minutes"]
                    # Cap effective arrival and departure at scheduled boundaries
                    if punch_in and punch_out:
                        eff_in  = max(_hhmm_to_minutes(punch_in),  _hhmm_to_minutes(req_in))
                        eff_out = min(_hhmm_to_minutes(punch_out), _hhmm_to_minutes(req_out))
                        worked = max(0, eff_out - eff_in)
                    else:
                        worked = raw_mins
                    total_worked_mins += worked
                else:
                    # Single punch — 50% rule
                    total_worked_mins += shift_mins // 2

                # Late / early flags — exempt transport employees
                if not uses_transport:
                    if att.get("is_late"):
                        days_late += 1
                    if att.get("left_early"):
                        days_early += 1

            elif st == "ABSENT":
                days_absent += 1
                absent_dates.add(date_str)
            elif st == "WEEKLY_OFF":
                days_weeklyoff += 1
            # HALF_DAY treated as partial present
            elif st == "HALF_DAY":
                days_present += 1
                total_worked_mins += shift_mins // 2

    # ── Sandwich Rule: expand absent days to include adjacent holidays ──────
    expanded_absent = expand_sandwich(absent_dates, calendar_map, period_start, period_end)
    # Extra deduction days from sandwich expansion (holidays pulled into deduction)
    sandwich_extra = expanded_absent - absent_dates  # newly added holiday days
    sandwich_extra_mins = 0
    for ds in sandwich_extra:
        cal_day = calendar_map.get(ds)
        req_in2, req_out2 = get_required_times(
            emp_code, ds, emp_info, calendar_map, global_in, global_out
        )
        sandwich_extra_mins += _shift_minutes(req_in2, req_out2)

    total_absent_mins = sum(
        _shift_minutes(*get_required_times(emp_code, ds, emp_info, calendar_map, global_in, global_out))
        for ds in absent_dates
    ) + sandwich_extra_mins

    # ── Transport employee override: no deduction for late/early ────────────
    # (already handled above by not counting days_late/days_early)

    # ── Payable minutes ─────────────────────────────────────────────────────
    # 1-day paid leave credit (first absent day is forgiven)
    leave_credit_mins = 0
    if days_absent > 0:
        # Credit one day's worth of the employee's standard shift
        std_shift = _shift_minutes(
            emp_info.get("custom_arrival") or global_in,
            emp_info.get("custom_departure") or global_out
        )
        leave_credit_mins = std_shift

    payable_mins = total_worked_mins + leave_credit_mins

    # ── Per-minute rate & earned salary ─────────────────────────────────────
    if total_req_mins > 0 and base_salary > 0:
        per_min_rate = base_salary / total_req_mins
        earned       = round(per_min_rate * payable_mins, 2)
    else:
        per_min_rate = 0.0
        earned       = 0.0 if base_salary == 0 else None  # N/A if no salary set

    return {
        "emp_code":          emp_code,
        "name":              emp_info.get("emp_name_override") or emp_code,
        "base_salary":       base_salary,
        "uses_transport":    1 if uses_transport else 0,
        "working_days":      last_day - days_holiday - days_weeklyoff,
        "days_present":      days_present,
        "days_absent":       days_absent,
        "days_holiday":      days_holiday,
        "days_weekly_off":   days_weeklyoff,
        "days_late":         days_late,
        "days_early_leave":  days_early,
        "sandwich_expanded": len(sandwich_extra),
        "total_req_mins":    total_req_mins,
        "per_min_rate":      round(per_min_rate, 4),
        "worked_mins":       total_worked_mins,
        "leave_credit_mins": leave_credit_mins,
        "payable_mins":      payable_mins,
        "earned":            earned if earned is not None else "N/A",
    }


def compute_salary_report(year: int, month: int) -> List[Dict]:
    """Compute salary report for ALL active employees for the given month."""
    emp_codes = db.get_all_active_emp_codes()
    results = []
    for code in emp_codes:
        row = compute_salary_for_employee(code, year, month)
        if row:
            results.append(row)
    return results
