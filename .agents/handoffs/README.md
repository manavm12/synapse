# Agent handoffs

Each active workstream keeps one branch-specific Markdown file in this directory.
Replace slashes in the branch name with double underscores, for example:

```text
claude/web-inbox -> claude__web-inbox.md
shobhit/docs-status -> shobhit__docs-status.md
```

Agents must read all active handoffs after fetching and before editing. Update and
push the relevant handoff at every meaningful checkpoint and before pausing.
Different workstreams use different files to avoid coordination-file conflicts.

Copy this template:

```markdown
# Handoff: <workstream>

- Branch: `<branch>`
- Human owner: `<name>`
- Active agent: `<agent or unassigned>`
- Base reviewed: `<origin/main commit>`
- Last checkpoint: `<commit or uncommitted>`
- Status: `active`, `paused`, `blocked`, or `ready-for-review`

## Goal

<One precise outcome.>

## File ownership

- `<paths this workstream expects to modify>`

## Completed

- <Implemented and verified work.>

## Decisions and invariants

- <Decisions another agent must preserve.>

## Verification

- `<command>` — <result>

## Remaining work

1. <Exact next step.>

## Risks or blockers

- <Known conflicts, missing access, skipped checks, or none.>
```
