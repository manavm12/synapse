# Handoff: Windows test-suite fixes + real cross-platform investigation

- Branch: `shobhit/windows-test-fixes`
- Human owner: `Shobhit Goel`
- Active agent: `unassigned` -- Claude has stopped; ready for Codex (or any
  agent) to resume immediately. Usage/credits have been added to the
  connected Codex account, so the live-testing budget concern below is
  cleared -- proceed with live `codex exec` testing.
- Base reviewed: `0aad6a1`
- Last checkpoint: `9245aae`
- Status: `blocked` -- PR #18 (the parts already fixed) is open and was green
  on CI as of `e79f0f9`; the specific open problem is below in
  "START HERE for the next agent."

## START HERE for the next agent

**The problem, precisely**: Synapse's plugin hooks (`plugins/synapse/hooks/hooks.json`)
do not execute successfully when Codex triggers them on Windows, even after
fixing the hardcoded absolute path `/bin/sh` to the bare command `sh` (which
is the technically correct fix -- verified that `sh` resolves correctly via
Node's real process spawn on this Windows machine, and it matches Codex's
own documented Windows plugin support via Git Bash). The `sh` fix is real
and already committed (`e79f0f9`), but it was proven, not assumed, to be
insufficient by itself: see "Follow-up in the same session: a conclusive
negative result" below for the exact reproduction.

**What to actually do**:
1. Read this entire handoff before touching anything -- especially the
   "Completed" section below, so you don't repeat the same dead-end
   experiments (e.g. don't rely on `prompt-memory.mjs`'s own checkpoint
   write as a success signal; it requires a registered project AND an
   already-existing checkpoint file, so it can't prove success or failure
   on its own -- that's why the unconditional-marker-write technique below
   was needed instead).
2. Reproduce the negative result first, to confirm the starting state:
   register a throwaway git repo as a Synapse project via `connectProject()`
   (pure local SQLite write, no OAuth needed -- see the exact code below),
   then run `codex exec --dangerously-bypass-hook-trust --json "<prompt>"`
   against it, with a temporary unconditional diagnostic write added to the
   top of a hook script (e.g. `prompt-memory.mjs`) to remove all ambiguity.
   Confirm the marker still doesn't appear before investigating further.
3. Test hypotheses in this order (cheapest/most informative first), **now
   that usage is available**:
   a. Add `--dangerously-bypass-approvals-and-sandbox` to the same repro.
      `codex doctor` reports command execution is sandboxed by default
      ("restricted fs + restricted network... sandbox backend: elevated").
      If the marker appears with this flag, the sandbox is wrapping hook
      subprocess execution and blocking `sh.exe` (or restricting its
      filesystem/network access) independently of the shell-invocation fix.
      That would mean the real fix is either an explicit sandbox exemption
      for hook commands, or documenting that hooks need
      `-s danger-full-access` on Windows, or something Codex-side to report
      upstream.
   b. If sandbox bypass doesn't change the result, test whether `codex exec`
      (a non-interactive, single-shot command) processes plugin hooks at
      all on this platform -- try the same scenario through the interactive
      `codex` TUI instead (a real prompt in a real interactive session, in
      the registered repo), since hooks may be an interactive/desktop-app-only
      surface regardless of platform. This wasn't tested yet.
   c. If neither explains it, this may be a genuine Codex-side Windows gap
      outside this repo's control -- consider checking
      https://github.com/openai/codex/issues (found real, relevant Windows
      native-pipe issues there during earlier research) or filing a new one.
4. Once you find the actual fix, **verify it conclusively** the same way
   the negative result was proven: an unconditional diagnostic write that
   bypasses all of Synapse's own gating logic, not just "no visible error."
   Then **remove the diagnostic code** (`git diff` must be clean of it)
   before committing the real fix.
5. Update this handoff's "Completed"/"Verification" sections with the
   result -- positive or still-negative -- and push before stopping.
   `npm run lint`, `npm run format:check`, and `npm test` must still pass
   (219 pass / 0 fail / 16 skipped baseline; see "Verification" below).

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

## Decisions and invariants

- Fix path/URL/IPC-address/shell-invocation handling to be genuinely
  cross-platform (identical behavior on macOS/Linux, correct on Windows)
  rather than papering over failures with skips, except where a capability
  is genuinely OS-gated (Windows symlink privilege, POSIX permission bits,
  POSIX signals) -- there, skip explicitly with a stated reason.
- The `/bin/sh` -> `sh` fix is justified on its own technical merits (matches
  Codex's documented Windows behavior; verified correct PATH resolution via
  Node's real spawn) but is **conclusively proven insufficient on its own**
  to make hooks execute via `codex exec` on Windows -- see the "conclusive
  negative result" note above. Do not describe it as fixing Windows hook
  execution; describe it as "a necessary but not sufficient fix, with the
  actual blocker still unidentified."
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

1. **Find the actual blocker.** Hooks conclusively do not execute via
   `codex exec` on Windows even after the `sh` fix and with a registered
   project (see "conclusive negative result" above). Get explicit user
   sign-off before spending more Codex usage, then investigate in this
   order (cheapest/most informative first):
   - Retry with `--dangerously-bypass-approvals-and-sandbox` (the run that
     would test this hit the account's usage limit before finishing --
     rerun once usage resets) to isolate whether the command sandbox blocks
     hook subprocess spawning independently of the shell fix.
   - If sandbox bypass doesn't fix it, test via the interactive `codex` TUI
     or the real desktop app GUI directly (not `codex exec`), since plugin
     hooks may be processed differently -- or not at all -- by the
     non-interactive single-shot exec path.
   - Consider asking in the Codex/OpenAI developer community or filing an
     issue if neither explains it; this may be a genuine Codex-side Windows
     gap rather than anything fixable in this repo.
   - A registered throwaway test project already exists locally for this:
     `C:\Users\DELL\AppData\Local\Temp\synapse-native-test-repo`, registered
     under alias `synapselivetest` in the real `~/.synapse/host.sqlite`.
     Harmless to leave; remove via direct SQL/CLI if a clean slate is wanted.
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
  (the model turn itself) in every run. Hook execution specifically was
  tested with an **unconditional** diagnostic file write added temporarily
  to `prompt-memory.mjs`, against a real registered project -- the marker
  never appeared. **Conclusive negative result** for hook execution via
  `codex exec` on Windows post-fix; not merged, fully reverted (`git diff`
  clean).
- Live: a follow-up test adding `--dangerously-bypass-approvals-and-sandbox`
  (to isolate whether Codex's command sandbox also blocks hook subprocess
  spawning) hit the account's Codex usage limit before the turn completed --
  untested, not failed.

## Risks or blockers

- **Hook execution on Windows is still broken after this fix.** The `sh`
  change is real and correct but not sufficient by itself; do not report or
  merge-describe this as "Windows hook execution now works." See "Remaining
  work" item 1 for the next diagnostic steps.
- **Each live `codex exec` test spends real, metered usage against the
  connected Codex account.** This investigation's repeated tests hit the
  account's usage limit. Get explicit user confirmation before running more
  live tests, and expect a real wait/cost to continue this investigation.
- PR #18 was already open and green on CI before commit `e79f0f9`. Recheck
  `gh pr checks 18` after pushing further commits before merging -- CI runs
  on Linux, so it re-validates none of these Windows-specific changes broke
  POSIX behavior, but cannot itself validate the Windows-side claims in this
  handoff (which, per above, are currently a mix of "fixed" and "still
  broken, cause unknown").
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
