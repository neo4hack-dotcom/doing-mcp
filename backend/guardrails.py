"""DOINg.MCP — deterministic SQL guardrail engine.

Defense in depth, independent of the LLM:
 - read-only (SELECT / WITH only)
 - a single statement (no multiple ';')
 - deny-list of forbidden keywords (isolated tokens, outside literals/comments)
 - automatic LIMIT depending on the dialect
 - extraction of named parameters :param
"""
import re

DENY_DEFAULT = [
    "insert", "update", "delete", "drop", "alter", "truncate", "grant", "revoke",
    "create", "replace", "attach", "detach", "rename", "optimize", "kill",
    "system", "call", "execute", "exec", "commit", "rollback", "savepoint",
    "lock", "vacuum", "outfile", "infile", "into", "merge", "settings", "set",
]

PARAM_RE = re.compile(r"(?<![:\w]):([A-Za-z_]\w*)")
LIMIT_RE = re.compile(r"\blimit\s+(\d+|:\w+)", re.IGNORECASE)
FETCH_RE = re.compile(r"\bfetch\s+(first|next)\b", re.IGNORECASE)


def strip_literals(sql: str) -> str:
    """Replace strings, quoted identifiers and comments with spaces."""
    out = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "-" and sql[i:i + 2] == "--":
            j = sql.find("\n", i)
            i = n if j < 0 else j
        elif ch == "/" and sql[i:i + 2] == "/*":
            j = sql.find("*/", i + 2)
            i = n if j < 0 else j + 2
            out.append(" ")
        elif ch in ("'", '"', "`"):
            quote = ch
            j = i + 1
            while j < n:
                if sql[j] == quote:
                    if quote == "'" and sql[j:j + 2] == "''":
                        j += 2
                        continue
                    break
                j += 1
            out.append(" ")
            i = j + 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def extract_params(sql: str) -> list[str]:
    stripped = strip_literals(sql)
    seen: list[str] = []
    for match in PARAM_RE.finditer(stripped):
        name = match.group(1)
        if name not in seen:
            seen.append(name)
    return seen


def has_limit(sql: str) -> bool:
    stripped = strip_literals(sql)
    return bool(LIMIT_RE.search(stripped) or FETCH_RE.search(stripped))


def apply_limit(sql: str, dialect: str, max_rows: int) -> str:
    body = sql.rstrip().rstrip(";")
    if has_limit(body):
        return body
    if dialect == "oracle":
        return f"{body}\nFETCH FIRST {int(max_rows)} ROWS ONLY"
    return f"{body}\nLIMIT {int(max_rows)}"


def validate(sql: str, dialect: str, cfg: dict) -> dict:
    """Returns {ok, errors, warnings, params, sql} (sql = rewritten, ready to execute)."""
    errors: list[str] = []
    warnings: list[str] = []
    raw = (sql or "").strip()
    if not raw:
        return {"ok": False, "errors": ["Empty query."], "warnings": [], "params": [], "sql": ""}

    stripped = strip_literals(raw)

    # Single statement
    parts = [p for p in stripped.split(";") if p.strip()]
    if len(parts) > 1:
        errors.append("Multiple statements detected — only a single SELECT statement is allowed.")

    # Read-only
    first = re.match(r"\s*([A-Za-z]+)", stripped)
    first_kw = first.group(1).lower() if first else ""
    if cfg.get("read_only", True) and first_kw not in ("select", "with"):
        errors.append(f"Only SELECT/WITH queries are allowed (found: “{first_kw.upper() or '?'}”).")

    # Forbidden keywords
    deny = [k.lower() for k in (DENY_DEFAULT + list(cfg.get("deny_keywords") or []))]
    lowered = stripped.lower()
    found = sorted({kw for kw in deny if re.search(rf"\b{re.escape(kw)}\b", lowered)})
    if found:
        errors.append("Forbidden keywords detected: " + ", ".join(k.upper() for k in found) + ".")

    params = extract_params(raw)
    max_rows = int(cfg.get("max_rows", 500))

    final_sql = raw.rstrip().rstrip(";")
    if cfg.get("auto_limit", True):
        if not has_limit(final_sql):
            final_sql = apply_limit(final_sql, dialect, max_rows)
            warnings.append(f"LIMIT {max_rows} applied automatically ({'FETCH FIRST' if dialect == 'oracle' else 'LIMIT'}).")
    if not params and re.search(r"\bwhere\b", lowered) is None:
        warnings.append("No WHERE filter — the query scans the whole table.")

    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "params": params,
        "sql": final_sql,
    }
