"""
core/query_builder.py
=====================
Converts GUI filter rows into parameterised SQLite WHERE clauses.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple


# ---------------------------------------------------------------------------
# Supported fields and their SQL column references
# ---------------------------------------------------------------------------

FIELD_MAP = {
    "Employee Name":    "emp_name",
    "Employee Code":    "emp_code",
    "Date":             "work_date",
    "Status":           "status",
    "Punch In Time":    "punch_in",
    "Punch Out Time":   "punch_out",
    "Hours Worked":     "work_hours",
    "Late Arrival":     "is_late",
    "Early Leave":      "left_early",
}

# Operators available per field category
TEXT_OPS = ["contains", "equals", "starts with", "ends with", "not equals"]
DATE_OPS = ["on", "before", "after", "between", "on or before", "on or after"]
TIME_OPS = ["before", "after", "equals"]
NUMBER_OPS = ["greater than", "less than", "equals", "greater or equal", "less or equal"]
STATUS_OPTS = ["PRESENT", "ABSENT", "WEEKLY_OFF", "HALF_DAY"]
BOOL_OPTS   = ["Yes", "No"]

FIELD_CATEGORIES = {
    "Employee Name":    "text",
    "Employee Code":    "text",
    "Date":             "date",
    "Status":           "status",
    "Punch In Time":    "time",
    "Punch Out Time":   "time",
    "Hours Worked":     "number",
    "Late Arrival":     "bool",
    "Early Leave":      "bool",
}


def get_operators_for_field(field_label: str) -> List[str]:
    cat = FIELD_CATEGORIES.get(field_label, "text")
    return {
        "text":   TEXT_OPS,
        "date":   DATE_OPS,
        "time":   TIME_OPS,
        "number": NUMBER_OPS,
        "status": ["is", "is not"],
        "bool":   ["is"],
    }.get(cat, TEXT_OPS)


def get_value_options_for_field(field_label: str) -> Optional[List[str]]:
    """Returns a list of options for dropdown fields, else None for free text."""
    cat = FIELD_CATEGORIES.get(field_label, "text")
    if cat == "status":
        return STATUS_OPTS
    if cat == "bool":
        return BOOL_OPTS
    return None


# ---------------------------------------------------------------------------
# Data structure
# ---------------------------------------------------------------------------

@dataclass
class FilterRow:
    field: str        # display name, e.g. "Employee Name"
    operator: str     # e.g. "contains"
    value: str        # user input
    value2: str = "" # second value for 'between'
    joiner: str = "AND"  # AND | OR — connector to NEXT filter row


@dataclass
class QuerySpec:
    filters: List[FilterRow] = field(default_factory=list)
    order_by: str = "work_date"
    order_dir: str = "ASC"
    limit: int = 5000


# ---------------------------------------------------------------------------
# SQL builder
# ---------------------------------------------------------------------------

def build_sql(spec: QuerySpec) -> Tuple[str, tuple]:
    """
    Build a SELECT SQL string and parameter tuple from a QuerySpec.
    Returns (sql, params).
    """
    base = """
SELECT
    a.emp_code    AS "Emp Code",
    a.emp_name    AS "Name",
    a.work_date   AS "Date",
    a.status      AS "Status",
    a.punch_in    AS "In",
    a.punch_out   AS "Out",
    a.work_hours  AS "Hours",
    a.is_late     AS "Late",
    a.left_early  AS "Left Early",
    a.report_file AS "Source File"
FROM attendance_raw a
"""
    where_clauses = []
    params = []

    for i, f in enumerate(spec.filters):
        col = FIELD_MAP.get(f.field)
        if not col:
            continue
        cat = FIELD_CATEGORIES.get(f.field, "text")

        clause, p = _build_clause(col, cat, f.operator, f.value, f.value2)
        if clause:
            if where_clauses:
                # Use previous row's joiner to connect
                joiner = spec.filters[i - 1].joiner if i > 0 else "AND"
                where_clauses.append(f"{joiner} {clause}")
            else:
                where_clauses.append(clause)
            params.extend(p)

    sql = base
    if where_clauses:
        sql += "WHERE " + " ".join(where_clauses) + "\n"

    # Order by
    safe_cols = list(FIELD_MAP.values()) + ["work_date", "emp_name", "emp_code", "work_hours", "punch_in"]
    ob = spec.order_by if spec.order_by in safe_cols else "work_date"
    od = "DESC" if spec.order_dir.upper() == "DESC" else "ASC"
    sql += f"ORDER BY {ob} {od}\n"

    if spec.limit > 0:
        sql += f"LIMIT {int(spec.limit)}\n"

    return sql.strip(), tuple(params)


def _build_clause(col: str, cat: str, op: str, val: str, val2: str) -> Tuple[str, list]:
    """Build a single WHERE clause fragment."""
    val = val.strip()
    if not val and op != "between":
        return "", []

    if cat == "text":
        if op == "contains":
            return f"LOWER({col}) LIKE LOWER(?)", [f"%{val}%"]
        if op == "equals":
            return f"LOWER({col}) = LOWER(?)", [val]
        if op == "starts with":
            return f"LOWER({col}) LIKE LOWER(?)", [f"{val}%"]
        if op == "ends with":
            return f"LOWER({col}) LIKE LOWER(?)", [f"%{val}"]
        if op == "not equals":
            return f"LOWER({col}) != LOWER(?)", [val]

    elif cat == "date":
        if op == "on":
            return f"{col} = ?", [val]
        if op == "before":
            return f"{col} < ?", [val]
        if op == "after":
            return f"{col} > ?", [val]
        if op == "on or before":
            return f"{col} <= ?", [val]
        if op == "on or after":
            return f"{col} >= ?", [val]
        if op == "between":
            v2 = val2.strip()
            if val and v2:
                return f"{col} BETWEEN ? AND ?", [val, v2]

    elif cat == "time":
        # Time stored as HH:MM strings — lexicographic comparison works
        if op == "before":
            return f"{col} < ?", [val]
        if op == "after":
            return f"{col} > ?", [val]
        if op == "equals":
            return f"{col} = ?", [val]

    elif cat == "number":
        try:
            float(val)
        except ValueError:
            return "", []
        if op == "greater than":
            return f"{col} > ?", [val]
        if op == "less than":
            return f"{col} < ?", [val]
        if op == "equals":
            return f"{col} = ?", [val]
        if op == "greater or equal":
            return f"{col} >= ?", [val]
        if op == "less or equal":
            return f"{col} <= ?", [val]

    elif cat == "status":
        if op == "is":
            return f"{col} = ?", [val.upper()]
        if op == "is not":
            return f"{col} != ?", [val.upper()]

    elif cat == "bool":
        bool_val = "1" if val.lower() == "yes" else "0"
        return f"{col} = ?", [bool_val]

    return "", []


def format_sql_readable(sql: str) -> str:
    """Basic SQL pretty-printer for display in the SQL panel."""
    import re
    keywords = ["SELECT", "FROM", "WHERE", "AND", "OR", "ORDER BY", "GROUP BY",
                "HAVING", "LIMIT", "LEFT JOIN", "INNER JOIN", "JOIN", "ON"]
    for kw in keywords:
        sql = re.sub(rf"\b{kw}\b", f"\n{kw}", sql, flags=re.IGNORECASE)
    # Clean up multiple blank lines
    sql = re.sub(r"\n{3,}", "\n\n", sql)
    return sql.strip()
