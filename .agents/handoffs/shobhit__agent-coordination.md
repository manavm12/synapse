# Handoff: shared agent coordination

- Branch: `shobhit/agent-coordination`
- Human owner: `Shobhit Goel`
- Active agent: `Codex`
- Base reviewed: `c87995c`
- Last checkpoint: pending initial commit
- Status: `active`

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

- Pending formatting and diff checks.

## Remaining work

1. Validate, commit, and push the coordination branch.
2. Merge the rules before relying on them from new branches.

## Risks or blockers

- Until this branch merges, other branches must opt in by reading these files
  from this branch or merging it explicitly.
