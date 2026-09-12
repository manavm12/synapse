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
acceptance, permanent-task reconciliation, and outbox receipts remain durable.
Native mutations are fenced on disk before issuance and require fresh receiver
authorization. A missing or ambiguous response becomes `needs_attention`;
automatic replay is forbidden.

The child startup hook is a fast binding path, not the only one. After creation
and during background receiver cycles, the installed plugin can resolve an accepted
temporary ID using Codex's local client-ID map, then independently verify the
native `read_thread` delegation, source task, local delivery marker, host, and
Git worktree ancestry. The local map is read-only compatibility data, never proof
of delivery. Unknown formats, duplicate aliases, mismatches, and unavailable
native APIs preserve the existing fence; no second task is created. New cloud
prompts carry the local receipt before their body as well as the terminal marker,
so the native API's 20,000-character output cap does not prevent large messages
from being reconciled. Receipts flush during the same bounded check and the supervised receiver retries
independently of owner prompts.

Setup separates connected enrollment from verified prompt hooks. A recent receipt
from the current chat and exact installed build is required for `ready`; stale
builds and missing hooks yield `hooks_pending`. The first-use guidance points to
the installed skill even before the current task's skill catalog has refreshed.

The supervised macOS LaunchAgent checks receiver authorization, flushes durable
receipts, claims batches of ten messages, and stages each message and its import
acknowledgement in one SQLite transaction. It polls every two seconds while
Codex is available and backs off to sixty seconds during outages. A staged
message cannot be sent to Codex until the server confirms ownership by this
installation. Session hooks register the signed runtime and wake the service.

```sh
npm run synapse -- receiver start
npm run synapse -- receiver stop
npm run synapse -- receiver status .
```

An explicit stop persists across hook wakeups until `receiver start`. The service
uses the signed runtime for desktop task creation and the existing app-server's
queue API for continuations. It never starts a competing app-server or extracts
Codex OAuth credentials. `doctor` checks both interfaces; an unavailable queue
keeps the message locally pending. See [Conversations](conversations.md) for
reply behavior, pause/resume, recovery, and rollout requirements.

Native task creation and continuation are fenced on disk before the mutation.
Immediately before issuing either mutation, routing checks the current local
binding and fresh cloud authorization, then rechecks the local binding after
the network response. Disconnecting or rebinding during that check denies the
stale reservation. Revocation after the final check cannot atomically undo a
native mutation that is already being issued.
If Codex may have accepted a mutation but its response is lost or malformed,
the job becomes `needs_attention`; Synapse does not automatically repeat it.
Receipt upload failures remain in a local outbox for the next receiver cycle. A cloud
failure never prevents legacy local messages from routing and the background
hook never blocks the foreground prompt.

## Compatibility and release

All runtime code ships under `plugins/synapse` and imports only bundled modules
or Node built-ins. Setup and every hook share the Codex-supplied runtime launcher,
which checks SQLite capability and has no system-Node fallback. Hooks require
Codex trust; the setup skill/starter remains independently accessible.

Apply migrations through `202609090003_conversations.sql` and deploy endpoint/tool support
before releasing the updated plugin. Existing connected receivers and v1
transport endpoints remain compatible. Repository receiver CLI commands remain
developer/recovery wrappers, not a recipient prerequisite.
