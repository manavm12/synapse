import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SAFE_ID = /^[a-zA-Z0-9._:-]{1,128}$/;

export function inboxPath(env = process.env) {
  return resolve(env.SYNAPSE_INBOX_PATH ?? join(homedir(), ".synapse", "inbox.sqlite"));
}

function requireId(value, label) {
  if (!SAFE_ID.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

function requireProjectRoot(value) {
  if (!isAbsolute(value)) {
    throw new Error("Project root must be an absolute path");
  }
}

function openInbox(path) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      project_root TEXT NOT NULL,
      thread_id TEXT,
      host_id TEXT,
      project_id TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      task TEXT NOT NULL,
      project_root TEXT NOT NULL,
      status TEXT NOT NULL,
      delivery_id TEXT,
      lease_expires_at INTEGER,
      thread_id TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS jobs_project_status
      ON jobs(project_root, status, created_at);
  `);
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
    threadId: row.thread_id,
    hostId: row.host_id,
    projectId: row.project_id,
  };
}

export function queueMessage(
  { channelId, task, projectRoot, id = randomUUID() },
  { path = inboxPath(), now = Date.now } = {},
) {
  requireId(id, "job ID");
  requireId(channelId, "channel ID");
  requireProjectRoot(projectRoot);
  if (typeof task !== "string" || task.trim() === "") {
    throw new Error("Task must not be empty");
  }

  const database = openInbox(path);
  try {
    return transaction(database, () => {
      database.prepare(`
        INSERT INTO channels (id, project_root) VALUES (?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(channelId, projectRoot);
      const channel = database.prepare(
        "SELECT project_root FROM channels WHERE id = ?",
      ).get(channelId);
      if (channel.project_root !== projectRoot) {
        throw new Error(
          `Channel ${channelId} is attached to ${channel.project_root}, not ${projectRoot}`,
        );
      }
      database.prepare(`
        INSERT INTO jobs (
          id, channel_id, task, project_root, status, created_at
        ) VALUES (?, ?, ?, ?, 'pending', ?)
      `).run(id, channelId, task, projectRoot, now());
      return { jobId: id, channelId, projectRoot, status: "pending" };
    });
  } finally {
    database.close();
  }
}

export function reserveNextMessage(
  { projectRoot },
  {
    path = inboxPath(),
    now = Date.now,
    leaseMs = 5 * 60_000,
    createDeliveryId = randomUUID,
  } = {},
) {
  requireProjectRoot(projectRoot);
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const currentTime = now();
      database.prepare(`
        UPDATE jobs
        SET status = 'pending', delivery_id = NULL, lease_expires_at = NULL
        WHERE status = 'routing' AND lease_expires_at <= ?
      `).run(currentTime);
      const job = database.prepare(`
        SELECT jobs.*, channels.thread_id, channels.host_id, channels.project_id
        FROM jobs
        JOIN channels ON channels.id = jobs.channel_id
        WHERE jobs.project_root = ? AND jobs.status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM jobs AS active
            WHERE active.channel_id = jobs.channel_id AND active.status = 'routing'
          )
        ORDER BY jobs.created_at, jobs.id
        LIMIT 1
      `).get(projectRoot);
      if (!job) {
        return null;
      }
      const deliveryId = createDeliveryId();
      requireId(deliveryId, "delivery ID");
      database.prepare(`
        UPDATE jobs
        SET status = 'routing', delivery_id = ?, lease_expires_at = ?
        WHERE id = ?
      `).run(deliveryId, currentTime + leaseMs, job.id);
      return {
        jobId: job.id,
        deliveryId,
        channelId: job.channel_id,
        task: job.task,
        projectRoot: job.project_root,
        channel: channelFromRow(job),
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
  ]) {
    requireId(value, label);
  }
  const database = openInbox(path);
  try {
    return transaction(database, () => {
      const job = database.prepare(
        "SELECT * FROM jobs WHERE id = ?",
      ).get(jobId);
      if (!job) {
        throw new Error(`Unknown job: ${jobId}`);
      }
      if (job.status !== "routing" || job.delivery_id !== deliveryId) {
        throw new Error(`Stale delivery for job ${jobId}`);
      }
      database.prepare(`
        UPDATE channels
        SET thread_id = ?, host_id = ?, project_id = ?
        WHERE id = ?
      `).run(threadId, hostId, projectId, job.channel_id);
      database.prepare(`
        UPDATE jobs
        SET status = 'completed', thread_id = ?, lease_expires_at = NULL,
            completed_at = ?
        WHERE id = ?
      `).run(threadId, now(), jobId);
      return { jobId, channelId: job.channel_id, threadId, status: "completed" };
    });
  } finally {
    database.close();
  }
}

export function getJob(jobId, { path = inboxPath() } = {}) {
  requireId(jobId, "job ID");
  const database = openInbox(path);
  try {
    const row = database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    return row
      ? {
          jobId: row.id,
          channelId: row.channel_id,
          projectRoot: row.project_root,
          status: row.status,
          threadId: row.thread_id,
        }
      : null;
  } finally {
    database.close();
  }
}
