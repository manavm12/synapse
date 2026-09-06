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
const SCHEMA_VERSION = 2;

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

function deliveryFromRow(row, { retrying = false, reconciling = false } = {}) {
  const deliveryMarker =
    row.marker_version === 1
      ? formatLegacyDeliveryMarker(row.id)
      : formatDeliveryMarker(row.id, row.delivery_id);
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
    reconciling,
    ownerSessionId: row.owner_session_id,
    channelId: row.channel_id,
    task: row.task,
    nativePrompt: `${row.task}\n\n<!-- ${deliveryMarker} -->`,
    projectRoot: row.project_root,
    channel: channelFromRow(row),
  };
}

const DELIVERY_SELECT = `
  SELECT jobs.*,
    channels.thread_id AS channel_thread_id,
    channels.client_thread_id AS channel_client_thread_id,
    channels.host_id, channels.project_id, channels.binding_state,
    channels.reconcile_attempts
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
  return database.prepare(`${DELIVERY_SELECT} WHERE jobs.id = ?`).get(jobId);
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

export function reserveNextMessage(
  { projectRoot, ownerSessionId },
  {
    path = inboxPath(),
    now = Date.now,
    leaseMs = 5 * 60_000,
    createDeliveryId = randomUUID,
  } = {},
) {
  requireProjectRoot(projectRoot);
  requireId(ownerSessionId, "owner session ID");
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const currentTime = now();
      let job = database
        .prepare(`${DELIVERY_SELECT}
        WHERE jobs.project_root = ? AND jobs.owner_session_id = ?
          AND jobs.status = 'routing' AND jobs.lease_expires_at <= ?
        ORDER BY jobs.created_at, jobs.id LIMIT 1
      `)
        .get(projectRoot, ownerSessionId, currentTime);
      const retrying = Boolean(job);
      if (!job) {
        job = database
          .prepare(`${DELIVERY_SELECT}
          WHERE jobs.project_root = ? AND jobs.status = 'pending'
            AND NOT EXISTS (SELECT 1 FROM jobs AS active
              WHERE active.channel_id = jobs.channel_id AND active.status IN (${ACTIVE_STATUSES}))
          ORDER BY jobs.created_at, jobs.id LIMIT 1
        `)
          .get(projectRoot);
      }
      if (!job) return null;
      if (!retrying) {
        job.delivery_id = createDeliveryId();
        requireId(job.delivery_id, "delivery ID");
      }
      job.owner_session_id = ownerSessionId;
      database
        .prepare(`UPDATE jobs SET status = 'routing', delivery_id = ?, lease_expires_at = ?,
        owner_session_id = ?, updated_at = ? WHERE id = ?`)
        .run(
          job.delivery_id,
          currentTime + leaseMs,
          ownerSessionId,
          currentTime,
          job.id,
        );
      return deliveryFromRow(job, { retrying });
    });
  } finally {
    database.close();
  }
}

export function reserveReconciliation(
  { projectRoot, ownerSessionId },
  {
    path = inboxPath(),
    now = Date.now,
    leaseMs = 60_000,
    baseBackoffMs = 30_000,
    maxBackoffMs = 30 * 60_000,
  } = {},
) {
  requireProjectRoot(projectRoot);
  requireId(ownerSessionId, "owner session ID");
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const currentTime = now();
      const job = database
        .prepare(`${DELIVERY_SELECT}
        WHERE jobs.project_root = ? AND jobs.status = 'accepted'
          AND (channels.next_reconcile_at IS NULL OR channels.next_reconcile_at <= ?)
          AND (channels.reconcile_lease_expires_at IS NULL
            OR channels.reconcile_lease_expires_at <= ? OR channels.reconcile_lease_owner = ?)
        ORDER BY jobs.accepted_at, jobs.created_at LIMIT 1
      `)
        .get(projectRoot, currentTime, currentTime, ownerSessionId);
      if (!job) return null;
      const attempt = Number(job.reconcile_attempts ?? 0) + 1;
      const backoff = Math.min(
        maxBackoffMs,
        baseBackoffMs * 2 ** (attempt - 1),
      );
      database
        .prepare(`UPDATE channels SET reconcile_attempts = ?, reconcile_lease_owner = ?,
        reconcile_lease_expires_at = ?, next_reconcile_at = ? WHERE id = ?`)
        .run(
          attempt,
          ownerSessionId,
          currentTime + leaseMs,
          currentTime + backoff,
          job.channel_id,
        );
      return deliveryFromRow(job, { reconciling: true });
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
        next_reconcile_at = COALESCE(next_reconcile_at, ?) WHERE id = ?`)
        .run(
          clientThreadId,
          projectId,
          hostId,
          jobId,
          deliveryId,
          timestamp,
          timestamp,
          job.channel_id,
        );
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
        }
      : null;
  } finally {
    database.close();
  }
}
