# Handoff: Web inbox

- Branch: `shobhit/web-inbox`
- Human owner: `Shobhit Goel`
- Active agent: `unassigned` (prepared for Claude takeover)
- Base inherited from Claude: `7530d65`
- Last pushed checkpoint before this handoff: `f0601d6` (current `main` merged)
- Status: `handed_off`

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

## Completed work

- Preserved Claude's original uncommitted implementation as commit `2fe2430`.
- Merged current `origin/main` (including PR #24 and PR #25) in `f0601d6`; the
  shared `receiver.mjs` authentication refactor merged without conflict.
- Added authenticated, account-scoped, read-only conversation/detail/message
  endpoints and a browser inbox using the existing Supabase web session.
- Fixed the inherited HTTP 400 asset bug in hidden worktree paths by explicitly
  allowing dotfile path components in the two `sendFile` calls.
- Added CSP, no-store, no-referrer, nosniff, frame-deny, and permissions-policy
  headers to the inbox document.
- Added responsive horizontal table containers, mobile spacing, visible focus,
  keyboard-operable conversation rows, ARIA tabs/live status, empty states,
  safe API error messages, sign-out, localized dates, participant labels, and
  duplicate-load fencing.
- All server-sourced values are still rendered only with `textContent`.
- Expanded pure view-helper tests and HTTP coverage for assets, headers,
  accessibility markup, strict query validation, auth, account scope,
  pagination, and response wire shapes.

## Decisions and invariants

- Start with read-only visibility; do not add retry, reply, pause, close, or other
  mutation controls without separately defining their authorization semantics.
- Derive account and user scope only from the verified browser access token.
- Treat message bodies, usernames, previews, and statuses as untrusted text and
  render them with DOM text nodes, never HTML injection.
- Preserve current messaging idempotency, receiver authorization, and memory
  context behavior while integrating latest `main`.
- Browser behavior must not depend on Windows, macOS, or Linux filesystem paths.

## Verification at handoff

- `biome check .`: passed (165 files).
- `node --test test/server/inbox-view.test.mjs test/server/mcp-http.test.mjs`:
  passed, 16/16, 0 skipped.
- `npm run check`: Biome passed and the full coverage suite was progressing with
  no failures when the human requested this stopping checkpoint. It was then
  interrupted cleanly. The observed Windows-only skips were existing intentional
  platform cases (POSIX permissions/signals/shebangs and symlink privileges), not
  web-inbox failures. The full coverage gate still needs an uninterrupted run.

## Next steps

1. Fetch origin and confirm this handoff commit is the branch tip.
2. Review the current diff, especially `src/server/inbox.mjs` and
   `src/server/public/inbox.js`, and add any missing failure-path tests.
3. Run an uninterrupted `npm run check` with Node 24/npm 11 on `PATH`.
4. Run `npm run test:sql` against the documented PostgreSQL test environment,
   `npm run audit`, and `npm run validate:plugin`.
5. Perform a browser smoke test for signed-out, setup-required, ready/empty,
   populated, filtering, paging, keyboard use, narrow viewport, and sign-out.
6. Confirm Linux CI is green. Do not claim live macOS validation without a Mac
   run; the implementation contains no OS-specific web-inbox paths.
7. Update this handoff, commit/push, and open a focused PR to `main`.

## Risks

- The full release gate and live authenticated browser matrix have not completed.
- Inbox-feed sender names are displayed as shortened stable IDs because the
  existing `listInbox` database wire shape does not include usernames. Conversation
  detail resolves participant usernames without changing shared database code.
- This is a read-only MVP by design; reply/retry/state mutations remain out of scope.

## Exact local verification commands

From this worktree in PowerShell, ensure the bundled Node runtime is on `PATH`:

```powershell
$runtimeBin = 'C:\Users\DELL\AppData\Local\OpenAI\Codex\runtimes\cua_node\e7fe122ad3cbcd58\bin'
$env:Path = "$runtimeBin;$env:Path"
npm run check
npm run test:sql
npm run audit
npm run validate:plugin
```
