import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  addJob,
  readState,
  reserveNextJob,
} from "../../src/client/store.mjs";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = join(TEST_DIRECTORY, "../../src/client/mcp-server.mjs");

test("the child MCP exposes only its server-bound task assignment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-mcp-test-"));
  const statePath = join(directory, "state.json");
  await addJob(statePath, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "assigned secret",
  });
  await addJob(statePath, {
    id: "job-2",
    channelId: "channel-2",
    sender: "person-b",
    task: "other secret",
  });
  const assigned = await reserveNextJob(statePath, {
    createDispatchId: () => "dispatch-1",
  });
  const other = await reserveNextJob(statePath, {
    createDispatchId: () => "dispatch-2",
  });
  assert.equal(other.jobId, "job-2");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    env: {
      SYNAPSE_STATE_PATH: statePath,
      SYNAPSE_JOB_ID: assigned.jobId,
      SYNAPSE_CHANNEL_ID: assigned.channelId,
      SYNAPSE_DISPATCH_ID: assigned.dispatchId,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "synapse-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["claim_task", "complete_task"],
    );
    assert.deepEqual(tools.tools.find((tool) => tool.name === "claim_task").inputSchema, {
      type: "object",
      properties: {},
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    const claim = await client.callTool({
      name: "claim_task",
      arguments: {
        job_id: other.jobId,
        dispatch_id: other.dispatchId,
      },
    });
    assert.equal(claim.structuredContent.jobId, "job-1");
    assert.equal(claim.structuredContent.task, "assigned secret");
    await client.callTool({
      name: "complete_task",
      arguments: { result: "assigned task completed" },
    });

    const state = await readState(statePath);
    assert.equal(state.jobs[0].status, "completed");
    assert.equal(state.jobs[1].status, "dispatched");
    assert.equal(state.jobs[1].task, "other secret");
  } finally {
    await client.close();
  }
});
