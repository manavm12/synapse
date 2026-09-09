# Cloud memory architecture

## Boundary and identity model

```text
Codex task
  local hooks (schedule only)
        │ OAuth bearer token + capture/session/project attribution
        ▼
Railway: Synapse MCP resource server
  validate issuer + audience + expiry + scopes + client_id
  resolve Supabase user → profile → single project
        │ SET LOCAL app.current_user_id inside every transaction
        ▼
Supabase Postgres
  RLS-enforced current nodes + immutable revisions + audit events
        │ same transaction: revision + processing job
        ▼
Separate opt-in organizer worker
  bounded extraction/reconciliation/review outside write transaction
        │ validate immutable source + current fenced project lease
        ▼
Postgres claim ledger + evidence + topic projection
        │ tenant-scoped, read-only snapshots and source verification
        ▼
MCP memory_topics / search_memory / read_memory
```

The OAuth subject maps to `profiles.id` and is the authorization principal.
`agent_sessions.client_session_id`, `oauth_client_id`, runtime, auth method,
capture reason, and request ID are provenance. A caller cannot select a user ID
or cross to another user's project.

## Data model

| Relation | Purpose | Important invariant |
| --- | --- | --- |
| `profiles` | Product identity | One row per Supabase Auth user |
| `projects` | User's cloud workspace | Exactly one per owner |
| `agent_sessions` | Agent provenance | Unique client session per owner |
| `memory_nodes` | Current raw-memory tree | One root per project, one session node per project/session |
| `memory_revisions` | Immutable history | Unique capture ID and node revision |
| `audit_events` | Security/operation evidence | Records save and capture conflicts without content |
| `development_tokens` | Explicit local escape hatch | Hashed, expiring, revocable, disabled in production by default |
| `invites` | Closed onboarding | Reserves email, username, and project alias |
| `memory_processing_jobs` / project leases | Durable organization scheduling | One job per revision/version; fenced project-serial commits |
| `memory_ledger_sources`, claims, evidence and relations | Derived source-backed memory | Tenant-scoped append-only facts and exact revision offsets |
| `memory_projection_*` | Current browseable topic view | Deterministic projection of a checked ledger generation |
| `message_conversations` / `message_jobs` | Username-addressed tasks | Participant-only reads, stable request IDs, conversation sequence |
| Receiver installations, pairings and delivery events | Explicit local receiving | Scoped hashed credentials, immutable assignment and replay-safe receipts |

The HTTP service logs in as `synapse_runtime`, a non-superuser role with narrow
grants, sets verified identity only inside transactions, and cannot bypass
forced user-table RLS. Messaging uses narrowly granted security-definer
functions for cross-user enqueue and credential-scoped receiver operations;
clients cannot query installation secrets or write message tables directly.

The organizer uses a separate `synapse_memory_worker` credential. It can read
queued users' immutable sources and access the private scheduling tables;
derived ledger writes are checked against owner/project settings and lease
fences. This is a trusted backend, not a user credential. Administrator secrets
are absent from both services, and the inference key exists only in the worker.

## Write lifecycle

1. The local Stop hook counts distinct turn IDs in a private SQLite scheduler.
2. At ten turns it records a pending checkpoint with a fresh UUID. On the
   next user prompt, a private hook context requests the save without adding a
   synthetic message to conversation history. A compaction hook injects one
   immediately.
3. Codex calls `save_session_memory`; MCP validation rejects malformed or
   oversized content before a database transaction.
4. The server validates the OAuth JWT against Supabase JWKS, including exact
   issuer, exact MCP-resource audience, expiry, `client_id`, and required
   scopes. It resolves the subject to one active profile and project.
5. Postgres takes a transaction advisory lock for the capture ID. An identical
   prior revision returns its existing result; changed content records a
   conflict and fails.
6. A new write upserts session provenance, locks the session memory node,
   appends an immutable revision, updates the current node, and appends an
   audit event and processor-version-1 job atomically. It can return the exact
   immutable `revision_id` alongside the compatible capture result.
7. Consuming the private hook context clears local due state whether the remote
   call succeeds or fails. There is deliberately no offline content queue.

Organization does not delay capture. The worker claims a project-serialized
job, validates the source envelope against immutable revisions, and invokes
bounded structured extraction, reconciliation, and review. Its fenced commit
revalidates the proposed changes and atomically appends the ledger, replaces the
projection, and marks the job successful. Retries preserve raw revisions; a
terminally failed earlier session revision blocks later revisions of that
session for investigation.

## Retrieval and messaging

Retrieval derives owner/project exclusively from the authenticated identity.
Browse/search responses are bounded and generation-scoped; lexical search is
not semantic search. Evidence reads verify revision hashes and exact UTF-16
offsets. An exact source read can access a captured but unprocessed revision,
while derived empty results do not invent claims or assert that no raw memory
exists. Memory content remains untrusted data, never higher-priority commands.

Messaging is independent of the memory-processing queue. Active signed-in users
send by username with a stable request UUID. Plugin setup binds one saved local
Git destination and enrolls an account-bound installation after explicit browser
approval. Any local chat can wake the asynchronous hook, which
claims/stages messages locally, confirms cloud import, and
then routes native tasks without blocking the owner prompt. Paths and native
task IDs remain local. Ambiguous mutations require reconciliation, not blind
replay; cloud `delivered` means native acceptance, not finished execution.

See [Architecture](architecture.md), [Memory processing](memory-processing.md),
[Retrieval](memory-retrieval.md), and [Cloud operations](cloud-memory-operations.md)
for contracts, failure modes, and deployment requirements.

## Limits and validation boundary

This integration does not implement embeddings/semantic search, full transcript
storage, multi-project membership, an always-on local receiver daemon, or
automatic device handoff. Historical captures predating queue integration need
an explicit backfill plan. Semantic recall is not guaranteed by deterministic
engineering tests.

Local mocks and disposable Postgres tests are distinct from live OAuth/email,
installed macOS/native compatibility, and paid inference validation. This
architecture documents the assembled code; it does not certify deployment or
live-native compatibility.
