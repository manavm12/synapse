# Handoff: Windows test-suite fixes + real cross-platform investigation

- Branch: `shobhit/windows-test-fixes`
- Human owner: `Shobhit Goel`
- Active agent: `Codex` -- implementing the user-authorized cross-platform MVP
  completion pass; do not share this branch/worktree until it is unassigned.
- Base reviewed: `fa57da5`
- Last checkpoint: branch `HEAD`
- Status: `active` -- current main is merged; auditing and implementing the
  remaining Windows/macOS/Linux MVP gates after the verified hook fix.

## START HERE for the next agent

**The Windows hook blocker is resolved.** Do not repeat the metered live
reproduction unless a regression appears. The conclusive findings were:

1. The original bare-`sh` build fails both with and without
   `--dangerously-bypass-approvals-and-sandbox`; sandboxing is not the cause.
2. The interactive TUI reports explicit hook attempts/failures, so hooks are
   not an interactive-only feature.
3. Adding `C:\Program Files\Git\bin` to `PATH` makes the original build's
   unconditional marker appear under `codex exec`. Therefore `codex exec`
   does support plugin hooks on Windows; normal Git for Windows installs put
   `git.exe` on `...\Git\cmd`, not `sh.exe` from `...\Git\bin`.
4. Official Codex hook configuration supports `commandWindows`. Every hook
   now retains its POSIX `command` and has a Windows PowerShell override that
   invokes the Codex-supplied signed Node runtime through `run-node.ps1`.
5. Windows PowerShell 5.1 mangled the original inline JavaScript SQLite
   preflight passed with `-e`. Moving the preflight to `check-runtime.mjs`
   fixed that final quoting issue.
6. With the final build installed, the exact baseline `codex exec` command
   created the unconditional marker on `win32` without a Git-Bash PATH edit
   or sandbox bypass. All diagnostic writes and marker files were removed.

Next agent: review PR #18, recheck CI after this checkpoint, and continue the
remaining cross-platform items below without reopening the resolved hook
execution hypothesis unless new evidence warrants it.

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
- `plugins/synapse/scripts/check-runtime.mjs`
- `plugins/synapse/scripts/run-node.ps1`
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
  isolated ephemeral temp directory, before and after the `sh` fix. Initial
  result looked encouraging (no visible hook-spawn error in the CLI's own
  JSONL/stderr output, which does clearly surface other errors -- an
  unrelated MCP OAuth error appeared plainly in the same runs), but was
  actually inconclusive: the one observable side effect available without
  deeper setup (a memory-checkpoint file write from `prompt-memory.mjs`)
  never appeared either time, for a reason unrelated to the shell fix --
  that code path requires the target directory to already be a *registered*
  git project (`findRegisteredProject`, backed by `host.sqlite`), which
  didn't exist yet, and even then only reads/updates an *existing*
  checkpoint file rather than creating one. The test methodology could not
  distinguish "hook failed" from "hook succeeded but had nothing to do."

### Follow-up in the same session: a conclusive negative result

Registered a real (throwaway, disposable) primary git checkout locally via
`connectProject()` -- this needs no OAuth/cloud, it's a pure local SQLite
write to `host.sqlite` -- to remove the "project not registered" ambiguity.
Re-ran `codex exec` (both `--ephemeral` and non-ephemeral, the latter to
connect to the real desktop app-server per `codex doctor`'s note that
ephemeral mode is disconnected from it) against that registered project.
Still no observable checkpoint write. To eliminate all remaining ambiguity
from Synapse's own business logic, temporarily added an **unconditional**
diagnostic file write at the very top of `prompt-memory.mjs` (before any of
its own gating logic), rebuilt, reinstalled, and re-ran.

**The marker file never appeared. This is a conclusive negative result for
this test surface**: `sh "${PLUGIN_ROOT}/scripts/run-node.sh" "..."` did not
execute successfully via `codex exec --dangerously-bypass-hook-trust` on
this Windows machine, even after the `/bin/sh` -> `sh` fix. The diagnostic
code has been fully reverted (`git diff` confirms `prompt-memory.mjs` is
back to its committed state) -- this was never merged.

One more variable was tested and came back **inconclusive, not negative**:
whether `codex`'s command sandbox (`codex doctor` shows "restricted fs +
restricted network... sandbox backend: elevated" is the default) also wraps
plugin-hook subprocess execution, which could independently block spawning
`sh.exe` regardless of the shell-invocation fix. Ran once with
`--dangerously-bypass-approvals-and-sandbox` added; **the run hit the
account's Codex usage limit before the turn completed**, so this specific
variable remains untested. Live testing was stopped at this point rather
than continuing to spend usage without the user's explicit sign-off on the
cost -- **each `codex exec` call in this investigation is a real,
usage-metered model turn against the account's Codex quota/credits, not a
free local operation.** Whoever resumes should get explicit user
confirmation before running more of these, and should budget for it,
similar to how this repo's own docs treat the $5 live-inference allowance
for the memory organizer as a real, tracked cost.

**Net effect on the earlier optimistic framing**: it was wrong to call the
first round of testing "encouraging." The corrected status is: the `sh` fix
is still justified on its own technical merits (matches Codex's documented
Windows behavior; `sh` demonstrably resolves via Node's own real process
creation on this machine), but it has now been conclusively shown *not* to
be sufficient on its own to make hooks execute via `codex exec` on Windows.
Remaining candidate explanations, untested: (a) the command sandbox also
wraps hook subprocesses and blocks/restricts them independently of the
shell-invocation fix, (b) `codex exec` specifically (a non-interactive,
single-shot command) may not process plugin hooks at all regardless of
platform -- untested whether hooks fire differently through the interactive
TUI or the real desktop app GUI, which were not exercised, (c) some other
Windows-specific Codex hook-execution gap not yet identified.

### Phase 3 (Codex follow-up) -- actual blocker isolated and fixed

Followed the Appendix reproduction literally with the unconditional marker:

- Baseline bare-`sh` run: model returned `PING_OK`; marker absent.
- Same run with `--dangerously-bypass-approvals-and-sandbox`: model returned
  `PING_OK`; marker absent. This ruled out the sandbox hypothesis.
- Interactive TUI: emitted explicit `Hook failed` events, proving the TUI
  attempts plugin hooks.
- `where.exe sh` returned no executable. This machine's normal PATH contains
  `C:\Program Files\Git\cmd` for `git.exe`, while `sh.exe` is under
  `C:\Program Files\Git\bin`. Prepending the latter and rerunning the exact
  `codex exec` command made the marker appear. This proved that `codex exec`
  supports hooks and that bare `sh` PATH resolution was the blocker.
- The official Codex Hooks documentation documents `commandWindows` as the
  Windows-only command override. Added it to all six handlers, backed by a
  new `scripts/run-node.ps1` launcher. The normal `command` stays POSIX.
- A launcher-level trace then showed all Windows handlers were selected and
  received both `CODEX_MCP_NODE_PATH` and expanded plugin paths, but the
  SQLite preflight returned `1`. The cause was Windows PowerShell 5.1 native
  argument quoting mangling the JavaScript supplied through `node -e`.
  Replaced that inline program with `scripts/check-runtime.mjs`.
- Final live run: the exact baseline command (normal sandbox, no Git `bin`
  PATH injection) created `hook-executed-marker.txt` with
  `ran at 2026-09-12T08:07:18.905Z on win32`. The marker code was then
  removed from `prompt-memory.mjs`, and both external diagnostic marker files
  were deleted.

## Decisions and invariants

- Fix path/URL/IPC-address/shell-invocation handling to be genuinely
  cross-platform (identical behavior on macOS/Linux, correct on Windows)
  rather than papering over failures with skips, except where a capability
  is genuinely OS-gated (Windows symlink privilege, POSIX permission bits,
  POSIX signals) -- there, skip explicitly with a stated reason.
- Bare `sh` remains the portable POSIX command, but it is not a sufficient
  Windows strategy because a normal Git for Windows PATH exposes `git.exe`
  from `Git\cmd`, not `sh.exe` from `Git\bin`. Use Codex's documented
  `commandWindows` override and the signed runtime launcher instead.
- `--dangerously-bypass-hook-trust` is safe to use for automation that has
  actually read the hook source, per the flag's own documentation. Used
  here deliberately, not as a workaround.
- **Each `codex exec` invocation spends real, metered usage/credits against
  the connected Codex account.** Treat it like the repo's own tracked
  live-inference budget for the memory organizer: get explicit user
  confirmation before running more of it, and stop immediately if a usage
  limit is hit rather than retrying. This was not flagged clearly enough
  early in this investigation.
- Do not use `git stash` in this repo's worktree setup (shared stash stack
  across worktrees/sessions); none was needed here.
- Temporary diagnostic code added to production hook files for a live test
  must be reverted (verify with `git diff`) before committing/pausing --
  done here for the `prompt-memory.mjs` marker-write experiment.

## Remaining work

1. **Review and merge the proven Windows hook fix.** Recheck PR #18's Linux
   CI after this checkpoint. The registered throwaway project remains at
   `C:\Users\DELL\AppData\Local\Temp\synapse-native-test-repo` under alias
   `synapselivetest`; it is harmless to leave for a future regression test.
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
- Live: both the normal-sandbox and sandbox-bypass runs remained negative
  with bare `sh`; adding Git's `bin` directory made the same exec run create
  the marker, proving `codex exec` hook support and isolating PATH resolution.
- Live: interactive TUI emitted `Hook failed`, independently proving that
  interactive Codex attempts the same plugin hooks.
- Live: the final `commandWindows` + PowerShell launcher + file-based runtime
  preflight build created the unconditional marker on `win32` using the exact
  baseline command, normal sandbox, and normal PATH. Diagnostic code/files
  were removed afterward.
- Direct Windows launcher smoke test with Codex's bundled Node -- exit `0`.
- `npm run check` -- formatting/lint and all 219 tests pass, but the command
  exits nonzero on the repository-wide pre-existing coverage gate: 77.47%
  lines versus the configured 85% threshold (largely skipped Postgres files).

## Risks or blockers

- Windows hook execution now works in the tested Codex CLI/Desktop build
  (`0.153.4`). The remaining platform work below (credential storage and
  native app-tools delivery) is separate and still unverified end to end.
- **Each live `codex exec` test spends real, metered usage against the
  connected Codex account.** The user explicitly authorized the completed
  follow-up after adding credits; get fresh confirmation before any new live
  regression campaign.
- PR #18 was already open and green on CI before commit `e79f0f9`. Recheck
  `gh pr checks 18` after pushing further commits before merging -- CI runs
  on Linux, so it re-validates none of these Windows-specific changes broke
  POSIX behavior, but cannot itself validate the Windows-side claims already
  proven on this machine.
- The plugin is currently installed into the user's real, live Windows
  Codex app as `synapse@synapse-dev-81bbd29df3a5` (a disposable dev
  snapshot, not `synapse@synapse`). Harmless but leave it deliberately or
  remove it (`codex plugin remove synapse@synapse-dev-81bbd29df3a5`) --
  don't just forget it's there. Likewise a throwaway test project is
  registered in the real `~/.synapse/host.sqlite` (see item 1 above).
- No production/live server changes were made in either phase.

## Appendix: exact reproduction commands

Real values from this Windows machine; adjust the `codex.exe` build hash and
`DELL` username if different on whoever's machine resumes this.

```powershell
# 1. Locate the real installed codex.exe (adjust build hash if it differs)
$bin = "C:\Users\DELL\AppData\Local\OpenAI\Codex\bin\7ac07f4ce733f89a\codex.exe"

# 2. Point plugin installs at it (only needed if reinstalling the dev plugin)
$env:SYNAPSE_CODEX_BIN = $bin

# 3. A throwaway registered test project already exists from this session:
#    C:\Users\DELL\AppData\Local\Temp\synapse-native-test-repo
#    registered under alias "synapselivetest" in ~/.synapse/host.sqlite.
#    Reuse it, or make a fresh one:
$repo = New-Item -ItemType Directory -Force -Path "$env:TEMP\synapse-native-test-repo-2"
Set-Location $repo
git init -b main .
git config user.email "test@example.test"
git config user.name "Synapse Live Test"
"fixture" | Out-File -FilePath "$repo\README.md" -Encoding utf8
git add README.md
git commit -m "fixture"
```

```js
// register-project.mjs -- run once with `node register-project.mjs` from the
// repo root (adjust the `repo` path to match)
import { connectProject } from "./plugins/synapse/lib/project-registry.mjs";
const result = await connectProject({
  alias: "synapselivetest2",
  project: ".",
  cwd: "C:\\Users\\DELL\\AppData\\Local\\Temp\\synapse-native-test-repo-2",
});
console.log(JSON.stringify(result, null, 2));
```

```powershell
# 4. The actual repro (baseline -- confirm this still fails before investigating)
Set-Location $repo
& $bin exec --cd $repo --dangerously-bypass-hook-trust --json "reply with exactly: PING_OK" 2>&1

# 5. Hypothesis (a): does disabling the sandbox change the result?
& $bin exec --cd $repo --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox --json "reply with exactly: PING_OK" 2>&1
```

To make the result unambiguous (don't trust "no visible error" alone -- see
"Completed" above for why), temporarily add this to the very top of
`plugins/synapse/hooks/prompt-memory.mjs`, before its existing imports/logic,
then run `npm run install:plugin` (with `SYNAPSE_CODEX_BIN` set) to rebuild
before testing, and **remove it again** (verify with `git diff`) once done:

```js
try {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    "C:\\Users\\DELL\\.synapse\\hook-executed-marker.txt",
    `ran at ${new Date().toISOString()} on ${process.platform}\n`,
  );
} catch {}
```

Then check `Test-Path C:\Users\DELL\.synapse\hook-executed-marker.txt` after
each exec run -- delete it between runs so a stale marker from a previous
run can't be mistaken for a fresh success.
