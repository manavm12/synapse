---
title: Personal Memory Layer
topic: architecture
added: 2026-08-29
updated: 2026-08-29
---

Synapse should treat agents as disposable compute and project memory as persistent external state. The MVP will ignore ownership and security boundaries so it can focus on preserving and retrieving useful context.

## Session capture

Every Codex session owns one concise Markdown memory document. The agent decides what is durable and writes only a summary of meaningful work, decisions, discoveries, unresolved questions, and references. Raw transcripts remain local. Repeated saves from one session update the same document rather than creating duplicates.

The Synapse plugin makes capture reliable through Codex lifecycle hooks. Plugin instructions ask the agent to save after meaningful milestones. A `Stop` hook calls `memory_checkpoint(session_id, turn_id)`; Synapse requests an update after five turns, after a Synapse task completes, or when substantive work has no saved memory. Codex then calls `save_session_memory(...)` before stopping.

Because `SessionEnd` cannot call an MCP tool, a bundled command hook records unsaved session metadata and the local transcript path in a local pending file. The next `SessionStart` hook asks Codex to process that local transcript and submit the missing memory document. The transcript itself never leaves the device.

Each session document contains `session_id`, `project_id`, title, short summary, Markdown details, optional source channel, and timestamps. The Markdown uses simple sections: Summary, What changed, Decisions, Still unresolved, and Important references.

## Indexed tree

Synapse stores memory as a shallow tree of root, topic, and session nodes. Each node has an ID, parent ID, type, title, summary, and Markdown body. Session documents are source material. Root and topic indexes are generated routing summaries.

A maintenance agent runs hourly or after ten unorganized session documents accumulate. It places each document under the closest topic, creates a topic when needed, and regenerates affected indexes. It splits a topic after 25 session documents and merges small topics that clearly describe the same subject. It never rewrites the original session document.

## Retrieval

For an incoming task, Synapse reads the root index and selects up to three topics. It reads those topic indexes and selects up to eight session documents. Postgres full-text search over summaries provides a fallback for missed branches. Synapse then passes the task, recent channel history, and a memory package capped at 12,000 tokens to the new agent.

The MVP has one project and one memory graph per user. Detailed sharing policies remain out of scope, but basic account isolation is required for external testers.
