# Cloud memory operations

This runbook turns the checked-in foundation into a live service. It keeps
admin credentials on an operator machine and gives Railway only the restricted
runtime database login.

## Cost expectation

Supabase can start at `$0/month`: its current Free plan includes a 500 MB
database, 50,000 monthly active users, and 5 GB egress. Free projects can pause
after a week of low activity and do not include automatic database backups, so
use Pro before treating this as production data. Supabase's OAuth 2.1 server is
currently beta and available without an extra charge on all plans.

Railway has a `$0/month` Free tier with `$1/month` in resource credits after
the trial, but it has tighter compute/network limits. Hobby is `$5/month` and
includes `$5` of usage. A small server may fit the free credit; an always-ready
product service should budget at least Hobby plus Supabase Pro when durability
and no-pausing matter.

## 1. Create Supabase

Create a Supabase project in the region closest to the first users (Singapore
for the current deployment). Record these operator-only values in a local
password manager or ignored `.env` file:

```sh
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable-key>
SUPABASE_SECRET_KEY=<secret-key>
DATABASE_ADMIN_URL=<direct-postgres-admin-connection-string>
DATABASE_SSL=verify-full
DATABASE_CA_CERT=<Supabase CA certificate PEM>
```

Never put `SUPABASE_SECRET_KEY` or `DATABASE_ADMIN_URL` in Railway.

Apply the schema from this repository:

```sh
npm ci
npm run db:migrate
```

The migration creates the tables, forced RLS policies, append-only revision
permissions, custom access-token hook function, and a non-login
`synapse_runtime` role. Create its first password:

```sh
npm run synapse -- admin runtime-role rotate
```

Save the returned password once. Construct Railway's `DATABASE_URL` from the
Supabase direct or session-pooler connection string with username
`synapse_runtime` and that password. Do not use a transaction pooler: the
server uses transactions and `SET LOCAL` for RLS identity.

## 2. Create Railway service

Configure Railway to deploy the repository's `main` branch. Railway detects
the root `Dockerfile`; the image runs Node 24 as the unprivileged `node` user
and binds to Railway's injected `PORT`.

On a Trial or Hobby plan, choose the Singapore region; Railway's Free tier does
not offer global region selection. Generate a public Railway domain and set the
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
```

Generate the cookie secret locally, for example with
`openssl rand -base64 48`. The process refuses insecure production URLs,
inexact `/mcp` paths, weak cookie secrets, malformed booleans, and unverified
database certificates. Download the project CA from Supabase Database Settings
and paste it as a multiline sealed Railway variable.

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
   the Invite email template uses its confirmation link/redirect value so the
   operator-provided activation URL is retained.
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
   custom SMTP before allowing arbitrary public email addresses.

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

Set `PUBLIC_SIGNUP_ENABLED=true` on Railway and redeploy. Install the local
plugin on the user's machine, then start its OAuth flow:

```sh
codex plugin marketplace add /absolute/path/to/synapse
codex plugin add synapse@synapse
codex mcp login synapse-memory
```

Enter a Supabase project-team email address. After following the magic link,
choose a unique Synapse username and one project alias. The hosted service
verifies the Supabase session token and atomically creates the profile, project,
and memory root without receiving a user ID or email from the browser.

Register the local checkout using the alias chosen during signup:

```sh
npm run synapse -- project connect /absolute/path/to/checkout --alias <project-alias>
```

The consent UI uses an HttpOnly signed cookie to preserve the authorization
request across the email magic-link flow. It never accepts a callback target
from a query parameter; only Supabase's validated `redirect_url` is used. The
browser session token is accepted only by `/auth/account`; MCP tokens continue
to require the exact resource audience, OAuth client ID, and scopes.

Operator invitations remain available when closed onboarding is needed:

```sh
npm run synapse -- admin invite \
  --email person@example.com \
  --username person \
  --project synapse
```

## 5. Release gate

Run these before every deployment:

```sh
npm ci
npm audit --audit-level=high
npm test
npm run validate:plugin
docker build --tag synapse-memory:release .
```

CI repeats these checks against Postgres 17 and verifies RLS, identity
resolution, immutable revision creation, replay idempotency, and conflict
auditing. After deploy, perform the manual checks in
[`session-memory-plugin.md`](./session-memory-plugin.md).

Inspect logs for structured event names (`http_request`, `mcp_tool`, and error
events). IDs are hashed and memory content is never logged. Alert on repeated
401/403 responses, `memory.capture_conflict`, readiness failures, and process
restarts.

## 6. Recovery and rotation

- Supabase Free has no automatic backups. Before launch, upgrade to Pro or set
  up a tested logical backup outside Supabase; test restoring it into a
  disposable project.
- Railway rollbacks restore an earlier application image, not database schema.
  Migrations are forward-only and must remain backward compatible with the
  prior application during rollout.
- Rotate the runtime password with `admin runtime-role rotate`, update Railway's
  `DATABASE_URL`, deploy, and invalidate the old secret in the password manager.
- Rotate `COOKIE_SIGNING_SECRET` to invalidate incomplete consent flows; signed
  cookies expire after ten minutes anyway.
- Revoke an emergency development token by UUID with
  `admin token revoke --token-id <uuid>`. Production should keep
  `ALLOW_DEV_TOKENS=false`.
- To disable a user, set `profiles.status = 'disabled'` from an admin session.
  New identity resolution and development-token exchange then fail.

## Rollout order

Use a private alpha first: operator account, one self-registered team email,
then a handful of users after a week of clean audit and readiness data. Keep
`PUBLIC_SIGNUP_ENABLED=false` outside an active test window. Do not add
retrieval or background capture queues until save correctness, user isolation,
and restore drills have passed.
