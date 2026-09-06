# Synapse

Synapse is a private, local-first bridge that queues a task for a Git project and
routes it into a native Codex task on the project's next owner prompt. It does
not run a network service or execute queued task text in the owner task.

The project is an early `0.1.x` implementation. Its SQLite data and queued task
content should be treated as sensitive local state.

## Requirements

- Node.js 24
- npm 11
- Git
- Codex with local plugin and hook support

## Set up

```sh
npm ci --ignore-scripts
```

The repository has no runtime npm dependencies. Biome is the only development
dependency and is pinned in `package-lock.json`.

## Use the client

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

Changes must go through a pull request and pass `CI / verify` and
`Security / secrets` before merging to `main`.

## Design and security

See [Architecture](docs/architecture.md) for the data flow and trust boundaries,
[Contributing](CONTRIBUTING.md) for the development workflow, and
[Security](SECURITY.md) for private vulnerability reporting.
