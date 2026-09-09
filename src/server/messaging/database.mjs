import { createHash } from "node:crypto";

import { messagingError } from "./errors.mjs";

function credentialHash(credential) {
  return createHash("sha256").update(credential, "utf8").digest();
}

function claimHash(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function identity(row) {
  return {
    installationId: row.installation_id,
    userId: row.user_id,
    username: row.username,
    projectId: row.project_id,
    projectAlias: row.project_alias,
    expiresAt: row.expires_at ?? row.receiver_expires_at,
    enabled: row.enabled ?? true,
  };
}

function date(value) {
  return value ? new Date(value) : null;
}

export function createMessagingDatabase(pool, withUser) {
  async function translated(operation) {
    try {
      return await operation();
    } catch (error) {
      throw messagingError(error);
    }
  }

  return {
    async sendMessage(sender, input) {
      return translated(() =>
        withUser(sender.userId, async (client) => {
          const result = await client.query(
            `select * from synapse_private.enqueue_message($1, $2, $3, $4)`,
            [
              input.toUsername,
              input.message,
              input.requestId,
              input.conversationId ?? null,
            ],
          );
          const row = result.rows[0];
          return {
            messageId: row.message_id,
            conversationId: row.conversation_id,
            sequence: Number(row.message_sequence),
            recipient: {
              userId: row.recipient_user_id,
              username: row.recipient_username,
            },
            status: row.public_status,
            idempotent: row.was_idempotent,
            queuedAt: date(row.queued_at),
          };
        }),
      );
    },

    async getMessageStatus(user, messageId) {
      return translated(() =>
        withUser(user.userId, async (client) => {
          const result = await client.query(
            `select id, conversation_id, sequence, status::text,
                    queued_at, imported_at, provisioning_at, delivered_at,
                    needs_attention_at, safe_error_code,
                    (status in ('queued', 'needs_attention')) as receiver_action_needed
             from public.message_jobs where id = $1`,
            [messageId],
          );
          if (result.rowCount !== 1) return null;
          const row = result.rows[0];
          return {
            messageId: row.id,
            conversationId: row.conversation_id,
            sequence: Number(row.sequence),
            status: row.status,
            queuedAt: date(row.queued_at),
            importedAt: date(row.imported_at),
            provisioningAt: date(row.provisioning_at),
            deliveredAt: date(row.delivered_at),
            needsAttentionAt: date(row.needs_attention_at),
            failureReason: row.safe_error_code,
            receiverActionNeeded: row.receiver_action_needed,
          };
        }),
      );
    },

    async listInbox(user, { limit, status, before }) {
      return translated(() =>
        withUser(user.userId, async (client) => {
          const values = [user.userId, limit + 1];
          const filters = ["recipient_id = $1"];
          if (status) {
            values.push(status);
            filters.push(
              `status = $${values.length}::public.message_public_status`,
            );
          }
          if (before) {
            values.push(before.queuedAt, before.messageId);
            filters.push(
              `(queued_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
            );
          }
          const result = await client.query(
            `select id, conversation_id, sequence, sender_id, message,
                    content_hash, status::text, queued_at
             from public.message_jobs
             where ${filters.join(" and ")}
             order by queued_at desc, id desc limit $2`,
            values,
          );
          const hasMore = result.rows.length > limit;
          const rows = result.rows.slice(0, limit);
          return {
            messages: rows.map((row) => ({
              messageId: row.id,
              conversationId: row.conversation_id,
              sequence: Number(row.sequence),
              senderId: row.sender_id,
              message: row.message,
              contentHash: row.content_hash,
              status: row.status,
              queuedAt: date(row.queued_at),
            })),
            next:
              hasMore && rows.length
                ? {
                    queuedAt: rows.at(-1).queued_at,
                    messageId: rows.at(-1).id,
                  }
                : null,
          };
        }),
      );
    },

    async createReceiverPairing(hashHex, requesterHash) {
      return translated(async () => {
        const result = await pool.query(
          `select * from synapse_private.create_receiver_pairing($1, $2)`,
          [Buffer.from(hashHex, "hex"), requesterHash],
        );
        return {
          pairingId: result.rows[0].pairing_id,
          expiresAt: date(result.rows[0].expires_at),
        };
      });
    },

    async createBoundReceiverPairing(user, hashHex) {
      return translated(() =>
        withUser(user.userId, async (client) => {
          const result = await client.query(
            "select * from synapse_private.create_bound_receiver_pairing($1)",
            [Buffer.from(hashHex, "hex")],
          );
          return {
            pairingId: result.rows[0].pairing_id,
            expiresAt: date(result.rows[0].expires_at),
          };
        }),
      );
    },

    async approveReceiverPairing(userId, pairingId) {
      return translated(() =>
        withUser(userId, async (client) => {
          const result = await client.query(
            `select * from synapse_private.approve_receiver_pairing($1)`,
            [pairingId],
          );
          return identity(result.rows[0]);
        }),
      );
    },

    async completeReceiverPairing(credential, pairingId) {
      return translated(async () => {
        const result = await pool.query(
          `select * from synapse_private.complete_receiver_pairing($1, $2)`,
          [pairingId, credentialHash(credential)],
        );
        const row = result.rows[0];
        return row.pairing_status === "pending"
          ? { status: "pending" }
          : { status: "connected", identity: identity(row) };
      });
    },

    async getReceiverIdentity(credential) {
      return translated(async () => {
        const result = await pool.query(
          `select * from synapse_private.receiver_identity($1)`,
          [credentialHash(credential)],
        );
        return result.rowCount === 1 ? identity(result.rows[0]) : null;
      });
    },

    async claimReceiverMessages(credential, limit) {
      return translated(async () => {
        const result = await pool.query(
          `select * from synapse_private.claim_receiver_messages($1, $2)`,
          [credentialHash(credential), limit],
        );
        const receiver = result.rows[0] ? identity(result.rows[0]) : null;
        return {
          identity: receiver,
          messages: result.rows.map((row) => ({
            version: 1,
            messageId: row.message_id,
            conversationId: row.conversation_id,
            sequence: Number(row.message_sequence),
            sender: { userId: row.sender_id, username: row.sender_username },
            recipient: { userId: row.user_id, projectId: row.project_id },
            message: row.message,
            contentHash: row.content_hash,
            claimToken: row.claim_token,
            leaseExpiresAt: date(row.lease_expires_at),
          })),
        };
      });
    },

    async importReceiverMessage(credential, { messageId, claimToken }) {
      return translated(async () => {
        const result = await pool.query(
          `select * from synapse_private.import_receiver_message($1, $2, $3)`,
          [credentialHash(credential), messageId, claimHash(claimToken)],
        );
        return {
          messageId: result.rows[0].message_id,
          status: result.rows[0].public_status,
        };
      });
    },

    async getReceiverMessage(credential, messageId) {
      return translated(async () => {
        const result = await pool.query(
          `select * from synapse_private.get_receiver_message($1, $2)`,
          [credentialHash(credential), messageId],
        );
        if (result.rowCount !== 1) return null;
        return {
          messageId: result.rows[0].message_id,
          status: result.rows[0].public_status,
          imported: result.rows[0].imported,
        };
      });
    },

    async recordReceiverEvents(credential, events) {
      return translated(async () => {
        const payload = events.map((event) => ({
          event_id: event.eventId,
          message_id: event.messageId,
          kind: event.kind,
          occurred_at: event.occurredAt,
          ...(event.errorCode ? { error_code: event.errorCode } : {}),
        }));
        const result = await pool.query(
          `select * from synapse_private.record_receiver_events($1, $2::jsonb)`,
          [credentialHash(credential), JSON.stringify(payload)],
        );
        return result.rows.map((row) => row.accepted_event_id);
      });
    },

    async disconnectReceiver(credential) {
      return translated(async () => {
        const result = await pool.query(
          `select synapse_private.disconnect_receiver($1) as disconnected`,
          [credentialHash(credential)],
        );
        return result.rows[0].disconnected;
      });
    },
  };
}
