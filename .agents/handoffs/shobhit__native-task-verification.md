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

Not yet known -- likely candidates once investigation starts:
- `plugins/synapse/hooks/dispatch.mjs`
- `plugins/synapse/lib/native-router.mjs`
- `plugins/synapse/lib/app-tools-client.mjs`
- `plugins/synapse/lib/native-reconcile.mjs`
- `plugins/synapse/hooks/bind-child.mjs`

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

## Remaining work

1. Read `dispatch.mjs`, `native-router.mjs`, `app-tools-client.mjs` to
   understand exactly what a successful native task creation looks like
   (what gets written to the local inbox DB, what native tool calls are
   made) so there's a precise, unambiguous success signal to check for --
   not another ambiguous "no error" situation.
2. Form a specific test plan: likely, queue a real local message via
   `npm run synapse -- send ...` (or directly via `queueMessage()`) against
   the registered throwaway project, then trigger the `UserPromptSubmit`
   hook via `codex exec` (matching the proven-working invocation from the
   prior investigation), and check the local inbox SQLite for evidence of
   an actual created native task (not just that the hook ran).
3. Get the user's attention before actually spending live `codex exec` calls
   if it turns into more than a couple of runs, consistent with the prior
   investigation's cost discipline.
4. If a Windows-specific gap is found, fix it following the same pattern as
   the hook-execution fix: find the actual root cause via live evidence,
   fix it properly (not a skip/workaround), verify conclusively, revert any
   temporary diagnostic code before committing.
5. Update this handoff and push before pausing.

## Verification

Not yet started.

## Risks or blockers

None yet. This is a fresh workstream.
