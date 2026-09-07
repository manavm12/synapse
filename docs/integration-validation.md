# Product integration validation

Date: 2026-09-07. Branch: `codex/product-integration`.

The six feature workstreams are integrated locally and independently reviewed.
This report is not a production deployment or a live-model/native-task claim.
Task IDs and integrated correction commits are in
[implementation coordination](implementation-coordination.md).

Subsequent **non-mocked** checks are recorded separately in
[live validation](live-validation-2026-09-07.md): actual cloud OAuth/capture,
Keychain lifecycle, native task creation and same-task follow-up passed. These
do not constitute a combined hosted end-to-end pass.

## Implemented flows

- Setup and OAuth login assistance, self-service account/username registration,
  and local diagnostics that do not pretend a login receipt is a live token check.
- Immutable capture → atomic processing queue → separately enabled organizer
  worker → tenant-scoped claim/evidence ledger → authenticated topic, search,
  claim, note, and source retrieval. The earlier graphing experiment supplied the
  organizer design/core; source history and exact evidence remain immutable.
- Username send → server inbox → explicit receiver pairing/approval/completion
  → durable local import → fenced native dispatch → cloud delivery receipt.
  Any active signed-in sender is allowed after receiver opt-in.
- Dry-run-first, exact-owner/project, bounded backfill for captures predating the
  queue. Applying it enqueues only missing jobs; it does not reset existing jobs.

## Verification

| Check | Result |
| --- | --- |
| `npm run check` with fresh disposable PostgreSQL 17 database | 182 passed, 0 failed, 0 skipped |
| Repository coverage gate | 94.99% lines, 84.41% branches, 94.60% functions |
| Plugin validation | Passed |
| Dependency audit | 0 vulnerabilities |
| Latest production Docker image build | Passed |
| Built HTTP image startup, `/healthz`, OAuth metadata | Passed; both endpoints HTTP 200 |
| Built worker image, processing disabled | Exits successfully without DB/API initialization |
| Local browser login/receiver pages | Rendered; required-email validation passed; no console errors |
| Independent feature, recovery, and backfill reviews | All reproduced actionable findings corrected and re-reviewed |

Coverage uses the repository's existing gate, including test files and excluding
the migration entrypoint and HTTP database module. The latter is exercised by
real SQL and composition tests; coverage percentage alone is not a quality claim.

The memory composition test uses real HTTP/MCP, PostgreSQL roles/RLS, capture,
queue/runner, organizer, ledger and retrieval. Token verification and inference
are explicit test doubles. It verifies SDK discovery of all eight tools, stable
revision IDs, raw source access before processing, supersession with retained
source bytes, stale cursor rejection and cross-user denial.

The messaging composition test uses real account/receiver HTTP, MCP, PostgreSQL
and SQLite with synthetic token verification, Keychain and native transports.
It verifies idempotent sends/imports/receipts, recipient isolation, noncontiguous
inbound sequences, opt-in enrollment, approval followed by failed local completion,
pending cancellation, replacement installation isolation, and revocation while
an actual HTTP identity response is held in flight. No real user task is created.

Independent regressions additionally exercised competing quotas, both lock-race
orderings, queue starvation, stale fences, forged evidence, bounded HTTP bodies,
crash-resumable disconnect, and local identity/account changes during dispatch.

## Remaining live release gates

1. Supply an operator-approved environment file containing an inference API key
   for fresh extraction/retrieval quality tests. The user authorized up to US$5
   total; **US$0 was spent**. All calls must share the reviewed evaluation-budget
   guard with verified exact-model pricing. The guard is not an account-wide
   billing limit. The prior graph experiment's 28/34 result is not a new pass.
2. Verify the receiver in a supported installed desktop hook context. Follow-up
   investigation established that the shell-based pipe probe is rejected for
   missing code-signing identity. The actual integration client works in the
   supported signed execution context, and real native creation/follow-up now
   pass. Automatic installed-hook reconciliation and the cloud receiver path
   remain unverified. Do not bypass desktop access checks or silently replay an
   uncertain native mutation.
3. Verify real email/OAuth onboarding with a controlled test account after
   configuring SMTP, redirect URLs, and signup policy. Browser checks here sent
   no email and granted no real account access.
4. Apply migrations and configure separate least-privilege HTTP/worker secrets,
   verified TLS/proxy settings, budgets and rollout under the
   [operations runbook](cloud-memory-operations.md). Nothing was pushed, merged to
   main, deployed, or enabled in the user's installed plugin during this task.

The original checkout and organizer worktree were preserved. Feature worktrees
remain available for follow-up. The receiver task confirmed that its earlier
synthetic Keychain probe item was deleted and an exact lookup returned not found;
its disposable keychains were removed. No default/search-list mutation commands
were used, although no before-probe settings snapshot was captured.
