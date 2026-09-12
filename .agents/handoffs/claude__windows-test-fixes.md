# Handoff: Windows test-suite fixes

- Branch: `claude/windows-test-fixes`
- Human owner: `Shobhit Goel`
- Active agent: `unassigned` (paused for a user scope decision)
- Base reviewed: `0aad6a1`
- Last checkpoint: `d878470`
- Status: `blocked` (needs user/product decision, see below)

## Goal

Get `npm test` fully green on native Windows (no WSL). Started at 197/234 pass,
28 failures. No production/live changes; this was scoped as local
dev-environment parity only -- see "Scope note" below for how that scope was
tested by later conversation.

## File ownership

- `plugins/synapse/lib/app-tools-client.mjs`
- `scripts/lib/local-plugin-install.mjs`
- `scripts/validate-plugin.mjs`
- `src/server/consent.mjs`
- `src/server/messaging/receiver.mjs`
- `test/client/app-tools-client.test.mjs`
- `test/client/hook.test.mjs`
- `test/plugin/local-install.test.mjs`
- `test/plugin/setup.test.mjs`
- `test/server/worker-operations.test.mjs`
- Not yet touched, in scope if this resumes: `plugins/synapse/hooks/run-dispatch.sh`,
  `plugins/synapse/scripts/run-node.sh`, `src/client/setup.mjs` (see remaining work)

## Completed

Commit `d878470` fixed 19 of the 28 original failures (197->216 pass) plus added
one honest environment-gated skip, with root causes, not workarounds:

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

## Decisions and invariants

- Fix path/URL/IPC-address handling to be genuinely cross-platform (works
  identically on macOS/Linux, becomes correct on Windows) rather than
  papering over failures with skips, EXCEPT where the underlying capability
  itself is platform-gated by the OS (Windows symlink privilege) or by
  today's product scope (see below) -- there, skip explicitly with a stated
  reason, never silently.
- Every fix above is a real bug (wrong Node API for the platform), verified
  by running the affected file before and after. None of them change any
  macOS/Linux runtime behavior -- confirmed by full local suite passing at
  the same count before and after the format pass.

## Scope note -- read before resuming

Original scope explicitly excluded macOS/Keychain-specific receiver code.
Partway through, the user separately stated the *product* itself (not just
the test suite) should eventually support any OS pairing (Windows<->Windows,
Windows<->Mac, Mac<->Linux, etc. -- sender and receiver independently on any
OS). That is a much larger, separate initiative (credential storage without
Keychain, an IPC transport per OS, hook-script portability, and whether Codex
desktop itself even runs on non-macOS) and was intentionally NOT started
here -- it needs its own scoped workstream and design discussion, not to be
folded into this bug-fix branch.

This branch paused at exactly the boundary between "portability bug in code
that should behave identically everywhere" (fixed, see above) and "feature
that is currently POSIX/macOS-only by product design" (the remaining 9
failures, all below). Whoever resumes must get an explicit answer from the
user on how to treat the remaining cluster before touching it -- do not
assume either direction.

## Remaining work

The remaining 9 failures are one cluster, not nine separate bugs: they all
depend on a real POSIX shell or POSIX process semantics that Windows has no
built-in equivalent for.

1. `test/plugin/setup.test.mjs:141,344,389,450` and
   `test/client/hook.test.mjs:215` -- all `spawn(Sync) /bin/sh ENOENT`.
   These execute `plugins/synapse/scripts/run-node.sh` or
   `plugins/synapse/hooks/run-dispatch.sh` via a hardcoded `/bin/sh`. This is
   genuine production hook/launcher infrastructure (not test-only).
2. `test/client/setup.test.mjs:105` ("real login streams its URL...") --
   writes a fake `codex` executable with a `#!${process.execPath}` shebang
   and relies on the OS honoring it via PATH lookup. Windows does not execute
   shebang files directly; this is a POSIX-only test technique, and it's
   unclear whether real production `desktopCodex()`/`runCommand` invocation
   has the same assumption or whether it's only this fixture that's POSIX-only.
3. `test/client/setup.test.mjs:193` ("interactive runner propagates exit,
   signal...") -- expects `/stopped by SIGTERM/` after
   `process.kill(pid, "SIGTERM")`; Windows has no real POSIX signal delivery,
   so the child observes a plain exit instead. Need to decide whether the
   production code's signal-handling message should become platform-aware,
   or whether this test scenario is POSIX-only.
4. `test/plugin/setup.test.mjs:223` and `test/plugin/memory-store.test.mjs:72`
   -- both assert `(await stat(path)).mode & 0o777 === 0o600`. Windows'
   filesystem has no POSIX permission-bit model; `fs.chmod`/mode-on-create
   cannot produce a real `0600` there (Node reports something like `0o666`
   regardless). Achieving equivalent "owner-only" protection on Windows would
   need actual ACL manipulation (e.g. via `icacls`), which is a real security
   feature, not a test fix -- do not fake the assertion to pass.

Next step for whoever resumes: get an explicit decision from the user on
each of the 4 items above -- e.g. (a) skip the exact scenario on non-POSIX
platforms with a clear comment citing this handoff, keeping today's
macOS-only product scope, vs (b) treat one or more as the first slice of the
larger cross-platform initiative and design a real Windows equivalent
(a `.cmd`-based launcher, `taskkill`-based termination reporting, ACL-based
file protection). These are different amounts of work and different product
commitments -- do not pick for the user.

## Verification

- `npm run lint` -- passed
- `npm run format:check` -- passed (after `npm run format` normalized 3 files)
- `npm test` (no `TEST_DATABASE_URL`) -- 216 pass / 9 fail / 10 skipped
  (9 pre-existing SQL-suite skips + 1 new symlink-privilege skip; started at
  197 pass / 28 fail / 9 skipped)
- No `TEST_DATABASE_URL` configured in this environment; SQL suites remain
  untouched/unexercised by this workstream.

## Risks or blockers

- Blocked on a user decision (see "Scope note" and "Remaining work" above)
  before any of the remaining 9 failures should be touched.
- No `TEST_DATABASE_URL` configured yet in this environment, so the 9
  pre-existing SQL-suite skips are unchanged and out of this workstream's
  goal unless one starts hiding a real cross-platform bug.
