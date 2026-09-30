"""
core/salary_engine.py
=====================
V13 Salary Computation Engine.

Priority chain for required In/Out time (highest priority wins):
  1. Employee Day Override for that specific date
  2. Employee Default custom_arrival / custom_departure
  3. Calendar Day In/Out for that date
  4. Global checkin_time / checkout_time from app_settings

Key rules:
  - Transport employees (uses_transport=1) are EXEMPT from is_late and
    left_early salary deductions. Only docked for full absences.
  - Sandwich Rule: Absent days adjacent (before/after) to Holidays or Weekly
    Offs are expanded — the whole contiguous block is deducted. Sandwich-type
    holidays/weekly-offs that get absorbed into deduction are NOT counted as
    paid holiday minutes.
  - Leave Credit: 1-day paid credit only if employee has 1+ absence AND at
    least one absence is NOT a sandwich-type absence. Zero absences = no credit.
  - Paid Holiday Mins: minutes from paid holidays/weekly-offs that are NOT
    absorbed into a sandwich deduction block.
  - Deducted Mins: shown as "X (absent) + Y (late/early)". Late/early mins
    are the difference between actual punch and required time for that day.
  - Per-Minute Rate: Base Salary ÷ Total Required Minutes for the period.
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
    req_in  = global_in
    req_out = global_out

    cal = calendar_map.get(date_str)
    if cal:
        if cal.get("day_in"):  req_in  = cal["day_in"]
        if cal.get("day_out"): req_out = cal["day_out"]

    if emp_info.get("custom_arrival"):   req_in  = emp_info["custom_arrival"]
    if emp_info.get("custom_departure"): req_out = emp_info["custom_departure"]

    edo = db.get_employee_day_override_single(emp_code, date_str)
    if edo:
        if edo.get("custom_in"):  req_in  = edo["custom_in"]
        if edo.get("custom_out"): req_out = edo["custom_out"]

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
    Return an expanded set of ALL dates that form the sandwich block:
    absent dates + any adjacent holidays/weekly-offs that get absorbed.
    """
    special = {d for d, v in calendar_map.items()
                 if v.get("day_type") in ("HOLIDAY", "WEEKLY_OFF")}

    deduct: Set[str] = set(absent_dates)
    changed = True
    while changed:
        changed = False
        for ab in list(deduct):
            ab_date = date.fromisoformat(ab)
            prev = ab_date - timedelta(days=1)
            while period_start <= prev <= period_end:
                ps = prev.isoformat()
                if ps in special and ps not in deduct:
                    deduct.add(ps); changed = True; prev -= timedelta(days=1)
                else:
                    break
            nxt = ab_date + timedelta(days=1)
            while period_start <= nxt <= period_end:
                ns = nxt.isoformat()
                if ns in special and ns not in deduct:
                    deduct.add(ns); changed = True; nxt += timedelta(days=1)
                else:
                    break
    return deduct


def is_sandwich_absent(
    absent_date_str: str,
    calendar_map: Dict[str, Dict],
    period_start: date,
    period_end: date,
) -> bool:
    """Return True if this absent date is directly adjacent to a Holiday/Weekly Off."""
    special = {d for d, v in calendar_map.items()
                 if v.get("day_type") in ("HOLIDAY", "WEEKLY_OFF")}
    d = date.fromisoformat(absent_date_str)
    return (d - timedelta(days=1)).isoformat() in special or \
           (d + timedelta(days=1)).isoformat() in special


# ---------------------------------------------------------------------------
# Per-employee salary computation
# ---------------------------------------------------------------------------

def compute_salary_for_employee(
    emp_code: str,
    year: int,
    month: int,
) -> Optional[Dict]:
    """Compute the full salary for one employee for a given year/month."""
    _, last_day = calendar.monthrange(year, month)
    start_str    = f"{year}-{month:02d}-01"
    end_str      = f"{year}-{month:02d}-{last_day:02d}"
    period_start = date(year, month, 1)
    period_end   = date(year, month, last_day)

    global_in  = db.get_setting("checkin_time",  "09:00")
    global_out = db.get_setting("checkout_time", "15:30")
    holidays_paid  = db.get_setting("holidays_paid",  "yes").strip().lower() == "yes"
    weeklyoff_paid = db.get_setting("weeklyoff_paid", "yes").strip().lower() == "yes"

    emp_info = db.get_employee_salary_info(emp_code)
    if not emp_info:
        emp_info = {
            "emp_code": emp_code, "emp_name_override": None,
            "monthly_salary": 0, "custom_arrival": None,
            "custom_departure": None, "uses_transport": 0, "is_disabled": 0,
        }

    if emp_info.get("is_disabled"):
        return None

    base_salary    = float(emp_info.get("monthly_salary") or 0)
    uses_transport = bool(emp_info.get("uses_transport"))

    cal_rows = db.get_calendar_days(year, month)
    calendar_map: Dict[str, Dict] = {r["date"]: r for r in cal_rows}

    att_rows = db.get_attendance_for_period(emp_code, start_str, end_str)
    att_map: Dict[str, Dict] = {r["work_date"]: r for r in att_rows}

    # ── Walk every day of the month ─────────────────────────────────────────
    total_req_mins    = 0
    total_worked_mins = 0
    days_present      = 0
    days_absent       = 0
    days_holiday      = 0
    days_weeklyoff    = 0
    absent_dates: Set[str] = set()

    # Track per-day data for late/early deduction calculation
    day_details: Dict[str, Dict] = {}   # date_str → {worked, req_shift, punch_in, punch_out, req_in, req_out, status}

    # Track paid holiday/weekly-off minutes (before sandwich removal)
    holiday_mins_map:   Dict[str, int] = {}   # date_str → shift_mins for paid holidays
    weeklyoff_mins_map: Dict[str, int] = {}   # date_str → shift_mins for paid weekly-offs

    for d_num in range(1, last_day + 1):
        day_date = date(year, month, d_num)
        date_str = day_date.isoformat()

        cal_day  = calendar_map.get(date_str)
        day_type = cal_day.get("day_type") if cal_day else None

        req_in, req_out = get_required_times(
            emp_code, date_str, emp_info, calendar_map, global_in, global_out
        )
        shift_mins = _shift_minutes(req_in, req_out)

        att = att_map.get(date_str)

        if day_type == "WEEKLY_OFF":
            days_weeklyoff += 1
            if weeklyoff_paid:
                total_req_mins += shift_mins
                weeklyoff_mins_map[date_str] = shift_mins
        elif day_type == "HOLIDAY":
            days_holiday += 1
            if holidays_paid:
                total_req_mins += shift_mins
                holiday_mins_map[date_str] = shift_mins
        else:
            # Regular working day
            total_req_mins += shift_mins

            if not att:
                days_absent += 1
                absent_dates.add(date_str)
                day_details[date_str] = {
                    "worked": 0, "req_shift": shift_mins,
                    "punch_in": None, "punch_out": None,
                    "req_in": req_in, "req_out": req_out, "status": "ABSENT"
                }
                continue

            st = att["status"]
            if st == "PRESENT":
                days_present += 1
                punch_in  = att.get("punch_in")
                punch_out = att.get("punch_out")

                if att.get("work_minutes") is not None:
                    if punch_in and punch_out:
                        eff_in  = max(_hhmm_to_minutes(punch_in),  _hhmm_to_minutes(req_in))
                        eff_out = min(_hhmm_to_minutes(punch_out), _hhmm_to_minutes(req_out))
                        worked  = max(0, eff_out - eff_in)
                    else:
                        worked = att["work_minutes"]
                    total_worked_mins += worked
                else:
                    worked = shift_mins // 2
                    total_worked_mins += worked

                day_details[date_str] = {
                    "worked": worked, "req_shift": shift_mins,
                    "punch_in": punch_in, "punch_out": punch_out,
                    "req_in": req_in, "req_out": req_out, "status": "PRESENT"
                }

            elif st == "ABSENT":
                days_absent += 1
                absent_dates.add(date_str)
                day_details[date_str] = {
                    "worked": 0, "req_shift": shift_mins,
                    "punch_in": None, "punch_out": None,
                    "req_in": req_in, "req_out": req_out, "status": "ABSENT"
                }
            elif st == "WEEKLY_OFF":
                days_weeklyoff += 1
            elif st == "HALF_DAY":
                days_present += 1
                worked = shift_mins // 2
                total_worked_mins += worked
                day_details[date_str] = {
                    "worked": worked, "req_shift": shift_mins,
                    "punch_in": att.get("punch_in"), "punch_out": att.get("punch_out"),
                    "req_in": req_in, "req_out": req_out, "status": "HALF_DAY"
                }

    # ── Sandwich expansion ───────────────────────────────────────────────────
    expanded_absent = expand_sandwich(absent_dates, calendar_map, period_start, period_end)
    sandwich_absorbed = expanded_absent - absent_dates   # holidays/offs pulled into deduction

    sandwich_extra_mins = 0
    for ds in sandwich_absorbed:
        req_in2, req_out2 = get_required_times(
            emp_code, ds, emp_info, calendar_map, global_in, global_out
        )
        sandwich_extra_mins += _shift_minutes(req_in2, req_out2)

    # ── Paid Holiday / Weekly-Off minutes (excluding sandwich-absorbed days) ─
    paid_holiday_mins = sum(
        mins for ds, mins in {**holiday_mins_map, **weeklyoff_mins_map}.items()
        if ds not in sandwich_absorbed
    )

    # ── Absent deduction minutes ─────────────────────────────────────────────
    absent_deduct_mins = sum(
        dd["req_shift"] for ds, dd in day_details.items()
        if dd["status"] == "ABSENT"
    ) + sandwich_extra_mins

    # ── Late/early deduction minutes (only non-transport employees) ──────────
    late_early_deduct_mins = 0
    if not uses_transport:
        for ds, dd in day_details.items():
            if dd["status"] != "PRESENT":
                continue
            pi = dd["punch_in"]; po = dd["punch_out"]
            ri = dd["req_in"];   ro = dd["req_out"]
            if pi and ri:
                late_mins = max(0, _hhmm_to_minutes(pi) - _hhmm_to_minutes(ri))
                late_early_deduct_mins += late_mins
            if po and ro:
                early_mins = max(0, _hhmm_to_minutes(ro) - _hhmm_to_minutes(po))
                late_early_deduct_mins += early_mins

    deducted_display = f"{absent_deduct_mins} (absent) + {late_early_deduct_mins} (late/early)"

    # ── Leave Credit (non-sandwich absences only, only if days_absent > 0) ──
    leave_credit_mins = 0
    if days_absent > 0:
        non_sandwich_absents = [
            ds for ds in absent_dates
            if not is_sandwich_absent(ds, calendar_map, period_start, period_end)
        ]
        if non_sandwich_absents:
            std_shift = _shift_minutes(
                emp_info.get("custom_arrival") or global_in,
                emp_info.get("custom_departure") or global_out
            )
            leave_credit_mins = std_shift

    payable_mins = total_worked_mins + paid_holiday_mins + leave_credit_mins

    # ── Per-minute rate & earned salary ─────────────────────────────────────
    if total_req_mins > 0 and base_salary > 0:
        per_min_rate = base_salary / total_req_mins
        earned       = round(per_min_rate * payable_mins, 2)
    else:
        per_min_rate = 0.0
        earned       = 0.0 if base_salary == 0 else None

    working_days = last_day - days_holiday - days_weeklyoff
    return {
        "Emp Code":           emp_code,
        "Name":               emp_info.get("emp_name_override") or emp_code,
        "Base Salary":        base_salary,
        "Working Days":       working_days,
        "Days Absent":        days_absent,
        "Total Req Mins":     total_req_mins,
        "Per Min Rate":       round(per_min_rate, 4),
        "Worked Mins":        total_worked_mins,
        "Paid Holiday Mins":  paid_holiday_mins,
        "Leave Credit Mins":  leave_credit_mins,
        "Payable Mins":       payable_mins,
        "Deducted Mins":      deducted_display,
        "Earned":             earned if earned is not None else "N/A",
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
