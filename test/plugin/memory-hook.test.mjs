import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  checkpointMemory,
  saveSessionMemory,
} from "../../plugins/synapse/server/memory-store.mjs";
import { createMemoryFixture, VALID_MEMORY_MARKDOWN } from "./_helpers.mjs";

const pluginRoot = resolve(
  process.env.SYNAPSE_PLUGIN_ROOT ?? "plugins/synapse",
);
const compactHookPath = resolve(pluginRoot, "hooks/compact-memory.mjs");
const promptMemoryHookPath = resolve(pluginRoot, "hooks/prompt-memory.mjs");

function runHook({ env, input, hookPath = compactHookPath }) {
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

test("the prompt hook injects pending memory privately on the next user prompt", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  for (let turn = 1; turn <= 2; turn += 1) {
    checkpointMemory(
      {
        sessionId: "prompt-hook-session",
        turnId: `turn-${turn}`,
        cwd: fixture.projectRoot,
      },
      { env: fixture.env },
    );
  }
  const beforeDue = await runHook({
    hookPath: promptMemoryHookPath,
    env: fixture.env,
    input: {
      session_id: "prompt-hook-session",
      cwd: fixture.projectRoot,
      hook_event_name: "UserPromptSubmit",
    },
  });
  assert.equal(beforeDue.stdout, "");

  const due = checkpointMemory(
    {
      sessionId: "prompt-hook-session",
      turnId: "turn-3",
      cwd: fixture.projectRoot,
    },
    { env: fixture.env },
  );
  assert.equal(due.due, true);
  assert.equal("decision" in due, false);

  const pending = await runHook({
    hookPath: promptMemoryHookPath,
    env: fixture.env,
    input: {
      session_id: "prompt-hook-session",
      cwd: fixture.linkedWorktree,
      hook_event_name: "UserPromptSubmit",
    },
  });
  assert.equal(pending.stderr, "");
  const output = JSON.parse(pending.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(
    output.hookSpecificOutput.additionalContext,
    "A Synapse memory checkpoint is pending for session prompt-hook-session (3 completed turns). Before answering the user's current request, call the Synapse save_session_memory MCP tool exactly once. Write a concise durable session summary, not a transcript. The markdown must contain these headings: Summary, What changed, Decisions, Still unresolved, Important references. Do not announce the checkpoint unless saving fails. After the tool succeeds, answer the user's current request normally.",
  );

  await assert.rejects(
    saveSessionMemory(
      {
        sessionId: "prompt-hook-session",
        title: "Invalid prompt hook save",
        summary: "This save must fail without clearing the checkpoint.",
        markdown: "## Summary\nMissing required sections.",
      },
      { env: fixture.env },
    ),
    /missing required headings/,
  );
  const retry = await runHook({
    hookPath: promptMemoryHookPath,
    env: fixture.env,
    input: {
      session_id: "prompt-hook-session",
      cwd: fixture.projectRoot,
      hook_event_name: "UserPromptSubmit",
    },
  });
  assert.equal(
    JSON.parse(retry.stdout).hookSpecificOutput.additionalContext,
    output.hookSpecificOutput.additionalContext,
  );

  await saveSessionMemory(
    {
      sessionId: "prompt-hook-session",
      title: "Prompt hook",
      summary: "The pending checkpoint was saved.",
      markdown: VALID_MEMORY_MARKDOWN,
    },
    { env: fixture.env },
  );
  const afterSave = await runHook({
    hookPath: promptMemoryHookPath,
    env: fixture.env,
    input: {
      session_id: "prompt-hook-session",
      cwd: fixture.projectRoot,
      hook_event_name: "UserPromptSubmit",
    },
  });
  assert.equal(afterSave.stdout, "");
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
    await readFile(resolve(pluginRoot, "hooks/hooks.json"), "utf8"),
  ).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), [
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ]);
  assert.equal(hooks.SessionStart[0].matcher, "^compact$");
  const stop = hooks.Stop[0].hooks[0];
  assert.equal(stop.type, "mcp_tool");
  assert.equal(stop.server, "synapse-memory");
  assert.equal(stop.tool, "memory_checkpoint");
  assert.deepEqual(stop.input, {
    session_id: `\${session_id}`,
    turn_id: `\${turn_id}`,
    cwd: `\${cwd}`,
    stop_hook_active: `\${stop_hook_active}`,
  });
  const promptMemory = hooks.UserPromptSubmit[0].hooks[1];
  assert.equal(promptMemory.type, "command");
  assert.equal(
    promptMemory.command,
    `node \${PLUGIN_ROOT}/hooks/prompt-memory.mjs`,
  );
});
