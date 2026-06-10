"""DOINg.MCP — local OpenAI-compatible LLM client (Ollama, LM Studio, vLLM, llama.cpp…)

All the dynamic intelligence of the app flows through here: SQL generation, repair,
data catalog, tool suggestion, security review, PII detection.
"""
import json
import re
import time

import httpx


class LlmError(RuntimeError):
    pass


def _headers(llm: dict) -> dict:
    headers = {"Content-Type": "application/json"}
    if llm.get("api_key"):
        headers["Authorization"] = f"Bearer {llm['api_key']}"
    return headers


def _base(llm: dict) -> str:
    base = (llm.get("base_url") or "").strip().rstrip("/")
    if not base:
        raise LlmError("LLM URL not configured (Settings → Local LLM).")
    return base


def list_models(llm: dict) -> list[str]:
    try:
        resp = httpx.get(_base(llm) + "/models", headers=_headers(llm), timeout=15)
        resp.raise_for_status()
        data = resp.json()
        return sorted(m.get("id", "") for m in data.get("data", []) if m.get("id"))
    except httpx.HTTPError as exc:
        raise LlmError(f"Unable to list models: {exc}") from exc


def test(llm: dict) -> dict:
    start = time.time()
    try:
        reply = chat(llm, [
            {"role": "system", "content": "Reply with the single word OK."},
            {"role": "user", "content": "ping"},
        ], max_tokens=8)
        return {"ok": True, "latency_ms": round((time.time() - start) * 1000, 1),
                "message": f"Model “{llm.get('model') or '(default)'}” is operational — reply: {reply.strip()[:40]}"}
    except LlmError as exc:
        return {"ok": False, "latency_ms": round((time.time() - start) * 1000, 1), "message": str(exc)}


def chat(llm: dict, messages: list[dict], temperature: float | None = None,
         max_tokens: int | None = None) -> str:
    payload = {
        "model": llm.get("model") or "default",
        "messages": messages,
        "temperature": llm.get("temperature", 0.2) if temperature is None else temperature,
        "max_tokens": max_tokens or int(llm.get("max_tokens") or 2048),
    }
    try:
        resp = httpx.post(_base(llm) + "/chat/completions", json=payload,
                          headers=_headers(llm), timeout=180)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"] or ""
    except httpx.HTTPStatusError as exc:
        raise LlmError(f"LLM HTTP {exc.response.status_code}: {exc.response.text[:200]}") from exc
    except httpx.HTTPError as exc:
        raise LlmError(f"LLM unreachable ({_base(llm)}): {exc}") from exc
    except (KeyError, IndexError, ValueError) as exc:
        raise LlmError(f"Unexpected LLM response: {exc}") from exc


def chat_with_tools(llm: dict, messages: list[dict], tools: list[dict],
                    temperature: float | None = None, max_tokens: int | None = None) -> dict:
    """Tool-calling turn: returns the full assistant message dict (may contain tool_calls)."""
    payload: dict = {
        "model": llm.get("model") or "default",
        "messages": messages,
        "temperature": llm.get("temperature", 0.2) if temperature is None else temperature,
        "max_tokens": max_tokens or int(llm.get("max_tokens") or 2048),
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    try:
        resp = httpx.post(_base(llm) + "/chat/completions", json=payload,
                          headers=_headers(llm), timeout=240)
        resp.raise_for_status()
        message = resp.json()["choices"][0]["message"]
        if not isinstance(message, dict):
            raise LlmError("Unexpected LLM message shape.")
        return message
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:300]
        if exc.response.status_code in (400, 404, 422):
            raise LlmError("This local model rejected tool-calling. Pick a model that supports "
                           f"OpenAI tools/function-calling. Server said: {detail}") from exc
        raise LlmError(f"LLM HTTP {exc.response.status_code}: {detail}") from exc
    except httpx.HTTPError as exc:
        raise LlmError(f"LLM unreachable ({_base(llm)}): {exc}") from exc
    except (KeyError, IndexError, ValueError) as exc:
        raise LlmError(f"Unexpected LLM response: {exc}") from exc


def parse_json_loose(text: str):
    """Tolerant parse: strip markdown fences, isolate the first JSON object/array."""
    cleaned = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text.strip(), flags=re.MULTILINE).strip()
    for candidate in (cleaned, text):
        try:
            return json.loads(candidate)
        except (ValueError, TypeError):
            pass
    for open_ch, close_ch in (("{", "}"), ("[", "]")):
        start = cleaned.find(open_ch)
        end = cleaned.rfind(close_ch)
        if 0 <= start < end:
            try:
                return json.loads(cleaned[start:end + 1])
            except ValueError:
                continue
    raise LlmError("The LLM did not return usable JSON:\n" + text[:300])


# ---------------------------------------------------------------- Business tasks

def generate_sql(llm: dict, dialect: str, schema_context: str, request: str) -> dict:
    system = (
        f"You are a {dialect} SQL expert. You generate ONLY read-only SELECT queries, "
        "a single statement, without a trailing semicolon. Use named parameters of the form "
        ":param_name for any value the user may want to vary. "
        "Reply STRICTLY in JSON: {\"sql\": \"...\", \"explanation\": \"...\", "
        "\"params\": [{\"name\": \"...\", \"type\": \"string|integer|number|boolean|date\", "
        "\"description\": \"...\"}]} — explanation and descriptions in English."
    )
    user = f"Available schema:\n{schema_context}\n\nRequest: {request}"
    out = parse_json_loose(chat(llm, [{"role": "system", "content": system},
                                      {"role": "user", "content": user}]))
    if not isinstance(out, dict) or not out.get("sql"):
        raise LlmError("The LLM did not produce a “sql” field.")
    out.setdefault("explanation", "")
    out.setdefault("params", [])
    return out


def fix_sql(llm: dict, dialect: str, schema_context: str, sql: str, error: str) -> dict:
    system = (
        f"You are a {dialect} SQL expert. Fix the SELECT query while preserving its intent. "
        "Reply STRICTLY in JSON: {\"sql\": \"...\", \"explanation\": \"cause of the failure and fix, in English\"}."
    )
    user = f"Schema:\n{schema_context}\n\nFailing query:\n{sql}\n\nError:\n{error}"
    out = parse_json_loose(chat(llm, [{"role": "system", "content": system},
                                      {"role": "user", "content": user}]))
    if not isinstance(out, dict) or not out.get("sql"):
        raise LlmError("The LLM did not produce a fix.")
    out.setdefault("explanation", "")
    return out


def explain_sql(llm: dict, dialect: str, sql: str) -> str:
    return chat(llm, [
        {"role": "system", "content":
            f"You are a {dialect} SQL expert. Explain this query in plain English, "
            "for a non-technical audience: goal, tables used, filters, expected result. "
            "Maximum 6 sentences, no markdown."},
        {"role": "user", "content": sql},
    ])


def suggest_tool(llm: dict, dialect: str, sql: str, sample: str, hint: str) -> dict:
    system = (
        "You design MCP (Model Context Protocol) tools from SQL queries. "
        "Propose a short, explicit snake_case name, a clear English description "
        "for an AI agent (when to use this tool, what it returns), and document each parameter. "
        "Reply STRICTLY in JSON: {\"name\": \"...\", \"description\": \"...\", "
        "\"params\": [{\"name\": \"...\", \"type\": \"string|integer|number|boolean|date\", "
        "\"description\": \"...\", \"required\": true, \"default\": null}], \"tags\": [\"...\"]}."
    )
    user = f"Dialect: {dialect}\nSQL:\n{sql}\n\nResult sample:\n{sample}\n\nContext: {hint or '(none)'}"
    out = parse_json_loose(chat(llm, [{"role": "system", "content": system},
                                      {"role": "user", "content": user}]))
    if not isinstance(out, dict) or not out.get("name"):
        raise LlmError("The LLM did not produce a tool suggestion.")
    out.setdefault("description", "")
    out.setdefault("params", [])
    out.setdefault("tags", [])
    return out


def review_sql(llm: dict, dialect: str, sql: str) -> dict:
    system = (
        "You are a data security auditor. Analyze this SQL query exposed as an MCP tool to an AI agent: "
        "exfiltration risk, excessive volumes, sensitive data (PII), injection via parameters, cost. "
        "Reply STRICTLY in JSON: {\"risk\": \"low|medium|high\", \"findings\": [\"...\"], "
        "\"recommendations\": [\"...\"]} — in English."
    )
    out = parse_json_loose(chat(llm, [{"role": "system", "content": system},
                                      {"role": "user", "content": f"Dialect {dialect}:\n{sql}"}]))
    if not isinstance(out, dict):
        raise LlmError("Unreadable security review.")
    out.setdefault("risk", "medium")
    out.setdefault("findings", [])
    out.setdefault("recommendations", [])
    return out


def enrich_catalog(llm: dict, tables: list[dict]) -> list[dict]:
    """tables = [{schema, name, columns:[{name,type}]}] → descriptions + PII flags."""
    system = (
        "You document a data catalog for AI agents. For each table: a business description "
        "in English (1-2 sentences), and for each column a short English description plus "
        "a boolean pii=true if the column likely contains personal or sensitive data "
        "(email, name, phone, address, IP, bank identifier…). "
        "Reply STRICTLY in JSON: [{\"schema\": \"...\", \"name\": \"...\", \"description\": \"...\", "
        "\"columns\": [{\"name\": \"...\", \"description\": \"...\", \"pii\": false}]}]."
    )
    payload = json.dumps(
        [{"schema": t["schema"], "name": t["name"],
          "columns": [{"name": c["name"], "type": c.get("type", "")} for c in t.get("columns", [])[:60]]}
         for t in tables],
        ensure_ascii=False,
    )
    out = parse_json_loose(chat(llm, [{"role": "system", "content": system},
                                      {"role": "user", "content": payload}]))
    if isinstance(out, dict):
        out = [out]
    if not isinstance(out, list):
        raise LlmError("Unreadable enriched catalog.")
    return out
