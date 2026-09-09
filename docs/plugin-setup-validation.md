# Plugin-only setup replacement validation — 2026-09-09

PR #9 replaces compulsory repository CLI enrollment with the installed Synapse
plugin's opt-in setup skill and short-lived helpers. No production migration,
deployment, merge, or marketplace release was performed for these checks.

## Passed

- Full serialized coverage gate with a fresh disposable PostgreSQL 17 database:
  **203 tests passed**, zero failures/skips; line coverage 94.99%, branch 84.05%,
  function 94.17%. Existing memory, queue ordering, temporary/permanent task-ID
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
