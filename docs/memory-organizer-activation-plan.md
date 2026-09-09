# Activate the production memory organizer

Status: deployment/status/canary tooling implemented and locally verified;
production activation awaits credentials, model selection and an operating
inference allowance.

Worktree: `/Users/manavmehta/synapse-memory-organizer`

Branch: `codex/enable-memory-organizer`

Base: `origin/main` at `a5a3668` (9 September 2026).

## Outcome

An accepted session-memory revision is automatically processed into the owner's
project ledger. Extraction, reconciliation against existing project claims, and
semantic review run successfully; the ledger and topic/note/edge projection commit
atomically with job completion. Authenticated retrieval returns the result with
citations to the original revision. Historical captures are also processed.

## What already exists

- `src/server/database.mjs`: saves immutable revisions and enqueues processor-v1
  jobs in the capture transaction.
- `src/server/worker/`: composes the database, inference adapter, organizer and
  queue runner; supports shutdown and configurable request bounds.
- `src/server/memory-processing/`: project leases, revision ordering, lease
  renewal, fenced commits, retry backoff and terminal failures.
- `src/server/memory-organizer/`: extraction, reconciliation, mandatory production
  review, durable evidence validation and ledger/projection persistence.
- `src/server/memory-retrieval/`: authenticated topic, search and source reads.
- `scripts/backfill-memory.mjs`: bounded, idempotent enqueue of missing old jobs,
  with a read-only preview by default.

The live Railway checks in this conversation found one running HTTP service and
no worker service. Its image starts `node src/server/index.mjs`. Worker enablement,
database credentials, inference key and model configuration are absent from that
HTTP service, consistent with the intended service separation. Those checks do
not establish whether the production worker database role is provisioned or all
required migrations are applied.

The core organizer does not need to be rebuilt. Implementation should make its
deployment repeatable and its first real run bounded and observable.

## 1. Implement deployment and operating tools

### Dedicated deployment configuration

Add a worker-specific Railway configuration under `deploy/`, selected explicitly
by the new service. Use the existing Dockerfile and `npm run worker`, one replica,
and no public domain or HTTP healthcheck. Keep the existing HTTP service's start
command and deployment configuration intact. The operator migration/backfill
commands run from the checkout; the current image copies `src/`, not `scripts/`
or `supabase/`.

Document the exact configuration and provisioning sequence in
`docs/cloud-memory-operations.md`, and keep `.env.example` aligned.

### Read-only readiness and processing status

Add an operator command, provisionally `npm run memory:status`, that reports:

- TLS/connectivity and whether the dedicated role satisfies startup requirements;
- required queue/ledger tables and usable permissions;
- pending, processing, succeeded and terminally failed job counts;
- oldest pending work, expired leases and revisions blocked by earlier failures;
- revisions missing a processor-v1 job;
- ledger generation and latest successful completion for an exact owner/project.

Use the worker credential for its allowed reads, explicit owner/project scope,
bounded queries and read-only transactions. Administrator-only migration-version
inspection remains an operator check. Never claim or recover jobs, call inference,
print connection strings or return source Markdown from the status command.

### Bounded canary mode

Add a worker mode that processes at most N claimed attempts for an exact
owner/project and exits. Require both scope IDs together. Count failed attempts
as well as successes, stop on a failed attempt during the canary, and report
idle/blocked separately from successful processing. Existing continuous mode
remains the default for the final production service.

Apply scope to candidate selection, locked eligibility checks and expired-lease
recovery. Preserve the existing project-before-job lock order, revision ordering,
lease renewal, fencing and atomic commit. A scoped run must not change another
project's queue or leases. Keep the continuous production service stopped during
canaries so it cannot consume the remaining backlog.

Expected edits: worker config/runtime/lifecycle, queue runner/storage, and focused
tests. A canary's attempt limit bounds work per invocation; it is not a monetary
cap, and restarts must not silently rerun a completed batch.

### Actionable diagnostics

Add safe failure categories and duration to worker events so an operator can
distinguish missing configuration, role/schema errors, model access, timeout,
context overflow, review rejection and lease loss. Use allowlisted fields and
generic fallbacks; exclude raw error messages, prompts and provider bodies.
Distinguish an attempt rescheduled to pending from a terminally failed job.

## 2. Verify database and model prerequisites

Before starting inference:

1. Inspect the deployed schema and the migration-version table with operator
   access. Apply only missing release migrations in order. In particular, verify
   `202609070002_memory_processing_queue.sql` and
   `202609070004_memory_ledger.sql` and their dependencies.
2. Provision or verify `synapse_memory_worker` as a dedicated login with its own
   password. It must have the worker permissions, no runtime-role membership,
   no superuser privileges and no `BYPASSRLS`.
3. Verify the worker connection from the deployment network using the Supabase
   CA, then inspect the selected project's backlog without claiming work.
4. Supply a funded inference key and explicit extraction/reconciliation model.
   Confirm the selected model supports the adapter's strict JSON output and
   medium reasoning. The review model may be the same model but runs as a
   separate review request; production review remains mandatory.
5. Establish the canary spend allowance and ongoing inference allowance before
   activation. Default bounds permit two calls per stage and five queue attempts;
   retries can multiply cost. Provider alerts alone must not be represented as a
   hard spending cap. Use provider usage to include unsuccessful API calls.

Worker-only environment:

```dotenv
NODE_ENV=production
MEMORY_PROCESSING_ENABLED=true
DATABASE_WORKER_URL=<dedicated-worker-connection-string>
DATABASE_SSL=verify-full
DATABASE_CA_CERT=<Supabase-CA-PEM>
OPENAI_API_KEY=<inference-key>
MEMORY_MODEL=<verified-model>
# Optional; otherwise uses MEMORY_MODEL.
MEMORY_REVIEW_MODEL=<verified-review-model>
```

Retain the current 60-second request timeout, 8,000 output-token limit and two
calls per stage initially. Adjust only if measured canary results demonstrate a
specific need. Keys and passwords are supplied through secret configuration.

## 3. Validate the implementation locally and in CI

- Use Node 24 and npm 11; install with `npm ci --ignore-scripts`.
- Test status as read-only, absent/misconfigured credentials, bounded-run stop
  behavior, mixed-tenant isolation, retry outcomes and sensitive-data omission.
- Exercise the real Postgres queue and ledger with a disposable Postgres 17
  database: scope all recovery/claim paths, preserve revision ordering and
  fencing, reject stale commits, and verify duplicate acknowledgments do not
  advance the ledger twice.
- Retain the existing extraction/reconciliation/review tests, source-citation
  checks, shutdown tests and tenant-isolation coverage.
- Run `npm run check`, `npm run audit`, `npm run validate:plugin` and a Docker
  build. Verify disabled startup opens neither database nor inference connections.
- Open a focused PR and pass `CI / verify` and `Security / secrets` before merging.

Mocked responses verify mechanics; the next phase establishes live processing.

## 4. Run live canaries and prepare historical work

1. In a controlled test owner/project, save a small source revision through the
   real capture path. Run one bounded attempt with the production inference
   adapter and dedicated worker role. Verify `succeeded`, one accepted ledger
   source, matching projection generation and exact source citations.
2. Save subsequent revisions from the same session and a second session that
   repeat a fact, explicitly change a fact, and introduce/resolve an open
   question. Run bounded attempts and verify cross-
   revision reconciliation, preserved history, source evidence and meaningful
   relation/projection output. A simple source need not produce a graph edge.
3. Inspect the intended production project's old captures while its worker is
   stopped. Preview missing jobs using the existing backfill command and enqueue
   bounded batches until `has_more` is false. This is done before draining the
   queue so missing earlier revisions participate in same-session ordering.
4. Run a small scoped production batch and inspect actual topics, claims,
   superseded facts and citations via `memory_topics`, `search_memory` and
   `read_memory`. Verify this against database job/generation state independently
   of the worker's log message.
5. Investigate failed or blocked revisions before widening the run. Backfill
   must not reset failed or succeeded jobs. Any recovery of a terminal failure
   targets the exact investigated job and retains its source and audit history.

Current scale limits must be visible during this phase: the organizer loads
project history, source segmentation allows at most 160 segments, and prompt
limits are 160,000 characters for extraction and 200,000 for other stages. It
fails rather than silently truncating. If the real backlog reaches these limits,
candidate selection/chunking with preserved evidence becomes a prerequisite for
that project's rollout; raising limits blindly is not an activation fix.

## 5. Enable continuous processing and verify completion

Create the dedicated Railway worker service from the tested release, install its
worker-only secrets, select its deployment configuration and enable continuous
mode. Start with one replica. Confirm the configured command, enabled startup,
successful inference, queue completion and durable retrieval updates.

Drain the historical backlog, reconcile every remaining failed/blocked revision,
then save a fresh memory and verify it is organized without an operator command.
Use periodic status snapshots and the job events to detect a growing backlog,
expired leases, repeated failures and loss of progress. A running process or
healthy HTTP `/readyz` is insufficient evidence of organizer health.

Completion criteria:

- A fresh capture reaches `succeeded` and becomes retrievable with valid citations.
- Cross-session/revision facts reconcile correctly and preserve relevant history.
- The intended historical captures have processor-v1 jobs and complete processing;
  any unresolved failures remain explicitly reported as incomplete work.
- Restarts retain work and duplicate processing cannot duplicate committed results.
- Worker failures do not break saving new captures, and the actual inference
  usage and ongoing operating allowance are understood.

Rollback: stop the dedicated worker or disable processing and redeploy it. Keep
captures, queued jobs and accepted ledger history. Restarting can recover expired
leases; disabling the service does not undo results already committed. A bad
semantic result requires an explicit data-repair procedure, not a queue reset.

## Inputs still needed for live activation

- Secure worker database credential and confirmation of migration/operator access.
- Secure inference key, selected model(s), and an ongoing inference allowance.
- Exact owner/project identifiers for the test and initial production batches.

These inputs do not block implementing the deployment/status/canary tooling in
this worktree. They are needed before its live rollout.

## Implementation verification — 9 September 2026

- Added `deploy/railway-worker.json` and the operating runbook commands.
- Added `npm run memory:status` with a read-only transaction, exact scope, role
  and table-privilege checks, job/history counts and ledger generation.
- Added `npm run worker:canary` with mandatory scope and attempt limit; scoped
  recovery and claim selection, stop-on-failure and explicit incomplete results.
- Added sanitized startup/job failure categories, job durations and durable
  retry/terminal-state reporting.
- `npm run check`: 192 tests passed, zero skipped, using a task-specific
  disposable PostgreSQL 17 container. Coverage: 95.17% lines, 85.09% branches,
  94.39% functions.
- `npm run audit`: zero reported vulnerabilities. Plugin validation passed.
- Docker build and container checks for disabled startup and both command help
  paths passed. Tests use synthetic inference; no live model call was performed.
- Production recheck still found only the existing HTTP service. No worker
  service, production migration, backfill or live inference was started.
