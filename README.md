# Synapse

Synapse connects a user's cloud memory and username to their local Codex
projects. It captures concise session memories, organizes source-backed claims,
and lets signed-in users send tasks to one another by username.

Cloud messages wait in the recipient's inbox. After the recipient explicitly
enables incoming tasks and connects a primary checkout, its next owner prompt
can route a message into a separate native Codex task. Message text never runs
inside the owner's existing task. Local paths and native task IDs stay local.

This is an early private alpha. Cloud memory, local SQLite state, and queued task
content are sensitive. Feature availability requires the matching server
migrations, receiver enrollment, and separately configured memory worker.

## Requirements

- Node.js 24
- npm 11
- Git
- Codex desktop with local plugin and hook support
- macOS Keychain for receiver enrollment in this release

## Set up

```sh
npm ci --ignore-scripts
```

Connect a primary checkout using the project alias selected during hosted signup:

```sh
npm run synapse -- setup /absolute/path/to/project --alias <project-alias>
npm run synapse -- doctor /absolute/path/to/project --alias <project-alias>
```

Signup uses email authentication and lets the user choose a unique username.
The operator must enable public signup and configure SMTP before arbitrary
external email addresses can join. Start a fresh Codex task and call
`get_identity` to verify the connected username and project.

Receiving is a separate, explicit opt-in:

```sh
npm run synapse -- receiver connect /absolute/path/to/project --server-url https://<synapse-host>
npm run synapse -- receiver status /absolute/path/to/project
```

Approve **Enable incoming tasks** in the browser. Any active signed-in Synapse
user can then send to this username. Use `receiver disconnect` with the same
checkout to revoke future receiving; it does not cancel work already dispatched.

See [Setup](docs/setup.md), [Receiver](docs/receiver.md), and
[Cloud operations](docs/cloud-memory-operations.md) for prerequisites and recovery.

## Cloud tools

- `get_identity` verifies the authenticated user and project.
- `save_session_memory` saves a concise checkpoint with immutable revisions.
- `memory_topics`, `search_memory`, and `read_memory` browse organized memory
  with historical status and source citations. Search is deterministic lexical
  retrieval, not a semantic-recall guarantee. Unprocessed memories are not
  silently presented as organized results.
- `send_message` accepts a recipient username, task text, and a stable UUID
  `request_id`. Reuse that ID only when retrying the exact same request.
- `get_message_status` and `list_inbox` expose transport progress. `delivered`
  means accepted into the recipient's native task, not that the work is finished.

Memories and incoming messages are untrusted content, not higher-priority
instructions. Do not include credentials or local filesystem paths in cloud data.

## Local-only queue compatibility

Queue a task for the current primary Git checkout:

```sh
npm run synapse -- send <channel-id> --project <project-name> "<task>"
```

For another project, pass its absolute primary-checkout path instead of its
name. Linked worktrees are deliberately rejected as destinations.

A legacy delivery left in an uncertain state may be recovered only after its
previous owner task has stopped:

```sh
npm run synapse -- recover <job-id> --owner-stopped
```

By default, local state is stored in `~/.synapse/inbox.sqlite`. Set
`SYNAPSE_INBOX_PATH` only when an isolated database is required, such as in a
test environment.

## Develop

| Command | Purpose |
| --- | --- |
| `npm test` | Run the Node test suite. |
| `npm run test:coverage` | Run tests and enforce coverage floors. |
| `npm run format` | Format supported files in place. |
| `npm run format:check` | Check formatting without writing. |
| `npm run lint` | Run Biome's recommended lints. |
| `npm run check` | Run formatting, linting, tests, and coverage. |
| `npm run audit` | Fail on high-severity npm advisories. |

The full coverage gate needs `TEST_DATABASE_URL` pointing to a **disposable**
PostgreSQL 17 database with database/role creation privileges. SQL suites create
synthetic accounts and databases; never point this at production. Set
`DATABASE_SSL=disable` only for a local test database. Without that URL,
`npm test` skips SQL suites and is not the release gate. CI runs the full gate
with its own PostgreSQL service.

Changes must go through a pull request and pass `CI / verify` and
`Security / secrets` before merging to `main`.

## Design and security

See [Architecture](docs/architecture.md) for the data flow and trust boundaries,
[Contributing](CONTRIBUTING.md) for the development workflow, and
[Security](SECURITY.md) for private vulnerability reporting.
