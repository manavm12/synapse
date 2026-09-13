# Handoff: Verify native task creation works on Windows

- Branch: `shobhit/native-task-verification`
- Human owner: `Shobhit Goel`
- Active agent: `unassigned`
- Base reviewed: `027c513` (main, includes merged PR #18)
- Last implementation checkpoint: `0babc4f` (all code and test changes pushed;
  this handoff is finalized in the branch HEAD)
- Status: `ready-for-review`

## Goal

Verify that Synapse can create and run a real Codex task through the native
app-tools pipe on Windows, fix any bugs exposed by that test, and leave the
installed development plugin free of temporary diagnostics.

## Completed

- Proved a Windows `UserPromptSubmit` hook receives a real
  `CODEX_APP_TOOLS_PIPE_PATH` (`\\.\pipe\...`), so native routing is available
  from `codex exec`; the earlier concern that hooks might be TUI-only was false.
- Found and fixed three Windows-broken direct-entry guards in
  `src/client/cli.mjs`, `plugins/synapse/server/control.mjs`, and
  `scripts/migrate.mjs`. They now compare `import.meta.url` with
  `pathToFileURL(process.argv[1]).href` instead of concatenating a raw Windows
  path. The real CLI now executes and queues sends on Windows (`b554593`).
- Found and fixed a second real Windows bug in
  `plugins/synapse/lib/native-router.mjs`: Codex reported the saved project as
  `c:\Shobhit Goel\...`, while Synapse stored `C:\Shobhit Goel\...`.
  Project selection now compares canonical paths case-insensitively on Windows,
  including `\\?\` long-path prefixes, while preserving POSIX case sensitivity
  (`d351f1c`).
- Added subprocess coverage for the three executable entry points and regression
  coverage for Windows saved-project path matching. Updated the stale native-pipe
  comment in `app-tools-client.mjs` (`947590f`).
- Increased only the setup-helper test deadline from three to five seconds.
  PowerShell startup exceeded three seconds once under concurrent Windows load;
  the production timeout is unchanged (`0babc4f`).
- Removed the temporary `dispatch.mjs` diagnostic from the branch. Reinstalled
  the clean development plugin as `synapse@synapse-dev-b699c2d4687a`, content
  hash `b1fdc910d927e84ab25120bf11765e0e49b05152f3f099f10242a50578eac86e`,
  deleted `C:\Users\DELL\.synapse\dispatch-diagnostic.txt`, and verified the
  installed `dispatch.mjs` contains no diagnostic code.

## Live Windows proof

- Queued job: `aed7d95a-f91c-4688-8326-a643ee80728a`
- Channel: `windows-native-e2e-20260913`
- Native delivery: `cfecb0e9-8ea9-401c-84f0-489fe4cd28cc`
- Temporary task ID returned by `create_thread`:
  `client-new-thread:b16a741a-3d9c-49b7-8f82-203cb4fd4436`
- Permanent Codex task ID resolved from desktop state:
  `01a098c3-1d06-7643-905a-1d1616577834`
- The created task ran in a Codex worktree, received the exact queued Synapse
  prompt, made no file changes, and completed with `SYNAPSE_NATIVE_PIPE_OK`.

This proves the complete Windows native path used by the MVP: prompt hook ->
local inbox reservation -> saved-project selection -> native `create_thread` ->
real child task execution.

## Verification

- `npm test`: 298 total, 286 passed, 0 failed, 12 skipped. The skips are explicit
  platform/PostgreSQL integration cases unavailable on this Windows host.
- Focused entry-point and native-router tests: 20 passed.
- `npm run lint`: passed.
- `npm run format:check`: passed.
- `npm run validate:plugin`: passed.
- `npm audit`: 0 vulnerabilities.
- `git diff --check`: passed.
- `npm run check`: Biome and every runnable test passed, but the aggregate command
  correctly exited nonzero because `TEST_DATABASE_URL` is absent. The skipped
  PostgreSQL suites leave line coverage at 80.16%, below the 85% release gate.
  Do not report the database-backed release gate as passed until CI or a fresh
  disposable PostgreSQL database runs it.

## Cross-platform scope

- Windows native task creation is now proven live end-to-end.
- Windows DPAPI, Task Scheduler, and path/URL/IPC behavior have automated coverage.
- macOS and Linux implementations and platform selection remain covered by the
  repository tests; their code paths were not changed by this workstream.
- No live macOS or Linux host was exercised here, so this handoff does not claim
  live acceptance on those platforms. Required CI and any live host smoke tests
  remain review/merge gates, not hidden failures.

## Remaining work

1. Open a focused pull request to `main` and let required CI/security checks run.
2. Run the PostgreSQL-backed `npm run check` gate in CI or against a fresh
   disposable test database; expect zero skipped tests before merge.
3. After the clean plugin install, a fresh Codex task must observe the new build's
   hooks before setup reports receiving as verified. Existing credentials,
   destinations, and queues were preserved.

## Risks and retained test artifacts

- The local test inbox retains the accepted verification job above, and the real
  child task remains in Codex history. They were not destructively rewritten.
- The clean plugin build is a local development installation, not a production
  release. No production server, credentials, migrations, or remote messages were
  changed.
- Each live `codex exec` spends account usage. The conclusive proof is complete;
  do not repeat it unless a future code change requires a new acceptance test.
