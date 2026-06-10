"""DOINg.MCP — minimal synchronous MCP client (Streamable HTTP transport).

JSON-RPC over HTTP, responses delivered either as application/json or as an
SSE stream (event: message / data: {...}). Used by the integrated chat to talk
to a locally running, DOINg.MCP-generated FastMCP server — 100% local.
"""
import json
import time

import httpx


class McpClientError(RuntimeError):
    pass


class McpHttpClient:
    def __init__(self, url: str, timeout: float = 120):
        self.url = url
        self.timeout = timeout
        self.session_id: str | None = None
        self._id = 0
        self._client = httpx.Client(timeout=timeout)

    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json",
                   "Accept": "application/json, text/event-stream"}
        if self.session_id:
            headers["mcp-session-id"] = self.session_id
        return headers

    def _request(self, method: str, params: dict | None = None, notification: bool = False):
        if notification:
            payload: dict = {"jsonrpc": "2.0", "method": method}
        else:
            self._id += 1
            payload = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            payload["params"] = params
        resp = self._client.post(self.url, json=payload, headers=self._headers())
        sid = resp.headers.get("mcp-session-id")
        if sid:
            self.session_id = sid
        if resp.status_code >= 400:
            raise McpClientError(f"MCP HTTP {resp.status_code}: {resp.text[:200]}")
        if notification:
            return None
        return self._parse(resp)

    def _parse(self, resp: httpx.Response):
        data = None
        if "text/event-stream" in resp.headers.get("content-type", ""):
            for line in resp.text.splitlines():
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                try:
                    obj = json.loads(line[5:].strip())
                except ValueError:
                    continue
                if isinstance(obj, dict) and ("result" in obj or "error" in obj):
                    data = obj
        else:
            try:
                data = resp.json()
            except ValueError as exc:
                raise McpClientError("Unreadable MCP response.") from exc
        if not isinstance(data, dict):
            raise McpClientError("Empty MCP response.")
        if data.get("error"):
            err = data["error"]
            raise McpClientError(str(err.get("message", err)) if isinstance(err, dict) else str(err))
        return data.get("result", {})

    def connect(self, attempts: int = 16, delay: float = 0.5) -> "McpHttpClient":
        """Initialize the session, retrying while the server boots."""
        last: Exception | None = None
        for _ in range(attempts):
            try:
                self._request("initialize", {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "DOINg.MCP chat", "version": "1.0"},
                })
                self._request("notifications/initialized", notification=True)
                return self
            except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadError) as exc:
                last = exc
                time.sleep(delay)
        raise McpClientError(f"MCP server unreachable at {self.url} ({last}).")

    def list_tools(self) -> list[dict]:
        return self._request("tools/list").get("tools", [])

    def call_tool(self, name: str, arguments: dict) -> dict:
        return self._request("tools/call", {"name": name, "arguments": arguments or {}})

    def close(self) -> None:
        self._client.close()
