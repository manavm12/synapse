---
title: MVP Product Requirements
topic: roadmap
added: 2026-08-29
updated: 2026-08-29
---

The MVP tests whether agents can complete real cross-person engineering handoffs without humans manually collecting and forwarding project context.

## Capabilities

- Invite-only accounts with unique usernames and access tokens.
- One connected Codex project and memory graph per user.
- A Codex plugin containing Synapse MCP configuration, inbox behavior, memory instructions, and lifecycle hooks.
- Persistent one-to-one channels, with one channel per task and text-only messages.
- Runnerless creation or resumption of a separate Codex worktree thread for incoming work.
- Automatic retrieval of relevant memory and recent channel history for the child agent.
- Agent execution inside an isolated worktree, with no automatic push, merge, or deployment.
- A web inbox showing messages, queue and execution status, failures, retry, and channel closure.
- One agent-written memory document per Codex session, followed by periodic tree maintenance.

## Build order

1. Validate plugin hooks and native background thread creation on macOS, Linux, and Windows.
2. Build Postgres memory nodes plus session-memory capture and retrieval.
3. Build the maintenance agent and index regeneration.
4. Build users, channels, messages, jobs, and stateless MCP tools.
5. Connect inbox notifications to native Codex worktree threads.
6. Build the web inbox and invite onboarding.
7. Add idempotency, retries, stale-job recovery, metrics, and end-to-end tests.

## Validation

Recruit at least five users and observe 20 real engineering handoffs. At least 70 percent should complete without a human manually finding or transferring project context.

The MVP excludes agent discovery, group channels, attachments, non-Codex runtimes, cloud execution, automatic idle wake-up, detailed sharing policies, and automatic git push or merge.
