import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { STATE_PATH } from "./config.mjs";
import { claimTask, completeTask, getPublicInbox } from "./store.mjs";

function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

const server = new McpServer({ name: "synapse-local", version: "0.1.0" });

server.registerTool(
  "check_inbox",
  {
    description: "List pending Synapse jobs. Returns metadata only, never task contents.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => jsonResult({ jobs: await getPublicInbox(STATE_PATH) }),
);

server.registerTool(
  "claim_task",
  {
    description: "Claim a Synapse job and retrieve its hidden task contents.",
    inputSchema: { job_id: z.string(), dispatch_id: z.string() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ job_id, dispatch_id }) =>
    jsonResult(await claimTask(STATE_PATH, job_id, dispatch_id)),
);

server.registerTool(
  "complete_task",
  {
    description: "Mark a claimed Synapse job completed with a concise result.",
    inputSchema: { job_id: z.string(), dispatch_id: z.string(), result: z.string() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ job_id, dispatch_id, result }) =>
    jsonResult(await completeTask(STATE_PATH, job_id, dispatch_id, result)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
