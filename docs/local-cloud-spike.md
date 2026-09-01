# Local cloud spike

This slice proves the production delivery boundary without deploying a cloud
service. A terminal command submits a task to a localhost relay. The relay
stores it in SQLite and immediately pushes it over a persistent WebSocket to a
laptop host. The host creates or resumes the task's Codex conversation and Git
worktree.

```text
terminal -> HTTP -> mock relay -> WebSocket -> laptop host -> Codex App Server
```

There is no Codex polling, scheduled task, prompt hook, child MCP server, or
second App Server. Replacing the local relay with Synapse Cloud later changes
the relay URL, not the host-side task protocol.

## Prerequisites

- Node.js 24 or newer.
- Git.
- A managed Codex App Server started with Remote Control:

  ```sh
  codex remote-control start
  ```

  If Codex reports that its managed standalone install is missing, follow the
  installer command it prints, then rerun `codex remote-control start`.

## Register a project

Projects are an allowlist on the laptop. Cloud tasks select an alias; they
never supply an arbitrary local filesystem path.

```sh
npm run synapse -- project add synapse /Users/manavmehta/synapse
```

The default Codex permissions profile is `:workspace`. Choose another existing
profile explicitly when needed:

```sh
npm run synapse -- project add website /Users/me/website \
  --permissions :read-only
```

## Run the three-terminal demo

Terminal 1 starts the mock cloud:

```sh
npm run synapse -- relay run
```

Terminal 2 starts the laptop host:

```sh
npm run synapse -- host run
```

Terminal 3 sends a task and follows its status stream:

```sh
npm run synapse -- send demo --project synapse \
  "Explain Synapse and create a short SYNAPSE.md file."
```

The first message for `demo` creates a detached Git worktree from the
project's committed `HEAD` and a Codex task named `Synapse: demo`. The task is
assigned to the registered Codex project. Later messages reuse that exact task
and worktree:

```sh
npm run synapse -- send demo --project synapse \
  "Now add a one-sentence example."
```

If the owner or Codex is already working in the task, the message stays in
Codex's native queue and begins as the next turn. It is never steered into the
active turn.

Use `--no-wait` to return after the relay accepts a task, then inspect it later:

```sh
npm run synapse -- status <task-id>
```

## Local state

The spike stores its state beneath `~/.synapse/`:

```text
relay.sqlite
host.sqlite
worktrees/<project-hash>/<conversation-hash>/
```

Set `SYNAPSE_HOME`, `SYNAPSE_RELAY_URL`, or the individual database/worktree
environment variables to isolate a test run. The mock relay refuses
non-loopback listeners by default.
