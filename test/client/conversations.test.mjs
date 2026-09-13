import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { controlConversation } from "../../plugins/synapse/lib/conversation-control.mjs";
import { handleConversationHook } from "../../plugins/synapse/lib/conversation-hooks.mjs";
import {
  acquireWorker,
  assertWorker,
  confirmOutgoingIntent,
  recordOutgoingIntent,
  recordRuntime,
  recordSession,
} from "../../plugins/synapse/lib/conversation-store.mjs";
import {
  acknowledgeMessage,
  confirmCloudImport,
  getJob,
  listPendingCloudEvents,
  markNativeMutationIssued,
  markNativeMutationUncertain,
  reserveNextMessage,
  stageCloudMessage,
  withInbox,
} from "../../plugins/synapse/lib/inbox.mjs";
import {
  cloudChannelId,
  messageContentHash,
} from "../../plugins/synapse/lib/receiver-contract.mjs";
import { ReceiverWorker } from "../../plugins/synapse/lib/receiver-worker.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "synapse-conversation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inboxOptions = { path: join(directory, "inbox.sqlite") };
  const identity = {
    installationId: randomUUID(),
    userId: randomUUID(),
    projectId: randomUUID(),
    username: "alice",
    projectAlias: "demo",
    expiresAt: "2030-01-01T00:00:00Z",
  };
  const root = join(directory, "project");
  const connection = { identity, projectRoot: root, status: "connected" };
  const receiver = () => connection;
  const store = (callback) => withInbox(callback, inboxOptions);
  const hookOptions = {
    inboxOptions,
    receiver,
    bind: async () => {},
    destinations: () => [],
    register: (input) => ({
      sessionId: input.session_id,
      cwd: root,
      projectRoot: root,
    }),
  };
  const hook = (event, values = {}, session = "source") =>
    handleConversationHook(
      {
        hook_event_name: event,
        session_id: session,
        cwd: root,
        turn_id: "turn-1",
        ...values,
      },
      hookOptions,
    );
  const sendInput = () => ({
    to_username: "bob",
    message: "Question",
    request_id: randomUUID(),
  });
  const sendResult = (input, conversationId = randomUUID()) => ({
    message_id: randomUUID(),
    conversation_id: conversationId,
    disposition: input.disposition ?? "continue",
    in_reply_to_message_id: input.message_id ?? null,
    sender: { user_id: identity.userId, project_id: identity.projectId },
  });
  function incoming({
    conversationId = randomUUID(),
    sequence = 1,
    origin = null,
    disposition = "continue",
    version = 2,
    confirm = true,
  } = {}) {
    const message = {
      version,
      messageId: randomUUID(),
      conversationId,
      sequence,
      senderUsername: "bob",
      senderUserId: randomUUID(),
      recipientUserId: identity.userId,
      recipientProjectId: identity.projectId,
      message: "Peer data",
      contentHash: messageContentHash("Peer data"),
      claimToken: "claim",
      leaseExpiresAt: "2030-01-01T00:00:00Z",
      disposition,
      inReplyToMessageId: null,
      recipientOriginRequestId: origin,
    };
    stageCloudMessage(
      {
        message,
        identity,
        projectRoot: root,
        channelId: cloudChannelId(
          identity.installationId,
          identity.userId,
          conversationId,
        ),
      },
      inboxOptions,
    );
    if (confirm)
      confirmCloudImport(
        {
          messageId: message.messageId,
          installationId: identity.installationId,
        },
        inboxOptions,
      );
    return message;
  }
  function reserve() {
    return reserveNextMessage(
      { projectRoot: root, ownerSessionId: "owner" },
      { ...inboxOptions, receiverIdentity: identity },
    );
  }
  function accept(delivery, session = "source") {
    markNativeMutationIssued(
      {
        jobId: delivery.jobId,
        deliveryId: delivery.deliveryId,
        receiverIdentity: identity,
      },
      inboxOptions,
    );
    acknowledgeMessage(
      {
        jobId: delivery.jobId,
        deliveryId: delivery.deliveryId,
        threadId: session,
        projectId: "native-project",
        hostId: "local",
      },
      inboxOptions,
    );
  }
  const control = (action, conversationId, taskId) =>
    controlConversation(
      { action, conversationId, taskId, projectRoot: root },
      { inboxOptions, receiver },
    );
  return {
    directory,
    inboxOptions,
    identity,
    root,
    connection,
    receiver,
    store,
    hookOptions,
    hook,
    sendInput,
    sendResult,
    incoming,
    reserve,
    accept,
    control,
  };
}

test("send hooks persist exact intents, reject task/account conflicts, and recover lost receipts", async (t) => {
  const f = await fixture(t);
  const input = f.sendInput();
  const tool_name = "mcp__synapse_memory__send_message";
  const pre = (values) =>
    f.hook("PreToolUse", { tool_name, tool_input: input, ...values });
  assert.equal(await pre(), null);
  assert.equal(await pre(), null);
  assert.equal(
    f.store(
      (db) => db.prepare("SELECT count(*) AS n FROM outgoing_intents").get().n,
    ),
    1,
  );
  assert.equal(
    (await pre({ tool_input: { ...input, message: "Different" } }))
      .hookSpecificOutput.permissionDecision,
    "deny",
  );
  assert.equal(
    (
      await f.hook(
        "PreToolUse",
        { tool_name, tool_input: input },
        "another-task",
      )
    ).hookSpecificOutput.permissionDecision,
    "deny",
  );
  const resumed = await f.hook("SessionStart");
  assert.match(
    resumed.hookSpecificOutput.additionalContext,
    new RegExp(input.request_id),
  );
  const sent = f.sendResult(input);
  await assert.rejects(
    f.hook("PostToolUse", {
      tool_name,
      tool_input: input,
      tool_response: {
        structuredContent: {
          ...sent,
          sender: { user_id: randomUUID(), project_id: f.identity.projectId },
        },
      },
    }),
    /identity differs/,
  );
  await f.hook("PostToolUse", {
    tool_name,
    tool_input: input,
    tool_response: { isError: true },
  });
  await f.hook("PostToolUse", {
    tool_name,
    tool_input: input,
    tool_response: {
      content: [
        { type: "text", text: "not JSON" },
        { type: "text", text: JSON.stringify(sent) },
      ],
    },
  });
  await f.hook("PostToolUse", {
    tool_name,
    tool_input: input,
    tool_response: { structuredContent: sent },
  });
  assert.equal(
    f.store(
      (db) => db.prepare("SELECT thread_id FROM channels").get().thread_id,
    ),
    "source",
  );
  assert.equal(await f.hook("SessionStart"), null);
  assert.throws(
    () =>
      f.store((db) =>
        confirmOutgoingIntent(db, {
          identity: f.identity,
          requestId: input.request_id,
          sent: { ...sent, disposition: "complete" },
        }),
      ),
    /conflicts/,
  );
  assert.equal(
    (
      await pre({
        tool_input: { ...f.sendInput(), conversation_id: randomUUID() },
      })
    ).hookSpecificOutput.permissionDecision,
    "deny",
  );
  const second = f.sendInput();
  await pre({ tool_input: second });
  const message = f.incoming({ sequence: 2, origin: second.request_id });
  assert.equal(f.reserve().channel.threadId, "source");
  assert.equal(
    f.store(
      (db) =>
        db
          .prepare("SELECT status FROM outgoing_intents WHERE request_id=?")
          .get(second.request_id).status,
    ),
    "sent",
  );
  assert.equal(message.sequence, 2);
});

test("missing reply gets one repair; duplicate Stop is idempotent and completion never loops", async (t) => {
  const f = await fixture(t);
  const message = f.incoming();
  const delivery = f.reserve();
  f.accept(delivery);
  assert.equal(
    await f.hook("UserPromptSubmit", {
      prompt: delivery.nativePrompt.replaceAll(delivery.deliveryId, "forged"),
    }),
    null,
  );
  assert.equal(
    await f.hook(
      "UserPromptSubmit",
      { prompt: delivery.nativePrompt },
      "unrelated",
    ),
    null,
  );
  const context = await f.hook("UserPromptSubmit", {
    prompt: delivery.nativePrompt,
  });
  assert.match(
    context.hookSpecificOutput.additionalContext,
    /purpose-written reply is required/,
  );
  assert.equal((await f.hook("Stop")).decision, "block");
  assert.equal((await f.hook("Stop")).decision, "block");
  assert.equal(await f.hook("Stop", { stop_hook_active: true }), null);
  assert.equal(await f.hook("Stop", { stop_hook_active: true }), null);
  assert.equal(
    f.store(
      (db) =>
        db.prepare("SELECT status FROM conversation_responses").get().status,
    ),
    "needs_attention",
  );
  assert.equal(getJob(message.messageId, f.inboxOptions).status, "completed");
  const events = listPendingCloudEvents(
    { installationId: f.identity.installationId },
    f.inboxOptions,
  );
  assert.deepEqual(
    events.map((e) => e.kind),
    ["delivered", "needs_attention"],
  );
  assert.equal(f.control("resume", message.conversationId).state, "ready");
  assert.equal(
    f.store(
      (db) =>
        db.prepare("SELECT status FROM conversation_responses").get().status,
    ),
    "resume_pending",
  );
  await f.hook("UserPromptSubmit", {
    prompt: delivery.nativePrompt,
    turn_id: "turn-2",
  });
  const args = {
    message_id: message.messageId,
    message: "Done",
    request_id: randomUUID(),
    disposition: "complete",
  };
  const tool_name = "mcp__synapse_memory__reply_to_message";
  await f.hook("PreToolUse", { tool_name, tool_input: args });
  await f.hook("PostToolUse", {
    tool_name,
    tool_input: args,
    tool_response: {
      structuredContent: f.sendResult(args, message.conversationId),
    },
  });
  assert.equal(await f.hook("Stop", { turn_id: "turn-2" }), null);
  const final = f.incoming({
    conversationId: message.conversationId,
    sequence: 3,
    disposition: "complete",
  });
  const finalDelivery = f.reserve();
  f.accept(finalDelivery);
  await f.hook("UserPromptSubmit", { prompt: finalDelivery.nativePrompt });
  assert.equal(await f.hook("Stop"), null);
  assert.equal(
    f.store(
      (db) =>
        db
          .prepare(
            "SELECT status FROM conversation_responses WHERE message_id=?",
          )
          .get(final.messageId).status,
    ),
    "done",
  );
});

test("interrupt blocks queued input and explicit resume retains the reply obligation", async (t) => {
  const f = await fixture(t);
  const message = f.incoming();
  const delivery = f.reserve();
  f.accept(delivery);
  await f.hook("Interrupt");
  assert.equal(
    (await f.hook("UserPromptSubmit", { prompt: delivery.nativePrompt }))
      .decision,
    "block",
  );
  assert.equal(await f.hook("Stop"), null);
  assert.equal(f.reserve(), null);
  const args = {
    message_id: message.messageId,
    message: "Reply",
    request_id: randomUUID(),
    disposition: "complete",
  };
  const denied = await f.hook("PreToolUse", {
    tool_name: "mcp__synapse-memory__reply_to_message",
    tool_input: args,
  });
  assert.match(
    denied.hookSpecificOutput.permissionDecisionReason,
    /paused|interrupted/,
  );
  f.control("resume", message.conversationId);
  const queued = [];
  const worker = new ReceiverWorker({
    inboxOptions: f.inboxOptions,
    queueClient: () => ({
      async prepare() {},
      async submit(value) {
        queued.push(value);
      },
      close() {},
    }),
  });
  await worker.resumeResponses(
    f.connection,
    { codex_path: "/fixture" },
    () => {},
  );
  assert.equal(queued.length, 1);
  await worker.resumeResponses(
    f.connection,
    { codex_path: "/fixture" },
    () => {},
  );
  assert.equal(queued.length, 1);
  await f.hook("UserPromptSubmit", { prompt: queued[0].prompt });
  assert.equal(
    f.store(
      (db) =>
        db.prepare("SELECT status FROM conversation_responses").get().status,
    ),
    "active",
  );
});

test("established conversations require explicit repair and serialize shared task dispatch", async (t) => {
  const f = await fixture(t);
  const missing = f.incoming({ sequence: 4 });
  assert.equal(f.reserve(), null);
  assert.equal(
    getJob(missing.messageId, f.inboxOptions).bindingState,
    "missing",
  );
  assert.throws(
    () => f.control("repair", missing.conversationId, "unregistered"),
    /Open the intended task/,
  );
  await f.hook("SessionStart");
  f.control("repair", missing.conversationId, "source");
  const delivery = f.reserve();
  f.accept(delivery);
  const other = f.incoming({ sequence: 5 });
  f.control("repair", other.conversationId, "source");
  assert.equal(f.reserve(), null);
  await f.hook("SessionStart", {}, "different");
  assert.throws(
    () => f.control("repair", other.conversationId, "different"),
    /verified binding/,
  );
  f.control("pause", other.conversationId);
  assert.equal(f.reserve(), null);
  f.connection.identity = {
    ...f.identity,
    installationId: randomUUID(),
    userId: randomUUID(),
  };
  assert.equal(await f.hook("SessionStart"), null);
  assert.throws(
    () => f.control("resume", missing.conversationId),
    /Unknown conversation/,
  );
});

test("worker leases fence old owners, back off during outages, and recover exact pending sends once", async (t) => {
  const f = await fixture(t);
  let now = 1_000_000;
  const first = f.store((db) => acquireWorker(db, { owner: "first" }, now));
  assert.equal(
    f.store((db) => acquireWorker(db, { owner: "second" }, now)),
    null,
  );
  now += 30_001;
  const second = f.store((db) => acquireWorker(db, { owner: "second" }, now));
  assert.throws(
    () =>
      f.store((db) =>
        assertWorker(db, { owner: "first", generation: first }, now),
      ),
    /no longer current/,
  );
  f.store((db) =>
    assertWorker(db, { owner: "second", generation: second }, now),
  );
  const worker = new ReceiverWorker({
    inboxOptions: f.inboxOptions,
    owner: "second",
    now: () => now,
    connections: () => [],
  });
  assert.equal((await worker.tick()).delayMs, 4000);
  for (let i = 0; i < 5; i++) await worker.tick();
  assert.equal((await worker.tick()).delayMs, 60_000);
  worker.release();
  const input = f.sendInput();
  f.store((db) =>
    recordOutgoingIntent(
      db,
      {
        identity: f.identity,
        sessionId: "source",
        projectRoot: f.root,
        toolName: "send_message",
        input,
      },
      now - 40_000,
    ),
  );
  const requests = [];
  const recovery = new ReceiverWorker({
    inboxOptions: f.inboxOptions,
    now: () => now,
    queueClient: () => ({
      async prepare() {
        return { status: { type: "idle" } };
      },
      async submit(value) {
        requests.push(value);
      },
      close() {},
    }),
  });
  await recovery.recoverSends(
    f.connection,
    { codex_path: "/fixture" },
    () => {},
  );
  await recovery.recoverSends(
    f.connection,
    { codex_path: "/fixture" },
    () => {},
  );
  assert.equal(requests.length, 1);
  assert.match(requests[0].deliveryId, new RegExp(input.request_id));
  assert.doesNotMatch(requests[0].prompt, /Question/);
  f.store((db) =>
    recordSession(db, {
      sessionId: "source",
      projectRoot: f.root,
      cwd: f.root,
    }),
  );
  f.connection.status = "revoked";
  assert.equal(await f.hook("SessionStart"), null);
  assert.throws(() => f.control("pause", randomUUID()), /Connect the receiver/);
});

test("an observed queued delivery reconciles an ambiguous native receipt without resubmission", async (t) => {
  const f = await fixture(t);
  const input = f.sendInput();
  const sent = f.sendResult(input);
  f.store((db) => {
    recordOutgoingIntent(db, {
      identity: f.identity,
      sessionId: "source",
      projectRoot: f.root,
      toolName: "send_message",
      input,
    });
    confirmOutgoingIntent(db, {
      identity: f.identity,
      requestId: input.request_id,
      sent,
    });
  });
  const message = f.incoming({
    conversationId: sent.conversation_id,
    sequence: 2,
  });
  const delivery = f.reserve();
  markNativeMutationIssued(
    {
      jobId: message.messageId,
      deliveryId: delivery.deliveryId,
      receiverIdentity: f.identity,
    },
    f.inboxOptions,
  );
  markNativeMutationUncertain(
    {
      jobId: message.messageId,
      deliveryId: delivery.deliveryId,
      error: "queue ack lost",
    },
    f.inboxOptions,
  );
  assert.equal(f.reserve(), null);
  await f.hook("UserPromptSubmit", { prompt: delivery.nativePrompt });
  assert.equal(getJob(message.messageId, f.inboxOptions).status, "completed");
  assert.equal(
    f.store(
      (db) =>
        db.prepare("SELECT status FROM conversation_responses").get().status,
    ),
    "active",
  );
  const args = {
    request_id: randomUUID(),
    message_id: message.messageId,
    message: "Done",
    disposition: "complete",
  };
  await f.hook("PreToolUse", {
    tool_name: "mcp__synapse_memory__reply_to_message",
    tool_input: args,
  });
  const repair = await f.hook("Stop");
  assert.match(repair.reason, new RegExp(args.request_id));
  assert.match(repair.reason, /do not send another reply with a new ID/);
});

test("SQLite upgrade preserves proven bindings and fences unproven established conversations", async (t) => {
  const f = await fixture(t);
  const proven = f.incoming();
  f.accept(f.reserve());
  const unproven = f.incoming({ sequence: 7 });
  f.store((db) => {
    db.prepare(
      "UPDATE channels SET binding_state='unbound' WHERE cloud_conversation_id=?",
    ).run(unproven.conversationId);
    db.exec(
      "DROP INDEX channels_thread_unique; CREATE UNIQUE INDEX channels_thread_unique ON channels(thread_id) WHERE thread_id IS NOT NULL; PRAGMA user_version=3;",
    );
  });
  assert.equal(
    getJob(proven.messageId, f.inboxOptions).channelThreadId,
    "source",
  );
  assert.equal(
    getJob(unproven.messageId, f.inboxOptions).bindingState,
    "missing",
  );
  assert.equal(
    f.store((db) => db.prepare("PRAGMA user_version").get().user_version),
    5,
  );
  assert.ok(
    listPendingCloudEvents(
      { installationId: f.identity.installationId },
      f.inboxOptions,
    ).length >= 1,
  );
});

test("late binding after the child stopped gets one background repair and definitive send errors stay visible", async (t) => {
  const f = await fixture(t);
  const message = f.incoming();
  const delivery = f.reserve();
  f.accept(delivery);
  await f.hook("UserPromptSubmit", { prompt: delivery.nativePrompt });
  // Persist the Stop evidence as if binding became visible just afterwards.
  f.store((db) =>
    recordSession(db, {
      sessionId: "source",
      cwd: f.root,
      projectRoot: f.root,
      event: "Stop",
    }),
  );
  const queued = [];
  const worker = new ReceiverWorker({
    inboxOptions: f.inboxOptions,
    queueClient: () => ({
      async prepare() {
        return { status: { type: "idle" } };
      },
      async submit(value) {
        queued.push(value);
      },
      close() {},
    }),
  });
  await worker.repairIdleResponses(
    f.connection,
    { codex_path: "/fixture" },
    () => {},
  );
  await worker.repairIdleResponses(
    f.connection,
    { codex_path: "/fixture" },
    () => {},
  );
  assert.equal(queued.length, 1);
  assert.match(queued[0].prompt, new RegExp(message.messageId));
  const args = {
    request_id: randomUUID(),
    to_username: " BOB ",
    message: "new request",
  };
  const tool_name = "mcp__synapse_memory__send_message";
  assert.equal(
    await f.hook("PreToolUse", { tool_name, tool_input: args }),
    null,
  );
  await f.hook("PostToolUse", {
    tool_name,
    tool_input: args,
    tool_response: {
      isError: true,
      _meta: { synapse_error_code: "rate_limited" },
    },
  });
  assert.equal(
    f.store(
      (db) =>
        db
          .prepare("SELECT status FROM outgoing_intents WHERE request_id=?")
          .get(args.request_id).status,
    ),
    "rejected",
  );
});

test("an ambiguous resume stays fenced until its queued marker is observed", async (t) => {
  const f = await fixture(t);
  const message = f.incoming();
  const delivery = f.reserve();
  f.accept(delivery);
  await f.hook("UserPromptSubmit", { prompt: delivery.nativePrompt });
  await f.hook("Interrupt");
  f.control("resume", message.conversationId);
  let queued;
  const worker = new ReceiverWorker({
    inboxOptions: f.inboxOptions,
    queueClient: () => ({
      async prepare() {},
      async submit(value) {
        queued = value;
        throw new Error("lost receipt");
      },
      close() {},
    }),
  });
  await assert.rejects(
    worker.resumeResponses(f.connection, { codex_path: "/fixture" }, () => {}),
    /lost receipt/,
  );
  assert.throws(
    () => f.control("resume", message.conversationId),
    /uncertain outcome/,
  );
  await f.hook("UserPromptSubmit", { prompt: queued.prompt });
  assert.equal(
    f.store(
      (db) =>
        db.prepare("SELECT status FROM conversation_responses").get().status,
    ),
    "active",
  );
});

test("pause and interruption retain an unconsumed native submission across resume", async (t) => {
  for (const action of ["pause", "Interrupt"])
    await t.test(action, async (t) => {
      const f = await fixture(t);
      const message = f.incoming();
      const delivery = f.reserve();
      f.accept(delivery);
      const nativeQueue = [delivery.nativePrompt];
      const worker = new ReceiverWorker({
        inboxOptions: f.inboxOptions,
        queueClient: () => ({
          async prepare() {},
          async submit(value) {
            nativeQueue.push(value.prompt);
          },
          close() {},
        }),
      });
      if (action === "Interrupt") await f.hook(action);
      else f.control(action, message.conversationId);
      // The target remains busy; its native queue has not consumed this prompt.
      f.control("resume", message.conversationId);
      await worker.resumeResponses(
        f.connection,
        { codex_path: "/fixture" },
        () => {},
      );
      assert.equal(nativeQueue.length, 1);
      assert.equal(
        f.store(
          (db) =>
            db.prepare("SELECT status FROM conversation_responses").get()
              .status,
        ),
        "queued",
      );
      const result = await f.hook("UserPromptSubmit", {
        prompt: nativeQueue.shift(),
      });
      assert.match(
        result.hookSpecificOutput.additionalContext,
        /purpose-written reply is required/,
      );
      assert.equal(
        f.store(
          (db) =>
            db.prepare("SELECT status FROM conversation_responses").get()
              .status,
        ),
        "active",
      );
    });
});

test("blocked prompts resume once and later interruptions use distinct native submissions", async (t) => {
  const f = await fixture(t);
  const message = f.incoming();
  const delivery = f.reserve();
  f.accept(delivery);
  const queued = [];
  const worker = new ReceiverWorker({
    inboxOptions: f.inboxOptions,
    queueClient: () => ({
      async prepare() {},
      async submit(value) {
        queued.push(value);
      },
      close() {},
    }),
  });
  const resume = () =>
    worker.resumeResponses(f.connection, { codex_path: "/fixture" }, () => {});
  f.control("pause", message.conversationId);
  assert.equal(
    (await f.hook("UserPromptSubmit", { prompt: delivery.nativePrompt }))
      .decision,
    "block",
  );
  f.control("resume", message.conversationId);
  await resume();
  assert.equal(queued.length, 1);
  // Pausing a continuation still waiting in the native queue must retain it too.
  f.control("pause", message.conversationId);
  f.control("resume", message.conversationId);
  await resume();
  assert.equal(queued.length, 1);
  await f.hook("UserPromptSubmit", {
    prompt: queued[0].prompt,
    turn_id: "resumed-1",
  });
  await f.hook("Interrupt");
  f.control("resume", message.conversationId);
  await resume();
  await resume();
  assert.equal(queued.length, 2);
  assert.notEqual(queued[0].deliveryId, queued[1].deliveryId);
});

test("receiver upgrade enriches only unchanged and unissued v1 staged messages", async (t) => {
  const f = await fixture(t);
  const message = f.incoming({ version: 1, confirm: false });
  const stage = (value) =>
    stageCloudMessage(
      {
        message: value,
        identity: f.identity,
        projectRoot: f.root,
        channelId: cloudChannelId(
          f.identity.installationId,
          f.identity.userId,
          value.conversationId,
        ),
      },
      f.inboxOptions,
    );
  const upgraded = {
    ...message,
    version: 2,
    disposition: "complete",
    inReplyToMessageId: randomUUID(),
    claimToken: "renewed-claim",
  };
  const before = f.store((db) => db.prepare("SELECT * FROM jobs").get());
  for (const changes of [
    { message: "changed", contentHash: messageContentHash("changed") },
    { senderUserId: randomUUID() },
    { recipientUserId: randomUUID() },
    { recipientProjectId: randomUUID() },
    { sequence: 7 },
    { senderUsername: "eve" },
  ]) {
    assert.throws(
      () => stage({ ...upgraded, ...changes }),
      /Conflicting cloud payload/,
    );
    assert.deepEqual(
      f.store((db) => db.prepare("SELECT * FROM jobs").get()),
      before,
    );
  }
  assert.equal(stage(upgraded).duplicate, true);
  assert.equal(stage(upgraded).duplicate, true);
  const row = f.store((db) => db.prepare("SELECT * FROM jobs").get());
  assert.equal(row.protocol_version, 2);
  assert.equal(row.disposition, "complete");
  assert.equal(row.in_reply_to_message_id, upgraded.inReplyToMessageId);
  assert.equal(row.claim_token, "renewed-claim");
  assert.equal(
    f.store(
      (db) =>
        db.prepare("SELECT claim_token FROM receiver_import_outbox").get()
          .claim_token,
    ),
    "renewed-claim",
  );
  assert.equal(row.created_at, before.created_at);
  assert.equal(
    f.store((db) => db.prepare("SELECT count(*) AS n FROM jobs").get().n),
    1,
  );
  assert.throws(() => stage(message), /Conflicting cloud payload/);
  assert.throws(
    () => stage({ ...upgraded, disposition: "continue" }),
    /Conflicting cloud payload/,
  );
  confirmCloudImport(
    { messageId: message.messageId, installationId: f.identity.installationId },
    f.inboxOptions,
  );
  assert.equal(f.reserve().protocolVersion, 2);

  const confirmed = f.incoming({ version: 1 });
  assert.throws(
    () => stage({ ...confirmed, version: 2 }),
    /Conflicting cloud payload/,
  );
});

test("background repair preserves its queued input and fences an ambiguous acknowledgement", async (t) => {
  for (const lostReceipt of [false, true])
    await t.test(lostReceipt ? "lost receipt" : "accepted", async (t) => {
      const f = await fixture(t);
      const message = f.incoming();
      const delivery = f.reserve();
      f.accept(delivery);
      await f.hook("UserPromptSubmit", { prompt: delivery.nativePrompt });
      f.store((db) =>
        recordSession(db, {
          sessionId: "source",
          cwd: f.root,
          projectRoot: f.root,
          event: "Stop",
        }),
      );
      const queued = [];
      const worker = new ReceiverWorker({
        inboxOptions: f.inboxOptions,
        queueClient: () => ({
          async prepare() {
            return { status: { type: "idle" } };
          },
          async submit(value) {
            queued.push(value);
            if (lostReceipt) throw new Error("lost repair receipt");
          },
          close() {},
        }),
      });
      const repairing = worker.repairIdleResponses(
        f.connection,
        { codex_path: "/fixture" },
        () => {},
      );
      if (lostReceipt) {
        await assert.rejects(repairing, /lost repair receipt/);
        assert.throws(
          () => f.control("resume", message.conversationId),
          /uncertain outcome/,
        );
      } else {
        await repairing;
        f.control("pause", message.conversationId);
        f.control("resume", message.conversationId);
        await worker.resumeResponses(
          f.connection,
          { codex_path: "/fixture" },
          () => {},
        );
      }
      assert.equal(queued.length, 1);
      await f.hook("UserPromptSubmit", {
        prompt: queued[0].prompt,
        turn_id: "repair-turn",
      });
      assert.equal(
        f.store(
          (db) =>
            db.prepare("SELECT status FROM conversation_responses").get()
              .status,
        ),
        "active",
      );
      await f.hook("Stop", { turn_id: "repair-turn" });
      assert.equal(
        f.store(
          (db) =>
            db.prepare("SELECT status FROM conversation_responses").get()
              .status,
        ),
        "needs_attention",
      );
    });
});

test("upgrading an established unbound staged conversation keeps its missing-route fence", async (t) => {
  const f = await fixture(t);
  const message = f.incoming({ version: 1, confirm: false, sequence: 4 });
  stageCloudMessage(
    {
      message: { ...message, version: 2 },
      identity: f.identity,
      projectRoot: f.root,
      channelId: cloudChannelId(
        f.identity.installationId,
        f.identity.userId,
        message.conversationId,
      ),
    },
    f.inboxOptions,
  );
  confirmCloudImport(
    { messageId: message.messageId, installationId: f.identity.installationId },
    f.inboxOptions,
  );
  assert.equal(f.reserve(), null);
  assert.equal(
    getJob(message.messageId, f.inboxOptions).bindingState,
    "missing",
  );
  assert.equal(
    listPendingCloudEvents(
      { installationId: f.identity.installationId },
      f.inboxOptions,
    )[0].error_code,
    "reply_route_missing",
  );
});

test("a deliberate send from a projectless chat binds replies to that chat through the selected receiver", async (t) => {
  const f = await fixture(t);
  const input = f.sendInput();
  const sent = f.sendResult(input);
  const options = {
    ...f.hookOptions,
    register: (args) => ({
      sessionId: args.session_id,
      cwd: "/unrelated",
      projectRoot: "/unrelated",
    }),
    receiver: (root) => (root === f.root ? f.connection : null),
    destinations: () => [{ projectRoot: f.root }],
  };
  const hook = (event) =>
    handleConversationHook(
      {
        hook_event_name: event,
        session_id: "projectless-source",
        cwd: "/unrelated",
        tool_name: "mcp__synapse_memory__send_message",
        tool_input: input,
        tool_response: { structuredContent: sent },
      },
      options,
    );
  assert.equal(await hook("PreToolUse"), null);
  assert.equal(await hook("PostToolUse"), null);
  f.incoming({ conversationId: sent.conversation_id, sequence: 2 });
  assert.equal(f.reserve().channel.threadId, "projectless-source");
});

test("an unrelated chat registers receiver runtime without becoming the recipient's conversation", async (t) => {
  const f = await fixture(t);
  f.incoming();
  f.store((db) =>
    recordRuntime(db, {
      sessionId: "unrelated-trigger",
      projectRoot: f.root,
      pipePath: "/fixture/socket",
      nodePath: "/fixture/signed-node",
      codexPath: "/fixture/codex",
    }),
  );
  const worker = new ReceiverWorker({
    inboxOptions: f.inboxOptions,
    connections: () => [f.connection],
    available: () => true,
    nativeReconcile: async () => {},
    sync: async () => ({ authorized: true, identity: f.identity }),
    route: async (delivery, context) => {
      assert.equal(context.ownerThreadId, "unrelated-trigger");
      f.accept(delivery, "recipient-child");
    },
  });
  assert.equal((await worker.tick()).routed, 1);
  assert.equal(
    f.store(
      (db) => db.prepare("SELECT thread_id FROM channels").get().thread_id,
    ),
    "recipient-child",
  );
  worker.release();
});

test("pausing one conversation does not block another sharing its task, while interruption fences a late origin binding", async (t) => {
  const f = await fixture(t);
  const first = f.incoming();
  f.accept(f.reserve());
  await f.hook("SessionStart");
  f.control("pause", first.conversationId);
  const second = f.incoming({ sequence: 3 });
  f.control("repair", second.conversationId, "source");
  assert.equal(f.reserve().jobId, second.messageId);
  const args = f.sendInput();
  const tool_name = "mcp__synapse_memory__send_message";
  await f.hook("PreToolUse", { tool_name, tool_input: args });
  await f.hook("Interrupt");
  const sent = f.sendResult(args);
  await f.hook("PostToolUse", {
    tool_name,
    tool_input: args,
    tool_response: { structuredContent: sent },
  });
  f.incoming({ conversationId: sent.conversation_id, sequence: 2 });
  assert.equal(f.reserve(), null);
  assert.equal(
    f.store(
      (db) =>
        db
          .prepare(
            "SELECT pause_reason FROM channels WHERE cloud_conversation_id=?",
          )
          .get(sent.conversation_id).pause_reason,
    ),
    "user_interrupted",
  );
});
