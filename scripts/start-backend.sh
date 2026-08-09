#!/usr/bin/env bash
# One-command backend setup + start: installs uv if missing, syncs deps,
# and runs the server on http://127.0.0.1:8721. Safe to re-run.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../backend"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv (Python package manager) not found — installing it..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "Installing backend dependencies..."
uv sync --group dev

echo ""
echo "Starting AcademicReader backend on http://127.0.0.1:8721 ..."
echo "Leave this running, then load the extension in Chrome (see README)."
echo ""
exec uv run uvicorn app.main:app --port 8721
