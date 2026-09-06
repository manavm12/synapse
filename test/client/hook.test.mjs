import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";

import {
  acceptProvisioning,
  getJob,
  queueMessage,
  reserveNextMessage,
} from "../../plugins/synapse/lib/inbox.mjs";

const pluginRoot = resolve(
  process.env.SYNAPSE_PLUGIN_ROOT ?? "plugins/synapse",
);
const dispatchHookPath = resolve(pluginRoot, "hooks/dispatch.mjs");
const childBindHookPath = resolve(pluginRoot, "hooks/bind-child.mjs");

function runHook(
  path,
  input,
  {
    arguments_ = [],
    env = {},
    hookPath = dispatchHookPath,
    rawInput = false,
  } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [hookPath, ...arguments_], {
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
    child.stdin.end(rawInput ? input : JSON.stringify(input));
  });
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

function childStartInput({ child, transcriptPath, sessionId = "thread-1" }) {
  return {
    cwd: child,
    session_id: sessionId,
    transcript_path: transcriptPath,
    source: "startup",
    hook_event_name: "SessionStart",
  };
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
    "-b",
    "child",
    childPath,
  ]);
  const child = realpathSync(childPath);
  return { directory, primary, child };
}

async function inbox() {
  return join(
    await mkdtemp(join(tmpdir(), "synapse-hook-inbox-")),
    "inbox.sqlite",
  );
}

test("a primary project prompt gets immediate nonblocking provisional acceptance", async () => {
  const path = await inbox();
  const { primary } = await gitFixture();
  queueMessage(
    {
      id: "job-1",
      channelId: "demo",
      task: "create TEST.md",
      projectRoot: primary,
    },
    { path },
  );
  const { stdout } = await runHook(path, {
    cwd: primary,
    session_id: "owner-1",
    prompt: "owner work",
    hook_event_name: "UserPromptSubmit",
  });
  const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /codex_app__create_thread/);
  assert.match(context, /dispatch\.mjs.*accept.*<clientThreadId>.*<projectId>/);
  assert.match(context, /durably records Codex acceptance/);
  assert.match(context, /child task's startup hook will bind/i);
  assert.match(context, /Continue the owner's original prompt immediately/);
  assert.match(context, /do not execute it in this owner task/);
  assert.match(context, /synapse-delivery:v2 job=job-1 delivery=/);
  assert.doesNotMatch(context, /list_threads/);
  assert.doesNotMatch(context, /read_thread/);
  assert.doesNotMatch(context, /wait_threads/);
  assert.doesNotMatch(context, /wait until/i);
});

test("the generated provisional acceptance command persists client identity", async () => {
  const path = await inbox();
  const { primary } = await gitFixture();
  queueMessage(
    { id: "job-1", channelId: "demo", task: "work", projectRoot: primary },
    { path },
  );
  reserveNextMessage(
    { projectRoot: primary, ownerSessionId: "owner-1" },
    { path, createDeliveryId: () => "delivery-1" },
  );
  const { stdout } = await runHook(
    path,
    {},
    {
      arguments_: [
        "accept",
        "job-1",
        "delivery-1",
        "client-1",
        "project-1",
        "local",
      ],
    },
  );
  assert.equal(JSON.parse(stdout).status, "accepted");
  const job = getJob("job-1", { path });
  assert.equal(job.clientThreadId, "client-1");
  assert.equal(job.bindingState, "provisioning");
});

test("a linked child startup hook observes its delegated permanent session ID", async () => {
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
      clientThreadId: "client-1",
      projectId: "project-1",
      hostId: "local",
    },
    { path },
  );

  const transcriptPath = join(directory, "child-rollout.jsonl");
  await writeFile(
    transcriptPath,
    delegatedTaskTranscript({
      sourceThreadId: "owner-1",
      nativePrompt: delivery.nativePrompt,
    }),
  );
  const result = await runHook(
    path,
    childStartInput({ child, transcriptPath }),
    { hookPath: childBindHookPath },
  );
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const job = getJob("job-1", { path });
  assert.equal(job.status, "completed");
  assert.equal(job.channelThreadId, "thread-1");
});

test("child observation can arrive before the owner records client acceptance", async () => {
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
  const transcriptPath = join(directory, "child-rollout.jsonl");
  await writeFile(
    transcriptPath,
    delegatedTaskTranscript({
      sourceThreadId: "owner-1",
      nativePrompt: delivery.nativePrompt,
    }),
  );
  await runHook(path, childStartInput({ child, transcriptPath }), {
    hookPath: childBindHookPath,
  });
  assert.equal(getJob("job-1", { path }).status, "completed");
  assert.equal(
    acceptProvisioning(
      {
        jobId: "job-1",
        deliveryId: "delivery-1",
        clientThreadId: "client-1",
        projectId: "project-1",
      },
      { path },
    ).status,
    "completed",
  );
});

test("the child identity compatibility guard disables self-observation", async () => {
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
  const transcriptPath = join(directory, "child-rollout.jsonl");
  await writeFile(
    transcriptPath,
    delegatedTaskTranscript({
      sourceThreadId: "owner-1",
      nativePrompt: delivery.nativePrompt,
    }),
  );
  await runHook(path, childStartInput({ child, transcriptPath }), {
    env: { SYNAPSE_TRUST_HOOK_SESSION_ID: "0" },
    hookPath: childBindHookPath,
  });
  assert.equal(getJob("job-1", { path }).status, "routing");
});

test("a marker from a different repository cannot bind a child task", async () => {
  const path = await inbox();
  const first = await gitFixture();
  const second = await gitFixture({ worktree: true });
  queueMessage(
    {
      id: "job-1",
      channelId: "demo",
      task: "work",
      projectRoot: first.primary,
    },
    { path },
  );
  const delivery = reserveNextMessage(
    { projectRoot: first.primary, ownerSessionId: "owner-1" },
    { path, createDeliveryId: () => "delivery-1" },
  );
  const transcriptPath = join(second.directory, "child-rollout.jsonl");
  await writeFile(
    transcriptPath,
    delegatedTaskTranscript({
      sourceThreadId: "owner-1",
      nativePrompt: delivery.nativePrompt,
    }),
  );
  await runHook(
    path,
    childStartInput({
      child: second.child,
      transcriptPath,
      sessionId: "thread-evil",
    }),
    { hookPath: childBindHookPath },
  );
  assert.equal(getJob("job-1", { path }).status, "routing");
});

test("a delegated marker from a different owner cannot bind the child", async () => {
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
  const transcriptPath = join(directory, "child-rollout.jsonl");
  await writeFile(
    transcriptPath,
    delegatedTaskTranscript({
      sourceThreadId: "owner-other",
      nativePrompt: delivery.nativePrompt,
    }),
  );
  await runHook(path, childStartInput({ child, transcriptPath }), {
    hookPath: childBindHookPath,
  });
  assert.equal(getJob("job-1", { path }).status, "routing");
});

test("a marker copied into a direct user prompt cannot bind the child", async () => {
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
  const transcriptPath = join(directory, "child-rollout.jsonl");
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
  await runHook(path, childStartInput({ child, transcriptPath }), {
    hookPath: childBindHookPath,
  });
  assert.equal(getJob("job-1", { path }).status, "routing");
});

test("the child startup hook tolerates the transcript creation race", async () => {
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
  const transcriptPath = join(directory, "delayed-child-rollout.jsonl");
  const hook = runHook(path, childStartInput({ child, transcriptPath }), {
    env: { SYNAPSE_CHILD_BIND_TIMEOUT_MS: "1000" },
    hookPath: childBindHookPath,
  });
  await pause(75);
  await writeFile(
    transcriptPath,
    delegatedTaskTranscript({
      sourceThreadId: "owner-1",
      nativePrompt: delivery.nativePrompt,
    }),
  );
  await hook;
  assert.equal(getJob("job-1", { path }).status, "completed");
  assert.equal(getJob("job-1", { path }).channelThreadId, "thread-1");
});

test("an accepted task never injects reconciliation into a later owner prompt", async () => {
  const path = await inbox();
  const { primary } = await gitFixture();
  queueMessage(
    { id: "job-1", channelId: "demo", task: "work", projectRoot: primary },
    { path },
  );
  reserveNextMessage(
    { projectRoot: primary, ownerSessionId: "owner-1" },
    { path, createDeliveryId: () => "delivery-1" },
  );
  acceptProvisioning(
    {
      jobId: "job-1",
      deliveryId: "delivery-1",
      clientThreadId: "client-1",
      projectId: "project-1",
    },
    { path, now: () => 1 },
  );
  const { stdout } = await runHook(path, {
    cwd: primary,
    session_id: "owner-2",
    prompt: "later owner work",
    hook_event_name: "UserPromptSubmit",
  });
  assert.equal(stdout, "");
  assert.equal(getJob("job-1", { path }).status, "accepted");
});

test("an expired retry recognizes only immutable creation evidence", async () => {
  const path = await inbox();
  const { primary } = await gitFixture();
  queueMessage(
    { id: "job-1", channelId: "demo", task: "work", projectRoot: primary },
    { path },
  );
  reserveNextMessage(
    { projectRoot: primary, ownerSessionId: "owner-1" },
    {
      path,
      now: () => 0,
      leaseMs: 1,
      createDeliveryId: () => "delivery-1",
    },
  );

  const { stdout } = await runHook(path, {
    cwd: primary,
    session_id: "owner-1",
    prompt: "retry owner work",
    hook_event_name: "UserPromptSubmit",
  });
  const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /retry after an ambiguous routing attempt/);
  assert.match(context, /list_threads once with limit 50/);
  assert.match(context, /candidate's initial turn/);
  assert.match(context, /functionCallOutput/);
  assert.match(context, /<source_thread_id>.*owner-1/);
  assert.match(context, /payload\.dedupeMarkers/);
  assert.match(context, /Never accept a marker copied into an agent message/);
});

test("malformed hook input is ignored without reserving a message", async () => {
  const path = await inbox();
  const { primary } = await gitFixture();
  queueMessage(
    {
      id: "job-1",
      channelId: "demo",
      task: "leave pending",
      projectRoot: primary,
    },
    { path },
  );

  assert.equal(
    (await runHook(path, "{not-json", { rawInput: true })).stdout,
    "",
  );
  assert.equal(
    (
      await runHook(path, {
        cwd: primary,
        session_id: "not valid",
      })
    ).stdout,
    "",
  );
  assert.equal(getJob("job-1", { path }).status, "pending");
});

test("oversized hook input is ignored without creating an inbox", async () => {
  const path = await inbox();
  const { stdout } = await runHook(path, "x".repeat(1024 * 1024 + 1), {
    rawInput: true,
  });
  assert.equal(stdout, "");
  await assert.rejects(() => access(path), /ENOENT/);
});
