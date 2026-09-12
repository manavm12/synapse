# Handoff: Windows test-suite fixes

- Branch: `claude/windows-test-fixes`
- Human owner: `Shobhit Goel`
- Active agent: `unassigned`
- Base reviewed: `0aad6a1`
- Last checkpoint: `f0d30bd`
- Status: `ready-for-review`

## Goal

Get `npm test` fully green on native Windows (no WSL). Started at 197/234 pass,
28 failures. No production/live changes; local dev-environment parity only.

## File ownership

- `plugins/synapse/lib/app-tools-client.mjs`
- `scripts/lib/local-plugin-install.mjs`
- `scripts/validate-plugin.mjs`
- `src/server/consent.mjs`
- `src/server/messaging/receiver.mjs`
- `test/client/app-tools-client.test.mjs`
- `test/client/hook.test.mjs`
- `test/client/setup.test.mjs`
- `test/plugin/local-install.test.mjs`
- `test/plugin/memory-store.test.mjs`
- `test/plugin/setup.test.mjs`
- `test/server/worker-operations.test.mjs`

## Completed

**Result: 219 pass / 0 fail / 16 skipped**, from a starting point of
197 pass / 28 fail / 9 skipped. Two commits:

`d878470` -- fixed 19 of the 28 original failures with real cross-platform
bug fixes (wrong Node API for the platform, not workarounds), plus one
environment-gated skip:

- `appToolsPipePath()` used platform-dependent `path.resolve()` on a value
  that's always a POSIX socket path or an opaque Windows pipe string; switched
  to `path.posix.resolve()` with a passthrough for `\\.\pipe\` strings.
- `consent.mjs` / `messaging/receiver.mjs`: three `res.sendFile()` calls used
  a raw `file://` URL `.pathname` (keeps the leading slash + percent-encoding
  on Windows); fixed with `fileURLToPath()`.
- `validate-plugin.mjs` / `local-plugin-install.mjs`: two containment checks
  used `target.startsWith(root + "/")`, which never matches on Windows
  (backslash-separated resolved paths); replaced with `path.relative()`-based
  checks. `local-plugin-install.mjs`'s bundle key-building also switched to
  `path.posix.join()` so keys compare correctly against hardcoded
  forward-slash literals elsewhere in the same file (fixed 10 of 11 failures
  in `local-install.test.mjs` with this one change).
- `worker-operations.test.mjs`: a `file://` URL `.pathname` was passed
  directly to `spawnSync`; fixed with `fileURLToPath()`.
- `setup.test.mjs`: a native-resolved Windows path was passed to dynamic
  `import()` in a child process (`ERR_UNSUPPORTED_ESM_URL_SCHEME`); fixed
  with `pathToFileURL(...).href`.
- `app-tools-client.test.mjs` / `hook.test.mjs`: fake IPC test servers
  listened on a Unix-domain-socket file path; Windows needs a named pipe in
  the `\\.\pipe\` namespace instead. Both now branch on `os.platform()`.
- `local-install.test.mjs`: one sub-scenario needs `fs.symlink`, which
  requires elevated/Developer Mode privilege on Windows. Wrapped in a
  try/catch that calls `t.skip(...)` with a clear reason only on
  `EPERM` + `win32`; the two non-symlink assertions in that same test still
  run and are verified everywhere.

`f0d30bd` -- after presenting the remaining 9 as one POSIX-only cluster, the
user explicitly chose: keep today's product scope (these features stay
macOS/Linux-only for now; do not build Windows equivalents in this branch).
Added explicit, clearly-labeled skips for exactly that scope, nothing wider:

- `/bin/sh`-dependent tests (`run-node.sh`, `run-dispatch.sh` launchers,
  5 tests across `setup.test.mjs` and `hook.test.mjs`): skip via `test()`
  options with a shared `needsPosixShell` reason string.
- Shebang-execution fixture (`setup.test.mjs:105`, relies on the OS honoring
  `#!`): skip via `test()` options.
- SIGTERM delivery/reporting (`setup.test.mjs`, Windows has no real POSIX
  signal semantics): skip only that one case inside its loop via
  `t.diagnostic()` + `continue`; the `process.exit(7)` and nonexistent-binary
  cases in the same test still run everywhere.
- Exact `0600` mode-bit assertions (`setup.test.mjs`, `memory-store.test.mjs`
  -- Windows has no POSIX permission-bit model): guard just the assertion
  with `t.diagnostic()`, leaving the rest of each test's coverage intact.

Every skip has a real, printed reason (`t.diagnostic` or the `test()` skip
message) -- none are silent, and none touch macOS/Linux behavior.

## Decisions and invariants

- Fix path/URL/IPC-address handling to be genuinely cross-platform (works
  identically on macOS/Linux, becomes correct on Windows) rather than
  papering over failures with skips, EXCEPT where the underlying capability
  itself is platform-gated by the OS (Windows symlink privilege, POSIX
  permission bits, POSIX signals) or by today's explicit product scope
  (`/bin/sh` launchers, shebang execution) -- there, skip explicitly with a
  stated reason, never silently.
- User-confirmed scope decision (see below): the POSIX-only cluster stays
  skipped on Windows for now. Building real Windows equivalents (a
  `.cmd`-based launcher, `taskkill`-based termination reporting, ACL-based
  file protection) is explicitly a separate, later initiative -- not started
  here, and not implied by anything in this branch.

## Scope note for future cross-platform work

The user separately stated the *product* itself (not just the test suite)
should eventually support any OS pairing (Windows<->Windows, Windows<->Mac,
Mac<->Linux, etc. -- sender and receiver independently on any OS). That is a
much larger initiative (credential storage without Keychain, an IPC transport
per OS, hook-script portability, and whether Codex desktop itself even runs
on non-macOS) and was intentionally kept out of this branch. If that work
starts, the 4 skip sites added in `f0d30bd` (grep `needsPosixShell`,
`needsPosixShebangExecution`, `needsPosixSignalDelivery`, and `0o600` in the
touched test files) are the exact list of scenarios to revisit first.

## Verification

- `npm run lint` -- passed
- `npm run format:check` -- passed
- `npm test` (no `TEST_DATABASE_URL`) -- 219 pass / 0 fail / 16 skipped
  (9 pre-existing SQL-suite skips + 1 symlink-privilege skip + 6 POSIX-only
  skips added in `f0d30bd`; started at 197 pass / 28 fail / 9 skipped)
- No `TEST_DATABASE_URL` configured in this environment; the 9 SQL suites
  were already skipped before this workstream and remain unexercised by it.

## Remaining work

1. Open a PR for this branch (`claude/windows-test-fixes` -> `main`) and get
   `CI / verify` + `Security / secrets` passing (CI runs on Linux with
   `TEST_DATABASE_URL` set, so it will additionally exercise the SQL suites
   this environment could not).
2. If/when the larger cross-platform-product initiative starts, see "Scope
   note" above for the exact resume points.

## Risks or blockers

- None currently blocking. CI (Linux) has not yet run this branch; expect it
  to pass since none of these changes alter POSIX-path behavior, but confirm
  before merging.
