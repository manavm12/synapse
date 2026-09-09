import * as z from "zod/v4";

import {
  decodeCursor,
  encodeCursor,
  getMessageStatusInputSchema,
  getMessageStatusOutputSchema,
  listInboxInputSchema,
  listInboxOutputSchema,
  sendMessageInputSchema,
  sendMessageOutputSchema,
} from "./schemas.mjs";

const annotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export function messagingToolDefinitions() {
  return [
    {
      name: "send_message",
      title: "Send a Synapse message",
      description:
        "Durably send a task to an active Synapse user by public username. The recipient controls local routing; never include local paths, task IDs, credentials, or Git state.",
      inputSchema: sendMessageInputSchema,
      outputSchema: sendMessageOutputSchema,
      annotations,
    },
    {
      name: "get_message_status",
      title: "Get Synapse message status",
      description:
        "Read cloud-to-receiver delivery state for a message in one of your conversations.",
      inputSchema: getMessageStatusInputSchema,
      outputSchema: getMessageStatusOutputSchema,
      annotations: { ...annotations, readOnlyHint: true },
    },
    {
      name: "list_inbox",
      title: "List Synapse inbox",
      description:
        "List the authenticated user's inbound cloud messages and delivery states.",
      inputSchema: listInboxInputSchema,
      outputSchema: listInboxOutputSchema,
      annotations: { ...annotations, readOnlyHint: true },
    },
    {
      name: "begin_receiver_setup",
      title: "Prepare incoming-task approval",
      description:
        "After the user accepts Synapse setup, bind a locally generated credential hash to this signed-in account. Returns a browser approval link; does not enable receiving. Never send the credential, local paths, or Codex task IDs.",
      inputSchema: z
        .object({ credential_hash: z.string().regex(/^[0-9a-f]{64}$/) })
        .strict(),
      outputSchema: z.object({
        pairing_id: z.uuid(),
        verification_url: z.url(),
        expires_at: z.iso.datetime({ offset: true }),
        identity: z.object({
          user_id: z.uuid(),
          project_id: z.uuid(),
          username: z.string(),
          project_alias: z.string(),
        }),
      }),
      annotations,
    },
  ];
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

export function registerMessagingTools(
  server,
  { database, logger, helpers, config },
) {
  const { identityFromContext, result, errorResult, securitySchemes } = helpers;

  server.registerTool(
    "begin_receiver_setup",
    {
      ...messagingToolDefinitions()[3],
      _meta: { securitySchemes },
    },
    async (input, context) => {
      try {
        const identity = identityFromContext(context);
        if (identity.authMethod !== "oauth")
          throw new Error(
            "Sign in to Synapse with OAuth before enabling receiving",
          );
        if (!config?.resourceUrl)
          throw new Error("Receiver setup is unavailable");
        const pairing = await database.createBoundReceiverPairing(
          identity,
          input.credential_hash,
        );
        return result({
          pairing_id: pairing.pairingId,
          verification_url: new URL(
            `/receiver/pairings/${pairing.pairingId}`,
            config.resourceUrl,
          ).href,
          expires_at: iso(pairing.expiresAt),
          identity: {
            user_id: identity.userId,
            project_id: identity.projectId,
            username: identity.username,
            project_alias: identity.projectAlias,
          },
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      ...messagingToolDefinitions()[0],
      _meta: { securitySchemes },
    },
    async (input, context) => {
      const identity = identityFromContext(context);
      try {
        const sent = await database.sendMessage(identity, {
          toUsername: input.to_username,
          message: input.message,
          requestId: input.request_id,
          conversationId: input.conversation_id,
        });
        logger.info("mcp_tool", {
          request_id: context.http?.authInfo?.extra?.requestId ?? null,
          tool: "send_message",
          result: sent.idempotent ? "idempotent" : "success",
        });
        return result({
          message_id: sent.messageId,
          conversation_id: sent.conversationId,
          sequence: sent.sequence,
          recipient: {
            user_id: sent.recipient.userId,
            username: sent.recipient.username,
          },
          status: sent.status,
          idempotent: sent.idempotent,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_message_status",
    {
      ...messagingToolDefinitions()[1],
      _meta: { securitySchemes },
    },
    async (input, context) => {
      try {
        const status = await database.getMessageStatus(
          identityFromContext(context),
          input.message_id,
        );
        if (!status) return errorResult(new Error("message is unavailable"));
        return result({
          message_id: status.messageId,
          conversation_id: status.conversationId,
          sequence: status.sequence,
          status: status.status,
          queued_at: iso(status.queuedAt),
          imported_at: iso(status.importedAt),
          provisioning_at: iso(status.provisioningAt),
          delivered_at: iso(status.deliveredAt),
          needs_attention_at: iso(status.needsAttentionAt),
          failure_reason: status.failureReason,
          receiver_action_needed: status.receiverActionNeeded,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_inbox",
    {
      ...messagingToolDefinitions()[2],
      _meta: { securitySchemes },
    },
    async (input, context) => {
      try {
        const inbox = await database.listInbox(identityFromContext(context), {
          limit: input.limit,
          status: input.status,
          before: decodeCursor(input.cursor),
        });
        return result({
          messages: inbox.messages.map((message) => ({
            message_id: message.messageId,
            conversation_id: message.conversationId,
            sequence: message.sequence,
            sender_id: message.senderId,
            message: message.message,
            content_hash: message.contentHash,
            status: message.status,
            queued_at: iso(message.queuedAt),
          })),
          next_cursor: encodeCursor(inbox.next),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
