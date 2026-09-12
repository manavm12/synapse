# Current MVP status

Status date: 12 September 2026. Reviewed baseline: `main` at `c87995c`.

This document is the current map of the Synapse MVP. It distinguishes code that
is merged from production deployment and live validation. Older planning and
validation documents remain useful historical records, but their status labels
and test counts may describe earlier revisions.

## Product goal

The MVP tests whether two people's Codex agents can complete real engineering
handoffs without a human manually collecting and forwarding project context.
Synapse combines authenticated usernames, durable project memory, explicit
receiver consent, cloud message transport, and local native Codex tasks.

The broader MVP succeeds after at least five users complete 20 real handoffs and
at least 70 percent require no manual context transfer.

## Status summary

| Area | Merged on `main` | Production or live status |
| --- | --- | --- |
| Accounts and identity | Supabase-backed profiles, unique usernames, one cloud project per user, OAuth verification, invites and configurable signup | Real OAuth identity and capture have passed individually; complete two-account email onboarding remains unverified |
| Session memory capture | Ten-turn and compaction hooks, immutable revisions, idempotent capture, audit events | A real hosted capture succeeded; independent production SQL read-back was not completed |
| Memory organization | Durable queue, project leases, fenced worker, claim/evidence ledger, projection, status, canary and backfill tools | Dedicated Railway worker exists but remains disabled pending credentials, model selection, budget and a live canary |
| Memory retrieval | Authenticated topic browsing, lexical search, claim/note reads and exact source reads | Code and PostgreSQL composition tests pass; fresh organized production retrieval and semantic quality remain unverified |
| Cloud messaging | Username sends, inbox/status tools, receiver enrollment, durable import, native dispatch and receipts | Local native creation and follow-up passed separately; the combined two-user cloud-to-native workflow remains a release gate |
| Plugin setup | Plugin-only opt-in, saved-project selection, browser approval, Keychain storage, hook-health checks and reinstall-safe state | Clean-Mac installation, automatic hook execution and recipient-accessible marketplace distribution remain pending |
| Conversational replies | Not merged | Implemented separately on `codex/conversational-messaging`; integration and live round-trip validation remain outside `main` |
| Web inbox | Not started | No user-facing inbox, retry or channel-management application exists |

## Completed in the merged codebase

- Nine authenticated MCP tools: `get_identity`, `save_session_memory`,
  `memory_topics`, `search_memory`, `read_memory`, `send_message`,
  `get_message_status`, `list_inbox`, plus the setup-specific
  `begin_receiver_setup` tool.
- Tenant isolation through verified identity, PostgreSQL row-level security and
  separate runtime, worker and operator roles.
- Sensitive incoming text is treated as untrusted data and routed to a separate
  native Codex task. Local paths and native task IDs do not enter cloud payloads.
- Durable replay protection for capture, sending, local import, native dispatch
  and cloud receipts. Ambiguous native mutations become `needs_attention`
  instead of being blindly repeated.
- A separate opt-in organizer process. Capture remains available while the
  organizer is disabled or unhealthy.
- Disposable-PostgreSQL integration coverage, Biome formatting/linting,
  dependency auditing, plugin validation and secret scanning in CI.
- Operator commands for migrations, historical memory backfill, scoped worker
  status and one-revision canaries.

The latest merged commit records 245 passing PostgreSQL-backed tests, no skips,
95.63 percent line coverage, 85.95 percent branch coverage, 94.20 percent
function coverage and no npm vulnerabilities. These are repository validation
results, not proof of production readiness.

## Release work still required

1. Verify and apply every production migration, including
   `202609090002_require_bound_receiver_approval.sql`, before distributing the
   matching plugin.
2. Publish the plugin through a marketplace available to intended recipients.
3. Run a clean-Mac plugin-only flow: install, OAuth sign-in, hook approval,
   receiver consent, message import and exactly one native task in the selected
   project.
4. Run a controlled two-account send, delivery, follow-up and revocation test.
5. Provision the least-privilege organizer database credential, inference key,
   exact model and operating allowance.
6. Run a one-revision organizer canary, inspect evidence and provider usage, then
   backfill historical revisions before enabling continuous processing.
7. Configure SMTP and validate real invite/public-signup email flows.
8. Exercise backup restore, credential rotation, backlog monitoring and recovery
   for terminal memory failures and persistent `needs_attention` deliveries.

These activities require explicit production credentials and operator approval.
Local fixtures and test doubles must not be reported as live validation.

## Product work not yet started on `main`

### Web inbox

The original MVP requires a browser inbox showing messages, delivery and
execution state, failures, retry and channel closure. The current server exposes
onboarding and receiver-consent pages but no inbox application.

A safe first implementation slice is read-only: authenticated message listing,
sender, preview, timestamps and transport status. Mutation controls should be
designed after the conversational state model is settled.

### Automatic context assembly for incoming work

Memory retrieval tools exist, but native incoming-task prompts currently contain
the sender, conversation identifiers and task text rather than an automatically
selected memory package. The original MVP calls for bounded relevant memory and
recent channel history to accompany the delegated task, with citations and an
explicit untrusted-data boundary.

### Pilot measurement

The five-user, 20-handoff, 70-percent success validation has not been run. Define
the observation method and completion criteria before recruiting pilot users.

### Additional platforms and devices

The current recipient flow requires macOS and uses `/bin/sh`, Unix sockets and
Keychain. Windows, Linux and multi-device receiver handoff are not part of the
current supported release and require separate architecture and validation.

## Work intentionally kept outside `main`

`codex/conversational-messaging` adds durable replies, conversation history,
response obligations, pause/resume/repair controls and a supervised background
receiver. It is a substantial independent workstream and must not be treated as
merged functionality until it is integrated, reviewed and live-tested.

`codex/v1-client-baseline` is already contained in `main` through pull request
#1. `codex/archive-v1-client-baseline-2026-09-01` is an obsolete divergent
prototype containing the old version-controlled wiki and should not be used as a
development base.

## Current scope boundaries

The MVP excludes agent discovery, group channels, attachments, non-Codex
runtimes, cloud execution, automatic Git push/merge/deployment, automatic idle
wake-up in the merged implementation, detailed sharing policies and automatic
multi-device handoff.

Start new work from the latest `main`, use a focused branch and pull request, add
tests for behavior changes, and preserve the security and idempotency invariants
documented in [Architecture](architecture.md) and
[Cloud service operations](cloud-memory-operations.md).
