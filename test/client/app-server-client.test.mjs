import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AppServerClient,
  appServerSocketPath,
} from "../../plugins/synapse/lib/app-server-client.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function serverFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.allocUnsafe(2 + body.byteLength);
  frame[0] = 0x81;
  frame[1] = body.byteLength;
  body.copy(frame, 2);
  return frame;
}

function clientFrame(buffer) {
  if (buffer.byteLength < 6) return null;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.byteLength < 8) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (buffer.byteLength < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let index = 0; index < payload.byteLength; index += 1) {
    payload[index] ^= mask[index % 4];
  }
  const opcode = buffer[0] & 0x0f;
  return {
    value: opcode === 0x1 ? JSON.parse(payload.toString("utf8")) : null,
    consumed: offset + length,
  };
}

async function fakeServer({ errorMethod = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "synapse-app-server-"));
  const socketPath = join(directory, "app.sock");
  const received = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const boundary = buffer.indexOf("\r\n\r\n");
        if (boundary === -1) return;
        const headers = buffer.subarray(0, boundary).toString("utf8");
        buffer = buffer.subarray(boundary + 4);
        const key = headers.match(/Sec-WebSocket-Key: ([^\r\n]+)/i)?.[1];
        const accept = createHash("sha1")
          .update(`${key}${GUID}`)
          .digest("base64");
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "",
            "",
          ].join("\r\n"),
        );
        upgraded = true;
      }
      let frame = clientFrame(buffer);
      while (frame) {
        buffer = buffer.subarray(frame.consumed);
        if (!frame.value) {
          frame = clientFrame(buffer);
          continue;
        }
        received.push(frame.value);
        if (frame.value.id !== undefined && frame.value.method) {
          const response =
            frame.value.method === errorMethod
              ? {
                  id: frame.value.id,
                  error: { code: -1, message: "missing" },
                }
              : {
                  id: frame.value.id,
                  result: { method: frame.value.method },
                };
          socket.write(serverFrame(response));
        }
        frame = clientFrame(buffer);
      }
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolvePromise);
  });
  return {
    socketPath,
    received,
    send(value) {
      for (const socket of sockets) socket.write(serverFrame(value));
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise) => server.close(resolvePromise));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("the client speaks WebSocket directly to the shared daemon socket", async (t) => {
  const server = await fakeServer();
  t.after(() => server.close());
  const client = new AppServerClient({
    socketPath: server.socketPath,
    createKey: () => "dGhlIHNhbXBsZSBub25jZQ==",
  });
  await client.start();
  assert.deepEqual(await client.request("project/list", {}), {
    method: "project/list",
  });
  assert.equal(server.received[0].method, "initialize");
  assert.equal(server.received[1].method, "initialized");
  await client.close();
});

test("App Server errors reject the matching request", async (t) => {
  const server = await fakeServer({ errorMethod: "thread/read" });
  t.after(() => server.close());
  const client = new AppServerClient({ socketPath: server.socketPath });
  await client.start();
  await assert.rejects(
    client.request("thread/read", { threadId: "thread-1" }),
    /thread\/read failed/,
  );
  await client.close();
});

test("server requests are rejected instead of hanging", async (t) => {
  const server = await fakeServer();
  t.after(() => server.close());
  const client = new AppServerClient({ socketPath: server.socketPath });
  await client.start();
  server.send({
    id: 99,
    method: "item/commandExecution/requestApproval",
    params: {},
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.deepEqual(server.received.at(-1), {
    id: 99,
    error: {
      code: -32601,
      message:
        "Unsupported Synapse client method: item/commandExecution/requestApproval",
    },
  });
  await client.close();
});

test("the default socket honors CODEX_HOME and explicit overrides", () => {
  assert.equal(
    appServerSocketPath({ CODEX_HOME: "/codex" }),
    "/codex/app-server-control/app-server-control.sock",
  );
  assert.equal(
    appServerSocketPath({ CODEX_APP_SERVER_SOCKET: "/custom.sock" }),
    "/custom.sock",
  );
});
