import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AppToolsClient,
  appToolJson,
  appToolsPipePath,
} from "../../plugins/synapse/lib/app-tools-client.mjs";

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const framed = Buffer.allocUnsafe(payload.byteLength + 4);
  framed.writeUInt32LE(payload.byteLength, 0);
  payload.copy(framed, 4);
  return framed;
}

async function fakePipe({ failCall = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "synapse-app-tools-"));
  // Windows IPC has no Unix-domain-socket files; it addresses a named pipe
  // in the \\.\pipe\ namespace instead of a filesystem path.
  const path =
    platform() === "win32"
      ? `\\\\.\\pipe\\synapse-app-tools-${randomBytes(8).toString("hex")}`
      : join(directory, "tools.sock");
  const received = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.byteLength < length + 4) return;
        const message = JSON.parse(
          buffer.subarray(4, length + 4).toString("utf8"),
        );
        buffer = buffer.subarray(length + 4);
        received.push(message);
        const result =
          message.method === "tools/list"
            ? {
                tools: [{ name: "list_projects", namespace: "codex_app" }],
              }
            : {
                success: !failCall,
                contentItems: [
                  {
                    type: "inputText",
                    text: failCall
                      ? "host rejected call"
                      : JSON.stringify({ tool: message.params.tool }),
                  },
                ],
              };
        socket.write(frame({ id: message.id, jsonrpc: "2.0", result }));
      }
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(path, resolvePromise);
  });
  return {
    path,
    received,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise) => server.close(resolvePromise));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("the client invokes desktop tools over the native framed pipe", async (t) => {
  const pipe = await fakePipe();
  t.after(() => pipe.close());
  const client = new AppToolsClient({ pipePath: pipe.path });
  const result = await client.callTool(
    "list_projects",
    { example: true },
    { threadId: "owner-1", turnId: "turn-1" },
  );
  assert.deepEqual(appToolJson(result), { tool: "list_projects" });
  assert.equal(pipe.received[0].method, "tools/list");
  assert.deepEqual(pipe.received[0].params, { threadStartKind: "all" });
  assert.equal(pipe.received[1].method, "tools/call");
  assert.equal(pipe.received[1].params.namespace, "codex_app");
  assert.equal(pipe.received[1].params.threadId, "owner-1");
  assert.equal(pipe.received[1].params.turnId, "turn-1");
  assert.deepEqual(pipe.received[1].params.arguments, { example: true });
  await client.close();
});

test("failed desktop tool calls reject with their host message", async (t) => {
  const pipe = await fakePipe({ failCall: true });
  t.after(() => pipe.close());
  const client = new AppToolsClient({ pipePath: pipe.path });
  await assert.rejects(
    client.callTool("list_projects", {}, { threadId: "owner-1" }),
    /host rejected call/,
  );
  await client.close();
});

test("invalid tool payloads and unavailable tools fail closed", async (t) => {
  assert.throws(
    () =>
      appToolJson({
        success: true,
        contentItems: [{ type: "inputText", text: "not-json" }],
      }),
    /invalid JSON/,
  );
  const pipe = await fakePipe();
  t.after(() => pipe.close());
  const client = new AppToolsClient({ pipePath: pipe.path });
  await assert.rejects(
    client.callTool("missing", {}, { threadId: "owner-1" }),
    /tool is unavailable/,
  );
  await assert.rejects(client.callTool("list_projects", {}), /owner task ID/);
  await client.close();
});

test("the native pipe must come from the Codex desktop environment", () => {
  assert.equal(
    appToolsPipePath({ CODEX_APP_TOOLS_PIPE_PATH: "/tmp/tools.sock" }),
    "/tmp/tools.sock",
  );
  assert.throws(() => appToolsPipePath({}), /CODEX_APP_TOOLS_PIPE_PATH/);
});
