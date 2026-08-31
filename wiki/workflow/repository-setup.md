---
title: Repository Setup
topic: workflow
added: 2026-08-31
updated: 2026-08-31
---

The active repository is `manavm12/synapse` on GitHub. The previous Synapse repository was archived and is not a source of product code or context.

This machine uses the SSH host alias `github-synapse` for the `manavm12` GitHub identity, so the repository remote is:

```text
git@github-synapse:manavm12/synapse.git
```

The global GitHub CLI account may remain `manav-tf`; repository pushes use the SSH alias above. GitHub CLI operations for this repository should explicitly use the stored `manavm12` authentication rather than changing the global default account.

The project requires Node.js 24 or newer. Install dependencies with `npm install`, run the unit suite with `npm test`, and run the live Codex probe with `npm run probe:live` when validating thread reuse and App Server behavior.

Submit a task manually with:

```text
npm run synapse -- send <channel-id> "<task>"
```

The command waits for completion and prints the job ID, Codex thread ID, channel worktree, and result. A channel ID is the durable routing key: its first task creates a detached Git worktree and a Codex thread whose working directory is that worktree, while later tasks with the same channel ID resume both. A different channel ID receives a different worktree and thread. The worktree is still a checkout of this repository, so the child is project-scoped rather than a general unanchored task.

App Server-created child threads currently appear under Recents rather than being registered automatically with the saved Codex project. Attach them to the project manually in the Codex UI for now. After the last active Synapse worker finishes, Synapse stops its idle App Server so the desktop can open the child instead of reporting that it is open in another app.

For another device, clone the repository, install dependencies, and open the repository root as a Codex project. The committed `wiki/` directory is the durable handoff context; machine-local credentials, MCP authentication, and global Codex skills still require separate setup.
