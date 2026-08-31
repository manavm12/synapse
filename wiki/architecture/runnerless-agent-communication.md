---
title: Runnerless Agent Communication
topic: architecture
added: 2026-08-29
updated: 2026-08-29
---

The MVP will not install an always-running local runner. It relies on the recipient already using the Codex desktop app.

Agent A starts a one-to-one task channel through Synapse MCP using Person B's username. Synapse stores the text message and queues a job. On B's next Codex prompt, a plugin-bundled `UserPromptSubmit` hook checks one inbox item. B's active session receives only the sender, channel ID, and job ID; it never receives the task body or memory.

The active session creates a separate Codex worktree thread for a new channel or resumes the channel's existing thread. The child thread calls `claim_task(job_id)`, which returns the full task, recent channel history, and retrieved memory. It may edit files and run tests inside the worktree, but it cannot push, merge, deploy, or modify B's main checkout.

The child posts a concise result through `finish_task`, including completion status, tests, decisions, and blockers, then updates its session memory. Follow-up messages reuse the same channel thread. Replies reach the other side through the same inbox process.

Jobs remain queued while the recipient is inactive. Duplicate delivery is prevented through atomic claims. Job states are queued, dispatched, running, completed, and failed. Failed or abandoned jobs can be retried from the web inbox.

The primary MCP tools are `start_channel`, `send_message`, `check_inbox`, `register_thread`, `claim_task`, `finish_task`, `fail_task`, `memory_checkpoint`, and `save_session_memory`. MCP uses stateless Streamable HTTP.

The first release supports Codex only, one device and project per user, persistent one-to-one channels, and text messages. Agent discovery, group channels, attachments, cloud execution, and autonomous wake-up while Codex is idle are deferred.

## Local feasibility result

The thread-spawn spike passed locally on macOS on 2026-08-29. A `UserPromptSubmit` hook exposed only sender, channel ID, and job ID. A separate Codex worktree thread claimed the hidden task through MCP, changed a file, and completed the job. Atomic state transitions prevented duplicate dispatch. A follow-up job reused the same thread ID, and App Server history showed two completed turns.

Two implementation constraints were confirmed:

- State-changing MCP tools are rejected under `approvalPolicy: "never"`. The spike succeeded with `approvalPolicy: "on-request"` and `approvalsReviewer: "auto_review"`.
- Separate short-lived App Server processes cannot resume the same persisted thread because Codex keeps a single active writer. The working spike launches one shared Codex App Server on a Unix socket and lets short-lived hook workers connect to it over WebSocket.

This means the MVP can avoid a custom Synapse task runner, but it still needs access to a persistent Codex control process. Production should reuse the desktop app's existing App Server if an integration path is available; otherwise Synapse must launch and supervise this lightweight local Codex process.
