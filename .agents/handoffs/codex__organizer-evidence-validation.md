# Handoff: organizer evidence validation

- Branch: `codex/organizer-evidence-validation`
- Human owner: `Manav Mehta`
- Active agent: `Codex`
- Base reviewed: `0aad6a193276ed98f6e5f8aa2d210d0449aa0ecc`
- Last checkpoint: `0aad6a193276ed98f6e5f8aa2d210d0449aa0ecc` (before implementation)
- Status: `active`

## Goal

Make the authorized production memory organizer rollout complete successfully,
preserving evidence validation, semantic review, queue history, and tenant fencing.

## File ownership

- `src/server/memory-organizer/handler.mjs`
- `src/server/memory-organizer/api.mjs`
- `src/server/memory-organizer/validation.mjs` (new)
- `test/server/memory-organizer.test.mjs`
- `docs/memory-organizer.md`
- This handoff only.

## Completed

- PR14 merged safe incomplete-response diagnostics and exact-revision canaries.
- Production credentials work; six historical jobs were backfilled.
- Rechecked current remote branches and active Windows-test handoff; the known
  Windows path-handling files and documentation work do not overlap this scope.
- A source-only live extraction passed structural validation: 19 claims, five
  segments, no unknown evidence. No database writes or queue attempts consumed.

## Decisions and invariants

- Retain gpt-5-nano, mandatory review, exact source citations, and atomic commits.
- Production continuous mode remains disabled until bounded canaries pass.
- Do not reset attempts, disclose credentials, change RLS, or apply unrelated migrations.
- Failed response/proposal text is not retained. Add fixed validation reason codes
  rather than logging model output or source text.

## Verification

- Earlier PR14: all 245 tests including PostgreSQL passed; CI/security passed.
- Added source-specific evidence/coverage enums, bounded against the provider's
  limits, without mutating shared base schemas or weakening core validation.
- Added allowlisted validation reasons to exhausted repair errors and tests for
  current/prior evidence, foreign IDs, empty catalogs, bounds, and redaction.
- Live full-handler diagnostic on the original capture passed: 22 claims, one
  extraction and one independent review with zero issues; no database writes.
  Usage: 7,923 input and 15,035 output tokens across both calls.
- `npm run check` — passed with fresh disposable PostgreSQL database; no skips.
  The first reused-fixture run failed the schema isolation assertion; no code
  change was needed after rerunning against the required fresh database.
- `npm run audit` — zero vulnerabilities; plugin validation passed.

## Remaining work

1. Complete Docker verification and PR/CI.
2. Merge after CI; run an exact-revision canary, verify durable retrieval, then
   reconciliation and historical backlog before continuous activation.

## Risks or blockers

- Original capture has two consumed queue attempts and no committed graph result.
- Last production failure was extraction validation; local reproduction passed,
  so the exact rejected rule is not yet established.
- Latest unrelated main auto-deployment needs Railway approval; do not confuse a
  pending deployment with a running worker.
