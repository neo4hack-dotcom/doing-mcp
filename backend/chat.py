"""DOINg.MCP — MCP-aware chat: a local-LLM agentic loop that calls a running
MCP server's tools (via the real MCP protocol) and answers with live data.

100% local: only the configured local LLM and the local MCP server are used.
"""
import json

import llm as llm_mod
from mcp_client import McpClientError, McpHttpClient

MAX_STEPS = 6
MAX_RESULT_CHARS = 6000
STEP_PREVIEW_CHARS = 2000

SYSTEM_PROMPT = (
    "You are a data assistant wired to a local MCP server. Answer the user's questions using "
    "ONLY the data returned by the available tools — never invent values. "
    "When you are unsure which table or column to use, call `catalog_search` first. "
    "Choose the most relevant tool, pass the required parameters, then summarize the result clearly. "
    "Format every answer in clean GitHub-flavored Markdown for readability: use **bold** for key "
    "figures, bullet lists for breakdowns, and ALWAYS present tabular results as a Markdown table "
    "(| col | col | with a |---|---| separator row). Use `code` for identifiers and column names. "
    "Reply in the same language as the user. Be concise and factual."
)


def mcp_tools_to_openai(tools: list[dict]) -> list[dict]:
    out = []
    for tool in tools:
        out.append({
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": (tool.get("description") or tool["name"])[:1024],
                "parameters": tool.get("inputSchema") or {"type": "object", "properties": {}},
            },
        })
    return out


def _result_to_text(result: dict) -> str:
    if not isinstance(result, dict):
        return json.dumps(result, ensure_ascii=False)[:MAX_RESULT_CHARS]
    if result.get("structuredContent") is not None:
        return json.dumps(result["structuredContent"], ensure_ascii=False)[:MAX_RESULT_CHARS]
    parts = []
    for chunk in result.get("content", []):
        if isinstance(chunk, dict) and chunk.get("type") == "text":
            parts.append(chunk.get("text", ""))
    text = "\n".join(parts) if parts else json.dumps(result, ensure_ascii=False)
    return text[:MAX_RESULT_CHARS]


def run_chat(llm_cfg: dict, mcp_url: str, messages: list[dict]) -> dict:
    """Run the agentic loop and return {reply, steps, tools_available}."""
    client = McpHttpClient(mcp_url).connect()
    try:
        mcp_tools = client.list_tools()
        openai_tools = mcp_tools_to_openai(mcp_tools)
        convo: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
        for msg in messages:
            role = msg.get("role")
            if role in ("user", "assistant") and msg.get("content"):
                convo.append({"role": role, "content": str(msg["content"])})

        steps: list[dict] = []
        for _ in range(MAX_STEPS):
            reply = llm_mod.chat_with_tools(llm_cfg, convo, openai_tools)
            tool_calls = reply.get("tool_calls") or []
            content = reply.get("content") or ""

            if not tool_calls:
                return {"reply": content, "steps": steps,
                        "tools_available": [t["name"] for t in mcp_tools]}

            convo.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
            for call in tool_calls:
                fn = call.get("function", {})
                name = fn.get("name", "")
                raw_args = fn.get("arguments")
                try:
                    args = raw_args if isinstance(raw_args, dict) else json.loads(raw_args or "{}")
                except (ValueError, TypeError):
                    args = {}
                try:
                    result = client.call_tool(name, args)
                    text = _result_to_text(result)
                    ok = not result.get("isError")
                except McpClientError as exc:
                    text = f"Tool error: {exc}"
                    ok = False
                steps.append({"tool": name, "args": args, "ok": ok,
                              "result": text[:STEP_PREVIEW_CHARS]})
                convo.append({"role": "tool", "tool_call_id": call.get("id") or name,
                              "name": name, "content": text})

        return {"reply": "(Reached the tool-call limit without a final answer — try rephrasing.)",
                "steps": steps, "tools_available": [t["name"] for t in mcp_tools]}
    finally:
        client.close()
