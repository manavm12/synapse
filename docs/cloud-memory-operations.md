# Cloud service operations

This runbook describes deploying the assembled capture, messaging, receiver,
organizer, and retrieval code. It does not assert that this revision is deployed
or that real-user smoke tests have passed. Administrator credentials stay on the
operator machine; the HTTP service and memory worker use separate restricted
database credentials.

## Service and cost boundaries

Run `npm start` for HTTP, account setup, OAuth-backed MCP tools, and receiver
transport. Run `npm run worker` in a separate process/service for organization.
The HTTP process does not start a worker or require an inference key. Retrieval
is deterministic lexical lookup with source verification and makes no model
calls; organization uses paid extraction, reconciliation, and review requests.

Configure hosting capacity, backups, and a provider-side inference budget before
enabling the worker. Its per-request bounds and retry limits are not an overall
spend cap. Confirm current provider pricing independently; do not treat a local
validation budget as authorization for an always-on production worker.

## 1. Create Supabase

Create a Supabase project in the intended deployment region. Record these
operator-only values in a local
password manager or ignored `.env` file:

```sh
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable-key>
SUPABASE_SECRET_KEY=<secret-key>
DATABASE_ADMIN_URL=<direct-postgres-admin-connection-string>
DATABASE_SSL=verify-full
DATABASE_CA_CERT=<Supabase CA certificate PEM>
```

Never put `SUPABASE_SECRET_KEY` or `DATABASE_ADMIN_URL` in either hosted service.
Load the selected environment securely before running these commands; the CLI
does not automatically load an ignored `.env` file.

Apply the schema from this repository:

```sh
npm ci --ignore-scripts
npm run db:migrate
```

Apply every migration from the release checkout, in filename order, before the
matching application code. In addition to the foundation/onboarding migrations:

| Migration | Adds |
| --- | --- |
| `202609070001_cloud_messaging.sql` | Conversations, messages, participant RLS, idempotent sends and quotas. |
| `202609070002_memory_processing_queue.sql` | Revision jobs, project leases, fencing, and the worker role. |
| `202609070003_receiver_connections.sql` | Pairing, scoped installations, claim/import receipts and revocation. |
| `202609070004_memory_ledger.sql` | Tenant-scoped claims, evidence, relations, coverage and projections. |
| `202609080001_authorization_states.sql` | One-time hashed OAuth email-link state, expiry, replay protection, and issuance cooldown. |
| `202609090001_bound_receiver_setup.sql` | Account/project-bound plugin setup and exact-identity receiver consent. |

Migrations are an operator action, not an HTTP/worker startup step. The
foundation creates forced RLS policies, append-only revisions, the custom
access-token hook, and a non-login `synapse_runtime` role. Create its password:

```sh
npm run synapse -- admin runtime-role rotate
```

Save the returned password once. Construct Railway's `DATABASE_URL` from the
Supabase direct or session-pooler connection string with username
`synapse_runtime` and that password. Do not use a transaction pooler: the
server uses transactions and `SET LOCAL` for RLS identity. All connection URLs
must omit `ssl`, `sslmode`, `sslcert`, `sslkey`, `sslrootcert`, and other SSL
query options. These are rejected so the database driver cannot override
`DATABASE_SSL` and `DATABASE_CA_CERT`.

The queue migration also creates the non-login `synapse_memory_worker` role.
For the dedicated worker, use an operator-owned interactive PostgreSQL session:

```sql
ALTER ROLE synapse_memory_worker
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
```

Set its password with the interactive `psql` command
`\password synapse_memory_worker`; do not place a real password in shell
arguments or committed SQL. Construct `DATABASE_WORKER_URL` using this role and
store it only in the worker service. It must not be a member of
`synapse_runtime`, own the schema, be a superuser, or have `BYPASSRLS`.
The worker legitimately reads queued users' immutable revisions, so this is a
trusted backend credential, never a client credential. Derived writes remain
tenant-scoped and completion is checked against the current project lease.

## 2. Create the HTTP service

Configure Railway to deploy the repository's `main` branch. Railway detects
the root `Dockerfile`; the image runs Node 24 as the unprivileged `node` user
and binds to Railway's injected `PORT`.

Generate a public Railway domain and set the
healthcheck path to `/readyz`. The server explicitly allows Railway's
`healthcheck.railway.app` probe hostname. Configure these service variables:

```sh
NODE_ENV=production
MCP_RESOURCE_URL=https://<railway-domain>/mcp
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable-key>
COOKIE_SIGNING_SECRET=<at-least-32-random-characters>
DATABASE_URL=<synapse_runtime-connection-string>
DATABASE_SSL=verify-full
DATABASE_CA_CERT=<Supabase CA certificate PEM>
ALLOW_DEV_TOKENS=false
PUBLIC_SIGNUP_ENABLED=false
TRUST_PROXY_HOPS=0
```

Generate the cookie secret locally, for example with
`openssl rand -base64 48`. The process refuses insecure production URLs,
inexact `/mcp` paths, weak cookie secrets, malformed booleans, and unverified
database certificates. Download the project CA from Supabase Database Settings
and paste it as a multiline sealed Railway variable.

`TRUST_PROXY_HOPS` accepts integers from 0 to 10 and defaults to 0. It controls
the IP used for pairing rate limits. Increase it only after verifying the exact
trusted reverse-proxy hop count and that clients cannot reach a shorter path to
the process. Do not blindly trust client-supplied `X-Forwarded-For`; an excessive
hop count makes quota identities spoofable. Leaving it at 0 behind a proxy can
group users under the proxy's IP. Keep `OPENAI_API_KEY` and `DATABASE_WORKER_URL`
out of the HTTP service.

After deployment, verify both endpoints before configuring OAuth:

```sh
curl --fail https://<railway-domain>/healthz
curl --fail https://<railway-domain>/readyz
```

`/healthz` proves the process is up. `/readyz` additionally checks Postgres and
the Supabase JWKS document.

## 3. Configure Supabase Auth as the OAuth server

In Supabase Dashboard:

1. Under Authentication → URL Configuration, set Site URL to
   `https://<railway-domain>` and add
   `https://<railway-domain>/auth/callback` and
   `https://<railway-domain>/auth/activate` to allowed redirect URLs. Ensure
   the email templates retain the confirmation link/redirect value. Receiver
   login uses `/auth/activate?receiver_pairing=<uuid>` and then a validated
   same-origin pairing path. Preserve that query value; it is not an arbitrary
   callback URL and it does not automatically approve receiving.
2. Under Authentication → OAuth Server, enable OAuth 2.1 server capabilities,
   enable dynamic client registration, and set Authorization Path to
   `/authorize`.
3. Under Authentication → Signing Keys, migrate to an asymmetric signing key
   (RS256 or ES256). The `openid` scope requires asymmetric signing and the MCP
   validates tokens locally from JWKS.
4. Under Authentication → Hooks, enable the Postgres Custom Access Token hook
   `public.custom_access_token_hook`. It sets OAuth-token `aud` to the exact MCP
   resource URL while leaving non-OAuth sessions alone.
5. For an alpha that permits self-service account creation, enable email signup.
   Supabase's built-in sender delivers only to project-team addresses; configure
   custom SMTP before allowing arbitrary public email addresses. For Resend,
   verify a dedicated sending subdomain, use `smtp.resend.com`, username
   `resend`, port 465 or 587, and an API key as the password. Use a sender on the
   verified subdomain, disable click/open tracking for authentication mail, and
   leave inbound receiving disabled unless another feature needs it. Start with
   an email limit supported by the provider (30 per hour is suitable for a small
   alpha) and keep the resend interval at least 60 seconds.

Write the deployed URL to the hook's authoritative config and to the plugin:

```sh
export MCP_RESOURCE_URL=https://<railway-domain>/mcp
npm run synapse -- admin configure --mcp-url https://<railway-domain>/mcp
npm run configure:plugin -- https://<railway-domain>/mcp
npm run validate:plugin
```

Commit the resulting `plugins/synapse/.mcp.json`. Its `url` and
`oauth_resource` must be the same exact HTTPS URL, including `/mcp`.

## 4. Register and connect an alpha user

Enable `PUBLIC_SIGNUP_ENABLED=true` only when ready for self-service users.
Distribute the Synapse plugin through a recipient-accessible Codex marketplace.
Recipients install and sign in inside Codex; no repository, npm, system Node, or
runner installation is part of onboarding. Repository setup/doctor commands
remain developer/recovery wrappers.

During OAuth login, follow the email magic link and choose a unique Synapse
username and project alias. Without custom SMTP, use a Supabase project-team
address. The hosted service derives account IDs from the verified session,
never from browser-supplied IDs.

After signing in, select **Enable incoming tasks**, choose the saved local Git
project, and approve in the browser with the same account. The bundled skill
calls `get_identity` and `begin_receiver_setup`, then its helper finishes and
live-validates enrollment. A CLI login receipt alone is not proof of live access.

Before requesting an email, the consent UI exchanges its HttpOnly signed cookie
for a random one-time callback state. Only the state's SHA-256 hash and its
authorization ID are stored server-side. The state expires after ten minutes,
is consumed atomically, and a new request after the 60-second cooldown
supersedes the previous unconsumed link. This lets a user open the link in a
different browser without accepting a callback target from that browser. The
browser session token is accepted by account and receiver-approval endpoints;
MCP tokens continue to require the exact resource audience, OAuth client ID, and
scopes. Receiver credentials cannot use either account management or MCP tools.

Operator invitations remain available when closed onboarding is needed:

```sh
npm run synapse -- admin invite \
  --email person@example.com \
  --username person \
  --project synapse
```

## 5. Verify the local receiver

Before shipping the plugin, apply `202609090001_bound_receiver_setup.sql`
and deploy authenticated `begin_receiver_setup` support. The additive migration
preserves connected receivers and v1 transport endpoints. Bound browser approval
checks exact account/project IDs; aliases alone are insufficient.

On a clean Mac, install only the plugin, sign in, accept Enable, select a saved
local Git project, approve in the browser, and verify readiness. Trust Codex
hooks separately. Send one message from another account and submit a prompt in
an unrelated local chat: exactly one task must appear in the selected project.
Repeat from a projectless chat and a worktree; test Later followed by manual setup.
This live release gate is separate from mocked-native/database fixture tests.

The plugin's status action verifies live authorization. Keychain holds the raw
receiver credential; only the hash is sent through MCP. The asynchronous hook
uses the global destination, stages/acknowledges imports, then routes at most one
native delivery per invocation. It never polls while Codex is idle and never
places message content in unrelated chats. Legacy low-level CLI receiver
commands remain available only for developer/recovery use.

Unapproved pairings expire after ten minutes and can be resumed with connect.
Installations expire after 90 days. Use the plugin's explicit reconnect action for
an expired installation; the server accepts the matching expired credential for
revocation only. Preserve the credential and local state if revocation fails.

```sh
npm run synapse -- receiver disconnect /absolute/path/to/checkout
```

Disconnect marks unfinished assigned messages `needs_attention` and preserves
their assignment. It neither transfers them to another device nor cancels work
already dispatched. Only one installation may be enabled per project. See
[Receiver](receiver.md) for local uncertainty and receipt recovery.

## 6. Enable the separate organizer worker

Create a second service from the same release image with start command
`npm run worker`. It needs no public domain or HTTP healthcheck; HTTP `/readyz`
does not establish worker health. Set:

```sh
NODE_ENV=production
MEMORY_PROCESSING_ENABLED=true
DATABASE_WORKER_URL=<synapse_memory_worker-connection-string>
DATABASE_SSL=verify-full
DATABASE_CA_CERT=<Supabase CA certificate PEM>
OPENAI_API_KEY=<worker-only-inference-key>
MEMORY_MODEL=<explicit-extraction-and-reconciliation-model>
# Optional: otherwise uses MEMORY_MODEL.
MEMORY_REVIEW_MODEL=<explicit-review-model>
```

The selected models must support the structured Responses API requests used by
the adapter, including medium reasoning. Review is always enabled in the
production worker. The request uses the standard service tier with storage
disabled; no worker request is made merely by saving a memory in the HTTP
process. If `MEMORY_PROCESSING_ENABLED` is absent or false, worker startup exits
without opening a database or API connection.

| Optional setting | Default | Allowed range |
| --- | --- | --- |
| `MEMORY_MAX_STAGE_CALLS` | 2 | 1–3 per stage |
| `MEMORY_REQUEST_TIMEOUT_MS` | 60000 | 1000–180000 |
| `MEMORY_MAX_OUTPUT_TOKENS` | 8000 | 256–16000 |
| `MEMORY_POLL_INTERVAL_MS` | 2000 | 100–60000 |
| `MEMORY_ERROR_DELAY_MS` | 5000 | 100–60000 |
| `MEMORY_LEASE_DURATION_MS` | 60000 | 3000–300000 |

New captures commit an immutable revision and one processor-version-1 job in
one transaction. The worker processes outside the database transaction, then
commits the derived ledger and job success atomically under a renewable fenced
project lease. Failed work retries with bounded backoff, normally up to five
claims; a terminally failed earlier session revision blocks later revisions of
that session until investigated. Disabling the worker preserves captures and
queued jobs; it does not manufacture organized results.

Existing revisions predating queue integration are not automatically backfilled,
and an exact capture replay does not create a missing job. Use the operator-only
bounded backfill command with `DATABASE_ADMIN_URL` and verified TLS configured:

```sh
npm run memory:backfill -- --owner-id <owner-uuid> --project-id <project-uuid> --limit 100
# Review the dry-run IDs/counts, authorize inference cost, then explicitly enqueue:
npm run memory:backfill -- --owner-id <owner-uuid> --project-id <project-uuid> --limit 100 --apply
```

The default is a read-only preview, both UUIDs are required, and the batch limit
is 1–1000. The active owner/project relationship is verified in the database.
Apply adds only missing processor-v1 jobs; repeated/concurrent runs do not reset
existing queued, completed, or failed jobs. It never starts a worker or model
request, but an already-running worker can consume newly enqueued jobs and incur
cost. Pause that worker before backfilling if inference has not been authorized.
Repeat bounded batches until `has_more` is false. Failed older jobs still require
separate investigation and can block later revisions of the same session.
Exact source reads remain available without a derived ledger.

## 7. Release gate

Run these before every deployment:

```sh
npm ci --ignore-scripts
# Point TEST_DATABASE_URL at a disposable PostgreSQL 17 database only.
# Use DATABASE_SSL=disable only for this isolated local database.
npm run check
npm run audit
npm run validate:plugin
docker build --tag synapse-memory:release .
```

The full coverage gate requires `TEST_DATABASE_URL` with permission to create
test databases and roles. Tests create synthetic accounts and alter test roles;
never use a production or shared development database. Without that variable,
SQL suites are skipped and `npm test` is not a release gate. The package's SQL
and coverage commands serialize tests to avoid cluster-wide role creation
races. CI runs `npm run check` and the dependency audit using PostgreSQL 17.

Local mocks and disposable Postgres can verify tenant isolation, immutable
capture, queue fencing, claim/import idempotency, ordering, revocation, bounded
retrieval, and native failure handling. They do not establish live SMTP/OAuth,
macOS Keychain permissions, installed native-task compatibility, or semantic
recall. After an approved deployment, separately verify with two consenting test
accounts: signup and usernames, fresh-task identity, capture and exact source
read, receiver connect/approve/finish, send/status/import/native binding, and
revocation. Verify organizer results against sources using a separately approved
live inference budget. Do not describe fixtures as live model validation. Also
perform the capture checks in [Session memory plugin](session-memory-plugin.md).

Inspect logs for structured event names (`http_request`, `mcp_tool`, and error
events), plus `memory_worker_started`, `memory_worker_job_finished`, and worker
failure events. Operational request/job IDs may appear, so keep logs private;
do not add credentials, message bodies, source Markdown, or provider response
bodies to them. Alert on repeated
401/403 responses, `memory.capture_conflict`, readiness failures, and process
restarts, a growing processing backlog, terminally failed jobs, and persistent
`needs_attention` receipts. HTTP readiness alone is not a complete product check.

## 8. Recovery and rotation

- Verify the selected database plan's retention/backup guarantees and test
  restoring a backup into a disposable project before accepting durable data.
- Railway rollbacks restore an earlier application image, not database schema.
  Migrations are forward-only and must remain backward compatible with the
  prior application during rollout.
- Rotate the runtime password with `admin runtime-role rotate`, update Railway's
  `DATABASE_URL`, deploy, and invalidate the old secret in the password manager.
- Rotate the dedicated worker password separately, update only
  `DATABASE_WORKER_URL`, and restart that service. Rotate the inference key only
  in the worker. Never solve a permissions error by substituting an admin URL.
- Rotate `COOKIE_SIGNING_SECRET` to invalidate incomplete consent flows; signed
  cookies expire after ten minutes anyway.
- Revoke an emergency development token by UUID with
  `admin token revoke --token-id <uuid>`. Production should keep
  `ALLOW_DEV_TOKENS=false`.
- To disable a user, set `profiles.status = 'disabled'` from an admin session.
  New identity resolution and receiver authorization then fail. It cannot revoke
  a native mutation that was already accepted.
- Treat uncertain native mutations as requiring reconciliation, not permission
  to replay. Preserve local inbox/outbox data and immutable cloud revisions;
  investigate before retrying terminally failed organization or stranded jobs.

## Rollout order

Apply migrations and provision the separate roles; deploy HTTP with signup
closed; verify authentication/capture/source reads; open a small approved alpha;
enroll a receiver and run the two-user transport checks; then enable the worker
with explicit models, credentials, and a spend limit. Confirm organized evidence
and retrieval behavior before expanding access. Preserve raw capture even when
organization is disabled or fails. Do not deploy until outstanding feature
reviews and the combined local release gate are complete.
