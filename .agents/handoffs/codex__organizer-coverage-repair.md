# Handoff: organizer evidence coverage repairs

- Branch: `codex/organizer-coverage-repair`
- Human owner: `Manav Mehta`
- Active agent: `Codex`
- Base reviewed: `bf48aeca50cf64c3c2737c89afafafeb714e6338`
- Last checkpoint: `3077f9ecf7798b1edfd745ff5724b196ede6e17f` (tested nonblank source groups)
- Status: `active`

## Goal

Resolve inconsistent extraction coverage without weakening evidence validation,
then resume the authorized production organizer rollout.

## File ownership

- `src/server/memory-organizer/handler.mjs`
- `src/server/memory-organizer/api.mjs`
- `src/server/memory-organizer/extraction-transport.mjs`
- `src/server/memory-organizer/validation.mjs`
- `src/server/memory-organizer/prompts.mjs`
- `test/server/memory-organizer.test.mjs`
- `docs/memory-organizer.md`
- This handoff only.

## Completed

- Read repository instructions and active branch handoffs; no ownership overlap.
- PR19 exact-source retry stopped on `extract / coverage_evidence` at attempt 2.
- Three prior committed sources remain intact. Continuous worker stays disabled.
- Started a bounded read-only extraction diagnostic; it cannot commit or consume
  a queue attempt and logs only counts and allowlisted validation diagnostics.
- Diagnostic confirmed a cluster of evidence/coverage defects: 25 incoming claims,
  five source segments, three uncited segments marked claims; the core also
  rejected non-unique or empty claim evidence. No writes were made.
- Provider schema now requires nonempty evidence, and one repair feedback lists
  all invalid evidence and coverage relationships. Prompt clarifies the exact
  bidirectional citation/coverage rule; no semantic content is silently repaired.
- Full read-only dry run on `7c77711` still failed coverage after two extraction
  calls. Do not merge or deploy that checkpoint as a proven production fix.
- Rechecked active branches before expanding into the API transport: no overlap.
  Next change groups model claims under exact current source segment keys and
  derives citation/coverage bookkeeping; the flat handler/core API stays stable.
- Implemented source-keyed provider transport with shared definitions, full
  local validation, deterministic flattening and citation/coverage derivation.
  Empty uncited groups still need justified non-claim classifications; omission
  and unsupported assertions remain subject to independent semantic review.
- Grouped read-only run on `55c6976` passed structural validation but needed
  semantic extraction repair, then hit HTTP 429 at review. No commit or queue
  attempt occurred. A subsequent minimal API probe succeeded (200), not a
  persistent credential/quota failure.
- Simplified each group to an exclusive schema choice: nonempty claims OR a
  justified non-claim classification. Claims no longer carry irrelevant
  non-claim metadata. Current edits require another verified full dry run.

## Decisions and invariants

- Preserve nano models, source citations, immutable claims, review, RLS, fenced
  commits, and queue attempt history. Do not blindly retry the queue.
- Inspect the coverage mismatch and provide actionable repair feedback; do not
  silently reclassify uncited material or fabricate supporting citations.
- A model-authored claim group explicitly identifies its primary evidence.
  Empty groups require a model-authored non-claim disposition and explanation;
  mandatory semantic review must still detect omitted durable assertions.

## Verification

- Focused tests: 17 passed, including repair completeness and fail-closed behavior.
- Final full PostgreSQL-backed check: 254 passed, zero skipped. Coverage 95.70%
  lines, 86.29% branches, 94.34% functions.
- Audit: zero vulnerabilities. Docker build and disabled startup passed.
- Grouped transport focused tests: 22 passed. Full PostgreSQL-backed check
  passed, zero skipped; coverage 95.74% lines, 86.50% branches, 94.38% functions.
- Grouped Docker build and disabled startup passed. Full real-ledger read-only
  dry run is started on this checkpoint; do not interrupt it with a main merge.
- Exclusive-group final check: 259 passed, zero skipped. Coverage 95.75% lines,
  86.58% branches, 94.38% functions; Docker build and disabled startup passed.
- Current read-only verification permits the library's bounded maximum of three
  calls per stage (initial call, repair, transient retry); actual production
  settings remain two until this experiment is verified. Queue history unchanged.
- Exclusive-group dry run reached 19 extracted claims but failed `required_text`
  after three calls. Required claim text and exclusion reasons are now nonempty
  provider patterns, matching the core validator; repair feedback names empty
  fields. Full final validation is being rerun before another no-write test.
- Nonblank-schema final check: 260 passed, zero skipped; coverage 95.76% lines,
  86.61% branches, 94.39% functions. Docker build and disabled startup passed.
- CodeRabbit accepted the corrected handoff and withdrew its foreign-evidence
  repair finding after verifying schema rejection and regression coverage.

## Remaining work

1. Finish the full real-ledger read-only dry run of grouped extraction.
2. Address applicable review findings and pass required PR checks on the final head.
3. Merge, verify one bounded queue attempt, then resume continuous rollout.

## Risks or blockers

- The failed source has consumed two of five queue attempts; preserve history.
- No raw failed proposals are persisted. Diagnostic inference is bounded.
