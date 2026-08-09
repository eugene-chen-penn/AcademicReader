#!/usr/bin/env bash
# One-command backend setup + start: installs uv if missing, syncs deps,
# and runs the server on http://127.0.0.1:8721. Safe to re-run.
#
# Works two ways: run from inside a clone of the repo (uses ../backend next
# to this script), or run standalone (e.g. downloaded directly from a
# release) — in that case it clones the repo into ~/.academicreader first.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -d "$SCRIPT_DIR/../backend" ]; then
  cd "$SCRIPT_DIR/../backend"
else
  REPO_DIR="$HOME/.academicreader/AcademicReader"
  if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" pull --ff-only
  else
    mkdir -p "$(dirname "$REPO_DIR")"
    git clone https://github.com/eugene-chen-penn/AcademicReader.git "$REPO_DIR"
  fi
  cd "$REPO_DIR/backend"
fi

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
