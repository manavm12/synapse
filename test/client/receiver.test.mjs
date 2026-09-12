import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  acceptProvisioning,
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
  getReceiverConnection,
  markReceiverDisconnected,
  recordReceiverPairing,
} from "../../plugins/synapse/lib/receiver-registry.mjs";
import {
  createReceiverSecretStore,
  LinuxSecretServiceStore,
  MacOsKeychainStore,
  RECEIVER_KEYCHAIN_SERVICE,
  WindowsDpapiStore,
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
      channelId: cloudChannelId(
        identity.installationId,
        identity.userId,
        message.conversationId,
      ),
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
      { path: inbox, receiverIdentity: identity },
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
    {
      path: inbox,
      receiverIdentity: identity,
      createDeliveryId: () => "delivery-1",
    },
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
    {
      path: inbox,
      receiverIdentity: identity,
      createDeliveryId: () => "delivery-2",
    },
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

test("overlapping prompts do not invalidate a live issued native mutation", async () => {
  const { inbox } = await paths();
  const message = cloudMessage();
  stage(inbox, message);
  confirmCloudImport(
    { messageId: message.messageId, installationId: identity.installationId },
    { path: inbox },
  );
  const delivery = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    {
      path: inbox,
      now: () => 10,
      leaseMs: 100,
      receiverIdentity: identity,
      createDeliveryId: () => "delivery-1",
    },
  );
  markNativeMutationIssued(
    {
      jobId: delivery.jobId,
      deliveryId: delivery.deliveryId,
      receiverIdentity: identity,
    },
    { path: inbox, now: () => 11 },
  );
  assert.equal(
    reserveNextMessage(
      { projectRoot: "/project", ownerSessionId: "owner-2" },
      { path: inbox, now: () => 12, receiverIdentity: identity },
    ),
    null,
  );
  assert.equal(getJob(message.messageId, { path: inbox }).status, "routing");
  acceptProvisioning(
    {
      jobId: delivery.jobId,
      deliveryId: delivery.deliveryId,
      clientThreadId: "client-thread-1",
      projectId: "codex-project",
    },
    { path: inbox, now: () => 13 },
  );
  assert.equal(getJob(message.messageId, { path: inbox }).status, "accepted");
});

test("expired pre-mutation cloud intent can move to a newly authorized owner", async () => {
  const { inbox } = await paths();
  const message = cloudMessage();
  stage(inbox, message);
  confirmCloudImport(
    { messageId: message.messageId, installationId: identity.installationId },
    { path: inbox },
  );
  reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    {
      path: inbox,
      now: () => 10,
      leaseMs: 20,
      receiverIdentity: identity,
      createDeliveryId: () => "delivery-old",
    },
  );
  const reassigned = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-2" },
    {
      path: inbox,
      now: () => 31,
      receiverIdentity: identity,
      createDeliveryId: () => "delivery-new",
    },
  );
  assert.equal(reassigned.ownerSessionId, "owner-2");
  assert.equal(reassigned.deliveryId, "delivery-new");
});

test("fresh authorization cannot route an old installation's imported job", async () => {
  const { inbox } = await paths();
  const message = cloudMessage();
  stage(inbox, message);
  confirmCloudImport(
    { messageId: message.messageId, installationId: identity.installationId },
    { path: inbox },
  );
  const replacement = {
    ...identity,
    installationId: "99999999-9999-4999-8999-999999999999",
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };
  assert.equal(
    reserveNextMessage(
      { projectRoot: "/project", ownerSessionId: "owner-new" },
      { path: inbox, receiverIdentity: replacement },
    ),
    null,
  );
  assert.equal(getJob(message.messageId, { path: inbox }).status, "pending");
});

test("a replacement installation isolates messages in the same conversation", async () => {
  const { inbox } = await paths();
  const replacement = {
    ...identity,
    installationId: "99999999-9999-4999-8999-999999999999",
  };
  const oldMessage = cloudMessage({ sequence: 1 });
  const newMessage = cloudMessage({
    id: "77777777-7777-4777-8777-777777777777",
    sequence: 2,
  });
  const oldChannel = cloudChannelId(
    identity.installationId,
    identity.userId,
    oldMessage.conversationId,
  );
  const newChannel = cloudChannelId(
    replacement.installationId,
    replacement.userId,
    newMessage.conversationId,
  );
  assert.notEqual(oldChannel, newChannel);
  stageCloudMessage(
    {
      message: oldMessage,
      identity,
      projectRoot: "/project",
      channelId: oldChannel,
    },
    { path: inbox },
  );
  confirmCloudImport(
    {
      messageId: oldMessage.messageId,
      installationId: identity.installationId,
    },
    { path: inbox },
  );
  stageCloudMessage(
    {
      message: newMessage,
      identity: replacement,
      projectRoot: "/project",
      channelId: newChannel,
    },
    { path: inbox },
  );
  confirmCloudImport(
    {
      messageId: newMessage.messageId,
      installationId: replacement.installationId,
    },
    { path: inbox },
  );
  const delivery = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-new" },
    { path: inbox, receiverIdentity: replacement },
  );
  assert.equal(delivery.jobId, newMessage.messageId);
  assert.equal(delivery.channelId, newChannel);
  assert.equal(getJob(oldMessage.messageId, { path: inbox }).status, "pending");
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
        channelId: cloudChannelId(
          identity.installationId,
          identity.userId,
          message.conversationId,
        ),
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
    {
      path: inbox,
      receiverIdentity: identity,
      createDeliveryId: () => "delivery-1",
    },
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
      { path: inbox },
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
    {
      path: inbox,
      receiverIdentity: identity,
      createDeliveryId: () => "delivery-1",
    },
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
    {
      path: inbox,
      receiverIdentity: identity,
      createDeliveryId: () => "delivery-1",
    },
  );
  markNativeMutationIssued(
    {
      jobId: delivery.jobId,
      deliveryId: delivery.deliveryId,
      receiverIdentity: identity,
    },
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
      { path: inbox, receiverIdentity: identity },
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
  const { inbox, registry } = await paths();
  beginReceiverConnection(
    {
      connectionId: "timeout-fixture",
      projectRoot: "/project",
      projectAlias: "demo",
      serverUrl: "https://example.test",
      credentialAccount: "receiver:timeout-fixture",
      credentialHash: "0".repeat(64),
    },
    { path: registry },
  );
  recordReceiverPairing(
    {
      connectionId: "timeout-fixture",
      pairingId: "fixture",
      verificationUrl: "https://example.test",
      expiresAt: identity.expiresAt,
    },
    { path: registry },
  );
  completeReceiverConnection(
    { connectionId: "timeout-fixture", identity },
    { path: registry },
  );
  const message = cloudMessage();
  stage(inbox, message);
  confirmCloudImport(
    { messageId: message.messageId, installationId: identity.installationId },
    { path: inbox },
  );
  const delivery = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    {
      path: inbox,
      receiverIdentity: identity,
      createDeliveryId: () => "delivery-1",
    },
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
            authorizeCloud: async () => {},
            cloudAuthorizationOptions: { registryPath: registry },
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

test("a disconnect completed during fresh authorization prevents native mutation", async () => {
  const { inbox, registry } = await paths();
  const database = new DatabaseSync(registry);
  database.exec(
    "CREATE TABLE projects (alias TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE)",
  );
  database
    .prepare("INSERT INTO projects VALUES (?, ?)")
    .run("demo", "/project");
  database.close();
  beginReceiverConnection(
    {
      connectionId: "connection-1",
      projectRoot: "/project",
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
  const message = cloudMessage();
  stage(inbox, message);
  confirmCloudImport(
    { messageId: message.messageId, installationId: identity.installationId },
    { path: inbox },
  );
  const delivery = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path: inbox, receiverIdentity: identity },
  );
  const nativeCalls = [];
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
      nativeCalls.push(name);
      throw new Error("native mutation must not run");
    },
  };
  let identityRequestedResolve;
  const identityRequested = new Promise((resolve) => {
    identityRequestedResolve = resolve;
  });
  let releaseIdentity;
  const routed = routeDelivery(delivery, {
    createClient: () => client,
    cloudAuthorizationOptions: {
      registryPath: registry,
      now: () => Date.parse("2026-09-07T00:00:00.000Z"),
      secretStore: {
        get: async () => `syn_recv_${"A".repeat(43)}`,
      },
      createReceiverClient: () => ({
        getIdentity: async () => {
          identityRequestedResolve();
          return await new Promise((resolve) => {
            releaseIdentity = () => resolve({ identity: wireIdentity() });
          });
        },
      }),
    },
  });
  await identityRequested;
  markReceiverDisconnected("connection-1", { path: registry });
  releaseIdentity();
  await assert.rejects(routed, /authorization is no longer current/);
  assert.deepEqual(nativeCalls, []);
  assert.equal(getJob(message.messageId, { path: inbox }).status, "routing");
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

test("receiver HTTP deadline covers a stalled response body", async () => {
  const client = new ReceiverClient({
    serverUrl: "https://synapse.example",
    credential: "syn_recv_secret",
    timeoutMs: 20,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start() {},
        }),
        { status: 200 },
      ),
  });
  await assert.rejects(client.getIdentity(), /timed out/);
});

test("receiver HTTP rejects an oversized body before buffering it", async () => {
  const client = new ReceiverClient({
    serverUrl: "https://synapse.example",
    credential: "syn_recv_secret",
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            controller.close();
          },
        }),
        { status: 200 },
      ),
  });
  await assert.rejects(client.getIdentity(), /response is too large/);
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

test("Keychain deletion treats only the absent-item exit as idempotent", async () => {
  const exitCodes = [44, 45];
  const store = new MacOsKeychainStore({
    platform: "darwin",
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = null;
      child.kill = () => {};
      const exitCode = exitCodes.shift();
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", exitCode);
      });
      return child;
    },
  });
  await store.delete("receiver:one");
  await assert.rejects(
    store.delete("receiver:one"),
    /Keychain operation failed/,
  );
});

function secretProcess(output, { input, exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  child.stdin = input
    ? new Writable({
        write(chunk, _encoding, callback) {
          input(chunk.toString("utf8"));
          callback();
        },
        final(callback) {
          callback();
          queueMicrotask(finish);
        },
      })
    : null;
  function finish() {
    if (output) child.stdout.write(output);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", exitCode);
  }
  if (!input) queueMicrotask(finish);
  return child;
}

test("receiver credential factory selects each supported OS vault", () => {
  assert.ok(createReceiverSecretStore({ platform: "darwin" }) instanceof MacOsKeychainStore);
  assert.ok(createReceiverSecretStore({ platform: "win32" }) instanceof WindowsDpapiStore);
  assert.ok(createReceiverSecretStore({ platform: "linux" }) instanceof LinuxSecretServiceStore);
  assert.throws(() => createReceiverSecretStore({ platform: "aix" }), /not supported/);
});

test("Windows DPAPI stores only protected data and never puts credentials in argv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-dpapi-test-"));
  const secret = `syn_recv_${"C".repeat(43)}`;
  const invocations = [];
  let stdin = "";
  const store = new WindowsDpapiStore({
    platform: "win32",
    directory,
    spawnImpl(command, arguments_) {
      invocations.push({ command, arguments_ });
      const operation = arguments_.at(-3);
      return secretProcess(operation === "protect" ? "Y2lwaGVy" : secret, {
        input: (value) => { stdin += value; },
      });
    },
  });
  await store.set("receiver:windows", secret);
  assert.equal(await store.get("receiver:windows"), secret);
  assert.equal(invocations.every(({ arguments_ }) => !arguments_.includes(secret)), true);
  assert.match(stdin, new RegExp(secret));
  assert.doesNotMatch(await readFile(store.path("receiver:windows"), "utf8"), /syn_recv_/);
  await store.delete("receiver:windows");
  await store.delete("receiver:windows");
});

test("Linux Secret Service sends credentials through stdin and uses stable attributes", async () => {
  const secret = `syn_recv_${"D".repeat(43)}`;
  const invocations = [];
  let written = "";
  const store = new LinuxSecretServiceStore({
    platform: "linux",
    spawnImpl(command, arguments_) {
      invocations.push({ command, arguments_ });
      return secretProcess(arguments_[0] === "lookup" ? secret : "", {
        input: arguments_[0] === "store" ? (value) => { written += value; } : undefined,
      });
    },
  });
  await store.set("receiver:linux", secret);
  await store.delete("receiver:linux");
  assert.equal(written, secret);
  assert.equal(invocations.every(({ command }) => command === "secret-tool"), true);
  assert.equal(invocations.every(({ arguments_ }) => !arguments_.includes(secret)), true);
  assert.equal(invocations.every(({ arguments_ }) => arguments_.includes(RECEIVER_KEYCHAIN_SERVICE)), true);
});

test("disconnect resumes after lost remote response and failed secret cleanup", async () => {
  const { registry, root } = await paths();
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
  let remoteCalls = 0;
  let deleteCalls = 0;
  const dependencies = {
    registryPath: registry,
    resolveRoot: async () => root,
    secretStore: {
      get: async () => `syn_recv_${"A".repeat(43)}`,
      delete: async () => {
        deleteCalls += 1;
        if (deleteCalls === 1) throw new Error("Keychain temporarily locked");
      },
    },
    createClient: () => ({
      disconnect: async () => {
        remoteCalls += 1;
        if (remoteCalls === 1) throw new Error("response lost");
        return { disconnected: true };
      },
    }),
  };
  await assert.rejects(
    disconnectReceiver({ project: root }, dependencies),
    /response lost/,
  );
  assert.equal(
    getReceiverConnection(root, { path: registry }).status,
    "disconnecting",
  );
  await assert.rejects(
    disconnectReceiver({ project: root }, dependencies),
    /Keychain temporarily locked/,
  );
  assert.equal(
    getReceiverConnection(root, { path: registry }).status,
    "revoked",
  );
  await disconnectReceiver({ project: root }, dependencies);
  assert.equal(
    getReceiverConnection(root, { path: registry }).status,
    "disconnected",
  );
  assert.equal(remoteCalls, 2);
  assert.equal(deleteCalls, 2);
  let replacementStored = false;
  const replacement = await startReceiverConnection(
    { project: root, serverUrl: "https://synapse.example" },
    {
      registryPath: registry,
      resolveRoot: async () => root,
      now: () => Date.parse("2028-01-01T00:00:00.000Z"),
      createId: () => "connection-2",
      createBytes: () => Buffer.alloc(32, 8),
      openBrowser: false,
      secretStore: {
        get: async () => {
          throw new Error("disconnected secret must not be read");
        },
        set: async () => {
          replacementStored = true;
        },
      },
      createClient: () => ({
        createPairing: async () => ({
          pairing_id: "pairing-2",
          verification_url: "https://synapse.example/pairing-2",
          expires_at: "2028-02-01T00:00:00.000Z",
        }),
      }),
    },
  );
  assert.equal(replacement.connectionId, "connection-2");
  assert.equal(replacementStored, true);
});

test("an approved pending enrollment can be durably cancelled after local completion fails", async () => {
  const { registry, root } = await paths();
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
  let disconnected = 0;
  let secretDeleted = 0;
  const dependencies = {
    registryPath: registry,
    resolveRoot: async () => root,
    secretStore: {
      get: async () => `syn_recv_${"A".repeat(43)}`,
      delete: async () => {
        secretDeleted += 1;
      },
    },
    createClient: () => ({
      completePairing: async () => ({
        statusCode: 200,
        status: "connected",
        identity: wireIdentity({ project_alias: "other-project" }),
      }),
      disconnect: async () => {
        disconnected += 1;
        return { disconnected: true };
      },
    }),
  };
  await assert.rejects(
    finishReceiverConnection({ project: root }, dependencies),
    /does not match local alias/,
  );
  assert.equal(
    getReceiverConnection(root, { path: registry }).status,
    "pending",
  );
  await disconnectReceiver({ project: root }, dependencies);
  assert.equal(
    getReceiverConnection(root, { path: registry }).status,
    "disconnected",
  );
  assert.equal(disconnected, 1);
  assert.equal(secretDeleted, 1);
});

test("connecting after credential expiry revokes the old installation before replacement", async () => {
  const { registry, root } = await paths();
  const database = new DatabaseSync(registry);
  database.exec(
    "CREATE TABLE projects (alias TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE)",
  );
  database.prepare("INSERT INTO projects VALUES (?, ?)").run("demo", root);
  database.close();
  beginReceiverConnection(
    {
      connectionId: "connection-old",
      projectRoot: root,
      projectAlias: "demo",
      serverUrl: "https://synapse.example",
      credentialAccount: "receiver:connection-old",
      credentialHash: "a".repeat(64),
    },
    { path: registry },
  );
  recordReceiverPairing(
    {
      connectionId: "connection-old",
      pairingId: "pairing-old",
      verificationUrl: "https://synapse.example/pair",
      expiresAt: "2026-01-01T00:00:00.000Z",
    },
    { path: registry },
  );
  completeReceiverConnection(
    {
      connectionId: "connection-old",
      identity: { ...identity, expiresAt: "2026-01-01T00:00:00.000Z" },
    },
    { path: registry },
  );
  const oldCredential = `syn_recv_${"A".repeat(43)}`;
  const secrets = new Map([["receiver:connection-old", oldCredential]]);
  const events = [];
  let disconnectCalls = 0;
  const dependencies = {
    registryPath: registry,
    resolveRoot: async () => root,
    now: () => Date.parse("2026-02-01T00:00:00.000Z"),
    createId: () => "connection-new",
    createBytes: () => Buffer.alloc(32, 7),
    openBrowser: false,
    secretStore: {
      get: async (account) => secrets.get(account),
      set: async (account, secret) => {
        events.push(`set:${account}`);
        secrets.set(account, secret);
      },
      delete: async (account) => {
        events.push(`delete:${account}`);
        secrets.delete(account);
      },
    },
    createClient: ({ credential }) => ({
      disconnect: async () => {
        disconnectCalls += 1;
        assert.equal(credential, oldCredential);
        events.push("disconnect-old");
        if (disconnectCalls === 1) throw new Error("response lost");
        return { disconnected: true };
      },
      createPairing: async () => {
        assert.notEqual(credential, oldCredential);
        events.push("pair-new");
        return {
          pairing_id: "pairing-new",
          verification_url: "https://synapse.example/pairing-new",
          expires_at: "2026-03-01T00:00:00.000Z",
        };
      },
    }),
  };
  await assert.rejects(
    startReceiverConnection(
      { project: root, serverUrl: "https://synapse.example" },
      dependencies,
    ),
    /response lost/,
  );
  assert.equal(
    getReceiverConnection(root, { path: registry }).status,
    "disconnecting",
  );
  assert.equal(secrets.get("receiver:connection-old"), oldCredential);
  assert.deepEqual(events, ["disconnect-old"]);

  const replacement = await startReceiverConnection(
    { project: root, serverUrl: "https://synapse.example" },
    dependencies,
  );
  assert.equal(replacement.connectionId, "connection-new");
  assert.equal(replacement.status, "pending");
  assert.equal(secrets.has("receiver:connection-old"), false);
  assert.equal(secrets.has("receiver:connection-new"), true);
  assert.deepEqual(events, [
    "disconnect-old",
    "disconnect-old",
    "delete:receiver:connection-old",
    "set:receiver:connection-new",
    "pair-new",
  ]);
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
