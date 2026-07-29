"""
core/query_builder.py
=====================
Converts GUI filter rows into parameterised SQLite WHERE clauses.
V4: adds SELECT fields, GROUP BY, HAVING and conflict detection.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple


# ---------------------------------------------------------------------------
# Field maps
# ---------------------------------------------------------------------------

FIELD_MAP = {
    "Employee Name":  "emp_name",
    "Employee ID":    "emp_code",
    "Date":           "work_date",
    "Status":         "status",
    "Arrival Time":   "punch_in",
    "Departure Time": "punch_out",
    "Hours Worked":   "work_hours",
    "Arrived Late?":  "is_late",
    "Left Early?":    "left_early",
}

TEXT_OPS   = ["contains", "equals", "starts with", "ends with", "not equals"]
DATE_OPS   = ["on", "before", "after", "between", "on or before", "on or after"]
TIME_OPS   = ["before", "after", "equals"]
NUMBER_OPS = ["greater than", "less than", "equals", "greater or equal", "less or equal"]
STATUS_OPTS = ["PRESENT", "ABSENT", "WEEKLY_OFF", "HALF_DAY"]
BOOL_OPTS   = ["Yes", "No"]

FIELD_CATEGORIES = {
    "Employee Name":  "text",
    "Employee ID":    "text",
    "Date":           "date",
    "Status":         "status",
    "Arrival Time":   "time",
    "Departure Time": "time",
    "Hours Worked":   "number",
    "Arrived Late?":  "bool",
    "Left Early?":    "bool",
}

# SELECT-able columns (regular, non-aggregate)
SELECT_COLS = [
    {"label": "Employee Name",   "expr": "emp_name",    "alias": None,             "aggregate": False},
    {"label": "Employee ID",     "expr": "emp_code",    "alias": None,             "aggregate": False},
    {"label": "Date",            "expr": "work_date",   "alias": None,             "aggregate": False},
    {"label": "Status",          "expr": "status",      "alias": None,             "aggregate": False},
    {"label": "Arrival Time",    "expr": "punch_in",    "alias": '"Arrival"',      "aggregate": False},
    {"label": "Departure Time",  "expr": "punch_out",   "alias": '"Departure"',    "aggregate": False},
    {"label": "Hours Worked",    "expr": "work_hours",  "alias": '"Hours"',        "aggregate": False},
    {"label": "Late?",           "expr": "is_late",     "alias": '"Late"',         "aggregate": False},
    {"label": "Left Early?",     "expr": "left_early",  "alias": '"Left Early"',   "aggregate": False},
    # Aggregates
    {"label": "# Records",       "expr": "COUNT(*)",                                              "alias": '"Records"',      "aggregate": True},
    {"label": "# Days Present",  "expr": "SUM(CASE WHEN status='PRESENT' THEN 1 ELSE 0 END)",    "alias": '"Days Present"',  "aggregate": True},
    {"label": "# Days Absent",   "expr": "SUM(CASE WHEN status='ABSENT' THEN 1 ELSE 0 END)",     "alias": '"Days Absent"',   "aggregate": True},
    {"label": "# Late Days",     "expr": "SUM(is_late)",                                          "alias": '"Late Days"',     "aggregate": True},
    {"label": "Total Hours",     "expr": "SUM(work_hours)",                                       "alias": '"Total Hours"',   "aggregate": True},
    {"label": "Avg Hours/Day",   "expr": "ROUND(AVG(work_hours),2)",                              "alias": '"Avg Hours"',     "aggregate": True},
    {"label": "Earliest Arrival","expr": "MIN(punch_in)",                                         "alias": '"Earliest In"',   "aggregate": True},
    {"label": "Latest Arrival",  "expr": "MAX(punch_in)",                                         "alias": '"Latest In"',     "aggregate": True},
]

# GROUP BY-able columns (no aggregates)
GROUPBY_COLS = [
    {"label": "Employee Name", "expr": "emp_name"},
    {"label": "Employee ID",   "expr": "emp_code"},
    {"label": "Date",          "expr": "work_date"},
    {"label": "Status",        "expr": "status"},
    {"label": "Month",         "expr": "strftime('%Y-%m', work_date)"},
    {"label": "Year",          "expr": "strftime('%Y', work_date)"},
    {"label": "Late?",         "expr": "is_late"},
]


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
    cat = FIELD_CATEGORIES.get(field_label, "text")
    if cat == "status": return STATUS_OPTS
    if cat == "bool":   return BOOL_OPTS
    return None


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class FilterRow:
    field:    str
    operator: str
    value:    str
    value2:   str = ""
    joiner:   str = "AND"


@dataclass
class QuerySpec:
    filters:       List[FilterRow] = field(default_factory=list)
    order_by:      str = "work_date"
    order_dir:     str = "ASC"
    limit:         int = 5000
    # V4: aggregation
    select_exprs:  List[str] = field(default_factory=list)   # SQL expressions e.g. ["emp_name", "COUNT(*)"]
    select_labels: List[str] = field(default_factory=list)   # display labels matching select_exprs
    group_by_exprs:List[str] = field(default_factory=list)   # SQL expressions e.g. ["emp_name"]
    having:        str = ""                                   # raw HAVING clause e.g. "COUNT(*) > 3"


# ---------------------------------------------------------------------------
# Conflict detection
# ---------------------------------------------------------------------------

def detect_group_conflict(select_exprs: List[str], select_is_agg: List[bool],
                          group_by_exprs: List[str]) -> bool:
    """
    Returns True if the SELECT list mixes aggregate and non-grouped regular columns.
    i.e. there is at least one non-aggregate selected column that is NOT in GROUP BY.
    """
    if not group_by_exprs:
        return False  # No GROUP BY — no conflict
    has_aggregate = any(select_is_agg)
    if not has_aggregate:
        return False  # GROUP BY with no aggregates is fine (de-duplication)
    group_set = set(g.strip() for g in group_by_exprs)
    for expr, is_agg in zip(select_exprs, select_is_agg):
        if not is_agg and expr.strip() not in group_set:
            return True   # Non-aggregate, non-grouped → conflict
    return False


# ---------------------------------------------------------------------------
# WHERE clause builder
# ---------------------------------------------------------------------------

def _build_where(filters: List[FilterRow]) -> Tuple[str, tuple, str]:
    """
    Returns (where_sql_parameterized, params, where_sql_display)
    where_sql_display has values interpolated (no ?).
    """
    clauses_param   = []
    clauses_display = []
    params = []

    for i, f in enumerate(filters):
        col = FIELD_MAP.get(f.field)
        if not col:
            continue
        cat = FIELD_CATEGORIES.get(f.field, "text")
        clause_p, clause_d, p = _build_clause(col, cat, f.operator, f.value, f.value2)
        if not clause_p:
            continue
        joiner = filters[i - 1].joiner if i > 0 else "AND"
        prefix = (joiner + " ") if clauses_param else ""
        clauses_param.append(prefix + clause_p)
        clauses_display.append(prefix + clause_d)
        params.extend(p)

    if not clauses_param:
        return "", tuple(), ""
    where_p = "WHERE " + " ".join(clauses_param)
    where_d = "WHERE " + " ".join(clauses_display)
    return where_p, tuple(params), where_d


def _build_clause(col: str, cat: str, op: str, val: str, val2: str) -> Tuple[str, str, list]:
    """Returns (parameterized_sql, display_sql, params)."""
    val = val.strip()
    if not val and op != "between":
        return "", "", []

    def esc(v: str) -> str:
        return v.replace("'", "''")

    if cat == "text":
        mapping = {
            "contains":    (f"LOWER({col}) LIKE LOWER(?)",    f"LOWER({col}) LIKE LOWER('%{esc(val)}%')", [f"%{val}%"]),
            "equals":      (f"LOWER({col}) = LOWER(?)",       f"LOWER({col}) = LOWER('{esc(val)}')",      [val]),
            "starts with": (f"LOWER({col}) LIKE LOWER(?)",    f"LOWER({col}) LIKE LOWER('{esc(val)}%')", [f"{val}%"]),
            "ends with":   (f"LOWER({col}) LIKE LOWER(?)",    f"LOWER({col}) LIKE LOWER('%{esc(val)}')", [f"%{val}"]),
            "not equals":  (f"LOWER({col}) != LOWER(?)",      f"LOWER({col}) != LOWER('{esc(val)}')",    [val]),
        }
        if op in mapping:
            p, d, prm = mapping[op]; return p, d, prm

    elif cat == "date":
        if op == "between":
            v2 = val2.strip()
            if val and v2:
                return (f"{col} BETWEEN ? AND ?",
                        f"{col} BETWEEN '{esc(val)}' AND '{esc(v2)}'",
                        [val, v2])
        mapping = {
            "on":          (f"{col} = ?",   f"{col} = '{esc(val)}'"),
            "before":      (f"{col} < ?",   f"{col} < '{esc(val)}'"),
            "after":       (f"{col} > ?",   f"{col} > '{esc(val)}'"),
            "on or before":(f"{col} <= ?",  f"{col} <= '{esc(val)}'"),
            "on or after": (f"{col} >= ?",  f"{col} >= '{esc(val)}'"),
        }
        if op in mapping: p, d = mapping[op]; return p, d, [val]

    elif cat == "time":
        mapping = {
            "before": (f"{col} < ?", f"{col} < '{esc(val)}'"),
            "after":  (f"{col} > ?", f"{col} > '{esc(val)}'"),
            "equals": (f"{col} = ?", f"{col} = '{esc(val)}'"),
        }
        if op in mapping: p, d = mapping[op]; return p, d, [val]

    elif cat == "number":
        try: float(val)
        except ValueError: return "", "", []
        mapping = {
            "greater than":  (f"{col} > ?",  f"{col} > {val}"),
            "less than":     (f"{col} < ?",  f"{col} < {val}"),
            "equals":        (f"{col} = ?",  f"{col} = {val}"),
            "greater or equal":(f"{col} >= ?", f"{col} >= {val}"),
            "less or equal": (f"{col} <= ?", f"{col} <= {val}"),
        }
        if op in mapping: p, d = mapping[op]; return p, d, [val]

    elif cat == "status":
        uv = val.upper()
        if op == "is":     return f"{col} = ?",  f"{col} = '{uv}'",  [uv]
        if op == "is not": return f"{col} != ?", f"{col} != '{uv}'", [uv]

    elif cat == "bool":
        bv = "1" if val.lower() == "yes" else "0"
        return f"{col} = ?", f"{col} = {bv}", [bv]

    return "", "", []


# ---------------------------------------------------------------------------
# Main build_sql
# ---------------------------------------------------------------------------

def build_sql(spec: QuerySpec) -> Tuple[str, tuple, str]:
    """
    Build SELECT SQL.
    Returns (sql_parameterized, params, sql_display).
    sql_display has values interpolated (shown in the UI SQL editor).
    """
    where_p, params, where_d = _build_where(spec.filters)

    # Determine SELECT list
    if spec.select_exprs:
        sel_parts = []
        for expr, label in zip(spec.select_exprs, spec.select_labels):
            alias = f' AS "{label}"' if label and label != expr else ""
            sel_parts.append(f"  {expr}{alias}")
        select_sql = "SELECT\n" + ",\n".join(sel_parts)
    else:
        select_sql = (
            "SELECT\n"
            "  emp_code, emp_name, work_date, status,\n"
            "  punch_in AS \"In\", punch_out AS \"Out\",\n"
            "  work_hours AS \"Hours\", is_late AS \"Late\", left_early AS \"Left Early\""
        )

    from_sql = "FROM attendance_raw"

    # GROUP BY
    group_sql = ""
    if spec.group_by_exprs:
        group_sql = "GROUP BY " + ", ".join(spec.group_by_exprs)

    # HAVING
    having_sql = ""
    if spec.having and spec.group_by_exprs:
        having_sql = "HAVING " + spec.having

    # ORDER BY (skip if GROUP BY present — different column set)
    safe_cols = list(FIELD_MAP.values()) + ["work_date", "emp_name", "emp_code", "work_hours"]
    ob = spec.order_by if spec.order_by in safe_cols else "work_date"
    od = "DESC" if spec.order_dir.upper() == "DESC" else "ASC"
    order_sql = f"ORDER BY {ob} {od}"
    if spec.group_by_exprs:
        order_sql = ""  # Don't add ORDER BY to grouped queries — can cause issues

    limit_sql = f"LIMIT {int(spec.limit)}" if spec.limit > 0 else ""

    parts = [select_sql, from_sql]
    if where_p:    parts.append(where_p)
    if group_sql:  parts.append(group_sql)
    if having_sql: parts.append(having_sql)
    if order_sql:  parts.append(order_sql)
    if limit_sql:  parts.append(limit_sql)

    sql_p = "\n".join(p for p in parts if p)

    # Build display version (with values interpolated)
    parts_d = [select_sql, from_sql]
    if where_d:    parts_d.append(where_d)
    if group_sql:  parts_d.append(group_sql)
    if having_sql: parts_d.append(having_sql)
    if order_sql:  parts_d.append(order_sql)
    if limit_sql:  parts_d.append(limit_sql)
    sql_d = "\n".join(p for p in parts_d if p)

    return sql_p, params, sql_d


def build_detail_sql(spec: QuerySpec) -> Tuple[str, tuple, str]:
    """
    Build the detail (non-grouped) version of a query.
    Used for the conflict dual-table view.
    """
    detail_spec = QuerySpec(
        filters=spec.filters,
        order_by=spec.order_by,
        order_dir=spec.order_dir,
        limit=spec.limit,
        # No select/group/having — use default full columns
    )
    return build_sql(detail_spec)


def format_sql_readable(sql: str) -> str:
    """Basic SQL pretty-printer for display."""
    import re
    for kw in ["SELECT", "FROM", "WHERE", "AND", "OR", "ORDER BY",
               "GROUP BY", "HAVING", "LIMIT"]:
        sql = re.sub(rf"(?<![A-Z])\b{kw}\b(?![A-Z])", f"\n{kw}", sql, flags=re.IGNORECASE)
    sql = re.sub(r"\n{3,}", "\n\n", sql)
    return sql.strip()
