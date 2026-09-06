# Session-memory plugin

The Synapse plugin captures one concise Markdown memory per registered Codex
session. It silently marks memory due after every 15 distinct completed turns,
then requests the save through hidden developer context on the next user prompt.
Compaction still requests an immediate save. It does not copy the raw transcript.

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
codex plugin add synapse@synapse
```

Start a new Codex task after installation. Open `/hooks`, review the Synapse
hook definitions, and trust them. Codex intentionally skips changed plugin
hooks until their new hash is trusted.

## Manual verification

1. Start a new task in a Synapse-registered main checkout or one of its linked
   worktrees.
2. Complete 15 ordinary user/assistant turns. The fifteenth Stop hook should
   finish normally without displaying memory instructions.
3. Send one more user message. Codex should call `save_session_memory` quietly
   before answering that message. Inspect
   `~/.synapse/memory/<project-alias>/<session-id>.md`.
4. Complete 14 more turns after that answer, then send another message. Confirm
   the same file advances to the next revision instead of creating a second
   document.
5. Trigger Codex compaction in a long task. The immediate continuation should
   save memory before returning to the original work.
6. Run a task in an unregistered repository and confirm that no checkpoint or
   memory file is created.

To pick up later local edits, update the plugin cachebuster with the Codex
plugin-creator helper, reinstall `synapse@synapse`, and start another new task.
