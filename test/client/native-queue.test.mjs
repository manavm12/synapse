import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { NativeQueueClient } from "../../plugins/synapse/lib/native-queue.mjs";

function fixture(respond = () => undefined, timeoutMs = 100) {
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.emit("exit");
  };
  child.stdin = new Writable({
    write(chunk, _, done) {
      const call = JSON.parse(chunk.toString());
      calls.push(call);
      const defaults = {
        initialize: {},
        "thread/read": {
          thread: { id: "task", cwd: "/repo", status: { type: "active" } },
        },
        "thread/list": { data: [{ id: "task" }], nextCursor: null },
        "thread/queue/list": { data: [] },
        "thread/queue/add": {
          queuedSubmission: {
            id: "queue-id",
            clientUserMessageId: call.params?.clientUserMessageId,
          },
        },
      };
      const value = respond(call, child) ?? defaults[call.method];
      if (call.id && value !== "timeout")
        queueMicrotask(() =>
          child.stdout.write(
            `${JSON.stringify({ id: call.id, ...(value?.error ? { error: value.error } : { result: value }) })}\n`,
          ),
        );
      done();
    },
  });
  const client = new NativeQueueClient({
    codexPath: "/fixture/codex",
    socketPath: "/fixture/control.sock",
    timeoutMs,
    spawnProcess: (path, args) => {
      assert.equal(path, "/fixture/codex");
      assert.deepEqual(args, [
        "app-server",
        "proxy",
        "--sock",
        "/fixture/control.sock",
      ]);
      return child;
    },
  });
  return { client, child, calls };
}

test("native queue probes live destinations and queues behind active work with a stable ID", async () => {
  const f = fixture();
  try {
    assert.equal((await f.client.prepare("task")).status.type, "active");
    await f.client.start();
    assert.equal(
      (
        await f.client.submit({
          threadId: "task",
          prompt: "Purpose-written message",
          deliveryId: "delivery",
        })
      ).id,
      "queue-id",
    );
    assert.equal(f.calls.filter((c) => c.method === "initialize").length, 1);
    const add = f.calls.find((c) => c.method === "thread/queue/add");
    assert.equal(add.params.clientUserMessageId, "synapse-delivery");
    assert.deepEqual(add.params.input, [
      { type: "text", text: "Purpose-written message", text_elements: [] },
    ]);
    assert.ok(
      !f.calls.some((c) => /turn\/|queue\/start|thread\/resume/.test(c.method)),
    );
  } finally {
    f.client.close();
  }
});

test("archived or deleted tasks and missing queue support fail before mutation", async (t) => {
  for (const [name, responder, pattern] of [
    [
      "deleted",
      (call) => (call.method === "thread/read" ? { thread: null } : undefined),
      /unavailable/,
    ],
    [
      "archived",
      (call) =>
        call.method === "thread/list"
          ? { data: [], nextCursor: null }
          : undefined,
      /archived/,
    ],
    [
      "queue unavailable",
      (call) => (call.method === "thread/queue/list" ? {} : undefined),
      /update Codex/,
    ],
    [
      "listing unavailable",
      (call) => (call.method === "thread/list" ? {} : undefined),
      /listing/,
    ],
  ])
    await t.test(name, async () => {
      const f = fixture(responder);
      try {
        await assert.rejects(f.client.prepare("task"), pattern);
        assert.ok(!f.calls.some((c) => c.method === "thread/queue/add"));
      } finally {
        f.client.close();
      }
    });
  const paged = fixture((call) =>
    call.method === "thread/list" && !call.params.cursor
      ? { data: [], nextCursor: "page2" }
      : undefined,
  );
  try {
    await paged.client.prepare("task");
    assert.equal(
      paged.calls.filter((c) => c.method === "thread/list").length,
      2,
    );
  } finally {
    paged.client.close();
  }
});

test("ambiguous queue responses, disconnects and malformed frames reject instead of claiming acceptance", async (t) => {
  for (const [name, responder, pattern] of [
    [
      "timeout",
      (call) => (call.method === "initialize" ? "timeout" : undefined),
      /Timed out/,
    ],
    [
      "error",
      (call) =>
        call.method === "initialize"
          ? { error: { code: -1, message: "denied" } }
          : undefined,
      /denied/,
    ],
    [
      "malformed",
      (call, child) => {
        if (call.method === "initialize") {
          queueMicrotask(() => child.stdout.write("broken\n"));
          return "timeout";
        }
      },
      /Invalid native/,
    ],
    [
      "oversized",
      (call, child) => {
        if (call.method === "initialize") {
          queueMicrotask(() =>
            child.stdout.write("x".repeat(8 * 1024 * 1024 + 1)),
          );
          return "timeout";
        }
      },
      /too large/,
    ],
    [
      "exit",
      (call, child) => {
        if (call.method === "initialize") {
          queueMicrotask(() => child.emit("exit"));
          return "timeout";
        }
      },
      /closed/,
    ],
  ])
    await t.test(name, async () => {
      const f = fixture(responder, 20);
      try {
        await assert.rejects(f.client.start(), pattern);
      } finally {
        f.client.close();
      }
    });
  const badAck = fixture((call) =>
    call.method === "thread/queue/add"
      ? {
          queuedSubmission: {
            id: "queue-id",
            clientUserMessageId: "different",
          },
        }
      : undefined,
  );
  try {
    await badAck.client.prepare("task");
    await assert.rejects(
      badAck.client.submit({
        threadId: "task",
        prompt: "hello",
        deliveryId: "id",
      }),
      /acknowledge/,
    );
  } finally {
    badAck.client.close();
  }
});
