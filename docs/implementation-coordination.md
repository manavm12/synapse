# Active product integration

The user has now authorized implementing the complete integration and has asked
the parent task to orchestrate, inspect every task, and test the combined result.
This supersedes the earlier planning-only and library-only phase limits. Keep
the original organizer worktree intact, preserve memory capture compatibility,
and retain the selected any-signed-in-user receiving policy after receiver opt-in.

The parent integration branch is `codex/product-integration` at
`/Users/manavmehta/synapse-integration`. Feature tasks commit locally; the parent
reviews and cherry-picks specific commits. No feature task merges to main,
changes production infrastructure, or changes installed user plugin settings.
The user approved up to US$5 total for fresh live validation. The parent owns
the budget and live requests centrally; feature tasks must not spend separately.

## Ownership

- Setup task: finish setup/doctor; retain its commit for parent integration.
- Memory queue task: owns `src/server/memory-processing/` and migration
  `202609070002_memory_processing_queue.sql`; commit and provide worker contract.
- Memory core task: extend its core result with a tenant-isolated Postgres ledger
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

## Active task registry

| Task | Task ID | Branch / first feature commit |
| --- | --- | --- |
| Setup and diagnostics | `01a07ab5-5c30-7e80-ad9a-9cc106876b83` | `codex/local-setup-doctor` / `a58518c` |
| Processing queue | `01a07ab5-5c30-7e80-ad9a-9cb9a912f923` | `codex/memory-processing-queue` / `243fcc9` |
| Organizer core and adapter | `01a07ab5-5cdc-7f21-a1a6-29eca009d27d` | `codex/deterministic-organizer-core` / `8731509` |
| Cloud messaging backend | `01a07abf-8c82-7b90-adf3-59d2684b992a` | `codex/messaging-backend` |
| Receiver client and hooks | `01a07abf-8bda-7623-8ce1-781b69e05e76` | `codex/local-receiver-client` |

Independent reviews cover the setup, queue and organizer commits. Passing tests
alone is not acceptance: reproduced findings require regressions and a re-review.
Dependency cherry-picks in feature worktrees are not new feature commits.

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
   account for each receiver request. Receiver credentials cannot call MCP or
   access memory/account management.
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
   cannot be confirmed. Preserve staged jobs until ownership is verified.
7. `GET /receiver/messages/:message_id` returns assignment/transport status for
   that installation only, including `{message_id, status, imported}`. It can
   reconcile a lost import response and cannot expose another installation's job.
8. `POST /receiver/events` with `{events: [{event_id, message_id, kind,
   occurred_at, error_code?}]}` returns `{accepted_event_ids: [...]}`. Kinds:
   `provisioning`, `delivered`, `needs_attention`. Deduplicate stable event UUIDs,
   validate installation ownership and transitions, and never regress delivered.
   No native Codex IDs, paths, or message contents belong in these receipts.
9. `POST /receiver/disconnect` disables/revokes this receiver and returns
   `{disconnected: true}`; it does not claim to cancel already-dispatched tasks.

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
handoff to another device; registration must not strand or duplicate an existing
installation's work. Cloud public status: `queued`, `in_receiver_inbox`,
`provisioning`, `delivered`, `needs_attention`.

Local import stages immutable payload plus an import acknowledgement outbox
record in one SQLite transaction. Stage -> routable only after cloud confirms
that same installation. Native status changes and receipt outbox entries also
commit together. An ambiguous native mutation response requires reconciliation,
not automatic replay. Network failure must not block the owner prompt.

Use existing sender OAuth for MCP `send_message`, `get_message_status`, and
`list_inbox`. Keep `get_identity` and `save_session_memory` compatible. Sender
cannot select a receiver's local path, native task ID, git state or permissions.

Feature tasks may adjust internal APIs. Wire/schema changes require reporting
the exact correction to the parent before clients and server diverge. Tests use
isolated homes, fake secret/native clients, and disposable Postgres.
