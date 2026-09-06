import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  acknowledgeMessage,
  getJob,
  queueMessage,
  recoverMessage,
  reserveNextMessage,
} from "../../plugins/synapse/lib/inbox.mjs";

async function inbox() {
  return join(
    await mkdtemp(join(tmpdir(), "synapse-inbox-test-")),
    "inbox.sqlite",
  );
}

test("a project prompt leases and acknowledges one queued message", async () => {
  const path = await inbox();
  queueMessage(
    {
      id: "job-1",
      channelId: "demo",
      task: "create a file",
      projectRoot: "/project",
    },
    { path, now: () => 1 },
  );
  const delivery = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path, now: () => 2, createDeliveryId: () => "delivery-1" },
  );
  assert.equal(delivery.task, "create a file");
  assert.equal(
    delivery.nativePrompt,
    "create a file\n\n<!-- synapse-delivery:job-1 -->",
  );
  assert.equal(delivery.retrying, false);
  assert.equal(delivery.channel.threadId, null);
  assert.equal(
    reserveNextMessage(
      { projectRoot: "/project", ownerSessionId: "owner-1" },
      { path, now: () => 3 },
    ),
    null,
  );

  acknowledgeMessage(
    {
      jobId: "job-1",
      deliveryId: "delivery-1",
      threadId: "thread-1",
      hostId: "local",
      projectId: "project-1",
    },
    { path, now: () => 3 },
  );
  assert.deepEqual(getJob("job-1", { path }), {
    jobId: "job-1",
    channelId: "demo",
    projectRoot: "/project",
    status: "completed",
    threadId: "thread-1",
  });
});

test("identifiers and task sizes are validated before storage", async () => {
  const path = await inbox();
  assert.throws(
    () =>
      queueMessage(
        {
          id: 42,
          channelId: "demo",
          task: "task",
          projectRoot: "/project",
        },
        { path },
      ),
    /Invalid job ID/,
  );
  assert.throws(
    () =>
      queueMessage(
        {
          id: "job-1",
          channelId: "demo",
          task: "é".repeat(32 * 1024 + 1),
          projectRoot: "/project",
        },
        { path },
      ),
    /65536 UTF-8 bytes/,
  );
  assert.equal(getJob("job-1", { path }), null);
});

test("the inbox directory and database are private to the current user", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "synapse-permissions-test-"));
  const directory = join(root, ".synapse");
  await mkdir(directory, { mode: 0o755 });
  await chmod(directory, 0o755);
  const path = join(directory, "inbox.sqlite");

  queueMessage(
    {
      id: "job-1",
      channelId: "demo",
      task: "private task",
      projectRoot: "/project",
    },
    { path },
  );

  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("a follow-up reuses the native channel and a channel stays in one project", async () => {
  const path = await inbox();
  queueMessage(
    { id: "job-1", channelId: "demo", task: "first", projectRoot: "/project" },
    { path },
  );
  const first = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path, createDeliveryId: () => "delivery-1" },
  );
  acknowledgeMessage(
    {
      jobId: "job-1",
      deliveryId: first.deliveryId,
      threadId: "thread-1",
      hostId: "local",
      projectId: "project-1",
    },
    { path },
  );
  queueMessage(
    { id: "job-2", channelId: "demo", task: "second", projectRoot: "/project" },
    { path },
  );
  const followUp = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path },
  );
  assert.deepEqual(followUp.channel, {
    threadId: "thread-1",
    hostId: "local",
    projectId: "project-1",
  });
  assert.throws(
    () =>
      queueMessage(
        {
          id: "job-3",
          channelId: "demo",
          task: "wrong",
          projectRoot: "/other",
        },
        { path },
      ),
    /attached to \/project/,
  );
});

test("an expired delivery retries with the same native identity", async () => {
  const path = await inbox();
  queueMessage(
    { id: "job-1", channelId: "demo", task: "retry", projectRoot: "/project" },
    { path },
  );
  reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path, now: () => 100, leaseMs: 10, createDeliveryId: () => "delivery-1" },
  );
  const retried = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path, now: () => 111, createDeliveryId: () => "delivery-2" },
  );
  assert.equal(retried.deliveryId, "delivery-1");
  assert.equal(retried.deliveryMarker, "synapse-delivery:job-1");
  assert.equal(retried.retrying, true);
  const acknowledgement = {
    jobId: "job-1",
    deliveryId: retried.deliveryId,
    threadId: "thread-1",
    hostId: "local",
    projectId: "project-1",
  };
  assert.equal(
    acknowledgeMessage(acknowledgement, { path }).status,
    "completed",
  );
  assert.equal(
    acknowledgeMessage(acknowledgement, { path }).status,
    "completed",
  );
});

test("stale acknowledgements cannot complete a reserved message", async () => {
  const path = await inbox();
  queueMessage(
    { id: "job-1", channelId: "demo", task: "task", projectRoot: "/project" },
    { path },
  );
  reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path, createDeliveryId: () => "delivery-1" },
  );

  assert.throws(
    () =>
      acknowledgeMessage(
        {
          jobId: "job-1",
          deliveryId: "delivery-stale",
          threadId: "thread-1",
          hostId: "local",
          projectId: "project-1",
        },
        { path },
      ),
    /Stale delivery/,
  );
  assert.equal(getJob("job-1", { path }).status, "routing");
});

test("an expired delivery cannot be stolen by another owner task", async () => {
  const path = await inbox();
  queueMessage(
    { id: "job-1", channelId: "demo", task: "retry", projectRoot: "/project" },
    { path },
  );
  reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path, now: () => 100, leaseMs: 10 },
  );

  assert.equal(
    reserveNextMessage(
      { projectRoot: "/project", ownerSessionId: "owner-2" },
      { path, now: () => 111 },
    ),
    null,
  );
  assert.equal(
    reserveNextMessage(
      { projectRoot: "/project", ownerSessionId: "owner-1" },
      { path, now: () => 111 },
    ).retrying,
    true,
  );
});

test("legacy in-flight jobs migrate to explicit recovery without losing identity", async () => {
  const path = await inbox();
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      project_root TEXT NOT NULL,
      thread_id TEXT,
      host_id TEXT,
      project_id TEXT
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      task TEXT NOT NULL,
      project_root TEXT NOT NULL,
      status TEXT NOT NULL,
      delivery_id TEXT,
      lease_expires_at INTEGER,
      thread_id TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    INSERT INTO channels (id, project_root) VALUES ('demo', '/project');
    INSERT INTO jobs (
      id, channel_id, task, project_root, status, delivery_id,
      lease_expires_at, created_at
    ) VALUES (
      'job-1', 'demo', 'legacy task', '/project', 'routing',
      'delivery-1', 100, 1
    );
  `);
  database.close();

  assert.equal(getJob("job-1", { path }).status, "uncertain");
  assert.equal(
    reserveNextMessage(
      { projectRoot: "/project", ownerSessionId: "owner-2" },
      { path, now: () => 200 },
    ),
    null,
  );
  assert.throws(
    () => recoverMessage({ jobId: "job-1", ownerStopped: false }, { path }),
    /prior owner task stopped/,
  );
  assert.equal(
    recoverMessage({ jobId: "job-1", ownerStopped: true }, { path }).status,
    "pending",
  );
  const retried = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-2" },
    { path, now: () => 200, createDeliveryId: () => "delivery-2" },
  );
  assert.equal(retried.deliveryMarker, "synapse-delivery:job-1");
});
