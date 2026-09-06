#!/bin/sh
set -eu

if [ -n "${CODEX_MCP_NODE_PATH:-}" ] && [ -x "$CODEX_MCP_NODE_PATH" ]; then
  exec "$CODEX_MCP_NODE_PATH" "$(dirname "$0")/dispatch.mjs"
fi

exec node "$(dirname "$0")/dispatch.mjs"
