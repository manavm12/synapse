import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { getJob, queueMessage } from "../../plugins/synapse/lib/inbox.mjs";

const dispatchHookPath = resolve("plugins/synapse/hooks/dispatch.mjs");

function runHook(path, input, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [dispatchHookPath], {
      env: { ...process.env, SYNAPSE_INBOX_PATH: path, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`hook exited ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function gitFixture({ worktree = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "synapse-hook-git-"));
  const primaryPath = join(directory, "primary");
  execFileSync("git", ["init", "-b", "main", primaryPath]);
  const primary = realpathSync(primaryPath);
  execFileSync("git", [
    "-C",
    primary,
    "config",
    "user.email",
    "synapse@example.test",
  ]);
  execFileSync("git", ["-C", primary, "config", "user.name", "Synapse"]);
  await writeFile(join(primary, "README.md"), "fixture\n");
  execFileSync("git", ["-C", primary, "add", "README.md"]);
  execFileSync("git", ["-C", primary, "commit", "-m", "fixture"]);
  if (!worktree) return { directory, primary, child: null };
  const childPath = join(directory, "child");
  execFileSync("git", [
    "-C",
    primary,
    "worktree",
    "add",
    "--detach",
    childPath,
    "HEAD",
  ]);
  return { directory, primary, child: realpathSync(childPath) };
}

function serverFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const width = body.byteLength < 126 ? 0 : 2;
  const frame = Buffer.allocUnsafe(2 + width + body.byteLength);
  frame[0] = 0x81;
  frame[1] = width === 0 ? body.byteLength : 126;
  let offset = 2;
  if (width === 2) {
    frame.writeUInt16BE(body.byteLength, offset);
    offset += 2;
  }
  body.copy(frame, offset);
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
  } else if (length === 127) {
    if (buffer.byteLength < 14) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
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

async function fakeDaemon(directory, projectRoot) {
  const path = join(directory, "app-server.sock");
  const calls = [];
  const queued = [];
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
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
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
        const message = frame.value;
        if (message.id !== undefined) calls.push(message);
        let result;
        switch (message.method) {
          case "initialize":
            result = {};
            break;
          case "project/list":
            result = {
              data: [
                {
                  id: "probe",
                  roots: [{ path: projectRoot }],
                  metadata: { createdBy: "synapse-compatibility-probe" },
                },
                {
                  id: "project-1",
                  roots: [{ path: projectRoot }],
                  metadata: {},
                },
              ],
              nextCursor: null,
            };
            break;
          case "thread/start":
            result = { thread: { id: "thread-1" } };
            break;
          case "thread/read":
            result = { thread: { id: "thread-1", turns: [] } };
            break;
          case "thread/queue/list":
            result = { data: queued, nextCursor: null };
            break;
          case "thread/queue/add": {
            const submission = {
              id: "queued-1",
              clientUserMessageId: message.params.clientUserMessageId,
              input: message.params.input,
            };
            queued.push(submission);
            result = { queuedSubmission: submission };
            break;
          }
          default:
            result = {};
        }
        if (message.id !== undefined) {
          socket.write(serverFrame({ id: message.id, result }));
        }
        frame = clientFrame(buffer);
      }
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(path, resolvePromise);
  });
  return {
    path,
    calls,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

async function inbox() {
  return join(
    await mkdtemp(join(tmpdir(), "synapse-hook-inbox-")),
    "inbox.sqlite",
  );
}

test("a project prompt routes a queued message through the desktop daemon", async (t) => {
  const path = await inbox();
  const { directory, primary } = await gitFixture();
  const daemon = await fakeDaemon(directory, primary);
  t.after(() => daemon.close());
  queueMessage(
    {
      id: "job-1",
      channelId: "demo",
      task: "create TEST.md",
      projectRoot: primary,
    },
    { path },
  );

  const result = await runHook(
    path,
    {
      cwd: primary,
      session_id: "owner-1",
      prompt: "owner work",
      hook_event_name: "UserPromptSubmit",
    },
    {
      CODEX_APP_SERVER_SOCKET: daemon.path,
      SYNAPSE_WORKTREE_ROOT: join(directory, "worktrees"),
    },
  );

  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const job = getJob("job-1", { path });
  assert.equal(job.status, "completed");
  assert.equal(job.channelThreadId, "thread-1");
  assert.equal(job.projectId, "project-1");
  const { calls } = daemon;
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      "initialize",
      "project/list",
      "thread/start",
      "thread/name/set",
      "thread/read",
      "thread/queue/list",
      "thread/queue/add",
    ],
  );
  const started = calls.find((call) => call.method === "thread/start");
  assert.equal(started.params.projectId, "project-1");
  assert.notEqual(started.params.cwd, primary);
  const queued = calls.find((call) => call.method === "thread/queue/add");
  assert.match(queued.params.input[0].text, /create TEST\.md/);
  assert.match(queued.params.input[0].text, /synapse-delivery:v2/);
});

test("a linked worktree prompt never consumes the project inbox", async () => {
  const path = await inbox();
  const { primary, child } = await gitFixture({ worktree: true });
  queueMessage(
    { id: "job-1", channelId: "demo", task: "work", projectRoot: primary },
    { path },
  );
  const result = await runHook(path, {
    cwd: child,
    session_id: "child-1",
    hook_event_name: "UserPromptSubmit",
  });
  assert.deepEqual(result, { stdout: "", stderr: "" });
  assert.equal(getJob("job-1", { path }).status, "pending");
});

test("malformed hook input is ignored", async () => {
  const result = await runHook(await inbox(), {
    cwd: "/tmp",
    session_id: "bad id",
    hook_event_name: "UserPromptSubmit",
  });
  assert.deepEqual(result, { stdout: "", stderr: "" });
});
