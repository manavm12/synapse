# Incoming tasks through the Synapse plugin

Install Synapse, sign in, and accept **Enable incoming tasks** in Codex. The
bundled setup skill selects a saved local Git receiving project and opens browser
consent. Any active signed-in Synapse user can send tasks after explicit opt-in.
There is no separately installed runner. See [Setup](setup.md).

## Authentication and enrollment

The skill calls `get_identity` through the existing OAuth connection and records
the exact account/cloud-project IDs locally. The helper creates a receiver
credential in macOS Keychain, returning only its SHA-256 hash.
Authenticated `begin_receiver_setup` derives the expected identity from the
server's OAuth context and returns a pairing ID, consent URL, expiry, and identity.

The helper verifies both IDs and the exact configured origin and pairing path
before opening the URL. Browser approval must match the expected identity,
including when another account has an identical alias. Completion checks live
receiver authorization before activating the saved destination. Healthy existing
enrollment is reused after live validation. Unbound legacy pending pairings are
retired by explicit setup, never silently adopted as account-bound pairings.

Approval progress is visible. One five-minute deadline covers browser opening,
network requests, sleeps, and Keychain operations; interruption retains resumable
state. Status and reconnect are available through the skill. Raw receiver
credentials and OAuth tokens never enter command arguments or conversation
history. Local paths and native task IDs never go to the cloud.

## Delivery and recovery

Any local user prompt can wake the asynchronous hook: unrelated projects,
projectless chats, and linked worktrees all use the selected destination.
Per-receiver leases serialize overlapping checks. Each invocation is bounded,
claims at most ten messages per checked receiver, and makes at most one native
delivery attempt. Locally recorded Synapse delivery markers suppress generated
prompts as fresh triggers. Idle Codex never polls.

Cloud payloads are staged durably in SQLite before import confirmation. Only
confirmed imports may route. Ordering, stable delivery IDs, temporary-ID
acceptance, permanent-task reconciliation, and outbox receipts remain unchanged.
Native mutations are fenced on disk before issuance and require fresh receiver
authorization. A missing or ambiguous response becomes `needs_attention`;
automatic replay is forbidden.

The selected destination and incoming content never enter unrelated triggering
chats. Legacy local-only queue messages remain scoped to prompts in their own
primary checkout. Ten-turn memory capture remains independent of receiving.

Disable removes the local destination and revokes future receiver access; it
cannot cancel tasks already accepted by Codex. The revoke-only endpoint accepts
a matching expired credential, so expiration does not prevent disconnect.
Network/Keychain cleanup failures preserve recoverable local state. Queued work,
memory databases, credentials not explicitly revoked, and native task bindings
are preserved across plugin reinstalls. A replacement installation does not
silently inherit old assigned messages or channels.

## Compatibility and release

All runtime code ships under `plugins/synapse` and imports only bundled modules
or Node built-ins. Setup and every hook share the Codex-supplied runtime launcher,
which checks SQLite capability and has no system-Node fallback. Hooks require
Codex trust; the setup skill/starter remains independently accessible.

Apply `202609090001_bound_receiver_setup.sql` and deploy endpoint/tool support
before releasing the updated plugin. Existing connected receivers and v1
transport endpoints remain compatible. Repository receiver CLI commands remain
developer/recovery wrappers, not a recipient prerequisite.
