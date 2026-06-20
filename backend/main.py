"""DOINg.MCP — FastAPI API (port 3001).

Conventions:
 - Every mutation requires the X-Base-Version header; conflict → HTTP 409 (optimistic concurrency).
 - Mutation responses return the full state { version, data, result } → the front-end
   stays in sync without refetching.
 - No secret ever leaves the API (passwords and API key are masked).
"""
import contextlib
import io
import os
import zipfile

from fastapi import Body, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse, JSONResponse, PlainTextResponse, StreamingResponse,
)
from fastapi.staticfiles import StaticFiles

# Production: the backend can serve the built SPA (frontend/dist). In dev the
# frontend runs on Vite (:3000) and proxies /api here, so dist is usually absent.
DIST_DIR = os.environ.get(
    "DOING_MCP_DIST",
    os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")),
)

import chat as chat_mod
import codegen
import connectors
import guardrails
import llm as llm_mod
import mcp_client
import rls
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


@app.exception_handler(mcp_client.McpClientError)
async def mcp_error_handler(_request, exc: mcp_client.McpClientError):
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


def resolve_workspace(db: dict, x_workspace: str | None) -> str:
    """Pick the workspace for a write: the requested one if it exists, else the first."""
    if x_workspace and storage.find(db["workspaces"], x_workspace):
        return x_workspace
    return db["workspaces"][0]["id"]


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


def run_validated(db: dict, conn: dict, sql: str, params: dict, cfg: dict,
                  policy: dict | None = None, identity_value=None) -> dict:
    """Validate then execute; never raises: {ok, error?, result?, validation, rls?}.

    When a row policy is active, the (read-only) base query is wrapped as a subquery
    and filtered on the projected columns for the captured caller identity.
    """
    dialect = connectors.dialect(conn["kind"])
    validation = guardrails.validate(sql, dialect, cfg)
    if not validation["ok"]:
        return {"ok": False, "error": " ".join(validation["errors"]), "validation": validation}

    effective_sql = validation["sql"]
    exec_params = dict(params or {})
    rls_summary = None
    if rls.is_active(policy):
        base = sql.rstrip().rstrip(";")
        wrapped, rls_params = rls.wrap_sql(base, dialect, policy, identity_value)
        effective_sql = (guardrails.apply_limit(wrapped, dialect, int(cfg.get("max_rows", 500)))
                         if cfg.get("auto_limit", True) else wrapped)
        exec_params.update(rls_params)
        rls_summary = rls.describe(policy, identity_value)

    try:
        result = connectors.execute(
            conn, effective_sql, exec_params,
            max_rows=int(cfg.get("max_rows", 500)), timeout_s=int(cfg.get("timeout_s", 30)),
        )
        storage.metric_query(db, conn["id"], result["elapsed_ms"], result["row_count"], True)
        return {"ok": True, "result": result, "validation": validation, "rls": rls_summary}
    except Exception as exc:  # noqa: BLE001 — driver error surfaced to the UI for the “fix with AI” flow
        storage.metric_query(db, conn["id"], 0, 0, False)
        msg = str(exc)[:600]
        if rls_summary is not None:
            msg = (f"{msg}\n(Row-level security is active — the policy columns must appear "
                   f"in the tool's SELECT output.)")
        return {"ok": False, "error": msg, "validation": validation, "rls": rls_summary}


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


@app.post("/api/llm/enhance-sql")
def llm_enhance_sql(payload: dict = Body(...)):
    """Make a query more versatile/efficient (optional filters, dialect features)."""
    db = storage.load()
    conn = get_conn_or_404(db, payload.get("connection_id", ""))
    dialect = connectors.dialect(conn["kind"])
    out = llm_mod.enhance_sql(db["settings"]["llm"], dialect, schema_context(db, conn["id"]),
                              payload.get("sql", ""), payload.get("goal", ""))
    out["validation"] = guardrails.validate(out["sql"], dialect, guard_cfg(db))
    return {"result": out}


@app.post("/api/sql/validate")
def validate_sql(payload: dict = Body(...)):
    db = storage.load()
    conn = get_conn_or_404(db, payload.get("connection_id", ""))
    return {"result": guardrails.validate(payload.get("sql", ""),
                                          connectors.dialect(conn["kind"]), guard_cfg(db))}


# ---------------------------------------------------------------- Workspaces

@app.post("/api/workspaces")
def create_workspace(payload: dict = Body(...),
                     x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        ws = {"id": storage.new_id("ws"), "name": payload.get("name") or "Workspace",
              "color": payload.get("color") or "indigo", "created_at": storage.now_iso()}
        db["workspaces"].append(ws)
        storage.audit(db, "workspace.create", ws["name"])
        return envelope(db, {"id": ws["id"]})


@app.put("/api/workspaces/{ws_id}")
def update_workspace(ws_id: str, payload: dict = Body(...),
                     x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        ws = storage.find(db["workspaces"], ws_id)
        if not ws:
            raise HTTPException(404, "Workspace not found.")
        for key in ("name", "color"):
            if key in payload:
                ws[key] = payload[key]
        storage.audit(db, "workspace.update", ws["name"])
        return envelope(db)


@app.delete("/api/workspaces/{ws_id}")
def delete_workspace(ws_id: str,
                     x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        ws = storage.find(db["workspaces"], ws_id)
        if not ws:
            raise HTTPException(404, "Workspace not found.")
        if len(db["workspaces"]) <= 1:
            raise HTTPException(400, "Cannot delete the last workspace.")
        for project in [p for p in db["projects"] if p.get("workspace_id") == ws_id]:
            runner.stop(project["id"])
        db["projects"] = [p for p in db["projects"] if p.get("workspace_id") != ws_id]
        db["tools"] = [t for t in db["tools"] if t.get("workspace_id") != ws_id]
        db["queries"] = [q for q in db["queries"] if q.get("workspace_id") != ws_id]
        db["folders"] = [f for f in db["folders"] if f.get("workspace_id") != ws_id]
        db["workspaces"] = [w for w in db["workspaces"] if w["id"] != ws_id]
        storage.audit(db, "workspace.delete", ws["name"], "warn")
        return envelope(db, {"deleted": ws_id})


# ---------------------------------------------------------------- Folders

@app.post("/api/folders")
def create_folder(payload: dict = Body(...),
                  x_base_version: str | None = Header(None, alias="X-Base-Version"),
                  x_workspace: str | None = Header(None, alias="X-Workspace")):
    with mutation(x_base_version) as db:
        folder = {"id": storage.new_id("fld"), "name": payload.get("name") or "Folder",
                  "color": payload.get("color") or "zinc",
                  "workspace_id": resolve_workspace(db, x_workspace),
                  "created_at": storage.now_iso()}
        db["folders"].append(folder)
        storage.audit(db, "folder.create", folder["name"])
        return envelope(db, {"id": folder["id"]})


@app.put("/api/folders/{folder_id}")
def update_folder(folder_id: str, payload: dict = Body(...),
                  x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        folder = storage.find(db["folders"], folder_id)
        if not folder:
            raise HTTPException(404, "Folder not found.")
        for key in ("name", "color"):
            if key in payload:
                folder[key] = payload[key]
        storage.audit(db, "folder.update", folder["name"])
        return envelope(db)


@app.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: str,
                  x_base_version: str | None = Header(None, alias="X-Base-Version")):
    with mutation(x_base_version) as db:
        folder = storage.find(db["folders"], folder_id)
        if not folder:
            raise HTTPException(404, "Folder not found.")
        for tool in db["tools"]:
            if tool.get("folder_id") == folder_id:
                tool["folder_id"] = None
        db["folders"] = [f for f in db["folders"] if f["id"] != folder_id]
        storage.audit(db, "folder.delete", folder["name"], "warn")
        return envelope(db)


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
        failed: list[str] = []
        last_error = ""

        def merge(chunk: list[dict], results: list) -> int:
            count = 0
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
                count += 1
            return count

        # Small chunks: large payloads are the main reason local models break JSON.
        chunk_size = 4
        for start in range(0, len(targets), chunk_size):
            chunk = targets[start:start + chunk_size]
            try:
                enriched_count += merge(chunk, llm_mod.enrich_catalog(db["settings"]["llm"], chunk))
            except llm_mod.LlmError:
                # Fallback: one table at a time, skipping only the ones that still fail.
                for table in chunk:
                    try:
                        enriched_count += merge([table],
                                                llm_mod.enrich_catalog(db["settings"]["llm"], [table]))
                    except llm_mod.LlmError as exc:
                        failed.append(f"{table['schema']}.{table['name']}")
                        last_error = str(exc)

        if enriched_count == 0 and failed:
            raise llm_mod.LlmError(
                f"No table could be documented ({len(failed)} attempts). Last error: {last_error[:300]}")
        catalog["enriched_at"] = storage.now_iso()
        storage.audit(db, "catalog.enrich",
                      f"{conn['name']}: {enriched_count} tables documented by the AI"
                      + (f" — {len(failed)} failed" if failed else ""))
        return envelope(db, {"enriched": enriched_count, "failed": failed})


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


@app.post("/api/connections/{conn_id}/browse")
def browse_table(conn_id: str, payload: dict = Body(...)):
    """Filtered/sorted table browsing for the data explorer (Metabase-style).

    Read-only: it does NOT mutate db.json (no version bump). The explorer reloads
    this on every keystroke/filter change, so keeping it side-effect free avoids a
    state-change → re-render → refetch loop and keeps the metrics chart clean.
    """
    db = storage.load()
    conn = get_conn_or_404(db, conn_id)
    try:
        result = connectors.browse(
            conn, payload.get("schema", ""), payload.get("table", ""),
            filters=payload.get("filters") or [],
            sort=payload.get("sort"), limit=int(payload.get("limit", 100)),
        )
        return {"result": {"ok": True, "result": result}}
    except Exception as exc:  # noqa: BLE001
        return {"result": {"ok": False, "error": str(exc)[:600]}}


@app.post("/api/connections/{conn_id}/profile")
def profile_table(conn_id: str, payload: dict = Body(...),
                  x_base_version: str | None = Header(None, alias="X-Base-Version")):
    """Column-level profiling: row count, nulls, distinct, min/max, top values."""
    with mutation(x_base_version) as db:
        conn = get_conn_or_404(db, conn_id)
        try:
            result = connectors.profile_table(conn, payload.get("schema", ""),
                                              payload.get("table", ""))
            storage.audit(db, "catalog.profile",
                          f"{conn['name']}: {payload.get('schema')}.{payload.get('table')} "
                          f"({result['row_count']} rows)")
            return envelope(db, {"ok": True, "profile": result})
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
                 x_base_version: str | None = Header(None, alias="X-Base-Version"),
                 x_workspace: str | None = Header(None, alias="X-Workspace")):
    with mutation(x_base_version) as db:
        get_conn_or_404(db, payload.get("connection_id", ""))
        query = {
            "id": storage.new_id("qry"),
            "name": payload.get("name") or "Untitled query",
            "description": payload.get("description", ""),
            "connection_id": payload["connection_id"],
            "sql": payload.get("sql", ""),
            "params": guardrails.extract_params(payload.get("sql", "")),
            "workspace_id": resolve_workspace(db, x_workspace),
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


def _scaffold_templates(conn: dict, table: dict) -> dict[str, dict]:
    """Deterministic starter tools for a table — no LLM required."""
    kind = conn["kind"]
    schema, name = table["schema"], table["name"]
    ref = f'"{name}"' if kind == "demo" else f'"{schema}"."{name}"'
    columns = table.get("columns", [])
    col_names = [c["name"] for c in columns]

    def first(predicate, fallback=None):
        for col in columns:
            if predicate(col):
                return col["name"]
        return fallback

    pk = ("id" if "id" in col_names
          else first(lambda c: c["name"].lower().endswith("_id"), col_names[0] if col_names else "id"))
    text_col = first(lambda c: any(t in (c.get("type") or "").upper()
                                   for t in ("CHAR", "TEXT", "STRING", "VARCHAR")))
    group_col = first(lambda c: c["name"] != pk and any(
        t in (c.get("type") or "").upper() for t in ("CHAR", "TEXT", "STRING", "VARCHAR")))

    base = codegen.py_ident(name)
    templates: dict[str, dict] = {
        "list": {
            "name": f"list_{base}",
            "description": f"List rows from {schema}.{name} (capped by the row limit).",
            "sql": f"SELECT * FROM {ref}",
            "params": [],
        },
        "get_by_id": {
            "name": f"get_{base}_by_{codegen.py_ident(pk)}",
            "description": f"Fetch rows from {schema}.{name} matching a {pk}.",
            "sql": f'SELECT * FROM {ref} WHERE "{pk}" = :{codegen.py_ident(pk)}',
            "params": [{"name": codegen.py_ident(pk), "type": "string",
                        "description": f"Value of {pk} to look up.", "required": True, "default": None}],
        },
    }
    if group_col:
        templates["count_by"] = {
            "name": f"count_{base}_by_{codegen.py_ident(group_col)}",
            "description": f"Count rows of {schema}.{name} grouped by {group_col}, most frequent first.",
            "sql": (f'SELECT "{group_col}", COUNT(*) AS row_count FROM {ref} '
                    f'GROUP BY "{group_col}" ORDER BY row_count DESC'),
            "params": [],
        }
    if text_col:
        templates["search"] = {
            "name": f"search_{base}",
            "description": f"Search {schema}.{name} where {text_col} matches a pattern (use % wildcards).",
            "sql": f'SELECT * FROM {ref} WHERE "{text_col}" LIKE :pattern',
            "params": [{"name": "pattern", "type": "string",
                        "description": f"LIKE pattern applied to {text_col}, e.g. %john%.",
                        "required": True, "default": None}],
        }
    return templates


@app.post("/api/tools/scaffold")
def scaffold_tools(payload: dict = Body(...),
                   x_base_version: str | None = Header(None, alias="X-Base-Version"),
                   x_workspace: str | None = Header(None, alias="X-Workspace")):
    """One-click starter tools (list / get_by_id / count_by / search) for a table."""
    with mutation(x_base_version) as db:
        conn = get_conn_or_404(db, payload.get("connection_id", ""))
        ws_id = resolve_workspace(db, x_workspace)
        folder_id = payload.get("folder_id")
        catalog = db["catalog"].get(conn["id"]) or {"tables": []}
        table = next((t for t in catalog["tables"]
                      if t["schema"] == payload.get("schema") and t["name"] == payload.get("table")), None)
        if not table:
            raise HTTPException(404, "Table not found in the catalog — introspect first.")
        templates = _scaffold_templates(conn, table)
        kinds = [k for k in (payload.get("kinds") or list(templates)) if k in templates]
        existing = {t["name"] for t in db["tools"]}
        created = []
        for kind_key in kinds:
            tpl = templates[kind_key]
            tool_name = tpl["name"]
            while tool_name in existing:
                tool_name += "_2"
            existing.add(tool_name)
            db["tools"].insert(0, {
                "id": storage.new_id("tool"), "name": tool_name,
                "description": tpl["description"], "connection_id": conn["id"],
                "query_id": None, "sql": tpl["sql"], "params": tpl["params"],
                "guardrails": normalize_guardrails(None, db["settings"]["guardrails"]),
                "row_policy": rls.default_policy(),
                "workspace_id": ws_id, "folder_id": folder_id,
                "tags": ["scaffold", table["name"]], "enabled": True,
                "security_review": None, "created_at": storage.now_iso(),
            })
            created.append(tool_name)
        storage.audit(db, "tool.scaffold",
                      f"{table['schema']}.{table['name']} → {', '.join(created) or 'nothing'}")
        return envelope(db, {"created": created})


@app.post("/api/tools/magic")
def magic_tool(payload: dict = Body(...),
               x_base_version: str | None = Header(None, alias="X-Base-Version"),
               x_workspace: str | None = Header(None, alias="X-Workspace")):
    """One-shot NL → tool: generate SQL, validate, dry-run, suggest the contract, create."""
    with mutation(x_base_version) as db:
        conn = get_conn_or_404(db, payload.get("connection_id", ""))
        request = (payload.get("request") or "").strip()
        if not request:
            raise HTTPException(400, "Describe the tool you want in plain language.")
        dialect = connectors.dialect(conn["kind"])
        gen = llm_mod.generate_sql(db["settings"]["llm"], dialect,
                                   schema_context(db, conn["id"]), request)
        sql = gen["sql"]
        validation = guardrails.validate(sql, dialect, guard_cfg(db))
        if not validation["ok"]:
            fixed = llm_mod.fix_sql(db["settings"]["llm"], dialect, schema_context(db, conn["id"]),
                                    sql, " ".join(validation["errors"]))
            sql = fixed["sql"]
            validation = guardrails.validate(sql, dialect, guard_cfg(db))
            if not validation["ok"]:
                raise HTTPException(400, "The generated SQL failed the guardrails twice: "
                                    + " ".join(validation["errors"]))
        test_outcome = None
        if not validation["params"]:
            test_outcome = run_validated(db, conn, sql, {}, guard_cfg(db))
        suggestion = llm_mod.suggest_tool(db["settings"]["llm"], dialect, sql, "", request)
        declared = {p["name"]: p for p in normalize_params(suggestion.get("params"))}
        params = [declared.get(name, {"name": name, "type": "string", "description": "",
                                      "required": True, "default": None})
                  for name in validation["params"]]
        tool_name = codegen.py_ident(suggestion.get("name") or "tool")
        existing = {t["name"] for t in db["tools"]}
        while tool_name in existing:
            tool_name += "_2"
        tool = {
            "id": storage.new_id("tool"), "name": tool_name,
            "description": suggestion.get("description") or request,
            "connection_id": conn["id"], "query_id": None, "sql": sql, "params": params,
            "guardrails": normalize_guardrails(None, db["settings"]["guardrails"]),
            "row_policy": rls.default_policy(),
            "workspace_id": resolve_workspace(db, x_workspace),
            "folder_id": payload.get("folder_id"),
            "tags": [str(t) for t in (suggestion.get("tags") or [])][:5],
            "enabled": True, "security_review": None, "created_at": storage.now_iso(),
        }
        db["tools"].insert(0, tool)
        storage.audit(db, "tool.magic", f"{tool_name} ← “{request[:120]}”")
        return envelope(db, {"id": tool["id"], "name": tool_name, "sql": sql,
                             "explanation": gen.get("explanation", ""),
                             "validation": validation, "test": test_outcome})


@app.post("/api/tools")
def create_tool(payload: dict = Body(...),
                x_base_version: str | None = Header(None, alias="X-Base-Version"),
                x_workspace: str | None = Header(None, alias="X-Workspace")):
    with mutation(x_base_version) as db:
        conn = get_conn_or_404(db, payload.get("connection_id", ""))
        sql = payload.get("sql", "")
        validation = guardrails.validate(sql, connectors.dialect(conn["kind"]), guard_cfg(db))
        if not validation["ok"]:
            raise HTTPException(400, "SQL rejected by the guardrails: " + " ".join(validation["errors"]))
        folder_id = payload.get("folder_id")
        if folder_id and not storage.find(db["folders"], folder_id):
            folder_id = None
        tool = {
            "id": storage.new_id("tool"),
            "name": codegen.py_ident(payload.get("name") or "tool"),
            "description": payload.get("description", ""),
            "connection_id": conn["id"],
            "query_id": payload.get("query_id"),
            "sql": sql,
            "params": normalize_params(payload.get("params")),
            "guardrails": normalize_guardrails(payload.get("guardrails"), db["settings"]["guardrails"]),
            "row_policy": rls.normalize(payload.get("row_policy")),
            "workspace_id": resolve_workspace(db, x_workspace),
            "folder_id": folder_id,
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
        if "folder_id" in payload:
            fid = payload["folder_id"]
            tool["folder_id"] = fid if (fid and storage.find(db["folders"], fid)) else None
        if "name" in payload:
            tool["name"] = codegen.py_ident(payload["name"])
        if "params" in payload:
            tool["params"] = normalize_params(payload["params"])
        if "guardrails" in payload:
            tool["guardrails"] = normalize_guardrails(payload["guardrails"], db["settings"]["guardrails"])
        if "row_policy" in payload:
            tool["row_policy"] = rls.normalize(payload["row_policy"])
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
        policy = tool.get("row_policy") or {}
        identity_value = None
        if rls.is_active(policy):
            identity_value = args.get(policy.get("identity_arg", "user_id"))
            if identity_value in (None, ""):
                return envelope(db, {"ok": False,
                                     "error": f"Row-level security is on: provide the caller identity "
                                              f"“{policy.get('identity_arg', 'user_id')}”."})
        coerced = {}
        for param in tool["params"]:
            value = args.get(param["name"], param.get("default"))
            if value is None or value == "":
                if param.get("required", True):
                    return envelope(db, {"ok": False,
                                         "error": f"Missing required parameter: {param['name']}"})
                # Optional + omitted → bind SQL NULL, enabling dynamic filters such as
                # WHERE (:param IS NULL OR column = :param).
                coerced[param["name"]] = None
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
        outcome = run_validated(db, conn, tool["sql"], coerced, cfg,
                                policy=policy, identity_value=identity_value)
        if outcome["ok"]:
            masked = {m.lower() for m in tool["guardrails"].get("masked_columns", [])}
            if masked:
                idx = [i for i, c in enumerate(outcome["result"]["columns"]) if c.lower() in masked]
                for row in outcome["result"]["rows"]:
                    for i in idx:
                        row[i] = "•••"
        rls_note = f" [RLS: {outcome['rls']}]" if outcome.get("rls") else ""
        storage.audit(db, "tool.test", f"{tool['name']} → {'OK' if outcome['ok'] else 'FAILED'}{rls_note}",
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
                   x_base_version: str | None = Header(None, alias="X-Base-Version"),
                   x_workspace: str | None = Header(None, alias="X-Workspace")):
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
            "workspace_id": resolve_workspace(db, x_workspace),
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


@app.post("/api/projects/{project_id}/preflight")
def preflight_project(project_id: str,
                      x_base_version: str | None = Header(None, alias="X-Base-Version")):
    """Pre-ship checklist: tools, guardrails, params, RLS coherence, connections."""
    with mutation(x_base_version) as db:
        project = storage.find(db["projects"], project_id)
        if not project:
            raise HTTPException(404, "Project not found.")
        items: list[dict] = []

        def add(level: str, label: str, detail: str = ""):
            items.append({"level": level, "label": label, "detail": detail})

        tools = [t for t in db["tools"] if t["id"] in project.get("tool_ids", [])]
        enabled = [t for t in tools if t.get("enabled", True)]
        if not enabled:
            add("fail", "At least one enabled tool", "The project has no enabled tool.")
        else:
            add("pass", "Enabled tools", f"{len(enabled)} tool(s) will be exposed.")

        conn_ids = {t["connection_id"] for t in enabled}
        for cid in conn_ids:
            conn = storage.find(db["connections"], cid)
            if not conn:
                add("fail", "Connection exists", f"A tool references a deleted connection ({cid}).")
                continue
            result = connectors.test(conn)
            conn["status"] = "ok" if result["ok"] else "error"
            conn["latency_ms"] = result["latency_ms"]
            conn["last_tested_at"] = storage.now_iso()
            add("pass" if result["ok"] else "fail", f"Connection “{conn['name']}”",
                result["message"])

        for tool in enabled:
            conn = storage.find(db["connections"], tool["connection_id"])
            dialect = connectors.dialect(conn["kind"]) if conn else "sqlite"
            validation = guardrails.validate(tool["sql"], dialect, guard_cfg(db, tool.get("guardrails")))
            if validation["ok"]:
                add("pass", f"Guardrails — {tool['name']}", "SQL accepted (read-only, safe keywords).")
            else:
                add("fail", f"Guardrails — {tool['name']}", " ".join(validation["errors"]))
            declared = {p["name"] for p in tool.get("params", [])}
            sql_params = set(validation["params"])
            if declared != sql_params:
                missing = sorted(sql_params - declared)
                extra = sorted(declared - sql_params)
                detail = (f"missing in contract: {', '.join(missing)}. " if missing else "") + \
                         (f"declared but unused: {', '.join(extra)}." if extra else "")
                add("warn", f"Parameters — {tool['name']}", detail.strip())
            policy = tool.get("row_policy") or {}
            if rls.is_active(policy):
                stripped = guardrails.strip_literals(tool["sql"]).lower()
                ghost = [r["column"] for r in policy["rules"]
                         if not (f'"{r["column"].lower()}"' in stripped
                                 or f" {r['column'].lower()}" in stripped
                                 or "select *" in stripped or "select\n*" in stripped)]
                if ghost:
                    add("warn", f"Row-level security — {tool['name']}",
                        f"Policy column(s) possibly absent from the SELECT output: {', '.join(sorted(set(ghost)))}.")
                else:
                    add("pass", f"Row-level security — {tool['name']}",
                        f"{len(policy['rules'])} rule(s), identity “{policy['identity_arg']}”, "
                        f"default {policy['default_visibility']}.")
            masked = (tool.get("guardrails") or {}).get("masked_columns", [])
            if masked:
                add("pass", f"PII masking — {tool['name']}", ", ".join(masked))

        if db["settings"]["llm"].get("last_test", {}) and db["settings"]["llm"]["last_test"] \
                and db["settings"]["llm"]["last_test"].get("ok"):
            add("pass", "Local LLM", "Tested OK (only needed for the integrated chat).")
        else:
            add("warn", "Local LLM", "Not tested — the generated server works without it, "
                                     "but the integrated chat needs it.")

        ok = not any(i["level"] == "fail" for i in items)
        storage.audit(db, "project.preflight",
                      f"{project['name']} → {'READY' if ok else 'BLOCKED'} "
                      f"({sum(1 for i in items if i['level'] == 'fail')} fail / "
                      f"{sum(1 for i in items if i['level'] == 'warn')} warn)")
        return envelope(db, {"ok": ok, "items": items})


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
                   x_base_version: str | None = Header(None, alias="X-Base-Version"),
                   x_workspace: str | None = Header(None, alias="X-Workspace")):
    with mutation(x_base_version) as db:
        bundle = payload.get("bundle") or payload
        src_project = bundle.get("project")
        if not isinstance(src_project, dict):
            raise HTTPException(400, "Invalid bundle: missing “project” field.")
        ws_id = resolve_workspace(db, x_workspace)
        target_conn = payload.get("connection_id") or (
            db["connections"][0]["id"] if db["connections"] else None)
        id_map = {}
        for src_tool in bundle.get("tools", []):
            new_tool = dict(src_tool)
            new_tool["id"] = storage.new_id("tool")
            new_tool["workspace_id"] = ws_id
            new_tool["folder_id"] = None
            if target_conn and not storage.find(db["connections"], new_tool.get("connection_id", "")):
                new_tool["connection_id"] = target_conn
            db["tools"].insert(0, new_tool)
            id_map[src_tool["id"]] = new_tool["id"]
        name = src_project.get("name", "Imported project") + " (import)"
        project = {**src_project, "id": storage.new_id("proj"), "name": name,
                   "slug": unique_slug(db, name), "workspace_id": ws_id,
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


@app.post("/api/projects/{project_id}/chat")
def project_chat(project_id: str, payload: dict = Body(...)):
    """Integrated chat: the local LLM calls this project's running MCP server.

    The server is auto-started locally (HTTP) if needed. Fully local — only the
    configured local LLM and the 127.0.0.1 MCP server are contacted.
    """
    db = storage.load()
    project = storage.find(db["projects"], project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    enabled = [t for t in db["tools"] if t["id"] in project["tool_ids"] and t.get("enabled", True)]
    if not enabled:
        raise HTTPException(400, "This project has no enabled tool — add one before chatting.")

    status = runner.status(project_id)
    started = False
    if not status.get("running"):
        files = codegen.generate_project_files(db, project)
        status = runner.start(db, project, files)
        started = True
        if not status.get("running"):
            raise HTTPException(400, "Could not start the MCP server — check the logs in the Projects tab.")

    url = status.get("url") or f"http://127.0.0.1:{project.get('port') or 8900}/mcp"
    messages = payload.get("messages") or []
    result = chat_mod.run_chat(db["settings"]["llm"], url, messages)
    result["server"] = {"running": True, "url": url, "port": status.get("port"), "auto_started": started}
    return {"result": result}


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


# ---------------------------------------------------------------- Static SPA
# Registered LAST so every /api/* route above keeps priority. Only mounted when
# a build exists, so the API still runs without a compiled frontend.

def _mount_frontend() -> None:
    if not os.path.isfile(os.path.join(DIST_DIR, "index.html")):
        return
    assets_dir = os.path.join(DIST_DIR, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/", include_in_schema=False)
    def _spa_root():
        return FileResponse(os.path.join(DIST_DIR, "index.html"))

    @app.get("/{full_path:path}", include_in_schema=False)
    def _spa_catch_all(full_path: str):
        # Never let the SPA fallback swallow unknown API calls.
        if full_path.startswith("api/"):
            raise HTTPException(404, "Not found.")
        candidate = os.path.normpath(os.path.join(DIST_DIR, full_path))
        # Stay inside DIST_DIR (defense against path traversal), then fall back
        # to index.html for client-side paths.
        if candidate.startswith(DIST_DIR) and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(DIST_DIR, "index.html"))


_mount_frontend()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=3001)
