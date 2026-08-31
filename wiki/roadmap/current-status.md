---
title: Current Status
topic: roadmap
added: 2026-08-31
updated: 2026-08-31
---

## Completed

Slice 1, the local Codex client baseline, is implemented on `codex/v1-client-baseline` and published in GitHub pull request [#1](https://github.com/manavm12/synapse/pull/1).

The baseline provides metadata-only parent notification, a manual `synapse send` command, assignment-bound child MCP claim, user-visible task text with the claim/completion protocol kept in developer instructions, one worktree and persistent Codex thread per channel, dispatch fencing, one active job per channel, race-safe dead-worker recovery that interrupts and confirms the old Codex turn before redispatch, race-safe process locking, project-isolated runtime paths, and a shared Codex App Server that releases thread ownership back to the desktop when Synapse becomes idle.

Verification evidence:

- 39 unit and integration tests pass.
- Node syntax checks pass.
- Dependency audit reports zero vulnerabilities.
- The isolated live probe completes two jobs on the same Codex thread.
- A desktop-inspected CLI run shows the exact submitted task as the user message while claim and completion remain tool calls.
- Probe cleanup leaves default state, worktrees, runtime directories, and processes unchanged.

The local JSON job store and local task MCP server are deliberate Slice 1 scaffolding. They will be replaced at the relay boundary in the messaging slice.

## Next

Build Slice 2: automatic session-memory capture. Keep it independently testable and do not start messaging, accounts, Postgres, or the web inbox until session capture works end to end.
