---
title: Modular Implementation Slices
topic: roadmap
added: 2026-08-29
updated: 2026-09-01
---

Synapse should be built as separate, testable slices rather than one large implementation plan. Each slice must produce a working demonstration before work begins on the next.

## V1 release boundary

V1 is the two-user technical pilot: agent-facing MCP tools, basic automatic session-memory capture and retrieval, persistent channels, and runnerless Codex worktree execution. It is the first usable release, not a replacement for the broader MVP requirements. Memory-tree maintenance, the web inbox, onboarding, broader reliability work, and the five-user validation follow in later MVP slices.

The local execution component should be packaged as part of the Synapse Codex plugin. A user with Codex already installed and authenticated connects a repository, and Synapse installs its MCP server, lifecycle hooks, local bridge, and configuration. Synapse reuses the user's Codex installation and credentials rather than bundling or authenticating Codex itself.

## Sequence

1. Codex thread-spawn feasibility.
2. Session memory capture.
3. Memory tree maintenance.
4. Memory retrieval.
5. Messaging and channels.
6. Inbox-to-agent-to-reply loop.
7. Web inbox and onboarding.
8. Reliability and user trial.

## Slice 1: Codex thread-spawn feasibility

The first slice must prove the runnerless architecture before production infrastructure is built.

Build a minimal local Synapse MCP server where `check_inbox()` returns a fake sender, channel ID, and job ID, while `claim_task()` returns a hidden test message. Add a minimal Codex plugin with a `UserPromptSubmit` hook. The active Codex session should use the metadata to create a separate worktree thread, and the child thread should claim and handle the hidden task.

The slice passes when the parent sees only metadata, the hidden task never enters the parent transcript, a separate worktree thread is created, the child receives the task and writes a test result, duplicate checks do not execute the job twice, and follow-up metadata resumes the existing child thread.

Test on macOS first. Do not build Postgres, accounts, production memory, or the web interface during this slice. Its output is a firm decision on whether native Codex threads can support the runnerless MVP. If it fails, revisit the runner or on-demand launcher architecture before continuing.

### Result: passed with one dependency

The local spike passed on 2026-08-29. It proved metadata-only parent delivery, hidden MCP task claim, separate worktree execution, duplicate prevention, and a two-turn follow-up on the same Codex thread.

Persistent follow-ups require one shared Codex App Server process while Synapse jobs are active because independently launched App Server instances conflict on the thread's active writer. When the last worker finishes, Synapse stops that process so the desktop can load the completed child thread; the next job starts it again and resumes the stored thread.

### Baseline superseded by the event-driven host

The initial hook/worker/MCP baseline proved worktree and conversation reuse but
could not support immediate delivery and simultaneous owner participation. It
has been replaced by a persistent outbound host connection and one managed Codex
App Server shared with Remote.

The replacement uses a durable relay boundary, explicit Codex project IDs,
committed-HEAD worktrees, native thread queueing, and client-message correlation.
The localhost relay is the cloud mock for this slice. The old dispatcher,
worker, task MCP, recovery, and App Server supervision code is no longer part of
the product architecture.
