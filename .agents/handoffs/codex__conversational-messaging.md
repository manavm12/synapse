# Handoff: conversational messaging review fixes

- Branch: `codex/conversational-messaging`
- Human owner: `Manav Mehta`
- Active agent: `Codex` in `Review Synapse functionality`
- Base reviewed: `a50f2222336e650418a9531cdd51e2ba03e2bb9b` (latest main integrated for merge)
- Tested and deployed source: `6c7800ca1cf547100b2f65bcc2a41b2852559695`
- Status: `user authorized merge; combined local checks passed, CI pending`

## Goal

Fix PR13's duplicate pause/resume delivery and stranded v1 staged-message
upgrade, verify the combined change, and complete the real desktop acceptance
test when controlled accounts and native queue access are available.

## File ownership

- `plugins/synapse/lib/conversation-store.mjs`
- `plugins/synapse/lib/conversation-hooks.mjs`
- `plugins/synapse/lib/receiver-worker.mjs`
- `plugins/synapse/lib/inbox.mjs`
- `test/client/conversations.test.mjs`
- `test/client/receiver-service.test.mjs`
- `docs/conversations.md`
- This handoff only.

## Completed

- Confirmed the original author task is idle and no active branch owns these files.
- Created a dedicated worktree and merged current main without rewriting history.
- Reproduced both review findings with isolated SQLite fixtures.
- Original PR head passes all 265 tests with disposable PostgreSQL, audit and plugin validation.
- Preserved unconsumed initial, resumed, and automatic-repair prompts across
  pause/resume. Only consuming or rejecting the prompt permits a continuation.
- Added unique IDs for later resume attempts and markers for automatic repairs;
  uncertain acknowledgements remain fenced until native execution is observed.
- Allowed unchanged, unissued staged v1 imports to adopt v2 metadata and a fresh
  claim token while retaining immutable-payload and tenant checks.
- Retained missing-route fences during upgrades and dispatch isolation between
  paused and unpaused conversations sharing a task.
- Added regression coverage and made the primary-root registration test use an
  isolated Git repository and linked worktree.

## Decisions and invariants

- Preserve queued versus already-consumed input across pause/resume.
- Only enrich unissued staged v1 jobs after validating unchanged payload and identity.
- Keep ambiguous native mutations fenced; retain cloud authorization and ordering.
- No production migration, plugin replacement, or real-user message is part of fixture testing.

## Verification

- Current bundled CLI exposes queue schemas; read-only default control-socket probe closes before initialization.
- Final full `npm run check` with a fresh disposable PostgreSQL 17 database:
  289 passed, zero failed, zero skipped. Coverage: 95.99% lines, 87.05% branches,
  94.31% functions.
- Both standalone reproductions of the original review findings now pass.
- `npm run audit`: zero vulnerabilities. `npm run validate:plugin`: passed.
- `git diff --check`: passed. New organizer coverage branch has no overlapping files.

## Remaining work

1. Pass the combined local/CI gates and merge PR13, as explicitly instructed by
   the user after discussing the still-unverified live routing.
2. Complete the live two-account desktop smoke test as a separate follow-up.
   Merge authorization does not establish that this test passed.

## Final integration for merge — 12 September 2026

- User explicitly instructed: resolve PR13 conflicts and merge. GitHub reported
  the PR mergeable; merging latest main `a50f222` into the PR branch applied
  cleanly with no conflict markers or manual conflict resolutions required.
- Retained main's PR20 organizer implementation without edits, and retained
  PR13's reviewed conversation implementation and regression fixes.
- Combined release check: 300 passed, zero failed, zero skipped against a fresh
  disposable PostgreSQL 17 database. Coverage: 96.05% lines, 87.42% branches,
  94.39% functions. Audit: zero vulnerabilities. Plugin validation and production
  Docker build passed. The disposable database was removed after validation.
- Verified the later local recipient task called `reply_to_message` and its
  local send receipt was `sent`; the inbound response obligation was `replied`.
  Reply `a241fc65-05f1-448c-b7c1-34249f49321f` remained queued in the cloud at
  the last read. The verified local binding points to the original recipient
  task; remote return delivery and busy-task ordering remain unverified.
- Main's automatic HTTP deployment at `2026-09-12T07:52:33.608Z`, deployment
  `274ba239-7cc1-4ac2-8ecf-4d3461d6081f`, replaced the manual PR13 upload with
  `a50f222`, which lacks v2 claims and conversation tools. Merging the combined
  PR restores those APIs to the tracked main source instead of another upload.
- The separate organizer workstream subsequently enabled its continuous
  worker with the user's approval. Preserve its configuration and PR20 code.
  Main merges can trigger the existing normal deployments; this workstream
  does not change worker settings, model, credentials, or queue history.

## Authorized rollout — 12 September 2026

- Required CI passed at `6c7800c`, including the production Docker build.
- Installed the local plugin from that exact source as
  `synapse@synapse-dev-a23800662bb7`, version
  `0.3.0+codex.20260909091650`. Immutable staging, cached bytes and 14 hook
  entries verified; OAuth configuration preserved. The prompt hook subsequently
  reported verified enrollment. This task still exposes the older nine-tool
  catalog and may need a fresh task/refresh for reply/history discovery.
- Diagnosed queued message `31eb97db-b83e-4841-94b7-08e241c9318b`:
  the new receiver sends `version: 2`, while production main rejected that field.
  Installing the plugin before its matching backend was the rollout-order error.
- With the user's explicit server-update approval, used the authenticated
  Supabase SQL editor for project `kikzjvzdghapmsrubsjk` (matched to the HTTP
  service's Supabase URL). Applied migrations
  `202609090002_require_bound_receiver_approval.sql` and
  `202609090003_conversations.sql` in filename order in one transaction with
  the migration advisory lock and ledger updates. The submitted migration
  contents matched the reviewed files' SHA-256 hashes. Both applied at
  `2026-09-12T07:34:29.45963Z`; all ten migration filenames are now recorded.
- Verified all three new columns and the three callable functions, including
  security-definer settings, hardened search path, runtime execution grants,
  and denial for anonymous/authenticated client roles.
- Uploaded the clean tested `6c7800c` checkout to the existing Railway HTTP
  service only. Deployment `33e828ab-265a-4efe-b387-4f19d12897d5` is SUCCESS,
  its instance is RUNNING, and its image digest is
  `sha256:e0bf1303de7a3061b55df3243d3656eceaf8371245ccef82ec1f47c5998768a7`.
  Both `/healthz` and `/readyz` returned HTTP 200. An authenticated
  `get_message_status` now returns the new `response_state: awaiting_reply`.
  No live message was sent or manually claimed for this deployment check.
- Railway's upload records the reviewed commit in the deployment message;
  it does not attach Git commit metadata. Direct image-file hash verification
  via Railway SSH was unavailable because no SSH keys are registered. No key
  was provisioned. Provenance is the verified clean checkout/upload, deployment
  ID/image digest, and successful upgraded API response.
- The separate memory worker remains at deployment
  `9b4d0110-be6e-4255-9eb7-a6307d489540`, stopped/EXITED. Its configuration,
  credentials and lifecycle were not changed by this rollout.
- HTTP rollback image: deployment `d01e3421-b2b6-495a-9f3e-f7d25da71051`
  from main `bf48aeca50cf64c3c2737c89afafafeb714e6338`. Retain the additive
  schema during an application rollback. HTTP source tracking remains on main;
  a future main deployment would replace this explicitly uploaded PR version.

## Risks or blockers

- The current desktop's default native control socket remains unavailable.
- The only authorized other device/project is
  `Manavs-MacBook-Pro-2.local` / `webcrm-rl`, authenticated as `neev`.
  The user authorized its plugin update and later reported installing its new
  hooks. Remote task reports must be copied by the user because the remote task
  API currently omits their content. Do not create another remote task, access
  another device/project, or initiate another live test without approval.
- A prior user-directed message from that device created a local task that
  answered in its own final text without sending a Synapse reply. This proves
  only one-way delivery. The later queued message remained queued after the
  HTTP update; full native round-trip acceptance remains unverified.
- GitHub currently reports the PR ready for review, although its earlier body
  said draft. Preserve that state and keep the live gate explicitly pending.
