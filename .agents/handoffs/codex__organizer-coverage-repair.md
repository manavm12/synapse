# Handoff: organizer evidence coverage repairs

- Branch: `codex/organizer-coverage-repair`
- Human owner: `Manav Mehta`
- Active agent: `Codex`
- Base reviewed: `bf48aeca50cf64c3c2737c89afafafeb714e6338`
- Last checkpoint: `55c69763c2d9d7a2b768452986462510211fdc82` (tested grouped implementation)
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

## Remaining work

1. Finish the full real-ledger read-only dry run of grouped extraction.
2. Address applicable review findings and pass required PR checks on the final head.
3. Merge, verify one bounded queue attempt, then resume continuous rollout.

## Risks or blockers

- The failed source has consumed two of five queue attempts; preserve history.
- No raw failed proposals are persisted. Diagnostic inference is bounded.
