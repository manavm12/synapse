# Active product integration

The user has now authorized implementing the complete integration and has asked
the parent task to orchestrate, inspect every task, and test the combined result.
This supersedes the earlier planning-only and library-only phase limits. Keep
the original organizer worktree intact, preserve memory capture compatibility,
and retain the selected any-signed-in-user receiving policy after receiver opt-in.

The parent integration branch is `codex/product-integration`. Feature tasks
commit locally; the parent
reviews and cherry-picks specific commits. No feature task merges to main,
changes production infrastructure, or changes installed user plugin settings.
The user approved up to US$5 total for fresh live validation. The parent owns
the budget and live requests centrally; feature tasks must not spend separately.

## Implementation and review checkpoint

The integration branch now contains setup/doctor, immutable capture plus a
durable processing queue, the deterministic organizer core and Postgres adapter,
bounded inference, authenticated lexical retrieval, cloud messaging, and the
receiver client/hooks. This is an assembled candidate, not a deployment claim.
The HTTP service and `npm run worker` remain separate; the worker is opt-in and
requires dedicated credentials and explicit models.

The setup login-output bug, database URL TLS override, queue scheduling/locking
findings, core source-replay checks, messaging import authorization/quota/expired
revocation findings, and retrieval discovery/historical-topic findings have
corrections integrated. Independent re-review cleared the receiver's local
identity, dispatch/revocation races, reconnect isolation, bounded response reads,
and resumable cancellation, plus backend atomic approval/cancellation. The
combined disposable-Postgres gate passed 182 tests without failures or skips.
This is local acceptance; live deployment gates below remain outstanding.

Local fixtures, real subprocess tests, and disposable Postgres are distinct from
live OAuth/email, real macOS/native-task operation, and paid semantic-quality
validation. At this checkpoint, the US$5 live-validation allowance is unspent
and an inference key is unavailable. Do not silently spend in feature tasks or
label mocked model output as live inference.

The existing task “Plan session memory graphing”
(`01a0753c-ff61-7951-9b7c-d2a2fabb33c9`) supplied organizer design and fixtures.
Its historical 28/34 retrieval result did not meet its prior quality target;
that result does not establish this integration's semantic recall. Keep the
original `codex/local-memory-organizer` worktree unchanged.

## Ownership

- Setup task: owns setup/doctor and interactive-login regressions.
- Memory queue task: owns `src/server/memory-processing/` and migration
  `202609070002_memory_processing_queue.sql`; commit and provide worker contract.
- Memory core task: owns its deterministic core and tenant-isolated Postgres ledger
  adapter and inference handler in `src/server/memory-organizer/` and migration
  `202609070004_memory_ledger.sql`, reusing the existing graphing experiment.
- Messaging backend task: owns `src/server/messaging/`, receiver server pages and
  routes, migrations `202609070001_cloud_messaging.sql` and
  `202609070003_receiver_connections.sql`, and messaging MCP registration.
- Receiver client task: owns `src/client/receiver/`, plugin receiver modules,
  native inbox/router/hooks changes, and small CLI dispatch additions.
- Retrieval task uses the published ledger contract; it owns retrieval
  service and MCP registrations. Parent resolves registration/CLI/manifest
  overlaps and owns server/worker startup integration and combined testing.

## Task registry

| Task | Task ID | Branch / integrated commits |
| --- | --- | --- |
| Finish Synapse setup and diagnostics | `01a07ab5-5c30-7e80-ad9a-9cc106876b83` | `codex/local-setup-doctor` / `cc3647d`, `8d1ddef` |
| Build Synapse memory processing queue | `01a07ab5-5c30-7e80-ad9a-9cb9a912f923` | `codex/memory-processing-queue` / `cd8584f`, `5db01dd` |
| Prepare Synapse memory organizer core | `01a07ab5-5cdc-7f21-a1a6-29eca009d27d` | `codex/deterministic-organizer-core` / `01c3392`, `38b73e8`, `480e602`, `2501fc2` |
| Implement Synapse cloud messaging backend | `01a07abf-8c82-7b90-adf3-59d2684b992a` | `codex/messaging-backend` / `0c5af7c`, `2c15faf`, `c5f6ffc`, `92b73db` |
| Implement Synapse receiver client and hooks | `01a07abf-8bda-7623-8ce1-781b69e05e76` | `codex/local-receiver-client` / `ba78f2e`, `93573ed`, `136dc5e`, `26b4628` |
| Implement Synapse cloud memory retrieval | `01a07ac2-52f4-7a00-853e-16be4acb5588` | `codex/cloud-memory-retrieval` / `0ace619`, `670e1fd` |

Independent reviews cover feature boundaries and the combined composition.
Reproduced findings require regressions and a re-review.
Dependency cherry-picks in feature worktrees are not new feature commits.

Parent-owned integration includes the bounded worker lifecycle, shared TLS
connection validation (`526b6c2`), separate worker entrypoint, retrieval startup
composition, and guarded live evaluation (`79e0cf2`). Deployment instructions in
[Cloud operations](cloud-memory-operations.md) supersede the old phase-only
limits in planning documents.

## User and deployment sequence

1. Operator applies all migrations, provisions separate runtime/worker roles,
   verifies TLS and reverse-proxy configuration, and configures Supabase
   OAuth/email. Private repository access is required for local installation;
   arbitrary external email signup requires custom SMTP.
2. User runs setup with the cloud project alias, then verifies `get_identity` in
   a fresh task. A doctor login receipt does not establish live token validity.
3. Receiver enrollment is `receiver connect` → browser **Enable incoming tasks**
   → `receiver finish`. The explicit policy accepts any active signed-in sender.
4. A receiver's owner-prompt hook syncs and routes confirmed cloud jobs; there is
   no continuously polling receiver daemon. Transport `delivered` is native
   acceptance, not completed work.
5. Operator separately enables `npm run worker` with its own database credential,
   inference key, explicit model and spend limit. Capture remains available while
   organization is disabled; source reads can precede derived retrieval.
6. Parent completes independent review and the serialized disposable-Postgres
   release gate before any approved real-user/native/paid-model smoke tests.

## Receiver transport contract v1

All snake_case below is wire format. Use HTTPS in production, localhost HTTP
only under explicit test/development configuration. A receiver credential is
`syn_recv_` plus 32 random bytes encoded base64url; the client generates and
stores it securely. The server stores SHA-256 of the entire credential string.
Never print credentials or expose them through command arguments.

1. `POST /receiver/pairings` with `{credential_hash}` returns
   `{pairing_id, verification_url, expires_at}`. Pairings expire after 10 minutes.
   Creation is unauthenticated, bounded and rate-limited; it cannot enable a
   receiver. Reusing the same pending credential hash is replay-safe.
2. `POST /auth/receiver-pairings/:pairing_id/approve` with a verified Supabase
   browser session binds the pairing to that session's user/project and enables
   incoming tasks from any active signed-in user. Show explicit consent in the
   server-owned browser UI. Never accept a user/project UUID from browser input.
3. `POST /receiver/pairings/:pairing_id/complete`, bearer receiver credential,
   returns HTTP 202 `{status: "pending"}` until approved, then HTTP 200
   `{status: "connected", identity: ReceiverIdentity}`. Repeats return the same
   identity; the server never issues a secret in a response.
4. `GET /receiver/identity`, bearer receiver credential, returns
   `{identity: ReceiverIdentity}`. Recheck enabled status, expiry, and active
   account for operational receiver requests. The revoke-only endpoint below
   intentionally accepts a matching expired credential. Receiver credentials
   cannot call MCP or access memory/account management.
5. `POST /receiver/claim` with `{limit: 10}` returns
   `{identity: ReceiverIdentity, messages: [CloudMessage]}`. Initial lease is
   60 seconds; the assigned installation persists beyond lease expiry. Claim
   excludes imported tasks; local staged records can reconcile through the
   import endpoint or a read of the assigned message's state. An expired claim
   may be reissued to the same installation with a new token.
6. `POST /receiver/import` with `{message_id, claim_token}` confirms SQLite
   persistence and returns `{message_id, status: "in_receiver_inbox"}`. Exact
   repeats after confirmation succeed for the same installation even if the
   original lease elapsed. Before confirmation, an expired/superseded claim
   cannot be confirmed. Unassigned jobs and absent/mismatched tokens are always
   rejected. Preserve staged jobs until ownership is verified.
7. `GET /receiver/messages/:message_id` returns assignment/transport status for
   that installation only, including `{message_id, status, imported}`. It can
   reconcile a lost import response and cannot expose another installation's job.
8. `POST /receiver/events` with `{events: [{event_id, message_id, kind,
   occurred_at, error_code?}]}` returns `{accepted_event_ids: [...]}`. Kinds:
   `provisioning`, `delivered`, `needs_attention`. Deduplicate stable event UUIDs,
   validate installation ownership and transitions, and never regress delivered.
   No native Codex IDs, paths, or message contents belong in these receipts.
9. `POST /receiver/disconnect` cancels the known pairing and revokes any
   installation, including approval that local completion did not record. It returns
   `{disconnected: true}`. A matching expired/revoked credential can only repeat
   revocation, not claim or read jobs. Unfinished assigned jobs become
   `needs_attention` without changing installation ownership. This does not
   cancel already-dispatched tasks or automatically hand work to another device.
   Cancellation and approval lock pairing before installation; cancelled
   pairings cannot be approved or reuse their credential for another enrollment.

`ReceiverIdentity` is `{installation_id, user_id, username, project_id,
project_alias, expires_at, enabled: true}`. UUIDs and names come from the server.

`CloudMessage` is `{version: 1, message_id, conversation_id, sequence,
sender: {user_id, username}, recipient: {user_id, project_id}, message,
content_hash, claim_token, lease_expires_at}`. `content_hash` is SHA-256 of exact
UTF-8 message bytes. Idempotent send also compares the normalized recipient and
conversation selection. Sequence is monotonically increasing per conversation;
inbound sequence numbers need not be contiguous because replies have the other
recipient. Native payload assembly must remain below 64 KiB.

Use one enabled receiver installation per user/project initially. No automatic
handoff to another device; reconnecting requires explicit revocation of an old
installation, and its assigned jobs require separate reconciliation. Cloud
public status: `queued`, `in_receiver_inbox`,
`provisioning`, `delivered`, `needs_attention`.

Local import stages immutable payload plus an import acknowledgement outbox
record in one SQLite transaction. Stage -> routable only after cloud confirms
that same installation. Native status changes and receipt outbox entries also
commit together. An ambiguous native mutation response requires reconciliation,
not automatic replay. Network failure must not block the owner prompt.
Local conversation channels include the installation ID, so new installations
can receive future messages without inheriting old jobs or native task bindings.

Historical captures have an operator-only, dry-run-first bounded backfill command;
it requires exact owner/project scope and never resets existing jobs or invokes
inference. A separately enabled worker may consume newly enqueued jobs.

Use existing sender OAuth for MCP `send_message`, `get_message_status`, and
`list_inbox`. Keep `get_identity` and `save_session_memory` compatible. Sender
cannot select a receiver's local path, native task ID, git state or permissions.
Quota defaults are 100 sends per sender per hour and 1000 unfinished messages
per recipient; the operator can change the corresponding `app_config` values.
Sorted participant locks serialize both checks under concurrent sends.

Feature tasks may adjust internal APIs. Wire/schema changes require reporting
the exact correction to the parent before clients and server diverge. Tests use
isolated homes, fake secret/native clients, and disposable Postgres.
