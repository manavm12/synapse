# Handoff: Windows test-suite fixes + real cross-platform investigation

- Branch: `shobhit/windows-test-fixes`
- Human owner: `Shobhit Goel`
- Active agent: `unassigned`
- Base reviewed: `0aad6a1`
- Last checkpoint: `e79f0f9`
- Status: `ready-for-review` (PR #18 open, was green on CI before this commit;
  recheck CI after this commit before merging)

## Goal

Originally: get `npm test` fully green on native Windows (no WSL). That part
is done (219 pass / 0 fail / 16 skipped, from 197/28/9). The goal then
expanded mid-branch: the user confirmed Codex desktop genuinely supports
Windows/Linux now (not just macOS, which is what the repo's docs assumed),
and asked to actually investigate and start building real cross-platform
receiver support, verified against a real installed Codex app rather than
by inspecting code alone. This handoff covers both phases.

## File ownership

- `plugins/synapse/lib/app-tools-client.mjs`
- `plugins/synapse/hooks/hooks.json`
- `plugins/synapse/hooks/run-dispatch.sh`
- `plugins/synapse/skills/setup-synapse/SKILL.md`
- `scripts/lib/local-plugin-install.mjs`
- `scripts/validate-plugin.mjs`
- `src/server/consent.mjs`
- `src/server/messaging/receiver.mjs`
- `test/client/app-tools-client.test.mjs`
- `test/client/hook.test.mjs`
- `test/client/setup.test.mjs`
- `test/plugin/local-install.test.mjs`
- `test/plugin/manifest.test.mjs`
- `test/plugin/memory-store.test.mjs`
- `test/plugin/setup.test.mjs`
- `test/server/worker-operations.test.mjs`

## Completed

### Phase 1 (`d878470`, `f0d30bd`) -- test suite parity

197 pass / 28 fail / 9 skipped -> 219 pass / 0 fail / 16 skipped. Real
path/URL/IPC-address bugs fixed (see prior version of this handoff in git
history for the full per-bug list: `appToolsPipePath` platform-dependent
resolve, `res.sendFile` given a raw `file://` `.pathname`, `startsWith`
containment checks broken by backslash paths, a `file://` `.pathname` passed
to `spawnSync`, a native path passed to dynamic `import()`, Unix-socket test
fixtures needing a Windows named pipe instead, one symlink-privilege skip).
Then, per explicit user decision at that point, 6 remaining POSIX-shell/
signal/permission-bit scenarios were skipped on Windows with stated reasons
(`needsPosixShell`, `needsPosixShebangExecution`, `needsPosixSignalDelivery`,
the two `0o600` checks), reasoning: today's product scope is macOS/Linux-only
for those. PR #18 opened and was green on CI (database/secrets/verify) at
this point.

### Phase 2 (this session, `e79f0f9`) -- the scope was reopened, then verified live

The user then said the product itself should work in any OS combination,
not just be developed on Windows. Before writing any more code, researched
whether that's even possible:

- **Web research**: Codex desktop actually ships for Windows (since March
  2026) and Linux (preview, since August 2026) -- the repo's "Recipients need
  a Mac" claim is outdated, not a current constraint. The Codex
  plugin/marketplace docs explicitly state Windows hook support works via
  Git Bash/Cygwin.
- **Found Codex genuinely installed and running on this Windows dev
  machine** (`OpenAI.Codex` package, `codex.exe`, real `ChatGPT.exe`
  processes, an active `codex-ipc` named pipe). This let every claim below
  be checked against the real app instead of guessed from docs.
- Verified empirically that `spawnSync('sh', ...)` (bare command, not the
  hardcoded absolute `/bin/sh`) resolves correctly via Node's real process
  creation on Windows, because Git for Windows puts `sh.exe` on PATH. This
  matches Codex's own documented Windows support model.
- **Actually installed this plugin build into the real, running Windows
  Codex app** using `SYNAPSE_CODEX_BIN` pointed at the real `codex.exe`
  (`npm run install:plugin`). This is real proof the earlier Phase-1 path
  fixes (`path.posix.join` bundle keys, `path.relative` containment checks)
  work end-to-end against production tooling, not just fixtures.
- That install run surfaced **two more real bugs**, found only because it
  ran against the actual Windows CLI:
  1. Codex reports some paths with the Windows `\\?\` long-path prefix;
     this script's own `resolve()`/`realpath()` calls don't add it, so a
     same-directory `dirname()` comparison spuriously mismatched on a
     second install. Fixed with a `stripLongPathPrefix()` helper applied
     before comparing.
  2. This Windows Codex CLI version (`0.153.4`) omits `marketplaceSource`
     on a later `plugin marketplace list --json` call (only `root` is
     present), so the local-source safety check treated every
     previously-installed dev marketplace as untrusted and refused to
     replace it. Broadened the check: a populated `root` with no
     `marketplaceSource` is itself local-marketplace evidence.
- **Found and fixed the actual `/bin/sh` bug in production code**:
  `hooks.json`'s 5 hook commands and `run-dispatch.sh`'s internal `exec`
  all hardcoded the absolute path `/bin/sh`, which doesn't exist on
  Windows. Changed every one to bare `sh`, letting PATH resolution find the
  right interpreter on any OS (also updated the matching prose in
  `SKILL.md`). Updated the hardcoded-string checks in
  `validate-plugin.mjs` and one assertion in `manifest.test.mjs` to match.
- **Attempted a live end-to-end verification** via `codex exec
  --dangerously-bypass-hook-trust` (a flag the CLI itself documents as
  "intended only for automation that already vets hook sources" -- used
  here because the hook source is this repo, already read in full) in an
  isolated ephemeral temp directory, before and after the `sh` fix.
  **Result: inconclusive, not negative.** Neither run produced a visible
  hook-spawn error in the CLI's own JSONL/stderr output (and errors clearly
  do surface there -- an unrelated MCP OAuth error appeared plainly in both
  runs). But the one observable side effect available without deeper setup
  (a memory-checkpoint file write from `prompt-memory.mjs`) never appeared
  either time, for a reason unrelated to the shell fix: that code path
  requires the target directory to already be a registered git project
  (`findRegisteredProject`, backed by `host.sqlite`), which doesn't exist
  yet on this machine. The test methodology could not distinguish "hook
  failed" from "hook succeeded but had nothing to do." `codex doctor` also
  showed `--ephemeral` runs are disconnected from the real desktop
  app-server daemon entirely, which may itself matter for testing the
  native app-tools pipe specifically (separate from the `sh` question).

## Decisions and invariants

- Fix path/URL/IPC-address/shell-invocation handling to be genuinely
  cross-platform (identical behavior on macOS/Linux, correct on Windows)
  rather than papering over failures with skips, except where a capability
  is genuinely OS-gated (Windows symlink privilege, POSIX permission bits,
  POSIX signals) -- there, skip explicitly with a stated reason.
- The `/bin/sh` -> `sh` fix is justified on its own technical merits
  (matches Codex's documented Windows behavior; verified correct PATH
  resolution via Node's real spawn) even without full end-to-end live proof.
  Do not describe it as "verified working end-to-end on Windows" until a
  properly registered project makes a conclusive test possible -- say
  "fixed and partially verified" instead.
- `--dangerously-bypass-hook-trust` is safe to use for automation that has
  actually read the hook source, per the flag's own documentation. Used
  here deliberately, not as a workaround.
- Do not use `git stash` in this repo's worktree setup (shared stash stack
  across worktrees/sessions); none was needed here.

## Remaining work

1. **Get a fully conclusive live test.** This needs a registered Synapse
   project (`host.sqlite` populated via the real setup/connect flow, or
   directly via `connectProject`) so `getPendingMemoryPrompt` /
   `findRegisteredProject` don't short-circuit before touching anything.
   With that in place, re-run `codex exec --dangerously-bypass-hook-trust`
   (or better, a non-ephemeral run connected to the real running desktop
   app-server, to also exercise the native app-tools pipe) and check for an
   actual `checkpoints.sqlite` row, not just absence of a visible error.
2. **Un-skip the 6 `needsPosix*`/`0o600` test scenarios individually now
   that a real `sh` fix exists** -- not a blanket find/replace:
   - The `/bin/sh`-hardcoded test harnesses (`setup.test.mjs` x4,
     `hook.test.mjs` x1) invoke `/bin/sh` directly rather than through
     `hooks.json`; changing them to bare `sh` is usually right, but one
     test (`setup.test.mjs:148`, "setup helper accepts one JSON line...")
     deliberately restricts `PATH` to `/no-node` to test that Synapse never
     falls back to system Node -- bare `sh` needs PATH resolution, which
     conflicts with that restriction. Needs a platform-aware PATH override
     (include Git's bin dir on Windows, exclude any real Node) rather than
     a plain rename.
   - The shebang-execution test (`setup.test.mjs:105`) fundamentally relies
     on OS-level shebang dispatch, which Windows doesn't have at all; this
     one likely needs a real per-platform fixture (e.g. a `.cmd` stub on
     Windows), not just an invocation change.
   - SIGTERM delivery/reporting and the two `0o600` mode-bit checks are
     genuine OS-model differences (no real POSIX signals or permission bits
     on Windows) -- these likely stay skipped on Windows regardless of any
     Synapse-side fix; revisit only if Windows-side equivalents (ACL-based
     file protection, `taskkill`-based termination) become an actual
     project goal.
3. **The credential-storage question is still fully open**: `MacOsKeychainStore`
   (`plugins/synapse/lib/receiver-secrets.mjs`) explicitly throws on any
   non-darwin platform with "no plaintext fallback is available." A Windows
   equivalent (Credential Manager/DPAPI via a native module or `cmdkey`, or
   Linux Secret Service/libsecret) has not been designed or started.
4. **Whether the native app-tools pipe itself works cross-platform is still
   unverified** -- distinct from the `sh` question. GitHub issues found
   during research describe Windows-specific flakiness in Codex's
   "Computer Use" native pipe subsystem; whether that affects the different
   `codex_app` project/task-management namespace this plugin uses (vs.
   screen-automation) is unknown. Needs the conclusive live test in item 1.

## Verification

- `npm run lint` -- passed
- `npm run format:check` -- passed
- `npm run validate:plugin` -- passed (this validator itself needed 3 of the
  fixes in this commit, since it hardcoded `/bin/sh` in its own checks)
- `npm test` (no `TEST_DATABASE_URL`) -- 219 pass / 0 fail / 16 skipped
  (unchanged from the Phase-1 checkpoint; this phase's fixes touch
  real-Windows-Codex behavior the fixture suite can't exercise, so it
  correctly shows no change in local test counts)
- Live: `npm run install:plugin` succeeded against the real installed
  Windows Codex app after both install-script fixes; `codex plugin list
  --json` confirmed `installed: true, enabled: true` for the resulting
  `synapse@synapse-dev-*` plugin.
- Live: `codex exec --dangerously-bypass-hook-trust` completed successfully
  before and after the `sh` fix, with no visible hook-spawn error in either
  run -- inconclusive as positive proof (see "Completed" above for why), but
  not a negative result either.

## Risks or blockers

- PR #18 was already open and green on CI before this commit (`e79f0f9`).
  Recheck `gh pr checks 18` after pushing this commit before merging --
  CI runs on Linux, so it re-validates none of these Windows-specific
  changes broke POSIX behavior, but cannot itself validate the Windows-side
  claims in this handoff.
- The plugin is currently installed into the user's real, live Windows
  Codex app as `synapse@synapse-dev-81bbd29df3a5` (a disposable dev
  snapshot, not `synapse@synapse`) for this investigation. It does not
  affect their real `synapse@synapse` installation if one exists, but
  leave it in place or remove it deliberately (`codex plugin remove
  synapse@synapse-dev-81bbd29df3a5`) -- don't just forget it's there.
- No production/live server changes were made in either phase.
