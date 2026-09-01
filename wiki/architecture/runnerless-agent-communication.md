---
title: Runnerless Agent Communication
topic: architecture
added: 2026-08-29
updated: 2026-09-01
---

The recipient installs a lightweight Synapse host that keeps one outbound
WebSocket open to the relay. It consumes no model tokens while idle and does not
poll Codex. The relay can therefore push a queued cloud task to an awake,
connected laptop immediately.

The host is a control-plane connector, not a second agent runner. It connects as
another client to the managed Codex App Server Unix WebSocket. The same daemon
owns Remote visibility, task history, approvals, and turns, which eliminates the
active-writer conflict caused by independently launched App Servers.

Every incoming task names a registered project alias and conversation ID. The
host resolves the alias through its local allowlist, creates a detached Git
worktree from committed `HEAD`, assigns the Codex thread to the canonical Codex
project ID, and submits the exact task text with a hidden client message ID.
Follow-ups reuse the same thread and worktree.

The host uses Codex's native thread queue. An idle submission is promoted into a
turn atomically. A submission received during owner or agent activity remains in
the queue and is promoted by Codex after the active turn. Synapse observes turn
and item events; it never calls `turn/steer` for a new message.

Only outcomes correlated to Synapse client message IDs return to the relay.
Owner-authored follow-ups remain private. Project permission profiles are
selected locally, and requests beyond the profile remain pending for the owner;
Synapse does not auto-approve them.

The current spike uses a loopback HTTP/WebSocket relay and SQLite. Replacing it
with the hosted relay changes the transport endpoint and authentication, not
the Codex/worktree ownership model.
