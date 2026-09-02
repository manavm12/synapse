import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { queueMessage } from "../../plugins/synapse/lib/inbox.mjs";

const hookPath = resolve("plugins/synapse/hooks/dispatch.mjs");

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
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`hook exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

test("the next local project prompt receives native routing context", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "synapse-hook-test-")), "inbox.sqlite");
  queueMessage(
    {
      id: "job-1",
      channelId: "demo",
      task: "create TEST.md",
      projectRoot: process.cwd(),
    },
    { path },
  );
  const stdout = await runHook(
    path,
    JSON.stringify({
      cwd: process.cwd(),
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
