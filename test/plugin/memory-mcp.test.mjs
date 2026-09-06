import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { createMemoryFixture, VALID_MEMORY_MARKDOWN } from "./_helpers.mjs";

const pluginRoot = resolve(process.env.SYNAPSE_PLUGIN_ROOT ?? "plugins/synapse");

function createStdioClient({ command, args, cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      const error = new Error(`MCP server exited ${code}: ${stderr}`);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      if (code === 0) resolvePromise();
      else reject(error);
    });
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });

  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolvePromise, reject) => {
      pending.set(id, { resolve: resolvePromise, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  return {
    async connect() {
      await request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "synapse-memory-test", version: "1.0.0" },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    ping: () => request("ping"),
    listTools: () => request("tools/list"),
    callTool: (params) => request("tools/call", params),
    async close() {
      child.stdin.end();
      await closed;
    },
  };
}

test("the dependency-free cache-local MCP exposes and executes exactly two memory tools", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const cachedPlugin = join(fixture.directory, "plugin-cache", "synapse", "local");
  await cp(pluginRoot, cachedPlugin, { recursive: true });
  const mcpConfig = JSON.parse(
    await readFile(join(cachedPlugin, ".mcp.json"), "utf8"),
  ).mcpServers["synapse-memory"];
  const client = createStdioClient({
    command: mcpConfig.command,
    args: mcpConfig.args,
    cwd: cachedPlugin,
    env: { ...process.env, ...fixture.env },
  });

  try {
    await client.connect();
    await client.ping();
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["memory_checkpoint", "save_session_memory"],
    );
    assert.deepEqual(
      tools.tools.find((tool) => tool.name === "memory_checkpoint").inputSchema.required,
      ["session_id", "turn_id", "cwd"],
    );

    const invalidSave = await client.callTool({
      name: "save_session_memory",
      arguments: {
        session_id: "mcp-session",
        title: "Invalid",
        summary: "Invalid",
        markdown: "## Summary\nMissing the other required sections.",
      },
    });
    assert.equal(invalidSave.isError, true);
    assert.match(invalidSave.content[0].text, /missing required headings/);

    let checkpoint;
    for (let turn = 1; turn <= 3; turn += 1) {
      checkpoint = await client.callTool({
        name: "memory_checkpoint",
        arguments: {
          session_id: "mcp-session",
          turn_id: `turn-${turn}`,
          cwd: fixture.linkedWorktree,
          stop_hook_active: false,
        },
      });
      const hookOutput = JSON.parse(checkpoint.content[0].text);
      if (turn < 3) {
        assert.deepEqual(hookOutput, {});
      }
    }
    assert.equal(checkpoint.structuredContent.decision, "block");
    assert.match(checkpoint.structuredContent.reason, /3 completed turns/);
    assert.deepEqual(JSON.parse(checkpoint.content[0].text), {
      decision: "block",
      reason: checkpoint.structuredContent.reason,
    });

    const saved = await client.callTool({
      name: "save_session_memory",
      arguments: {
        session_id: "mcp-session",
        title: "MCP integration",
        summary: "The dependency-free server saved this memory.",
        markdown: VALID_MEMORY_MARKDOWN,
      },
    });
    assert.equal(saved.structuredContent.saved, true);
    assert.equal(saved.structuredContent.revision, 1);
    assert.match(await readFile(saved.structuredContent.path, "utf8"), /MCP integration/);
  } finally {
    await client.close();
  }
});

test("memory_checkpoint fails open when SQLite state is unavailable", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const cachedPlugin = join(fixture.directory, "plugin-cache-fail-open", "synapse");
  await cp(pluginRoot, cachedPlugin, { recursive: true });
  const mcpConfig = JSON.parse(
    await readFile(join(cachedPlugin, ".mcp.json"), "utf8"),
  ).mcpServers["synapse-memory"];
  const client = createStdioClient({
    command: mcpConfig.command,
    args: mcpConfig.args,
    cwd: cachedPlugin,
    env: {
      ...process.env,
      ...fixture.env,
      SYNAPSE_MEMORY_DB: fixture.directory,
    },
  });

  try {
    await client.connect();
    const result = await client.callTool({
      name: "memory_checkpoint",
      arguments: {
        session_id: "fail-open-session",
        turn_id: "turn-1",
        cwd: fixture.projectRoot,
        stop_hook_active: false,
      },
    });
    assert.deepEqual(JSON.parse(result.content[0].text), {});
    assert.deepEqual(result.structuredContent, {
      registered: false,
      due: false,
      unavailable: true,
    });
  } finally {
    await client.close();
  }
});
