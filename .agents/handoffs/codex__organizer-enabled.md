# Handoff: production organizer enabled

- Branch: `codex/organizer-enabled`
- Human owner: `Manav Mehta`
- Active agent: `Codex`
- Base reviewed: `a50f2222336e650418a9531cdd51e2ba03e2bb9b`
- Last checkpoint: `a50f2222336e650418a9531cdd51e2ba03e2bb9b` (deployed runtime)
- Status: `ready-for-review`

## Goal

Enable the continuous production organizer after the user explicitly accepted
the known semantic-quality limitations and instructed that it be turned on.

## File ownership

- This handoff only.
- `.agents/handoffs/codex__organizer-coverage-repair.md` (close the same agent's
  merged workstream and point to the current activation record).

## Completed

- PR20 merged after all required CI and security checks passed at exact head
  `f68086d1b829aaba825ae82f6cabb920ef620d90`; bot findings were resolved/withdrawn.
- Production release: `a50f2222336e650418a9531cdd51e2ba03e2bb9b`.
- Railway deployment: `bca8f6e0-22a3-49d2-a44f-5396881c613d`, status `SUCCESS`.
- Set `MEMORY_PROCESSING_ENABLED=true` on `synapse-memory-worker` only.
- Normal start command `npm run worker`; restart `ON_FAILURE`, three retries.
- Startup logged `enabled: true`, `mode: continuous` at 2026-09-12 07:52:52 UTC.
- Read-only database check confirms one queued memory is actively processing.

## Decisions and invariants

- The user knowingly accepted uncertain memory quality. This is authorization
  to run the worker, not evidence that extraction/reconciliation is accurate.
- Keep `gpt-5-nano` for extraction, reconciliation, and review. No model upgrade.
- Mandatory review, strict evidence validation, source replay, tenant scope,
  project lease/fence, backoff, and five-attempt job limits remain unchanged.
- Per-stage request limit remains the configured default of two; output ceiling
  remains 32000 tokens and request timeout 180000 ms. No new spend cap was added.
- No credential, schema, queue-history reset, or HTTP-service setting change.
- This documentation-only branch is not another runtime release. Do not interrupt
  an active job just to deploy its handoff text.

## Verification

- Released code: full PostgreSQL-backed check passed 261 tests, zero skipped;
  audit clean; Docker build and disabled-start smoke test passed before merge.
- Exact PR head: verify, database, both security checks, and CodeRabbit green.
- Effective deployment manifest matches the release, normal start, and restart policy.
- Worker startup is enabled/continuous; database reports one processing job,
  21 pending jobs, three succeeded jobs, generation 3, 79 claims, and 56 notes.
- Earlier investigated target remains pending at attempt 2 at this observation;
  the continuous scheduler has claimed a different eligible capture.
- HTTP `/readyz` returns `{"status":"ready"}` after the release.

## Remaining work

1. No further action is needed to enable the worker; it is running.
2. If asked to investigate quality or backlog completion, inspect actual job
   outcomes and source-backed retrieval. Do not equate an active job with success.
3. Model quality remains a separate follow-up; no newer model was tested or approved.

## Risks or blockers

- Nano still misses facts and can issue incorrect semantic reviews. A job may
  be rejected repeatedly and ultimately fail; later revisions of that session
  then remain blocked until investigated. Do not bypass checks or reset history.
- The backlog has not been drained or newly accepted output semantically certified.
