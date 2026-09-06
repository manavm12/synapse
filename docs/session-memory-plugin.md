# Session-memory plugin

Synapse captures concise, durable memory in the authenticated user's cloud
knowledge tree. The local plugin decides *when* a checkpoint is due; it never
stores memory content locally. Supabase Postgres is authoritative and the
Railway service is the only application process allowed to write memory.

## Runtime contract

- The principal is the Supabase user. A Codex session and OAuth client are
  provenance attached to writes, never independent identities.
- Each user owns exactly one cloud project and one memory root.
- A session has one mutable current node plus append-only revisions.
- A globally unique `capture_id` makes an identical retry idempotent. Reusing
  the ID with different content fails and creates an audit event.
- Checkpoints occur after 15 distinct completed turns and immediately after
  compaction. If the remote call fails, the hook fails open and does not queue
  memory or block later work.
- The MCP surface is intentionally two tools: `get_identity` and
  `save_session_memory`. Retrieval, embeddings, messaging, and import are not
  part of this foundation.

The save tool accepts at most 64 KiB of Markdown and requires the headings
`Summary`, `What changed`, `Decisions`, `Still unresolved`, and
`Important references`. Agents should synthesize useful state, not copy a raw
transcript, filesystem paths, or credentials.

## Install and connect

The plugin requires Node.js 24 or newer and a main Git checkout. Configure its
committed MCP endpoint only after Railway has assigned the production domain:

```sh
cd /path/to/synapse
npm ci
npm run configure:plugin -- https://<railway-domain>/mcp
npm run validate:plugin
codex plugin marketplace add /path/to/synapse
codex plugin add synapse@synapse
```

Register the local checkout against the alias created with the cloud invite:

```sh
npm run synapse -- project connect /path/to/project --alias <project-alias>
```

Then sign in through Codex:

```sh
codex mcp login synapse-memory
```

The browser opens Synapse's authorization page. Use the invited email address,
follow the magic link, review the scopes, and approve. In a new Codex task,
call `get_identity` before relying on memory and confirm its username and
project alias.

Hook definitions change when the plugin changes. Review `/hooks` and trust the
new hash before testing a fresh task.

## Manual verification

1. Run `get_identity`; confirm it returns `principal_type: user`, the expected
   username/project, an OAuth client ID, and `authentication_method: oauth`.
2. Start a task inside a registered main checkout or any linked worktree.
3. Complete 15 distinct ordinary turns. The Stop hook should create one
   automatic continuation asking the agent to call `save_session_memory` with
   a generated capture ID.
4. Confirm the tool succeeds and that no Markdown memory exists beneath
   `~/.synapse`. Only `checkpoints.sqlite` may exist, containing scheduler IDs.
5. Retry the identical tool arguments and confirm `idempotent: true`, the same
   node ID, and no second revision.
6. Reuse the capture ID with changed content and confirm the call fails.
7. Trigger compaction in a long task. Its immediate continuation should save a
   fresh memory without creating a local due record.
8. Run in an unregistered repository and confirm the hooks silently do
   nothing.

Provisioning, secrets, recovery, and rollout are documented in
[`cloud-memory-operations.md`](./cloud-memory-operations.md).
