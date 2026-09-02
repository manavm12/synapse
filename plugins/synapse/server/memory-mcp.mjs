import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { checkpointMemory, saveSessionMemory } from "./memory-store.mjs";

function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function checkpointResult(value) {
  const hookOutput =
    value.decision === "block"
      ? { decision: "block", reason: value.reason }
      : {};
  return {
    content: [{ type: "text", text: JSON.stringify(hookOutput) }],
    structuredContent: value,
  };
}

function failOpenCheckpoint(input) {
  try {
    return checkpointResult(checkpointMemory(input));
  } catch {
    return checkpointResult({
      registered: false,
      due: false,
      unavailable: true,
    });
  }
}

const server = new McpServer({ name: "synapse-memory", version: "0.1.0" });

server.registerTool(
  "memory_checkpoint",
  {
    description:
      "Record a completed Codex turn and request a durable session-memory save when capture is due.",
    inputSchema: {
      session_id: z.string(),
      turn_id: z.string(),
      cwd: z.string(),
      stop_hook_active: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ session_id, turn_id, cwd, stop_hook_active }) =>
    failOpenCheckpoint({
      sessionId: session_id,
      turnId: turn_id,
      cwd,
      stopHookActive: stop_hook_active,
    }),
);

server.registerTool(
  "save_session_memory",
  {
    description:
      "Create or update this Codex session's concise durable Markdown memory after Synapse requests capture.",
    inputSchema: {
      session_id: z.string(),
      title: z.string(),
      summary: z.string(),
      markdown: z.string(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ session_id, title, summary, markdown }) =>
    jsonResult(
      await saveSessionMemory({
        sessionId: session_id,
        title,
        summary,
        markdown,
      }),
    ),
);

await server.connect(new StdioServerTransport());
