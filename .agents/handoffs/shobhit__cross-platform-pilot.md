# Handoff: Cross-platform two-account pilot

- Branch: `shobhit/cross-platform-pilot`
- Human owner: `Shobhit Goel`
- Active agent: `Codex`
- Base reviewed: `61049f5` (`origin/main`)
- Last checkpoint: `uncommitted`
- Status: `active`

## Goal

Prove the complete Synapse conversation workflow with real accounts and native
Codex tasks for Mac-to-Windows, Windows-to-Mac, and Windows-to-Windows, reusing
the established Mac-to-Mac acceptance behavior and preserving safe evidence.

## File ownership

- `docs/cross-platform-pilot.md`
- `docs/conversations.md` only for linking the current acceptance matrix
- `README.md` only for linking the current acceptance matrix
- This handoff
- Focused test or runtime files only if a live run exposes a reproducible defect

## Completed

- Created a dedicated worktree from current `origin/main` after checking remote
  branches and active handoffs; no active branch owns this acceptance matrix.
- Read the Mac setup/validation history and the Windows hook, native-task,
  credential-store, receiver-service, and conversation handoffs in full.
- Confirmed the components were proven independently on Windows, but a complete
  two-account conversation involving Windows is not yet evidenced.
- Confirmed this Windows installation currently has no configured Synapse
  receiver connection; no live remote message has been sent.
- Installed the pinned dependencies with Node 24/npm 11; audit reported zero
  vulnerabilities.

## Decisions and invariants

- Do not describe independent component checks as a complete two-device pass.
- Use two consenting real accounts and real Codex tasks. Do not substitute a
  mocked database/native router for live acceptance.
- Never record credentials, local paths, native task IDs, message bodies, or
  screenshots containing private task content in cloud messages or Git.
- Reuse stable request IDs only for identical retries; preserve uncertain native
  mutation fences and exactly-one-child expectations.
- Do not repeat metered `codex exec` tests without fresh human authorization.
- The web-inbox branch is independent and remains untouched.

## Verification

- `npm ci --ignore-scripts` — passed; 103 packages, zero vulnerabilities.
- Windows setup helper `inspect` — returned `connections: []`; local enrollment
  is a live-test prerequisite, not silently manufactured.

## Remaining work

1. Commit the acceptance matrix and link it from current conversation docs.
2. Verify the deployed backend/schema and exact plugin builds before any message.
3. Enroll the consenting Windows and Mac participants through the installed
   setup skill and require `conversations_ready` on each device.
4. Execute and record Mac-to-Windows, Windows-to-Mac, and Windows-to-Windows.
5. Reproduce and fix only defects actually exposed by those runs, with tests.
6. Run the repository release gate, update this handoff, and open a focused PR.

## Risks or blockers

- This session controls only one Windows machine. The live matrix needs one Mac
  and a second Windows account/device (or two isolated, real Codex installations)
  online with explicit owner consent.
- Recipient-accessible marketplace distribution is still a rollout prerequisite.
- Actual local task IDs and message contents must remain outside committed
  evidence; use counts, statuses, versions, and timestamps instead.
