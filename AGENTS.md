# Shared agent coordination

These instructions apply to every Codex, Claude, and other agent session in this
repository.

## Before editing

1. Run `git fetch --prune origin` and inspect `git status`, remote branches, and
   recent commits.
2. Read `CONTRIBUTING.md`, the relevant product documents, and every active
   handoff in `.agents/handoffs/`.
3. Compare the intended files with other active branches. If ownership overlaps,
   stop and ask the user which workstream owns the files.
4. Work from current `origin/main` in a dedicated branch and worktree. Never let
   two active agents edit the same worktree or branch.

## While working

- Use one workstream per branch. Suggested prefixes are `shobhit/`, `codex/`, and
  `claude/`; the handoff file records the human owner separately.
- Create `.agents/handoffs/<branch-slug>.md` from the template in that directory.
- Update the handoff after meaningful changes and before pausing. Record changed
  files, decisions, tests, remaining work, risks, and the exact last commit.
- Commit and push safe checkpoints so another agent can resume from the remote.
  Never leave the only copy of important work as uncommitted local changes.
- Fetch before each commit. Review newly changed remote branches for overlapping
  files or assumptions; do not overwrite or silently duplicate their work.
- Do not rebase, force-push, delete, merge, or rewrite another agent's branch.

## Handoff and completion

- A replacement agent resumes the existing branch only after the previous agent
  has stopped, then fetches, reads its handoff, and verifies the recorded commit.
- Run the checks required by `CONTRIBUTING.md`. Never claim skipped platform,
  database, credential, or live-service checks passed.
- Push the final branch and update its handoff before requesting review.
- Keep `main` protected: changes go through focused pull requests.
