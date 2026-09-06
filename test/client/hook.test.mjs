import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { getJob, queueMessage } from "../../plugins/synapse/lib/inbox.mjs";

const hookPath = resolve("plugins/synapse/hooks/dispatch.mjs");
const execFileAsync = promisify(execFile);

async function primaryGitCheckout() {
  const path = await mkdtemp(join(tmpdir(), "synapse-project-test-"));
  await execFileAsync("git", ["init", "--quiet", path]);
  return realpath(path);
}

function runHook(path, input, arguments_ = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [hookPath, ...arguments_], {
      env: { ...process.env, SYNAPSE_INBOX_PATH: path },
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
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`hook exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

test("the next local project prompt receives native routing context", async () => {
  const projectRoot = await primaryGitCheckout();
  const path = join(
    await mkdtemp(join(tmpdir(), "synapse-hook-test-")),
    "inbox.sqlite",
  );
  queueMessage(
    {
      id: "job-1",
      channelId: "demo",
      task: "create TEST.md",
      projectRoot,
    },
    { path },
  );
  const stdout = await runHook(
    path,
    JSON.stringify({
      cwd: projectRoot,
      session_id: "owner-1",
      hook_event_name: "UserPromptSubmit",
    }),
  );
  const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /codex_app__create_thread/);
  assert.match(context, /codex_app__send_message_to_thread/);
  assert.match(context, /codex_app__read_thread/);
  assert.match(context, /create TEST\.md/);
  assert.match(context, /synapse-delivery:job-1/);
  assert.match(context, /marker already exists.*do not create or send again/);
  assert.match(context, /do not execute it in this owner task/);
});

test("malformed hook input is ignored without reserving a message", async () => {
  const path = join(
    await mkdtemp(join(tmpdir(), "synapse-hook-test-")),
    "inbox.sqlite",
  );
  queueMessage(
    {
      id: "job-1",
      channelId: "demo",
      task: "leave pending",
      projectRoot: process.cwd(),
    },
    { path },
  );

  assert.equal(await runHook(path, "{not-json"), "");
  assert.equal(
    await runHook(
      path,
      JSON.stringify({ cwd: process.cwd(), session_id: "not valid" }),
    ),
    "",
  );
  assert.equal(getJob("job-1", { path }).status, "pending");
});

test("oversized hook input is ignored without creating an inbox", async () => {
  const path = join(
    await mkdtemp(join(tmpdir(), "synapse-hook-test-")),
    "inbox.sqlite",
  );
  const stdout = await runHook(path, "x".repeat(1024 * 1024 + 1));
  assert.equal(stdout, "");
  await assert.rejects(() => access(path), /ENOENT/);
});
