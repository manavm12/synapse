import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import pg from "pg";
import { handleConversationHook } from "../../plugins/synapse/lib/conversation-hooks.mjs";
import { recordSession } from "../../plugins/synapse/lib/conversation-store.mjs";
import { recordPromptHook } from "../../plugins/synapse/lib/hook-health.mjs";
import { withInbox } from "../../plugins/synapse/lib/inbox.mjs";
import { routeDelivery } from "../../plugins/synapse/lib/native-router.mjs";
import {
  completeSetup,
  prepareSetup,
} from "../../plugins/synapse/lib/plugin-setup.mjs";
import { ReceiverClient } from "../../plugins/synapse/lib/receiver-client.mjs";
import { getReceiverConnection } from "../../plugins/synapse/lib/receiver-registry.mjs";
import { syncReceiver } from "../../plugins/synapse/lib/receiver-sync.mjs";
import { ReceiverWorker } from "../../plugins/synapse/lib/receiver-worker.mjs";
import { runMigrations } from "../../scripts/migrate.mjs";
import { createApplication } from "../../src/server/app.mjs";
import { createDatabase } from "../../src/server/database.mjs";
import { createMemoryLedgerAdapter } from "../../src/server/memory-organizer/storage.mjs";
import {
  createMemoryRetrievalService,
  createMemorySourceReader,
} from "../../src/server/memory-retrieval/index.mjs";
import { createMessageMemoryAgent } from "../../src/server/message-memory/agent.mjs";
import { runMessageMemoryWorker } from "../../src/server/message-memory/worker.mjs";

const adminUrl = process.env.TEST_DATABASE_URL;
const ssl = process.env.DATABASE_SSL === "disable" ? false : undefined;

test("automatic conversation keeps Alice’s original task and Bob’s single child", {
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
  let memoryPool, memoryRun;
  const memoryStop = new AbortController();
  let inferenceCalls = 0;
  const directory = await mkdtemp(join(tmpdir(), "synapse-message-flow-"));
  t.after(async () => {
    memoryStop.abort();
    await memoryRun;
    await memoryPool?.end();
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
    messageMemoryEnabled: true,
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
    await call(user, "save_session_memory", {
      capture_id: randomUUID(),
      session_id: `release-${user}`,
      project_alias: "demo",
      capture_reason: "turn_checkpoint",
      title: "Release context",
      summary: "Synthetic recipient-specific release fact",
      markdown: `# Summary\nRelease context.\n# What changed\nRecorded a release.\n# Decisions\nRelease owner phrase: ${user}-private-context.\n# Still unresolved\nNone.\n# Important references\nNone.`,
    });
  }
  const workerUrl = new URL(url);
  workerUrl.searchParams.set("options", "-c role=synapse_memory_worker");
  memoryPool = new pg.Pool({ connectionString: workerUrl.href, ssl });
  const retrieval = createMemoryRetrievalService({
    adapter: createMemoryLedgerAdapter({ pool: memoryPool }),
    sourceReader: createMemorySourceReader({ pool: memoryPool }),
  });
  const api = {
    model: "scripted-retrieval",
    async structured(_stage, prompt) {
      inferenceCalls++;
      const data = JSON.parse(prompt);
      return {
        model: "scripted-retrieval",
        usage: { input_tokens: 1, output_tokens: 1 },
        value: data.transcript.length
          ? {
              actions: [],
              selected: data.transcript[0].result.results.map(
                (s) => s.evidence_id,
              ),
              done: true,
              gaps: [],
            }
          : {
              actions: [{ op: "sources", query: "Release" }],
              selected: [],
              done: false,
              gaps: [],
            },
      };
    },
  };
  memoryRun = runMessageMemoryWorker({
    pool: memoryPool,
    prepare: createMessageMemoryAgent({ retrieval, api }),
    signal: memoryStop.signal,
    pollMs: 5,
    logger: { info() {}, error() {} },
  });
  const peers = {};
  const nativeCalls = [];
  for (const user of ["alice", "bob"]) {
    const root = join(directory, user);
    const registryPath = join(directory, `${user}-registry.sqlite`);
    const inboxOptions = { path: join(directory, `${user}-inbox.sqlite`) };
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
        CODEX_THREAD_ID: `${user}-original`,
      },
      openBrowser: false,
    };
    const oauthIdentity = await call(user, "get_identity", {});
    recordPromptHook(
      { hook_event_name: "UserPromptSubmit", session_id: `${user}-original` },
      { path: registryPath },
    );
    const prepared = await prepareSetup(
      { identity: oauthIdentity },
      { ...options, serverUrl: baseUrl },
    );
    const pairing = await call(user, "begin_receiver_setup", {
      credential_hash: prepared.credential_hash,
    });
    assert.equal(
      (
        await post(
          `/auth/receiver-pairings/${pairing.pairing_id}/approve`,
          `session:${user}`,
        )
      ).status,
      200,
    );
    const ready = await completeSetup(
      { connection_id: prepared.connection_id, pairing },
      { ...options, openUrl: async () => {} },
    );
    assert.equal(ready.status, "ready");
    const connection = getReceiverConnection(root, { path: registryPath });
    const native = [];
    const registration = (sessionId) => ({
      sessionId,
      projectRoot: root,
      cwd: root,
      pipePath: "/fixture/socket",
      nodePath: "/fixture/signed-node",
      codexPath: "/fixture/codex",
    });
    withInbox(
      (db) => recordSession(db, registration(`${user}-original`)),
      inboxOptions,
    );
    const hook = (event, sessionId, values = {}) =>
      handleConversationHook(
        {
          hook_event_name: event,
          session_id: sessionId,
          cwd: root,
          turn_id: `${sessionId}-turn`,
          ...values,
        },
        {
          inboxOptions,
          registryPath,
          register: (input) => registration(input.session_id),
          bind: async () => {},
        },
      );
    const queue = () => ({
      async prepare(threadId) {
        return { id: threadId, status: { type: "active" } };
      },
      async submit(args) {
        nativeCalls.push({ user, name: "queue", ...args });
        native.push(args);
        return { id: randomUUID() };
      },
      close() {},
    });
    const worker = new ReceiverWorker({
      inboxOptions,
      registryPath,
      available: () => true,
      sync: (input) => syncReceiver(input, { ...options, inboxOptions }),
      queueClient: queue,
      route: (delivery, context) =>
        routeDelivery(delivery, {
          ...context,
          cloudAuthorizationOptions: options,
          createQueueClient: queue,
          createClient: () => ({
            async start() {},
            async close() {},
            async callTool(name, args) {
              const value =
                name === "list_projects"
                  ? {
                      projects: [
                        {
                          path: root,
                          projectId: `${user}-project`,
                          isGitRepository: true,
                        },
                      ],
                    }
                  : { threadId: `${user}-child`, hostId: "local" };
              if (name === "create_thread") {
                nativeCalls.push({ user, name, ...args });
                native.push({ threadId: `${user}-child`, prompt: args.prompt });
              }
              return {
                success: true,
                contentItems: [
                  { type: "inputText", text: JSON.stringify(value) },
                ],
              };
            },
          }),
        }),
    });
    peers[user] = {
      root,
      inboxOptions,
      hook,
      worker,
      native,
      connection,
      receiver: new ReceiverClient({
        serverUrl: baseUrl,
        credential: secrets.get(connection.credentialAccount),
        allowInsecureHttp: true,
      }),
    };
  }
  async function send(user, session, tool, args, loseResponse = false) {
    const peer = peers[user];
    const tool_name = `mcp__synapse_memory__${tool}`;
    const pre = await peer.hook("PreToolUse", session, {
      tool_name,
      tool_input: args,
    });
    assert.equal(pre, null);
    const sent = await call(user, tool, args);
    if (!loseResponse)
      await peer.hook("PostToolUse", session, {
        tool_name,
        tool_input: args,
        tool_response: { structuredContent: sent },
      });
    return sent;
  }
  async function deliver(user, expectedTask) {
    const peer = peers[user];
    assert.equal((await peer.worker.tick()).routed, 1);
    assert.equal(peer.native.length, 1);
    const queued = peer.native.shift();
    assert.equal(queued.threadId, expectedTask);
    assert.match(queued.prompt, new RegExp(`${user}-private-context`));
    for (const other of users.keys())
      if (other !== user)
        assert.ok(!queued.prompt.includes(`${other}-private-context`));
    assert.ok(
      withInbox(
        (db) =>
          db
            .prepare(
              "SELECT 1 FROM jobs WHERE native_prompt=? AND native_mutation_state='issued'",
            )
            .get(queued.prompt),
        peer.inboxOptions,
      ),
    );
    const context = await peer.hook("UserPromptSubmit", expectedTask, {
      prompt: queued.prompt,
    });
    assert.match(
      context.hookSpecificOutput.additionalContext,
      /Reply to the remote requester/,
    );
    return queued;
  }
  const initial = {
    to_username: "bob",
    message: "Review the release notes.",
    request_id: randomUUID(),
  };
  // The cloud response is lost. An immediate reply must recover the original
  // task from the authenticated origin correlation, before PostToolUse runs.
  const request = await send(
    "alice",
    "alice-original",
    "send_message",
    initial,
    true,
  );
  await deliver("bob", "bob-child");
  const preparedContext = await peers.bob.receiver.prepareContext(
    request.message_id,
  );
  const callsBeforeReplay = inferenceCalls;
  assert.deepEqual(
    await peers.bob.receiver.prepareContext(request.message_id),
    preparedContext,
  );
  assert.equal(inferenceCalls, callsBeforeReplay);
  await assert.rejects(
    () => peers.alice.receiver.prepareContext(request.message_id),
    (error) => error.status === 403,
  );
  await peers.bob.worker.tick();
  await peers.bob.receiver.sendEvents([
    {
      event_id: randomUUID(),
      message_id: request.message_id,
      kind: "needs_attention",
      occurred_at: new Date().toISOString(),
      error_code: "reply_missing",
    },
  ]);
  const failure = await call("alice", "get_message_status", {
    message_id: request.message_id,
  });
  assert.equal(failure.status, "delivered");
  assert.equal(failure.response_state, "needs_attention");
  const question = await send("bob", "bob-child", "reply_to_message", {
    message_id: request.message_id,
    message: "Which version?",
    disposition: "continue",
    request_id: randomUUID(),
  });
  assert.equal(await peers.bob.hook("Stop", "bob-child"), null);
  const repairedStatus = await call("alice", "get_message_status", {
    message_id: request.message_id,
  });
  assert.equal(repairedStatus.response_state, "replied");
  assert.equal(repairedStatus.failure_reason, null);
  // Alice is busy: the worker still accepts a native queued submission. The
  // simulated desktop consumes it only after the running turn has ended.
  await deliver("alice", "alice-original");
  const answer = await send("alice", "alice-original", "reply_to_message", {
    message_id: question.message_id,
    message: "Version 4.",
    disposition: "continue",
    request_id: randomUUID(),
  });
  assert.equal(await peers.alice.hook("Stop", "alice-original"), null);
  await deliver("bob", "bob-child");
  const resultArgs = {
    message_id: answer.message_id,
    message: "Version 4 is ready to ship.",
    disposition: "complete",
    request_id: randomUUID(),
  };
  const result = await send("bob", "bob-child", "reply_to_message", resultArgs);
  assert.equal(
    (await call("bob", "reply_to_message", resultArgs)).message_id,
    result.message_id,
  );
  await call(
    "bob",
    "reply_to_message",
    { ...resultArgs, disposition: "continue" },
    { isError: true },
  );
  await deliver("alice", "alice-original");
  assert.equal(await peers.alice.hook("Stop", "alice-original"), null);
  assert.equal((await peers.alice.worker.tick()).routed, 0);
  assert.equal((await peers.bob.worker.tick()).routed, 0);
  assert.equal(nativeCalls.filter((c) => c.name === "create_thread").length, 1);
  assert.ok(
    nativeCalls
      .filter((c) => c.user === "alice")
      .every((c) => c.threadId === "alice-original"),
  );
  const history = await call("alice", "get_conversation", {
    conversation_id: request.conversation_id,
    limit: 2,
  });
  assert.deepEqual(
    history.messages.map((m) => m.sequence),
    [1, 2],
  );
  assert.equal(history.next_sequence, 2);
  assert.equal(history.messages[0].response_state, "replied");
  assert.deepEqual(history.participants.map((p) => p.username).sort(), [
    "alice",
    "bob",
  ]);
  const rest = await call("bob", "get_conversation", {
    conversation_id: request.conversation_id,
    after_sequence: 2,
  });
  assert.deepEqual(
    rest.messages.map((m) => m.sequence),
    [3, 4],
  );
  assert.equal(rest.messages[1].response_state, "complete");
  assert.equal(rest.next_sequence, null);
  const list = await call("alice", "list_conversations", {});
  assert.equal(list.conversations[0].activity_state, "complete");
  assert.equal(list.conversations[0].outstanding_replies, 0);
  assert.equal(
    (await call("eve", "list_conversations", {})).conversations.length,
    0,
  );
  await call(
    "eve",
    "get_conversation",
    { conversation_id: request.conversation_id },
    { isError: true },
  );
  await call(
    "eve",
    "reply_to_message",
    { ...resultArgs, request_id: randomUUID() },
    { isError: true },
  );
  await call(
    "alice",
    "reply_to_message",
    { ...resultArgs, request_id: randomUUID() },
    { isError: true },
  );
  // Further substantive follow-up stays in the same two tasks.
  const followup = await send("alice", "alice-original", "send_message", {
    ...initial,
    conversation_id: request.conversation_id,
    request_id: randomUUID(),
    message: "Please check the appendix too.",
  });
  await deliver("bob", "bob-child");
  await send("bob", "bob-child", "reply_to_message", {
    message_id: followup.message_id,
    message: "The appendix needs your approval.",
    disposition: "needs_user",
    request_id: randomUUID(),
  });
  await deliver("alice", "alice-original");
  assert.equal(await peers.alice.hook("Stop", "alice-original"), null);
  assert.equal(nativeCalls.filter((c) => c.name === "create_thread").length, 1);
  // Independent conversations can share Alice's originating native task.
  const second = await send("alice", "alice-original", "send_message", {
    ...initial,
    request_id: randomUUID(),
    message: "A separate request.",
  });
  assert.notEqual(second.conversation_id, request.conversation_id);
  const bindings = withInbox(
    (db) =>
      db
        .prepare("SELECT thread_id FROM channels WHERE binding_role='origin'")
        .all(),
    peers.alice.inboxOptions,
  );
  assert.deepEqual(
    bindings.map((row) => row.thread_id),
    ["alice-original", "alice-original"],
  );
  const page = await call("alice", "list_conversations", { limit: 1 });
  assert.ok(page.next_cursor);
  assert.equal(
    (await call("alice", "list_conversations", { cursor: page.next_cursor }))
      .conversations.length,
    1,
  );
  // Expired attempts stay unavailable, stale leases cannot publish, and no
  // receiver receives generic queue or memory-table privileges.
  memoryStop.abort();
  await memoryRun;
  assert.equal(
    (
      await seed.query(
        "select has_function_privilege('synapse_runtime','synapse_private.claim_message_memory()','execute') as allowed",
      )
    ).rows[0].allowed,
    false,
  );
  assert.equal(
    (
      await seed.query(
        "select has_table_privilege('synapse_runtime','synapse_private.message_memory_contexts','select') as allowed",
      )
    ).rows[0].allowed,
    false,
  );
  await assert.rejects(
    () => peers.bob.receiver.prepareContext(second.message_id),
    (e) => e.status === 403,
  );
  const claim = await peers.bob.receiver.claim(10, 2);
  const next = claim.messages.find((m) => m.message_id === second.message_id);
  await peers.bob.receiver.confirmImport(next.message_id, next.claim_token);
  assert.equal(
    (await peers.bob.receiver.prepareContext(next.message_id)).status,
    "pending",
  );
  const job = (
    await memoryPool.query(
      "select synapse_private.claim_message_memory() as job",
    )
  ).rows[0].job;
  assert.equal(job.message_id, next.message_id);
  assert.equal(
    (
      await memoryPool.query(
        "select synapse_private.claim_message_memory() as job",
      )
    ).rows[0].job,
    null,
  );
  assert.equal(
    (
      await memoryPool.query(
        "select synapse_private.finish_message_memory($1,$2,$3) as saved",
        [job.message_id, randomUUID(), { status: "no_match" }],
      )
    ).rows[0].saved,
    false,
  );
  await seed.query(
    "update synapse_private.message_memory_contexts set deadline_at=now()-interval '1 second' where message_id=$1",
    [job.message_id],
  );
  assert.equal(
    (
      await memoryPool.query(
        "select synapse_private.finish_message_memory($1,$2,$3) as saved",
        [job.message_id, job.lease_token, { status: "no_match" }],
      )
    ).rows[0].saved,
    false,
  );
  assert.equal(
    (await peers.bob.receiver.prepareContext(job.message_id)).status,
    "unavailable",
  );
  const bobIdentity = peers.bob.connection.identity;
  await seed.query(
    "insert into synapse_private.memory_ledger_projects(owner_id,project_id,generation,core_version,projection_version) values($1,$2,1,'test','test')",
    [bobIdentity.userId, bobIdentity.projectId],
  );
  assert.deepEqual(
    (await peers.bob.receiver.prepareContext(request.message_id)).gaps,
    ["generation_changed"],
  );
  await peers.bob.receiver.disconnect();
  await assert.rejects(
    () => peers.bob.receiver.prepareContext(request.message_id),
    (e) => e.status === 401,
  );
});
