import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { createMemoryFixture } from "./_helpers.mjs";

function runHook(path, { env, input }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(path)], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`hook exited ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test("Stop schedules at the configured interval and the next prompt injects the save privately", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const hook = "plugins/synapse/hooks/checkpoint-memory.mjs";
  for (let turn = 1; turn <= 3; turn += 1) {
    const response = await runHook(hook, {
      env: fixture.env,
      input: {
        session_id: "hook-session",
        turn_id: `turn-${turn}`,
        cwd: fixture.projectRoot,
        stop_hook_active: false,
      },
    });
    assert.equal(response.stdout, "");
  }
  const prompt = await runHook("plugins/synapse/hooks/prompt-memory.mjs", {
    env: fixture.env,
    input: {
      session_id: "hook-session",
      cwd: fixture.projectRoot,
      hook_event_name: "UserPromptSubmit",
    },
  });
  const output = JSON.parse(prompt.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "UserPromptSubmit");
  assert.match(output.additionalContext, /save_session_memory/);
  assert.match(
    output.additionalContext,
    /capture_id=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
  );
  assert.match(output.additionalContext, /Do not mention the checkpoint/);
  const consumed = await runHook("plugins/synapse/hooks/prompt-memory.mjs", {
    env: fixture.env,
    input: {
      session_id: "hook-session",
      cwd: fixture.projectRoot,
      hook_event_name: "UserPromptSubmit",
    },
  });
  assert.equal(consumed.stdout, "");
});

test("compact SessionStart injects an immediate cloud-memory instruction", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const { stdout, stderr } = await runHook(
    "plugins/synapse/hooks/compact-memory.mjs",
    {
      env: fixture.env,
      input: {
        session_id: "compact-hook-session",
        cwd: fixture.linkedWorktree,
        hook_event_name: "SessionStart",
        source: "compact",
      },
    },
  );
  assert.equal(stderr, "");
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /capture_reason=compaction/,
  );
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /project_alias=fixture/,
  );
  assert.match(output.hookSpecificOutput.additionalContext, /do not retry/);
});

test("hook configuration uses local commands for scheduling only", async () => {
  const hooks = JSON.parse(
    await readFile(resolve("plugins/synapse/hooks/hooks.json"), "utf8"),
  ).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), [
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ]);
  assert.deepEqual(hooks.SessionStart.map((entry) => entry.matcher).sort(), [
    "^compact$",
    "^startup$",
  ]);
  const stop = hooks.Stop[0].hooks[0];
  assert.equal(stop.type, "command");
  assert.match(stop.command, /checkpoint-memory\.mjs$/);
  assert.equal(JSON.stringify(stop).includes("mcp_tool"), false);
  const prompt = hooks.UserPromptSubmit[0].hooks[1];
  assert.equal(prompt.type, "command");
  assert.match(prompt.command, /prompt-memory\.mjs$/);
  assert.notEqual(prompt.async, true);
});
