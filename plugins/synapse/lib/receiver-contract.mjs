import { createHash } from "node:crypto";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MAX_MESSAGE_BYTES = 60 * 1024;

function requiredString(value, label, { max = 4096 } = {}) {
  if (typeof value !== "string" || !value || value.length > max) {
    throw new Error(`Invalid receiver ${label}`);
  }
  return value;
}

function requiredUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`Invalid receiver ${label}`);
  }
  return value.toLowerCase();
}

export function credentialHash(credential) {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

export function messageContentHash(message) {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

export function validateReceiverIdentity(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Invalid receiver identity");
  }
  if (value.enabled !== true) throw new Error("Receiver is not enabled");
  const expiresAt = requiredString(value.expires_at, "identity expiry", {
    max: 64,
  });
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("Invalid receiver identity expiry");
  }
  return {
    installationId: requiredUuid(value.installation_id, "installation ID"),
    userId: requiredUuid(value.user_id, "user ID"),
    username: requiredString(value.username, "username", { max: 128 }),
    projectId: requiredUuid(value.project_id, "project ID"),
    projectAlias: requiredString(value.project_alias, "project alias", {
      max: 128,
    }),
    expiresAt,
    enabled: true,
  };
}

export function validateCloudMessage(value, identity) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    value.version !== 1
  ) {
    throw new Error("Invalid cloud message version");
  }
  const message = requiredString(value.message, "message", {
    max: MAX_MESSAGE_BYTES,
  });
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error(`Cloud message exceeds ${MAX_MESSAGE_BYTES} UTF-8 bytes`);
  }
  const contentHash = requiredString(value.content_hash, "content hash", {
    max: 64,
  });
  if (!HASH.test(contentHash) || messageContentHash(message) !== contentHash) {
    throw new Error("Cloud message content hash mismatch");
  }
  const sequence = value.sequence;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Invalid cloud message sequence");
  }
  const recipientUserId = requiredUuid(
    value.recipient?.user_id,
    "recipient user ID",
  );
  const recipientProjectId = requiredUuid(
    value.recipient?.project_id,
    "recipient project ID",
  );
  if (
    recipientUserId !== identity.userId ||
    recipientProjectId !== identity.projectId
  ) {
    throw new Error(
      "Cloud message recipient does not match the receiver identity",
    );
  }
  return {
    version: 1,
    messageId: requiredUuid(value.message_id, "message ID"),
    conversationId: requiredUuid(value.conversation_id, "conversation ID"),
    sequence,
    senderUserId: requiredUuid(value.sender?.user_id, "sender user ID"),
    senderUsername: requiredString(value.sender?.username, "sender username", {
      max: 128,
    }),
    recipientUserId,
    recipientProjectId,
    message,
    contentHash,
    claimToken: requiredString(value.claim_token, "claim token", { max: 512 }),
    leaseExpiresAt: requiredString(value.lease_expires_at, "lease expiry", {
      max: 64,
    }),
  };
}

export function cloudChannelId(
  receiverInstallationId,
  recipientUserId,
  conversationId,
) {
  const value = `cloud:${receiverInstallationId}:${recipientUserId}:${conversationId}`;
  if (value.length > 128)
    throw new Error("Derived cloud channel ID is too long");
  return value;
}
