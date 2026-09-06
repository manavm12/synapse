# Contributing

## Workflow

1. Create a branch or dedicated worktree from the latest `origin/main`.
2. Install the pinned dependencies with `npm ci --ignore-scripts`.
3. Make a focused change and include tests for behavior changes.
4. Run `npm run check` and `npm run audit`.
5. Open a pull request to `main` and complete the repository checklist.
6. Merge only after the required CI and secret-scanning checks pass.

Human approval is not required for the current single-team workflow, but direct
pushes, force pushes, and deletion of `main` are prohibited.

## Conventions

- Use Node.js 24 and npm 11.
- Keep runtime code dependency-free unless a dependency has a clear maintenance
  and security benefit.
- Treat queued task content and local inbox data as sensitive and untrusted.
- Preserve delivery idempotency, owner fencing, and primary-checkout isolation.
- Never commit local databases, environment files, credentials, or generated
  state.
- Use concise conventional commit subjects such as `feat:`, `fix:`, `test:`,
  `docs:`, and `chore:`.

This repository is private and has no open-source license. Contributions do not
grant redistribution rights.
