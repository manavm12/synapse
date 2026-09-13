# Handoff: Web inbox

- Branch: `shobhit/web-inbox`
- Human owner: `Shobhit Goel`
- Active agent: `Codex`
- Base inherited from Claude: `7530d65`
- Last checkpoint: none yet; Claude's local WIP is being preserved before integration
- Status: `active`

## Goal

Build a secure, responsive, read-only web inbox for Synapse conversations and
incoming messages, integrate it with the current server, and verify it across
supported browsers and operating-system-independent server behavior.

## File ownership

- `src/server/browser-session.mjs`
- `src/server/inbox.mjs`
- `src/server/public/inbox.js`
- `src/server/public/inbox.css`
- `src/server/public/inbox-view.js`
- `src/server/app.mjs`
- `src/server/onboarding.mjs`
- `src/server/messaging/receiver.mjs` only for shared browser authentication
- `test/server/inbox-view.test.mjs`
- `test/server/mcp-http.test.mjs` only for web-inbox HTTP coverage
- Web-inbox documentation and this handoff

## Inherited work

- Claude created an uncommitted first implementation with authenticated browser
  routes, conversation and message feeds, pagination, status filtering, a
  responsive page shell, and focused tests.
- Claude stopped before creating a handoff, committing, pushing, testing, or
  integrating the two newer main commits.
- The inherited base contains PR #21. Current `origin/main` subsequently reverted
  that experiment in PR #24 and added its compact replacement in PR #25.

## Decisions and invariants

- Start with read-only visibility; do not add retry, reply, pause, close, or other
  mutation controls without separately defining their authorization semantics.
- Derive account and user scope only from the verified browser access token.
- Treat message bodies, usernames, previews, and statuses as untrusted text and
  render them with DOM text nodes, never HTML injection.
- Preserve current messaging idempotency, receiver authorization, and memory
  context behavior while integrating latest `main`.
- Browser behavior must not depend on Windows, macOS, or Linux filesystem paths.

## Initial verification of inherited WIP

- Focused Node tests: 12 passed, 1 failed. The web-inbox route test expected
  HTTP 200 for an asset and received HTTP 400.
- Biome found formatting-only differences in `inbox.mjs`, `inbox.js`, and
  `mcp-http.test.mjs`.
- These findings are recorded before any behavioral repair so the first pushed
  checkpoint accurately preserves Claude's stopping point.

## Next steps

1. Run focused checks and commit/push the inherited WIP unchanged as a recovery
   checkpoint.
2. Merge current `origin/main` and resolve the known `receiver.mjs` overlap.
3. Complete security, accessibility, responsive UI, empty/loading/error states,
   pagination, and browser behavior.
4. Add focused browser/HTTP tests, run the full PostgreSQL-backed release gate,
   dependency audit, plugin validation, and production image smoke test.
5. Update this handoff, push, and open a focused pull request.

## Risks

- Until the first checkpoint is pushed, Claude's WIP exists only in this local
  worktree.
- The branch is two main commits behind and must not be reviewed or deployed
  before integration.
