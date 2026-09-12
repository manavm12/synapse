# Handoff: message memory retrieval experiment

- Branch: `codex/message-memory-retrieval`
- Human owner: `Manav Mehta`
- Active agent: `Codex`
- Base reviewed: `bf48aeca50cf64c3c2737c89afafafeb714e6338`
- Last checkpoint: `uncommitted`
- Status: `active`

## Goal

Implement the approved retained local recipient-memory retrieval prototype,
compare lexical, agent, and hybrid strategies within USD 5 total, and document
the later messaging integration. Production remains untouched.

## File ownership

- `experiments/message-retrieval/` (new isolated implementation, fixtures, tests,
  reports, and documentation).
- This handoff only.

## Completed

- Fetched origin; inspected current main, worktrees, all remote diffs and handoffs.
- Created the dedicated worktree from current main. No active ownership overlap.
- Read the retrieval, organizer, receiver and reference-task implementation.
- Built 204 claims / 31 sources / 80 mock messages and retained source fixtures.
- Implemented bounded retrieval, hybrid indexing, prompt injection, durable spend
  reservations, native delivery test doubles, and PostgreSQL round-trip tests.
- First live development run exposed ambiguous action IDs; v2 constrains IDs and
  gap codes, and adds bounded topic labels. Agent/hybrid comparisons are running.

## Decisions and invariants

- Trusted recipient project scope; immutable evidence; original messages preserved.
- Fail open with an explicit context gap. Six model calls, twelve read actions,
  30-second deadline and 8 KiB injected context by default.
- USD 3 development and USD 2 final evaluation, cumulative across restarts.
- Synthetic fixtures only; no production writes or real messages.
- Keep experiments separate from active messaging/organizer workstreams.

## Verification

- 22 focused tests including disposable PostgreSQL: passed, zero skipped.
- Biome checks passed after formatting.
- Lexical baseline: 50.05% required recall, 16.29% precision, no abstention.
- Initial nano agent: 52.86% required recall, 47.51% precision; gates not met.
- API spending at the first full checkpoint: USD 0.02085; budget preserved.

## Remaining work

1. Build corpus, retrieval agent, persistent budget and mock delivery harness.
2. Run engineering/Postgres checks and real bounded API comparisons.
3. Preserve results, integration handoff, and push the final branch for review.

## Risks or blockers

- Quality gates may remain unmet; budget exhaustion is not a quality pass.
- Existing ledger adapter loads full project history; measure scale explicitly.
