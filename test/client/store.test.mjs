import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HostStore, RelayStore } from "../../src/client/store.mjs";

async function temporaryDatabase(t, name) {
  const root = await mkdtemp(join(tmpdir(), "synapse-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, name);
}

test("relay tasks survive reopening and retain outcomes", async (t) => {
  const path = await temporaryDatabase(t, "relay.sqlite");
  const first = new RelayStore(path, { now: () => 10, createId: () => "task-1" });
  assert.equal(
    first.createTask({
      hostId: "local",
      conversationId: "demo",
      project: "synapse",
      prompt: "Do the task",
    }).status,
    "queued",
  );
  first.updateTask("task-1", {
    status: "completed",
    threadId: "thread-1",
    result: "done",
  });
  first.close();

  const second = new RelayStore(path);
  t.after(() => second.close());
  assert.deepEqual(second.getTask("task-1"), {
    id: "task-1",
    hostId: "local",
    conversationId: "demo",
    project: "synapse",
    prompt: "Do the task",
    status: "completed",
    threadId: "thread-1",
    worktreePath: null,
    result: "done",
    error: null,
    createdAt: 10,
    updatedAt: 10,
  });
  assert.deepEqual(second.pendingTasks("local"), []);
});

test("host conversations are pinned to one project", async (t) => {
  const path = await temporaryDatabase(t, "host.sqlite");
  const store = new HostStore(path, { now: () => 20 });
  t.after(() => store.close());
  store.upsertProject({ alias: "one", root: "/tmp/one", permissions: ":workspace" });
  store.upsertProject({ alias: "two", root: "/tmp/two", permissions: ":read-only" });
  store.createConversation({
    id: "conversation-1",
    project: "one",
    threadId: "thread-1",
    worktreePath: "/tmp/worktree-1",
    sourceHead: "abc",
  });
  assert.throws(
    () =>
      store.createConversation({
        id: "conversation-1",
        project: "two",
        threadId: "thread-2",
        worktreePath: "/tmp/worktree-2",
        sourceHead: "def",
      }),
    /pinned to project one/,
  );
});

test("host deliveries are idempotent and correlate turns", async (t) => {
  const path = await temporaryDatabase(t, "host.sqlite");
  const store = new HostStore(path);
  t.after(() => store.close());
  store.upsertProject({ alias: "one", root: "/tmp/one", permissions: ":workspace" });
  store.createConversation({
    id: "conversation-1",
    project: "one",
    threadId: "thread-1",
    worktreePath: "/tmp/worktree-1",
    sourceHead: "abc",
  });
  store.createDelivery({ taskId: "task-1", conversationId: "conversation-1" });
  store.createDelivery({ taskId: "task-1", conversationId: "conversation-1" });
  const updated = store.updateDelivery("task-1", {
    queuedSubmissionId: "queue-1",
    turnId: "turn-1",
    status: "running",
  });
  assert.equal(updated.status, "running");
  assert.equal(store.deliveryForTurn("turn-1").taskId, "task-1");
});
