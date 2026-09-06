import assert from "node:assert/strict";
import test from "node:test";

import { createApplication } from "../../src/server/app.mjs";
import { UsernameTakenError } from "../../src/server/database.mjs";

const identity = Object.freeze({
  principalType: "user",
  userId: "11111111-1111-4111-8111-111111111111",
  username: "tester",
  projectId: "22222222-2222-4222-8222-222222222222",
  projectAlias: "synapse",
  oauthClientId: "codex-client",
  authMethod: "oauth",
});
const memoryMarkdown = [
  "# Summary",
  "A concise memory.",
  "# What changed",
  "Cloud persistence was connected.",
  "# Decisions",
  "The user is the principal.",
  "# Still unresolved",
  "Production credentials.",
  "# Important references",
  "The cloud memory foundation.",
].join("\n\n");

function createConfig() {
  return {
    allowedHosts: ["127.0.0.1", "localhost"],
    resourceUrl: new URL("http://127.0.0.1/mcp"),
    resourceMetadataUrl: new URL(
      "http://127.0.0.1/.well-known/oauth-protected-resource",
    ),
    supabaseIssuer: "https://example.supabase.co/auth/v1",
    supabaseUrl: new URL("https://example.supabase.co/"),
    supabaseJwksUrl: new URL(
      "https://example.supabase.co/auth/v1/.well-known/jwks.json",
    ),
    supabasePublishableKey: "sb_publishable_example",
    cookieSecret: "x".repeat(32),
    publicSignup: true,
    requiredScopes: ["openid", "email", "profile"],
  };
}

async function fixture(t, { publicSignup = true } = {}) {
  const saves = [];
  const accounts = new Map();
  const database = {
    async healthCheck() {},
    async saveSessionMemory(receivedIdentity, input, requestId) {
      saves.push({ receivedIdentity, input, requestId });
      return {
        idempotent: false,
        nodeId: "33333333-3333-4333-8333-333333333333",
        sessionId: input.sessionId,
        revision: 1,
        contentHash: "a".repeat(64),
        savedAt: new Date("2026-09-06T00:00:00Z"),
      };
    },
    async getAccount(userId) {
      return accounts.get(userId) ?? null;
    },
    async registerAccount(userId, account) {
      if (account.username === "taken") throw new UsernameTakenError();
      const registered = {
        username: account.username,
        projectId: "33333333-3333-4333-8333-333333333333",
        projectAlias: account.projectAlias,
      };
      accounts.set(userId, registered);
      return registered;
    },
  };
  const config = createConfig();
  config.publicSignup = publicSignup;
  const verifier = {
    async verifyAccessToken(token) {
      if (token !== "valid") throw new Error("invalid token");
      return {
        token,
        clientId: identity.oauthClientId,
        scopes: [...config.requiredScopes],
        expiresAt: 2_000_000_000,
        resource: config.resourceUrl,
        extra: { identity },
      };
    },
  };
  const sessionVerifier = {
    async verifyAccessToken(token) {
      if (token !== "session") throw new Error("invalid session");
      return {
        userId: "66666666-6666-4666-8666-666666666666",
        sessionId: "77777777-7777-4777-8777-777777777777",
      };
    },
  };
  const logger = { info() {}, error() {} };
  const application = await createApplication({
    config,
    database,
    verifier,
    sessionVerifier,
    logger,
    fetchImplementation: async () =>
      new Response(JSON.stringify({ keys: [{ kid: "test" }] })),
  });
  const listener = application.app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  t.after(async () => {
    await new Promise((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    await application.server.close();
  });
  const port = listener.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    config,
    saves,
    accounts,
  };
}

async function mcp(baseUrl, body, token = "valid") {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-11-25",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("OAuth discovery, readiness, and bearer challenge are public", async (t) => {
  const { baseUrl } = await fixture(t);
  const metadata = await fetch(
    `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
  );
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), {
    resource: "http://127.0.0.1/mcp",
    authorization_servers: ["https://example.supabase.co/auth/v1"],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
    resource_name: "Synapse Memory",
  });
  assert.deepEqual(await (await fetch(`${baseUrl}/readyz`)).json(), {
    status: "ready",
  });
  const consent = await fetch(
    `${baseUrl}/authorize?authorization_id=oauth-request-1`,
  );
  assert.equal(consent.status, 200);
  const consentHtml = await consent.text();
  assert.match(consentHtml, /data-mode="consent"/);
  assert.match(consentHtml, /data-public-signup="true"/);
  const cookie = consent.headers.get("set-cookie").split(";", 1)[0];
  const callback = await fetch(`${baseUrl}/auth/callback`, {
    headers: { cookie },
  });
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /data-mode="callback"/);
  assert.equal(
    (await fetch(`${baseUrl}/authorize?authorization_id=bad%20request`)).status,
    400,
  );
  assert.equal((await fetch(`${baseUrl}/auth/callback`)).status, 400);
  const activation = await fetch(`${baseUrl}/auth/activate?code=invite-code`);
  assert.equal(activation.status, 200);
  assert.match(await activation.text(), /data-mode="activate"/);
  for (const asset of [
    "/assets/supabase.js",
    "/assets/consent.js",
    "/assets/consent.css",
  ]) {
    const assetResponse = await fetch(baseUrl + asset);
    assert.equal(
      assetResponse.status,
      200,
      `${asset}: ${await assetResponse.text()}`,
    );
  }
  const unauthorized = await mcp(
    baseUrl,
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    null,
  );
  assert.equal(unauthorized.response.status, 401);
  assert.match(
    unauthorized.response.headers.get("www-authenticate"),
    /resource_metadata="http:\/\/127\.0\.0\.1\/\.well-known\/oauth-protected-resource"/,
  );
});

test("an authenticated Supabase user can create an idempotent Synapse account", async (t) => {
  const { baseUrl } = await fixture(t);
  const headers = { authorization: "Bearer session" };

  const missing = await fetch(`${baseUrl}/auth/account`, { headers });
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), { status: "setup_required" });

  const created = await fetch(`${baseUrl}/auth/account`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ username: "new_agent", project_alias: "synapse" }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    status: "ready",
    username: "new_agent",
    project_alias: "synapse",
  });

  const retried = await fetch(`${baseUrl}/auth/account`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ username: "different", project_alias: "other" }),
  });
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), {
    status: "ready",
    username: "new_agent",
    project_alias: "synapse",
  });
});

test("account setup rejects unauthorized, invalid, conflicting, and closed registration", async (t) => {
  const { baseUrl } = await fixture(t);
  const unauthorized = await fetch(`${baseUrl}/auth/account`);
  assert.equal(unauthorized.status, 401);

  const invalid = await fetch(`${baseUrl}/auth/account`, {
    method: "POST",
    headers: {
      authorization: "Bearer session",
      "content-type": "application/json",
    },
    body: JSON.stringify({ username: "NO", project_alias: "x" }),
  });
  assert.equal(invalid.status, 422);

  const conflict = await fetch(`${baseUrl}/auth/account`, {
    method: "POST",
    headers: {
      authorization: "Bearer session",
      "content-type": "application/json",
    },
    body: JSON.stringify({ username: "taken", project_alias: "synapse" }),
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "username_taken" });

  const closedFixture = await fixture(t, { publicSignup: false });
  const closed = await fetch(`${closedFixture.baseUrl}/auth/account`, {
    method: "POST",
    headers: {
      authorization: "Bearer session",
      "content-type": "application/json",
    },
    body: JSON.stringify({ username: "new_agent", project_alias: "synapse" }),
  });
  assert.equal(closed.status, 403);
  assert.deepEqual(await closed.json(), { error: "registration_closed" });
});

test("MCP publishes exactly identity and memory-save tools with OAuth schemes", async (t) => {
  const { baseUrl } = await fixture(t);
  const initialized = await mcp(baseUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  assert.equal(initialized.response.status, 200);
  assert.equal(initialized.body.result.protocolVersion, "2025-11-25");

  const listed = await mcp(baseUrl, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  assert.deepEqual(
    listed.body.result.tools.map((tool) => tool.name),
    ["get_identity", "save_session_memory"],
  );
  for (const tool of listed.body.result.tools) {
    assert.deepEqual(tool.securitySchemes, [
      { type: "oauth2", scopes: ["openid", "email", "profile"] },
    ]);
  }
});

test("get_identity exposes the user principal and save preserves attribution", async (t) => {
  const { baseUrl, saves } = await fixture(t);
  const identityCall = await mcp(baseUrl, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_identity", arguments: {} },
  });
  assert.equal(
    identityCall.body.result.structuredContent.principal_type,
    "user",
  );
  assert.equal(
    identityCall.body.result.structuredContent.user_id,
    identity.userId,
  );
  assert.equal(
    identityCall.body.result.structuredContent.oauth_client_id,
    identity.oauthClientId,
  );

  const saved = await mcp(baseUrl, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "save_session_memory",
      arguments: {
        capture_id: "44444444-4444-4444-8444-444444444444",
        session_id: "codex-session-1",
        project_alias: "synapse",
        capture_reason: "turn_checkpoint",
        title: "Cloud memory foundation",
        summary: "The authenticated user owns this durable memory.",
        markdown: memoryMarkdown,
      },
    },
  });
  assert.equal(saved.body.result.structuredContent.saved, true);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].receivedIdentity, identity);
  assert.equal(saves[0].input.sessionId, "codex-session-1");
  assert.match(saves[0].requestId, /^[0-9a-f-]{36}$/);
});

test("save rejects a memory that omits the durable-memory headings", async (t) => {
  const { baseUrl, saves } = await fixture(t);
  const result = await mcp(baseUrl, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "save_session_memory",
      arguments: {
        capture_id: "55555555-5555-4555-8555-555555555555",
        session_id: "codex-session-1",
        project_alias: "synapse",
        capture_reason: "manual",
        title: "Incomplete memory",
        summary: "This should not be written.",
        markdown: "# Summary\nOnly one heading.",
      },
    },
  });
  assert.equal(result.body.result.isError, true);
  assert.equal(saves.length, 0);
});
