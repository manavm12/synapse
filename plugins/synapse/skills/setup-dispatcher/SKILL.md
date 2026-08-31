---
name: setup-dispatcher
description: Set up automatic polling that routes queued Synapse messages into visible native Codex project tasks. Use when the user asks to enable, install, configure, or repair the automatic Synapse dispatcher.
---

# Set up the automatic Synapse dispatcher

Create one Codex-owned dispatcher for the current Synapse-enabled project:

1. Resolve the main checkout path with `git rev-parse --show-toplevel`. Do not install the dispatcher from a linked worktree.
2. Run `npm run synapse -- dispatcher-prompt` in that checkout and preserve its stdout exactly as the dispatcher prompt.
3. Check existing Codex automations and tasks for an active `Synapse Dispatcher` attached to this exact project. Reuse or repair it instead of creating a duplicate.
4. Use the native Codex project tools to find the saved local project whose path exactly matches the checkout.
5. If needed, create a task directly in that project with a local environment, not a worktree. Its initial prompt must be the dispatcher prompt from step 2. Once its real task ID exists, set its title to `Synapse Dispatcher` explicitly.
6. Attach an active heartbeat automation named `Synapse Dispatcher` to that task. Run it once per minute with the same exact prompt and notify only on failed runs.
7. Report the dispatcher task and automation identifiers and make clear that delivery latency is normally under one minute.

The dispatcher must remain a desktop-owned native Codex task. Never replace it with a detached App Server writer. The scheduled task leases work through `dispatcher-next`; the project hook remains only as an opportunistic path for ordinary project prompts.
