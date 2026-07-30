import sqlite3

conn = sqlite3.connect(':memory:')
conn.executescript("""
CREATE TABLE app_settings (key TEXT, value TEXT);
INSERT INTO app_settings VALUES ('checkin_time', '09:00'), ('checkout_time', '17:00');

CREATE TABLE attendance_raw (emp_code TEXT, emp_name TEXT, status TEXT, work_date DATE, punch_in TEXT, punch_out TEXT);
INSERT INTO attendance_raw VALUES 
  ('1', 'Alice', 'PRESENT', '2026-07-01', '08:45', '17:15'),  -- Worked extra, should be truncated to 09:00-17:00 (8h = 480m)
  ('1', 'Alice', 'PRESENT', '2026-07-02', '09:30', '16:30'),  -- Late and early, should be 09:30-16:30 (7h = 420m)
  ('1', 'Alice', 'ABSENT',  '2026-07-03', NULL, NULL),        -- Absent (will trigger 1 day leave credit = 480m)
  ('1', 'Alice', 'ABSENT',  '2026-07-04', NULL, NULL),        -- Absent again (no extra credit)
  
  ('2', 'Bob',   'PRESENT', '2026-07-01', '10:00', '18:00');  -- Custom schedule 10:00-18:00

CREATE TABLE employee_salary (emp_code TEXT, emp_name_override TEXT, monthly_salary REAL, custom_arrival TEXT, custom_departure TEXT, is_disabled INTEGER);
INSERT INTO employee_salary VALUES 
  ('1', 'Alice', 10000, NULL, NULL, 0),
  ('2', 'Bob',   10000, '10:00', '18:00', 0);

CREATE TABLE calendar_days (date DATE);
""")

query = """
WITH bounds AS (SELECT '2026-07-01' as mn, '2026-07-31' as mx),
config AS (
    SELECT 
        COALESCE((SELECT value FROM app_settings WHERE key='checkin_time'), '09:00') AS def_in,
        COALESCE((SELECT value FROM app_settings WHERE key='checkout_time'), '17:00') AS def_out,
        CAST(julianday((SELECT mx FROM bounds)) - julianday((SELECT mn FROM bounds)) + 1 AS INTEGER) AS total_days,
        (SELECT COUNT(*) FROM calendar_days WHERE date BETWEEN (SELECT mn FROM bounds) AND (SELECT mx FROM bounds)) AS holidays
),
daily_calc AS (
    SELECT 
        a.emp_code,
        a.emp_name,
        a.status,
        a.work_date,
        COALESCE(s.custom_arrival, c.def_in) AS sched_in,
        COALESCE(s.custom_departure, c.def_out) AS sched_out,
        a.punch_in,
        a.punch_out,
        -- Truncate punch_in and punch_out
        MAX(a.punch_in, COALESCE(s.custom_arrival, c.def_in)) AS eff_in,
        MIN(a.punch_out, COALESCE(s.custom_departure, c.def_out)) AS eff_out,
        CASE WHEN a.punch_in IS NOT NULL AND a.punch_out IS NOT NULL THEN
             MAX(0, (strftime('%s', '1970-01-01 ' || MIN(a.punch_out, COALESCE(s.custom_departure, c.def_out)) || ':00') - 
                     strftime('%s', '1970-01-01 ' || MAX(a.punch_in, COALESCE(s.custom_arrival, c.def_in)) || ':00')) / 60)
        ELSE 0 END AS valid_worked_mins,
        (strftime('%s', '1970-01-01 ' || COALESCE(s.custom_departure, c.def_out) || ':00') - 
         strftime('%s', '1970-01-01 ' || COALESCE(s.custom_arrival, c.def_in) || ':00')) / 60 AS shift_mins
    FROM attendance_raw a
    LEFT JOIN employee_salary s ON a.emp_code = s.emp_code
    CROSS JOIN config c
    WHERE COALESCE(s.is_disabled, 0) = 0
)
SELECT 
    d.emp_code AS "Emp Code",
    COALESCE((SELECT emp_name_override FROM employee_salary WHERE emp_code=d.emp_code), d.emp_name) AS "Name",
    COALESCE((SELECT monthly_salary FROM employee_salary WHERE emp_code=d.emp_code), 0) AS "Base Salary (₹)",
    (SELECT MAX(total_days - holidays, 1) FROM config) AS "Working Days",
    COUNT(CASE WHEN d.status='ABSENT' AND d.work_date NOT IN (SELECT date FROM calendar_days) THEN 1 END) AS "Absent",
    CASE 
        WHEN COUNT(CASE WHEN d.status='ABSENT' AND d.work_date NOT IN (SELECT date FROM calendar_days) THEN 1 END) > 0 
        THEN 1 ELSE 0 
    END AS "Leave Credit",
    MAX(d.shift_mins) * (SELECT MAX(total_days - holidays, 1) FROM config) AS "Req Mins",
    SUM(d.valid_worked_mins) AS "Worked Mins",
    SUM(d.valid_worked_mins) + 
      (CASE WHEN COUNT(CASE WHEN d.status='ABSENT' AND d.work_date NOT IN (SELECT date FROM calendar_days) THEN 1 END) > 0 THEN MAX(d.shift_mins) ELSE 0 END) 
      AS "Payable Mins",
    CASE 
        WHEN COALESCE((SELECT monthly_salary FROM employee_salary WHERE emp_code=d.emp_code), 0) > 0 THEN 
            ROUND(
                (COALESCE((SELECT monthly_salary FROM employee_salary WHERE emp_code=d.emp_code), 0) * 1.0 / 
                (MAX(d.shift_mins) * (SELECT MAX(total_days - holidays, 1) FROM config))) * 
                (SUM(d.valid_worked_mins) + 
                  (CASE WHEN COUNT(CASE WHEN d.status='ABSENT' AND d.work_date NOT IN (SELECT date FROM calendar_days) THEN 1 END) > 0 THEN MAX(d.shift_mins) ELSE 0 END)
                )
            , 2)
        ELSE 'N/A' 
    END AS "Earned (₹)"
FROM daily_calc d
GROUP BY d.emp_code, d.emp_name
ORDER BY CAST(d.emp_code AS INTEGER)
"""

print("Executing Query...")
for row in conn.execute(query):
    print(row)
