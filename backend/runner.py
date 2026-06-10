"""DOINg.MCP — local execution of generated MCP servers (start / stop / status / logs)."""
import os
import signal
import subprocess
import sys
import threading
import time

import codegen
import storage

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GEN_DIR = os.path.join(BASE_DIR, "generated")
_PROCS: dict[str, dict] = {}
_LOCK = threading.Lock()


def write_files(slug: str, files: dict[str, str]) -> str:
    target = os.path.join(GEN_DIR, slug)
    os.makedirs(target, exist_ok=True)
    for name, content in files.items():
        with open(os.path.join(target, name), "w", encoding="utf-8") as fh:
            fh.write(content)
    return target


def build_env(db: dict, project: dict) -> dict:
    env = os.environ.copy()
    env["MCP_TRANSPORT"] = "http"
    env["MCP_PORT"] = str(project.get("port") or 8900)
    tool_ids = set(project.get("tool_ids", []))
    conn_ids = {t["connection_id"] for t in db["tools"] if t["id"] in tool_ids}
    for cid in conn_ids:
        conn = storage.find(db["connections"], cid)
        if not conn or conn["kind"] == "demo":
            continue
        prefix = codegen.conn_env_prefix(conn)
        env[prefix + "_HOST"] = str(conn.get("host") or "")
        env[prefix + "_PORT"] = str(conn.get("port") or "")
        env[prefix + "_USER"] = str(conn.get("username") or "")
        env[prefix + "_PASSWORD"] = str(conn.get("password") or "")
        env[prefix + "_DATABASE"] = str(conn.get("database") or "")
        env[prefix + "_SERVICE"] = str(conn.get("service_name") or "")
    return env


def start(db: dict, project: dict, files: dict[str, str]) -> dict:
    with _LOCK:
        info = _PROCS.get(project["id"])
        if info and info["proc"].poll() is None:
            raise RuntimeError("This server is already running — stop it first.")
        target = write_files(project["slug"], files)
        log_path = os.path.join(target, "server.log")
        log_fh = open(log_path, "w", encoding="utf-8")
        proc = subprocess.Popen(
            [sys.executable, "server.py"],
            cwd=target, env=build_env(db, project),
            stdout=log_fh, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        _PROCS[project["id"]] = {
            "proc": proc, "log_path": log_path, "log_fh": log_fh,
            "started_at": storage.now_iso(), "port": project.get("port") or 8900,
            "dir": target,
        }
        time.sleep(0.8)
        return status(project["id"])


def stop(project_id: str) -> dict:
    with _LOCK:
        info = _PROCS.get(project_id)
        if not info:
            return {"running": False, "message": "No process."}
        proc = info["proc"]
        if proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        info["log_fh"].close()
        del _PROCS[project_id]
        return {"running": False, "message": "Server stopped."}


def status(project_id: str) -> dict:
    info = _PROCS.get(project_id)
    if not info:
        return {"running": False}
    code = info["proc"].poll()
    return {
        "running": code is None,
        "pid": info["proc"].pid,
        "exit_code": code,
        "started_at": info["started_at"],
        "port": info["port"],
        "url": f"http://127.0.0.1:{info['port']}/mcp",
    }


def logs(project_id: str, tail: int = 200) -> str:
    info = _PROCS.get(project_id)
    if not info:
        return "No active process for this project."
    try:
        with open(info["log_path"], "r", encoding="utf-8", errors="replace") as fh:
            return "".join(fh.readlines()[-tail:]) or "(log empty for now)"
    except OSError as exc:
        return f"Unreadable log: {exc}"


def stop_all() -> None:
    for pid in list(_PROCS):
        try:
            stop(pid)
        except Exception:  # noqa: BLE001 — best-effort shutdown
            pass
