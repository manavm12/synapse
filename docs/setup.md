# Set up incoming tasks in Codex

Recipients need a Mac, Git, a saved local Git project, and a compatible Codex
desktop installation with its supplied Node runtime and SQLite support. They do
not need system Node, npm, a Synapse checkout, a server URL, or a separate runner.
The operator must distribute the plugin through an accessible Codex marketplace;
the repository's local marketplace is a development source, not public distribution.

## First use

1. Install Synapse and sign in through its existing OAuth connection. Email
   signup requires the operator's SMTP configuration.
   Email requests are single-flight and limited to one link per authorization
   request every 60 seconds. One-time server-side state allows opening the link
   in another browser without allowing replay.
2. Accept the one-time **Enable** offer, or choose **Later**. Deferral suppresses
   automatic offers. The **Enable incoming tasks** starter prompt remains
   available even before hooks are trusted.
3. Select a saved local Git project. Setup defaults to the current saved project;
   linked worktrees resolve to their saved primary project. Projectless chats
   ask for a destination. Conflicting existing alias bindings are preserved,
   never silently overwritten.
4. Approve incoming tasks in the browser using the same account/project as the
   plugin connection. The page says **Return to Codex**; there is no terminal step.
5. Synapse completes enrollment, validates live authorization, and verifies that
   this installed build's prompt hook has run in the current chat. If hooks have
   not run, it reports **Connected; background checks still need verification**,
   preserving enrollment and the destination. Review/trust Synapse hooks, open a
   fresh local task, and ask for incoming-task setup status. No repeat browser
   approval, terminal command, manual hook execution, or database repair is needed.
   A successful enrollment also makes one bounded delivery attempt; subsequent
   local prompts wake the same saved destination.

Codex's separate hook-trust requirement must be accepted before automatic prompt
checks work. Idle Codex does not poll. There is no daemon, service registration,
or always-running receiver process.

## Status and recovery

Ask Synapse for incoming-task setup status, to reconnect, or to disable incoming
tasks. The bundled `setup-synapse` skill handles these operations. Status verifies
live authorization and a recent prompt-hook receipt for the current installed
build and chat. Expired, revoked, mismatched, unavailable, or unverified hook state
does not count as ready. Setup itself never fabricates a prompt-hook receipt.

Browser approval waiting is bounded to five minutes, including network and
Keychain work. Progress is visible; cancellation retains resumable state.
Repeat Enable to resume: the skill runs `prepare`, the authenticated
`begin_receiver_setup` tool, and `complete`. Pending pairings are reused until
their ten-minute server expiry; a five-minute local wait timeout is resumable,
and an expired pairing is renewed. A healthy connected enrollment is validated
and reused without another approval. Explicit reconnect is needed only when
setup reports `reconnect_required`. Disable stops
local routing immediately and revokes the receiver. Failed remote revocation or
Keychain cleanup can be retried without deleting queued work.

Credentials stay in macOS Keychain. Only their SHA-256 hash reaches the
authenticated setup MCP tool. The server stores the expected account and
cloud-project IDs derived from authenticated context to enforce browser approval.
The helper caches those expected IDs locally; destination paths, onboarding
preferences, and Codex task bindings remain local. Reinstalling the
plugin preserves existing databases and credentials. Never delete local state
to troubleshoot an uncertain delivery; uncertain native mutations must not replay.

## Developer and recovery CLI

Repository commands are optional developer/recovery wrappers. Ordinary CLI setup
only installs/connects the plugin and binds memory; it does not force receiving:

```sh
npm ci --ignore-scripts
npm run synapse -- setup /absolute/path/to/project --alias <project-alias>
npm run synapse -- doctor /absolute/path/to/project --alias <project-alias>
```

These wrappers require repository access, Node 24, npm 11, Git, and Codex CLI.
`doctor` reads local configuration and the non-secret login receipt; it is not
proof of live OAuth or receiver authorization. Use plugin status for the latter.
The lower-level `receiver connect/finish/status/disconnect` commands are retained
for legacy recovery; they are not the installed plugin's onboarding flow.
New unbound pairings from `receiver connect` cannot be approved. Use the installed
skill for new enrollment or reconnect; status/disconnect and completion of already
approved legacy pairings remain available.

## Release gate

Deploy both additive pairing migrations (`202609090001_bound_receiver_setup.sql`
and `202609090002_require_bound_receiver_approval.sql`) and the authenticated
`begin_receiver_setup` tool before releasing the updated plugin. Preparation of
PR #9 and local reinstallation are separate from merging and production rollout.
See [Receiver](receiver.md) for invariants and [Cloud operations](cloud-memory-operations.md)
for operator deployment.
