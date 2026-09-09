#!/bin/sh
set -eu
# Codex supplies this signed runtime to plugin commands. No PATH/node/npm fallback.
if [ -z "${CODEX_MCP_NODE_PATH:-}" ] || [ ! -x "$CODEX_MCP_NODE_PATH" ]; then
  echo 'Synapse needs the Node runtime supplied by Codex. Update/restart Codex and try again.' >&2
  exit 1
fi
"$CODEX_MCP_NODE_PATH" --disable-warning=ExperimentalWarning --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(":memory:"); db.close();' || {
  echo 'This Codex runtime lacks the SQLite support required by Synapse. Update Codex.' >&2
  exit 1
}
exec "$CODEX_MCP_NODE_PATH" --disable-warning=ExperimentalWarning "$@"
