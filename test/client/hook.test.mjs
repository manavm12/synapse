import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { recordSession } from "../../plugins/synapse/lib/conversation-store.mjs";
import {
  acceptProvisioning,
  getJob,
  queueMessage,
  reserveNextMessage,
  withInbox,
} from "../../plugins/synapse/lib/inbox.mjs";
import { ReceiverWorker } from "../../plugins/synapse/lib/receiver-worker.mjs";

const pluginRoot = resolve("plugins/synapse");
const dispatchHookPath = resolve(pluginRoot, "hooks/dispatch.mjs");
const dispatchWrapperPath = resolve(pluginRoot, "hooks/run-dispatch.sh");
const childBindHookPath = resolve(pluginRoot, "hooks/bind-child.mjs");

function runHook(
  path,
  input,
  { env = {}, hookPath = dispatchHookPath, wrapper = false } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const executable = wrapper ? "/bin/sh" : process.execPath;
    const arguments_ = [wrapper ? dispatchWrapperPath : hookPath];
    const child = spawn(executable, arguments_, {
      env: {
        ...process.env,
        SYNAPSE_INBOX_PATH: path,
        SYNAPSE_HOST_DB: join(dirname(path), "host.sqlite"),
        ...env,
      },
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
    "test@example.test",
  ]);
  execFileSync("git", ["-C", primary, "config", "user.name", "Synapse Test"]);
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

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const framed = Buffer.allocUnsafe(payload.byteLength + 4);
  framed.writeUInt32LE(payload.byteLength, 0);
  payload.copy(framed, 4);
  return framed;
}

function toolResult(value) {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  };
}

async function fakeAppTools(directory, projectRoot) {
  const path = join(directory, "app-tools.sock");
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
        let result;
        if (message.method === "tools/list") {
          result = {
            tools: [
              { name: "list_projects", namespace: "codex_app" },
              { name: "create_thread", namespace: "codex_app" },
              { name: "send_message_to_thread", namespace: "codex_app" },
            ],
          };
        } else if (message.params.tool === "list_projects") {
          result = toolResult({
            schemaVersion: 2,
            projects: [
              {
                projectId: "project-1",
                path: projectRoot,
                isGitRepository: true,
              },
            ],
          });
        } else if (message.params.tool === "create_thread") {
          result = toolResult({
            clientThreadId: "client-new-thread:test",
            hostId: "local",
          });
        } else {
          result = toolResult({});
        }
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
    },
  };
}

function escapeXmlText(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function delegatedTaskTranscript({ sourceThreadId, nativePrompt }) {
  return [
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context />" }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["environments.environment_context"],
        },
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        name: "create_thread",
        namespace: "codex_app",
        output: `<codex_delegation>\n  <source_thread_id>${sourceThreadId}</source_thread_id>\n  <input>${escapeXmlText(nativePrompt)}</input>\n</codex_delegation>`,
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
}

async function inbox() {
  return join(
    await mkdtemp(join(tmpdir(), "synapse-hook-inbox-")),
    "inbox.sqlite",
  );
}

test("the background hook creates a desktop project task and accepts its temporary ID", async (t) => {
  const path = await inbox();
  const { directory, primary } = await gitFixture();
  const appTools = await fakeAppTools(directory, primary);
  t.after(() => appTools.close());
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
      turn_id: "turn-1",
      prompt: "owner work",
      hook_event_name: "UserPromptSubmit",
    },
    {
      wrapper: true,
      env: {
        CODEX_APP_TOOLS_PIPE_PATH: appTools.path,
        CODEX_MCP_NODE_PATH: process.execPath,
      },
    },
  );

  assert.deepEqual(result, { stdout: "", stderr: "" });
  const job = getJob("job-1", { path });
  assert.equal(job.status, "accepted");
  assert.equal(job.bindingState, "provisioning");
  assert.equal(job.clientThreadId, "client-new-thread:test");
  assert.equal(job.projectId, "project-1");
  const call = appTools.received.find(
    (message) => message.params?.tool === "create_thread",
  );
  assert.equal(call.params.threadId, "owner-1");
  assert.equal(call.params.turnId, "turn-1");
  assert.equal(
    call.params.arguments.prompt.includes("synapse-delivery:v2"),
    true,
  );
  assert.deepEqual(call.params.arguments.target.environment, {
    type: "worktree",
    startingState: { type: "working-tree" },
  });
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

test("the child startup hook binds the permanent task ID independently", async () => {
  const path = await inbox();
  const { directory, primary, child } = await gitFixture({ worktree: true });
  queueMessage(
    { id: "job-1", channelId: "demo", task: "work", projectRoot: primary },
    { path },
  );
  const delivery = reserveNextMessage(
    { projectRoot: primary, ownerSessionId: "owner-1" },
    { path, createDeliveryId: () => "delivery-1" },
  );
  acceptProvisioning(
    {
      jobId: "job-1",
      deliveryId: "delivery-1",
      clientThreadId: "client-new-thread:test",
      projectId: "project-1",
      hostId: "local",
    },
    { path },
  );
  const transcriptPath = join(directory, "child.jsonl");
  await writeFile(
    transcriptPath,
    delegatedTaskTranscript({
      sourceThreadId: "owner-1",
      nativePrompt: delivery.nativePrompt,
    }),
  );

  const result = await runHook(
    path,
    {
      cwd: child,
      session_id: "thread-permanent-1",
      transcript_path: transcriptPath,
      source: "startup",
      hook_event_name: "SessionStart",
    },
    { hookPath: childBindHookPath },
  );
  assert.deepEqual(result, { stdout: "", stderr: "" });
  const job = getJob("job-1", { path });
  assert.equal(job.status, "completed");
  assert.equal(job.channelThreadId, "thread-permanent-1");
});

test("the child binder tolerates the transcript creation race", async () => {
  const path = await inbox();
  const { directory, primary, child } = await gitFixture({ worktree: true });
  queueMessage(
    { id: "job-1", channelId: "demo", task: "work", projectRoot: primary },
    { path },
  );
  const delivery = reserveNextMessage(
    { projectRoot: primary, ownerSessionId: "owner-1" },
    { path, createDeliveryId: () => "delivery-1" },
  );
  const transcriptPath = join(directory, "delayed.jsonl");
  const hook = runHook(
    path,
    {
      cwd: child,
      session_id: "thread-permanent-1",
      transcript_path: transcriptPath,
      source: "startup",
      hook_event_name: "SessionStart",
    },
    {
      hookPath: childBindHookPath,
      env: { SYNAPSE_CHILD_BIND_TIMEOUT_MS: "1000" },
    },
  );
  await pause(75);
  await writeFile(
    transcriptPath,
    delegatedTaskTranscript({
      sourceThreadId: "owner-1",
      nativePrompt: delivery.nativePrompt,
    }),
  );
  await hook;
  assert.equal(getJob("job-1", { path }).channelThreadId, "thread-permanent-1");
});

test("a copied marker in a direct user message cannot bind a child", async () => {
  const path = await inbox();
  const { directory, primary, child } = await gitFixture({ worktree: true });
  queueMessage(
    { id: "job-1", channelId: "demo", task: "work", projectRoot: primary },
    { path },
  );
  const delivery = reserveNextMessage(
    { projectRoot: primary, ownerSessionId: "owner-1" },
    { path, createDeliveryId: () => "delivery-1" },
  );
  const transcriptPath = join(directory, "copied.jsonl");
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: delivery.nativePrompt }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["user.text"],
        },
      },
    })}\n`,
  );
  await runHook(
    path,
    {
      cwd: child,
      session_id: "thread-evil",
      transcript_path: transcriptPath,
      source: "startup",
      hook_event_name: "SessionStart",
    },
    { hookPath: childBindHookPath },
  );
  assert.equal(getJob("job-1", { path }).status, "routing");
});

test("malformed hook input is ignored", async () => {
  const result = await runHook(await inbox(), {
    cwd: "/tmp",
    session_id: "bad id",
    hook_event_name: "UserPromptSubmit",
  });
  assert.deepEqual(result, { stdout: "", stderr: "" });
});

test("the receiver reconciles durable child evidence after startup timeout without an owner prompt", async (t) => {
  const { directory, primary, child } = await gitFixture({ worktree: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inboxOptions = { path: join(directory, "inbox.sqlite") };
  const queued = queueMessage(
    { channelId: "delayed-worker", projectRoot: primary, task: "Review" },
    inboxOptions,
  );
  const delivery = reserveNextMessage(
    { projectRoot: primary, ownerSessionId: "owner" },
    inboxOptions,
  );
  acceptProvisioning(
    {
      jobId: queued.jobId,
      deliveryId: delivery.deliveryId,
      clientThreadId: "temporary",
      hostId: "local",
      projectId: "project",
    },
    inboxOptions,
  );
  const transcript = join(directory, "late.jsonl");
  withInbox(
    (db) =>
      recordSession(db, {
        sessionId: "permanent",
        cwd: child,
        projectRoot: primary,
        transcriptPath: transcript,
        event: "Stop",
      }),
    inboxOptions,
  );
  const worker = new ReceiverWorker({ inboxOptions });
  await worker.reconcile(primary);
  assert.equal(getJob(queued.jobId, inboxOptions).status, "accepted");
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        namespace: "codex_app",
        name: "create_thread",
        output: `<codex_delegation><source_thread_id>owner</source_thread_id><input>${delivery.nativePrompt.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</input></codex_delegation>`,
      },
    })}\n`,
  );
  await worker.reconcile(primary);
  assert.equal(getJob(queued.jobId, inboxOptions).channelThreadId, "permanent");
  assert.equal(getJob(queued.jobId, inboxOptions).status, "completed");
  await worker.reconcile(primary);
});
