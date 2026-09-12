# Handoff: deterministic organizer claim references

- Branch: `codex/organizer-claim-refs`
- Human owner: `Manav Mehta`
- Active agent: `Codex`
- Base reviewed: `5caaf78736f5ce15939a9e51abbfc99304642540`
- Last checkpoint: `5caaf78736f5ce15939a9e51abbfc99304642540`
- Status: `active`

## Goal

Remove model-generated local claim-label failures so the authorized organizer
rollout can proceed without weakening evidence or semantic checks.

## File ownership

- `src/server/memory-organizer/handler.mjs`
- `test/server/memory-organizer.test.mjs`
- `docs/memory-organizer.md`
- This handoff only.

## Completed

- Three production captures committed under PR16; all passed independent review.
- The scoped three-attempt batch stopped after two successes and one failure.
- New diagnostics identified `extract / claim_refs` for job
  `d7232e8f-7fcc-4025-8cf1-cfe77fa08546`; queue state is pending, not reset.
- Reviewed the current Windows and conversational-messaging workstreams; none of
  the intended files overlap. Rollout documentation is checkpointed separately
  on `codex/organizer-rollout-verified` at `401a292`.

## Decisions and invariants

- Claim refs are local proposal keys, not model-derived facts or evidence.
- Assign them by array ordinal before any reconciliation/review uses them.
- Retain the API proposal shape for compatibility; never trust returned labels.
- Do not alter claims, citations, coverage, committed IDs, tenant fencing, or
  queue attempts. Review remains mandatory and gpt-5-nano remains selected.
- Continuous production processing remains disabled; all canaries are stopped.

## Verification

- `npm run check` with fresh disposable PostgreSQL: 250 passed, zero skipped;
  coverage 95.67% lines, 86.17% branches, 94.30% functions.
- `npm run audit`: zero vulnerabilities. Docker build passed.
- Regression tests prove invalid/duplicate model labels are replaced before
  reconciliation/review, original proposals and committed claims remain unchanged,
  replay succeeds, and bad evidence/stale action labels still fail closed.

## Remaining work

1. Pass CI; merge and deploy the tested release.
2. Retry exactly revision `44a45390-03f5-407f-8cee-6b2c91275918` (one consumed
   attempt), then continue the bounded rollout.

## Risks or blockers

- Existing ledger is generation three. Do not rewrite committed sources.
- No new credentials, migrations, or permissions are needed for this fix.
