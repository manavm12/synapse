# Session-memory plugin

The Synapse plugin captures one concise Markdown memory per registered Codex
session. It requests a save after every fifteen distinct completed turns and on the
first model continuation after compaction. It does not copy the raw transcript.

## Local installation

The initial implementation requires macOS, Node.js 24 or newer, and a project
registered in Synapse's `~/.synapse/host.sqlite` database.

From this worktree, validate the dependency-free plugin runtime:

```sh
cd /Users/manavmehta/synapse-memory-capture
npm install
npm test
npm run validate:plugin
```

Add the repository marketplace and install the plugin:

```sh
codex plugin marketplace add /Users/manavmehta/synapse-memory-capture
codex plugin add synapse@personal
```

Start a new Codex task after installation. Open `/hooks`, review the Synapse
hook definitions, and trust them. Codex intentionally skips changed plugin
hooks until their new hash is trusted.

## Manual verification

1. Start a new task in a Synapse-registered main checkout or one of its linked
   worktrees.
2. Complete fifteen ordinary user/assistant turns. The fifteenth Stop hook should
   create one automatic continuation asking Codex to call
   `save_session_memory`.
3. Confirm the continuation finishes and inspect
   `~/.synapse/memory/<project-alias>/<session-id>.md`.
4. Continue for another fifteen turns and confirm the same file advances to the
   next revision instead of creating a second document.
5. Trigger Codex compaction in a long task. The immediate continuation should
   save memory before returning to the original work.
6. Run a task in an unregistered repository and confirm that no checkpoint or
   memory file is created.

To pick up later local edits, update the plugin cachebuster with the Codex
plugin-creator helper, reinstall `synapse@personal`, and start another new task.
