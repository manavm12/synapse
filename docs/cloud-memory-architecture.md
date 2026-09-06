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
| `memory_nodes` | Current memory tree | One root per project, one session node per project/session |
| `memory_revisions` | Immutable history | Unique capture ID and node revision |
| `audit_events` | Security/operation evidence | Records save and capture conflicts without content |
| `development_tokens` | Explicit local escape hatch | Hashed, expiring, revocable, disabled in production by default |
| `invites` | Closed onboarding | Reserves email, username, and project alias |

Postgres RLS is forced on every user-owned table. The Railway process logs in
as `synapse_runtime`, a non-superuser role with narrow grants, sets the verified
user ID only inside a transaction, and cannot bypass RLS. Admin operations use
a separate connection string that is never present in the runtime service.

## Write lifecycle

1. The local Stop hook counts distinct turn IDs in a private SQLite scheduler.
2. At 15 turns it emits a blocking continuation with a fresh UUID. A compaction
   hook emits one immediately.
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
   audit event atomically.
7. The hook's continuation clears local due state whether the remote call
   succeeds or fails. There is deliberately no offline content queue.

## Explicitly deferred

This phase does not implement memory retrieval, semantic search, embeddings,
topics/claims extraction, task messaging in the cloud, transcript storage, or
multi-project membership. The schema supports adding topic nodes later without
changing the identity or revision boundaries.
