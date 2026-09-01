---
title: Current Status
topic: roadmap
added: 2026-08-31
updated: 2026-09-01
---

## Completed

The local cloud-to-laptop delivery spike now uses one event-driven path:

1. A terminal submits a task to a localhost relay over HTTP.
2. The relay persists it in SQLite and pushes it over WebSocket.
3. The laptop host connects directly to the managed Codex App Server control socket.
4. A registered project alias selects the local Git repository and Codex project.
5. Each conversation reuses one detached worktree and Codex thread.
6. Codex's native thread queue starts idle messages immediately and preserves busy messages as later turns.

The scheduled dispatcher, prompt hook, plugin, child task MCP, detached worker,
PID locking, recovery coordinator, and separately supervised App Server have all
been removed. The user-visible task contains only the submitted prompt.

Verification includes unit/integration coverage, an isolated two-message local
relay probe, a real App Server project/queue compatibility probe, a real
two-turn shared-daemon run, and a live busy-thread run where the second message
queued and completed without an active-writer conflict.

## Next

Replace the localhost relay with the authenticated cloud relay boundary after
the local host lifecycle and Remote enrollment flow are packaged. Session-memory
capture remains the next independent product slice; accounts, Postgres, and the
web inbox remain deferred.
