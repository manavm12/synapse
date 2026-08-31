import assert from "node:assert/strict";
import test from "node:test";

import { interruptTurnForRecovery } from "../../src/client/recovery.mjs";

function fakeClient(responses) {
  const requests = [];
  let closed = false;
  return {
    requests,
    get closed() {
      return closed;
    },
    async start() {},
    async request(method, params) {
      requests.push({ method, params });
      const response = responses.shift();
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
    async close() {
      closed = true;
    },
  };
}

test("recovery interrupts an active turn and confirms it stopped", async () => {
  const client = fakeClient([
    { thread: { turns: [{ id: "turn-1", status: "inProgress" }] } },
    {},
    { thread: { turns: [{ id: "turn-1", status: "interrupted" }] } },
  ]);

  const status = await interruptTurnForRecovery(
    { threadId: "thread-1", turnId: "turn-1" },
    {
      ensureServer: async () => {},
      createClient: () => client,
      attempts: 1,
      delayMs: 0,
    },
  );

  assert.equal(status, "interrupted");
  assert.deepEqual(client.requests, [
    {
      method: "thread/read",
      params: { threadId: "thread-1", includeTurns: true },
    },
    {
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    },
    {
      method: "thread/read",
      params: { threadId: "thread-1", includeTurns: true },
    },
  ]);
  assert.equal(client.closed, true);
});

test("recovery accepts an already terminal turn without interrupting it", async () => {
  const client = fakeClient([
    { thread: { turns: [{ id: "turn-1", status: "completed" }] } },
  ]);

  const status = await interruptTurnForRecovery(
    { threadId: "thread-1", turnId: "turn-1" },
    {
      ensureServer: async () => {},
      createClient: () => client,
    },
  );

  assert.equal(status, "completed");
  assert.equal(client.requests.length, 1);
  assert.equal(client.closed, true);
});

test("recovery fails closed when the recorded turn cannot be found", async () => {
  const client = fakeClient([{ thread: { turns: [] } }]);

  await assert.rejects(
    () =>
      interruptTurnForRecovery(
        { threadId: "thread-1", turnId: "turn-1" },
        {
          ensureServer: async () => {},
          createClient: () => client,
        },
      ),
    /was not found/,
  );
  assert.equal(client.closed, true);
});
