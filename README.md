# DOINg.MCP

**No-code MCP server factory** — connect your local ClickHouse / Oracle databases,
compose queries assisted by your local LLM, and ship standalone, secure, documented
[MCP](https://modelcontextprotocol.io) **FastMCP** servers… without writing a single line of code.

```
┌────────────┐   ┌─────────────┐   ┌────────────┐   ┌───────────┐   ┌────────────┐
│ Connections│ → │ Catalog     │ → │ SQL Studio │ → │ MCP Tools │ → │ FastMCP    │
│ CH/Oracle/ │   │ + AI docs   │   │ NL → SQL   │   │ + guard-  │   │ server     │
│ sandbox    │   │ + PII flags │   │ + repair   │   │   rails   │   │ ZIP / run  │
└────────────┘   └─────────────┘   └────────────┘   └───────────┘   └────────────┘
                     ▲  everything is driven by your local (OpenAI-compatible) LLM  ▲
```

## Quick start

```bash
./start.sh
# Frontend: http://localhost:3000   ·   Backend: http://localhost:3001
```

Or manually:

```bash
# Backend (port 3001)
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 3001

# Frontend (port 3000, proxy /api → 3001)
cd frontend
npm install
npm run dev
```

**No database at hand?** Click “Demo sandbox”: an in-memory SQLite database
(5 filled e-commerce tables) lets you run the whole pipeline.

**Local LLM**: Settings tab → Ollama / LM Studio / vLLM / llama.cpp presets,
connection test, model listing, temperature.

## The pipeline in 7 steps (Pipeline tab)

1. **Connection** — test + automatic schema introspection.
2. **Tables** — drag & drop selection; becomes the LLM context.
3. **Query** — plain-English description → generated parameterized SQL (`:param`), runnable, repairable by the AI.
4. **Guardrails** — deterministic validation + LLM security review + suggested PII masking.
5. **Tool** — MCP contract (name, description, typed parameters) suggested by the AI, confirmed by you.
6. **Project** — drag the tool into an existing server or create a new one.
7. **Shipping** — FastMCP code generated, downloadable ZIP, one-click local run, ready-to-paste MCP client config, and an **integrated chat** to test the server with your local LLM.

## Integrated chat (local LLM × MCP)

Every MCP project ships with a built-in chat (Projects tab → **Chat**, and the final Pipeline step → **Test in chat**).
Ask a question in plain language: DOINg.MCP **auto-starts the generated server locally**, the local LLM
discovers its tools over the real MCP protocol, **calls them** (tool calls are shown inline), and answers with
**live data from your database**. Nothing leaves your machine — only the local LLM and the `127.0.0.1` MCP server
are contacted. The LLM must support OpenAI tool/function calling (most do via Ollama, LM Studio, vLLM).

## Features (beyond the brief)

1. **Built-in demo sandbox** (in-memory SQLite) — pipeline testable without ClickHouse/Oracle.
2. **NL → SQL** with schema context injected automatically.
3. **SQL auto-repair**: the driver error is sent back to the LLM, which proposes a fix.
4. **Query explanation** in plain English for non-technical users.
5. **Deterministic guardrail engine**: read-only, single statement, deny-list of forbidden keywords, automatic LIMIT per dialect (LIMIT / FETCH FIRST), timeout.
6. **LLM security review** per query (low/medium/high risk, findings, recommendations) attached to the tool.
7. **AI PII detection** in the catalog + **column masking** embedded in the generated server.
8. **Living data catalog**: introspection in 1 system query, AI descriptions preserved on refresh, exposed as an **MCP resource** (`doing://catalog`) + `catalog_search` tool.
9. **Tool contract suggestion** by the AI (snake_case name, agent-friendly description, typed/documented parameters).
10. **Tool test playground** (form generated from the parameters, live results).
11. **Per-tool rate-limiting** (calls/minute) compiled into the generated server.
12. **Full ZIP export**: `server.py`, `requirements.txt`, `README.md`, `.env.example`, `catalog.json`, `manifest.json`, generic MCP client config.
13. **Built-in runner**: local HTTP launch of the generated server, status (PID/port), logs, stop — from the UI.
14. **Zero secrets in the generated code**: credentials via environment variables only, passwords never returned by the API.
15. **Optimistic concurrency**: `X-Base-Version` header, HTTP 409 + automatic resync on conflict across tabs.
16. **Filterable audit log** of every action (SQL, tests, generations, deletions).
17. **Dashboard**: KPIs, SQL latency (sparkline), runs/day (bars), tool breakdown (donut) — pure SVG.
18. **Guided onboarding checklist** with progress.
19. **Project import/export as JSON** (share a server + its tools across workshops).
20. **Dark/light mode** persisted, system fonts, 100% offline (no CDN).
21. **Saved queries** with last run status and result sample (reused as AI context).
22. **Drag & drop everywhere**: tables → SQL editor, tables → pipeline selection, tools → projects (with reordering).
23. **Row-level security per tool**: fully parameterizable visibility rules — capture a caller identity (e.g. `user_id`) and declare “this caller can see these values of column A and/or B”. Fail-closed by default, enforced in the app **and compiled into the generated server** (bound parameters, subquery wrapping).
24. **Column profiling** (Explorer): row count, null rates, cardinality, min/max and top values per column — ideal for choosing RLS columns and rule values.
25. **Join-key detection** (Explorer): probable relationships between tables inferred from column names (`orders.customer_id → customers.id`, shared keys), with one-click navigation.
26. **Starter tools**: one click generates deterministic tools for a table (list / get_by_id / count_by / search) — an MCP server in seconds, no LLM needed.
27. **Magic tool**: describe the tool in plain language — the local LLM writes the SQL, validates it against the guardrails (with one auto-repair attempt), names it, documents the contract and creates it.
28. **Project preflight**: a pre-ship checklist — guardrails per tool, contract/SQL parameter coherence, RLS policy sanity, live connection tests — with pass/warn/fail verdicts.

## Row-level security (RLS)

Each tool can carry a *row policy*: an *identity argument* (default `user_id`) is added to the
tool contract, and rules of the form **“these callers → these values of this column”** filter
every result. Rules on the same column add up (OR); different columns combine (AND); callers
matching no rule see nothing by default (fail-closed, configurable). Enforcement wraps the
tool's SQL as a subquery with bound parameters — no string interpolation — and the exact same
policy is **compiled into the generated `server.py`**, so MCP clients cannot bypass it.

## Architecture

| Layer | Technology |
|---|---|
| Frontend | React 19 · TypeScript 5.8 strict · Tailwind CSS 3.4 (dark `class`) · Lucide 0.563 · Vite 6.4 |
| State | `useState`/`useMemo`/`useEffect` + localStorage (theme, tab) — no router |
| Backend | Python 3.10+ · FastAPI · Uvicorn (port 3001) |
| Persistence | `backend/db.json` (lock + atomic write + versioning) |
| Databases | `clickhouse-connect` (HTTP) · `oracledb` (thin mode) · demo SQLite |
| LLM | Any OpenAI-compatible API via httpx (`/chat/completions`, `/models`) |
| Generated servers | [FastMCP](https://github.com/jlowin/fastmcp) ≥ 2.3 — stdio or HTTP |

```
doing-mcp/
├── start.sh                  # turnkey startup
├── backend/
│   ├── main.py               # FastAPI API (state, LLM, connections, tools, projects…)
│   ├── storage.py            # db.json: lock, version, audit, secret masking
│   ├── guardrails.py         # deterministic SQL engine (deny-list, auto LIMIT, params)
│   ├── connectors.py         # ClickHouse / Oracle / demo sandbox SQLite
│   ├── llm.py                # OpenAI-compatible client + business tasks (SQL, catalog…)
│   ├── codegen.py            # FastMCP bundle generation
│   ├── runner.py             # start/stop/logs of generated servers
│   └── generated/<slug>/     # generated servers (server.py, logs…)
└── frontend/src/
    ├── App.tsx               # shell: sidebar, theme, state sync
    ├── api.ts                # typed client + X-Base-Version + 409 handling
    ├── types.ts
    ├── components/           # ui.tsx, charts.tsx (SVG), data.tsx (schema, results…)
    └── tabs/                 # Dashboard, Pipeline, Connections, Catalog, QueryStudio,
                              # Tools, Projects, Audit, Settings
```

## Security model

- **Workshop side**: deterministic guardrails before any execution (never delegated to the LLM),
  parameters bound at the driver level (anti-injection), secrets masked in all API responses.
- **Generated server side**: the same guardrails are *compiled* into `server.py`
  (deny-list regex, SELECT-only, row cap, timeout, rate-limit, PII masking) —
  the client agent cannot bypass them.
- **LLM as a second layer**: the AI security review complements, but never replaces, the deterministic engine.
