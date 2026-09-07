# Durable memory processing

Synapse records accepted session memory before any organization work begins. The
capture transaction inserts an immutable `memory_revisions` row and exactly one
`memory_processing_jobs` row for processor version 1. An exact capture replay
returns the existing response and creates no additional job. A conflicting or
rolled-back capture creates no job. Existing response fields remain compatible;
the optional `revision_id` also identifies the immutable source for retrieval.
Capture performs no inference. Revisions saved before queue integration are not
automatically backfilled, including when an old capture is replayed exactly.

## Worker boundary

`createMemoryProcessingStorage` owns the Postgres scheduling protocol.
`createMemoryProcessingRunner` is disabled unless it receives a handler with both
of these methods:

```js
const handler = {
  async process(sourceEnvelope) {
    // Expensive or remote work happens outside a database transaction.
    return deterministicResult;
  },
  async commit({ client, source, result }) {
    // Apply derived mutations with this transaction-bound pg client.
  },
};
```

Storage validates the current project lease token, monotonically increasing
fence, and expiration before calling `commit`. It applies the handler's derived
mutations and changes the job to `succeeded` in the same transaction. A stale
worker therefore cannot commit mutations or complete a job. The HTTP server does
not start this runner. The separate `npm run worker` entrypoint composes the
Postgres ledger adapter, bounded inference API, organizer handler, queue storage,
and runner. An absent handler remains disabled rather than consuming jobs as a
successful no-op.

The worker is opt-in through `MEMORY_PROCESSING_ENABLED=true`. Its default
production composition always reviews proposed changes, makes remote calls
outside the write transaction, and revalidates source-backed change sets before
commit. Shutdown cancels active inference and stops new claims; unfinished jobs
remain subject to the same retry and lease-fencing rules.

The source envelope is adapter contract v1. It is assembled from the immutable
revision and checked joins to its owner, project, session node, and author
session. `capturedAt` is the revision's arrival timestamp; it does not establish
when every claim in the Markdown became true.

## Scheduling guarantees

- A durable project lease permits one active job per project, even across worker
  processes. Its fence increases every time the project is reacquired.
- Claim selection excludes active project leases before its candidate limit, so
  a busy project's pending sessions do not hide another project's ready work.
- Every queue transaction locks one project lease before its job row. Candidate
  scans take no row locks; claim and recovery recheck eligibility under the
  project lock. Recovery skips projects currently being renewed or completed.
- A later revision for the same session node is blocked until all earlier
  revisions for that processor version have succeeded. An explicitly failed
  earlier revision intentionally blocks later ones for investigation or replay.
- Each claim increments `attempt_count`. Handler errors and expired leases are
  rescheduled with bounded exponential backoff until `max_attempts`; the final
  outcome is the explicit `failed` state.
- Claiming first recovers expired jobs. Old lease tokens and fences cannot renew,
  fail, mutate derived storage, or complete the reacquired job.
- Successful completion is idempotent from the queue's perspective: only the
  holder of the live fence can transition a processing job once, and a repeated
  acknowledgment observes the existing success without invoking the commit
  callback again. A handler's derived schema should additionally use stable
  revision/change identifiers.

## Deployment boundary

Migration `202609070002_memory_processing_queue.sql` creates the private queue,
the capture-only enqueue function, and the non-login `synapse_memory_worker`
role. Migration `202609070004_memory_ledger.sql` supplies the normalized ledger
and projection schema. Apply all release migrations before deploying the
matching HTTP service and worker.

Provision a dedicated worker login, `DATABASE_WORKER_URL`, an inference API key,
and explicit extraction/review models only in the organizer service. Startup
rejects superusers, `BYPASSRLS`, and runtime-role membership; shared connection
validation rejects URL options that would override verified TLS. Disabled
workers open neither a database nor an API connection. Do not reuse the capture
runtime or administrator credential for workers.

Authenticated retrieval reads the ledger/projection without making model calls;
exact source reads can return an authorized unprocessed revision. Cloud message
delivery has its own queue and receiver credentials and does not depend on
organization succeeding. These are assembled code boundaries, not claims of
deployment, live-native compatibility, or semantic recall.

See [Organizer](memory-organizer.md) for the adapter contract,
[Retrieval](memory-retrieval.md) for read semantics, and
[Cloud operations](cloud-memory-operations.md) for environment bounds, role
provisioning, release gates, and explicit live-validation requirements.
