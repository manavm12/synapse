# Handoff: undo PR 21

- Branch: `codex/revert-message-memory-retrieval`
- Human owner: `Manav Mehta`
- Active agent: `Codex`
- Base reviewed: `7530d65`
- Last checkpoint: see this file's committing revision (`git log -1 --format=%H -- .agents/handoffs/codex__revert-message-memory-retrieval.md`)
- Status: `ready-for-review`

## Goal

Undo PR 21 as explicitly requested by the user.

## File ownership

- Remove `experiments/message-retrieval/` and its original handoff.
- This handoff only. No active remote branch overlaps these files.

## Completed

- Inspected current main, active branches and handoffs; PR 23 is unrelated.
- Exact inverse removes all 29 original files and 51,397 lines.

## Decisions and invariants

- Revert squash commit `a721d6b31c6ef9def2dcd8cbf91e563d19bac3ab`.
- Preserve later commits and use the required PR workflow without rewriting main.

## Verification

- `npm run check`: 307 passed, one failed, zero skipped with disposable PostgreSQL.
  The unchanged setup doctor test expects no receiver but reads this Mac's active
  global inbox (`SYNAPSE_HOME` does not isolate `inboxPath`). No product fix is
  included. Full tests must pass in clean CI before merging.
- Dependency audit: zero vulnerabilities. Plugin validation and diff checks pass.
- All original files removed; no production source, test, or later PR files changed.

## Remaining work

1. Verify, push, and merge the revert after required checks pass.

## Risks or blockers

- A revert removes the changes from main; the original commit remains in history.
