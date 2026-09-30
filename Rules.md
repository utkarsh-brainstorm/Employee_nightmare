# Attendance Processor Pro — Comprehensive Rules & Architecture

This document serves as the absolute source of truth for the policies, rules, and architecture of the Attendance Processor Pro software. It is divided into sections for Teachers, Administrators, and Software Engineers.

---

## 👩‍🏫 SECTION 1: Rules Every Teacher Must Know
*These rules govern how your attendance is tracked and how your salary is computed.*

1. **Mandatory Punch In/Out:** You must punch in when you arrive and punch out when you leave.
2. **Single Punch Penalty:** If you forget to punch in OR punch out (leaving only one punch for the day), the system will automatically dock your pay for half the day (you will only be credited for 50% of your required shift).
3. **Late Arrivals & Early Departures:** If you arrive late or leave early, your salary will be deducted minute-by-minute for the exact time you missed based on your required schedule. 
4. **School Bus Exception:** If you are formally assigned to travel via the school transport, you are **exempt** from late arrival and early departure penalties. As long as you are marked "Present", you will receive 100% full pay for the day, regardless of what time the bus arrives or leaves.
5. **The Sandwich Rule:** If you take an unauthorized absence on the working days immediately adjacent to a Holiday or Weekly Off, you will lose pay for the Holiday/Weekly Off as well.
   * *Example:* If Sunday is a Weekly Off, and you are absent on Saturday and Monday, you will lose 3 days of pay (Saturday, Sunday, Monday).
   * *Example:* If you are absent only on Friday, but Saturday/Sunday are weekly offs, you only lose Friday.
6. **One-Day Leave Credit:** If you are absent for at least one day in the month, but it is **not** part of a Sandwich Rule violation, the system will automatically give you 1 paid leave credit (effectively refunding 1 day of absent deductions).

---

## 👨‍💼 SECTION 2: Rules Every Admin Must Know
*These rules govern how to operate the software and manage staff.*

1. **Priority of Schedules (The Priority Chain):** 
   If an employee has conflicting time schedules, the system determines their required In/Out time for the day in this exact order (Highest priority wins):
   * **Priority 1:** Employee Day Override (Set in the Employee Manager for a specific date).
   * **Priority 2:** Calendar Day Time (Set by right-clicking a date in the Calendar).
   * **Priority 3:** Employee Default Schedule (Permanent custom arrival/departure in Employee Manager).
   * **Priority 4:** Global Settings (The default school check-in/check-out time).
2. **Calendar Management:**
   * Left-click a calendar day to cycle between: Working Day → Weekly Off → Holiday → Normal.
   * Right-click a calendar day to set a **custom schedule** for the whole school on that day (e.g., Half day for an event).
3. **Automated Recomputation:** You do not need to manually fix past attendance when you change a setting. If you change a global setting, update a calendar day, or change an employee's bus status, the software instantly and automatically recalculates all affected records in the background.
4. **Raw Data Import:** Always import the raw Excel file straight from the biometric machine. Do not modify the Excel structure manually before importing.
5. **Disabled Employees:** If an employee leaves the organization, toggle their "Disabled" status in the Employee Manager. This removes them from all PDF reports and salary computations without deleting their historical data.

---

## 💻 SECTION 3: Rules Every Developer Must Know
*Engineering constraints and backend rules.*

1. **Single Source of Truth for Times:** 
   The `attendance_raw` table has `req_in` and `req_out` columns. These are populated by the `recompute.py` engine at write-time. The `salary_engine.py` reads these values directly. **Never** attempt to recalculate an employee's required time in the UI or in raw SQL queries; always read `req_in` and `req_out` from the table.
2. **Recompute Triggers:** 
   Any state mutation (Calendar change, Employee update, Global settings change, Import) must trigger the appropriate recompute function:
   * `recompute_for_date(date_str)`
   * `recompute_for_employee(emp_code)`
   * `recompute_single(emp_code, date_str)`
3. **No ORM:** 
   The project uses raw SQLite3 queries (`core/db.py`). Do not introduce SQLAlchemy or any ORM. 
4. **Window API Bridge:** 
   Frontend JS communicates with Python via `window.pywebview.api`. All new backend functions must be explicitly mapped in the `Api` class inside `api.py`.
5. **No Frameworks:** 
   The frontend is strictly Vanilla JS and Tailwind CSS. Do not introduce React, Vue, or heavy state management libraries.

---

## 🏗️ SECTION 4: Architectural Decisions
*Why the system is built the way it is.*

1. **PyWebView vs Electron:** 
   Electron bundles a massive Chromium binary. PyWebView uses the OS's native WebView (WebKit on Linux/Mac, EdgeWebView2 on Windows). This keeps the application binary footprint incredibly small while still allowing a modern HTML/CSS/JS interface.
2. **Thick Backend / Thin Frontend:** 
   All heavy lifting (Sandwich rules, PDF generation, SQL string building) happens in Python. The JavaScript frontend acts strictly as a dumb view layer, maintaining minimal state and rendering JSON arrays returned from Python.
3. **Atomic Write-Time Resolution vs Read-Time Aggregation:** 
   * **Write-Time (`recompute.py`):** The Priority Chain (figuring out if someone is late based on 4 layers of settings) is complex. We evaluate this immediately upon data entry/modification and save the result (`is_late`, `left_early`, `req_in`, `req_out`) to the row. This makes viewing tables instantly fast.
   * **Read-Time (`salary_engine.py`):** The Sandwich Rule and Leave Credits require analyzing a full month of contiguous data. These cannot be resolved atomically per row, so they are evaluated at read-time when the Salary Report is generated.

---

## ⚠️ SECTION 5: Known Flaws & System Limitations
*Every software has limits. These are the known flaws administration should be aware of.*

1. **Unforgiving Sandwich Rule (No Granular Leave Types):** 
   The system currently treats all absences as generic `ABSENT`. It cannot differentiate between an unapproved absence and an approved Medical Leave. Therefore, if an employee has an approved Medical Leave on Friday and Monday, the system will mercilessly deduct Saturday and Sunday via the Sandwich Rule unless the administrator manually intervenes (by adding a Day Override for those dates).
2. **Overtime is Unpaid (Hard Cap):** 
   The salary calculation explicitly caps `worked_minutes` to `shift_mins`. If a teacher is required to work 6 hours, but stays for 9 hours, the system only pays them for 6 hours. Overtime is completely unhandled.
3. **The Single Punch Loophole:** 
   If an employee forgets to punch out, they receive a 50% shift penalty. However, if a malicious employee arrives, punches in, stays for 15 minutes, leaves without punching out, they are still awarded 50% of their daily pay because the system simply detects a single punch.
4. **No Audit Trails:** 
   While the software logs raw SQL queries for debugging (`query_log`), there is no dedicated Admin Audit Trail. If an administrator manually modifies an employee's time in the database to favor them, there is no historical record proving who made the edit or what the original biometric time was.
5. **Strict Intraday Assumption (No Night Shifts):** 
   The system relies on basic `max(0, out - in)` time deltas assuming all work happens within the same calendar day. If a staff member works a night shift from `22:00` to `06:00`, the math will break completely and result in negative or zeroed time.
6. **Destructive Biometric Syncs:** 
   If the admin manually fixes a punch-in time in the software, and later re-imports the original raw Excel file from the biometric machine for the same time period, the Excel data will overwrite the manual fix. Admin overrides should ideally be kept to `employee_day_overrides` rather than altering the raw punch times.
