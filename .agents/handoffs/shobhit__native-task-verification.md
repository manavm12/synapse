# Handoff: Verify native task creation works on Windows

- Branch: `shobhit/native-task-verification`
- Human owner: `Shobhit Goel`
- Active agent: `Claude`
- Base reviewed: `027c513` (main, includes merged PR #18)
- Last checkpoint: `uncommitted`
- Status: `active`

## Goal

PR #18 proved Synapse's plugin **hooks execute** correctly on Windows (a
`commandWindows` PowerShell launcher, verified live with an unconditional
marker-file write). That is a different, narrower claim than "Synapse can
receive and deliver a task on Windows." This workstream verifies the
remaining, still-open piece: does the native app-tools pipe (`codex_app`
namespace: `list_projects`, `create_thread`, `send_message_to_thread`) that
`dispatch.mjs`/`native-router.mjs` depend on for actually creating a new
Codex task also work correctly when invoked from a Windows-launched hook.

This is a live-verification task, not primarily a coding task, though real
bugs are likely to surface the same way they did in the hook-execution
investigation (see `.agents/handoffs/shobhit__windows-test-fixes.md` in git
history, now on `main`, for that full investigation and its methodology).

## File ownership

- `plugins/synapse/lib/dispatch.mjs` -- currently has TEMPORARY diagnostic
  code at the top of `dispatchPrompt` (see "Remaining work" item 1). Must be
  removed before this branch merges.
- `src/client/cli.mjs`, `plugins/synapse/server/control.mjs`,
  `scripts/migrate.mjs` -- fixed (see "Completed"), already committed and
  pushed (`b554593`), no longer need work.
- Likely candidates once the actual native-pipe investigation resumes:
  `plugins/synapse/lib/native-router.mjs`, `app-tools-client.mjs`,
  `native-reconcile.mjs`, `hooks/bind-child.mjs`

## Decisions and invariants (carried over from the prior investigation)

- **Each `codex exec` call spends real, metered usage/credits against the
  connected Codex account.** The user explicitly authorized proceeding with
  this exact verification in this conversation, but don't spend it
  carelessly -- do free/code-only research first, form a specific hypothesis,
  then run the minimum number of live tests needed to confirm or refute it.
- Prefer proving things conclusively (an unconditional, unambiguous side
  effect) over "no visible error," which was proven insufficient last time.
- `--dangerously-bypass-hook-trust` is documented by Codex's own CLI as safe
  for automation that has read the hook source; use it, don't work around
  hook trust some other way.
- The real Windows `codex.exe` on this machine:
  `C:\Users\DELL\AppData\Local\OpenAI\Codex\bin\7ac07f4ce733f89a\codex.exe`
  (set as `SYNAPSE_CODEX_BIN` if reinstalling the dev plugin).
- A disposable dev plugin build (`synapse@synapse-dev-81bbd29df3a5`) is
  already installed in the real Codex app from the prior investigation, and
  a throwaway registered test project exists at
  `C:\Users\DELL\AppData\Local\Temp\synapse-native-test-repo` (alias
  `synapselivetest` in `~/.synapse/host.sqlite`). Reuse both rather than
  creating new ones, unless the plugin needs rebuilding for this branch's
  changes (it will, once anything in `plugins/synapse` changes here).
- Do not use `git stash` in this repo's worktree setup (shared stash stack).

## Completed

- Read `dispatch.mjs`/`native-router.mjs`/`app-tools-client.mjs`. The chain
  is: `dispatchPrompt()` immediately returns `null` (no-ops entirely) unless
  `env.CODEX_APP_TOOLS_PIPE_PATH` is set -> if set, eventually calls
  `native-router.mjs`'s `runReservedDelivery` -> `new AppToolsClient()`
  (no explicit `pipePath`, so it reads `CODEX_APP_TOOLS_PIPE_PATH` itself
  too) -> `client.callTool("create_thread", ...)`. **Whether
  `CODEX_APP_TOOLS_PIPE_PATH` is actually set when Codex spawns a Windows
  hook via `commandWindows` is the single biggest unknown** -- this is
  distinct from and untested by the prior hook-execution investigation
  (that proof used `prompt-memory.mjs`, which never reads this variable).
- Added a temporary unconditional diagnostic to the top of `dispatchPrompt`
  (writes `~/.synapse/dispatch-diagnostic.txt` with `hook_event_name`,
  whether `CODEX_APP_TOOLS_PIPE_PATH` is set, and `cwd`) -- **still present,
  not yet reverted**, see "Risks or blockers".
- **Found and fixed a real, separate, significant bug while setting up the
  test**: `npm run synapse -- send ...` silently did nothing on Windows
  (exit 0, no output, nothing queued). Root cause: `src/client/cli.mjs`
  (plus `plugins/synapse/server/control.mjs` and `scripts/migrate.mjs`) used
  the classic broken idiom `import.meta.url === \`file://${process.argv[1]}\``
  to detect "is this the directly-executed script" -- this is well-known
  broken on Windows (`import.meta.url` is a proper encoded `file:///C:/...`
  URL; `process.argv[1]` is a raw `C:\...` path; naive concatenation can
  never match), so `main()` was simply never called for **any** CLI command
  on Windows (`send`, `doctor`, `setup`, `admin`, `recover` -- not just
  `send`). Fixed all three using `process.argv[1] && import.meta.url ===
  pathToFileURL(process.argv[1]).href`, matching the pattern already
  correct in `scripts/backfill-memory.mjs` elsewhere in this codebase.
  Verified live: `send` now actually queues a message. Committed and pushed
  as `b554593`, separately from the still-open diagnostic work above.
  Full suite still 284/0/12 -- no existing test caught this bug, because
  tests call `main()` directly as a function rather than through a real
  subprocess, bypassing the guard entirely. That's a real coverage gap,
  not fixed here.
- Successfully: reinstalled the dev plugin build with the diagnostic,
  queued a real message via the now-fixed CLI against the registered
  throwaway project, then ran `codex exec --cd <repo>
  --dangerously-bypass-hook-trust --json "..."` to trigger it.
  **Result: hit the account's Codex usage limit again** before the turn
  even started processing ("You've hit your usage limit... try again at
  9:09 PM"). No diagnostic file was written -- the turn appears to have
  failed early enough that `UserPromptSubmit` hooks never ran at all for
  it. This attempt produced zero information either way; it is not a
  negative result, just a non-result.

## Remaining work

1. **Get explicit user confirmation before any further live `codex exec`
   calls** -- the account hit its usage limit again this session (reset
   "9:09 PM" per the error, timezone unconfirmed). Do not retry live tests
   without checking in first.
2. Once usage is available again, repeat the exact same live test (queue a
   message against `C:\Users\DELL\AppData\Local\Temp\synapse-native-test-repo`,
   run `codex exec --dangerously-bypass-hook-trust` there, check
   `~/.synapse/dispatch-diagnostic.txt`). Read the diagnostic to see whether
   `CODEX_APP_TOOLS_PIPE_PATH` is set:
   - If unset: this confirms `dispatchPrompt` can never proceed via
     `codex exec` regardless of platform -- the native-pipe question would
     then need testing through the interactive TUI or the real desktop app
     instead of `codex exec`, similar to how the interactive TUI was needed
     to fully settle the earlier hook-execution question.
   - If set: extend the diagnostic further down the call chain (before/after
     the `AppToolsClient`/`create_thread` call) to see exactly how far
     execution gets, and whether a real native task actually appears.
3. Once the question is answered, **remove the temporary diagnostic from
   `dispatch.mjs`** (verify with `git diff`) before committing whatever real
   fix (if any) is needed.
4. Update this handoff and push before pausing.

## Verification

- `npm run lint`, `npm run format:check`, `npm test` all pass (284/0/12)
  with the entry-point fix in place (commit `b554593`).
- The `dispatch.mjs` diagnostic itself is unverified/inconclusive -- see
  "Completed" above.

## Risks or blockers

- **`dispatch.mjs` currently has uncommitted temporary diagnostic code in
  the working tree.** It is NOT committed (kept separate from the real
  `b554593` fix deliberately). Do not commit it as-is; either use it for
  one more live test then revert, or revert it now if pausing for a while.
- **The Codex account is at its usage limit** (reported reset ~9:09 PM).
  Get explicit confirmation before spending more live-test budget.
- A disposable dev plugin build (`synapse@synapse-dev-b699c2d4687a`, from
  this branch/worktree) is installed in the real Codex app, replacing the
  prior investigation's build (which was removed via
  `codex plugin remove synapse@synapse-dev-81bbd29df3a5` to free the
  conflict). Clean up when this workstream concludes.
- No production/live server changes were made.
