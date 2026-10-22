"""
core/salary_engine.py
=====================
V14.2 Salary Computation Engine.

Priority chain for required In/Out time (highest wins):
  1. Employee Day-Specific Override (specific day set in employee manager)
  2. Employee Custom Arrival / Departure (all-day default in employee manager)
  3. Calendar Day setting (day-specific in/out from calendar for all staff)
  4. Global checkin_time / checkout_time

IMPORTANT: When computing salary, req_in / req_out are read directly from the
stored attendance_raw.req_in / req_out columns (populated by recompute.py on
every import/save). This means the database IS the single source of truth for
required times. get_required_times() is only used as a fallback for days that
have no attendance row (absent days, or days not yet imported).

Key rules:
  - Bus employees (uses_transport=1):
      Full shift credit for every present day (no late/early deduction).
      Formula: (days_present × shift_mins + paid_holiday_mins
                + leave_credit_mins) × per_min_rate
  - Non-bus employees:
      Worked mins capped at schedule (late arrival / early departure implicitly
      reduces worked mins). Late/early minute amounts shown in Deducted Mins.
  - Sandwich Rule: Absent days adjacent to Holidays/Weekly-Offs expand the
      deduction block. Absorbed holiday days NOT counted as paid holidays.
  - Leave Credit: 1-day credit if days_absent > 0 AND at least one absence is
      NOT sandwich-type. Sandwich-only absences get zero credit.
  - Paid Holiday Mins: minutes from paid holidays/weekly-offs NOT absorbed by
      sandwich expansion.
  - Deducted Mins: "X (absent) + Y (late/early)" breakdown.
  - Per-Minute Rate = Base Salary / Total Required Minutes for the period.
  - Single punch (only in or only out) = 50% of that day's required shift.
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
    if not t:
        return 0
    try:
        hh, mm = map(int, t.strip().split(":"))
        return hh * 60 + mm
    except Exception:
        return 0


def _shift_minutes(in_time: str, out_time: str) -> int:
    return max(0, _hhmm_to_minutes(out_time) - _hhmm_to_minutes(in_time))


# ---------------------------------------------------------------------------
# Priority-chain fallback (used ONLY when no DB row exists for a date)
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
    Fallback resolver — only used for days with no attendance row.
    Priority (highest wins):
      1. Employee Day-Specific Override (set in employee manager for specific date)
      2. Employee Custom Arrival / Departure (set in employee manager for all days)
      3. Calendar Day Required Time (all staff required time from calendar section)
      4. General Settings Check-In / Check-Out Time
    """
    req_in  = (global_in or "09:00").strip()
    req_out = (global_out or "15:30").strip()

    # Priority 3: Calendar day-specific (all staff)
    cal = calendar_map.get(date_str)
    if cal:
        din  = (cal.get("day_in") or "").strip()
        dout = (cal.get("day_out") or "").strip()
        if din:  req_in  = din
        if dout: req_out = dout

    # Priority 2: Employee custom arrival / departure (all days)
    # Overrides calendar day timing! Staff with custom schedule keep their custom schedule.
    ca = (emp_info.get("custom_arrival") or "").strip()
    cd = (emp_info.get("custom_departure") or "").strip()
    if ca: req_in  = ca
    if cd: req_out = cd

    # Priority 1 (highest): Employee day override
    edo = db.get_employee_day_override_single(emp_code, date_str)
    if edo:
        cin  = (edo.get("custom_in") or "").strip()
        cout = (edo.get("custom_out") or "").strip()
        if cin:  req_in  = cin
        if cout: req_out = cout

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
    """Return all dates forming the sandwich block."""
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
    apply_sandwich: Optional[bool] = None,
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
    if apply_sandwich is None:
        apply_sandwich = db.get_setting("sandwich_rule", "yes").strip().lower() == "yes"


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

    # Attendance rows now include req_in / req_out stored by recompute.py
    att_rows = db.get_attendance_for_period(emp_code, start_str, end_str)
    att_map: Dict[str, Dict] = {r["work_date"]: r for r in att_rows}

    # Standard shift for leave credit (employee default or global)
    std_shift = _shift_minutes(
        emp_info.get("custom_arrival") or global_in,
        emp_info.get("custom_departure") or global_out,
    )

    # ── Walk every day of the month ─────────────────────────────────────────
    total_req_mins     = 0
    total_worked_mins  = 0
    days_present       = 0
    days_absent        = 0
    days_holiday       = 0
    days_weeklyoff     = 0
    absent_dates: Set[str] = set()

    day_details: Dict[str, Dict] = {}
    holiday_mins_map:   Dict[str, int] = {}
    weeklyoff_mins_map: Dict[str, int] = {}

    for d_num in range(1, last_day + 1):
        day_date = date(year, month, d_num)
        date_str = day_date.isoformat()

        cal_day  = calendar_map.get(date_str)
        day_type = cal_day.get("day_type") if cal_day else None

        att = att_map.get(date_str)

        # ── Resolve req_in / req_out ─────────────────────────────────────────
        # PRIMARY: use stored DB value (set by recompute.py, respects full priority chain)
        # FALLBACK: recalculate live (for days with no attendance row)
        if att and att.get("req_in") and att.get("req_out"):
            req_in  = att["req_in"]
            req_out = att["req_out"]
        else:
            req_in, req_out = get_required_times(
                emp_code, date_str, emp_info, calendar_map, global_in, global_out
            )

        shift_mins = _shift_minutes(req_in, req_out)

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
                # No row at all → absent
                days_absent += 1
                absent_dates.add(date_str)
                day_details[date_str] = {
                    "req_shift": shift_mins, "worked": 0,
                    "punch_in": None, "punch_out": None,
                    "req_in": req_in, "req_out": req_out, "status": "ABSENT",
                }
                continue

            st = att["status"]

            if st == "PRESENT":
                days_present += 1
                punch_in  = att.get("punch_in")
                punch_out = att.get("punch_out")

                if uses_transport:
                    # Full shift credit — no late/early penalty
                    worked = shift_mins
                elif att.get("work_minutes") is not None:
                    if punch_in and punch_out:
                        eff_in  = max(_hhmm_to_minutes(punch_in),  _hhmm_to_minutes(req_in))
                        eff_out = min(_hhmm_to_minutes(punch_out), _hhmm_to_minutes(req_out))
                        worked  = max(0, eff_out - eff_in)
                    else:
                        worked = shift_mins // 2   # single punch
                else:
                    worked = shift_mins // 2

                total_worked_mins += worked
                day_details[date_str] = {
                    "req_shift": shift_mins, "worked": worked,
                    "punch_in": punch_in, "punch_out": punch_out,
                    "req_in": req_in, "req_out": req_out, "status": "PRESENT",
                }

            elif st == "ABSENT":
                days_absent += 1
                absent_dates.add(date_str)
                day_details[date_str] = {
                    "req_shift": shift_mins, "worked": 0,
                    "punch_in": None, "punch_out": None,
                    "req_in": req_in, "req_out": req_out, "status": "ABSENT",
                }

            elif st == "WEEKLY_OFF":
                days_weeklyoff += 1

            elif st == "HALF_DAY":
                days_present += 1
                worked = shift_mins // 2
                total_worked_mins += worked
                day_details[date_str] = {
                    "req_shift": shift_mins, "worked": worked,
                    "punch_in": att.get("punch_in"), "punch_out": att.get("punch_out"),
                    "req_in": req_in, "req_out": req_out, "status": "HALF_DAY",
                }

    # ── Sandwich expansion ───────────────────────────────────────────────────
    if apply_sandwich:
        expanded_absent   = expand_sandwich(absent_dates, calendar_map, period_start, period_end)
        sandwich_absorbed = expanded_absent - absent_dates

        sandwich_extra_mins = sum(
            _shift_minutes(
                *get_required_times(emp_code, ds, emp_info, calendar_map, global_in, global_out)
            )
            for ds in sandwich_absorbed
        )
    else:
        expanded_absent   = set(absent_dates)
        sandwich_absorbed = set()
        sandwich_extra_mins = 0

    # ── Paid Holiday / Weekly-Off mins (excluding sandwich-absorbed) ──────────
    paid_holiday_mins = sum(
        mins for ds, mins in {**holiday_mins_map, **weeklyoff_mins_map}.items()
        if ds not in sandwich_absorbed
    )

    # ── Leave Credit ─────────────────────────────────────────────────────────
    leave_credit_mins = 0
    if days_absent > 0:
        if apply_sandwich:
            non_sandwich = [
                ds for ds in absent_dates
                if not is_sandwich_absent(ds, calendar_map, period_start, period_end)
            ]
            if non_sandwich:
                leave_credit_mins = std_shift
        else:
            leave_credit_mins = std_shift

    # ── Absent deduction minutes (net of leave credit) ───────────────────────
    gross_absent_mins = sum(
        dd["req_shift"] for ds, dd in day_details.items()
        if dd["status"] == "ABSENT"
    ) + sandwich_extra_mins

    net_absent_mins = max(0, gross_absent_mins - leave_credit_mins)

    # ── Late/early deduction minutes (non-bus only) ──────────────────────────
    late_early_deduct_mins = 0
    if not uses_transport:
        for ds, dd in day_details.items():
            if dd["status"] in ("PRESENT", "HALF_DAY"):
                late_early_deduct_mins += max(0, dd["req_shift"] - dd["worked"])

    tot_deducted_mins = net_absent_mins + late_early_deduct_mins
    deducted_display = f"{net_absent_mins} mins (absent) + {late_early_deduct_mins} mins (late/early)"

    # ── Payable minutes ──────────────────────────────────────────────────────
    payable_mins = total_worked_mins + paid_holiday_mins + leave_credit_mins

    # ── Per-minute rate & earned ─────────────────────────────────────────────
    if total_req_mins > 0 and base_salary > 0:
        per_min_rate = base_salary / total_req_mins
        earned       = round(per_min_rate * payable_mins, 2)
    else:
        per_min_rate = 0.0
        earned       = 0.0 if base_salary == 0 else None

    working_days = last_day - days_holiday - days_weeklyoff
    earned_val = earned if earned is not None else 0.0
    deducted_amount = round(base_salary - earned_val, 2) if base_salary > 0 else 0.0

    total_absent_days = days_absent + len(sandwich_absorbed)

    return {
        "Code":               emp_code,
        "Name":               emp_info.get("emp_name_override") or emp_info.get("emp_name") or emp_code,
        "Working Days":       working_days,
        "Absent":             total_absent_days,
        "Deducted Mins":      deducted_display,
        "_base_salary":       base_salary,
        "_earned":            earned_val,
        "_deducted_amount":   deducted_amount,
        "_per_min_rate":      round(per_min_rate, 4),
        "_req_mins":          total_req_mins,
        "_worked_mins":       total_worked_mins,
        "_holiday_mins":      paid_holiday_mins,
        "_leave_credit":      leave_credit_mins,
        "_payable_mins":      payable_mins,
        "_absent_days":       total_absent_days,
        "_net_absent_mins":   net_absent_mins,
        "_late_early_mins":   late_early_deduct_mins,
        "_deducted_mins":     tot_deducted_mins,
    }


def compute_salary_report(year: int, month: int, apply_sandwich: Optional[bool] = None) -> List[Dict]:
    """Compute salary report for ALL active employees for the given month with pre-computation precedence guarantee."""
    from core.recompute import recompute_all
    recompute_all()

    if apply_sandwich is None:
        apply_sandwich = db.get_setting("sandwich_rule", "yes").strip().lower() == "yes"
    emp_codes = db.get_all_active_emp_codes()
    raw_results = []
    for code in emp_codes:
        row = compute_salary_for_employee(code, year, month, apply_sandwich=apply_sandwich)
        if row:
            raw_results.append(row)

    # Sort output alphabetically by Name
    raw_results.sort(key=lambda r: str(r["Name"]).lower())

    if not raw_results:
        return []

    tot_salary = sum(r["_base_salary"] for r in raw_results)
    tot_earned = sum(r["_earned"] for r in raw_results)
    tot_deducted = sum(r["_deducted_amount"] for r in raw_results)
    tot_req_mins = sum(r["_req_mins"] for r in raw_results)
    tot_worked_mins = sum(r["_worked_mins"] for r in raw_results)
    tot_holiday_mins = sum(r["_holiday_mins"] for r in raw_results)
    tot_leave_credit = sum(r["_leave_credit"] for r in raw_results)
    tot_payable_mins = sum(r["_payable_mins"] for r in raw_results)
    tot_absents = sum(r["_absent_days"] for r in raw_results)
    tot_net_absent = sum(r["_net_absent_mins"] for r in raw_results)
    tot_late_early = sum(r["_late_early_mins"] for r in raw_results)

    results = []
    for r in raw_results:
        results.append({
            "Code":               str(r["Code"]),
            "Name":               str(r["Name"]),
            "Salary":             f"₹{r['_base_salary']:,.2f}/-",
            "Working Days":       r["Working Days"],
            "Absent":             r["Absent"],
            "Req Minutes":        f"{r['_req_mins']} mins",
            "Worked Mins":        f"{r['_worked_mins']} mins",
            "Holiday Mins":       f"{r['_holiday_mins']} mins",
            "Leave Credit Mins":  f"{r['_leave_credit']} mins",
            "Payable Mins":       f"{r['_payable_mins']} mins",
            "Per Min Rate":       f"₹{r['_per_min_rate']:.4f}/-",
            "Earned":             f"₹{r['_earned']:,.2f}/-",
            "Deducted Mins":      r["Deducted Mins"],
            "Deducted Amount":    f"₹{r['_deducted_amount']:,.2f}/-",
        })

    # Summary TOTAL row at the end
    results.append({
        "Code":               "",
        "Name":               "TOTAL",
        "Salary":             f"₹{tot_salary:,.2f}/-",
        "Working Days":       "",
        "Absent":             tot_absents,
        "Req Minutes":        f"{tot_req_mins} mins",
        "Worked Mins":        f"{tot_worked_mins} mins",
        "Holiday Mins":       f"{tot_holiday_mins} mins",
        "Leave Credit Mins":  f"{tot_leave_credit} mins",
        "Payable Mins":       f"{tot_payable_mins} mins",
        "Per Min Rate":       "",
        "Earned":             f"₹{tot_earned:,.2f}/-",
        "Deducted Mins":      f"{tot_net_absent} mins (absent) + {tot_late_early} mins (late/early)",
        "Deducted Amount":    f"₹{tot_deducted:,.2f}/-",
    })

    return results


