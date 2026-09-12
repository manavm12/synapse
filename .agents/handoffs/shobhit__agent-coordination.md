# Handoff: shared agent coordination

- Branch: `shobhit/agent-coordination`
- Human owner: `Shobhit Goel`
- Active agent: `unassigned`
- Base reviewed: `c87995c`
- Last checkpoint: `66399ea`
- Status: `ready-for-review`

## Goal

Give Codex and Claude one durable protocol for isolated concurrent work and exact
Git-based handoffs.

## File ownership

- `AGENTS.md`
- `CLAUDE.md`
- `.cursor/rules/agent-coordination.mdc`
- `.agents/handoffs/`

## Completed

- Added shared instructions, a Claude import, an always-applied rule, and the
  branch-specific handoff template.

## Decisions and invariants

- Agents never share an active branch or worktree.
- Remote commits and branch-specific handoff files are the durable source of
  truth; chat history is not.
- Overlapping file ownership requires user direction before editing.

## Verification

- `npm run format:check` — passed.
- `npm run lint` — passed.
- `git diff --check` — passed.

## Remaining work

1. Review and merge the coordination branch.
2. Use separate worktrees and create a handoff file for each new workstream.

## Risks or blockers

- Until this branch merges, other branches must opt in by reading these files
  from this branch or merging it explicitly.
