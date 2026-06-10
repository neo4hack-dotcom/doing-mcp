"""DOINg.MCP — database connectors: ClickHouse, Oracle and a Demo sandbox (SQLite).

Every function receives the `conn` dict stored in db.json (with password).
Drivers are imported lazily: the app works even without clickhouse-connect
or oracledb installed (explicit error on first use).
"""
import datetime
import math
import random
import re
import sqlite3
import threading
import time

import guardrails

ORACLE_SYSTEM_SCHEMAS = (
    "'SYS','SYSTEM','OUTLN','XDB','CTXSYS','MDSYS','ORDSYS','ORDDATA','DBSNMP',"
    "'APPQOSSYS','WMSYS','GSMADMIN_INTERNAL','LBACSYS','OJVMSYS','DVSYS','AUDSYS',"
    "'OLAPSYS','REMOTE_SCHEDULER_AGENT','DBSFWUSER'"
)


def dialect(kind: str) -> str:
    return {"clickhouse": "clickhouse", "oracle": "oracle", "demo": "sqlite"}.get(kind, "sqlite")


def json_safe(value):
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, (bytes, bytearray)):
        return value.hex()[:64]
    return str(value)


# ---------------------------------------------------------------- Demo (SQLite)

_DEMO_CON: sqlite3.Connection | None = None
_DEMO_LOCK = threading.Lock()

_DEMO_DDL = """
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, country TEXT,
  segment TEXT, created_at TEXT, lifetime_value REAL);
CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT, name TEXT, category TEXT, price REAL);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, order_date TEXT,
  status TEXT, total_amount REAL);
CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER,
  quantity INTEGER, unit_price REAL);
CREATE TABLE web_events (id INTEGER PRIMARY KEY, customer_id INTEGER, event_type TEXT,
  page TEXT, ts TEXT);
"""


def _seed_demo(con: sqlite3.Connection) -> None:
    rng = random.Random(42)
    cur = con.cursor()
    cur.executescript(_DEMO_DDL)
    countries = ["FR", "DE", "ES", "IT", "US", "UK", "BE", "CH"]
    segments = ["SMB", "Enterprise", "Consumer", "Startup"]
    categories = ["Audio", "Video", "Accessories", "Storage", "Network"]
    statuses = ["paid", "pending", "shipped", "cancelled", "refunded"]
    events = ["page_view", "add_to_cart", "checkout", "search", "login"]
    base = datetime.date(2026, 6, 1)

    for i in range(1, 41):
        cat = rng.choice(categories)
        cur.execute("INSERT INTO products VALUES (?,?,?,?,?)",
                    (i, f"SKU-{i:04d}", f"{cat} Pro {i}", cat, round(rng.uniform(9, 900), 2)))
    for i in range(1, 181):
        created = base - datetime.timedelta(days=rng.randint(30, 900))
        cur.execute("INSERT INTO customers VALUES (?,?,?,?,?,?,?)",
                    (i, f"Customer {i:03d}", f"customer{i:03d}@example.com", rng.choice(countries),
                     rng.choice(segments), created.isoformat(), round(rng.uniform(50, 25000), 2)))
    order_id, item_id = 0, 0
    for _ in range(900):
        order_id += 1
        cust = rng.randint(1, 180)
        day = base - datetime.timedelta(days=rng.randint(0, 365))
        n_items = rng.randint(1, 4)
        total = 0.0
        rows = []
        for _ in range(n_items):
            item_id += 1
            pid = rng.randint(1, 40)
            qty = rng.randint(1, 5)
            price = round(rng.uniform(9, 900), 2)
            total += qty * price
            rows.append((item_id, order_id, pid, qty, price))
        cur.execute("INSERT INTO orders VALUES (?,?,?,?,?)",
                    (order_id, cust, day.isoformat(), rng.choice(statuses), round(total, 2)))
        cur.executemany("INSERT INTO order_items VALUES (?,?,?,?,?)", rows)
    base_dt = datetime.datetime(2026, 6, 1, 12, 0, 0)
    for i in range(1, 4001):
        ts = base_dt - datetime.timedelta(days=rng.randint(0, 90), seconds=rng.randint(0, 86400))
        cur.execute("INSERT INTO web_events VALUES (?,?,?,?,?)",
                    (i, rng.randint(1, 180), rng.choice(events),
                     rng.choice(["/", "/products", "/cart", "/account", "/help"]),
                     ts.isoformat(sep=" ")))
    con.commit()


def demo_connection() -> sqlite3.Connection:
    global _DEMO_CON
    with _DEMO_LOCK:
        if _DEMO_CON is None:
            _DEMO_CON = sqlite3.connect(":memory:", check_same_thread=False)
            _seed_demo(_DEMO_CON)
        return _DEMO_CON


# ---------------------------------------------------------------- Clients

def _clickhouse_client(conn: dict):
    try:
        import clickhouse_connect
    except ImportError as exc:
        raise RuntimeError("Missing driver: pip install clickhouse-connect") from exc
    return clickhouse_connect.get_client(
        host=conn.get("host") or "localhost",
        port=int(conn.get("port") or 8123),
        username=conn.get("username") or "default",
        password=conn.get("password") or "",
        database=conn.get("database") or None,
        secure=bool(conn.get("secure")),
        connect_timeout=5,
    )


def _oracle_connect(conn: dict, timeout_s: int = 30):
    try:
        import oracledb
    except ImportError as exc:
        raise RuntimeError("Missing driver: pip install oracledb") from exc
    dsn = f"{conn.get('host') or 'localhost'}:{int(conn.get('port') or 1521)}/{conn.get('service_name') or 'FREEPDB1'}"
    con = oracledb.connect(user=conn.get("username") or "", password=conn.get("password") or "", dsn=dsn)
    con.call_timeout = int(timeout_s * 1000)
    return con


# ---------------------------------------------------------------- Public API

def test(conn: dict) -> dict:
    start = time.time()
    kind = conn.get("kind")
    try:
        if kind == "demo":
            demo_connection().execute("SELECT 1").fetchone()
            server = "SQLite (built-in sandbox)"
        elif kind == "clickhouse":
            client = _clickhouse_client(conn)
            server = "ClickHouse " + str(client.server_version)
            client.close()
        elif kind == "oracle":
            con = _oracle_connect(conn, 10)
            server = "Oracle " + (getattr(con, "version", "") or "")
            con.close()
        else:
            return {"ok": False, "latency_ms": 0, "message": f"Unknown type: {kind}"}
        return {"ok": True, "latency_ms": round((time.time() - start) * 1000, 1), "message": server}
    except Exception as exc:  # noqa: BLE001 — surfaced as-is to the UI
        return {"ok": False, "latency_ms": round((time.time() - start) * 1000, 1), "message": str(exc)[:400]}


def list_tables(conn: dict) -> list[dict]:
    kind = conn.get("kind")
    if kind == "demo":
        con = demo_connection()
        out = []
        for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            count = con.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
            out.append({"schema": "demo", "name": name, "rows": count, "comment": ""})
        return out
    if kind == "clickhouse":
        client = _clickhouse_client(conn)
        try:
            res = client.query(
                "SELECT database, name, total_rows, comment FROM system.tables "
                "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
                "ORDER BY database, name"
            )
            return [{"schema": r[0], "name": r[1], "rows": json_safe(r[2]), "comment": r[3] or ""}
                    for r in res.result_rows]
        finally:
            client.close()
    if kind == "oracle":
        con = _oracle_connect(conn)
        try:
            cur = con.cursor()
            cur.execute(
                f"SELECT owner, table_name, num_rows FROM all_tables "
                f"WHERE owner NOT IN ({ORACLE_SYSTEM_SCHEMAS}) ORDER BY owner, table_name"
            )
            return [{"schema": r[0], "name": r[1], "rows": json_safe(r[2]), "comment": ""}
                    for r in cur.fetchall()]
        finally:
            con.close()
    raise RuntimeError(f"Unknown connection type: {kind}")


def list_columns(conn: dict, schema: str, table: str) -> list[dict]:
    kind = conn.get("kind")
    if kind == "demo":
        con = demo_connection()
        cur = con.execute(f'PRAGMA table_info("{table}")')
        return [{"name": r[1], "type": r[2] or "TEXT", "nullable": not r[3], "comment": ""}
                for r in cur.fetchall()]
    if kind == "clickhouse":
        client = _clickhouse_client(conn)
        try:
            res = client.query(
                "SELECT name, type, comment FROM system.columns "
                "WHERE database = %(db)s AND table = %(tb)s ORDER BY position",
                parameters={"db": schema, "tb": table},
            )
            return [{"name": r[0], "type": r[1], "nullable": "Nullable" in (r[1] or ""), "comment": r[2] or ""}
                    for r in res.result_rows]
        finally:
            client.close()
    if kind == "oracle":
        con = _oracle_connect(conn)
        try:
            cur = con.cursor()
            cur.execute(
                "SELECT c.column_name, c.data_type, c.nullable, m.comments "
                "FROM all_tab_columns c LEFT JOIN all_col_comments m "
                "ON m.owner = c.owner AND m.table_name = c.table_name AND m.column_name = c.column_name "
                "WHERE c.owner = :ow AND c.table_name = :tb ORDER BY c.column_id",
                ow=schema, tb=table,
            )
            return [{"name": r[0], "type": r[1], "nullable": r[2] == "Y", "comment": r[3] or ""}
                    for r in cur.fetchall()]
        finally:
            con.close()
    raise RuntimeError(f"Unknown connection type: {kind}")


def introspect(conn: dict, max_tables: int = 300) -> list[dict]:
    """Tables + columns in as few queries as possible (1 system query per database)."""
    kind = conn.get("kind")
    tables = list_tables(conn)[:max_tables]
    cols_map: dict[tuple, list] = {}

    if kind == "clickhouse":
        client = _clickhouse_client(conn)
        try:
            res = client.query(
                "SELECT database, table, name, type, comment FROM system.columns "
                "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
                "ORDER BY database, table, position"
            )
            for db_name, tb, col, ctype, comment in res.result_rows:
                cols_map.setdefault((db_name, tb), []).append(
                    {"name": col, "type": ctype, "nullable": "Nullable" in (ctype or ""),
                     "comment": comment or "", "description": "", "pii": False})
        finally:
            client.close()
    elif kind == "oracle":
        con = _oracle_connect(conn)
        try:
            cur = con.cursor()
            cur.execute(
                f"SELECT owner, table_name, column_name, data_type, nullable "
                f"FROM all_tab_columns WHERE owner NOT IN ({ORACLE_SYSTEM_SCHEMAS}) "
                f"ORDER BY owner, table_name, column_id"
            )
            for owner, tb, col, ctype, nullable in cur.fetchall():
                cols_map.setdefault((owner, tb), []).append(
                    {"name": col, "type": ctype, "nullable": nullable == "Y",
                     "comment": "", "description": "", "pii": False})
        finally:
            con.close()
    else:  # demo
        for table in tables:
            cols_map[(table["schema"], table["name"])] = [
                {**c, "description": "", "pii": False}
                for c in list_columns(conn, table["schema"], table["name"])]

    return [{**t, "description": "", "columns": cols_map.get((t["schema"], t["name"]), [])}
            for t in tables]


def preview(conn: dict, schema: str, table: str, limit: int = 50) -> dict:
    """Safe preview: the schema/table pair must exist in the introspection."""
    known = {(t["schema"], t["name"]) for t in list_tables(conn)}
    if (schema, table) not in known:
        raise RuntimeError(f"Unknown table: {schema}.{table}")
    kind = conn.get("kind")
    limit = max(1, min(int(limit), 200))
    if kind == "oracle":
        sql = f'SELECT * FROM "{schema}"."{table}" FETCH FIRST {limit} ROWS ONLY'
    elif kind == "clickhouse":
        sql = f'SELECT * FROM "{schema}"."{table}" LIMIT {limit}'
    else:
        sql = f'SELECT * FROM "{table}" LIMIT {limit}'
    return execute(conn, sql, {}, max_rows=limit, timeout_s=20)


def execute(conn: dict, sql: str, params: dict, max_rows: int = 500, timeout_s: int = 30) -> dict:
    """Execute a SELECT already validated by the guardrails. Returns JSON-safe columns + rows."""
    kind = conn.get("kind")
    used = guardrails.extract_params(sql)
    bind = {k: v for k, v in (params or {}).items() if k in used}
    missing = [p for p in used if p not in bind]
    if missing:
        raise RuntimeError("Missing parameters: " + ", ".join(missing))
    start = time.time()

    if kind == "demo":
        con = demo_connection()
        with _DEMO_LOCK:
            cur = con.execute(sql, bind)
            cols = [d[0] for d in cur.description or []]
            rows = cur.fetchmany(max_rows + 1)
    elif kind == "clickhouse":
        ch_sql = re.sub(r"(?<![:\w]):([A-Za-z_]\w*)", r"%(\1)s", sql)
        client = _clickhouse_client(conn)
        try:
            res = client.query(
                ch_sql, parameters=bind,
                settings={"max_execution_time": int(timeout_s),
                          "max_result_rows": int(max_rows) + 1,
                          "result_overflow_mode": "break"},
            )
            cols = list(res.column_names)
            rows = list(res.result_rows)
        finally:
            client.close()
    elif kind == "oracle":
        con = _oracle_connect(conn, timeout_s)
        try:
            cur = con.cursor()
            cur.execute(sql, bind)
            cols = [d[0] for d in cur.description or []]
            rows = cur.fetchmany(max_rows + 1)
        finally:
            con.close()
    else:
        raise RuntimeError(f"Unknown connection type: {kind}")

    truncated = len(rows) > max_rows
    rows = rows[:max_rows]
    return {
        "columns": cols,
        "rows": [[json_safe(v) for v in row] for row in rows],
        "row_count": len(rows),
        "elapsed_ms": round((time.time() - start) * 1000, 1),
        "truncated": truncated,
    }
