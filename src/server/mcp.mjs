import { randomUUID } from "node:crypto";

import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { MemoryConflictError } from "./database.mjs";
import { privateIdentifier } from "./logger.mjs";

export const REQUIRED_MEMORY_SECTIONS = Object.freeze([
  "Summary",
  "What changed",
  "Decisions",
  "Still unresolved",
  "Important references",
]);
export const OAUTH_SECURITY_SCHEMES = Object.freeze([
  { type: "oauth2", scopes: ["openid", "email", "profile"] },
]);

function hasRequiredHeadings(markdown) {
  return REQUIRED_MEMORY_SECTIONS.every((section) => {
    const escaped = section.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    return new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, "im").test(markdown);
  });
}

export const saveMemoryInputSchema = z
  .object({
    capture_id: z.uuid(),
    session_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:-]+$/),
    project_alias: z
      .string()
      .trim()
      .min(2)
      .max(63)
      .regex(/^[a-z][a-z0-9_-]+$/),
    capture_reason: z.enum(["turn_checkpoint", "compaction", "manual"]),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(2000),
    markdown: z
      .string()
      .trim()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 65_536, {
        message: "markdown must be at most 64 KiB",
      })
      .refine(hasRequiredHeadings, {
        message:
          "markdown must contain headings: " +
          REQUIRED_MEMORY_SECTIONS.join(", "),
      }),
  })
  .strict();

const identityOutputSchema = z.object({
  principal_type: z.literal("user"),
  user_id: z.uuid(),
  username: z.string(),
  project_id: z.uuid(),
  project_alias: z.string(),
  oauth_client_id: z.string(),
  authentication_method: z.string(),
});

const saveOutputSchema = z.object({
  saved: z.literal(true),
  idempotent: z.boolean(),
  node_id: z.uuid(),
  session_id: z.string(),
  revision: z.number().int().positive(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  saved_at: z.string(),
});

function wireSchema(schema) {
  const json = z.toJSONSchema(schema);
  delete json.$schema;
  return json;
}

function identityFromContext(context) {
  const identity = context.http?.authInfo?.extra?.identity;
  if (!identity) throw new Error("Authenticated identity is unavailable");
  return identity;
}

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolDefinitions() {
  const securitySchemes = OAUTH_SECURITY_SCHEMES.map((scheme) => ({
    ...scheme,
  }));
  return [
    {
      name: "get_identity",
      title: "Get Synapse identity",
      description:
        "Verify the authenticated Synapse user and the single project available to this agent session.",
      inputSchema: wireSchema(z.object({}).strict()),
      outputSchema: wireSchema(identityOutputSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      securitySchemes,
      _meta: { securitySchemes },
    },
    {
      name: "save_session_memory",
      title: "Save session memory",
      description:
        "Create or revise one concise, durable session memory with provenance. Never submit a raw transcript or local filesystem path.",
      inputSchema: wireSchema(saveMemoryInputSchema),
      outputSchema: wireSchema(saveOutputSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      securitySchemes,
      _meta: { securitySchemes },
    },
  ];
}

export async function createMcpRuntime({ database, logger }) {
  const server = new McpServer(
    { name: "synapse-memory", version: "0.3.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Synapse stores concise durable memory for the authenticated user. Use get_identity after connecting. Call save_session_memory only at a Synapse checkpoint, include the supplied capture/session/project identifiers, summarize rather than copying transcripts, and never send local paths or credentials.",
    },
  );

  server.registerTool(
    "get_identity",
    {
      title: "Get Synapse identity",
      description:
        "Verify the authenticated Synapse user and the single project available to this agent session.",
      inputSchema: z.object({}).strict(),
      outputSchema: identityOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { securitySchemes: OAUTH_SECURITY_SCHEMES },
    },
    async (_input, context) => {
      const started = performance.now();
      const identity = identityFromContext(context);
      const output = {
        principal_type: "user",
        user_id: identity.userId,
        username: identity.username,
        project_id: identity.projectId,
        project_alias: identity.projectAlias,
        oauth_client_id: identity.oauthClientId,
        authentication_method: identity.authMethod,
      };
      logger.info("mcp_tool", {
        request_id: context.http?.authInfo?.extra?.requestId ?? null,
        tool: "get_identity",
        result: "success",
        latency_ms: Math.round(performance.now() - started),
        user: privateIdentifier(identity.userId),
      });
      return result(output);
    },
  );

  server.registerTool(
    "save_session_memory",
    {
      title: "Save session memory",
      description:
        "Create or revise one concise, durable session memory with provenance. Never submit a raw transcript or local filesystem path.",
      inputSchema: saveMemoryInputSchema,
      outputSchema: saveOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { securitySchemes: OAUTH_SECURITY_SCHEMES },
    },
    async (input, context) => {
      const started = performance.now();
      const identity = identityFromContext(context);
      const requestId =
        context.http?.authInfo?.extra?.requestId ?? randomUUID();
      try {
        const saved = await database.saveSessionMemory(
          identity,
          {
            captureId: input.capture_id,
            sessionId: input.session_id,
            projectAlias: input.project_alias,
            captureReason: input.capture_reason,
            title: input.title,
            summary: input.summary,
            markdown: input.markdown,
          },
          requestId,
        );
        const output = {
          saved: true,
          idempotent: saved.idempotent,
          node_id: saved.nodeId,
          session_id: saved.sessionId,
          revision: saved.revision,
          content_hash: saved.contentHash,
          saved_at: new Date(saved.savedAt).toISOString(),
        };
        logger.info("mcp_tool", {
          request_id: requestId,
          tool: "save_session_memory",
          result: saved.idempotent ? "idempotent" : "success",
          latency_ms: Math.round(performance.now() - started),
          user: privateIdentifier(identity.userId),
          session: privateIdentifier(input.session_id),
        });
        return result(output);
      } catch (error) {
        logger.error("mcp_tool", {
          request_id: requestId,
          tool: "save_session_memory",
          result: error instanceof MemoryConflictError ? "conflict" : "failure",
          latency_ms: Math.round(performance.now() - started),
          user: privateIdentifier(identity.userId),
          session: privateIdentifier(input.session_id),
          error_type: error.name,
        });
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof MemoryConflictError
                  ? error.message
                  : "Synapse could not save this memory",
            },
          ],
          isError: true,
        };
      }
    },
  );

  // MCP core has not adopted the plugin securitySchemes extension yet.
  // Override discovery so OpenAI hosts receive its required top-level field
  // while retaining the SDK's validation and call dispatcher.
  server.server.setRequestHandler("tools/list", async () => ({
    tools: toolDefinitions(),
  }));

  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return { server, transport };
}
