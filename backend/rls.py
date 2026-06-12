"""DOINg.MCP — Row-Level Security (RLS): per-tool, fully parameterizable visibility.

A tool may declare a *row policy* that constrains which rows the caller can see,
based on a captured caller identity (an extra tool argument, default `user_id`).

Model
-----
policy = {
  "enabled": bool,
  "identity_arg": "user_id",          # tool argument that carries the caller identity
  "default_visibility": "deny"|"all", # what a caller with no matching rule sees
  "rules": [
    {"subjects": ["u123", "u456"] | ["*"],  # which callers this rule applies to
     "column": "country",                    # the column to constrain
     "values": ["FR", "BE"]}                  # allowed values for that column
  ]
}

Semantics (fail-closed)
-----------------------
For a caller, gather the rules that match (subject == identity or "*"). Per column,
the allowed values are the union of its rules (OR). Across columns, all constraints
must hold (AND). A caller with no matching rule sees everything (default "all") or
nothing (default "deny"). Enforcement wraps the tool SQL as a subquery and filters
on the *projected* columns — DB-agnostic and safe:

    SELECT * FROM ( <tool sql> ) doing_rls WHERE "country" IN (:rls_0_0, ...)

(no AS keyword and no leading underscore: Oracle rejects both). Values are always
bound as parameters (anti-injection); column names are validated against a strict
identifier pattern.
"""
import re

IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_INT_RE = re.compile(r"-?\d+")
_FLOAT_RE = re.compile(r"-?\d+\.\d+")


def default_policy() -> dict:
    return {"enabled": False, "identity_arg": "user_id",
            "default_visibility": "deny", "rules": []}


def normalize(policy: dict | None) -> dict:
    p = policy or {}
    arg = str(p.get("identity_arg") or "user_id").strip()
    arg = arg if IDENT_RE.fullmatch(arg) else "user_id"
    rules = []
    for rule in p.get("rules") or []:
        if not isinstance(rule, dict):
            continue
        col = str(rule.get("column") or "").strip()
        if not IDENT_RE.fullmatch(col):  # drop rules with unsafe column identifiers
            continue
        subjects = [str(s).strip() for s in (rule.get("subjects") or []) if str(s).strip()]
        values = [str(v).strip() for v in (rule.get("values") or []) if str(v).strip()]
        if not subjects or not values:
            continue
        rules.append({"subjects": subjects, "column": col, "values": values})
    return {
        "enabled": bool(p.get("enabled")),
        "identity_arg": arg,
        "default_visibility": "all" if p.get("default_visibility") == "all" else "deny",
        "rules": rules,
    }


def is_active(policy: dict | None) -> bool:
    return bool(policy) and bool(policy.get("enabled")) and bool(policy.get("rules"))


def _coerce(value: str):
    if _INT_RE.fullmatch(value):
        return int(value)
    if _FLOAT_RE.fullmatch(value):
        return float(value)
    return value


def compute(policy: dict, identity_value) -> tuple[bool, dict]:
    """Returns (denied, {column: [values]}) for the given caller identity."""
    ident = "" if identity_value is None else str(identity_value)
    by_col: dict[str, list] = {}
    matched = False
    for rule in policy.get("rules", []):
        subjects = rule.get("subjects", [])
        if "*" in subjects or ident in subjects:
            matched = True
            existing = by_col.setdefault(rule["column"], [])
            for val in rule.get("values", []):
                if val not in existing:
                    existing.append(val)
    if not matched:
        return (policy.get("default_visibility") != "all", {})
    return (False, by_col)


def _quote(column: str, dialect: str) -> str:
    # Oracle folds unquoted identifiers to upper-case; match that for the subquery alias.
    if dialect == "oracle":
        return column.upper()
    return f'"{column}"'


def wrap_sql(base_sql: str, dialect: str, policy: dict, identity_value) -> tuple[str, dict]:
    """Returns (effective_sql, extra_params). `base_sql` must be a bare SELECT."""
    inner = base_sql.rstrip().rstrip(";")
    denied, by_col = compute(policy, identity_value)
    if denied:
        return (f"SELECT * FROM (\n{inner}\n) doing_rls WHERE 1 = 0", {})
    if not by_col:
        return (inner, {})
    conditions, params = [], {}
    for i, (col, values) in enumerate(sorted(by_col.items())):
        placeholders = []
        for j, val in enumerate(values):
            name = f"rls_{i}_{j}"
            params[name] = _coerce(val)
            placeholders.append(f":{name}")
        conditions.append(f"{_quote(col, dialect)} IN ({', '.join(placeholders)})")
    where = " AND ".join(conditions)
    return (f"SELECT * FROM (\n{inner}\n) doing_rls WHERE {where}", params)


def describe(policy: dict, identity_value) -> str:
    """Human-readable summary of what the caller is restricted to (for audit/UI)."""
    denied, by_col = compute(policy, identity_value)
    if denied:
        return "denied (no matching rule, default deny)"
    if not by_col:
        return "unrestricted"
    return "; ".join(f"{col} ∈ {{{', '.join(map(str, vals))}}}" for col, vals in sorted(by_col.items()))
