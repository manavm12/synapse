# Handoff: Live-verify Windows credential storage and receiver service

- Branch: `shobhit/credential-store-verification`
- Human owner: `Shobhit Goel`
- Active agent: `unassigned`
- Base reviewed: `a721d6b` (main, includes merged PR #18, #22, #21)
- Last checkpoint: `6695ab0`
- Status: `ready-for-review`

## Goal

PR #18/#22 proved hook execution and native task creation work on Windows.
What was unverified: whether `WindowsDpapiStore` (in
`plugins/synapse/lib/receiver-secrets.mjs`) and the Windows Task Scheduler
receiver service (`receiverServicePowerShell`/`manage-receiver-task.ps1` in
`receiver-service.mjs`) actually work on a real Windows session, not just in
code review and mocked-spawn tests. This closes out the last unverified
piece of the Windows cross-platform track.

## File ownership

- `plugins/synapse/lib/receiver-secrets.mjs` (verified, unchanged)
- `plugins/synapse/lib/receiver-service.mjs` (verified, unchanged)
- `plugins/synapse/scripts/windows-secret.ps1` (verified, unchanged)
- `plugins/synapse/scripts/manage-receiver-task.ps1` (fixed, see Completed)
- Confirmed no overlap with any other active handoff (`codex__conversational-
  messaging.md` only claims `receiver-worker.mjs`, not `receiver-service.mjs`;
  organizer handoffs only touch `src/server/memory-organizer/*`).

## Completed

### 1. WindowsDpapiStore -- verified correct, no bugs found

Directly exercised `set`/`get`/`delete` with a real synthetic
`syn_recv_...`-format credential against the actual `windows-secret.ps1`
(no mocking):
- `set()`: confirmed the on-disk `.dpapi` file contains a genuine DPAPI
  blob (`AQAAANCMnd8B...`, the standard DPAPI header) and does **not**
  contain the plaintext secret anywhere in the file.
- `get()`: confirmed it decrypts back to the exact original secret.
- `delete()`: confirmed the file is removed, and a second `delete()` call
  is idempotent (does not throw).

No changes needed here -- the implementation is correct as reviewed earlier.

### 2. Windows Task Scheduler receiver service -- found and fixed a real bug

Called `startReceiverService`/`stopReceiverService` end-to-end (real
`manage-receiver-task.ps1`, real Task Scheduler, isolated temp inbox path,
no mocking) and separately isolated the exact failure with a disposable
long-running heartbeat script once a problem was found:

- `startReceiverService` correctly registered and started a real "Synapse
  Receiver" scheduled task; confirmed via `Get-ScheduledTask` (state
  `Running`) and by observing the actual spawned process and its log output.
- `stopReceiverService` reported `{stopped: true}` and the scheduled task
  itself was genuinely unregistered -- but **the `node.exe` child process
  the launcher spawned via PowerShell's `&` call operator survived as an
  orphan**, indefinitely. Isolated this precisely: the wrapper PowerShell
  process Task Scheduler tracks and terminates is not the same OS process
  as the node.exe child it launches; Windows does not propagate that
  termination to already-spawned children this way. Confirmed via process
  listing that the wrapper's PID was gone while the child's PID (recording
  the now-dead wrapper as its parent) kept running and kept writing to a
  disposable heartbeat log, well after `stop` returned.
- **Fixed** in `manage-receiver-task.ps1`'s `stop` action: parse the exact
  target script path back out of the launcher script it generated, then
  explicitly find and `Stop-Process -Force` any `node.exe` process still
  running that script, in addition to the existing
  `Stop-ScheduledTask`/`Unregister-ScheduledTask` calls.
- Re-verified with the same controlled reproduction three separate times to
  rule out a fluke or timing artifact: 1 matching process running before
  `stop`, 0 after, each time, plus confirmation the scheduled task itself
  is also gone afterward.
- Does not change `receiverServicePowerShell()`'s generated script format at
  all, so existing tests asserting its exact string output are unaffected.

All temporary/scratch test scripts, log files, and OS-level artifacts
(the disposable scheduled task, heartbeat log, credential file) were
cleaned up after each test. Nothing was left registered or running.

## Decisions and invariants

- This verification did not require `codex exec`/Codex account usage --
  DPAPI and Task Scheduler are pure local Windows OS operations.
- The orphan-process bug is **not automatically testable in CI**: it's
  genuine Windows OS process-lifecycle behavior (a spawned child surviving
  parent termination unless explicitly handled) that only manifests on a
  real Windows session with real Task Scheduler; CI runs on Linux. The
  existing `receiver-service.test.mjs` coverage mocks the `run` function
  entirely and only validates generated script *content* (already correct,
  unaffected by this fix), not actual OS process behavior -- it could not
  have caught this bug, and can't regression-test the fix either. This is
  documented, not glossed over; the fix is live-verified-only, matching how
  native task creation (PR #22) was verified.
- If a future project goal needs automated coverage for this exact
  behavior, it would require a real (not mocked) Windows CI runner able to
  register/exercise a real Scheduled Task -- a meaningfully bigger lift than
  this fix itself.

## Verification

- `npx biome check .` -- passed
- `npm test` -- 323 pass / 0 fail / 13 skipped (unchanged before/after the fix)
- Live: `WindowsDpapiStore` full round-trip verified against the real
  `windows-secret.ps1`, no bugs found.
- Live: `startReceiverService`/`stopReceiverService` end-to-end against a
  real Task Scheduler task, confirmed the orphan-process bug and confirmed
  the fix resolves it, via three separate clean before/after process-count
  checks (see "Completed" above for exact evidence).

## Remaining work

1. Open a PR to `main` and let required CI/security checks run.
2. Once merged, this closes the Windows cross-platform track as genuinely
   complete end-to-end (hooks, native task creation, credential storage,
   and the background receiver service are all now live-verified, not just
   reviewed).
3. Next workstream per the user's plan ("finish both one by one"): the web
   inbox, as a separate fresh handoff -- this is a much larger, more
   open-ended greenfield feature and deserves its own scoping discussion
   before starting, unlike this bounded verification task.

## Risks or blockers

- None. No production/live server changes were made. No OS-level artifacts
  (scheduled tasks, processes, credential files) were left behind after
  testing -- confirmed clean after every test in this handoff.
