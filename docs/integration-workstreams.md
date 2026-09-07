# Synapse integration workstreams

Planning baseline: main `02f983917bb11b394c1cfc562c20e956439f8b0f`, 7 September 2026.

The user requested planning for cloud messaging and implementation of independent
pieces in separate Codex tasks/worktrees. Messaging remains a plan until selected
for implementation. The other tasks implement the bounded milestones below.

## Created tasks and worktrees

All three tasks were confirmed active through the app's task-status API.

| Task | Worktree | Branch | Task ID |
| --- | --- | --- | --- |
| Finish Synapse setup and diagnostics | `/Users/manavmehta/.codex/worktrees/8330/synapse` | `codex/local-setup-doctor` | `01a07ab5-5c30-7e80-ad9a-9cc106876b83` |
| Build Synapse memory processing queue | `/Users/manavmehta/.codex/worktrees/9766/synapse` | `codex/memory-processing-queue` | `01a07ab5-5c30-7e80-ad9a-9cb9a912f923` |
| Prepare Synapse memory organizer core | `/Users/manavmehta/.codex/worktrees/d0a9/synapse` | `codex/deterministic-organizer-core` | `01a07ab5-5cdc-7f21-a1a6-29eca009d27d` |

User-selected messaging policy: after a receiver enables incoming tasks, any
signed-in active user may send tasks for automatic routing. No sender allowlist
or per-message approval flow is part of the initial messaging plan. This policy
does not change the three independent tasks' ownership.

## Shared decisions

- Supabase user ID is the security principal; retain one cloud project per user.
- Existing memory MCP tools and save response remain compatible.
- `memory_revisions` is authoritative, immutable accepted memory. An organizer
  always processes a particular revision, never a mutable `memory_nodes` snapshot.
- Use explicit owner/project UUIDs. A project alias or Codex session ID cannot
  authorize access. Local checkout paths remain local.
- Messaging jobs and memory processing jobs have different states, permissions,
  consumers, and failure semantics. They are separate tables/modules; neither
  waits for the other or needs a shared general-purpose queue framework.
- Keep the uncommitted organizer at
  `/Users/manavmehta/synapse-memory-organizer` intact. Read it as a reference and
  bring selected code into the new task worktree. Preserve its experiment results.
- Work on a branch from current main. Do not merge, deploy, change live service
  settings, alter the user's installed plugin, or run paid inference as part of
  these initial parallel milestones. Commit a reviewable result with verification.
- Check for credentials in any copied files. Do not copy `.env`, databases,
  transcripts, model-call logs, or the `state/` directory.

## Task A: finish local setup experience

Build a repeatable setup command/script and read-only diagnostics for the existing
plugin, cloud OAuth login, and project registration. Work with the existing
username/project account flow. Explain errors and the private repository/SMTP
distribution boundary clearly. Use injectable commands and isolated test homes.

Primary ownership: new `src/client/setup.mjs`, `src/client/doctor.mjs`, setup tests,
`docs/setup.md`, and a minimal dispatch change in `src/client/cli.mjs`. CLI command
syntax should be `setup` and `doctor`; keep the existing commands compatible.
Edit packaging only if strictly needed and coordinate before broad changes.

Do not implement receiver pairing/authentication, change project registry schema,
modify hook behavior, edit memory processing, or provision public infrastructure.
The future messaging plan owns receiver enrollment, so setup should be extensible
without claiming receiving is already available. Verify actual supported Codex
CLI behavior and required skills before implementation.

## Task B: durable cloud memory processing queue

Add an atomic enqueue when a new `memory_revisions` row is stored. Exact save
replays must not enqueue twice; conflicts/rolled-back writes enqueue nothing.
Keep capture responses unchanged and do no inference in the capture transaction.

Implement Postgres job storage and an injectable worker runner with per-project
serialization, renewable fenced leases, revision ordering within a session,
bounded retry scheduling, explicit failure status, and idempotent completion.
The runner must not complete real jobs until a real organizer handler is wired.
An absent handler stays disabled/pending; it is never a successful no-op.

Primary ownership: `src/server/memory-processing/`, one additive migration named
`202609070002_memory_processing_queue.sql`, focused tests, a minimal transaction
integration in `src/server/database.mjs`, and `docs/memory-processing.md`.
The messaging plan reserves migration prefix `202609070001` and does not depend
on this migration. Do not edit historic migrations.

Worker source envelope (adapter contract v1):

```json
{
  "version": 1,
  "ownerId": "uuid",
  "projectId": "uuid",
  "revisionId": "uuid",
  "nodeId": "uuid",
  "sessionId": "opaque session identifier",
  "revision": 1,
  "captureId": "uuid",
  "title": "session title",
  "summary": "session summary",
  "markdown": "exact accepted Markdown",
  "capturedAt": "ISO timestamp of the stored revision"
}
```

The queue identifies an input by revision ID and processor version; the envelope
timestamp is arrival/capture time, not proof of when every source claim was true.
Read all source fields from the durable revision and its checked relationships.
Commit derived mutations and successful processing together, under a validated
fence in one transaction. The initial runner may use a test handler and document
the production commit interface; it must not pretend production organization
exists. Use disposable Postgres and test doubles only. No paid model calls.

## Task C: prepare the organizer's deterministic core

Port the useful v2 source segmentation, claim ledger validation/reducer, and
deterministic topic projection from the dirty organizer prototype onto main in
the new worktree. Accept the source envelope above with identity supplied by a
trusted adapter. Preserve source bytes, evidence offsets, immutable claims,
explicit scope, and replacement/conflict history. Validate tenant/project source
consistency at the adapter boundary.

Primary ownership: `src/memory/core/`, `test/memory-core/`, selected synthetic
fixtures in `fixtures/memory-core/`, and `docs/memory-core.md`.

This is a library milestone. Do not port the SQLite CLI/database/snapshot storage,
add production Postgres tables, implement retrieval, call external models, modify
MCP tools, alter capture, or change worker queue code. Test against supplied model
proposals. Keep failures/quality limitations documented; deterministic checks
cannot establish semantic recall. The existing reported 28/34 retrieval result
does not meet the old quality target and must not be presented as a pass.

Export/document a narrow adapter API around normalized source input, validated
proposals, and a deterministic change set. Queue workers will call this later;
it does not own scheduling or persistence. Do not silently loosen existing scope,
chronology, or evidence checks to make fixtures pass.

## Integration order

Tasks A, B, and C can each be reviewed and merged independently after their tests
pass. Integration is a separate milestone: a tenant-scoped Postgres ledger adapter
and inference handler connect B to C. Retrieval follows the settled storage and
evidence contract. Cloud messaging can ship independently of that memory chain.

When finishing, report exact branch/worktree, changed files, tests, limitations,
and the small next integration step. Flag any required overlap with another task
before changing its owned files. Avoid project-wide renames/refactors.
