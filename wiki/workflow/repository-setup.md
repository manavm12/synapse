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

For another device, clone the repository, install dependencies, and open the repository root as a Codex project. The committed `wiki/` directory is the durable handoff context; machine-local credentials, MCP authentication, and global Codex skills still require separate setup.
