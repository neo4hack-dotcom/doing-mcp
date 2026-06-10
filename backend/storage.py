"""DOINg.MCP — local db.json persistence with lock + optimistic versioning."""
import copy
import json
import os
import threading
import time
import uuid

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DOING_MCP_DB", os.path.join(BASE_DIR, "db.json"))
LOCK = threading.RLock()
MASK = "••••••••"

AUDIT_CAP = 400
METRIC_CAP = 300


def default_db() -> dict:
    return {
        "version": 1,
        "settings": {
            "llm": {
                "base_url": "http://localhost:11434/v1",
                "api_key": "",
                "model": "",
                "temperature": 0.2,
                "max_tokens": 2048,
                "last_test": None,
            },
            "guardrails": {
                "read_only": True,
                "max_rows": 500,
                "timeout_s": 30,
                "auto_limit": True,
                "deny_keywords": [],
            },
        },
        "connections": [],
        "catalog": {},
        "queries": [],
        "tools": [],
        "projects": [],
        "audit": [],
        "metrics": {"query_runs": []},
    }


def _merge_defaults(db: dict) -> dict:
    base = default_db()
    for key, value in base.items():
        db.setdefault(key, value)
    for key, value in base["settings"].items():
        db["settings"].setdefault(key, value)
    for key, value in base["settings"]["llm"].items():
        db["settings"]["llm"].setdefault(key, value)
    for key, value in base["settings"]["guardrails"].items():
        db["settings"]["guardrails"].setdefault(key, value)
    db["metrics"].setdefault("query_runs", [])
    return db


def load() -> dict:
    with LOCK:
        if not os.path.exists(DB_PATH):
            db = default_db()
            save(db, bump=False)
            return db
        with open(DB_PATH, "r", encoding="utf-8") as fh:
            return _merge_defaults(json.load(fh))


def save(db: dict, bump: bool = True) -> dict:
    with LOCK:
        if bump:
            db["version"] = int(db.get("version", 0)) + 1
        tmp = DB_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(db, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, DB_PATH)
        return db


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def audit(db: dict, action: str, detail: str = "", level: str = "info") -> None:
    db["audit"].insert(0, {
        "id": new_id("aud"),
        "ts": now_iso(),
        "action": action,
        "detail": detail[:500],
        "level": level,
    })
    del db["audit"][AUDIT_CAP:]


def metric_query(db: dict, connection_id: str, ms: float, rows: int, ok: bool) -> None:
    db["metrics"]["query_runs"].append({
        "ts": now_iso(),
        "connection_id": connection_id,
        "ms": round(ms, 1),
        "rows": rows,
        "ok": ok,
    })
    runs = db["metrics"]["query_runs"]
    if len(runs) > METRIC_CAP:
        db["metrics"]["query_runs"] = runs[-METRIC_CAP:]


def public_state(db: dict) -> dict:
    """Copy of the state with every secret stripped (passwords, API key)."""
    out = copy.deepcopy(db)
    for conn in out.get("connections", []):
        conn["has_password"] = bool(conn.get("password"))
        conn.pop("password", None)
    llm = out["settings"]["llm"]
    llm["api_key_set"] = bool(llm.get("api_key"))
    llm["api_key"] = MASK if llm.get("api_key") else ""
    out.pop("version", None)
    return out


def find(items: list, item_id: str) -> dict | None:
    for item in items:
        if item.get("id") == item_id:
            return item
    return None
