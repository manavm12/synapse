import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  acknowledgeMessage,
  confirmCloudImport,
  getJob,
  listPendingCloudEvents,
  listPendingCloudImports,
  markNativeMutationIssued,
  markNativeMutationUncertain,
  recoverMessage,
  reserveNextMessage,
  stageCloudMessage,
} from "../../plugins/synapse/lib/inbox.mjs";
import {
  routeDelivery,
  runReservedDelivery,
} from "../../plugins/synapse/lib/native-router.mjs";
import { ReceiverClient } from "../../plugins/synapse/lib/receiver-client.mjs";
import {
  cloudChannelId,
  messageContentHash,
} from "../../plugins/synapse/lib/receiver-contract.mjs";
import {
  beginReceiverConnection,
  completeReceiverConnection,
  recordReceiverPairing,
} from "../../plugins/synapse/lib/receiver-registry.mjs";
import {
  MacOsKeychainStore,
  RECEIVER_KEYCHAIN_SERVICE,
} from "../../plugins/synapse/lib/receiver-secrets.mjs";
import { syncReceiver } from "../../plugins/synapse/lib/receiver-sync.mjs";
import {
  disconnectReceiver,
  finishReceiverConnection,
  startReceiverConnection,
} from "../../src/client/receiver/enrollment.mjs";

const identity = {
  installationId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  username: "bob",
  projectId: "33333333-3333-4333-8333-333333333333",
  projectAlias: "demo",
  expiresAt: "2027-01-01T00:00:00.000Z",
  enabled: true,
};

function wireIdentity(overrides = {}) {
  return {
    installation_id: identity.installationId,
    user_id: identity.userId,
    username: identity.username,
    project_id: identity.projectId,
    project_alias: identity.projectAlias,
    expires_at: identity.expiresAt,
    enabled: true,
    ...overrides,
  };
}

function cloudMessage({
  id = "66666666-6666-4666-8666-666666666666",
  conversationId = "55555555-5555-4555-8555-555555555555",
  sequence = 2,
  task = "Review the change",
  claimToken = "claim-token-1",
} = {}) {
  return {
    messageId: id,
    conversationId,
    sequence,
    senderUserId: "44444444-4444-4444-8444-444444444444",
    senderUsername: "alice",
    recipientUserId: identity.userId,
    recipientProjectId: identity.projectId,
    message: task,
    contentHash: messageContentHash(task),
    claimToken,
    leaseExpiresAt: "2026-09-07T01:00:00.000Z",
  };
}

function wireMessage(options = {}) {
  const message = cloudMessage(options);
  return {
    version: 1,
    message_id: message.messageId,
    conversation_id: message.conversationId,
    sequence: message.sequence,
    sender: {
      user_id: message.senderUserId,
      username: message.senderUsername,
    },
    recipient: {
      user_id: message.recipientUserId,
      project_id: message.recipientProjectId,
    },
    message: message.message,
    content_hash: message.contentHash,
    claim_token: message.claimToken,
    lease_expires_at: message.leaseExpiresAt,
  };
}

async function paths() {
  const directory = await mkdtemp(join(tmpdir(), "synapse-receiver-test-"));
  return {
    inbox: join(directory, "inbox.sqlite"),
    registry: join(directory, "host.sqlite"),
    root: join(directory, "project"),
  };
}

function stage(path, message, now = 1) {
  return stageCloudMessage(
    {
      message,
      identity,
      projectRoot: "/project",
      channelId: cloudChannelId(identity.userId, message.conversationId),
    },
    { path, now: () => now },
  );
}

test("cloud import is staged atomically, deduplicated, and ordered by server sequence", async () => {
  const { inbox } = await paths();
  const later = cloudMessage({
    id: "77777777-7777-4777-8777-777777777777",
    sequence: 4,
    claimToken: "later-claim",
  });
  const earlier = cloudMessage({ sequence: 2 });
  stage(inbox, later, 1);
  stage(inbox, earlier, 2);
  assert.equal(
    reserveNextMessage(
      { projectRoot: "/project", ownerSessionId: "owner-1" },
      { path: inbox, allowCloud: true },
    ),
    null,
  );
  assert.equal(
    listPendingCloudImports(
      { installationId: identity.installationId },
      { path: inbox },
    ).length,
    2,
  );
  confirmCloudImport(
    { messageId: later.messageId, installationId: identity.installationId },
    { path: inbox, now: () => 3 },
  );
  confirmCloudImport(
    { messageId: earlier.messageId, installationId: identity.installationId },
    { path: inbox, now: () => 4 },
  );
  const first = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path: inbox, allowCloud: true, createDeliveryId: () => "delivery-1" },
  );
  assert.equal(first.jobId, earlier.messageId);
  assert.match(first.nativePrompt, /from @alice/);
  assert.equal(first.cloud.sequence, 2);
  acknowledgeMessage(
    {
      jobId: first.jobId,
      deliveryId: first.deliveryId,
      threadId: "thread-1",
      hostId: "local",
      projectId: "codex-project",
    },
    { path: inbox, now: () => 5 },
  );
  const second = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path: inbox, allowCloud: true, createDeliveryId: () => "delivery-2" },
  );
  assert.equal(second.jobId, later.messageId);
  assert.equal(second.channel.threadId, "thread-1");
  assert.equal(
    stage(inbox, { ...earlier, claimToken: "new-claim" }, 6).duplicate,
    true,
  );
  assert.throws(
    () => stage(inbox, { ...earlier, message: "changed" }, 7),
    /Conflicting cloud payload/,
  );
});

test("sync reconciles an ambiguous import response without replaying the local job", async () => {
  const { inbox, registry, root } = await paths();
  const database = new DatabaseSync(registry);
  database.exec(
    "CREATE TABLE projects (alias TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE)",
  );
  database.prepare("INSERT INTO projects VALUES (?, ?)").run("demo", root);
  database.close();
  beginReceiverConnection(
    {
      connectionId: "connection-1",
      projectRoot: root,
      projectAlias: "demo",
      serverUrl: "https://synapse.example",
      credentialAccount: "receiver:connection-1",
      credentialHash: "a".repeat(64),
    },
    { path: registry },
  );
  recordReceiverPairing(
    {
      connectionId: "connection-1",
      pairingId: "pairing-1",
      verificationUrl: "https://synapse.example/pair",
      expiresAt: "2026-09-07T01:00:00.000Z",
    },
    { path: registry },
  );
  completeReceiverConnection(
    { connectionId: "connection-1", identity },
    { path: registry },
  );
  let importAttempts = 0;
  const result = await syncReceiver(
    { projectRoot: root },
    {
      registryPath: registry,
      inboxOptions: { path: inbox },
      secretStore: { get: async () => "syn_recv_secret" },
      createClient: ({ credential }) => {
        assert.equal(credential, "syn_recv_secret");
        return {
          sendEvents: async () => ({ accepted_event_ids: [] }),
          claim: async () => ({
            identity: wireIdentity(),
            messages: [wireMessage()],
          }),
          confirmImport: async () => {
            importAttempts += 1;
            throw new Error("response lost");
          },
          getMessage: async (messageId) => ({
            message_id: messageId,
            status: "in_receiver_inbox",
            imported: true,
          }),
        };
      },
    },
  );
  assert.equal(result.authorized, true);
  assert.equal(result.activated, 1);
  assert.equal(importAttempts, 1);
  assert.equal(
    getJob(cloudMessage().messageId, { path: inbox }).status,
    "pending",
  );
  assert.equal(
    listPendingCloudImports(
      { installationId: identity.installationId },
      { path: inbox },
    ).length,
    0,
  );
});

test("revoked or unavailable sync cannot authorize dispatch and failed receipts remain durable", async () => {
  const { inbox, registry, root } = await paths();
  const database = new DatabaseSync(registry);
  database.exec(
    "CREATE TABLE projects (alias TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE)",
  );
  database.prepare("INSERT INTO projects VALUES (?, ?)").run("demo", root);
  database.close();
  beginReceiverConnection(
    {
      connectionId: "connection-1",
      projectRoot: root,
      projectAlias: "demo",
      serverUrl: "https://synapse.example",
      credentialAccount: "receiver:connection-1",
      credentialHash: "a".repeat(64),
    },
    { path: registry },
  );
  recordReceiverPairing(
    {
      connectionId: "connection-1",
      pairingId: "pairing-1",
      verificationUrl: "https://synapse.example/pair",
      expiresAt: identity.expiresAt,
    },
    { path: registry },
  );
  completeReceiverConnection(
    { connectionId: "connection-1", identity },
    { path: registry },
  );

  const delivered = cloudMessage();
  const waiting = cloudMessage({
    id: "77777777-7777-4777-8777-777777777777",
    conversationId: "88888888-8888-4888-8888-888888888888",
  });
  for (const message of [delivered, waiting]) {
    stageCloudMessage(
      {
        message,
        identity,
        projectRoot: root,
        channelId: cloudChannelId(identity.userId, message.conversationId),
      },
      { path: inbox },
    );
    confirmCloudImport(
      { messageId: message.messageId, installationId: identity.installationId },
      { path: inbox },
    );
  }
  const delivery = reserveNextMessage(
    { projectRoot: root, ownerSessionId: "owner-1" },
    { path: inbox, allowCloud: true, createDeliveryId: () => "delivery-1" },
  );
  acknowledgeMessage(
    {
      jobId: delivery.jobId,
      deliveryId: delivery.deliveryId,
      threadId: "thread-1",
      hostId: "local",
      projectId: "codex-project",
    },
    { path: inbox },
  );
  const common = {
    registryPath: registry,
    inboxOptions: { path: inbox },
    secretStore: { get: async () => `syn_recv_${"A".repeat(43)}` },
  };
  await assert.rejects(
    syncReceiver(
      { projectRoot: root },
      {
        ...common,
        createClient: () => ({
          sendEvents: async () => {
            throw new Error("offline");
          },
          claim: async () => {
            throw new Error("receiver revoked");
          },
        }),
      },
    ),
    /receiver revoked/,
  );
  assert.equal(
    reserveNextMessage(
      { projectRoot: root, ownerSessionId: "owner-2" },
      { path: inbox, allowCloud: false },
    ),
    null,
  );
  const retained = listPendingCloudEvents(
    { installationId: identity.installationId },
    { path: inbox },
  );
  assert.equal(retained.length, 1);
  await syncReceiver(
    { projectRoot: root },
    {
      ...common,
      createClient: () => ({
        sendEvents: async () => ({
          accepted_event_ids: [retained[0].event_id],
        }),
        claim: async () => ({ identity: wireIdentity(), messages: [] }),
      }),
    },
  );
  assert.equal(
    listPendingCloudEvents(
      { installationId: identity.installationId },
      { path: inbox },
    ).length,
    0,
  );
});

test("receiver sync rejects server and message identity mismatches before activation", async () => {
  const { inbox, registry, root } = await paths();
  const database = new DatabaseSync(registry);
  database.exec(
    "CREATE TABLE projects (alias TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE)",
  );
  database.prepare("INSERT INTO projects VALUES (?, ?)").run("demo", root);
  database.close();
  beginReceiverConnection(
    {
      connectionId: "connection-1",
      projectRoot: root,
      projectAlias: "demo",
      serverUrl: "https://synapse.example",
      credentialAccount: "receiver:connection-1",
      credentialHash: "a".repeat(64),
    },
    { path: registry },
  );
  recordReceiverPairing(
    {
      connectionId: "connection-1",
      pairingId: "pairing-1",
      verificationUrl: "https://synapse.example/pair",
      expiresAt: identity.expiresAt,
    },
    { path: registry },
  );
  completeReceiverConnection(
    { connectionId: "connection-1", identity },
    { path: registry },
  );
  const base = {
    registryPath: registry,
    inboxOptions: { path: inbox },
    secretStore: { get: async () => "secret" },
  };
  await assert.rejects(
    syncReceiver(
      { projectRoot: root },
      {
        ...base,
        createClient: () => ({
          sendEvents: async () => ({ accepted_event_ids: [] }),
          claim: async () => ({
            identity: wireIdentity({
              user_id: "99999999-9999-4999-8999-999999999999",
            }),
            messages: [],
          }),
        }),
      },
    ),
    /identity does not match/,
  );
  await assert.rejects(
    syncReceiver(
      { projectRoot: root },
      {
        ...base,
        createClient: () => ({
          sendEvents: async () => ({ accepted_event_ids: [] }),
          claim: async () => ({
            identity: wireIdentity(),
            messages: [
              wireMessage(),
              {
                ...wireMessage({
                  id: "77777777-7777-4777-8777-777777777777",
                  task: "tampered",
                }),
                recipient: {
                  user_id: identity.userId,
                  project_id: "99999999-9999-4999-8999-999999999999",
                },
              },
            ],
          }),
        }),
      },
    ),
    /recipient does not match/,
  );
  assert.equal(getJob(cloudMessage().messageId, { path: inbox }), null);
});

test("delivery receipts remain in an outbox until the server accepts their stable IDs", async () => {
  const { inbox } = await paths();
  const message = cloudMessage();
  stage(inbox, message);
  confirmCloudImport(
    { messageId: message.messageId, installationId: identity.installationId },
    { path: inbox },
  );
  const delivery = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path: inbox, allowCloud: true, createDeliveryId: () => "delivery-1" },
  );
  acknowledgeMessage(
    {
      jobId: delivery.jobId,
      deliveryId: delivery.deliveryId,
      threadId: "thread-1",
      hostId: "local",
      projectId: "codex-project",
    },
    { path: inbox, now: () => 5 },
  );
  const events = listPendingCloudEvents(
    { installationId: identity.installationId },
    { path: inbox },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "delivered");
  assert.equal(Object.hasOwn(events[0], "thread_id"), false);
});

test("an issued native mutation with an uncertain response is fenced from replay", async () => {
  const { inbox } = await paths();
  const message = cloudMessage();
  stage(inbox, message);
  confirmCloudImport(
    { messageId: message.messageId, installationId: identity.installationId },
    { path: inbox },
  );
  const delivery = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path: inbox, allowCloud: true, createDeliveryId: () => "delivery-1" },
  );
  markNativeMutationIssued(
    { jobId: delivery.jobId, deliveryId: delivery.deliveryId },
    { path: inbox },
  );
  markNativeMutationUncertain(
    {
      jobId: delivery.jobId,
      deliveryId: delivery.deliveryId,
      error: "desktop response timed out",
    },
    { path: inbox, createEventId: () => "event-1" },
  );
  assert.equal(getJob(message.messageId, { path: inbox }).status, "uncertain");
  assert.equal(
    reserveNextMessage(
      { projectRoot: "/project", ownerSessionId: "owner-1" },
      { path: inbox, allowCloud: true },
    ),
    null,
  );
  assert.throws(
    () =>
      recoverMessage(
        { jobId: message.messageId, ownerStopped: true },
        { path: inbox },
      ),
    /requires receiver reconciliation/,
  );
  assert.deepEqual(
    listPendingCloudEvents(
      { installationId: identity.installationId },
      { path: inbox },
    ).map((event) => [event.event_id, event.kind, event.error_code]),
    [["event-1", "needs_attention", "native_response_uncertain"]],
  );
});

test("the native router classifies a cloud mutation timeout as uncertain, not retryable", async () => {
  const { inbox } = await paths();
  const message = cloudMessage();
  stage(inbox, message);
  confirmCloudImport(
    { messageId: message.messageId, installationId: identity.installationId },
    { path: inbox },
  );
  const delivery = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path: inbox, allowCloud: true, createDeliveryId: () => "delivery-1" },
  );
  const client = {
    start: async () => {},
    close: async () => {},
    callTool: async (name) => {
      if (name === "list_projects") {
        return {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                projects: [
                  {
                    projectId: "codex-project",
                    path: "/project",
                    isGitRepository: true,
                  },
                ],
              }),
            },
          ],
        };
      }
      throw new Error("desktop response timed out");
    },
  };
  let retries = 0;
  await assert.rejects(
    runReservedDelivery(
      {
        jobId: delivery.jobId,
        deliveryId: delivery.deliveryId,
        ownerThreadId: "owner-1",
      },
      {
        load: () => delivery,
        route: (value, metadata) =>
          routeDelivery(value, {
            ...metadata,
            createClient: () => client,
            markIssued: (input) =>
              markNativeMutationIssued(input, { path: inbox }),
          }),
        retry: () => {
          retries += 1;
        },
        uncertain: (input) =>
          markNativeMutationUncertain(input, {
            path: inbox,
            createEventId: () => "event-timeout",
          }),
      },
    ),
    /desktop response timed out/,
  );
  assert.equal(retries, 0);
  assert.equal(getJob(message.messageId, { path: inbox }).status, "uncertain");
});

test("receiver HTTP auth stays in headers and localhost HTTP is opt-in", async () => {
  const requests = [];
  const client = new ReceiverClient({
    serverUrl: "https://synapse.example",
    credential: "syn_recv_secret",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(JSON.stringify({ identity: wireIdentity() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await client.getIdentity();
  await client.createPairing("a".repeat(64));
  await client.completePairing("pairing-1");
  await client.claim(10);
  await client.confirmImport(cloudMessage().messageId, "claim-token");
  await client.getMessage(cloudMessage().messageId);
  await client.sendEvents([]);
  await client.disconnect();
  assert.equal(
    requests[0].options.headers.authorization,
    "Bearer syn_recv_secret",
  );
  assert.equal(
    requests.every((request) => !request.url.includes("syn_recv_secret")),
    true,
  );
  assert.equal(
    Object.hasOwn(requests[1].options.headers, "authorization"),
    false,
  );
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    credential_hash: "a".repeat(64),
  });
  assert.equal(
    requests[2].url.endsWith("/receiver/pairings/pairing-1/complete"),
    true,
  );
  assert.deepEqual(JSON.parse(requests[3].options.body), { limit: 10 });
  assert.deepEqual(JSON.parse(requests[4].options.body), {
    message_id: cloudMessage().messageId,
    claim_token: "claim-token",
  });
  assert.deepEqual(JSON.parse(requests[6].options.body), { events: [] });
  assert.equal(requests[7].url.endsWith("/receiver/disconnect"), true);
  assert.throws(
    () =>
      new ReceiverClient({
        serverUrl: "http://localhost:3000",
        credential: "x",
      }),
    /explicit development configuration/,
  );
  assert.doesNotThrow(
    () =>
      new ReceiverClient({
        serverUrl: "http://localhost:3000",
        credential: "x",
        allowInsecureHttp: true,
      }),
  );
});

test("macOS Keychain writes the credential through stdin, never argv", async () => {
  const invocations = [];
  let written = "";
  const secret = `syn_recv_${"A".repeat(43)}`;
  const store = new MacOsKeychainStore({
    platform: "darwin",
    spawnImpl: (command, arguments_) => {
      invocations.push({ command, arguments_ });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      if (arguments_[0] !== "-i") {
        child.stdin = null;
        queueMicrotask(() => {
          child.stdout.write(`${secret}\n`);
          child.stdout.end();
          child.stderr.end();
          child.emit("close", 0);
        });
        return child;
      }
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          written += chunk.toString("utf8");
          callback();
        },
        final(callback) {
          callback();
          queueMicrotask(() => child.emit("close", 0));
        },
      });
      return child;
    },
  });
  await store.set("receiver:one", secret);
  assert.equal(invocations[0].command, "/usr/bin/security");
  assert.deepEqual(invocations[0].arguments_, ["-i"]);
  assert.equal(
    invocations.every((invocation) => !invocation.arguments_.includes(secret)),
    true,
  );
  assert.match(written, new RegExp(RECEIVER_KEYCHAIN_SERVICE));
  assert.match(written, new RegExp(secret));
});

test("Keychain reads tolerate an ignored stdin stream and validate the result", async () => {
  const secret = `syn_recv_${"B".repeat(43)}`;
  const store = new MacOsKeychainStore({
    platform: "darwin",
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = null;
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.write(`${secret}\n`);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0);
      });
      return child;
    },
  });
  assert.equal(await store.get("receiver:one"), secret);
});

test("enrollment stores only a credential hash locally and resumes completion", async () => {
  const { registry, root } = await paths();
  const database = new DatabaseSync(registry);
  database.exec(
    "CREATE TABLE projects (alias TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE)",
  );
  database.prepare("INSERT INTO projects VALUES (?, ?)").run("demo", root);
  database.close();
  const secrets = new Map();
  const secretStore = {
    set: async (account, secret) => secrets.set(account, secret),
    get: async (account) => secrets.get(account),
    delete: async (account) => secrets.delete(account),
  };
  let pairings = 0;
  const dependencies = {
    registryPath: registry,
    resolveRoot: async () => root,
    secretStore,
    createId: () => "connection-1",
    createBytes: () => Buffer.alloc(32, 7),
    openBrowser: false,
    createClient: ({ credential }) => ({
      createPairing: async (hash) => {
        pairings += 1;
        assert.equal(hash.includes(credential), false);
        return {
          pairing_id: `pairing-${pairings}`,
          verification_url: `https://synapse.example/pairing-${pairings}`,
          expires_at: "2026-09-07T01:00:00.000Z",
        };
      },
      completePairing: async () => ({
        statusCode: 200,
        status: "connected",
        identity: wireIdentity(),
      }),
      disconnect: async () => ({ disconnected: true }),
    }),
  };
  const pending = await startReceiverConnection(
    { project: root, serverUrl: "https://synapse.example" },
    dependencies,
  );
  assert.equal(pending.status, "pending");
  const raw = new DatabaseSync(registry, { readOnly: true });
  const stored = raw.prepare("SELECT * FROM receiver_connections").get();
  raw.close();
  const secret = secrets.get("receiver:connection-1");
  assert.match(secret, /^syn_recv_/);
  assert.equal(JSON.stringify(stored).includes(secret), false);
  assert.equal(stored.credential_hash.length, 64);
  const restarted = await startReceiverConnection(
    { project: root, serverUrl: "https://synapse.example" },
    {
      ...dependencies,
      now: () => Date.parse("2026-09-07T02:00:00.000Z"),
    },
  );
  assert.equal(restarted.pairingId, "pairing-2");
  assert.equal(secrets.size, 1);
  const connected = await finishReceiverConnection(
    { project: root },
    dependencies,
  );
  assert.equal(connected.status, "connected");
  assert.equal(connected.identity.userId, identity.userId);
  await disconnectReceiver({ project: root }, dependencies);
  assert.equal(secrets.size, 0);
});
