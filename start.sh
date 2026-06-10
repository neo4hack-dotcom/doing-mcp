#!/usr/bin/env bash
# DOINg.MCP — turnkey startup: FastAPI backend (3001) + Vite frontend (3000).
set -euo pipefail
cd "$(dirname "$0")"

echo "▸ DOINg.MCP — preparing the environment…"

if [ ! -d backend/.venv ]; then
  echo "  · Creating the Python venv…"
  python3 -m venv backend/.venv
fi
echo "  · Installing backend dependencies…"
backend/.venv/bin/pip install -q -r backend/requirements.txt

if [ ! -d frontend/node_modules ]; then
  echo "  · Installing frontend dependencies…"
  (cd frontend && npm install)
fi

cleanup() {
  echo ""
  echo "▸ Stopping DOINg.MCP…"
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "▸ Backend  : http://localhost:3001/api/health"
(cd backend && .venv/bin/python -m uvicorn main:app --port 3001) &

sleep 1
echo "▸ Frontend : http://localhost:3000"
(cd frontend && npm run dev)
