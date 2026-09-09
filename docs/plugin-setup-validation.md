# Plugin-only setup replacement validation — 2026-09-09

PR #9 replaces compulsory repository CLI enrollment with the installed Synapse
plugin's opt-in setup skill and short-lived helpers. No production migration,
deployment, PR merge, or marketplace release was performed for these checks.

## Current review-fix gate

### Local install identity repair — 2026-09-09

Live diagnosis found both checkouts advertising `synapse@synapse`. At 08:59:01 UTC,
the installed cache was replaced with the other checkout's September 8-based
bundle, including its unique uncommitted conversation files, alongside a desktop
plugin refresh. A successful immediate setup delivery had concealed the later
loss of the new setup skill and prompt hooks. This is not a credential-expiry fix.

`npm run install:plugin` now builds an immutable snapshot outside Git, under a
checkout-specific `synapse-dev-…` marketplace. It verifies the installed identity,
version, source and actual cached bytes before optionally retiring this checkout's
legacy ID. Updates preserve prior snapshots; unrelated installations are rejected.
Repository setup refuses to reintroduce the old ID beside an isolated install.
No receiving state, Keychain item, hook trust, server code, or delivery logic changes.

The client/plugin gate passed **137 tests**, zero failures/skips, including new
identity/snapshot isolation, symlink/alias validation, cache integrity, conflict
preservation, failed-install behavior, and repository-setup regressions. Existing
ten-turn memory and delivery fencing tests pass. Both plugin validators pass.
This focused gate does not claim a new full PostgreSQL/coverage run.

Installed local build `0.3.0+codex.20260909091049` as
`synapse@synapse-dev-e058c040e5a7`. A fresh desktop-matching app-server process
listed plugins with **each** competing checkout supplied in `cwds`; only the new
ID remained installed/enabled, and cached bytes still matched the snapshot after
both refreshes. `skills/list` discovered the installed setup skill, and
`hooks/list` discovered all six hooks from the new cache. They correctly report
**untrusted** for the new identity. No trust was copied or bypassed. Native delivery
after user approval, another prompt and a full app restart remains to be tested;
installation success is not a claim that receiving is ready.

### Previous full database gate

The 2026-09-09 review-fix run passed **222 tests**, with zero failures or skips:
**95.32% lines / 84.97% branches / 94.24% functions**. This is whole-suite Node
test discovery with serialized execution and all database-dependent tests enabled,
including a fresh PostgreSQL 17 database and isolated per-test databases. Auth,
Keychain and native task creation remain explicit doubles in integration tests.

Command run from the PR worktree using Codex's supplied Node v24.19.0 (substitute
a fresh disposable database URL for the local test URL):

```sh
TEST_DATABASE_URL=<fresh-local-postgres-url> DATABASE_SSL=disable \
  "$CODEX_MCP_NODE_PATH" --test --test-concurrency=1 \
  --experimental-test-coverage \
  --test-coverage-exclude=scripts/migrate.mjs \
  --test-coverage-exclude=src/server/database.mjs \
  --test-coverage-lines=85 --test-coverage-branches=70 --test-coverage-functions=90
```

This is the flag set in `npm run test:coverage`; the executable is selected
explicitly to avoid relying on system Node. Coverage includes test files, as
configured by that script; the percentages are not production-code-only coverage.
Historical 182/205/215-test checkpoints below or in coordination notes are not
current release evidence. Earlier runs without a test database likewise do not
establish database coverage.

New regressions cover post-delivery reconciliation failure and cancellation,
authorization-fence failure after the durable issue marker, SQLite writer
contention for setup reads/writes, whitespace/native-null responses, cloud-only
reconciliation, and OAuth state reissue after consumption. The upgrade test first
applies the old migrations and creates pending/approved unbound pairings, then
runs the new migration: pending unbound approval is rejected, already-connected
legacy receivers still authorize/complete/claim, and expired credentials still
disconnect. New bound approvals reject the wrong account despite identical aliases.

Formatting/lint, both plugin validators, bundle import isolation and diff checks
pass. Reinstalled local build `0.3.0+codex.20260909083644`; the desktop-matching
CLI reports it enabled and the cached bundle matches the PR source byte-for-byte.
No receiver reset or manual delivery was performed. These results do not replace
the clean-Mac live release gate below.

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

Historical validation of this follow-up at `f48a09a` (superseded by the current
review-fix gate below; exact historical invocation is not retained here):

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
marketplace distribution remain release gates. The later local install identity
repair above addresses the observed cross-checkout cache collision; build-specific
readiness alone did not prevent that replacement.

## Historical original replacement validation

These results predate `f48a09a` and the review fixes. They describe the earlier
replacement's scope, not the current release gate. The exact historical command
is not reconstructed from the test count.

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

Apply `202609090001_bound_receiver_setup.sql` and the subsequent
`202609090002_require_bound_receiver_approval.sql`, then deploy the matching authenticated
`begin_receiver_setup` MCP tool and browser behavior **before** distributing the
plugin. Keep production rollout/merge separate from preparing this replacement PR.

Run the central clean-Mac real-user acceptance test after deployment: install only
the plugin, sign in, accept setup, trust hooks, approve in the browser, receive a
message, and verify exactly one native task in the chosen project. This must also
verify skill discovery and automatic hook invocation in a fresh Codex task. Manual
installed-command smoke tests and mocked-native composition do not substitute for
that live gate. Publishing an accessible marketplace is a separate rollout action.
