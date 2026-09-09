import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import pg from "pg";
import { recordPromptHook } from "../../plugins/synapse/lib/hook-health.mjs";
import {
  acceptProvisioning,
  acknowledgeMessage,
  getJob,
  listPendingCloudEvents,
  markNativeMutationIssued,
  reserveNextMessage,
  withInbox,
} from "../../plugins/synapse/lib/inbox.mjs";
import { reconcileNativeBindings } from "../../plugins/synapse/lib/native-reconcile.mjs";
import { routeDelivery } from "../../plugins/synapse/lib/native-router.mjs";
import {
  completeSetup,
  disableSetup,
  prepareSetup,
} from "../../plugins/synapse/lib/plugin-setup.mjs";
import { ReceiverClient } from "../../plugins/synapse/lib/receiver-client.mjs";
import { getReceiverConnectionById } from "../../plugins/synapse/lib/receiver-registry.mjs";
import { syncReceiver } from "../../plugins/synapse/lib/receiver-sync.mjs";
import { runMigrations } from "../../scripts/migrate.mjs";
import {
  disconnectReceiver,
  startReceiverConnection,
} from "../../src/client/receiver/enrollment.mjs";
import { createApplication } from "../../src/server/app.mjs";
import { createDatabase } from "../../src/server/database.mjs";

const adminUrl = process.env.TEST_DATABASE_URL;
const ssl = process.env.DATABASE_SSL === "disable" ? false : undefined;

test("signup, username send, receiver enrollment, local delivery and cloud receipts compose", {
  skip: !adminUrl,
  timeout: 60_000,
}, async (t) => {
  // Only this randomly named database and temporary directory are mutated.
  // Auth, Keychain and native Codex transport are explicit test doubles.
  const admin = new pg.Pool({ connectionString: adminUrl, ssl });
  const name = `synapse_message_flow_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await admin.query(`create database "${name}" template template0`);
  const seed = new pg.Pool({ connectionString: url.href, ssl });
  let database;
  let application;
  let listener;
  const directory = await mkdtemp(join(tmpdir(), "synapse-message-flow-"));
  t.after(async () => {
    if (listener) await new Promise((resolve) => listener.close(resolve));
    await application?.server.close();
    await database?.close();
    await seed.end();
    await admin.query(`drop database "${name}"`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });
  await seed.query(
    await readFile(new URL("../sql/bootstrap.sql", import.meta.url), "utf8"),
  );
  await runMigrations({
    connectionString: url.href,
    ssl,
    output: { write() {} },
  });
  // Exercise the real runtime role/RLS without changing any cluster password.
  url.searchParams.set("options", "-c role=synapse_runtime");
  database = createDatabase({ databaseUrl: url.href, databaseSsl: ssl });
  const users = new Map(
    ["alice", "bob", "eve"].map((user) => [user, randomUUID()]),
  );
  for (const [user, id] of users) {
    await seed.query("insert into auth.users(id,email) values($1,$2)", [
      id,
      `${user}@example.test`,
    ]);
  }
  const config = {
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
    supabasePublishableKey: "sb_publishable_fixture",
    cookieSecret: "fixture-secret-not-production-".repeat(2),
    publicSignup: true,
    requiredScopes: ["openid", "email", "profile"],
  };
  application = await createApplication({
    config,
    database,
    memoryRetrieval: database.memoryRetrieval,
    logger: { info() {}, error() {} },
    sessionVerifier: {
      async verifyAccessToken(token) {
        const userId = users.get(token.replace(/^session:/, ""));
        if (!token.startsWith("session:") || !userId)
          throw new Error("Invalid fixture session");
        return { userId, sessionId: randomUUID() };
      },
    },
    verifier: {
      async verifyAccessToken(token) {
        const userId = users.get(token);
        if (!userId)
          throw new OAuthError(
            OAuthErrorCode.InvalidToken,
            "Invalid fixture access token",
          );
        const identity = await database.resolveIdentity(userId, {
          authMethod: "oauth",
          oauthClientId: "fixture-client",
        });
        return {
          token,
          clientId: "fixture-client",
          scopes: config.requiredScopes,
          expiresAt: 4_000_000_000,
          resource: config.resourceUrl,
          extra: { identity },
        };
      },
    },
  });
  listener = application.app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${listener.address().port}`;
  config.resourceUrl = new URL(`${baseUrl}/mcp`);
  async function post(path, token, body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, body: await response.json() };
  }
  async function call(user, tool, args, { isError = false } = {}) {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${user}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.result, JSON.stringify(body));
    assert.equal(body.result.isError === true, isError, JSON.stringify(body));
    return body.result.structuredContent ?? body.result;
  }
  for (const user of users.keys()) {
    const registered = await post("/auth/account", `session:${user}`, {
      username: user,
      project_alias: "demo",
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.username, user);
  }
  const request = {
    to_username: "@BOB",
    message: "Review the synthetic release notes.",
    request_id: randomUUID(),
  };
  const sent = await call("alice", "send_message", request);
  assert.equal(sent.status, "queued");
  const replay = await call("alice", "send_message", request);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.message_id, sent.message_id);
  assert.equal((await call("bob", "list_inbox", {})).messages.length, 1);
  assert.equal((await call("eve", "list_inbox", {})).messages.length, 0);
  await call(
    "eve",
    "get_message_status",
    { message_id: sent.message_id },
    { isError: true },
  );

  const root = join(directory, "project");
  const registryPath = join(directory, "registry.sqlite");
  const inboxOptions = { path: join(directory, "inbox.sqlite") };
  const registry = new DatabaseSync(registryPath);
  registry.exec(
    "CREATE TABLE projects (alias TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE)",
  );
  registry.prepare("INSERT INTO projects VALUES (?, ?)").run("demo", root);
  registry.close();
  const secrets = new Map();
  const secretStore = {
    get: async (key) => secrets.get(key),
    set: async (key, value) => secrets.set(key, value),
    delete: async (key) => secrets.delete(key),
  };
  const options = {
    registryPath,
    secretStore,
    resolveRoot: async () => root,
    env: {
      SYNAPSE_ALLOW_INSECURE_RECEIVER_HTTP: "1",
      CODEX_THREAD_ID: "fixture-owner",
    },
    openBrowser: false,
  };
  const oauthIdentity = await call("bob", "get_identity", {});
  recordPromptHook(
    { hook_event_name: "UserPromptSubmit", session_id: "fixture-owner" },
    { path: registryPath },
  );
  const unpublished = await prepareSetup(
    { identity: oauthIdentity },
    { ...options, serverUrl: baseUrl },
  );
  // Unknown credentials are definitively absent at the revoke-only endpoint.
  await disableSetup({ connection_id: unpublished.connection_id }, options);
  assert.equal(secrets.size, 0);
  const prepared = await prepareSetup(
    { identity: oauthIdentity },
    { ...options, serverUrl: baseUrl },
  );
  const pairing = await call("bob", "begin_receiver_setup", {
    credential_hash: prepared.credential_hash,
  });
  assert.equal(pairing.identity.user_id, users.get("bob"));
  assert.equal(pairing.identity.project_id, oauthIdentity.project_id);
  assert.equal(
    (
      await call("bob", "begin_receiver_setup", {
        credential_hash: prepared.credential_hash,
      })
    ).pairing_id,
    pairing.pairing_id,
  );
  await call(
    "eve",
    "begin_receiver_setup",
    { credential_hash: prepared.credential_hash },
    { isError: true },
  );
  // Bob and Eve have the same alias; only exact bound account IDs may approve.
  assert.equal(
    (
      await post(
        `/auth/receiver-pairings/${pairing.pairing_id}/approve`,
        "session:eve",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post(
        `/auth/receiver-pairings/${pairing.pairing_id}/approve`,
        "session:bob",
      )
    ).status,
    200,
  );
  const ready = await completeSetup(
    { connection_id: prepared.connection_id, pairing },
    { ...options, openUrl: async () => {} },
  );
  assert.equal(ready.status, "ready");
  const connection = getReceiverConnectionById(prepared.connection_id, {
    path: registryPath,
  });
  assert.equal(connection.identity.userId, users.get("bob"));
  const receiver = new ReceiverClient({
    serverUrl: baseUrl,
    credential: secrets.get(connection.credentialAccount),
    allowInsecureHttp: true,
  });
  const syncOptions = { ...options, inboxOptions };
  const synced = await syncReceiver({ projectRoot: root }, syncOptions);
  assert.equal(synced.activated, 1);
  assert.equal(
    (await call("alice", "get_message_status", { message_id: sent.message_id }))
      .status,
    "in_receiver_inbox",
  );
  assert.equal(
    (await syncReceiver({ projectRoot: root }, syncOptions)).claimed,
    0,
  );
  const delivery = reserveNextMessage(
    { projectRoot: root, ownerSessionId: "fixture-owner" },
    { ...inboxOptions, receiverIdentity: synced.identity },
  );
  assert.equal(delivery.jobId, sent.message_id);
  const nativeCalls = [];
  const routeOptions = {
    createQueueClient: () => ({
      async prepare() {},
      async submit() {},
      close() {},
    }),
    ownerThreadId: "fixture-owner",
    turnId: "fixture-turn",
    cloudAuthorizationOptions: options,
    createClient: () => ({
      async start() {},
      async close() {},
      async callTool(name, args) {
        nativeCalls.push({ name, args });
        const value =
          name === "list_projects"
            ? {
                projects: [
                  {
                    path: root,
                    projectId: "fixture-native-project",
                    isGitRepository: true,
                  },
                ],
              }
            : {
                clientThreadId: "client-new-thread:fixture-native-child",
                hostId: "local",
              };
        return {
          success: true,
          contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
        };
      },
    }),
    markIssued: (input) => markNativeMutationIssued(input, inboxOptions),
    acknowledge: (input) => acknowledgeMessage(input, inboxOptions),
    accept: (input) => acceptProvisioning(input, inboxOptions),
  };
  await routeDelivery(delivery, routeOptions);
  assert.deepEqual(
    nativeCalls.map(({ name }) => name),
    ["list_projects", "create_thread"],
  );
  assert.equal(nativeCalls[1].args.target.environment.type, "worktree");
  assert.match(nativeCalls[1].args.prompt, /from @alice/);
  assert.equal(getJob(sent.message_id, inboxOptions).status, "accepted");
  // No child hook runs. A later bounded check verifies the existing native task.
  const reconciled = await reconcileNativeBindings(
    {
      projectRoot: root,
      installationId: synced.identity.installationId,
      ownerThreadId: "fixture-owner",
    },
    {
      inboxOptions,
      resolveId: async () => "fixture-native-child",
      verifyWorktree: async () => true,
      createClient: () => ({
        async callTool(name) {
          assert.equal(name, "read_thread");
          return {
            success: true,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({
                  thread: {
                    id: "fixture-native-child",
                    kind: "codex",
                    hostId: "local",
                    cwd: root,
                  },
                  turns: [
                    {
                      items: [
                        {
                          type: "functionCallOutput",
                          namespace: "codex_app",
                          name: "create_thread",
                          output: {
                            text: `<codex_delegation><source_thread_id>fixture-owner</source_thread_id><input>${nativeCalls[1].args.prompt.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</input></codex_delegation>`,
                          },
                        },
                      ],
                    },
                  ],
                }),
              },
            ],
          };
        },
        async close() {},
      }),
    },
  );
  assert.equal(reconciled.reconciled, 1);
  assert.equal(getJob(sent.message_id, inboxOptions).status, "completed");
  const events = listPendingCloudEvents(
    { installationId: synced.identity.installationId },
    inboxOptions,
  );
  assert.equal(events.length, 2);
  assert.doesNotMatch(
    JSON.stringify(events),
    /fixture-native|fixture-owner|project_root|thread_id/,
  );
  await syncReceiver({ projectRoot: root, receiptsOnly: true }, syncOptions);
  assert.equal(
    (await call("alice", "get_message_status", { message_id: sent.message_id }))
      .status,
    "delivered",
  );
  // Replaying the durable receipt is harmless and doesn't create another task.
  assert.deepEqual(
    (await receiver.sendEvents(events)).accepted_event_ids,
    events.map((event) => event.event_id),
  );
  assert.equal(nativeCalls.length, 2);

  // Conversation sequence is global: the opposite-direction reply consumes 2.
  await call("bob", "send_message", {
    to_username: "alice",
    message: "Acknowledged.",
    request_id: randomUUID(),
    conversation_id: sent.conversation_id,
  });
  withInbox(
    (db) =>
      db.prepare("UPDATE conversation_responses SET status='replied'").run(),
    inboxOptions,
  );
  const later = await call("alice", "send_message", {
    ...request,
    request_id: randomUUID(),
    conversation_id: sent.conversation_id,
  });
  assert.equal(later.sequence, 3);
  await syncReceiver({ projectRoot: root }, syncOptions);
  const next = reserveNextMessage(
    { projectRoot: root, ownerSessionId: "fixture-owner" },
    { ...inboxOptions, receiverIdentity: synced.identity },
  );
  assert.equal(next.jobId, later.message_id);
  assert.equal(next.channel.threadId, "fixture-native-child");
  // Hold a real successful identity response while local+remote revocation wins.
  const identityRead = Promise.withResolvers();
  const resumeIdentity = Promise.withResolvers();
  const racingRoute = routeDelivery(next, {
    ...routeOptions,
    cloudAuthorizationOptions: {
      ...options,
      createReceiverClient: (clientOptions) =>
        new ReceiverClient({
          ...clientOptions,
          fetchImpl: async (url, init) => {
            const response = await fetch(url, init);
            identityRead.resolve();
            await resumeIdentity.promise;
            return response;
          },
        }),
    },
  });
  const blockedRace = assert.rejects(
    racingRoute,
    /authorization is no longer current/,
  );
  await identityRead.promise;
  await disconnectReceiver({}, options);
  resumeIdentity.resolve();
  await blockedRace;
  assert.equal(secrets.size, 0);
  assert.equal((await receiver.disconnect()).disconnected, true);
  await assert.rejects(receiver.claim(), (error) => error.status === 401);
  assert.equal(
    (await syncReceiver({ projectRoot: root }, syncOptions)).authorized,
    false,
  );
  const disconnected = await call("alice", "get_message_status", {
    message_id: later.message_id,
  });
  assert.equal(disconnected.status, "needs_attention");
  assert.equal(disconnected.failure_reason, "receiver_disconnected");
  // A previously authorized reservation must not outlive local revocation.
  await assert.rejects(
    routeDelivery(next, routeOptions),
    /authorization is no longer current/,
  );
  assert.deepEqual(
    nativeCalls.map(({ name }) => name),
    ["list_projects", "create_thread", "list_projects", "list_projects"],
  );

  // Finish plugin disable too: transport revocation alone intentionally retains
  // the selected local destination until the user disables or reconnects setup.
  await disableSetup({ connection_id: prepared.connection_id }, options);

  // Legacy unbound enrollment cannot bypass the authenticated setup tool.
  const mismatched = await startReceiverConnection(
    { serverUrl: baseUrl },
    options,
  );
  assert.equal(
    (
      await post(
        `/auth/receiver-pairings/${mismatched.pairingId}/approve`,
        "session:bob",
      )
    ).status,
    403,
  );
  await disconnectReceiver({}, options);
  assert.equal(secrets.size, 0);

  // Cancelling before approval must prevent a delayed browser approval as well.
  const cancelled = await startReceiverConnection(
    { serverUrl: baseUrl },
    options,
  );
  await disconnectReceiver({}, options);
  assert.notEqual(
    (
      await post(
        `/auth/receiver-pairings/${cancelled.pairingId}/approve`,
        "session:bob",
      )
    ).status,
    200,
  );

  const replacementPending = await prepareSetup(
    { identity: oauthIdentity },
    { ...options, serverUrl: baseUrl },
  );
  const replacementPairing = await call("bob", "begin_receiver_setup", {
    credential_hash: replacementPending.credential_hash,
  });
  assert.equal(
    (
      await post(
        `/auth/receiver-pairings/${replacementPairing.pairing_id}/approve`,
        "session:bob",
      )
    ).status,
    200,
  );
  const replacementReady = await completeSetup(
    {
      connection_id: replacementPending.connection_id,
      pairing: replacementPairing,
    },
    { ...options, openUrl: async () => {} },
  );
  assert.equal(replacementReady.status, "ready");
  const replacement = getReceiverConnectionById(
    replacementPending.connection_id,
    {
      path: registryPath,
    },
  );
  assert.notEqual(
    replacement.identity.installationId,
    connection.identity.installationId,
  );
  const afterReconnect = await call("alice", "send_message", {
    ...request,
    request_id: randomUUID(),
    conversation_id: sent.conversation_id,
  });
  assert.equal(afterReconnect.sequence, 4);
  const replacementSync = await syncReceiver(
    { projectRoot: root },
    syncOptions,
  );
  assert.equal(replacementSync.activated, 1);
  const replacementDelivery = reserveNextMessage(
    { projectRoot: root, ownerSessionId: "fixture-owner" },
    { ...inboxOptions, receiverIdentity: replacementSync.identity },
  );
  assert.equal(replacementDelivery, null);
  assert.equal(
    getJob(afterReconnect.message_id, inboxOptions).bindingState,
    "missing",
  );
  // Old assigned work is never silently transferred to the new installation.
  assert.equal(getJob(later.message_id, inboxOptions).status, "routing");
  // Expired credentials cannot claim, but must still be able to revoke.
  await seed.query(
    "update public.receiver_installations set expires_at=now()-interval '1 second' where id=$1",
    [replacement.identity.installationId],
  );
  const expired = new ReceiverClient({
    serverUrl: baseUrl,
    credential: secrets.get(replacement.credentialAccount),
    allowInsecureHttp: true,
  });
  await assert.rejects(
    () => expired.claim(),
    (error) => error.status === 401,
  );
  await disconnectReceiver({}, options);
  assert.equal(secrets.size, 0);
});
