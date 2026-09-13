# Handoff: Live-verify Windows credential storage and receiver service

- Branch: `shobhit/credential-store-verification`
- Human owner: `Shobhit Goel`
- Active agent: `Claude`
- Base reviewed: `a721d6b` (main, includes merged PR #18, #22, #21)
- Last checkpoint: `uncommitted`
- Status: `active`

## Goal

PR #18/#22 proved hook execution and native task creation work on Windows.
What's still unverified: whether `WindowsDpapiStore` (in
`plugins/synapse/lib/receiver-secrets.mjs`) and the Windows Task Scheduler
receiver service (`receiverServicePowerShell`/`manage-receiver-task.ps1` in
`receiver-service.mjs`) actually work on a real Windows session, not just in
code review and mocked-spawn tests. This is the last unverified piece of the
Windows cross-platform track before it's genuinely complete end-to-end.

## File ownership

- `plugins/synapse/lib/receiver-secrets.mjs`
- `plugins/synapse/lib/receiver-service.mjs`
- `plugins/synapse/scripts/windows-secret.ps1`
- `plugins/synapse/scripts/manage-receiver-task.ps1`
- Confirmed no overlap with any other active handoff on `main` as of this
  checkpoint (`codex__conversational-messaging.md` only claims
  `receiver-worker.mjs`, not `receiver-service.mjs`; organizer handoffs only
  touch `src/server/memory-organizer/*`).

## Decisions and invariants

- This verification does **not** require `codex exec` or any Codex account
  usage -- DPAPI credential storage and Task Scheduler registration are pure
  local Windows OS operations, testable directly via Node scripts calling
  the real classes (default `spawnImpl`/`run`, not mocked). No live-testing
  cost concern here, unlike the native-task-creation work.
- A real Task Scheduler registration is a **persistent, visible OS-level
  change** (a scheduled task named "Synapse Receiver" that runs at logon and
  auto-restarts). Clean it up (stop + unregister) after verification,
  don't leave it running unexpectedly.
- Do not touch `receiver-worker.mjs` or anything conversational-messaging
  owns; if the receiver-service test needs a real `CODEX_MCP_NODE_PATH`,
  reuse the same real Windows codex.exe/runtime discovery used in the prior
  investigations (see `shobhit__native-task-verification.md` for exact
  paths), not a fresh guess.
- If real bugs are found, fix them following the same discipline as the
  prior two PRs: find the actual root cause, fix it properly (not a skip),
  verify conclusively, keep diagnostic/throwaway code out of committed history.

## Remaining work

1. Directly exercise `WindowsDpapiStore.set/get/delete` for a real synthetic
   credential (matching the `SAFE_CREDENTIAL` pattern `syn_recv_...`) via a
   real `windows-secret.ps1` invocation -- confirm actual DPAPI
   protect/unprotect round-trips correctly, the file lands with expected
   permissions, and delete cleans up.
2. Directly exercise `manage-receiver-task.ps1` (start/status/stop) via
   `receiverServicePowerShell`/`startService`/`stopService` (or by calling
   the PowerShell script directly) against a disposable launcher script --
   confirm a real Scheduled Task actually registers, runs, and unregisters
   cleanly. Do not leave a stray scheduled task behind.
3. Fix any real bugs found, with tests, following the file-ownership list.
4. Update this handoff, commit, and push.
5. Once this is done, move to the web inbox (the other half of "finish both
   one by one" from the user) as a separate, later workstream/handoff.

## Verification

Not yet started.

## Risks or blockers

None yet. Fresh workstream.
