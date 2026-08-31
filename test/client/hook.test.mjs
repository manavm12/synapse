import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { addJob, readState } from "../../src/client/store.mjs";

const hookPath = resolve("src/client/hook.mjs");
const pluginHookPath = resolve("plugins/synapse/hooks/dispatch.mjs");

function runHook({ env, input, path = hookPath }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [path], {
      env,
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
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(new Error(`hook exited ${code}: ${stderr}`));
      }
    });
    child.stdin.end(input);
  });
}

test("the hook asks the owner to route the exact task through native Codex tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-hook-test-"));
  const statePath = join(directory, "state.json");
  await addJob(statePath, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "write the proof file",
    projectRoot: "/tmp/example-project",
  });

  const { stdout } = await runHook({
    env: {
      ...process.env,
      SYNAPSE_STATE_PATH: statePath,
      SYNAPSE_PROJECT_ROOT: "/tmp/example-project",
    },
    input: JSON.stringify({
      session_id: "owner-thread",
      cwd: "/tmp/example-project",
      hook_event_name: "UserPromptSubmit",
      prompt: "check inbox",
    }),
  });

  const output = JSON.parse(stdout);
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /codex_app__create_thread/);
  assert.match(context, /codex_app__send_message_to_thread/);
  assert.match(context, /write the proof file/);
  assert.match(context, /prompt exactly equal to payload\.task/);
  assert.equal((await readState(statePath)).jobs[0].status, "routing");
});

test("the project hook runs only from the main checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-plugin-hook-test-"));
  const statePath = join(directory, "state.json");
  await addJob(statePath, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "route me",
    projectRoot: resolve("."),
  });

  const { stdout } = await runHook({
    path: pluginHookPath,
    env: { ...process.env, SYNAPSE_STATE_PATH: statePath },
    input: JSON.stringify({
      session_id: "owner-thread",
      cwd: resolve("."),
      hook_event_name: "UserPromptSubmit",
      prompt: "check inbox",
    }),
  });

  assert.match(stdout, /route me/);
  assert.equal((await readState(statePath)).jobs[0].status, "routing");
});
