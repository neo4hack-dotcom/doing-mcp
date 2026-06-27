"""DOINg.MCP — generation of standalone MCP servers (FastMCP library).

Produces a complete bundle: server.py (single-file, embedded guardrails, rate-limiting,
PII masking, catalog exposed as an MCP resource), requirements.txt, README.md,
.env.example, catalog.json, manifest.json and a generic MCP client config snippet.
"""
import json
import re

import storage

TYPE_MAP = {"string": "str", "integer": "int", "number": "float", "boolean": "bool", "date": "str"}


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return slug or "mcp-server"


def py_ident(name: str) -> str:
    ident = re.sub(r"\W+", "_", (name or "").strip().lower()).strip("_")
    if not ident:
        ident = "tool"
    if ident[0].isdigit():
        ident = "t_" + ident
    return ident


def conn_key(conn: dict) -> str:
    return py_ident(conn.get("name") or conn.get("id") or "conn")


def conn_env_prefix(conn: dict) -> str:
    return "DOING_" + conn_key(conn).upper()


def _py_default(param: dict) -> str:
    value = param.get("default")
    ptype = param.get("type", "string")
    if value is None or value == "":
        return "None"
    try:
        if ptype == "integer":
            return repr(int(value))
        if ptype == "number":
            return repr(float(value))
        if ptype == "boolean":
            return repr(str(value).lower() in ("true", "1", "yes"))
    except (TypeError, ValueError):
        return "None"
    return repr(str(value))


def build_signature(params: list[dict]) -> str:
    required = [p for p in params if p.get("required", True)]
    optional = [p for p in params if not p.get("required", True)]
    parts = []
    for p in required:
        parts.append(f"{py_ident(p['name'])}: {TYPE_MAP.get(p.get('type', 'string'), 'str')}")
    for p in optional:
        pytype = TYPE_MAP.get(p.get("type", "string"), "str")
        default = _py_default(p)
        annotation = pytype if default != "None" else f"{pytype} | None"
        parts.append(f"{py_ident(p['name'])}: {annotation} = {default}")
    return ", ".join(parts)


def project_catalog(db: dict, project: dict) -> list[dict]:
    tools = [t for t in db["tools"] if t["id"] in project.get("tool_ids", [])]
    conn_ids = {t["connection_id"] for t in tools}
    out = []
    for cid in conn_ids:
        for table in (db["catalog"].get(cid) or {}).get("tables", []):
            out.append({
                "schema": table["schema"],
                "name": table["name"],
                "description": table.get("description") or table.get("comment") or "",
                "columns": [
                    {"name": c["name"], "type": c.get("type", ""),
                     "description": c.get("description") or c.get("comment") or "",
                     "pii": bool(c.get("pii"))}
                    for c in table.get("columns", [])
                ],
            })
    return out


_RUNTIME = '''
import json
import os
import re
import sqlite3
import threading
import time
from collections import deque

from fastmcp import FastMCP

_DENY_RE = re.compile(
    r"\\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|replace|attach|"
    r"detach|rename|optimize|kill|system|call|execute|exec|commit|rollback|savepoint|"
    r"lock|vacuum|outfile|infile|into|merge|set)\\b", re.IGNORECASE)
_EXFIL_RE = re.compile(
    r"\\b(url|file|remote|remotesecure|s3|s3cluster|hdfs|hdfscluster|mysql|postgresql|"
    r"jdbc|odbc|mongodb|redis|sqlite|executable|azureblobstorage|deltalake|hudi|iceberg|"
    r"urlcluster|gcs|deltalakecluster)\\s*\\(", re.IGNORECASE)
_PARAM_RE = re.compile(r"(?<![:\\w]):([A-Za-z_]\\w*)")

_CLIENTS: dict = {}
_CLIENT_LOCK = threading.Lock()
_RATE: dict = {}
_RATE_LOCK = threading.Lock()


def _env(prefix: str, key: str, default: str = "") -> str:
    return os.environ.get(prefix + "_" + key, default)


def _guard(sql: str) -> None:
    head = re.match(r"\\s*([A-Za-z]+)", sql)
    if not head or head.group(1).lower() not in ("select", "with"):
        raise ValueError("Guardrail: only SELECT queries are allowed.")
    if ";" in sql.rstrip().rstrip(";"):
        raise ValueError("Guardrail: only a single SQL statement is allowed.")
    bad = _DENY_RE.search(sql)
    if bad:
        raise ValueError("Guardrail: forbidden keyword '" + bad.group(1).upper() + "'.")
    exfil = _EXFIL_RE.search(sql)
    if exfil:
        raise ValueError("Guardrail: external I/O function not allowed '" + exfil.group(1) + "()'.")


def _rate(tool: str, per_min: int) -> None:
    with _RATE_LOCK:
        bucket = _RATE.setdefault(tool, deque())
        now = time.time()
        while bucket and now - bucket[0] > 60:
            bucket.popleft()
        if len(bucket) >= per_min:
            raise ValueError("Rate limit reached for '" + tool + "' (" + str(per_min) + "/min).")
        bucket.append(now)


def _demo_db():
    with _CLIENT_LOCK:
        if "demo" not in _CLIENTS:
            con = sqlite3.connect(":memory:", check_same_thread=False)
            _seed_demo(con)
            _CLIENTS["demo"] = con
        return _CLIENTS["demo"]


_NUM_RE = re.compile(r"-?\\d+(\\.\\d+)?")


def _rls_coerce(value: str):
    if _NUM_RE.fullmatch(value):
        return float(value) if "." in value else int(value)
    return value


def _rls_apply(sql: str, kind: str, policy: dict, identity) -> tuple:
    """Row-level security: wrap the query and filter projected columns for the caller.

    Fail-closed: a caller matching no rule gets zero rows unless the policy's
    default_visibility is "all". Values are bound as parameters.
    """
    ident = "" if identity is None else str(identity)
    by_col: dict = {}
    matched = False
    for rule in policy.get("rules", []):
        subjects = rule.get("subjects", [])
        if "*" in subjects or ident in subjects:
            matched = True
            bucket = by_col.setdefault(rule["column"], [])
            for val in rule.get("values", []):
                if val not in bucket:
                    bucket.append(val)
    inner = sql.rstrip().rstrip(";")
    if not matched:
        if policy.get("default_visibility") != "all":
            return ("SELECT * FROM (\\n" + inner + "\\n) doing_rls WHERE 1 = 0", {})
        return (inner, {})
    if not by_col:
        return (inner, {})
    conditions, params = [], {}
    for i, col in enumerate(sorted(by_col)):
        names = []
        for j, val in enumerate(by_col[col]):
            name = "rls_" + str(i) + "_" + str(j)
            params[name] = _rls_coerce(val)
            names.append(":" + name)
        quoted = col.upper() if kind == "oracle" else '"' + col + '"'
        conditions.append(quoted + " IN (" + ", ".join(names) + ")")
    return ("SELECT * FROM (\\n" + inner + "\\n) doing_rls WHERE " + " AND ".join(conditions),
            params)


def _flex_ref(kind, schema, table):
    if kind == "demo":
        return '"' + table + '"'
    return '"' + schema + '"."' + table + '"'


def _flex_build(spec, kind, args):
    """Assemble a SELECT from the caller's whitelisted field/aggregate/filter choices."""
    args = args or {}
    dims_allowed = list(spec.get("dimensions", []))
    metrics_allowed = set(spec.get("metrics", []))
    aggs_allowed = set(spec.get("aggregates", []))
    requested = [d.strip() for d in str(args.get("dimensions") or "").split(",") if d.strip()]
    bad = [d for d in requested if d not in dims_allowed]
    if bad:
        raise ValueError("Unknown dimension(s): " + ", ".join(bad))
    dims = [d for d in dims_allowed if d in requested]
    select = ['"' + d + '"' for d in dims]
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
        select.append(agg.upper() + '("' + metric + '") AS "' + agg + "_" + metric + '"')
        has_agg = True
    elif agg == "count":
        if "count" not in aggs_allowed:
            raise ValueError("Aggregate not allowed: count")
        select.append('COUNT(*) AS "count"')
        has_agg = True
    if not select:
        select = ["*"]
    where, params = [], {}
    for i, col in enumerate(spec.get("filters", [])):
        value = args.get(col)
        if value not in (None, ""):
            where.append('"' + col + '" = :flt_' + str(i))
            params["flt_" + str(i)] = value
    sql = "SELECT " + ", ".join(select) + " FROM " + _flex_ref(kind, spec.get("schema", ""), spec.get("table", ""))
    if where:
        sql += " WHERE " + " AND ".join(where)
    if has_agg and dims:
        sql += " GROUP BY " + ", ".join('"' + d + '"' for d in dims)
    order_by = str(args.get("order_by") or "").strip()
    if spec.get("allow_order", True) and order_by:
        valid = set(dims_allowed) | metrics_allowed | {"count"} | set(
            a + "_" + m for a in aggs_allowed for m in metrics_allowed)
        if order_by not in valid:
            raise ValueError("Cannot order by: " + order_by)
        direction = "DESC" if str(args.get("order_dir") or "asc").lower().startswith("desc") else "ASC"
        sql += ' ORDER BY "' + order_by + '" ' + direction
    try:
        limit = int(args.get("limit") or spec.get("default_limit", 100))
    except (TypeError, ValueError):
        limit = spec.get("default_limit", 100)
    limit = max(1, min(limit, spec.get("max_limit", 1000)))
    sql += ("\\nFETCH FIRST " + str(limit) + " ROWS ONLY") if kind == "oracle" else ("\\nLIMIT " + str(limit))
    return sql, params


def _execute(conn_name: str, sql: str, params: dict, max_rows: int,
             timeout_s: int, masked: list, policy: dict | None = None,
             identity=None, required: list | None = None) -> dict:
    cfg = CONNECTIONS[conn_name]
    rls_params: dict = {}
    if policy and policy.get("enabled") and policy.get("rules"):
        if identity in (None, ""):
            raise ValueError("Row-level security: the caller identity argument is required.")
        sql, rls_params = _rls_apply(sql, cfg["kind"], policy, identity)
    _guard(sql)
    used = set(_PARAM_RE.findall(sql))
    merged = dict(params or {})
    merged.update(rls_params)
    # Keep None binds (optional params -> SQL NULL); only required params must be set.
    bind = {k: merged.get(k) for k in used if k in merged}
    missing = [p for p in (required or []) if p in used and bind.get(p) is None]
    if missing:
        raise ValueError("Missing required parameters: " + ", ".join(sorted(missing)))
    missing = [p for p in used if p not in bind]
    if missing:
        raise ValueError("Missing required parameters: " + ", ".join(sorted(missing)))
    start = time.time()
    kind = cfg["kind"]
    prefix = cfg["env_prefix"]

    if kind == "demo":
        cur = _demo_db().execute(sql, bind)
        cols = [d[0] for d in cur.description or []]
        rows = cur.fetchmany(max_rows + 1)
    elif kind == "clickhouse":
        import clickhouse_connect
        client = clickhouse_connect.get_client(
            host=_env(prefix, "HOST", cfg.get("host", "localhost")),
            port=int(_env(prefix, "PORT", str(cfg.get("port", 8123)))),
            username=_env(prefix, "USER", cfg.get("username", "default")),
            password=_env(prefix, "PASSWORD", ""),
            database=_env(prefix, "DATABASE", cfg.get("database", "")) or None,
        )
        try:
            res = client.query(
                _PARAM_RE.sub(r"%(\\1)s", sql), parameters=bind,
                settings={"max_execution_time": timeout_s,
                          "max_result_rows": max_rows + 1,
                          "result_overflow_mode": "break"})
            cols = list(res.column_names)
            rows = list(res.result_rows)
        finally:
            client.close()
    elif kind == "oracle":
        import oracledb
        dsn = (_env(prefix, "HOST", cfg.get("host", "localhost")) + ":"
               + _env(prefix, "PORT", str(cfg.get("port", 1521))) + "/"
               + _env(prefix, "SERVICE", cfg.get("service_name", "")))
        con = oracledb.connect(user=_env(prefix, "USER", cfg.get("username", "")),
                               password=_env(prefix, "PASSWORD", ""), dsn=dsn)
        con.call_timeout = timeout_s * 1000
        try:
            cur = con.cursor()
            cur.execute(sql, bind)
            cols = [d[0] for d in cur.description or []]
            rows = cur.fetchmany(max_rows + 1)
        finally:
            con.close()
    else:
        raise ValueError("Unknown connection: " + kind)

    truncated = len(rows) > max_rows
    rows = rows[:max_rows]
    masked_idx = [i for i, c in enumerate(cols) if c.lower() in {m.lower() for m in masked}]
    out_rows = []
    for row in rows:
        line = [None if v is None else (v if isinstance(v, (bool, int, float, str)) else str(v))
                for v in row]
        for i in masked_idx:
            line[i] = "***MASKED***"
        out_rows.append(line)
    return {"columns": cols, "rows": out_rows, "row_count": len(out_rows),
            "elapsed_ms": round((time.time() - start) * 1000, 1), "truncated": truncated}
'''

_DEMO_SEED = '''
def _seed_demo(con) -> None:
    import datetime
    import random
    rng = random.Random(42)
    cur = con.cursor()
    cur.executescript("""
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, country TEXT,
  segment TEXT, created_at TEXT, lifetime_value REAL);
CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT, name TEXT, category TEXT, price REAL);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, order_date TEXT,
  status TEXT, total_amount REAL);
CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER,
  quantity INTEGER, unit_price REAL);
CREATE TABLE web_events (id INTEGER PRIMARY KEY, customer_id INTEGER, event_type TEXT,
  page TEXT, ts TEXT);
""")
    base = datetime.date(2026, 6, 1)
    countries = ["FR", "DE", "ES", "IT", "US", "UK", "BE", "CH"]
    segments = ["SMB", "Enterprise", "Consumer", "Startup"]
    categories = ["Audio", "Video", "Accessories", "Storage", "Network"]
    statuses = ["paid", "pending", "shipped", "cancelled", "refunded"]
    events = ["page_view", "add_to_cart", "checkout", "search", "login"]
    for i in range(1, 41):
        cat = rng.choice(categories)
        cur.execute("INSERT INTO products VALUES (?,?,?,?,?)",
                    (i, "SKU-%04d" % i, cat + " Pro " + str(i), cat, round(rng.uniform(9, 900), 2)))
    for i in range(1, 181):
        created = base - datetime.timedelta(days=rng.randint(30, 900))
        cur.execute("INSERT INTO customers VALUES (?,?,?,?,?,?,?)",
                    (i, "Customer %03d" % i, "customer%03d@example.com" % i, rng.choice(countries),
                     rng.choice(segments), created.isoformat(), round(rng.uniform(50, 25000), 2)))
    oid, iid = 0, 0
    for _ in range(900):
        oid += 1
        day = base - datetime.timedelta(days=rng.randint(0, 365))
        total = 0.0
        items = []
        for _ in range(rng.randint(1, 4)):
            iid += 1
            qty = rng.randint(1, 5)
            price = round(rng.uniform(9, 900), 2)
            total += qty * price
            items.append((iid, oid, rng.randint(1, 40), qty, price))
        cur.execute("INSERT INTO orders VALUES (?,?,?,?,?)",
                    (oid, rng.randint(1, 180), day.isoformat(), rng.choice(statuses), round(total, 2)))
        cur.executemany("INSERT INTO order_items VALUES (?,?,?,?,?)", items)
    base_dt = datetime.datetime(2026, 6, 1, 12, 0, 0)
    for i in range(1, 4001):
        ts = base_dt - datetime.timedelta(days=rng.randint(0, 90), seconds=rng.randint(0, 86400))
        cur.execute("INSERT INTO web_events VALUES (?,?,?,?,?)",
                    (i, rng.randint(1, 180), rng.choice(events),
                     rng.choice(["/", "/products", "/cart", "/account", "/help"]),
                     ts.isoformat(sep=" ")))
    con.commit()
'''


def generate_server_py(db: dict, project: dict) -> str:
    tools = [t for t in db["tools"] if t["id"] in project.get("tool_ids", []) and t.get("enabled", True)]
    conns = {t["connection_id"]: storage.find(db["connections"], t["connection_id"]) for t in tools}
    conns = {cid: c for cid, c in conns.items() if c}

    connections_cfg = {}
    for conn in conns.values():
        connections_cfg[conn_key(conn)] = {
            "kind": conn["kind"],
            "env_prefix": conn_env_prefix(conn),
            "host": conn.get("host", ""),
            "port": conn.get("port", 0),
            "database": conn.get("database", ""),
            "service_name": conn.get("service_name", ""),
            "username": conn.get("username", ""),
        }

    catalog = project_catalog(db, project)
    needs_demo = any(c["kind"] == "demo" for c in conns.values())

    lines: list[str] = []
    lines.append('"""' + project["name"] + " — MCP server generated by DOINg.MCP.\n\n"
                 "Read-only, embedded guardrails, rate-limiting and PII masking.\n"
                 'Transport: stdio (default) or HTTP via MCP_TRANSPORT=http MCP_PORT=<port>.\n"""')
    lines.append(_RUNTIME)
    if needs_demo:
        lines.append(_DEMO_SEED)
    else:
        lines.append("\ndef _seed_demo(con):\n    raise ValueError('No demo connection in this project.')\n")

    def embed(name: str, payload) -> str:
        """Embed a structure as safe Python source: json.loads(<str literal>).
        Avoids the false/true/null pitfalls of JSON literals pasted as-is."""
        return f"\n{name} = json.loads({json.dumps(json.dumps(payload, ensure_ascii=False), ensure_ascii=False)})"

    lines.append(embed("PROJECT", {
        "name": project["name"], "slug": project["slug"],
        "description": project.get("description", ""),
        "version": project.get("version", "1.0.0"),
        "generator": "DOINg.MCP",
    }))
    lines.append(embed("CONNECTIONS", connections_cfg))
    lines.append(embed("CATALOG", catalog))

    sql_map = {}
    rls_map = {}
    used_names: set[str] = set()
    flex_map: dict = {}
    tool_blocks: list[str] = []
    for tool in tools:
        name = py_ident(tool["name"])
        while name in used_names:
            name += "_2"
        used_names.add(name)
        conn = conns[tool["connection_id"]]
        sql_map[name] = tool["sql"]
        gr = tool.get("guardrails", {})
        flex_spec = tool.get("flex") or {}
        flexible = bool(flex_spec.get("enabled")) and bool(flex_spec.get("table"))
        params = list(tool.get("params", []))
        flex_params = list(params)  # the flexible selection params (before identity)
        desc = (tool.get("description") or tool["name"]).strip()
        if flexible:
            flex_map[name] = flex_spec
            desc += " Flexible tool: choose dimensions/metric/aggregate/filters/order at call time."

        policy = tool.get("row_policy") or {}
        rls_on = bool(policy.get("enabled")) and bool(policy.get("rules"))
        identity_arg = py_ident(policy.get("identity_arg") or "user_id") if rls_on else None
        if rls_on:
            rls_map[name] = {"enabled": True, "default_visibility": policy.get("default_visibility", "deny"),
                             "rules": policy.get("rules", [])}
            if identity_arg not in {py_ident(p["name"]) for p in params}:
                params = [{"name": identity_arg, "type": "string",
                           "description": "Caller identity (row-level access control).",
                           "required": True, "default": None}] + params
            desc += f" Requires `{identity_arg}` (caller identity): results are filtered by the row-level policy."

        signature = build_signature(params)
        params_dict = "{" + ", ".join(f'{json.dumps(p["name"])}: {py_ident(p["name"])}' for p in params) + "}"
        flex_args = "{" + ", ".join(f'{json.dumps(p["name"])}: {py_ident(p["name"])}' for p in flex_params) + "}"
        required = [p["name"] for p in params
                    if p.get("required", True) and py_ident(p["name"]) != identity_arg]

        block = [f"@mcp.tool(name={json.dumps(name)}, description={json.dumps(desc, ensure_ascii=False)})",
                 f"def {name}({signature}) -> dict:",
                 f"    _rate({json.dumps(name)}, {int(gr.get('rate_per_min', 120))})"]
        if flexible:
            block.append(f"    _q, _p = _flex_build(_FLEX[{json.dumps(name)}], "
                         f"CONNECTIONS[{json.dumps(conn_key(conn))}][\"kind\"], {flex_args})")
            sql_ref, params_ref, required_ref = "_q", "_p", "[]"
        else:
            sql_ref, params_ref, required_ref = f"_SQL[{json.dumps(name)}]", params_dict, json.dumps(required)
        block.append(f"    return _execute({json.dumps(conn_key(conn))}, {sql_ref}, {params_ref},")
        block.append(f"                    max_rows={int(gr.get('max_rows', 500))}, timeout_s={int(gr.get('timeout_s', 30))},")
        block.append(f"                    masked={json.dumps(gr.get('masked_columns', []), ensure_ascii=False)},")
        block.append(f"                    required={required_ref},")
        if rls_on:
            block.append(f"                    policy=_RLS[{json.dumps(name)}], identity={identity_arg})")
        else:
            block.append("                    policy=None, identity=None)")
        tool_blocks.append("\n".join(block))

    lines.append(embed("_SQL", sql_map))
    lines.append(embed("_RLS", rls_map))
    lines.append(embed("_FLEX", flex_map))

    instructions = (project.get("description") or project["name"]) + \
        " — read-only data server. Use the doing://catalog resource " \
        "or the catalog_search tool to discover the available tables."
    lines.append(f'\nmcp = FastMCP(name={json.dumps(project["name"], ensure_ascii=False)}, '
                 f'instructions={json.dumps(instructions, ensure_ascii=False)})')

    lines.append('''
@mcp.resource("doing://catalog")
def catalog_resource() -> str:
    """Complete data catalog for the project (tables, columns, descriptions, PII)."""
    return json.dumps(CATALOG, ensure_ascii=False, indent=1)


@mcp.tool(description="Search the data catalog: tables and columns matching the term.")
def catalog_search(term: str) -> dict:
    needle = term.lower()
    hits = []
    for table in CATALOG:
        cols = [c for c in table["columns"]
                if needle in c["name"].lower() or needle in (c.get("description") or "").lower()]
        if (needle in table["name"].lower()
                or needle in (table.get("description") or "").lower() or cols):
            hits.append({"schema": table["schema"], "name": table["name"],
                         "description": table.get("description", ""),
                         "matching_columns": [c["name"] for c in cols]})
    return {"matches": hits, "count": len(hits)}


@mcp.tool(description="Check that the MCP server is operational and list its tools.")
def ping() -> dict:
    return {"ok": True, "project": PROJECT, "tools": sorted(_SQL.keys()),
            "tables_in_catalog": len(CATALOG)}
''')

    lines.append("\n\n".join(tool_blocks))

    lines.append('''

if __name__ == "__main__":
    transport = os.environ.get("MCP_TRANSPORT", "stdio")
    if transport == "http":
        mcp.run(transport="http", host="127.0.0.1",
                port=int(os.environ.get("MCP_PORT", "8900")))
    else:
        mcp.run()
''')
    return "\n".join(lines)


def generate_requirements(db: dict, project: dict) -> str:
    tools = [t for t in db["tools"] if t["id"] in project.get("tool_ids", [])]
    kinds = set()
    for tool in tools:
        conn = storage.find(db["connections"], tool["connection_id"])
        if conn:
            kinds.add(conn["kind"])
    reqs = ["fastmcp>=2.3"]
    if "clickhouse" in kinds:
        reqs.append("clickhouse-connect>=0.8")
    if "oracle" in kinds:
        reqs.append("oracledb>=2.0")
    return "\n".join(reqs) + "\n"


def generate_env_example(db: dict, project: dict) -> str:
    tools = [t for t in db["tools"] if t["id"] in project.get("tool_ids", [])]
    conn_ids = {t["connection_id"] for t in tools}
    lines = ["# DOINg.MCP — environment variables (secrets are NEVER in the code)",
             "# MCP_TRANSPORT=stdio | http", "# MCP_PORT=8900", ""]
    for cid in conn_ids:
        conn = storage.find(db["connections"], cid)
        if not conn or conn["kind"] == "demo":
            continue
        prefix = conn_env_prefix(conn)
        lines.append(f"# Connection “{conn['name']}” ({conn['kind']})")
        lines.append(f"{prefix}_HOST={conn.get('host', '')}")
        lines.append(f"{prefix}_PORT={conn.get('port', '')}")
        lines.append(f"{prefix}_USER={conn.get('username', '')}")
        lines.append(f"{prefix}_PASSWORD=")
        if conn["kind"] == "clickhouse":
            lines.append(f"{prefix}_DATABASE={conn.get('database', '')}")
        else:
            lines.append(f"{prefix}_SERVICE={conn.get('service_name', '')}")
        lines.append("")
    return "\n".join(lines)


def mcp_client_snippet(project: dict) -> str:
    """Generic MCP client configuration (mcpServers schema) — works with any MCP client."""
    return json.dumps({
        "mcpServers": {
            project["slug"]: {
                "command": "python",
                "args": ["/absolute/path/to/" + project["slug"] + "/server.py"],
                "env": {"MCP_TRANSPORT": "stdio"},
            }
        }
    }, ensure_ascii=False, indent=2)


def generate_readme(db: dict, project: dict) -> str:
    tools = [t for t in db["tools"] if t["id"] in project.get("tool_ids", []) and t.get("enabled", True)]
    def first_line(text: str) -> str:
        lines = (text or "").splitlines()
        return lines[0][:100] if lines else "—"

    tool_rows = "\n".join(
        f"| `{py_ident(t['name'])}` | {first_line(t.get('description'))} | "
        f"{', '.join(p['name'] for p in t.get('params', [])) or '—'} |"
        for t in tools
    )
    return f"""# {project['name']}

MCP server generated by **DOINg.MCP** — {project.get('description') or 'read-only data access.'}

## Exposed tools

| Tool | Description | Parameters |
|---|---|---|
{tool_rows or '| — | No tool | — |'}

Plus the built-in tools: `ping`, `catalog_search`, and the MCP resource `doing://catalog`
(complete data catalog: tables, columns, descriptions, PII flags).

## Installation

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill in the passwords
```

## Running

```bash
# stdio mode (MCP clients):
python server.py

# HTTP mode (tests, integrations):
MCP_TRANSPORT=http MCP_PORT={project.get('port') or 8900} python server.py
```

## Connect to an MCP client

Add to your MCP client configuration (the standard `mcpServers` schema, adjust the path):

```json
{mcp_client_snippet(project)}
```

## Embedded security

- **Read-only**: only SELECT/WITH queries pass (deny-list of forbidden keywords).
- **A single statement** per query, parameters bound at the driver level (anti-injection).
- **Row cap and timeout** per tool.
- **Rate-limiting** per tool (calls/minute).
- **PII masking**: configured sensitive columns are replaced with `***MASKED***`.
- **Row-level security** (when configured): each call must carry the caller identity
  argument; rows are filtered per caller according to the embedded policy (fail-closed).
- **Zero secrets in the code**: credentials via environment variables only.

---
Generated on {storage.now_iso()} by DOINg.MCP.
"""


def generate_project_files(db: dict, project: dict) -> dict[str, str]:
    return {
        "server.py": generate_server_py(db, project),
        "requirements.txt": generate_requirements(db, project),
        "README.md": generate_readme(db, project),
        ".env.example": generate_env_example(db, project),
        "catalog.json": json.dumps(project_catalog(db, project), ensure_ascii=False, indent=1),
        "mcp_client_config.example.json": mcp_client_snippet(project),
        "manifest.json": json.dumps({
            "generator": "DOINg.MCP", "generated_at": storage.now_iso(),
            "project": {k: project.get(k) for k in
                        ("id", "name", "slug", "description", "transport", "port", "version")},
            "tools": [t["name"] for t in db["tools"] if t["id"] in project.get("tool_ids", [])],
        }, ensure_ascii=False, indent=1),
    }
