# Handoff: Windows test-suite fixes

- Branch: `claude/windows-test-fixes`
- Human owner: `Shobhit Goel`
- Active agent: `Claude`
- Base reviewed: `0aad6a1`
- Last checkpoint: `uncommitted`
- Status: `active`

## Goal

Get `npm test` fully green on native Windows (no WSL). Currently 197/234 pass with
28 failures, all traced to POSIX-only assumptions (Unix domain sockets, raw
`file://` URL concatenation, backslash paths used where a URL is expected).
No production/live changes; this is local dev-environment parity only.

## File ownership

- `test/client/app-tools-client.test.mjs`
- `test/server/worker-operations.test.mjs`
- `test/server/mcp-http.test.mjs`
- `test/plugin/validator.test.mjs`
- Any `src/` or `plugins/` file whose path-handling causes the above failures
  (exact files not yet identified — will update this section once diagnosed)

## Completed

- (nothing committed yet)

## Decisions and invariants

- Fix path/URL handling to be cross-platform (e.g. `pathToFileURL`, `url.pathToFileURL`,
  forward-slash-safe joins) rather than skipping/disabling tests on Windows.
- Unix-domain-socket tests may need a platform guard (skip on win32) if Node's
  Windows AF_UNIX support genuinely cannot satisfy the test's assumptions -- to be
  confirmed before taking this route; prefer a real fix over a skip.
- Do not touch macOS/Keychain-specific receiver code paths -- those are correctly
  Mac-only per docs/architecture.md and out of scope here.

## Verification

- `npm run lint` — passed (pre-existing baseline)
- `npm run format:check` — passed (pre-existing baseline)
- `npm test` (no TEST_DATABASE_URL) — 197 pass / 28 fail / 9 skipped (baseline before fixes)

## Remaining work

1. Diagnose and fix `test/server/worker-operations.test.mjs` module-path bug
   (`Cannot find module 'C:\C:\...'` -- doubled drive letter from URL+path concat).
2. Diagnose and fix `test/server/mcp-http.test.mjs` OAuth-discovery/static-asset
   failure (400 instead of 200 for `/assets/consent.js`).
3. Diagnose `test/plugin/validator.test.mjs` failure.
4. Diagnose `test/client/app-tools-client.test.mjs` Unix-socket `EACCES` failures
   and decide fix vs. platform-guarded skip.
5. Re-run full `npm test` and confirm 0 unexpected failures (9 SQL-suite skips
   remain expected without `TEST_DATABASE_URL`).
6. Push branch and update this handoff before pausing.

## Risks or blockers

- No `TEST_DATABASE_URL` configured yet in this environment, so the 9 SQL suites
  stay skipped; not part of this workstream's goal unless it starts hiding a
  real cross-platform bug.
- None yet blocking the 4 identified failure groups.
