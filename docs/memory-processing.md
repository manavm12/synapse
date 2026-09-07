# Durable memory processing

Synapse records accepted session memory before any organization work begins. The
capture transaction inserts an immutable `memory_revisions` row and exactly one
`memory_processing_jobs` row for processor version 1. An exact capture replay
returns the existing response and creates no additional job. A conflicting or
rolled-back capture creates no job. The `save_session_memory` response is
unchanged, and capture performs no inference.

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
worker therefore cannot commit mutations or complete a job. The current server
does not construct or start this runner: there is no production organizer
handler yet, and an absent handler remains disabled rather than consuming jobs as
a successful no-op.

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
role. Production provisioning should give a worker credential only to the real
organizer service. Do not reuse the capture runtime credential for workers. The
organizer/ledger adapter is the next integration milestone; retrieval and
messaging are separate systems.
