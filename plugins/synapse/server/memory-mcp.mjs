import { createInterface } from "node:readline";

import { checkpointMemory, saveSessionMemory } from "./memory-store.mjs";

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);

const TOOLS = Object.freeze([
  {
    name: "memory_checkpoint",
    description:
      "Record a completed Codex turn and request a durable session-memory save when capture is due.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        turn_id: { type: "string" },
        cwd: { type: "string" },
        stop_hook_active: { type: "boolean", default: false },
      },
      required: ["session_id", "turn_id", "cwd"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: "save_session_memory",
    description:
      "Create or update this Codex session's concise durable Markdown memory after Synapse requests capture.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        markdown: { type: "string" },
      },
      required: ["session_id", "title", "summary", "markdown"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
]);

function textResult(value) {
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

function toolError(error) {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : "Tool call failed",
      },
    ],
    isError: true,
  };
}

function requireArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object");
  }
  return value;
}

function requireString(argumentsObject, name) {
  const value = argumentsObject[name];
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function optionalBoolean(argumentsObject, name, defaultValue) {
  const value = argumentsObject[name];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function callCheckpoint(argumentsObject) {
  const input = requireArguments(argumentsObject);
  const checkpoint = {
    sessionId: requireString(input, "session_id"),
    turnId: requireString(input, "turn_id"),
    cwd: requireString(input, "cwd"),
    stopHookActive: optionalBoolean(input, "stop_hook_active", false),
  };
  try {
    return checkpointResult(checkpointMemory(checkpoint));
  } catch {
    return checkpointResult({
      registered: false,
      due: false,
      unavailable: true,
    });
  }
}

async function callSave(argumentsObject) {
  try {
    const input = requireArguments(argumentsObject);
    return textResult(
      await saveSessionMemory({
        sessionId: requireString(input, "session_id"),
        title: requireString(input, "title"),
        summary: requireString(input, "summary"),
        markdown: requireString(input, "markdown"),
      }),
    );
  } catch (error) {
    return toolError(error);
  }
}

async function callTool(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return toolError(new Error("tools/call params must be an object"));
  }
  if (params.name === "memory_checkpoint") {
    try {
      return callCheckpoint(params.arguments);
    } catch (error) {
      return toolError(error);
    }
  }
  if (params.name === "save_session_memory") {
    return callSave(params.arguments);
  }
  throw Object.assign(new Error(`Unknown tool: ${String(params.name)}`), {
    code: -32602,
  });
}

function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function failure(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleRequest(message) {
  const id = message.id;
  switch (message.method) {
    case "initialize": {
      const requestedVersion = message.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : LATEST_PROTOCOL_VERSION;
      return success(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "synapse-memory", version: "0.2.0" },
      });
    }
    case "ping":
      return success(id, {});
    case "tools/list":
      return success(id, { tools: TOOLS });
    case "tools/call":
      try {
        return success(id, await callTool(message.params));
      } catch (error) {
        return failure(id, error.code ?? -32603, error.message ?? "Tool call failed");
      }
    default:
      return failure(id, -32601, `Method not found: ${message.method}`);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (line.trim() === "") {
    continue;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage(failure(null, -32700, "Parse error"));
    continue;
  }
  if (
    !message ||
    typeof message !== "object" ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  ) {
    if (Object.hasOwn(message ?? {}, "id")) {
      writeMessage(failure(message.id ?? null, -32600, "Invalid Request"));
    }
    continue;
  }
  if (!Object.hasOwn(message, "id")) {
    continue;
  }
  writeMessage(await handleRequest(message));
}
