#!/usr/bin/env bash
# Starts iOSDeOb's host-side services — the two pieces that run directly on
# your Mac instead of in Docker (frida-bridge needs real USB device access;
# mcp-server is normally spawned by your MCP client, but this is handy for a
# standalone smoke test). The Docker stack (`docker compose up -d` in the
# project root) should already be running for either of these to be useful.
#
# Usage:
#   ./run-host-services.sh          interactive menu
#   ./run-host-services.sh 1        MCP server only
#   ./run-host-services.sh 2        frida-bridge only
#   ./run-host-services.sh 3        both
#
# Ctrl-C stops whatever this started.

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRIDA_DIR="$ROOT_DIR/frida-bridge"
MCP_DIR="$ROOT_DIR/mcp-server"

# ---------- helpers ----------

internal_token() {
  if [ -f "$ROOT_DIR/.env" ] && grep -q '^INTERNAL_TOKEN=' "$ROOT_DIR/.env"; then
    grep '^INTERNAL_TOKEN=' "$ROOT_DIR/.env" | head -1 | cut -d= -f2-
  else
    echo "dev-internal-token-change-me"
  fi
}

# ensure_venv <dir> — create the venv and install requirements.txt if either
# is missing or requirements.txt changed since the last install.
ensure_venv() {
  local dir="$1"
  if [ ! -d "$dir/.venv" ]; then
    echo "==> Creating venv in ${dir#"$ROOT_DIR"/}"
    python3 -m venv "$dir/.venv" || return 1
  fi
  local marker="$dir/.venv/.deps-installed"
  if [ ! -f "$marker" ] || [ "$dir/requirements.txt" -nt "$marker" ]; then
    echo "==> Installing ${dir#"$ROOT_DIR"/} requirements"
    ( cd "$dir" && . .venv/bin/activate && pip install -q -r requirements.txt ) || return 1
    touch "$marker"
  fi
}

ensure_frida_agent() {
  if [ ! -d "$FRIDA_DIR/node_modules" ]; then
    echo "==> Installing frida-bridge npm dependencies"
    ( cd "$FRIDA_DIR" && npm install ) || return 1
  fi
  if [ ! -f "$FRIDA_DIR/agent-bundle.js" ] || [ "$FRIDA_DIR/agent.js" -nt "$FRIDA_DIR/agent-bundle.js" ]; then
    echo "==> Building frida agent bundle"
    ( cd "$FRIDA_DIR" && npm run build ) || return 1
  fi
}

# run_labeled <label> — reads stdin line by line and prefixes each line with
# [label]. Deliberately avoids GNU-only sed/awk flags so it works with
# macOS's stock BSD tools too.
run_labeled() {
  local label="$1"
  while IFS= read -r line; do
    printf '[%s] %s\n' "$label" "$line"
  done
}

start_frida() {
  ensure_venv "$FRIDA_DIR" || { echo "!! frida-bridge venv setup failed"; return 1; }
  ensure_frida_agent || { echo "!! frida-bridge agent build failed"; return 1; }
  echo "==> Starting frida-bridge — make sure your jailbroken iPhone is"
  echo "    connected and frida-server's version matches frida-bridge/requirements.txt"
  (
    cd "$FRIDA_DIR"
    . .venv/bin/activate
    export REDIS_URL="${REDIS_URL:-redis://localhost:6379/0}"
    export API_INTERNAL_URL="${API_INTERNAL_URL:-http://localhost:8000}"
    export INTERNAL_TOKEN="${INTERNAL_TOKEN:-$(internal_token)}"
    exec celery -A bridge.celery_app worker -Q frida --pool=solo --loglevel=INFO
  ) 2>&1 | run_labeled "frida-bridge" &
}

start_mcp() {
  ensure_venv "$MCP_DIR" || { echo "!! mcp-server venv setup failed"; return 1; }
  echo "==> Starting mcp-server — it talks stdio JSON-RPC, so it'll sit quiet"
  echo "    here with no output until something actually calls it; that's"
  echo "    expected. Your MCP client (Claude Code/Desktop) normally spawns"
  echo "    its own instance per the config from the web UI's 'MCP setup'"
  echo "    button rather than attaching to this one — this is mainly a"
  echo "    standalone check that it starts cleanly."
  (
    cd "$MCP_DIR"
    . .venv/bin/activate
    export IOSDEOB_API_BASE="${IOSDEOB_API_BASE:-http://localhost:8080/api}"
    exec python3 server.py
  ) 2>&1 | run_labeled "mcp-server" &
}

cleanup() {
  echo ""
  echo "==> Stopping..."
  kill 0 2>/dev/null
}
trap cleanup INT TERM

# ---------- menu ----------

choice="${1:-}"
if [ -z "$choice" ]; then
  echo "iOSDeOb — host-side services"
  echo "(the Docker stack should already be up: docker compose up -d)"
  echo ""
  echo "  1) MCP server only"
  echo "  2) frida-bridge only"
  echo "  3) Both"
  echo ""
  while true; do
    read -rp "Choice [1-3]: " choice
    case "$choice" in
      1|2|3) break ;;
      *) echo "Please enter 1, 2, or 3." ;;
    esac
  done
fi

case "$choice" in
  1) start_mcp ;;
  2) start_frida ;;
  3) start_mcp; start_frida ;;
  *) echo "Invalid choice: $choice (expected 1, 2, or 3)"; exit 1 ;;
esac

wait
