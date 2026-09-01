import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { createRelay } from "../../src/client/relay.mjs";
import { RelayStore } from "../../src/client/store.mjs";

function nextMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function createTestRelay(t) {
  const root = await mkdtemp(join(tmpdir(), "synapse-relay-test-"));
  const store = new RelayStore(join(root, "relay.sqlite"));
  const relay = createRelay({ store, port: 0, logger: { error() {} } });
  const address = await relay.start();
  const relayUrl = `http://${address.host}:${address.port}`;
  t.after(async () => {
    await relay.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { relay, store, relayUrl };
}

test("the mock relay rejects non-loopback listeners", () => {
  const store = { close() {} };
  assert.throws(
    () => createRelay({ store, host: "0.0.0.0" }),
    /only bind to a loopback/,
  );
});

test("offline tasks are persisted and pushed when the host connects", async (t) => {
  const { relayUrl } = await createTestRelay(t);
  const response = await fetch(`${relayUrl}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hostId: "local",
      conversationId: "demo",
      project: "synapse",
      prompt: "Do the task",
    }),
  });
  assert.equal(response.status, 202);
  const created = (await response.json()).task;
  assert.equal(created.status, "queued");

  const socket = new WebSocket(relayUrl.replace("http:", "ws:") + "/v1/host");
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const taskPromise = nextMessage(socket, (message) => message.type === "task");
  socket.send(JSON.stringify({ type: "hello", hostId: "local" }));
  const delivery = await taskPromise;
  assert.equal(delivery.task.id, created.id);
  assert.equal(delivery.task.prompt, "Do the task");
});

test("host status and results stream back through the relay", async (t) => {
  const { relayUrl } = await createTestRelay(t);
  const socket = new WebSocket(relayUrl.replace("http:", "ws:") + "/v1/host");
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const readyPromise = nextMessage(socket, (message) => message.type === "ready");
  socket.send(JSON.stringify({ type: "hello", hostId: "local" }));
  await readyPromise;

  const taskPromise = nextMessage(socket, (message) => message.type === "task");
  const response = await fetch(`${relayUrl}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hostId: "local",
      conversationId: "demo",
      project: "synapse",
      prompt: "Do the task",
    }),
  });
  const created = (await response.json()).task;
  await taskPromise;

  const eventsResponse = await fetch(`${relayUrl}/v1/tasks/${created.id}/events`);
  const reader = eventsResponse.body.getReader();
  socket.send(
    JSON.stringify({
      type: "status",
      taskId: created.id,
      status: "completed",
      threadId: "thread-1",
      worktreePath: "/tmp/worktree",
      result: "done",
    }),
  );
  let streamed = "";
  while (!streamed.includes('"status":"completed"')) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    streamed += new TextDecoder().decode(value);
  }
  assert.match(streamed, /"result":"done"/);

  const stored = (await (await fetch(`${relayUrl}/v1/tasks/${created.id}`)).json()).task;
  assert.equal(stored.status, "completed");
  assert.equal(stored.threadId, "thread-1");
});

test("invalid task envelopes are rejected before storage", async (t) => {
  const { relayUrl } = await createTestRelay(t);
  const response = await fetch(`${relayUrl}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "bad path", project: "synapse", prompt: "x" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /conversationId/);
});
