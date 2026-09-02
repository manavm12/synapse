import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { createMemoryFixture } from "./_helpers.mjs";

const hookPath = resolve("plugins/synapse/hooks/compact-memory.mjs");

function runHook({ env, input }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [hookPath], {
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
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(new Error(`hook exited ${code}: ${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test("compact SessionStart injects an immediate memory-save instruction", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const { stdout, stderr } = await runHook({
    env: fixture.env,
    input: {
      session_id: "compact-hook-session",
      cwd: fixture.linkedWorktree,
      hook_event_name: "SessionStart",
      source: "compact",
    },
  });
  assert.equal(stderr, "");
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(
    output.hookSpecificOutput.additionalContext,
    "Synapse memory capture is due for session compact-hook-session (compaction boundary). Before finishing, call the Synapse save_session_memory MCP tool exactly once. Write a concise durable session summary, not a transcript. The markdown must contain these headings: Summary, What changed, Decisions, Still unresolved, Important references. After the tool succeeds, finish the original task normally.",
  );
});

test("compact hook is silent outside compaction and for unregistered projects", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const startup = await runHook({
    env: fixture.env,
    input: {
      session_id: "startup-session",
      cwd: fixture.projectRoot,
      hook_event_name: "SessionStart",
      source: "startup",
    },
  });
  assert.equal(startup.stdout, "");
  const unregistered = await runHook({
    env: fixture.env,
    input: {
      session_id: "unregistered-session",
      cwd: fixture.directory,
      hook_event_name: "SessionStart",
      source: "compact",
    },
  });
  assert.equal(unregistered.stdout, "");
});

test("plugin hook configuration uses only the planned lifecycle events", async () => {
  const hooks = JSON.parse(
    await readFile(resolve("plugins/synapse/hooks/hooks.json"), "utf8"),
  ).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["SessionStart", "Stop", "UserPromptSubmit"]);
  assert.equal(hooks.SessionStart[0].matcher, "^compact$");
  const stop = hooks.Stop[0].hooks[0];
  assert.equal(stop.type, "mcp_tool");
  assert.equal(stop.server, "synapse-memory");
  assert.equal(stop.tool, "memory_checkpoint");
  assert.deepEqual(stop.input, {
    session_id: "${session_id}",
    turn_id: "${turn_id}",
    cwd: "${cwd}",
    stop_hook_active: "${stop_hook_active}",
  });
});
