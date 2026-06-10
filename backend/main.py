"""DOINg.MCP — FastAPI API (port 3001).

Conventions:
 - Every mutation requires the X-Base-Version header; conflict → HTTP 409 (optimistic concurrency).
 - Mutation responses return the full state { version, data, result } → the front-end
   stays in sync without refetching.
 - No secret ever leaves the API (passwords and API key are masked).
"""
import contextlib
import io
import zipfile

from fastapi import Body, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

import codegen
import connectors
import guardrails
import llm as llm_mod
import runner
import storage

app = FastAPI(title="DOINg.MCP", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)


@app.exception_handler(llm_mod.LlmError)
async def llm_error_handler(_request, exc: llm_mod.LlmError):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(RuntimeError)
async def runtime_error_handler(_request, exc: RuntimeError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


def envelope(db: dict, result=None) -> dict:
    return {"version": db["version"], "data": storage.public_state(db), "result": result}


def check_version(db: dict, x_base_version: str | None) -> None:
    if x_base_version is None:
        return
    try:
        expected = int(x_base_version)
    except ValueError as exc:
        raise HTTPException(400, "Invalid X-Base-Version header.") from exc
    if expected != db["version"]:
        raise HTTPException(409, detail={
            "message": "Version conflict: the state was modified by another session.",
            "current_version": db["version"],
        })


@contextlib.contextmanager
def mutation(x_base_version: str | None):
    """The version number is incremented BEFORE the yield so responses (envelope)
    carry the actually persisted version; if the body raises, nothing is saved."""
    with storage.LOCK:
        db = storage.load()
        check_version(db, x_base_version)
        db["version"] = int(db.get("version", 0)) + 1
        yield db
        storage.save(db, bump=False)


def get_conn_or_404(db: dict, conn_id: str) -> dict:
    conn = storage.find(db["connections"], conn_id)
    if not conn:
        raise HTTPException(404, "Connection not found.")
    return conn


def schema_context(db: dict, conn_id: str, max_tables: int = 30) -> str:
    catalog = db["catalog"].get(conn_id) or {"tables": []}
    lines = []
    for table in catalog["tables"][:max_tables]:
        cols = ", ".join(f"{c['name']} {c.get('type', '')}".strip() for c in table.get("columns", [])[:40])
        desc = table.get("description") or table.get("comment") or ""
        suffix = f"  -- {desc}" if desc else ""
        lines.append(f"{table['schema']}.{table['name']}({cols}){suffix}")
    return "\n".join(lines) or "(empty catalog — run the schema introspection first)"


def guard_cfg(db: dict, overrides: dict | None = None) -> dict:
    cfg = dict(db["settings"]["guardrails"])
    if overrides:
        cfg.update({k: v for k, v in overrides.items() if v is not None})
    return cfg


def run_validated(db: dict, conn: dict, sql: str, params: dict, cfg: dict) -> dict:
    """Validate then execute; never raises: {ok, error?, result?, validation}."""
    dialect = connectors.dialect(conn["kind"])
    validation = guardrails.validate(sql, dialect, cfg)
    if not validation["ok"]:
        return {"ok": False, "error": " ".join(validation["errors"]), "validation": validation}
    try:
        result = connectors.execute(
            conn, validation["sql"], params,
            max_rows=int(cfg.get("max_rows", 500)), timeout_s=int(cfg.get("timeout_s", 30)),
        )
        storage.metric_query(db, conn["id"], result["elapsed_ms"], result["row_count"], True)
        return {"ok": True, "result": result, "validation": validation}
    except Exception as exc:  # noqa: BLE001 — driver error surfaced to the UI for the “fix with AI” flow
        storage.metric_query(db, conn["id"], 0, 0, False)
        return {"ok": False, "error": str(exc)[:600], "validation": validation}


# ---------------------------------------------------------------- State & health

@app.get("/api/health")
def health():
    db = storage.load()
    return {"ok": True, "app": "DOINg.MCP", "db_version": db["version"], "time": storage.now_iso()}


@app.get("/api/state")
def get_state():
    db = storage.load()
    return envelope(db)


# ---------------------------------------------------------------- Settings

@app.put("/api/settings/llm")
def put_llm_settings(payload: dict = Body(...),
                     x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        cfg = db["settings"]["llm"]
        for key in ("base_url", "model", "temperature", "max_tokens"):
            if key in payload:
                cfg[key] = payload[key]
        if "api_key" in payload and payload["api_key"] != storage.MASK:
            cfg["api_key"] = payload["api_key"]
        storage.audit(db, "settings.llm", f"LLM → {cfg.get('base_url')} / {cfg.get('model') or '(default)'}")
        return envelope(db)


@app.put("/api/settings/guardrails")
def put_guardrail_settings(payload: dict = Body(...),
                           x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        cfg = db["settings"]["guardrails"]
        for key in ("read_only", "max_rows", "timeout_s", "auto_limit", "deny_keywords"):
            if key in payload:
                cfg[key] = payload[key]
        storage.audit(db, "settings.guardrails", f"max_rows={cfg['max_rows']} timeout={cfg['timeout_s']}s")
        return envelope(db)


# ---------------------------------------------------------------- LLM

@app.post("/api/llm/test")
def llm_test(x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        result = llm_mod.test(db["settings"]["llm"])
        db["settings"]["llm"]["last_test"] = {**result, "ts": storage.now_iso()}
        storage.audit(db, "llm.test", result["message"], "info" if result["ok"] else "error")
        return envelope(db, result)


@app.get("/api/llm/models")
def llm_models():
    db = storage.load()
    return {"models": llm_mod.list_models(db["settings"]["llm"])}


@app.post("/api/llm/generate-sql")
def llm_generate_sql(payload: dict = Body(...)):
    db = storage.load()
    conn = get_conn_or_404(db, payload.get("connection_id", ""))
    dialect = connectors.dialect(conn["kind"])
    out = llm_mod.generate_sql(db["settings"]["llm"], dialect,
                               schema_context(db, conn["id"]), payload.get("request", ""))
    out["validation"] = guardrails.validate(out["sql"], dialect, guard_cfg(db))
    return {"result": out}


@app.post("/api/llm/fix-sql")
def llm_fix_sql(payload: dict = Body(...)):
    db = storage.load()
    conn = get_conn_or_404(db, payload.get("connection_id", ""))
    dialect = connectors.dialect(conn["kind"])
    out = llm_mod.fix_sql(db["settings"]["llm"], dialect, schema_context(db, conn["id"]),
                          payload.get("sql", ""), payload.get("error", ""))
    out["validation"] = guardrails.validate(out["sql"], dialect, guard_cfg(db))
    return {"result": out}


@app.post("/api/llm/explain-sql")
def llm_explain_sql(payload: dict = Body(...)):
    db = storage.load()
    dialect = payload.get("dialect", "sql")
    return {"result": {"explanation": llm_mod.explain_sql(db["settings"]["llm"], dialect,
                                                          payload.get("sql", ""))}}


@app.post("/api/llm/suggest-tool")
def llm_suggest_tool(payload: dict = Body(...)):
    db = storage.load()
    conn = get_conn_or_404(db, payload.get("connection_id", ""))
    out = llm_mod.suggest_tool(db["settings"]["llm"], connectors.dialect(conn["kind"]),
                               payload.get("sql", ""), payload.get("sample", ""),
                               payload.get("hint", ""))
    return {"result": out}


@app.post("/api/llm/review-sql")
def llm_review_sql(payload: dict = Body(...)):
    db = storage.load()
    out = llm_mod.review_sql(db["settings"]["llm"], payload.get("dialect", "sql"),
                             payload.get("sql", ""))
    return {"result": out}


@app.post("/api/sql/validate")
def validate_sql(payload: dict = Body(...)):
    db = storage.load()
    conn = get_conn_or_404(db, payload.get("connection_id", ""))
    return {"result": guardrails.validate(payload.get("sql", ""),
                                          connectors.dialect(conn["kind"]), guard_cfg(db))}


# ---------------------------------------------------------------- Connections

@app.post("/api/connections")
def create_connection(payload: dict = Body(...),
                      x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        conn = {
            "id": storage.new_id("conn"),
            "name": payload.get("name") or "Connection",
            "kind": payload.get("kind") or "demo",
            "host": payload.get("host", ""),
            "port": payload.get("port", 0),
            "database": payload.get("database", ""),
            "service_name": payload.get("service_name", ""),
            "username": payload.get("username", ""),
            "password": payload.get("password", ""),
            "secure": bool(payload.get("secure")),
            "status": "unknown", "latency_ms": None, "last_tested_at": None, "last_error": "",
            "created_at": storage.now_iso(),
        }
        db["connections"].append(conn)
        storage.audit(db, "connection.create", f"{conn['name']} ({conn['kind']})")
        return envelope(db, {"id": conn["id"]})


@app.put("/api/connections/{conn_id}")
def update_connection(conn_id: str, payload: dict = Body(...),
                      x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        conn = get_conn_or_404(db, conn_id)
        for key in ("name", "kind", "host", "port", "database", "service_name", "username", "secure"):
            if key in payload:
                conn[key] = payload[key]
        if payload.get("password"):
            conn["password"] = payload["password"]
        conn["status"] = "unknown"
        storage.audit(db, "connection.update", conn["name"])
        return envelope(db)


@app.delete("/api/connections/{conn_id}")
def delete_connection(conn_id: str,
                      x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        conn = get_conn_or_404(db, conn_id)
        db["connections"] = [c for c in db["connections"] if c["id"] != conn_id]
        db["catalog"].pop(conn_id, None)
        storage.audit(db, "connection.delete", conn["name"], "warn")
        return envelope(db)


@app.post("/api/connections/{conn_id}/test")
def test_connection(conn_id: str,
                    x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        conn = get_conn_or_404(db, conn_id)
        result = connectors.test(conn)
        conn["status"] = "ok" if result["ok"] else "error"
        conn["latency_ms"] = result["latency_ms"]
        conn["last_tested_at"] = storage.now_iso()
        conn["last_error"] = "" if result["ok"] else result["message"]
        storage.audit(db, "connection.test",
                      f"{conn['name']} → {result['message']}", "info" if result["ok"] else "error")
        return envelope(db, result)


@app.post("/api/connections/{conn_id}/introspect")
def introspect_connection(conn_id: str,
                          x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        conn = get_conn_or_404(db, conn_id)
        tables = connectors.introspect(conn)
        previous = {(t["schema"], t["name"]): t
                    for t in (db["catalog"].get(conn_id) or {}).get("tables", [])}
        for table in tables:  # preserve existing AI enrichment
            old = previous.get((table["schema"], table["name"]))
            if old:
                table["description"] = old.get("description", "")
                old_cols = {c["name"]: c for c in old.get("columns", [])}
                for col in table["columns"]:
                    prev_col = old_cols.get(col["name"])
                    if prev_col:
                        col["description"] = prev_col.get("description", "")
                        col["pii"] = prev_col.get("pii", False)
        db["catalog"][conn_id] = {"tables": tables, "generated_at": storage.now_iso(),
                                  "enriched_at": (db["catalog"].get(conn_id) or {}).get("enriched_at")}
        conn["status"] = "ok"
        storage.audit(db, "catalog.introspect", f"{conn['name']}: {len(tables)} tables")
        return envelope(db, {"tables": len(tables)})


@app.post("/api/connections/{conn_id}/enrich")
def enrich_catalog(conn_id: str, payload: dict = Body(default={}),
                   x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        conn = get_conn_or_404(db, conn_id)
        catalog = db["catalog"].get(conn_id)
        if not catalog or not catalog["tables"]:
            raise HTTPException(400, "Empty catalog — run the introspection first.")
        keys = set(payload.get("table_keys") or [])
        targets = [t for t in catalog["tables"]
                   if not keys or f"{t['schema']}.{t['name']}" in keys][:36]
        enriched_count = 0
        for start in range(0, len(targets), 12):
            chunk = targets[start:start + 12]
            results = llm_mod.enrich_catalog(db["settings"]["llm"], chunk)
            by_key = {(r.get("schema"), r.get("name")): r for r in results if isinstance(r, dict)}
            for table in chunk:
                hit = by_key.get((table["schema"], table["name"]))
                if not hit:
                    continue
                table["description"] = hit.get("description", table.get("description", ""))
                col_hits = {c.get("name"): c for c in hit.get("columns", []) if isinstance(c, dict)}
                for col in table["columns"]:
                    info = col_hits.get(col["name"])
                    if info:
                        col["description"] = info.get("description", col.get("description", ""))
                        col["pii"] = bool(info.get("pii"))
                enriched_count += 1
        catalog["enriched_at"] = storage.now_iso()
        storage.audit(db, "catalog.enrich", f"{conn['name']}: {enriched_count} tables documented by the AI")
        return envelope(db, {"enriched": enriched_count})


@app.post("/api/connections/{conn_id}/preview")
def preview_table(conn_id: str, payload: dict = Body(...),
                  x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        conn = get_conn_or_404(db, conn_id)
        try:
            result = connectors.preview(conn, payload.get("schema", ""), payload.get("table", ""),
                                        int(payload.get("limit", 50)))
            storage.metric_query(db, conn_id, result["elapsed_ms"], result["row_count"], True)
            return envelope(db, {"ok": True, "result": result})
        except Exception as exc:  # noqa: BLE001
            return envelope(db, {"ok": False, "error": str(exc)[:600]})


@app.post("/api/connections/{conn_id}/run-sql")
def run_sql(conn_id: str, payload: dict = Body(...),
            x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        conn = get_conn_or_404(db, conn_id)
        outcome = run_validated(db, conn, payload.get("sql", ""),
                                payload.get("params") or {}, guard_cfg(db))
        storage.audit(db, "sql.run",
                      f"{conn['name']}: {'OK ' + str(outcome['result']['row_count']) + ' rows' if outcome['ok'] else 'FAILED ' + outcome.get('error', '')[:120]}",
                      "info" if outcome["ok"] else "error")
        return envelope(db, outcome)


# ---------------------------------------------------------------- Saved queries

@app.post("/api/queries")
def create_query(payload: dict = Body(...),
                 x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        get_conn_or_404(db, payload.get("connection_id", ""))
        query = {
            "id": storage.new_id("qry"),
            "name": payload.get("name") or "Untitled query",
            "description": payload.get("description", ""),
            "connection_id": payload["connection_id"],
            "sql": payload.get("sql", ""),
            "params": guardrails.extract_params(payload.get("sql", "")),
            "created_at": storage.now_iso(), "last_run": None, "sample": None,
        }
        db["queries"].insert(0, query)
        storage.audit(db, "query.create", query["name"])
        return envelope(db, {"id": query["id"]})


@app.put("/api/queries/{query_id}")
def update_query(query_id: str, payload: dict = Body(...),
                 x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        query = storage.find(db["queries"], query_id)
        if not query:
            raise HTTPException(404, "Query not found.")
        for key in ("name", "description", "sql", "connection_id"):
            if key in payload:
                query[key] = payload[key]
        query["params"] = guardrails.extract_params(query["sql"])
        storage.audit(db, "query.update", query["name"])
        return envelope(db)


@app.delete("/api/queries/{query_id}")
def delete_query(query_id: str,
                 x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        query = storage.find(db["queries"], query_id)
        if not query:
            raise HTTPException(404, "Query not found.")
        db["queries"] = [q for q in db["queries"] if q["id"] != query_id]
        storage.audit(db, "query.delete", query["name"], "warn")
        return envelope(db)


@app.post("/api/queries/{query_id}/run")
def run_saved_query(query_id: str, payload: dict = Body(default={}),
                    x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        query = storage.find(db["queries"], query_id)
        if not query:
            raise HTTPException(404, "Query not found.")
        conn = get_conn_or_404(db, query["connection_id"])
        outcome = run_validated(db, conn, query["sql"], payload.get("params") or {}, guard_cfg(db))
        query["last_run"] = {"ts": storage.now_iso(), "ok": outcome["ok"],
                             "ms": outcome["result"]["elapsed_ms"] if outcome["ok"] else 0,
                             "rows": outcome["result"]["row_count"] if outcome["ok"] else 0}
        if outcome["ok"]:
            sample = dict(outcome["result"])
            sample["rows"] = sample["rows"][:5]
            query["sample"] = sample
        return envelope(db, outcome)


# ---------------------------------------------------------------- MCP tools

def normalize_params(params: list) -> list[dict]:
    out = []
    for p in params or []:
        if not isinstance(p, dict) or not p.get("name"):
            continue
        out.append({
            "name": str(p["name"]),
            "type": p.get("type") if p.get("type") in codegen.TYPE_MAP else "string",
            "description": str(p.get("description") or ""),
            "required": bool(p.get("required", True)),
            "default": p.get("default"),
        })
    return out


def normalize_guardrails(gr: dict | None, defaults: dict) -> dict:
    gr = gr or {}
    return {
        "max_rows": int(gr.get("max_rows") or defaults.get("max_rows", 500)),
        "timeout_s": int(gr.get("timeout_s") or defaults.get("timeout_s", 30)),
        "rate_per_min": int(gr.get("rate_per_min") or 120),
        "masked_columns": [str(c) for c in (gr.get("masked_columns") or [])],
    }


@app.post("/api/tools")
def create_tool(payload: dict = Body(...),
                x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        conn = get_conn_or_404(db, payload.get("connection_id", ""))
        sql = payload.get("sql", "")
        validation = guardrails.validate(sql, connectors.dialect(conn["kind"]), guard_cfg(db))
        if not validation["ok"]:
            raise HTTPException(400, "SQL rejected by the guardrails: " + " ".join(validation["errors"]))
        tool = {
            "id": storage.new_id("tool"),
            "name": codegen.py_ident(payload.get("name") or "tool"),
            "description": payload.get("description", ""),
            "connection_id": conn["id"],
            "query_id": payload.get("query_id"),
            "sql": sql,
            "params": normalize_params(payload.get("params")),
            "guardrails": normalize_guardrails(payload.get("guardrails"), db["settings"]["guardrails"]),
            "tags": [str(t) for t in (payload.get("tags") or [])],
            "enabled": True,
            "security_review": payload.get("security_review"),
            "created_at": storage.now_iso(),
        }
        sql_params = set(guardrails.extract_params(sql))
        declared = {p["name"] for p in tool["params"]}
        for missing in sorted(sql_params - declared):
            tool["params"].append({"name": missing, "type": "string",
                                   "description": "", "required": True, "default": None})
        tool["params"] = [p for p in tool["params"] if p["name"] in sql_params]
        db["tools"].insert(0, tool)
        storage.audit(db, "tool.create", tool["name"])
        return envelope(db, {"id": tool["id"]})


@app.put("/api/tools/{tool_id}")
def update_tool(tool_id: str, payload: dict = Body(...),
                x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        tool = storage.find(db["tools"], tool_id)
        if not tool:
            raise HTTPException(404, "Tool not found.")
        if "sql" in payload:
            conn = get_conn_or_404(db, payload.get("connection_id") or tool["connection_id"])
            validation = guardrails.validate(payload["sql"], connectors.dialect(conn["kind"]),
                                             guard_cfg(db))
            if not validation["ok"]:
                raise HTTPException(400, "SQL rejected by the guardrails: " + " ".join(validation["errors"]))
            tool["sql"] = payload["sql"]
        for key in ("description", "connection_id", "tags", "enabled", "security_review"):
            if key in payload:
                tool[key] = payload[key]
        if "name" in payload:
            tool["name"] = codegen.py_ident(payload["name"])
        if "params" in payload:
            tool["params"] = normalize_params(payload["params"])
        if "guardrails" in payload:
            tool["guardrails"] = normalize_guardrails(payload["guardrails"], db["settings"]["guardrails"])
        storage.audit(db, "tool.update", tool["name"])
        return envelope(db)


@app.delete("/api/tools/{tool_id}")
def delete_tool(tool_id: str,
                x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        tool = storage.find(db["tools"], tool_id)
        if not tool:
            raise HTTPException(404, "Tool not found.")
        db["tools"] = [t for t in db["tools"] if t["id"] != tool_id]
        for project in db["projects"]:
            project["tool_ids"] = [tid for tid in project["tool_ids"] if tid != tool_id]
        storage.audit(db, "tool.delete", tool["name"], "warn")
        return envelope(db)


@app.post("/api/tools/{tool_id}/test")
def test_tool(tool_id: str, payload: dict = Body(default={}),
              x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        tool = storage.find(db["tools"], tool_id)
        if not tool:
            raise HTTPException(404, "Tool not found.")
        conn = get_conn_or_404(db, tool["connection_id"])
        args = payload.get("args") or {}
        coerced = {}
        for param in tool["params"]:
            value = args.get(param["name"], param.get("default"))
            if value is None or value == "":
                if param.get("required", True):
                    return envelope(db, {"ok": False,
                                         "error": f"Missing required parameter: {param['name']}"})
                continue
            try:
                if param["type"] == "integer":
                    value = int(value)
                elif param["type"] == "number":
                    value = float(value)
                elif param["type"] == "boolean":
                    value = str(value).lower() in ("true", "1", "yes")
                else:
                    value = str(value)
            except (TypeError, ValueError):
                return envelope(db, {"ok": False,
                                     "error": f"Invalid value for {param['name']} ({param['type']})."})
            coerced[param["name"]] = value
        cfg = guard_cfg(db, tool.get("guardrails"))
        outcome = run_validated(db, conn, tool["sql"], coerced, cfg)
        if outcome["ok"]:
            masked = {m.lower() for m in tool["guardrails"].get("masked_columns", [])}
            if masked:
                idx = [i for i, c in enumerate(outcome["result"]["columns"]) if c.lower() in masked]
                for row in outcome["result"]["rows"]:
                    for i in idx:
                        row[i] = "•••"
        storage.audit(db, "tool.test", f"{tool['name']} → {'OK' if outcome['ok'] else 'FAILED'}",
                      "info" if outcome["ok"] else "error")
        return envelope(db, outcome)


# ---------------------------------------------------------------- MCP projects

def unique_slug(db: dict, name: str, exclude_id: str | None = None) -> str:
    base = codegen.slugify(name)
    slug, i = base, 2
    existing = {p["slug"] for p in db["projects"] if p["id"] != exclude_id}
    while slug in existing:
        slug = f"{base}-{i}"
        i += 1
    return slug


@app.post("/api/projects")
def create_project(payload: dict = Body(...),
                   x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        name = payload.get("name") or "My MCP server"
        project = {
            "id": storage.new_id("proj"),
            "name": name,
            "slug": unique_slug(db, name),
            "description": payload.get("description", ""),
            "tool_ids": [tid for tid in (payload.get("tool_ids") or [])
                         if storage.find(db["tools"], tid)],
            "transport": payload.get("transport") if payload.get("transport") in ("stdio", "http") else "stdio",
            "port": int(payload.get("port") or 8900),
            "version": "1.0.0",
            "created_at": storage.now_iso(), "updated_at": storage.now_iso(),
            "generated_at": None,
        }
        db["projects"].insert(0, project)
        storage.audit(db, "project.create", project["name"])
        return envelope(db, {"id": project["id"]})


@app.put("/api/projects/{project_id}")
def update_project(project_id: str, payload: dict = Body(...),
                   x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        project = storage.find(db["projects"], project_id)
        if not project:
            raise HTTPException(404, "Project not found.")
        if "name" in payload:
            project["name"] = payload["name"]
            project["slug"] = unique_slug(db, payload["name"], project_id)
        for key in ("description", "transport", "port", "version"):
            if key in payload:
                project[key] = payload[key]
        if "tool_ids" in payload:
            project["tool_ids"] = [tid for tid in payload["tool_ids"]
                                   if storage.find(db["tools"], tid)]
        project["updated_at"] = storage.now_iso()
        storage.audit(db, "project.update", project["name"])
        return envelope(db)


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str,
                   x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        project = storage.find(db["projects"], project_id)
        if not project:
            raise HTTPException(404, "Project not found.")
        runner.stop(project_id)
        db["projects"] = [p for p in db["projects"] if p["id"] != project_id]
        storage.audit(db, "project.delete", project["name"], "warn")
        return envelope(db)


@app.post("/api/projects/{project_id}/generate")
def generate_project(project_id: str,
                     x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        project = storage.find(db["projects"], project_id)
        if not project:
            raise HTTPException(404, "Project not found.")
        files = codegen.generate_project_files(db, project)
        project["generated_at"] = storage.now_iso()
        storage.audit(db, "project.generate",
                      f"{project['name']}: {len(files)} files, {len(project['tool_ids'])} tools")
        return envelope(db, {"files": files})


@app.get("/api/projects/{project_id}/export")
def export_project(project_id: str):
    db = storage.load()
    project = storage.find(db["projects"], project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    files = codegen.generate_project_files(db, project)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in files.items():
            zf.writestr(f"{project['slug']}/{name}", content)
    buffer.seek(0)
    return StreamingResponse(buffer, media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="{project["slug"]}.zip"'})


@app.get("/api/projects/{project_id}/bundle")
def bundle_project(project_id: str):
    db = storage.load()
    project = storage.find(db["projects"], project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    tools = [t for t in db["tools"] if t["id"] in project["tool_ids"]]
    return {"doing_mcp_bundle": 1, "project": project, "tools": tools}


@app.post("/api/projects/import")
def import_project(payload: dict = Body(...),
                   x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        bundle = payload.get("bundle") or payload
        src_project = bundle.get("project")
        if not isinstance(src_project, dict):
            raise HTTPException(400, "Invalid bundle: missing “project” field.")
        target_conn = payload.get("connection_id") or (
            db["connections"][0]["id"] if db["connections"] else None)
        id_map = {}
        for src_tool in bundle.get("tools", []):
            new_tool = dict(src_tool)
            new_tool["id"] = storage.new_id("tool")
            if target_conn and not storage.find(db["connections"], new_tool.get("connection_id", "")):
                new_tool["connection_id"] = target_conn
            db["tools"].insert(0, new_tool)
            id_map[src_tool["id"]] = new_tool["id"]
        name = src_project.get("name", "Imported project") + " (import)"
        project = {**src_project, "id": storage.new_id("proj"), "name": name,
                   "slug": unique_slug(db, name),
                   "tool_ids": [id_map.get(tid) for tid in src_project.get("tool_ids", [])
                                if id_map.get(tid)],
                   "created_at": storage.now_iso(), "updated_at": storage.now_iso(),
                   "generated_at": None}
        db["projects"].insert(0, project)
        storage.audit(db, "project.import", project["name"])
        return envelope(db, {"id": project["id"]})


@app.post("/api/projects/{project_id}/run")
def run_project(project_id: str,
                x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        project = storage.find(db["projects"], project_id)
        if not project:
            raise HTTPException(404, "Project not found.")
        files = codegen.generate_project_files(db, project)
        status = runner.start(db, project, files)
        project["generated_at"] = storage.now_iso()
        storage.audit(db, "project.run",
                      f"{project['name']} started (HTTP port {status.get('port')})")
        return envelope(db, status)


@app.post("/api/projects/{project_id}/stop")
def stop_project(project_id: str,
                 x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        project = storage.find(db["projects"], project_id)
        if not project:
            raise HTTPException(404, "Project not found.")
        result = runner.stop(project_id)
        storage.audit(db, "project.stop", project["name"])
        return envelope(db, result)


@app.get("/api/projects/{project_id}/status")
def project_status(project_id: str):
    return {"result": runner.status(project_id)}


@app.get("/api/projects/{project_id}/logs", response_class=PlainTextResponse)
def project_logs(project_id: str, tail: int = 200):
    return runner.logs(project_id, tail)


# ---------------------------------------------------------------- Audit

@app.delete("/api/audit")
def clear_audit(x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        db["audit"] = []
        storage.audit(db, "audit.clear", "Log cleared", "warn")
        return envelope(db)


@app.on_event("shutdown")
def shutdown():
    runner.stop_all()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=3001)
