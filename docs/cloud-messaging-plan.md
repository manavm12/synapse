# Cloud messaging bridge: step 1 implementation plan

Status: planned, not implemented. Baseline: main `02f9839`, 7 September 2026.
See [parallel workstreams](integration-workstreams.md) for work already delegated.

## Outcome and dependencies

Alice can ask her agent to send Bob a task by username. The authenticated MCP
server commits the task to Bob's cloud inbox and immediately returns its ID and
status. Bob's enabled receiver downloads it on an eligible owner prompt, persists
it, and uses the existing native Codex router. Alice can inspect delivery status.

The send request waits only for authentication, validation, and the database
commit. It never waits for Bob, Codex worktree provisioning, memory organization,
or retrieval. Bob may be offline for hours. No continuous daemon or realtime
subscription is required for the first release.

Messaging depends on existing profiles/projects, OAuth, Postgres, and the local
inbox/router, all already on main. Setup improvements, the memory processing
queue, and the organizer core can proceed in parallel. The two kinds of jobs
need separate state machines and permissions; a shared queue framework is not
a prerequisite. Memory retrieval remains a later milestone.

## Observed implementation constraints

- `src/client/cli.mjs:sendMessage` currently resolves a LOCAL checkout and calls
  SQLite `queueMessage`. Its channel ID does not identify a cloud user.
- `src/server/mcp.mjs` currently exposes only identity and memory save. Preserve
  those tools and their schemas while adding messaging registration/discovery.
- `profiles` RLS allows a user to see their own record. Resolving a recipient
  needs a narrow database function, not permission to read all profiles/emails.
- `projects.owner_id` is unique. Use the recipient's one project, determined by
  the server; never accept a sender-supplied local destination path.
- `host.sqlite` currently maps aliases to paths only. A receiver must bind the
  authenticated user/project UUIDs as well, so an alias reused after an account
  switch cannot consume another user's queue.
- `queueMessage` is not replay-idempotent for a repeated job ID. Cloud import
  needs a dedicated idempotent transaction and payload/identity comparison.
- The receiver hook runs only from a primary checkout. Its background command
  already reserves one local job and invokes native desktop tools. Keep this
  eligibility boundary and the independent child SessionStart binder.
- Local `completed` means delivered to a native task. It does not mean the agent
  completed the work. Cloud status must express that distinction.
- `runReservedDelivery` presently sends every thrown routing error to a retry
  path. A native mutation timeout is ambiguous and must not authorize a second
  automatic send/create for a cloud job.
- A read-only app-tools catalog probe from this planning process closed its
  pipe connection. Local fixture tests passed in the previous assessment, but
  current live hook compatibility needs a focused check in the integration phase.

## Product defaults

- Keep one cloud project per user and initially one enabled receiver installation
  per project. A second laptop is a future capability with explicit ownership
  transfer; no silent takeover when a heartbeat expires.
- A conversation has exactly two authenticated participants and a server UUID.
  A first send creates it; following sends/replies reuse the returned UUID and
  are allowed only between its participants. Each participant has their own
  local native task binding. A new conversation creates a separate native task.
- Public usernames are case insensitive; normalize an optional leading `@` at
  the input boundary. Internal authorization always uses UUIDs.
- User decision: receiving must be explicitly enabled by the receiver; after
  that, any signed-in active user may send tasks which the hooks automatically
  route. No sender allowlist or per-message approval is required. Before enabling
  receiving, messages can wait in the durable inbox but cannot auto-dispatch.
- Delivery receipts are supported. Agent execution results, automatic replies,
  attachments, cancellations after handoff, organizations, and multi-project
  routing are separate later features.
- Accept messages up to 60 KiB UTF-8 and ensure the rendered native prompt stays
  within the existing 64 KiB bound after metadata and markers are added.

## First milestone: durable cloud send and status

Add `202609070001_cloud_messaging.sql` and a focused
`src/server/messaging/` module. Do not modify historical migrations or the
memory-processing task's reserved `202609070002` migration.

Proposed tables across the three milestones, with names finalized in migration
review. The first milestone creates only conversations and jobs. Receiver tables
and receipt events arrive in an independent additive
`202609070003_receiver_connections.sql` migration in milestone two.

| Table | Milestone | Purpose and essential constraints |
| --- | --- | --- |
| `message_conversations` | 1 | Two participant UUIDs, creation time, per-conversation sequence counter; immutable membership. |
| `message_jobs` | 1 | Message UUID, conversation, sequence, sender, recipient and recipient project UUIDs, exact message body/hash, sender request UUID, status and timestamps; unique `(sender_id, request_id)` and `(conversation_id, sequence)`. |
| `message_delivery_events` | 2 | Append-only transport receipts with stable event UUID, message, receiver/attempt identity, transition and safe error code; unique event UUID. No task body in logs/events. |
| `receiver_installations` | 2 | Subordinate installation identity, owner/project, enabled/revoked state, credential hash/expiry and last contact; one active installation per project initially. |
| `receiver_pairings` | 2 | Expiring one-time browser enrollment challenge and decision; no stored plaintext long-lived credential. |

Keep transport attempt metadata separate from immutable message identity. Generate
sequence numbers under a conversation lock. Enqueue, status selection,
dedupe, and audit happen in one transaction. A repeated request UUID with exactly
the same normalized recipient/conversation/body returns the same message. Reusing
it with different content returns a conflict and creates no second job. Resolve
an exact replay before applying new-send quotas.

Use a tightly scoped `SECURITY DEFINER` function to resolve one active username
and enqueue on behalf of the verified caller. Fix its search path, revoke public
execution, and validate caller identity/status and conversation membership inside
the function. Do not grant cross-user access to `profiles`, projects, or memory.
Read policies permit the sender/recipient to inspect only their own messages;
receiver mutation policies/functions permit only the intended recipient and
assigned installation. Composite keys/FKs bind message, recipient, and project.
Test database grants/functions, not only route-level checks.

Add these authenticated MCP tools using existing OAuth:

| Tool | Input | Result |
| --- | --- | --- |
| `send_message` | `to_username`, `message`, required stable `request_id`, optional `conversation_id` | `message_id`, `conversation_id`, sequence, normalized recipient, queued status, `idempotent` |
| `get_message_status` | `message_id` | Participant-visible delivery status, timestamps, safe failure reason and whether receiver action is needed |
| `list_inbox` | Cursor, bounded limit, optional status filter | Authenticated user's inbound messages and delivery state |

Enabled receivers automatically route tasks from any authenticated active user.
Incoming text runs in the separate native task, never in the owner task.
No searchable email directory. Invalid or disabled recipients get a
bounded user-facing error. Start with configurable per-sender send limits and
recipient pending-message caps, enforced across server replicas.

This milestone can be implemented, reviewed, and tested before any hook change.
Its acceptance boundary is two provisioned test users, send/replay/conflict,
participant status reads, nonparticipant denial, and durable queue persistence.

## Second milestone: receiver enrollment and cloud-to-local handoff

### Authentication

Use the current OAuth identity for agent-facing MCP. The background command
needs its own narrow receiver credential: claim/import/receipt operations for
one owner's project, with no memory-read/write, send-message, or account powers.
Do not extract Codex's stored OAuth token or assume the desktop app-tools pipe
can proxy arbitrary remote MCP calls.

Add a `synapse receiver connect` CLI flow:

1. Generate a 32-byte random receiver secret locally and save it in the OS
   credential store as a pending connection. Begin a short-lived enrollment
   challenge over HTTPS using its SHA-256 hash. Keep local checkout paths out
   of this exchange. The secret never needs to appear in a server response.
2. Open the Synapse enrollment page. Reuse existing Supabase email login/session
   verification and show the username/project being connected. The receiver
   explicitly enables this installation with the explanation that signed-in
   Synapse users can send tasks for automatic routing to this project.
3. Approval is authenticated and atomically binds the credential hash to the
   verified owner/project. Polling/finishing proves possession of the private
   secret, only over HTTPS. Repeating finish returns the same nonsecret
   installation IDs; it never creates another live receiver or rotates the
   secret. Use expiring, rate-limited pairing records. Do not expose the
   credential in browser URLs, agent prompts, logs,
   command-line arguments, or status output.
4. Finalize the pending credential-store record through an injectable adapter.
   For the existing macOS client, implement Keychain first.
   Use a fake credential store in tests; unsupported platforms fail with useful
   setup guidance rather than silently storing plaintext secrets.
5. Save nonsecret user/project/installation IDs beside the local mapping. Show
   connected identity and connection expiry through receiver diagnostics. Add
   revoke/disconnect and renewal through enrollment. Credentials expire; a
   revoked/disabled account or installation is rejected on every request.

The local pending record and server pairing ID make interrupted enrollment
resumable. A lost finish response is safe because the client already holds the
secret; finishing again returns the same identifiers. The server stores hashes
only. Expired unapproved pairings can be restarted without creating an active
receiver. Account/installation revocation remains effective on every request.

### Transport and ownership

Add authenticated `/receiver/*` REST endpoints backed by the messaging service:
claim a bounded batch, confirm durable import, submit delivery events, and inspect
an assigned message's handoff state. Limit the default batch to 10 messages and
one native dispatch per owner hook. Use per-conversation ordering and a short
lease for transfer; persist the installation assignment beyond lease expiry.

On an eligible owner prompt, the background receiver does the following:

1. Resolve the local project and verify its user/project/installation binding.
2. Flush durable pending receipts from earlier runs with stable event IDs.
3. Claim eligible messages, ordered by server sequence. A claim grants no native
   execution permission until the cloud-to-local handoff completes.
4. In ONE SQLite transaction, persist exact message/provenance, cloud job ID,
   conversation/sequence, payload hash, and an import-ack outbox entry. Store the
   job as staged and ineligible for native dispatch.
5. Confirm import to the cloud using the installation ID and fenced attempt.
6. When cloud ownership is confirmed, atomically mark the staged job routable.
   Then call the existing local router for one eligible job.

Use cloud message UUID as the stable local job ID. Derive a namespaced local
channel from recipient UUID and conversation UUID, within the 128-character
identifier limit. Do not reuse user-entered legacy channel names. A repeated
download compares exact identifiers, hash, and payload and becomes a no-op;
changed data under the same ID fails visibly. Preserve explicit server sequence
ordering in SQLite rather than relying on timestamps or random UUID sorting.

If a reply arrives in the same conversation, it uses that receiver's existing
native task binding. The sender can never choose the receiver's path, Codex
project ID, thread ID, Git ref, or security settings.

### Recovery invariants

| Failure | Required result |
| --- | --- |
| Receiver offline | Message remains cloud-queued. |
| Download response lost | Retry obtains the same assigned message; no deletion-on-fetch. |
| Crash before SQLite commit | Cloud retains the task for redownload. |
| Crash after local commit, before import acknowledgement | Staged job cannot execute; retry confirms the existing import. |
| Import acknowledgement response lost | Read/retry proves the same installation owns the task; then activate that local job once. |
| Crash after server confirmation, before local activation | Reconcile the staged record on the next prompt without importing a second job. |
| Receiver credential revoked | No new download/confirmation/dispatch authorization. Already dispatched work is not advertised as canceled. |
| Second machine appears | No automatic reassignment of handed-off work; old native task IDs are local to its installation. |
| Native create/send may have succeeded but response is lost | Preserve uncertain state, block that channel, and reconcile or request receiver recovery. Never blindly retry the native mutation. |
| Receipt upload fails | Local outbox retains the event; retry independently of native dispatch. |

The protocol provides replay-safe transport and local dedupe. Exactly-once
external Codex execution cannot be promised without a proven native idempotency
or reconciliation contract. Uncertainty must be visible and recoverable.

## Third milestone: native dispatch, receipts, and integration tests

Keep the existing asynchronous `UserPromptSubmit` command and child binder.
Put receiver transport in new plugin-local modules so the installed plugin is
self-contained. Update `inbox.mjs`, `native-router.mjs`, and child binding only
for the needed cloud metadata, activation, certainty classification, and receipt
outbox transactions. Preserve legacy local sends.

Before a native mutation, durably record intent. Failures before issuing the
mutation may retry. After issuing it, timeout/disconnect/malformed responses are
uncertain unless failure is proven. Temporary client ID means `provisioning`;
independent child observation of its permanent ID means `delivered`. Existing
task sends become delivered only after native acceptance. Preserve delivery
markers and verify provenance; marker text alone never authenticates a sender.

Use this public state progression:

```text
queued
  -> in_receiver_inbox
  -> provisioning (new native task only)
  -> delivered

Explicit failures/ambiguous handoffs -> needs_attention
```

Transfer leases, staged records, and mutation intent are internal states. Events
are deduped and validated against a transition graph; stale/out-of-order receipts
cannot regress `delivered` to queued/provisioning. Keep native task IDs local;
return cloud IDs/status to the sender. Do not add `completed` as a public status
until actual agent execution completion is instrumented separately.

Set bounded network timeouts under the background hook budget. An unavailable
cloud connection must not block the user's foreground prompt. For new native
dispatches, obtain a fresh installation/account-enabled check in the receiver
sync response; if the cloud is unavailable, confirmed jobs remain safely local
until the next authorized sync. Staged/unconfirmed jobs stay put. There is an
unavoidable race between authorization and native dispatch; revocation cannot
undo work already accepted by Codex. On session cancellation, all recoverable
state must already be on disk or in Postgres. Empty inbox checks stay quiet.

Test in isolated homes, fake native tool clients, and disposable Postgres:

- Two users plus an unauthorized third user; exact/replayed/conflicting sends.
- RLS and restricted receiver credential permissions, account/project mismatch,
  username normalization, and unauthorized conversation reuse.
- Ordering across multiple messages, participants, simultaneous owner prompts,
  duplicate claims and two receiver installations.
- Every crash boundary in the table above, stale leases, delayed receipts,
  native temporary ID races and no duplicate after ambiguous mutation responses.
- Disabled/revoked receivers, failed pairing, expiry, and safe credential output.
- Existing local inbox/native routing and all cloud memory tests remain green.
- An explicit live two-user smoke test once the implementation is approved and
  connected test identities exist: Alice sends while Bob is offline, Bob's next
  eligible prompt produces one native task, a second same-conversation message
  continues it, and Alice observes delivered status. Separately verify foreground
  progress while the relay is slow/unavailable.

## Code ownership and integration

Messaging owns new `src/server/messaging/`, receiver authentication/REST routes,
new `src/client/receiver/`, new plugin receiver modules, messaging migration,
delivery tests, and focused additions to MCP registration and native hooks.

Coordinate small shared-file edits (`src/client/cli.mjs`, server boot/config,
package scripts, plugin manifest) after independent tasks commit. Setup owns its
new modules and setup/doctor dispatch; memory queue owns the memory-save enqueue
point. Keep existing exports stable and introduce focused registration helpers
when adding messaging tools so new discovery does not drift from implementation.

Recommended first implementation is the durable cloud send/status milestone.
Then implement receiver enrollment/handoff, followed by native delivery receipts
and end-to-end recovery tests. Each is a small reviewable change; this plan does
not authorize implementing all three immediately in the parent planning task.

## Documentation evidence

Official [MCP documentation](https://learn.chatgpt.com/docs/extend/mcp) describes
OAuth connections. Official [hook documentation](https://learn.chatgpt.com/docs/hooks)
specifies that MCP tool hooks are synchronous, whereas command hooks support
background execution. That is the reason for the separate receiver transport.
The docs do not establish a supported way for a command hook to borrow Codex's
OAuth credential; the plan does not assume one.

Correction to the earlier assessment: the GitHub wiki request showed an account
plan restriction, so failure to retrieve it does not establish that the wiki is
empty. This plan uses the user's stated product intent and inspected code/docs.
