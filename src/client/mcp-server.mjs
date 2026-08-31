import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { STATE_PATH } from "./config.mjs";
import { claimTask, completeTask } from "./store.mjs";

function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

const server = new McpServer({ name: "synapse-local", version: "0.1.0" });
const assignment = {
  jobId: process.env.SYNAPSE_JOB_ID,
  channelId: process.env.SYNAPSE_CHANNEL_ID,
  dispatchId: process.env.SYNAPSE_DISPATCH_ID,
};

for (const [name, value] of Object.entries(assignment)) {
  if (!value) {
    throw new Error(`Missing task assignment environment variable: ${name}`);
  }
}

server.registerTool(
  "claim_task",
  {
    description: "Claim this child thread's assigned Synapse task.",
    inputSchema: {},
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async () =>
    jsonResult(
      await claimTask(
        STATE_PATH,
        assignment.jobId,
        assignment.dispatchId,
        assignment.channelId,
      ),
    ),
);

server.registerTool(
  "complete_task",
  {
    description: "Complete this child thread's assigned task with a concise result.",
    inputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ result }) =>
    jsonResult(
      await completeTask(
        STATE_PATH,
        assignment.jobId,
        assignment.dispatchId,
        result,
        assignment.channelId,
      ),
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
