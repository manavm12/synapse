# Plugin-only setup replacement validation — 2026-09-09

PR #9 replaces compulsory repository CLI enrollment with the installed Synapse
plugin's opt-in setup skill and short-lived helpers. No production migration,
deployment, PR merge, or marketplace release was performed for these checks.

## Plugin-level follow-up after the live receiver failure

The local repair exposed gaps not covered by the original smoke tests: enrollment
could be reported ready without proof of current hook execution, and a missed
child startup hook left an accepted temporary task ID unreconciled. The earlier
manual binding/receipt repair is **not** evidence that clean installation works.

The plugin now persists bounded, local prompt-hook receipts by task and exact
installed build. Setup/status return `hooks_pending` until a recent matching hook
is observed, preserve healthy enrollment/destinations, and give the explicit Codex
trust/fresh-task step instead of falling back to repository CLI setup. The real
hook writes receipts; setup's immediate check cannot manufacture one. First-use
guidance links directly to the installed skill when skill discovery is stale.

Accepted cloud jobs now have a parent-side reconciliation path independent of the
child startup hook. It treats Codex's read-only client-ID map only as a candidate,
then verifies native delegation provenance, source task, delivery marker, local
host and worktree ancestry. Unknown formats, duplicates, mismatches and uncertain
mutations remain fenced. Same-check outbox flushing performs no additional claim.
Large task prompts have a leading local receipt because real `read_thread` output
is capped at 20,000 characters. Identical remote project paths cannot override the
local receiving project.

Validation of this follow-up:

- Fresh disposable PostgreSQL 17 full gate: **215 passed**, zero failures/skips;
  **95.21% lines / 84.52% branches / 94.22% functions**.
- Installed-bundle isolation with no system Node/npm: the actual hook entrypoint
  creates its receipt; the setup helper does not. Old-build and different-task
  receipts do not produce ready. Existing enrollment/credentials are reused.
- Missed startup, delayed IDs, restart, concurrent prompts, native API errors,
  cancellation, large truncated task output, wrong provenance/project, corrupt or
  duplicate aliases, and uncertain-response fencing have regressions.
- Real HTTP/MCP/Postgres flow now exercises temporary native acceptance followed
  by verified reconciliation and durable provisioning/delivered receipts. Native
  API/Keychain/auth are explicit doubles in this integration test.
- The compatibility adapter and delegation verifier successfully read the real
  previously created Codex task using Codex's supplied Node; **read-only**, no
  task creation or binding/receipt mutation. This live check caught and corrected
  the API's output-size constraint absent from the initial mocks.
- Plugin/skill validators, bundle import isolation, formatting, lint, diff checks,
  and dependency audit pass. Tests use isolated state; no user queue/credentials
  were changed to make these regressions pass.
- Reinstalled bundle **0.3.0+codex.20260909074709** from the updated PR source.
  The native tool-catalog preflight and saved-project resolver were also checked
  against the live desktop API. Hook trust was not modified or bypassed.

The original independent reviews below predate this follow-up. Clean-Mac live
installation, actual scheduler invocation after hook review, and recipient-accessible
marketplace distribution remain release gates. The historical plugin downgrade's
cause has not been established; build-specific readiness detects a stale running
installation but does not claim to repair Codex's plugin cache lifecycle.

## Passed

- Full serialized coverage gate with a fresh disposable PostgreSQL 17 database:
  **205 tests passed**, zero failures/skips; line coverage 94.95%, branch 84.15%,
  function 94.14%. Existing memory, queue ordering, temporary/permanent task-ID
  reconciliation, native uncertainty fencing, RLS, and migration tests remain green.
- Real HTTP/MCP/PostgreSQL flow: authenticated identity → bound pairing → reject
  wrong-account approval despite identical alias → complete → confirmed import →
  one native delivery → durable receipt. Auth verification, Keychain, and native
  delivery are explicit doubles in that fixture, not live OAuth/native claims.
- Real HTTP regression for prepare → disable before a cloud pairing exists;
  expired receiver cannot claim but can disconnect through the revoke-only endpoint.
- Setup tests cover first-offer/deferral/manual enable, hash-only output, interrupted
  Keychain creation, same-origin/path validation, mismatched IDs, stale/revoked/expired
  authorization, transient availability, five-minute deadline mechanics, cancellation,
  shared lifecycle leases, newline-delimited helper input, and reinstall preservation.
- Global dispatch tests cover unrelated/projectless/worktree trigger directories,
  one saved destination, overlap, marker suppression, at most one attempt, legacy
  local-queue isolation, and no replay of uncertain mutations.
- Actual Codex-supplied Node v24.19.0 resolved this worktree to its saved parent via
  the real native `list_projects` tool and supports `node:sqlite`.
- Actual macOS Keychain set/read/delete round-trip through the supplied runtime;
  the uniquely named disposable credential was removed, with no secret printed.
- Installed plugin `0.3.0+codex.20260909064308`: all six hook commands and the setup
  helper executed from the plugin cache, outside the checkout, with no Node/npm on
  PATH and isolated local databases. Exactly one first-use offer was emitted; no
  account was enrolled by the smoke check.
- Plugin and skill validators, bundle import-isolation validation, formatting/lint,
  `git diff --check`, and dependency audit (zero vulnerabilities).
- Incorporated main's `a5a3668` cross-browser authentication fix into the feature
  branch to remove its documentation conflict; retained both email-link safeguards
  and plugin-first setup guidance. The full coverage gate above includes this update.

## Independent review

Correctness, security, and test/UX reviewers checked the replacement. Recovery
findings prompted unpublished-credential state, definitive-absence cleanup,
shared project leases/local-first disable, transient-status classification,
newline helper input, and a 25-second internal dispatch budget under the 30-second
hook timeout, serialized schema migration, and an atomic stop-before-issue fence.
Final re-review reported no actionable findings; 67 focused regressions passed.
Regression tests cover the fixes. The prior expiry-auth finding was
withdrawn: expired credentials were already intentionally supported for revocation.

## Still required before release

Apply `202609090001_bound_receiver_setup.sql`, then deploy the matching authenticated
`begin_receiver_setup` MCP tool and browser behavior **before** distributing the
plugin. Keep production rollout/merge separate from preparing this replacement PR.

Run the central clean-Mac real-user acceptance test after deployment: install only
the plugin, sign in, accept setup, trust hooks, approve in the browser, receive a
message, and verify exactly one native task in the chosen project. This must also
verify skill discovery and automatic hook invocation in a fresh Codex task. Manual
installed-command smoke tests and mocked-native composition do not substitute for
that live gate. Publishing an accessible marketplace is a separate rollout action.
