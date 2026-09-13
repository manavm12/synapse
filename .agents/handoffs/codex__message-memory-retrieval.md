# Handoff: message memory retrieval experiment

- Branch: `codex/message-memory-retrieval`
- Human owner: `Manav Mehta`
- Active agent: `Codex`
- Base reviewed: `bf48aeca50cf64c3c2737c89afafafeb714e6338`
- Last checkpoint: `f02ae7faccc4bed092c71245e9dd6fa7f8ad21ce` (tested implementation and reports)
- Status: `ready-for-review`

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
- Frozen mini primary and repeat both pass every gate: 100% recall, completeness
  and abstention; macro precision 92.708% / 90.625%, pooled 86.486% / 83.117%.
  Both have zero citation, tenant, status and scope violations. Nano controls fail.
- Paid trials ended at USD 1.135522518 total, including USD 0.276797151 reserved
  for 41 uncertain development requests. Final phase has no uncertain requests.
- Post-benchmark review fixed markerless-size and transitive-companion boundaries;
  all 360 saved v9 cases replay identically. See RELEASE_VERIFICATION.json.
- Reports, exact prompt comparison, graph inspection, and production integration
  sequence are complete. Actual prompts, caches and the spending ledger remain local.

## Decisions and invariants

- Trusted recipient project scope; immutable evidence; original messages preserved.
- Fail open with an explicit context gap. Six model calls, twelve read actions,
  30-second deadline and 8 KiB injected context by default.
- USD 3 development and USD 2 final evaluation, cumulative across restarts.
- Synthetic fixtures only; no production writes or real messages.
- Keep experiments separate from active messaging/organizer workstreams.

## Verification

- Full release check: 288 passed, zero skipped, including disposable PostgreSQL; coverage 95.70% lines / 86.73% branches / 94.21% functions. Audit: zero vulnerabilities.
- Biome checks passed after formatting.
- Lexical baseline: 50.05% required recall, 16.29% precision, no abstention.
- Initial nano agent: 52.86% required recall, 47.51% precision; gates not met.
- Final ledger: USD 0.931534357 development + USD 0.203988161 final = USD 1.135522518 charged/reserved out of USD 5.

## Remaining work

- Implementation and experiments are complete. PR: https://github.com/manavm12/synapse/pull/21.
- CI verify, PostgreSQL database checks and both secret scans passed at `f02ae7f`; final documentation-only head should retain those checks.
- Production integration is deliberately separate and owned by the active messaging
  workstream. Follow experiments/message-retrieval/INTEGRATION.md.

## Risks or blockers

- Synthetic success does not establish quality on real recipient graphs.
- Failed nano controls and early development attempts remain visible; do not conflate them with the selected mini result.
- Existing ledger adapter rebuilds project history; large-project scaling is unproven.
- Transport is an isolated Responses-style client because the existing organizer
  adapter is coupled to extract/reconcile/review stages and an active workstream.
- Paid-trial runtime/config, ledger, corpus and benchmark are frozen at SELECTION.json's hash. RELEASE_VERIFICATION.json records the later boundary-only patch and exact replay evidence.


## Remote compatibility review

Fetched before the final commit. Main advanced to `a50f222` (organizer coverage
transport and prompt repair); the deterministic ledger, evidence, relation,
projection and retrieval contracts used here did not change. No changed remote
file overlaps this experiment. Keep the benchmark base at `bf48aeca` and let PR
CI validate the merge; do not rewrite the frozen experiment onto another agent's
branch. Messaging ownership remains with `codex/conversational-messaging`.
