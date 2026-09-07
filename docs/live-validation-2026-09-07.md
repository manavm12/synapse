# Live validation — 7 September 2026

This is a separate record from the 182-test local integration gate. The checks
below use actual services or operating-system components, without substituting
authentication, database, credential-store, or native responses. They do **not**
establish a complete hosted end-to-end pass.

## Release identity

- Integrated source: `codex/product-integration`, commit `5e74f4f`.
- Latest successful production deployment reported by GitHub: `02f9839`,
  deployment `6294072000`, 6 September 2026 at 14:27:24 UTC.
- Installed plugin source: existing worktree `a5d7`, commit `523f4b1`.
- Production endpoint: `https://synapse-production-ff6c.up.railway.app`.

These are different releases. No deployment, migration, plugin replacement, or
production receiver enrollment was performed during these checks.

## Confirmed live results

| Check | Observed result |
| --- | --- |
| Connected MCP `get_identity` | Real OAuth identity: username `manav`, project alias `synapse` |
| Due session-memory checkpoint | Real `save_session_memory` returned `saved: true`, revision 3, at 08:32:01 UTC |
| Production `/healthz` | HTTP 200, `status: ok` |
| Production `/readyz` | HTTP 200, `status: ready`; the implementation checks PostgreSQL and Supabase JWKS |
| OAuth protected-resource metadata | Exact hosted `/mcp` resource and configured Supabase authorization server returned |
| Unauthenticated MCP request | HTTP 401; missing authorization rejected |
| Unauthenticated `/auth/account` | HTTP 401 |
| Production signup page | HTTP 200, public signup enabled, email and identity forms present; no email sent |
| Real macOS receiver Keychain adapter | Generated credential stored and read back exactly; exact disposable item deleted; second delete succeeded |
| Keychain cleanup | Exact lookup returned item-not-found; default keychain and search list unchanged from before the test |
| Railway CLI authentication | Existing operator login works; actual service status confirms production commit `02f9839` and one HTTP service, no worker |
| Signed-runtime native tool discovery | Integration client retrieved 38 actual tools and successfully called `list_projects` |
| Actual native task creation | Router created a fresh worktree task; it completed with exactly `SYNAPSE_REAL_NATIVE_OK` |
| Actual same-conversation follow-up | Router sent a second message to that same task; it again completed with exactly `SYNAPSE_REAL_NATIVE_OK` |
| Real local delivery persistence | Parent independently read isolated SQLite: two completed jobs, no last error, one ready channel bound to the same permanent task ID |

The memory write was the required session checkpoint, not an invented user
memory or a raw transcript. A server acknowledgment is not an independent SQL
read-back, and there is no deployed retrieval tool available in this connection
to verify the new retrieval functionality.

## Native runtime investigation

An ordinary shell Node process connects to the desktop socket but is rejected
by the installed desktop's peer-authorization check. The desktop log records
`dynamic_app_tools_peer_rejected`, reason `missing-code-signing-identity`.

The same integration `AppToolsClient`, used inside the existing supported
signed execution runtime, successfully fetched 38 real desktop tools. No
credentials, code signatures, or access controls were changed. The integration
client already uses little-endian framing; an initially suspected framing
mismatch was checked and disproved.

The actual task smoke used unchanged integration `queueMessage` →
`reserveNextMessage` → `routeDelivery` and real SQLite accept/ack functions.
Only the temporary database path was supplied to the functions; no native
responses were fabricated. The task was told not to edit files, use tools, or
send messages. Its first reply completed in 9.312 seconds and the follow-up in
2.621 seconds. The parent independently verified both real replies and database
states.

- Task: `01a07b04-94db-7c13-a561-4cd0332003ef`.
- Title: `Synapse: real-native-20260907-mLlTsO`.
- New worktree: `/Users/manavmehta/.codex/worktrees/b587/synapse`.
- Isolated database: `/tmp/synapse-native-live-20260907.mLlTsO/inbox.sqlite`.
- Jobs: `34a674c2-5ba5-4df5-93c3-42e2a344ac22` and
  `6bf794f1-73d1-4a0c-b00b-e1f18cc2828d`.

The initial temporary-to-permanent task binding used an **explicit test
reconciliation** with the independently observed task ID. The installed hook
does not know this isolated test database. This proves actual native creation,
follow-up, and local persistence; it does not prove automatic installed-hook
reconciliation or cloud receipt completion. The task, worktree, and test
database are retained. Source and created worktree are clean.

## Live gaps and blocked checks

- Production `/receiver/identity` and `/assets/receiver-pairing.js` both return
  HTTP 404. The combined receiver backend is not deployed.
- The installed plugin still belongs to the earlier checkout. `doctor` detects
  that source mismatch; its missing login receipt does not override the real
  OAuth identity check, which passed.
- Two-account signup, email delivery, username messaging, receiver opt-in,
  cloud-to-local import, cloud receipts, and fresh organized retrieval have not
  passed a live combined workflow.
- The existing Railway HTTP service has a restricted runtime database URL,
  verified TLS, and a CA certificate. It has no admin/worker database URL,
  inference key, or Supabase admin secret. Values were consumed in memory and
  were not printed or written to an environment file.
- Direct hosted PostgreSQL read-back timed out from this machine. A bounded
  read-only Railway runtime attempt stopped because no SSH keys are registered;
  none were created. The checkpoint is acknowledged by MCP, but independent SQL
  read-back remains unverified.
- Supabase CLI reports that no access token is provided. No inference key is
  available in the scoped workspaces/process environment. The earlier graph
  experiment supplied its key ephemerally, not through a retained environment
  file.
- The in-app Railway browser requires sign-in, and later browser operations
  timed out; no external browser was connected. Existing CLI login recovered
  Railway access without extracting browser credentials or stored sessions.

## Cost and safety

Fresh inference spend remains **US$0 of the authorized US$5**. No mocked model
responses were counted as live tests. No production schema, existing user data,
installed plugin, or OS security settings were changed. The only Keychain item
created for this run was uniquely named and has been removed.

Complete testing needs an approved deployment target containing the integrated
migrations/server/worker, Supabase operator access, an inference key supplied
securely, and controlled test-account email access. Railway login is available;
new SSH access was not granted. The agent can run the tests; the missing access
and release rollout cannot be replaced with mocked success.
