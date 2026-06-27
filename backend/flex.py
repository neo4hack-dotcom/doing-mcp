"""DOINg.MCP — flexible tool builder.

A flexible tool lets the calling agent choose, at call time, which fields to
return, which metric to aggregate and how, which filters to apply and how to
sort/limit — all assembled from a whitelist defined when the tool is created.
Identifiers are validated against that whitelist (never interpolated from raw
input) and values are bound as parameters, so the result is injection-proof.

spec = {
  "enabled": bool,
  "schema": "...", "table": "...",
  "dimensions": [col, ...],   # selectable output / group-by columns
  "metrics": [col, ...],      # numeric columns that can be aggregated
  "aggregates": ["count","sum","avg","min","max"],
  "filters": [col, ...],      # columns exposed as optional equality filters
  "allow_order": bool,
  "default_limit": int, "max_limit": int
}
"""
import re

AGGREGATES = ("count", "sum", "avg", "min", "max")
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def default_spec() -> dict:
    return {"enabled": False, "schema": "", "table": "", "dimensions": [], "metrics": [],
            "aggregates": list(AGGREGATES), "filters": [],
            "allow_order": True, "default_limit": 100, "max_limit": 1000}


def normalize(spec: dict | None, columns: list[str] | None = None) -> dict:
    s = spec or {}
    allowed = {c for c in columns if IDENT.fullmatch(c)} if columns is not None else None

    def keep(items) -> list[str]:
        out = []
        for c in items or []:
            c = str(c)
            if IDENT.fullmatch(c) and (allowed is None or c in allowed) and c not in out:
                out.append(c)
        return out

    aggs = [a for a in (s.get("aggregates") or []) if a in AGGREGATES] or ["count"]
    default_limit = max(1, int(s.get("default_limit") or 100))
    max_limit = max(default_limit, int(s.get("max_limit") or 1000))
    return {
        "enabled": bool(s.get("enabled")),
        "schema": str(s.get("schema") or ""),
        "table": str(s.get("table") or ""),
        "dimensions": keep(s.get("dimensions")),
        "metrics": keep(s.get("metrics")),
        "aggregates": aggs,
        "filters": keep(s.get("filters")),
        "allow_order": bool(s.get("allow_order", True)),
        "default_limit": default_limit,
        "max_limit": max_limit,
    }


def is_active(spec: dict | None) -> bool:
    return bool(spec) and bool(spec.get("enabled")) and bool(spec.get("table"))


def param_schema(spec: dict) -> list[dict]:
    """The MCP parameters this flexible tool exposes (all optional)."""
    params: list[dict] = []
    if spec["dimensions"]:
        params.append({"name": "dimensions", "type": "string", "required": False, "default": None,
                       "description": "Comma-separated columns to return / group by. Allowed: "
                       + ", ".join(spec["dimensions"]) + "."})
    if spec["metrics"]:
        params.append({"name": "metric", "type": "string", "required": False, "default": None,
                       "description": "Numeric column to aggregate. Allowed: " + ", ".join(spec["metrics"]) + "."})
        params.append({"name": "aggregate", "type": "string", "required": False, "default": None,
                       "description": "Aggregate function. Allowed: " + ", ".join(spec["aggregates"])
                       + ". Defaults to sum when a metric is given."})
    for col in spec["filters"]:
        params.append({"name": col, "type": "string", "required": False, "default": None,
                       "description": f"Optional equality filter on {col}."})
    if spec["allow_order"]:
        params.append({"name": "order_by", "type": "string", "required": False, "default": None,
                       "description": "Column or aggregate alias to sort by."})
        params.append({"name": "order_dir", "type": "string", "required": False, "default": None,
                       "description": "Sort direction: asc or desc."})
    params.append({"name": "limit", "type": "integer", "required": False, "default": None,
                   "description": f"Max rows (default {spec['default_limit']}, max {spec['max_limit']})."})
    return params


def _ref(dialect: str, schema: str, table: str) -> str:
    if dialect == "sqlite":
        return f'"{table}"'
    return f'"{schema}"."{table}"'


def build(spec: dict, dialect: str, args: dict) -> tuple[str, dict]:
    """Assemble (sql, bound_params) from validated, whitelisted pieces."""
    args = args or {}
    dims_allowed = set(spec["dimensions"])
    metrics_allowed = set(spec["metrics"])
    aggs_allowed = set(spec["aggregates"])

    requested = [d.strip() for d in str(args.get("dimensions") or "").split(",") if d.strip()]
    bad = [d for d in requested if d not in dims_allowed]
    if bad:
        raise ValueError("Unknown dimension(s): " + ", ".join(bad))
    dims = [d for d in dims_allowed if d in requested]  # preserve spec order, dedupe

    select = [f'"{d}"' for d in dims]
    has_agg = False
    metric = str(args.get("metric") or "").strip()
    agg = str(args.get("aggregate") or "").strip().lower()
    if metric:
        if metric not in metrics_allowed:
            raise ValueError("Unknown metric: " + metric)
        if not agg:
            agg = "sum"
        if agg not in aggs_allowed:
            raise ValueError("Aggregate not allowed: " + agg)
        select.append(f'{agg.upper()}("{metric}") AS "{agg}_{metric}"')
        has_agg = True
    elif agg == "count":
        if "count" not in aggs_allowed:
            raise ValueError("Aggregate not allowed: count")
        select.append('COUNT(*) AS "count"')
        has_agg = True
    if not select:
        select = ["*"]

    where, params = [], {}
    for i, col in enumerate(spec["filters"]):
        value = args.get(col)
        if value not in (None, ""):
            where.append(f'"{col}" = :flt_{i}')
            params[f"flt_{i}"] = value

    sql = f'SELECT {", ".join(select)} FROM {_ref(dialect, spec["schema"], spec["table"])}'
    if where:
        sql += " WHERE " + " AND ".join(where)
    if has_agg and dims:
        sql += " GROUP BY " + ", ".join(f'"{d}"' for d in dims)

    order_by = str(args.get("order_by") or "").strip()
    if spec["allow_order"] and order_by:
        valid_order = dims_allowed | metrics_allowed | {"count"} \
            | {f"{a}_{m}" for a in aggs_allowed for m in metrics_allowed}
        if order_by not in valid_order:
            raise ValueError("Cannot order by: " + order_by)
        direction = "DESC" if str(args.get("order_dir") or "asc").lower().startswith("desc") else "ASC"
        sql += f' ORDER BY "{order_by}" {direction}'

    try:
        limit = int(args.get("limit") or spec["default_limit"])
    except (TypeError, ValueError):
        limit = spec["default_limit"]
    limit = max(1, min(limit, spec["max_limit"]))
    sql += f"\nFETCH FIRST {limit} ROWS ONLY" if dialect == "oracle" else f"\nLIMIT {limit}"
    return sql, params
