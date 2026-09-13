# Handoff: Web inbox

- Branch: `shobhit/web-inbox`
- Human owner: `Shobhit Goel`
- Active agent: `unassigned` -- Claude completed the remaining verification and
  browser smoke-test matrix from Codex's `40c2a3f` handoff and is stopping.
- Base inherited from Claude: `7530d65`
- Base reviewed at takeover: `40c2a3f` (confirmed both local `HEAD` and
  `origin/shobhit/web-inbox` at this commit before editing)
- Status: `pr-open-ci-green` -- [PR #26](https://github.com/manavm12/synapse/pull/26)
  is open against `main` at commit `5475852`; `verify`, `database`, and
  `secrets` all passed. Waiting on human review/merge.

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

## Completed by Claude (this session)

- **Found and fixed a real, previously-undetected bug**: `src/server/public/inbox.js`
  statically imports `./inbox-view.js` as an ES module, but `installInboxRoutes`
  in `src/server/inbox.mjs` never registered a route to serve
  `/assets/inbox-view.js`. In a real browser this import 404s, which means the
  browser refuses to evaluate any of `inbox.js` at all (static ES module
  imports fail closed) -- so **the entire inbox page was inert**: no login
  form wiring, no sign-out, nothing, even though every existing HTTP test
  passed, because none of them actually loaded `inbox.js` as a module in a
  browser. Only found by driving a real headless Chromium against the page.
  Fixed by adding a third `/assets/inbox-view.js` route in `inbox.mjs`,
  mirroring the existing `/assets/inbox.js` and `/assets/inbox.css` routes.
- Added a regression test in `test/server/mcp-http.test.mjs` that fetches
  `/assets/inbox.js`, parses every static `from "./..."` import specifier out
  of its source with a regex, and asserts each one resolves to a real,
  servable module with a JS content type -- this is the exact invariant that
  was broken, verified to fail without the fix and pass with it (checked by
  temporarily stashing the route addition and re-running the test).
- Added failure-path test coverage for the inbox routes that was previously
  missing: `getAccount` throwing `AccountDisabledError` (403 `account_disabled`
  on all three inbox routes), `getAccount` throwing a generic error (503
  `account_unavailable`, plus asserting `inbox_account_lookup_failed` is
  logged), `listConversations`/`listInbox`/`getConversation` throwing a
  generic (non-`MessagingError`) error (503 `inbox_unavailable`), and invalid
  query parameters on the conversation-detail endpoint (`limit=0`,
  `after_sequence=-1`) and on `/inbox/messages` (`limit=0`). Focused web-inbox
  test count went from 16 to 19, all passing.
- Ran a full browser smoke-test matrix in real headless Chromium (Playwright,
  fetched ad hoc via `npx`, not added as a project dependency) against a
  disposable local harness that mounts the real `installInboxRoutes` via
  `createApplication` with a mocked in-memory database and a fake
  bearer-session verifier (same pattern as `test/server/mcp-http.test.mjs`'s
  `fixture()`), since no live Postgres/Supabase is available in this sandbox.
  All 19 scripted checks passed, screenshots taken and visually reviewed. See
  "Browser smoke test" below for the exact matrix and results. The harness and
  driver scripts were scratch files, never committed.

## Decisions and invariants

- Start with read-only visibility; do not add retry, reply, pause, close, or other
  mutation controls without separately defining their authorization semantics.
- Derive account and user scope only from the verified browser access token.
- Treat message bodies, usernames, previews, and statuses as untrusted text and
  render them with DOM text nodes, never HTML injection.
- Preserve current messaging idempotency, receiver authorization, and memory
  context behavior while integrating latest `main`.
- Browser behavior must not depend on Windows, macOS, or Linux filesystem paths.

## Verification (uninterrupted, this session)

- Node 24.21.0 / npm 11.19.0, already on `PATH` in this environment (no manual
  `$env:Path` prepend was needed here; the PowerShell command below is kept for
  environments where it is).
- `npx biome check .`: passed, 165 files (166 with the now-deleted scratch
  harness file present transiently; it was never committed).
- `node --test test/server/inbox-view.test.mjs test/server/mcp-http.test.mjs`:
  **19/19 passed, 0 skipped** (up from 16; see "Completed by Claude" above).
- `npm run check` (Biome + `npm run test:coverage`), run fully and
  uninterrupted: **315 tests, 303 passed, 0 failed, 12 skipped.** The 12 skips
  are the same pre-existing, intentional Windows platform cases documented at
  the prior handoff (POSIX permissions/signals/shebangs, symlink privileges) --
  none are web-inbox related. Coverage: **80.51% lines / 84.98% branches /
  91.42% functions**. The aggregate command exits nonzero solely because lines
  coverage is below the 85% release gate -- this is caused entirely by the
  `*-postgres.test.mjs` and `schema.test.mjs` suites reporting near-0%
  coverage because they skip without a live database (no `TEST_DATABASE_URL`
  in this sandbox; no PostgreSQL or Docker is installed on this Windows host).
  **This is not a web-inbox failure and is not being reported as a passed
  release gate** -- it matches the exact pattern already documented in
  `shobhit__native-task-verification.md`. CI runs this gate with its own
  PostgreSQL service.
- `npm run test:sql`: 9 tests, 1 passed (a non-database CLI validation case in
  `schema.test.mjs`), 8 skipped gracefully, 0 failed. The 8 skips are every
  Postgres-backed case, skipped because no `TEST_DATABASE_URL` is available --
  **this does not establish the database-backed release gate**, only that
  local skip-without-a-database behaves as documented. No PostgreSQL/Docker
  was available to actually run these live.
- `npm run audit`: 0 vulnerabilities.
- `npm run validate:plugin`: passed.
- `git diff --check`: passed (no whitespace errors).

## Browser smoke test (headless Chromium, this session)

No live Postgres/Supabase is available in this sandbox, so the real
`src/server/index.mjs` server can't be started as-is. Instead: fetched
Playwright ad hoc via `npx` (not added to `package.json`/the lockfile, used
only for this manual verification) and drove real headless Chromium against a
disposable local harness script (deleted after use, never committed) that
calls the exact same `createApplication` from `src/server/app.mjs` used by
`test/server/mcp-http.test.mjs`, wired to a mocked in-memory database and a
fake bearer-session verifier -- i.e. the real routes, real HTML, real
`inbox.js`/`inbox-view.js`/`inbox.css` as actually served, with only the
database and Supabase auth backend swapped for fixtures. `/assets/supabase.js`
was intercepted with a two-function stub (`getSession`/`signOut`) so no real
network calls to Supabase happened. All 19 scripted checks passed; screenshots
were taken and visually reviewed (table rendering, badge colors, focus ring,
mobile layout all looked correct, not just DOM-asserted):

| Item | Result |
| --- | --- |
| Signed-out (no session) | PASS -- login form shown, app shell hidden, no console errors |
| Setup-required (`/auth/account` not ready) | PASS -- setup panel shown, app shell hidden |
| Empty inbox (conversations + inbox feed) | PASS -- both empty-state messages shown, zero rows |
| Populated conversations | PASS -- header identity and rows render correctly |
| Pagination: conversations "Load more" | PASS -- appends next page, then hides itself |
| Keyboard navigation | PASS -- Tab-focusable row has `role="button"`; Enter opens conversation detail |
| Conversation detail + its own pagination | PASS -- messages render; "Load more" appends the next page |
| ARIA tab semantics | PASS -- clicking a tab flips `aria-selected` on both tabs and swaps the visible panel |
| Status filtering | PASS -- selecting a status narrows the inbox feed to matching rows only |
| Narrow/mobile viewport (375px) | PASS -- no horizontal page overflow; tables sit in their own `overflow-x: auto` containers |
| Sign-out | PASS -- clears the session and returns to the signed-out view on reload |

**Explicitly not verified this way** (needs live credentials this sandbox does
not have): the real Supabase magic-link email sign-in flow itself (`signInWithOtp`
against a live Supabase project and clicking through an actual received
email), and anything that depends on real Postgres-backed account/conversation
data rather than fixtures. These remain open until a live Supabase/Postgres
environment is available for a genuine end-to-end pass.

## Linux CI

- Checked `origin/shobhit/web-inbox` at `40c2a3f` (the commit before this
  session's changes): only the `secrets` check had run
  (`.github/workflows/security.yml` triggers on any push). `.github/workflows/ci.yml`
  (`verify`) and `.github/workflows/cloud-memory.yml` (`database`) only trigger
  on `pull_request` to `main` or `push` to `main`, so neither had run against
  this branch until the PR below was opened.
- Opened [PR #26](https://github.com/manavm12/synapse/pull/26) from
  `shobhit/web-inbox` (`5475852`) to `main`. All required checks are **green**:
  `verify` passed (48s), `database` passed (1m4s, this is the PostgreSQL-backed
  gate this sandbox could not run locally), `secrets` passed on both the push
  and PR triggers (7s each), and CodeRabbit reported "Review skipped: manual
  review required for this OSS repository" (not a failure -- this repo's
  CodeRabbit config requires a human to invoke it). This is genuine Linux CI
  confirmation, run by GitHub Actions, not a claim made from local results.
- Not claiming macOS validation: no Mac was used in this session. The
  implementation has no OS-specific web-inbox code paths (confirmed by reading
  `inbox.mjs`/`inbox.js`/`inbox-view.js`; the only cross-platform surface in
  this repo is the receiver/task-scheduler code covered by other handoffs).

## Next steps

1. [PR #26](https://github.com/manavm12/synapse/pull/26) is open with all CI
   green; it needs human review/merge approval (CodeRabbit requires a manual
   invocation on this repo, so that step is still pending a person).
2. After merge, a genuine live smoke test against a real Supabase project
   (magic-link sign-in) and real Postgres-backed data remains outstanding --
   the browser matrix above proves the UI/API contract works correctly, not
   that the live auth/data path is wired end-to-end.

## Risks

- The database-backed release gate (`npm run check`'s 85% line-coverage
  threshold) and `npm run test:sql` have only been exercised in
  skip-without-a-database mode in this sandbox; only CI's real PostgreSQL
  service can actually clear that gate. Do not treat the local runs above as
  having passed it.
- The live authenticated browser matrix (real Supabase magic-link sign-in,
  real Postgres data) has not run; the fixture-backed browser matrix in this
  handoff proves the UI/API contract, not the live integration.
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
