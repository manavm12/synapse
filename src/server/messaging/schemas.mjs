import * as z from "zod/v4";

export const dispositionSchema = z.enum(["continue", "complete", "needs_user"]);

export const publicStatusSchema = z.enum([
  "queued",
  "in_receiver_inbox",
  "provisioning",
  "delivered",
  "needs_attention",
]);

export const sendMessageInputSchema = z
  .object({
    to_username: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(33)
      .regex(/^@?[a-z][a-z0-9_-]{2,31}$/),
    message: z.string().refine(
      (value) => {
        const bytes = Buffer.byteLength(value, "utf8");
        return bytes >= 1 && bytes <= 61_440;
      },
      { message: "message must be between 1 byte and 60 KiB" },
    ),
    request_id: z.uuid(),
    conversation_id: z.uuid().optional(),
    disposition: dispositionSchema.default("continue"),
  })
  .strict();

export const sendMessageOutputSchema = z.object({
  message_id: z.uuid(),
  conversation_id: z.uuid(),
  sequence: z.number().int().positive(),
  recipient: z.object({ user_id: z.uuid(), username: z.string() }),
  sender: z.object({
    user_id: z.uuid(),
    username: z.string(),
    project_id: z.uuid(),
  }),
  disposition: dispositionSchema,
  in_reply_to_message_id: z.uuid().nullable(),
  status: publicStatusSchema,
  idempotent: z.boolean(),
});

export const getMessageStatusInputSchema = z
  .object({ message_id: z.uuid() })
  .strict();

export const getMessageStatusOutputSchema = z.object({
  message_id: z.uuid(),
  conversation_id: z.uuid(),
  sequence: z.number().int().positive(),
  status: publicStatusSchema,
  queued_at: z.string(),
  imported_at: z.string().nullable(),
  provisioning_at: z.string().nullable(),
  delivered_at: z.string().nullable(),
  needs_attention_at: z.string().nullable(),
  failure_reason: z.string().nullable(),
  receiver_action_needed: z.boolean(),
  response_state: z.enum([
    "awaiting_reply",
    "replied",
    "complete",
    "needs_user",
    "needs_attention",
  ]),
});

export const replyMessageInputSchema = z
  .object({
    message_id: z.uuid(),
    message: sendMessageInputSchema.shape.message,
    request_id: z.uuid(),
    disposition: dispositionSchema,
  })
  .strict();

export const listConversationsInputSchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const getConversationInputSchema = z
  .object({
    conversation_id: z.uuid(),
    after_sequence: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

const participantSchema = z.object({ user_id: z.uuid(), username: z.string() });
export const listConversationsOutputSchema = z.object({
  conversations: z.array(
    z.object({
      conversation_id: z.uuid(),
      participants: z.array(participantSchema),
      preview: z.string(),
      updated_at: z.string(),
      disposition: dispositionSchema,
      outstanding_replies: z.number().int().nonnegative(),
      activity_state: z.enum([
        "awaiting_reply",
        "complete",
        "needs_user",
        "needs_attention",
      ]),
    }),
  ),
  next_cursor: z.string().nullable(),
});

export const getConversationOutputSchema = z.object({
  conversation_id: z.uuid(),
  participants: z.array(participantSchema),
  messages: z.array(
    z.object({
      message_id: z.uuid(),
      sequence: z.number().int().positive(),
      sender_id: z.uuid(),
      recipient_id: z.uuid(),
      message: z.string(),
      disposition: dispositionSchema,
      in_reply_to_message_id: z.uuid().nullable(),
      status: publicStatusSchema,
      queued_at: z.string(),
      response_state: getMessageStatusOutputSchema.shape.response_state,
    }),
  ),
  next_sequence: z.number().int().positive().nullable(),
});

export const listInboxInputSchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    status: publicStatusSchema.optional(),
  })
  .strict();

const inboxMessageSchema = z.object({
  message_id: z.uuid(),
  conversation_id: z.uuid(),
  sequence: z.number().int().positive(),
  sender_id: z.uuid(),
  message: z.string(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  status: publicStatusSchema,
  queued_at: z.string(),
});

export const listInboxOutputSchema = z.object({
  messages: z.array(inboxMessageSchema),
  next_cursor: z.string().nullable(),
});

export function encodeCursor(cursor) {
  if (!cursor) return null;
  return Buffer.from(
    JSON.stringify({
      q: new Date(cursor.queuedAt).toISOString(),
      m: cursor.messageId,
    }),
  ).toString("base64url");
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value.q !== "string" ||
      Number.isNaN(Date.parse(value.q)) ||
      !z.uuid().safeParse(value.m).success
    ) {
      throw new Error();
    }
    return { queuedAt: value.q, messageId: value.m };
  } catch {
    throw new Error("cursor is invalid");
  }
}
