import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  formatDeliveryMarker,
  formatLegacyDeliveryMarker,
} from "./markers.mjs";

const SAFE_ID = /^[a-zA-Z0-9._:-]{1,128}$/;
const ACTIVE_STATUSES = "'routing', 'accepted', 'uncertain'";
const MAX_TASK_BYTES = 64 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SCHEMA_VERSION = 3;

export function inboxPath(env = process.env) {
  return resolve(
    env.SYNAPSE_INBOX_PATH ?? join(homedir(), ".synapse", "inbox.sqlite"),
  );
}

function requireId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

function requireOptionalId(value, label) {
  if (value !== null && value !== undefined) requireId(value, label);
}

function requireProjectRoot(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("Project root must be an absolute path");
  }
}

function ensureColumn(database, table, name, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function secureFile(path) {
  try {
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function secureDatabaseFiles(path) {
  for (const databasePath of [path, `${path}-wal`, `${path}-shm`]) {
    secureFile(databasePath);
  }
}

function openInbox(path) {
  const directory = dirname(path);
  const directoryExisted = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (!directoryExisted || basename(directory) === ".synapse") {
    chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  }
  const database = new DatabaseSync(path);
  secureFile(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      project_root TEXT NOT NULL,
      thread_id TEXT,
      host_id TEXT,
      project_id TEXT,
      binding_state TEXT NOT NULL DEFAULT 'unbound',
      client_thread_id TEXT,
      provisioning_job_id TEXT,
      provisioning_delivery_id TEXT,
      provisioning_started_at INTEGER,
      resolved_at INTEGER,
      reconcile_attempts INTEGER NOT NULL DEFAULT 0,
      next_reconcile_at INTEGER,
      reconcile_lease_owner TEXT,
      reconcile_lease_expires_at INTEGER,
      last_reconcile_error TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      task TEXT NOT NULL,
      project_root TEXT NOT NULL,
      status TEXT NOT NULL,
      delivery_id TEXT,
      marker_version INTEGER NOT NULL DEFAULT 2,
      previous_delivery_marker TEXT,
      lease_expires_at INTEGER,
      owner_session_id TEXT,
      thread_id TEXT,
      client_thread_id TEXT,
      observed_thread_id TEXT,
      created_at INTEGER NOT NULL,
      accepted_at INTEGER,
      observed_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS receiver_import_outbox (
      message_id TEXT PRIMARY KEY REFERENCES jobs(id),
      claim_token TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS receiver_event_outbox (
      event_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES jobs(id),
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      error_code TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(message_id, kind)
    );
    CREATE INDEX IF NOT EXISTS jobs_project_status
      ON jobs(project_root, status, created_at);
  `);

  for (const [name, definition] of [
    ["binding_state", "TEXT NOT NULL DEFAULT 'unbound'"],
    ["client_thread_id", "TEXT"],
    ["provisioning_job_id", "TEXT"],
    ["provisioning_delivery_id", "TEXT"],
    ["provisioning_started_at", "INTEGER"],
    ["resolved_at", "INTEGER"],
    ["reconcile_attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["next_reconcile_at", "INTEGER"],
    ["reconcile_lease_owner", "TEXT"],
    ["reconcile_lease_expires_at", "INTEGER"],
    ["last_reconcile_error", "TEXT"],
    ["cloud_conversation_id", "TEXT"],
    ["receiver_installation_id", "TEXT"],
    ["receiver_user_id", "TEXT"],
    ["receiver_project_id", "TEXT"],
  ])
    ensureColumn(database, "channels", name, definition);
  for (const [name, definition] of [
    ["owner_session_id", "TEXT"],
    ["client_thread_id", "TEXT"],
    ["observed_thread_id", "TEXT"],
    ["accepted_at", "INTEGER"],
    ["observed_at", "INTEGER"],
    ["updated_at", "INTEGER"],
    ["last_error", "TEXT"],
    ["marker_version", "INTEGER NOT NULL DEFAULT 1"],
    ["previous_delivery_marker", "TEXT"],
    ["source", "TEXT NOT NULL DEFAULT 'local'"],
    ["cloud_conversation_id", "TEXT"],
    ["cloud_sequence", "INTEGER"],
    ["content_hash", "TEXT"],
    ["sender_user_id", "TEXT"],
    ["sender_username", "TEXT"],
    ["recipient_user_id", "TEXT"],
    ["recipient_project_id", "TEXT"],
    ["receiver_installation_id", "TEXT"],
    ["cloud_import_state", "TEXT"],
    ["claim_token", "TEXT"],
    ["cloud_lease_expires_at", "TEXT"],
    ["native_mutation_state", "TEXT"],
  ])
    ensureColumn(database, "jobs", name, definition);

  database.exec(`
    UPDATE channels
    SET binding_state = CASE WHEN thread_id IS NULL THEN 'unbound' ELSE 'ready' END
    WHERE binding_state IS NULL OR (thread_id IS NOT NULL AND binding_state = 'unbound');
    UPDATE jobs SET status = 'uncertain'
    WHERE status = 'routing' AND owner_session_id IS NULL;
    UPDATE jobs SET marker_version = 2
    WHERE status = 'pending' AND delivery_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS channels_client_thread_unique
      ON channels(client_thread_id) WHERE client_thread_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS channels_thread_unique
      ON channels(thread_id) WHERE thread_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_channel
      ON jobs(channel_id) WHERE status IN (${ACTIVE_STATUSES});
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_cloud_conversation_sequence
      ON jobs(cloud_conversation_id, cloud_sequence)
      WHERE cloud_conversation_id IS NOT NULL;
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
  secureDatabaseFiles(path);
  return database;
}

function transaction(database, callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function channelFromRow(row) {
  return {
    bindingState: row.binding_state,
    clientThreadId: row.channel_client_thread_id,
    threadId: row.channel_thread_id,
    hostId: row.host_id,
    projectId: row.project_id,
  };
}

function deliveryFromRow(
  row,
  { retrying = false, receiverIdentity = null } = {},
) {
  const deliveryMarker =
    row.marker_version === 1
      ? formatLegacyDeliveryMarker(row.id)
      : formatDeliveryMarker(row.id, row.delivery_id);
  const nativeBody =
    row.source === "cloud"
      ? `Synapse message from @${row.sender_username} (conversation ${row.cloud_conversation_id}, sequence ${row.cloud_sequence}):\n\n${row.task}`
      : row.task;
  // Keep a local receipt before cloud content as well as the terminal trigger
  // marker. Native read_thread caps each output at 20,000 characters; large
  // tasks must still be reconcilable without copying their bodies elsewhere.
  const receipt =
    row.source === "cloud" ? `<!-- ${deliveryMarker} -->\n\n` : "";
  const nativePrompt = `${receipt}${nativeBody}\n\n<!-- ${deliveryMarker} -->`;
  if (Buffer.byteLength(nativePrompt, "utf8") > MAX_TASK_BYTES) {
    throw new Error("Rendered native prompt exceeds the 64 KiB limit");
  }
  return {
    jobId: row.id,
    deliveryId: row.delivery_id,
    deliveryMarker,
    dedupeMarkers: [
      ...new Set(
        [deliveryMarker, row.previous_delivery_marker].filter(Boolean),
      ),
    ],
    markerVersion: row.marker_version,
    retrying,
    ownerSessionId: row.owner_session_id,
    channelId: row.channel_id,
    task: row.task,
    nativePrompt,
    projectRoot: row.project_root,
    source: row.source,
    nativeMutationState: row.native_mutation_state,
    receiverAuthorization: row.source === "cloud" ? receiverIdentity : null,
    cloud:
      row.source === "cloud"
        ? {
            messageId: row.id,
            conversationId: row.cloud_conversation_id,
            sequence: row.cloud_sequence,
            senderUserId: row.sender_user_id,
            senderUsername: row.sender_username,
            recipientUserId: row.recipient_user_id,
            recipientProjectId: row.recipient_project_id,
            receiverInstallationId: row.receiver_installation_id,
            contentHash: row.content_hash,
            importState: row.cloud_import_state,
          }
        : null,
    channel: channelFromRow(row),
  };
}

function cloudIdentityMatches(row, identity) {
  return (
    identity?.installationId === row.receiver_installation_id &&
    identity?.userId === row.recipient_user_id &&
    identity?.projectId === row.recipient_project_id
  );
}

const DELIVERY_SELECT = `
  SELECT jobs.*,
    channels.thread_id AS channel_thread_id,
    channels.client_thread_id AS channel_client_thread_id,
    channels.host_id, channels.project_id, channels.binding_state
  FROM jobs JOIN channels ON channels.id = jobs.channel_id
`;

function finalizeObservedJob(database, jobId, now) {
  const row = database
    .prepare(`${DELIVERY_SELECT} WHERE jobs.id = ?`)
    .get(jobId);
  if (!row?.observed_thread_id) return row;
  if (
    row.channel_thread_id &&
    row.channel_thread_id !== row.observed_thread_id
  ) {
    const message =
      "Observed permanent task conflicts with the channel binding";
    database
      .prepare(
        `UPDATE jobs SET status = 'uncertain', last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(message, now, jobId);
    database
      .prepare(
        `UPDATE channels SET binding_state = 'uncertain', last_reconcile_error = ? WHERE id = ?`,
      )
      .run(message, row.channel_id);
    throw new Error(`Conflicting permanent task for channel ${row.channel_id}`);
  }
  database
    .prepare(`
    UPDATE channels SET binding_state = 'ready', thread_id = ?,
      client_thread_id = COALESCE(client_thread_id, ?),
      provisioning_job_id = NULL, provisioning_delivery_id = NULL,
      resolved_at = ?, reconcile_lease_owner = NULL,
      reconcile_lease_expires_at = NULL, next_reconcile_at = NULL,
      last_reconcile_error = NULL WHERE id = ?
  `)
    .run(row.observed_thread_id, row.client_thread_id, now, row.channel_id);
  database
    .prepare(`
    UPDATE jobs SET status = 'completed', thread_id = observed_thread_id,
      lease_expires_at = NULL, completed_at = COALESCE(completed_at, ?),
      updated_at = ?, last_error = NULL WHERE id = ?
  `)
    .run(now, now, jobId);
  enqueueCloudEvent(database, row, "delivered", now);
  return database.prepare(`${DELIVERY_SELECT} WHERE jobs.id = ?`).get(jobId);
}

function enqueueCloudEvent(
  database,
  job,
  kind,
  timestamp,
  { errorCode = null, createEventId = randomUUID } = {},
) {
  if (job.source !== "cloud") return;
  database
    .prepare(`INSERT OR IGNORE INTO receiver_event_outbox (
      event_id, message_id, kind, occurred_at, error_code, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      createEventId(),
      job.id,
      kind,
      new Date(timestamp).toISOString(),
      errorCode,
      timestamp,
    );
}

export function queueMessage(
  { channelId, task, projectRoot, id = randomUUID() },
  { path = inboxPath(), now = Date.now } = {},
) {
  requireId(id, "job ID");
  requireId(channelId, "channel ID");
  requireProjectRoot(projectRoot);
  if (typeof task !== "string" || task.trim() === "")
    throw new Error("Task must not be empty");
  if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) {
    throw new Error(`Task must not exceed ${MAX_TASK_BYTES} UTF-8 bytes`);
  }
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      database
        .prepare(
          `INSERT INTO channels (id, project_root) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`,
        )
        .run(channelId, projectRoot);
      const channel = database
        .prepare("SELECT project_root FROM channels WHERE id = ?")
        .get(channelId);
      if (channel.project_root !== projectRoot) {
        throw new Error(
          `Channel ${channelId} is attached to ${channel.project_root}, not ${projectRoot}`,
        );
      }
      const timestamp = now();
      database
        .prepare(`
        INSERT INTO jobs (id, channel_id, task, project_root, status, marker_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', 2, ?, ?)
      `)
        .run(id, channelId, task, projectRoot, timestamp, timestamp);
      return { jobId: id, channelId, projectRoot, status: "pending" };
    });
  } finally {
    database.close();
  }
}

export function stageCloudMessage(
  { message, identity, projectRoot, channelId },
  { path = inboxPath(), now = Date.now } = {},
) {
  requireId(message.messageId, "cloud message ID");
  requireId(message.conversationId, "cloud conversation ID");
  requireId(channelId, "cloud channel ID");
  requireId(identity.installationId, "receiver installation ID");
  requireProjectRoot(projectRoot);
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const timestamp = now();
      database
        .prepare(`INSERT INTO channels (
          id, project_root, cloud_conversation_id, receiver_installation_id,
          receiver_user_id, receiver_project_id
        ) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
        .run(
          channelId,
          projectRoot,
          message.conversationId,
          identity.installationId,
          identity.userId,
          identity.projectId,
        );
      const channel = database
        .prepare("SELECT * FROM channels WHERE id = ?")
        .get(channelId);
      if (
        channel.project_root !== projectRoot ||
        channel.cloud_conversation_id !== message.conversationId ||
        channel.receiver_installation_id !== identity.installationId ||
        channel.receiver_user_id !== identity.userId ||
        channel.receiver_project_id !== identity.projectId
      ) {
        throw new Error(`Cloud channel identity mismatch for ${channelId}`);
      }
      const existing = database
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(message.messageId);
      if (existing) {
        const exact =
          existing.source === "cloud" &&
          existing.channel_id === channelId &&
          existing.project_root === projectRoot &&
          existing.task === message.message &&
          existing.cloud_conversation_id === message.conversationId &&
          existing.cloud_sequence === message.sequence &&
          existing.content_hash === message.contentHash &&
          existing.sender_user_id === message.senderUserId &&
          existing.sender_username === message.senderUsername &&
          existing.recipient_user_id === message.recipientUserId &&
          existing.recipient_project_id === message.recipientProjectId &&
          existing.receiver_installation_id === identity.installationId;
        if (!exact)
          throw new Error(`Conflicting cloud payload for ${message.messageId}`);
        if (existing.cloud_import_state === "staged") {
          database
            .prepare(`UPDATE jobs SET claim_token = ?, cloud_lease_expires_at = ?,
              updated_at = ? WHERE id = ?`)
            .run(
              message.claimToken,
              message.leaseExpiresAt,
              timestamp,
              message.messageId,
            );
          database
            .prepare(`UPDATE receiver_import_outbox SET claim_token = ?,
              updated_at = ?, last_error = NULL WHERE message_id = ?`)
            .run(message.claimToken, timestamp, message.messageId);
        }
        return {
          messageId: message.messageId,
          status: existing.cloud_import_state,
          duplicate: true,
        };
      }
      database
        .prepare(`INSERT INTO jobs (
          id, channel_id, task, project_root, status, marker_version,
          source, cloud_conversation_id, cloud_sequence, content_hash,
          sender_user_id, sender_username, recipient_user_id, recipient_project_id,
          receiver_installation_id, cloud_import_state, claim_token,
          cloud_lease_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'staged', 2, 'cloud', ?, ?, ?, ?, ?, ?, ?, ?,
          'staged', ?, ?, ?, ?)`)
        .run(
          message.messageId,
          channelId,
          message.message,
          projectRoot,
          message.conversationId,
          message.sequence,
          message.contentHash,
          message.senderUserId,
          message.senderUsername,
          message.recipientUserId,
          message.recipientProjectId,
          identity.installationId,
          message.claimToken,
          message.leaseExpiresAt,
          timestamp,
          timestamp,
        );
      database
        .prepare(`INSERT INTO receiver_import_outbox (
          message_id, claim_token, created_at, updated_at
        ) VALUES (?, ?, ?, ?)`)
        .run(message.messageId, message.claimToken, timestamp, timestamp);
      return {
        messageId: message.messageId,
        status: "staged",
        duplicate: false,
      };
    });
  } finally {
    database.close();
  }
}

export function listPendingCloudImports(
  { installationId, limit = 10 },
  { path = inboxPath() } = {},
) {
  requireId(installationId, "receiver installation ID");
  const database = openInbox(path);
  try {
    return database
      .prepare(`SELECT o.message_id, o.claim_token, o.attempts,
        jobs.receiver_installation_id
        FROM receiver_import_outbox AS o
        JOIN jobs ON jobs.id = o.message_id
        WHERE jobs.receiver_installation_id = ?
        ORDER BY jobs.created_at, jobs.cloud_sequence LIMIT ?`)
      .all(installationId, Math.max(1, Math.min(Number(limit) || 10, 100)))
      .map((row) => ({
        messageId: row.message_id,
        claimToken: row.claim_token,
        attempts: row.attempts,
      }));
  } finally {
    database.close();
  }
}

export function confirmCloudImport(
  { messageId, installationId },
  { path = inboxPath(), now = Date.now } = {},
) {
  requireId(messageId, "cloud message ID");
  requireId(installationId, "receiver installation ID");
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const job = database
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(messageId);
      if (job?.source !== "cloud")
        throw new Error(`Unknown cloud message: ${messageId}`);
      if (job.receiver_installation_id !== installationId) {
        throw new Error(`Receiver installation mismatch for ${messageId}`);
      }
      if (job.cloud_import_state === "confirmed") {
        database
          .prepare("DELETE FROM receiver_import_outbox WHERE message_id = ?")
          .run(messageId);
        return { messageId, status: job.status, duplicate: true };
      }
      if (job.cloud_import_state !== "staged" || job.status !== "staged") {
        throw new Error(`Cloud message ${messageId} cannot be activated`);
      }
      database
        .prepare(`UPDATE jobs SET cloud_import_state = 'confirmed', status = 'pending',
          updated_at = ?, last_error = NULL WHERE id = ?`)
        .run(now(), messageId);
      database
        .prepare("DELETE FROM receiver_import_outbox WHERE message_id = ?")
        .run(messageId);
      return { messageId, status: "pending", duplicate: false };
    });
  } finally {
    database.close();
  }
}

export function recordCloudImportFailure(
  { messageId, error },
  { path = inboxPath(), now = Date.now } = {},
) {
  const database = openInbox(path);
  try {
    database
      .prepare(`UPDATE receiver_import_outbox SET attempts = attempts + 1,
        last_error = ?, updated_at = ? WHERE message_id = ?`)
      .run(
        String(error ?? "Import confirmation failed").slice(0, 4096),
        now(),
        messageId,
      );
  } finally {
    database.close();
  }
}

export function listPendingCloudEvents(
  { installationId, limit = 50 },
  { path = inboxPath() } = {},
) {
  requireId(installationId, "receiver installation ID");
  const database = openInbox(path);
  try {
    return database
      .prepare(`SELECT events.* FROM receiver_event_outbox AS events
        JOIN jobs ON jobs.id = events.message_id
        WHERE jobs.receiver_installation_id = ?
        ORDER BY events.created_at, events.event_id LIMIT ?`)
      .all(installationId, Math.max(1, Math.min(Number(limit) || 50, 100)))
      .map((row) => ({
        event_id: row.event_id,
        message_id: row.message_id,
        kind: row.kind,
        occurred_at: row.occurred_at,
        ...(row.error_code ? { error_code: row.error_code } : {}),
      }));
  } finally {
    database.close();
  }
}

export function acknowledgeCloudEvents(
  { installationId, eventIds },
  { path = inboxPath() } = {},
) {
  requireId(installationId, "receiver installation ID");
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const remove = database.prepare(`DELETE FROM receiver_event_outbox
        WHERE event_id = ? AND message_id IN (
          SELECT id FROM jobs WHERE receiver_installation_id = ?
        )`);
      let removed = 0;
      for (const eventId of eventIds) {
        requireId(eventId, "event ID");
        removed += Number(remove.run(eventId, installationId).changes);
      }
      return removed;
    });
  } finally {
    database.close();
  }
}

export function markCloudEventFailure(
  { eventIds, error },
  { path = inboxPath() } = {},
) {
  const database = openInbox(path);
  try {
    const update = database.prepare(`UPDATE receiver_event_outbox
      SET attempts = attempts + 1, last_error = ? WHERE event_id = ?`);
    for (const eventId of eventIds) {
      update.run(
        String(error ?? "Receipt upload failed").slice(0, 4096),
        eventId,
      );
    }
  } finally {
    database.close();
  }
}

export function reserveNextMessage(
  { projectRoot, ownerSessionId, source = null },
  {
    path = inboxPath(),
    now = Date.now,
    leaseMs = 5 * 60_000,
    createDeliveryId = randomUUID,
    receiverIdentity = null,
  } = {},
) {
  requireProjectRoot(projectRoot);
  requireId(ownerSessionId, "owner session ID");
  if (source !== null && source !== "local" && source !== "cloud")
    throw new Error("Invalid inbox source");
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const currentTime = now();
      const abandonedIssued = database
        .prepare(`SELECT * FROM jobs WHERE project_root = ? AND source = 'cloud'
          AND status = 'routing' AND native_mutation_state = 'issued'
          AND lease_expires_at <= ?`)
        .all(projectRoot, currentTime);
      for (const issued of abandonedIssued) {
        database
          .prepare(`UPDATE jobs SET status = 'uncertain', native_mutation_state = 'uncertain',
            lease_expires_at = NULL, updated_at = ?, last_error = ? WHERE id = ?`)
          .run(
            currentTime,
            "Native mutation ended without a definitive response",
            issued.id,
          );
        enqueueCloudEvent(database, issued, "needs_attention", currentTime, {
          errorCode: "native_response_uncertain",
        });
      }
      database
        .prepare(`UPDATE jobs SET status = 'pending', delivery_id = NULL,
          lease_expires_at = NULL, owner_session_id = NULL,
          native_mutation_state = NULL, updated_at = ?, last_error = NULL
          WHERE project_root = ? AND source = 'cloud' AND status = 'routing'
            AND native_mutation_state = 'intent' AND lease_expires_at <= ?
            AND receiver_installation_id = ? AND recipient_user_id = ?
            AND recipient_project_id = ?`)
        .run(
          currentTime,
          projectRoot,
          currentTime,
          receiverIdentity?.installationId ?? "",
          receiverIdentity?.userId ?? "",
          receiverIdentity?.projectId ?? "",
        );
      let job = database
        .prepare(`${DELIVERY_SELECT}
        WHERE jobs.project_root = ? AND jobs.owner_session_id = ?
          AND (? IS NULL OR jobs.source = ?)
          AND jobs.status = 'routing' AND jobs.lease_expires_at <= ?
          AND (jobs.source = 'local' OR (jobs.cloud_import_state = 'confirmed'
            AND jobs.receiver_installation_id = ? AND jobs.recipient_user_id = ?
            AND jobs.recipient_project_id = ?))
          AND (jobs.source = 'local' OR jobs.native_mutation_state <> 'issued')
        ORDER BY jobs.created_at, jobs.id LIMIT 1
      `)
        .get(
          projectRoot,
          ownerSessionId,
          source,
          source,
          currentTime,
          receiverIdentity?.installationId ?? "",
          receiverIdentity?.userId ?? "",
          receiverIdentity?.projectId ?? "",
        );
      const retrying = Boolean(job);
      if (!job) {
        job = database
          .prepare(`${DELIVERY_SELECT}
          WHERE jobs.project_root = ? AND jobs.status = 'pending'
            AND (? IS NULL OR jobs.source = ?)
            AND (jobs.source = 'local' OR (jobs.cloud_import_state = 'confirmed'
              AND jobs.receiver_installation_id = ? AND jobs.recipient_user_id = ?
              AND jobs.recipient_project_id = ?))
            AND NOT EXISTS (SELECT 1 FROM jobs AS active
              WHERE active.channel_id = jobs.channel_id AND active.status IN (${ACTIVE_STATUSES}))
            AND NOT EXISTS (SELECT 1 FROM jobs AS earlier
              WHERE jobs.source = 'cloud' AND earlier.source = 'cloud'
                AND earlier.channel_id = jobs.channel_id
                AND earlier.cloud_sequence < jobs.cloud_sequence
                AND earlier.status <> 'completed')
          ORDER BY jobs.created_at, jobs.id LIMIT 1
        `)
          .get(
            projectRoot,
            source,
            source,
            receiverIdentity?.installationId ?? "",
            receiverIdentity?.userId ?? "",
            receiverIdentity?.projectId ?? "",
          );
      }
      if (!job) return null;
      if (!retrying) {
        job.delivery_id = createDeliveryId();
        requireId(job.delivery_id, "delivery ID");
      }
      job.owner_session_id = ownerSessionId;
      if (job.source === "cloud") job.native_mutation_state = "intent";
      database
        .prepare(`UPDATE jobs SET status = 'routing', delivery_id = ?, lease_expires_at = ?,
        owner_session_id = ?, updated_at = ?,
        native_mutation_state = CASE WHEN source = 'cloud' THEN 'intent' ELSE native_mutation_state END
        WHERE id = ?`)
        .run(
          job.delivery_id,
          currentTime + leaseMs,
          ownerSessionId,
          currentTime,
          job.id,
        );
      return deliveryFromRow(job, {
        retrying,
        receiverIdentity: job.source === "cloud" ? receiverIdentity : null,
      });
    });
  } finally {
    database.close();
  }
}

export function acceptProvisioning(
  { jobId, deliveryId, clientThreadId, projectId, hostId = null },
  { path = inboxPath(), now = Date.now } = {},
) {
  for (const [label, value] of [
    ["job ID", jobId],
    ["delivery ID", deliveryId],
    ["client thread ID", clientThreadId],
    ["project ID", projectId],
  ])
    requireId(value, label);
  requireOptionalId(hostId, "host ID");
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const timestamp = now();
      const job = database
        .prepare(`${DELIVERY_SELECT} WHERE jobs.id = ?`)
        .get(jobId);
      if (!job) throw new Error(`Unknown job: ${jobId}`);
      if (job.delivery_id !== deliveryId)
        throw new Error(`Stale delivery for job ${jobId}`);
      if (job.client_thread_id && job.client_thread_id !== clientThreadId) {
        throw new Error(`Conflicting client task for job ${jobId}`);
      }
      if (!["routing", "accepted", "completed"].includes(job.status)) {
        throw new Error(
          `Job ${jobId} cannot accept provisioning from ${job.status}`,
        );
      }
      if (
        job.channel_client_thread_id &&
        job.channel_client_thread_id !== clientThreadId
      ) {
        throw new Error(
          `Conflicting client task for channel ${job.channel_id}`,
        );
      }
      if (job.project_id && job.project_id !== projectId) {
        throw new Error(`Conflicting project for channel ${job.channel_id}`);
      }
      if (hostId && job.host_id && job.host_id !== hostId) {
        throw new Error(`Conflicting host for channel ${job.channel_id}`);
      }
      database
        .prepare(`UPDATE jobs SET status = CASE WHEN status = 'routing' THEN 'accepted' ELSE status END,
        client_thread_id = ?, accepted_at = COALESCE(accepted_at, ?), lease_expires_at = NULL,
        updated_at = ?, last_error = NULL WHERE id = ?`)
        .run(clientThreadId, timestamp, timestamp, jobId);
      database
        .prepare(`UPDATE channels SET
        binding_state = CASE WHEN thread_id IS NULL THEN 'provisioning' ELSE 'ready' END,
        client_thread_id = ?, project_id = COALESCE(project_id, ?), host_id = COALESCE(host_id, ?),
        provisioning_job_id = ?, provisioning_delivery_id = ?,
        provisioning_started_at = COALESCE(provisioning_started_at, ?),
        reconcile_attempts = 0, next_reconcile_at = NULL,
        reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL,
        last_reconcile_error = NULL WHERE id = ?`)
        .run(
          clientThreadId,
          projectId,
          hostId,
          jobId,
          deliveryId,
          timestamp,
          job.channel_id,
        );
      enqueueCloudEvent(database, job, "provisioning", timestamp);
      const finalized = finalizeObservedJob(database, jobId, timestamp);
      return {
        jobId,
        channelId: job.channel_id,
        clientThreadId,
        threadId: finalized?.thread_id ?? null,
        status: finalized?.status ?? "accepted",
      };
    });
  } finally {
    database.close();
  }
}

export function observeProvisionedThread(
  { jobId, deliveryId, threadId },
  { path = inboxPath(), now = Date.now } = {},
) {
  for (const [label, value] of [
    ["job ID", jobId],
    ["delivery ID", deliveryId],
    ["thread ID", threadId],
  ])
    requireId(value, label);
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const timestamp = now();
      const job = database
        .prepare(`${DELIVERY_SELECT} WHERE jobs.id = ?`)
        .get(jobId);
      if (!job) throw new Error(`Unknown job: ${jobId}`);
      if (job.delivery_id !== deliveryId)
        throw new Error(`Stale delivery for job ${jobId}`);
      if (!["routing", "accepted", "completed"].includes(job.status)) {
        throw new Error(
          `Job ${jobId} cannot observe provisioning from ${job.status}`,
        );
      }
      if (job.observed_thread_id && job.observed_thread_id !== threadId) {
        throw new Error(`Conflicting permanent task for job ${jobId}`);
      }
      database
        .prepare(`UPDATE jobs SET observed_thread_id = ?, observed_at = COALESCE(observed_at, ?),
        updated_at = ? WHERE id = ?`)
        .run(threadId, timestamp, timestamp, jobId);
      const finalized = finalizeObservedJob(database, jobId, timestamp);
      return {
        jobId,
        channelId: job.channel_id,
        threadId,
        status: finalized.status,
      };
    });
  } finally {
    database.close();
  }
}

export function bindChannelThread(
  { jobId, deliveryId, threadId, projectId, hostId = "local" },
  { path = inboxPath(), now = Date.now } = {},
) {
  for (const [label, value] of [
    ["job ID", jobId],
    ["delivery ID", deliveryId],
    ["thread ID", threadId],
    ["project ID", projectId],
  ])
    requireId(value, label);
  requireOptionalId(hostId, "host ID");
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const timestamp = now();
      const job = database
        .prepare(`${DELIVERY_SELECT} WHERE jobs.id = ?`)
        .get(jobId);
      if (!job) throw new Error(`Unknown job: ${jobId}`);
      if (job.delivery_id !== deliveryId)
        throw new Error(`Stale delivery for job ${jobId}`);
      if (!["routing", "completed"].includes(job.status)) {
        throw new Error(`Job ${jobId} cannot bind a task from ${job.status}`);
      }
      if (job.channel_thread_id && job.channel_thread_id !== threadId) {
        throw new Error(
          `Conflicting permanent task for channel ${job.channel_id}`,
        );
      }
      if (job.project_id && job.project_id !== projectId) {
        throw new Error(`Conflicting project for channel ${job.channel_id}`);
      }
      if (hostId && job.host_id && job.host_id !== hostId) {
        throw new Error(`Conflicting host for channel ${job.channel_id}`);
      }
      database
        .prepare(`UPDATE channels SET binding_state = 'ready', thread_id = ?,
        host_id = COALESCE(host_id, ?), project_id = COALESCE(project_id, ?),
        provisioning_job_id = NULL, provisioning_delivery_id = NULL,
        resolved_at = COALESCE(resolved_at, ?), last_reconcile_error = NULL
        WHERE id = ?`)
        .run(threadId, hostId, projectId, timestamp, job.channel_id);
      database
        .prepare(`UPDATE jobs SET thread_id = ?, observed_thread_id = ?,
        observed_at = COALESCE(observed_at, ?), updated_at = ?, last_error = NULL
        WHERE id = ?`)
        .run(threadId, threadId, timestamp, timestamp, jobId);
      return {
        jobId,
        channelId: job.channel_id,
        threadId,
        projectId,
        status: job.status,
      };
    });
  } finally {
    database.close();
  }
}

export function acknowledgeMessage(
  { jobId, deliveryId, threadId, hostId, projectId },
  { path = inboxPath(), now = Date.now } = {},
) {
  for (const [label, value] of [
    ["job ID", jobId],
    ["delivery ID", deliveryId],
    ["thread ID", threadId],
    ["host ID", hostId],
    ["project ID", projectId],
  ])
    requireId(value, label);
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const timestamp = now();
      const job = database
        .prepare(`${DELIVERY_SELECT} WHERE jobs.id = ?`)
        .get(jobId);
      if (!job) throw new Error(`Unknown job: ${jobId}`);
      if (job.delivery_id !== deliveryId)
        throw new Error(`Stale delivery for job ${jobId}`);
      if (job.status === "completed") {
        if (job.thread_id !== threadId)
          throw new Error(`Conflicting permanent task for job ${jobId}`);
        if (job.host_id && job.host_id !== hostId)
          throw new Error(`Conflicting host for job ${jobId}`);
        if (job.project_id && job.project_id !== projectId) {
          throw new Error(`Conflicting project for job ${jobId}`);
        }
        return {
          jobId,
          channelId: job.channel_id,
          threadId,
          status: "completed",
        };
      }
      if (!["routing", "accepted"].includes(job.status)) {
        throw new Error(`Job ${jobId} cannot be completed from ${job.status}`);
      }
      if (job.channel_thread_id && job.channel_thread_id !== threadId) {
        throw new Error(
          `Conflicting permanent task for channel ${job.channel_id}`,
        );
      }
      database
        .prepare(`UPDATE channels SET binding_state = 'ready', thread_id = ?, host_id = ?,
        project_id = ?, provisioning_job_id = NULL, provisioning_delivery_id = NULL,
        resolved_at = COALESCE(resolved_at, ?), reconcile_lease_owner = NULL,
        reconcile_lease_expires_at = NULL, next_reconcile_at = NULL,
        last_reconcile_error = NULL WHERE id = ?`)
        .run(threadId, hostId, projectId, timestamp, job.channel_id);
      database
        .prepare(`UPDATE jobs SET status = 'completed', thread_id = ?,
        observed_thread_id = COALESCE(observed_thread_id, ?), observed_at = COALESCE(observed_at, ?),
        lease_expires_at = NULL, completed_at = COALESCE(completed_at, ?), updated_at = ?,
        last_error = NULL WHERE id = ?`)
        .run(threadId, threadId, timestamp, timestamp, timestamp, jobId);
      enqueueCloudEvent(database, job, "delivered", timestamp);
      return {
        jobId,
        channelId: job.channel_id,
        threadId,
        status: "completed",
      };
    });
  } finally {
    database.close();
  }
}

export function recoverMessage(
  { jobId, ownerStopped },
  { path = inboxPath(), now = Date.now } = {},
) {
  requireId(jobId, "job ID");
  if (ownerStopped !== true)
    throw new Error(
      "Recovery requires confirmation that the prior owner task stopped",
    );
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const job = database
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId);
      if (!job) throw new Error(`Unknown job: ${jobId}`);
      if (job.source === "cloud") {
        throw new Error(
          `Cloud job ${jobId} requires receiver reconciliation and cannot use legacy recovery`,
        );
      }
      if (job.status === "accepted") {
        throw new Error(
          `Job ${jobId} was accepted by Codex and must be reconciled, not retried`,
        );
      }
      if (job.status !== "uncertain")
        throw new Error(`Job ${jobId} is not awaiting recovery`);
      const timestamp = now();
      const previousMarker = job.delivery_id
        ? job.marker_version === 1
          ? formatLegacyDeliveryMarker(job.id)
          : formatDeliveryMarker(job.id, job.delivery_id)
        : job.previous_delivery_marker;
      database
        .prepare(`UPDATE jobs SET status = 'pending', delivery_id = NULL, lease_expires_at = NULL,
        owner_session_id = NULL, client_thread_id = NULL, observed_thread_id = NULL, marker_version = 2,
        previous_delivery_marker = ?, updated_at = ?, last_error = NULL WHERE id = ?`)
        .run(previousMarker, timestamp, jobId);
      database
        .prepare(`UPDATE channels SET
        binding_state = CASE WHEN thread_id IS NULL THEN 'unbound' ELSE 'ready' END,
        client_thread_id = CASE WHEN thread_id IS NULL THEN NULL ELSE client_thread_id END,
        provisioning_job_id = NULL, provisioning_delivery_id = NULL, provisioning_started_at = NULL,
        reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL, next_reconcile_at = NULL,
        last_reconcile_error = NULL WHERE id = ?`)
        .run(job.channel_id);
      return { jobId, channelId: job.channel_id, status: "pending" };
    });
  } finally {
    database.close();
  }
}

export function retryRoutingMessage(
  { jobId, deliveryId, error },
  { path = inboxPath(), now = Date.now } = {},
) {
  requireId(jobId, "job ID");
  requireId(deliveryId, "delivery ID");
  const message = String(error ?? "Routing failed").slice(0, 4096);
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const job = database
        .prepare(`${DELIVERY_SELECT} WHERE jobs.id = ?`)
        .get(jobId);
      if (!job) throw new Error(`Unknown job: ${jobId}`);
      if (job.delivery_id !== deliveryId)
        throw new Error(`Stale delivery for job ${jobId}`);
      if (job.status === "completed") return deliveryFromRow(job);
      if (job.status !== "routing") {
        throw new Error(`Job ${jobId} cannot retry from ${job.status}`);
      }
      const marker =
        job.marker_version === 1
          ? formatLegacyDeliveryMarker(job.id)
          : formatDeliveryMarker(job.id, job.delivery_id);
      const timestamp = now();
      database
        .prepare(`UPDATE jobs SET status = 'pending', delivery_id = NULL,
        previous_delivery_marker = ?, lease_expires_at = NULL,
        owner_session_id = NULL, native_mutation_state = NULL,
        updated_at = ?, last_error = ? WHERE id = ?`)
        .run(marker, timestamp, message, jobId);
      return {
        jobId,
        channelId: job.channel_id,
        status: "pending",
        lastError: message,
      };
    });
  } finally {
    database.close();
  }
}

export function getReservedDelivery(
  { jobId, deliveryId, receiverIdentity = null },
  { path = inboxPath() } = {},
) {
  requireId(jobId, "job ID");
  requireId(deliveryId, "delivery ID");
  const database = openInbox(path);
  try {
    const row = database
      .prepare(`${DELIVERY_SELECT} WHERE jobs.id = ? AND jobs.delivery_id = ?`)
      .get(jobId, deliveryId);
    if (row?.status !== "routing") return null;
    if (
      row.source === "cloud" &&
      !cloudIdentityMatches(row, receiverIdentity)
    ) {
      return null;
    }
    return deliveryFromRow(row, {
      receiverIdentity: row.source === "cloud" ? receiverIdentity : null,
    });
  } finally {
    database.close();
  }
}

export function markNativeMutationIssued(
  { jobId, deliveryId, receiverIdentity = null },
  { path = inboxPath(), now = Date.now } = {},
) {
  requireId(jobId, "job ID");
  requireId(deliveryId, "delivery ID");
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const job = database
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId);
      if (!job) throw new Error(`Unknown job: ${jobId}`);
      if (job.delivery_id !== deliveryId || job.status !== "routing") {
        throw new Error(`Stale native mutation for job ${jobId}`);
      }
      if (job.source !== "cloud") return { jobId, source: "local" };
      if (!cloudIdentityMatches(job, receiverIdentity)) {
        throw new Error(`Receiver identity mismatch for cloud job ${jobId}`);
      }
      if (job.native_mutation_state !== "intent") {
        throw new Error(
          `Cloud job ${jobId} has no durable native mutation intent`,
        );
      }
      database
        .prepare(`UPDATE jobs SET native_mutation_state = 'issued', updated_at = ?
          WHERE id = ?`)
        .run(now(), jobId);
      return { jobId, source: "cloud", state: "issued" };
    });
  } finally {
    database.close();
  }
}

export function markNativeMutationUncertain(
  { jobId, deliveryId, error, errorCode = "native_response_uncertain" },
  { path = inboxPath(), now = Date.now, createEventId = randomUUID } = {},
) {
  requireId(jobId, "job ID");
  requireId(deliveryId, "delivery ID");
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const timestamp = now();
      const job = database
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId);
      if (!job) throw new Error(`Unknown job: ${jobId}`);
      if (job.delivery_id !== deliveryId)
        throw new Error(`Stale delivery for job ${jobId}`);
      if (job.source !== "cloud" || job.native_mutation_state !== "issued") {
        throw new Error(`Job ${jobId} has no issued cloud mutation`);
      }
      if (job.status === "completed") return { jobId, status: "completed" };
      database
        .prepare(`UPDATE jobs SET status = 'uncertain', native_mutation_state = 'uncertain',
          lease_expires_at = NULL, updated_at = ?, last_error = ? WHERE id = ?`)
        .run(
          timestamp,
          String(error ?? "Native response was uncertain").slice(0, 4096),
          jobId,
        );
      enqueueCloudEvent(database, job, "needs_attention", timestamp, {
        errorCode,
        createEventId,
      });
      return { jobId, status: "uncertain" };
    });
  } finally {
    database.close();
  }
}

export function getJob(jobId, { path = inboxPath() } = {}) {
  requireId(jobId, "job ID");
  const database = openInbox(path);
  try {
    const row = database
      .prepare(`${DELIVERY_SELECT} WHERE jobs.id = ?`)
      .get(jobId);
    return row
      ? {
          jobId: row.id,
          deliveryId: row.delivery_id,
          markerVersion: row.marker_version,
          ownerSessionId: row.owner_session_id,
          channelId: row.channel_id,
          projectRoot: row.project_root,
          status: row.status,
          bindingState: row.binding_state,
          clientThreadId: row.client_thread_id,
          observedThreadId: row.observed_thread_id,
          threadId: row.thread_id,
          channelThreadId: row.channel_thread_id,
          hostId: row.host_id,
          projectId: row.project_id,
          source: row.source,
          cloudImportState: row.cloud_import_state,
          cloudConversationId: row.cloud_conversation_id,
          cloudSequence: row.cloud_sequence,
          receiverInstallationId: row.receiver_installation_id,
          nativeMutationState: row.native_mutation_state,
        }
      : null;
  } finally {
    database.close();
  }
}

export function listPendingNativeBindings(
  { projectRoot, installationId },
  { path = inboxPath() } = {},
) {
  const database = openInbox(path);
  try {
    return database
      .prepare(`SELECT id AS jobId, delivery_id AS deliveryId,
      client_thread_id AS clientThreadId, owner_session_id AS ownerSessionId,
      project_root AS projectRoot FROM jobs WHERE project_root = ?
      AND receiver_installation_id = ? AND source = 'cloud'
      AND status = 'accepted' AND cloud_import_state = 'confirmed'
      AND native_mutation_state = 'issued' AND thread_id IS NULL
      AND EXISTS (SELECT 1 FROM channels WHERE channels.id=jobs.channel_id AND channels.host_id='local')
      AND client_thread_id IS NOT NULL ORDER BY accepted_at LIMIT 3`)
      .all(projectRoot, installationId);
  } finally {
    database.close();
  }
}
