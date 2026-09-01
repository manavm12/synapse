import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AppServerClient } from "../../src/client/app-server-client.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.id) {
          queueMicrotask(() => {
            this.stdout.write(
              `${JSON.stringify({ id: message.id, result: { method: message.method } })}\n`,
            );
          });
        }
      }
    });
  }

  kill(signal) {
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

test("the client connects through the managed App Server proxy", async () => {
  const child = new FakeChild();
  const client = new AppServerClient({
    codexBinary: "/test/codex",
    codexArguments: ["app-server", "proxy"],
    spawnProcess: (binary, arguments_) => {
      assert.equal(binary, "/test/codex");
      assert.deepEqual(arguments_, ["app-server", "proxy"]);
      return child;
    },
  });
  await client.start();
  assert.deepEqual(await client.request("project/list", {}), { method: "project/list" });
  await client.close();
});

test("server requests are exposed for owner-attention handling", async () => {
  const child = new FakeChild();
  const client = new AppServerClient({
    codexArguments: ["app-server", "proxy"],
    spawnProcess: () => child,
  });
  await client.start();
  const requestPromise = once(client, "serverRequest");
  child.stdout.write(
    `${JSON.stringify({
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1" },
    })}\n`,
  );
  const [request] = await requestPromise;
  assert.equal(request.id, 99);
  assert.equal(request.params.turnId, "turn-1");
  await client.close();
});
