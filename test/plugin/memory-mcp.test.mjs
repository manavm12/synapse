import assert from "node:assert/strict";
import { cp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createMemoryFixture, VALID_MEMORY_MARKDOWN } from "./_helpers.mjs";

const pluginRoot = resolve("plugins/synapse");

test("the bundled cache-local MCP exposes and executes exactly two memory tools", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const cachedPlugin = join(fixture.directory, "plugin-cache", "synapse", "local");
  await cp(pluginRoot, cachedPlugin, { recursive: true });
  const mcpConfig = JSON.parse(
    await readFile(join(cachedPlugin, ".mcp.json"), "utf8"),
  ).mcpServers["synapse-memory"];
  const transport = new StdioClientTransport({
    command: mcpConfig.command,
    args: mcpConfig.args,
    cwd: cachedPlugin,
    env: { ...process.env, ...fixture.env },
    stderr: "pipe",
  });
  const client = new Client({ name: "synapse-memory-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["memory_checkpoint", "save_session_memory"],
    );

    let checkpoint;
    for (let turn = 1; turn <= 15; turn += 1) {
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
      if (turn < 15) {
        assert.deepEqual(hookOutput, {});
      }
    }
    assert.equal(checkpoint.structuredContent.decision, "block");
    assert.match(checkpoint.structuredContent.reason, /15 completed turns/);
    assert.deepEqual(JSON.parse(checkpoint.content[0].text), {
      decision: "block",
      reason: checkpoint.structuredContent.reason,
    });

    const saved = await client.callTool({
      name: "save_session_memory",
      arguments: {
        session_id: "mcp-session",
        title: "MCP integration",
        summary: "The bundled server saved this memory.",
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
  const transport = new StdioClientTransport({
    command: mcpConfig.command,
    args: mcpConfig.args,
    cwd: cachedPlugin,
    env: {
      ...process.env,
      ...fixture.env,
      SYNAPSE_MEMORY_DB: fixture.directory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "synapse-fail-open-test", version: "1.0.0" });

  try {
    await client.connect(transport);
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
