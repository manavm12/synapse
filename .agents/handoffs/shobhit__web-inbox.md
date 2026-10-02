# Handoff: Web inbox

- Branch: `shobhit/web-inbox`
- Human owner: `Shobhit Goel`
- Active agent: `unassigned` -- Claude completed the remaining verification
  and browser smoke-test matrix from Codex's `40c2a3f` handoff, then (with the
  human owner) drove a real Supabase magic-link sign-in and real
  Postgres-backed messaging end-to-end (see "Live end-to-end verification"),
  and is now stopping.
- Base inherited from Claude: `7530d65`
- Base reviewed at takeover: `40c2a3f` (confirmed both local `HEAD` and
  `origin/shobhit/web-inbox` at this commit before editing)
- Last pushed commit: `148236c` -- confirmed local `HEAD` and
  `origin/shobhit/web-inbox` both at this exact commit, working tree clean, as
  of this handoff.
- Status: `verified-live-ready-for-merge` -- [PR #26](https://github.com/manavm12/synapse/pull/26)
  is open against `main` at `148236c`; `verify`, `database`, and `secrets` all
  passed (re-confirmed at this exact commit). Beyond that, the human owner and
  Claude drove a real Supabase magic-link sign-in and real Postgres-backed
  messaging end-to-end together in this session (see "Live end-to-end
  verification"). Only human review/merge and deleting the throwaway Supabase
  staging project remain.

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

At the time this matrix ran, the real Supabase magic-link flow and real
Postgres-backed data had not been exercised -- see "Live end-to-end
verification" below, which closes that gap in the same session.

## Live end-to-end verification (real Supabase + real Postgres, this session)

Went further than the fixture-backed matrix above and proved the actual live
integration, with the human owner (`Shobhit Goel`) driving the real browser
himself since only he could access the real inbox to click the magic link.

**Infrastructure stood up for this** (all local/disposable, nothing production):
- Downloaded the official PostgreSQL 17.11 Windows binaries (EDB) and ran a
  standalone, non-service instance on `127.0.0.1:5544` -- not installed as a
  Windows service, so it is fully torn down by stopping the process and
  deleting its data directory.
- Applied `test/sql/bootstrap.sql` (the repo's own stub for the `auth`/`anon`/
  `authenticated`/`supabase_auth_admin` roles a real Supabase-hosted Postgres
  provides) and ran the real `scripts/migrate.mjs` against it -- all 11
  migrations applied cleanly.
- Created a brand-new, free-tier Supabase project (isolated from the real
  production project referenced in `codex__conversational-messaging.md`) for
  its Auth service only; no real user data or the production project was
  touched. Added `http://127.0.0.1:8787/inbox` as an allowed redirect URL.
- Started the real `src/server/index.mjs` (not a harness) with `--env-file=.env`
  pointing `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` at that real project and
  `DATABASE_URL`/`DATABASE_ADMIN_URL` at the local disposable Postgres.
  `/readyz` returned `{"status":"ready"}`, confirming it reached both the real
  Supabase JWKS endpoint and the real database.

**What was actually proven, in order:**
1. Real magic-link sign-in: the human owner requested a magic link through the
   real `/inbox` login form, received the real email from Supabase, clicked it,
   and the real Supabase JS SDK produced a genuine signed JWT
   (`iss: https://nwpxbyhcziwitlphrhxy.supabase.co/auth/v1`, real `sub`/`email`
   claims) -- real `jose`/JWKS verification, not a stub.
2. Discovered and confirmed a genuine (expected, not a bug) product behavior
   along the way: `inbox.js` calls `signInWithOtp` with `shouldCreateUser:
   false` deliberately -- the web inbox never lets an arbitrary email
   self-register; only `consent.js` (the OAuth/CLI onboarding entry point,
   gated by `PUBLIC_SIGNUP_ENABLED`) creates new Supabase users. Had to
   pre-create the test user directly in the Supabase dashboard first.
3. Real account creation: called the actual `POST /auth/account` endpoint
   (the same one the CLI onboarding flow calls) with the real access token,
   which invoked the real `synapse_private.register_identity` SQL function.
   This surfaced one setup gap specific to a non-Supabase-hosted Postgres:
   that function checks `auth.users` for the caller's email, which on a real
   Supabase Postgres is auto-populated by GoTrue but on our standalone
   instance needed one manual mirrored row (`insert into auth.users (id,
   email) values (...)`) -- not a bug in `register_identity`, just something
   a fully self-hosted deployment would need to handle (e.g. its own sync from
   whatever issues the JWTs). Confirmed via a real Postgres error
   (`42501`/"verified Supabase user is missing") pointing exactly at this.
   After that one row, registration succeeded for real:
   `{"status":"ready","username":"shobhit","project_alias":"synapse-test"}`.
4. Confirmed genuinely empty state first: `/inbox/conversations` and
   `/inbox/messages` both returned empty arrays for the freshly-created real
   account, over the real HTTP API.
5. Real message send: created a second synthetic identity via the repo's own
   documented local escape hatch (`ALLOW_DEV_TOKENS`/`syn_dev_` tokens,
   `docs/cloud-memory-architecture.md`'s "Explicit local escape hatch" row) --
   inserted its `auth.users`/`profiles`/`projects`/`development_tokens` rows
   directly (again mirroring what GoTrue+real onboarding would produce), then
   called the actual `send_message` MCP tool over `/mcp` as that identity,
   addressed to `shobhit` by username. This exercises the real messaging
   write path (`src/server/messaging/mcp.mjs`/`database.mjs`), not a shortcut.
6. Confirmed the sent message appears correctly through the real
   `/inbox/conversations` and `/inbox/messages` HTTP responses.
7. The human owner then reloaded the real `/inbox` page in his own browser
   (headed, not automated) and confirmed, with screenshots: the Inbox tab
   showing the real message with a correct localized timestamp and "Queued"
   badge; the Conversations tab showing `@alice, @shobhit` with "Awaiting
   reply" (verified this is the real, correct computed state from
   `src/server/messaging/database.mjs`'s `activity_state`/`response_state`
   logic -- reflects that `alice`'s message has disposition `continue` and no
   reply yet, not a placeholder); clicking into the conversation correctly
   rendering the full thread (sender, message, status, response state); and
   Sign out correctly returning to the signed-out view.
8. This closes every item that the fixture-backed matrix explicitly could not
   cover: real Supabase magic-link auth, real Postgres-backed account
   creation, and real message data rendered through the real UI.

**Also incidentally re-verified, now against a real (not skip-without-a-
database) PostgreSQL 17**, since the disposable instance was already running:
- `npm run test:sql`: **19/19 passed, 0 skipped, 0 failed** (previously this
  sandbox could only report 1 passed / 8 gracefully skipped without a
  database).
- `npm run check` with `TEST_DATABASE_URL` set: **325 tests, 321 passed, 1
  failed, 3 skipped**. Coverage jumped to **95.69% lines / 87.38% branches /
  94.24% functions -- clears the 85%/70%/90% release gate for real.** The one
  failure (`receiver-approval-upgrade.test.mjs`, `EPERM: operation not
  permitted, symlink ...`) is a pre-existing Windows limitation unrelated to
  this session's changes or to web-inbox: creating filesystem symlinks
  requires either Developer Mode or elevated privileges on Windows, neither
  of which this account has enabled; it is not something this handoff's scope
  covers or should change unilaterally. This is a genuinely stronger, more
  honest result than what could be reported earlier in this same handoff
  without a database -- both are recorded here rather than only keeping the
  better number.

**Cleanup done**: the local disposable Postgres process was stopped and its
data directory deleted, the local server was stopped, and the local `.env`
(already git-ignored, never committed) was removed. Still outstanding: the
human owner deleting the throwaway Supabase staging project from the
dashboard whenever convenient -- nothing in this repo depends on it existing.

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
   invocation on this repo, so that step is still pending a person). The live
   end-to-end verification above is complete, so nothing further is blocking
   merge from a verification standpoint.
2. Local cleanup is done (see "Live end-to-end verification"). The only
   remaining item is the human owner deleting the throwaway Supabase staging
   project from the dashboard whenever convenient.

## Risks

- The database-backed release gate is now genuinely cleared (see "Live
  end-to-end verification": 95.69%/87.38%/94.24% against a real PostgreSQL 17,
  above the 85%/70%/90% thresholds) and the live authenticated browser matrix
  (real Supabase magic-link sign-in, real Postgres data) has run and passed,
  confirmed by the human owner directly in his own browser. Neither is an
  open risk anymore.
- One pre-existing, unrelated test failure was surfaced while running against
  a real database: `receiver-approval-upgrade.test.mjs` fails with `EPERM:
  operation not permitted, symlink ...` on this Windows account because
  Developer Mode/symlink privilege is not enabled here. Not caused by, or in
  scope for, this handoff -- flagging so it isn't mistaken for a regression.
- A fully self-hosted (non-Supabase-hosted) Postgres deployment would need
  its own mechanism to keep a local `auth.users` mirror in sync with whatever
  issues its JWTs, since `synapse_private.register_identity` (and other
  functions) check that table directly. This session worked around it with a
  manual insert for a one-off test; a real self-hosted deployment is out of
  scope for this handoff but worth noting for whoever owns that decision.
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
