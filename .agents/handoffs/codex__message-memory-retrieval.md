# Handoff: message memory retrieval experiment

- Branch: `codex/message-memory-retrieval`
- Human owner: `Manav Mehta`
- Active agent: `Codex`
- Base reviewed: `bf48aeca50cf64c3c2737c89afafeb714e6338`
- Last checkpoint: `1a6606c`
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

- Created isolated worktree from current main; production files remain untouched.
- Built and retained 204 claims / 31 source revisions / eight topics / 80 messages.
- Added exact JSON sources, authored proposals, messages, and gold definitions.
- Implemented typed subject/scope/aspect planning, bounded topic and relation
  navigation, source fallback, graph and hybrid candidates, verified rendering,
  durable budget accounting, prompt freezing, and offline decision replay.
- Corrected schema aliasing, action ambiguity and broad candidate selection.
  All failed development trials and costs remain in ignored local state.
- Development v9: mini graph passes every gate (96.875% recall and completeness,
  91.833% macro precision, 100% abstention, zero integrity violations).
- Nano graph and nano hybrid fail development gates. Mini graph was selected
  before held-out evaluation; SELECTION.json records the choice and freeze.
- All four v9 development runs replayed to 160 identical prompts without API calls.
- Frozen held-out comparisons are running. Do not tune retrieval using those results.

## Decisions and invariants

- Trusted recipient project scope; immutable evidence; original messages preserved.
- Fail open with an explicit context gap. Six model calls, twelve read actions,
  30-second deadline and 8 KiB injected context by default.
- USD 3 development and USD 2 final evaluation, cumulative across restarts.
- Synthetic fixtures only; no production writes or real messages.
- Keep experiments separate from active messaging/organizer workstreams.

## Verification

- Latest focused suite: 36 passed. Full check: 287 passed, zero skipped, including disposable PostgreSQL; coverage 95.68% lines / 86.63% branches / 94.20% functions. Audit: zero vulnerabilities.
- Biome checks passed after formatting.
- Lexical baseline: 50.05% required recall, 16.29% precision, no abstention.
- Initial nano agent: 52.86% required recall, 47.51% precision; gates not met.
- USD 0.931534357 development charged/reserved before final runs. USD 2 final reserve is separate; consult the durable SQLite ledger for current spend.

## Remaining work

1. Finish frozen held-out controls and mini evaluation; repeat mini once.
2. Report each run independently, actual prompt differences, failures, cost and limits.
3. Update integration handoff and push final results for review.

## Risks or blockers

- Synthetic dev success may not transfer to held-out or real recipient graphs.
- A failed repeat or held-out run must remain visible; do not declare success.
- Existing ledger adapter rebuilds project history; large-project scaling is unproven.
- Transport is an isolated Responses-style client because the existing organizer
  adapter is coupled to extract/reconcile/review stages and an active workstream.
- Runtime/config, ledger, corpus and benchmark are frozen at SELECTION.json's hash.
