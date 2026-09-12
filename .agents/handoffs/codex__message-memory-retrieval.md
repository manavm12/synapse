# Handoff: message memory retrieval experiment

- Branch: `codex/message-memory-retrieval`
- Human owner: `Manav Mehta`
- Active agent: `Codex`
- Base reviewed: `bf48aeca50cf64c3c2737c89afafeb714e6338`
- Last checkpoint: `e11266c`
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
- Full repository checks passed 272 tests with disposable PostgreSQL; audit clean.
- Development runs exposed schema aliasing and premature/overbroad selection.
  Corrected independent schemas, typed actions, first-step planning, full status
  metadata, graph neighbors, compact wire handles, and configurable reasoning.
- Retained all failed runs and charges. Latest complete v3 comparisons: hybrid
  nano 84.38% recall; mini graph 88.54%. Neither meets all gates.
- Added integration boundary and experiment audit documents. New smoke runs are
  evaluating v6 before further full development comparisons.

## Decisions and invariants

- Trusted recipient project scope; immutable evidence; original messages preserved.
- Fail open with an explicit context gap. Six model calls, twelve read actions,
  30-second deadline and 8 KiB injected context by default.
- USD 3 development and USD 2 final evaluation, cumulative across restarts.
- Synthetic fixtures only; no production writes or real messages.
- Keep experiments separate from active messaging/organizer workstreams.

## Verification

- Latest focused suite: 24 passed. Previous SQL round-trip passed; final full check pending.
- Biome checks passed after formatting.
- Lexical baseline: 50.05% required recall, 16.29% precision, no abstention.
- Initial nano agent: 52.86% required recall, 47.51% precision; gates not met.
- Approximately USD 0.33 charged/reserved in development; consult the durable ledger for current spend. No held-out calls yet.

## Remaining work

1. Finish development comparisons and freeze finalist configurations.
2. Evaluate held-out cases, repeat selected configuration, and report unmet gates.
3. Tighten benchmark status/scope validation and finish independent boundary tests.
4. Run final fresh-Postgres checks, preserve concise results, commit/push and open PR.

## Risks or blockers

- Quality gates may remain unmet; budget exhaustion is not a quality pass.
- Existing ledger adapter loads full project history; measure scale explicitly.
