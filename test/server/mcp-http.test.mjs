import assert from "node:assert/strict";
import test from "node:test";

import { ListToolsResultSchema } from "@modelcontextprotocol/core";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";

import { createApplication } from "../../src/server/app.mjs";
import {
  AccountDisabledError,
  AuthorizationStateCooldownError,
  UsernameTakenError,
} from "../../src/server/database.mjs";

const identity = Object.freeze({
  principalType: "user",
  userId: "11111111-1111-4111-8111-111111111111",
  username: "tester",
  projectId: "22222222-2222-4222-8222-222222222222",
  projectAlias: "synapse",
  oauthClientId: "codex-client",
  authMethod: "oauth",
});
const receiverCredential = `syn_recv_${"A".repeat(43)}`;
const receiverIdentity = Object.freeze({
  installationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  userId: "66666666-6666-4666-8666-666666666666",
  username: "receiver",
  projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  projectAlias: "synapse",
  expiresAt: new Date("2026-12-01T00:00:00Z"),
  enabled: true,
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

async function fixture(t, { publicSignup = true, memoryRetrieval } = {}) {
  const saves = [];
  const sentMessages = [];
  let receiverPairingApproved = false;
  const accounts = new Map();
  const authorizationStates = new Map();
  const activeAuthorizationStates = new Set();
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
      if (account.username === "disabled") throw new AccountDisabledError();
      const registered = {
        username: account.username,
        projectId: "33333333-3333-4333-8333-333333333333",
        projectAlias: account.projectAlias,
      };
      accounts.set(userId, registered);
      return registered;
    },
    async createAuthorizationState(authorizationId, stateHash) {
      if (activeAuthorizationStates.has(authorizationId)) {
        throw new AuthorizationStateCooldownError();
      }
      activeAuthorizationStates.add(authorizationId);
      authorizationStates.set(stateHash.toString("hex"), authorizationId);
      return { expiresAt: new Date(Date.now() + 10 * 60_000) };
    },
    async consumeAuthorizationState(stateHash) {
      const key = stateHash.toString("hex");
      const authorizationId = authorizationStates.get(key) ?? null;
      authorizationStates.delete(key);
      if (authorizationId) activeAuthorizationStates.delete(authorizationId);
      return authorizationId;
    },
    async resolveAuthorizationState(stateHash) {
      return authorizationStates.get(stateHash.toString("hex")) ?? null;
    },
    async sendMessage(receivedIdentity, input) {
      sentMessages.push({ receivedIdentity, input });
      return {
        messageId: "88888888-8888-4888-8888-888888888888",
        conversationId: "99999999-9999-4999-8999-999999999999",
        sequence: 1,
        recipient: {
          userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          username: "recipient",
        },
        status: "queued",
        idempotent: false,
      };
    },
    async getMessageStatus(_receivedIdentity, messageId) {
      return {
        messageId,
        conversationId: "99999999-9999-4999-8999-999999999999",
        sequence: 1,
        status: "queued",
        queuedAt: new Date("2026-09-07T00:00:00Z"),
        importedAt: null,
        provisioningAt: null,
        deliveredAt: null,
        needsAttentionAt: null,
        failureReason: null,
        receiverActionNeeded: true,
      };
    },
    async listInbox() {
      return { messages: [], next: null };
    },
    async createReceiverPairing() {
      return {
        pairingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        expiresAt: new Date("2026-09-07T00:10:00Z"),
      };
    },
    async approveReceiverPairing() {
      receiverPairingApproved = true;
      return receiverIdentity;
    },
    async completeReceiverPairing() {
      return receiverPairingApproved
        ? { status: "connected", identity: receiverIdentity }
        : { status: "pending" };
    },
    async getReceiverIdentity(credential) {
      return credential === receiverCredential ? receiverIdentity : null;
    },
    async claimReceiverMessages() {
      return { messages: [] };
    },
    async importReceiverMessage(_credential, input) {
      return { messageId: input.messageId, status: "in_receiver_inbox" };
    },
    async getReceiverMessage(_credential, messageId) {
      return { messageId, status: "in_receiver_inbox", imported: true };
    },
    async recordReceiverEvents(_credential, events) {
      return events.map((event) => event.eventId);
    },
    async disconnectReceiver(credential) {
      return credential === receiverCredential;
    },
  };
  const config = createConfig();
  config.publicSignup = publicSignup;
  const verifier = {
    async verifyAccessToken(token) {
      if (token !== "valid") {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid token");
      }
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
    memoryRetrieval,
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
    sentMessages,
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
  const missingHeader = await fetch(`${baseUrl}/auth/state`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(missingHeader.status, 403);
  const stateResponse = await fetch(`${baseUrl}/auth/state`, {
    method: "POST",
    headers: { cookie, "x-synapse-auth-request": "1" },
  });
  assert.equal(stateResponse.status, 201);
  const state = await stateResponse.json();
  assert.equal(state.cooldown_seconds, 60);
  assert.match(state.redirect_to, /\/auth\/callback\?state=[A-Za-z0-9_-]{43}$/);
  const duplicateState = await fetch(`${baseUrl}/auth/state`, {
    method: "POST",
    headers: { cookie, "x-synapse-auth-request": "1" },
  });
  assert.equal(duplicateState.status, 429);
  assert.equal(duplicateState.headers.get("retry-after"), "60");
  const callbackPath =
    new URL(state.redirect_to).pathname + new URL(state.redirect_to).search;
  const callback = await fetch(baseUrl + callbackPath);
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /data-mode="callback"/);
  const callbackCookie = callback.headers.get("set-cookie").split(";", 1)[0];
  assert.match(callbackCookie, /synapse_authorization=/);
  assert.equal((await fetch(baseUrl + callbackPath)).status, 200);
  const unauthenticatedConsume = await fetch(`${baseUrl}/auth/state/consume`, {
    method: "POST",
    headers: {
      cookie: callbackCookie,
      "content-type": "application/json",
      "x-synapse-auth-request": "1",
    },
    body: JSON.stringify({
      state: new URL(state.redirect_to).searchParams.get("state"),
    }),
  });
  assert.equal(unauthenticatedConsume.status, 401);
  const invalidSessionConsume = await fetch(`${baseUrl}/auth/state/consume`, {
    method: "POST",
    headers: {
      authorization: "Bearer invalid",
      cookie: callbackCookie,
      "content-type": "application/json",
      "x-synapse-auth-request": "1",
    },
    body: JSON.stringify({
      state: new URL(state.redirect_to).searchParams.get("state"),
    }),
  });
  assert.equal(invalidSessionConsume.status, 401);
  const consumeState = await fetch(`${baseUrl}/auth/state/consume`, {
    method: "POST",
    headers: {
      authorization: "Bearer session",
      cookie: callbackCookie,
      "content-type": "application/json",
      "x-synapse-auth-request": "1",
    },
    body: JSON.stringify({
      state: new URL(state.redirect_to).searchParams.get("state"),
    }),
  });
  assert.equal(consumeState.status, 204);
  const reissuedState = await fetch(`${baseUrl}/auth/state`, {
    method: "POST",
    headers: { cookie, "x-synapse-auth-request": "1" },
  });
  assert.equal(reissuedState.status, 201);
  assert.notEqual((await reissuedState.json()).redirect_to, state.redirect_to);
  assert.equal((await fetch(baseUrl + callbackPath)).status, 400);
  assert.equal(
    (await fetch(`${baseUrl}/authorize?authorization_id=bad%20request`)).status,
    400,
  );
  assert.equal((await fetch(`${baseUrl}/auth/callback`)).status, 400);
  const activation = await fetch(`${baseUrl}/auth/activate?code=invite-code`);
  assert.equal(activation.status, 200);
  assert.match(await activation.text(), /data-mode="activate"/);
  const receiverCallback = await fetch(
    `${baseUrl}/auth/activate?receiver_pairing=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
  );
  assert.equal(receiverCallback.status, 200);
  assert.match(await receiverCallback.text(), /data-mode="receiver_callback"/);
  assert.equal(
    (
      await fetch(
        `${baseUrl}/auth/activate?receiver_pairing=https%3A%2F%2Fevil.example`,
      )
    ).status,
    400,
  );
  for (const asset of [
    "/assets/supabase.js",
    "/assets/consent.js",
    "/assets/email-submission.js",
    "/assets/consent.css",
  ]) {
    const assetResponse = await fetch(baseUrl + asset);
    assert.equal(
      assetResponse.status,
      200,
      `${asset}: ${await assetResponse.text()}`,
    );
  }
  const consentScript = await (
    await fetch(`${baseUrl}/assets/consent.js`)
  ).text();
  assert.match(consentScript, /flowType: "implicit"/);
  assert.match(consentScript, /x-synapse-auth-request/);
  const emailSubmissionScript = await (
    await fetch(`${baseUrl}/assets/email-submission.js`)
  ).text();
  const emailSubmissionModule = await import(
    `data:text/javascript;base64,${Buffer.from(emailSubmissionScript).toString("base64")}`
  );
  let now = 1_000;
  let submissions = 0;
  const button = { disabled: false, textContent: "Send link" };
  const form = {
    addEventListener() {},
    querySelector() {
      return button;
    },
  };
  const panel = { hidden: false };
  const status = { className: "", textContent: "" };
  const shownErrors = [];
  const controller = emailSubmissionModule.installEmailSubmission({
    form,
    panel,
    status,
    now: () => now,
    readEmail: () => "person@example.com",
    showError(error) {
      shownErrors.push(error.message);
    },
    async submit() {
      submissions += 1;
      return { cooldownSeconds: 60 };
    },
  });
  t.after(() => controller.dispose());
  await controller.handleSubmit({ preventDefault() {} });
  now += 1_000;
  await controller.handleSubmit({ preventDefault() {} });
  assert.equal(submissions, 1);
  assert.equal(button.textContent, "Try again in 60s");

  const limitedButton = { disabled: false, textContent: "Send link" };
  const limitedController = emailSubmissionModule.installEmailSubmission({
    form: {
      addEventListener() {},
      querySelector() {
        return limitedButton;
      },
    },
    panel: { hidden: false },
    status: { className: "", textContent: "" },
    now: () => now,
    readEmail: () => "person@example.com",
    showError(error) {
      shownErrors.push(error.message);
    },
    async submit() {
      throw Object.assign(new Error("Too many requests"), {
        status: 429,
        retryAfterSeconds: 30,
      });
    },
  });
  t.after(() => limitedController.dispose());
  await limitedController.handleSubmit({ preventDefault() {} });
  assert.equal(limitedButton.textContent, "Try again in 30s");
  assert.equal(
    shownErrors.at(-1),
    "Please wait a minute before requesting another link.",
  );
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
  assert.equal(missing.headers.get("cache-control"), "no-store");
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

  const disabled = await fetch(`${baseUrl}/auth/account`, {
    method: "POST",
    headers: {
      authorization: "Bearer session",
      "content-type": "application/json",
    },
    body: JSON.stringify({ username: "disabled", project_alias: "synapse" }),
  });
  assert.equal(disabled.status, 403);
  assert.deepEqual(await disabled.json(), { error: "account_disabled" });

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

test("MCP publishes memory and messaging tools with OAuth schemes", async (t) => {
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
    [
      "get_identity",
      "save_session_memory",
      "send_message",
      "get_message_status",
      "list_inbox",
      "begin_receiver_setup",
    ],
  );
  for (const tool of listed.body.result.tools) {
    assert.deepEqual(tool.securitySchemes, [
      { type: "oauth2", scopes: ["openid", "email", "profile"] },
    ]);
  }
});

test("MCP publishes and authenticates bounded memory retrieval tools", async (t) => {
  const calls = [];
  const memoryRetrieval = {
    async topics(receivedIdentity, input) {
      calls.push({ tool: "memory_topics", receivedIdentity, input });
      return {
        catalog_status: "ready",
        generation: 3,
        topic: {
          id: "root",
          title: "Project memory",
          summary: "Evidence-backed claim views",
          parent_id: null,
        },
        entries: [],
        next_cursor: null,
      };
    },
    async search(receivedIdentity, input) {
      calls.push({ tool: "search_memory", receivedIdentity, input });
      return {
        catalog_status: "ready",
        generation: 3,
        query: input.query,
        status: input.status ?? "current",
        results: [],
        next_cursor: null,
      };
    },
    async read(receivedIdentity, input) {
      calls.push({ tool: "read_memory", receivedIdentity, input });
      if (input.target_type === "source") {
        return {
          catalog_status: "ready",
          generation: 3,
          target_type: "source",
          source: {
            revision_id: input.target_id,
            node_id: "33333333-3333-4333-8333-333333333333",
            session_id: "session-1",
            revision: 1,
            title: "Source",
            summary: "Summary",
            captured_at: "2026-09-01T00:00:00.000Z",
            content_hash: "a".repeat(64),
            capture_content_hash: "b".repeat(64),
            processed: true,
            start: 0,
            end: 5,
            text: "Exact",
          },
          next_cursor: null,
        };
      }
      if (input.target_type === "claim") {
        return {
          catalog_status: "ready",
          generation: 3,
          target_type: "claim",
          note: null,
          claim: {
            claim_id: input.target_id,
            canonical_claim_id: input.target_id,
            title: "Claim",
            assertion: "Exact assertion.",
            assertion_truncated: false,
            subject: "Subject",
            aspect: "Aspect",
            scope: "production",
            kind: "fact",
            status: "active",
            current: true,
            conflicted: false,
            topic: "Operations",
            subtopic: "Logging",
            observed_at: "2026-09-01T00:00:00.000Z",
            recorded_at: "2026-09-01T00:00:01.000Z",
            source_revision_id: "44444444-4444-4444-8444-444444444444",
            relations: [],
          },
          evidence: [],
          next_cursor: null,
        };
      }
      return {
        catalog_status: "ready",
        generation: 3,
        target_type: "note",
        note: {
          note_id: input.target_id,
          title: "Note",
          body: "Current claim — Exact assertion.",
          body_truncated: false,
          kind: "fact",
          status: "active",
          conflicted: false,
          observed_at: "2026-09-01T00:00:00.000Z",
          claim_ids: ["claim:test"],
        },
        claim: null,
        evidence: [],
        next_cursor: null,
      };
    },
  };
  const { baseUrl } = await fixture(t, { memoryRetrieval });
  const listed = await mcp(baseUrl, {
    jsonrpc: "2.0",
    id: 20,
    method: "tools/list",
    params: {},
  });
  assert.deepEqual(
    listed.body.result.tools.map((tool) => tool.name),
    [
      "get_identity",
      "save_session_memory",
      "memory_topics",
      "search_memory",
      "read_memory",
      "send_message",
      "get_message_status",
      "list_inbox",
      "begin_receiver_setup",
    ],
  );
  assert.equal(
    ListToolsResultSchema.safeParse(listed.body.result).success,
    true,
  );
  const retrievalTools = listed.body.result.tools.slice(2, 5);
  assert.ok(
    retrievalTools.every(
      (tool) => !/owner_id|project_id/.test(JSON.stringify(tool.inputSchema)),
    ),
  );
  assert.match(retrievalTools[1].description, /deterministic lexical/);

  const searched = await mcp(baseUrl, {
    jsonrpc: "2.0",
    id: 21,
    method: "tools/call",
    params: {
      name: "search_memory",
      arguments: { query: "retention", status: "historical" },
    },
  });
  assert.equal(searched.body.result.structuredContent.status, "historical");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receivedIdentity, identity);
  assert.deepEqual(calls[0].input, {
    query: "retention",
    status: "historical",
  });

  const readCases = [
    { target_type: "note", target_id: "item:test", evidence_limit: 2 },
    { target_type: "claim", target_id: "claim:test" },
    {
      target_type: "source",
      target_id: "44444444-4444-4444-8444-444444444444",
      max_chars: 5,
    },
  ];
  for (const [index, arguments_] of readCases.entries()) {
    const read = await mcp(baseUrl, {
      jsonrpc: "2.0",
      id: 30 + index,
      method: "tools/call",
      params: { name: "read_memory", arguments: arguments_ },
    });
    assert.equal(read.body.result.isError, undefined);
    assert.equal(
      read.body.result.structuredContent.target_type,
      arguments_.target_type,
    );
    assert.equal(calls.at(-1).receivedIdentity, identity);
  }

  const callCount = calls.length;
  for (const arguments_ of [
    { target_type: "source", target_id: "not-a-uuid" },
    {
      target_type: "source",
      target_id: "44444444-4444-4444-8444-444444444444",
      evidence_limit: 2,
    },
    { target_type: "note", target_id: "item:test", max_chars: 20 },
    { target_type: "unknown", target_id: "item:test" },
  ]) {
    const invalid = await mcp(baseUrl, {
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: { name: "read_memory", arguments: arguments_ },
    });
    assert.equal(invalid.body.result.isError, true);
  }
  assert.equal(calls.length, callCount);

  const rejected = await mcp(baseUrl, {
    jsonrpc: "2.0",
    id: 22,
    method: "tools/call",
    params: {
      name: "search_memory",
      arguments: { query: "retention", owner_id: identity.userId },
    },
  });
  assert.equal(rejected.body.result.isError, true);
  assert.equal(calls.length, callCount);
});

test("messaging MCP sends by username and exposes participant status", async (t) => {
  const { baseUrl, sentMessages } = await fixture(t);
  const sent = await mcp(baseUrl, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "send_message",
      arguments: {
        to_username: "@recipient",
        message: "Please investigate the durable queue.",
        request_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      },
    },
  });
  assert.equal(sent.body.result.structuredContent.status, "queued");
  assert.equal(
    sent.body.result.structuredContent.recipient.username,
    "recipient",
  );
  assert.equal(sentMessages[0].receivedIdentity, identity);
  assert.equal(sentMessages[0].input.toUsername, "@recipient");

  const status = await mcp(baseUrl, {
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "get_message_status",
      arguments: { message_id: "88888888-8888-4888-8888-888888888888" },
    },
  });
  assert.equal(
    status.body.result.structuredContent.receiver_action_needed,
    true,
  );
  assert.equal(status.body.result.structuredContent.imported_at, null);
});

test("receiver pairing and scoped transport routes preserve the v1 wire shape", async (t) => {
  const { baseUrl } = await fixture(t);
  const pairing = await fetch(`${baseUrl}/receiver/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential_hash: "a".repeat(64) }),
  });
  assert.equal(pairing.status, 201);
  const pairingBody = await pairing.json();
  assert.equal(pairingBody.pairing_id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.match(pairingBody.verification_url, /\/receiver\/pairings\//);

  const verificationPath = new URL(pairingBody.verification_url).pathname;
  const page = await fetch(baseUrl + verificationPath);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Enable incoming tasks/);

  const pending = await fetch(
    `${baseUrl}/receiver/pairings/${pairingBody.pairing_id}/complete`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${receiverCredential}` },
    },
  );
  assert.equal(pending.status, 202);
  assert.deepEqual(await pending.json(), { status: "pending" });

  const approved = await fetch(
    `${baseUrl}/auth/receiver-pairings/${pairingBody.pairing_id}/approve`,
    { method: "POST", headers: { authorization: "Bearer session" } },
  );
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).identity.project_alias, "synapse");

  const completed = await fetch(
    `${baseUrl}/receiver/pairings/${pairingBody.pairing_id}/complete`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${receiverCredential}` },
    },
  );
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).status, "connected");

  const identityResponse = await fetch(`${baseUrl}/receiver/identity`, {
    headers: { authorization: `Bearer ${receiverCredential}` },
  });
  assert.equal(identityResponse.status, 200);
  assert.equal((await identityResponse.json()).identity.username, "receiver");

  const claim = await fetch(`${baseUrl}/receiver/claim`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${receiverCredential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ limit: 10 }),
  });
  assert.deepEqual((await claim.json()).messages, []);

  const imported = await fetch(`${baseUrl}/receiver/import`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${receiverCredential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message_id: "88888888-8888-4888-8888-888888888888",
      claim_token: "b".repeat(64),
    }),
  });
  assert.deepEqual(await imported.json(), {
    message_id: "88888888-8888-4888-8888-888888888888",
    status: "in_receiver_inbox",
  });

  const message = await fetch(
    `${baseUrl}/receiver/messages/88888888-8888-4888-8888-888888888888`,
    { headers: { authorization: `Bearer ${receiverCredential}` } },
  );
  assert.deepEqual(await message.json(), {
    message_id: "88888888-8888-4888-8888-888888888888",
    status: "in_receiver_inbox",
    imported: true,
  });

  const eventId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const events = await fetch(`${baseUrl}/receiver/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${receiverCredential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      events: [
        {
          event_id: eventId,
          message_id: "88888888-8888-4888-8888-888888888888",
          kind: "delivered",
          occurred_at: "2026-09-07T00:00:00.000Z",
        },
      ],
    }),
  });
  assert.deepEqual(await events.json(), { accepted_event_ids: [eventId] });

  const unsafeEvent = await fetch(`${baseUrl}/receiver/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${receiverCredential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      events: [
        {
          event_id: eventId,
          message_id: "88888888-8888-4888-8888-888888888888",
          kind: "delivered",
          occurred_at: "2026-09-07T00:00:00.000Z",
          error_code: "/private/native/task/id",
        },
      ],
    }),
  });
  assert.equal(unsafeEvent.status, 422);

  const receiverCannotUseMcp = await mcp(
    baseUrl,
    { jsonrpc: "2.0", id: 20, method: "tools/list", params: {} },
    receiverCredential,
  );
  assert.equal(receiverCannotUseMcp.response.status, 401);

  const otherCredential = `syn_recv_${"B".repeat(43)}`;
  const denied = await fetch(`${baseUrl}/receiver/identity`, {
    headers: { authorization: `Bearer ${otherCredential}` },
  });
  assert.equal(denied.status, 401);
  const deniedDisconnect = await fetch(`${baseUrl}/receiver/disconnect`, {
    method: "POST",
    headers: { authorization: `Bearer ${otherCredential}` },
  });
  assert.equal(deniedDisconnect.status, 401);

  const disconnected = await fetch(`${baseUrl}/receiver/disconnect`, {
    method: "POST",
    headers: { authorization: `Bearer ${receiverCredential}` },
  });
  assert.deepEqual(await disconnected.json(), { disconnected: true });
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
