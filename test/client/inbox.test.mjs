import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  acceptProvisioning,
  acknowledgeMessage,
  bindChannelThread,
  getJob,
  getReservedDelivery,
  observeProvisionedThread,
  queueMessage,
  recoverMessage,
  reserveNextMessage,
  retryRoutingMessage,
} from "../../plugins/synapse/lib/inbox.mjs";

async function inbox() {
  return join(
    await mkdtemp(join(tmpdir(), "synapse-inbox-test-")),
    "inbox.sqlite",
  );
}

function queue(path, id = "job-1", channelId = "demo", task = "create a file") {
  return queueMessage(
    { id, channelId, task, projectRoot: "/project" },
    { path, now: () => 1 },
  );
}

function reserve(path, ownerSessionId = "owner-1", options = {}) {
  return reserveNextMessage(
    { projectRoot: "/project", ownerSessionId },
    { path, now: () => 2, createDeliveryId: () => "delivery-1", ...options },
  );
}

test("a project prompt leases and directly acknowledges one queued message", async () => {
  const path = await inbox();
  queue(path);
  const delivery = reserve(path);
  assert.equal(delivery.task, "create a file");
  assert.equal(delivery.ownerSessionId, "owner-1");
  assert.equal(
    delivery.nativePrompt,
    "create a file\n\n<!-- synapse-delivery:v2 job=job-1 delivery=delivery-1 -->",
  );
  assert.equal(delivery.retrying, false);
  assert.equal(delivery.channel.threadId, null);

  const acknowledgement = {
    jobId: "job-1",
    deliveryId: "delivery-1",
    threadId: "thread-1",
    hostId: "local",
    projectId: "project-1",
  };
  assert.equal(
    acknowledgeMessage(acknowledgement, { path, now: () => 3 }).status,
    "completed",
  );
  assert.equal(
    acknowledgeMessage(acknowledgement, { path, now: () => 4 }).status,
    "completed",
  );
  assert.throws(
    () =>
      acknowledgeMessage(
        { ...acknowledgement, projectId: "project-2" },
        { path },
      ),
    /Conflicting project/,
  );
  const job = getJob("job-1", { path });
  assert.equal(job.status, "completed");
  assert.equal(job.bindingState, "ready");
  assert.equal(job.channelThreadId, "thread-1");
});

test("the background router binds a permanent task before delivery completes", async () => {
  const path = await inbox();
  queue(path);
  reserve(path);
  const bound = bindChannelThread(
    {
      jobId: "job-1",
      deliveryId: "delivery-1",
      threadId: "thread-1",
      projectId: "project-1",
    },
    { path, now: () => 3 },
  );
  assert.equal(bound.status, "routing");
  const job = getJob("job-1", { path });
  assert.equal(job.status, "routing");
  assert.equal(job.bindingState, "ready");
  assert.equal(job.channelThreadId, "thread-1");
  assert.equal(
    getReservedDelivery({ jobId: "job-1", deliveryId: "delivery-1" }, { path })
      .channel.threadId,
    "thread-1",
  );
  assert.equal(
    getReservedDelivery({ jobId: "job-1", deliveryId: "stale" }, { path }),
    null,
  );
});

test("a failed route returns to pending with its marker retained for dedupe", async () => {
  const path = await inbox();
  queue(path);
  reserve(path);
  const retried = retryRoutingMessage(
    {
      jobId: "job-1",
      deliveryId: "delivery-1",
      error: "daemon unavailable",
    },
    { path, now: () => 3 },
  );
  assert.equal(retried.status, "pending");
  const next = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-2" },
    { path, now: () => 4, createDeliveryId: () => "delivery-2" },
  );
  assert.deepEqual(next.dedupeMarkers, [
    "synapse-delivery:v2 job=job-1 delivery=delivery-2",
    "synapse-delivery:v2 job=job-1 delivery=delivery-1",
  ]);
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

test("client acceptance is durable and queues later same-channel messages", async () => {
  const path = await inbox();
  queue(path);
  reserve(path);
  const accepted = acceptProvisioning(
    {
      jobId: "job-1",
      deliveryId: "delivery-1",
      clientThreadId: "client-1",
      projectId: "project-1",
    },
    { path, now: () => 3 },
  );
  assert.deepEqual(accepted, {
    jobId: "job-1",
    channelId: "demo",
    clientThreadId: "client-1",
    threadId: null,
    status: "accepted",
  });
  assert.equal(
    acceptProvisioning(
      {
        jobId: "job-1",
        deliveryId: "delivery-1",
        clientThreadId: "client-1",
        projectId: "project-1",
      },
      { path, now: () => 4 },
    ).status,
    "accepted",
  );

  queue(path, "job-2", "demo", "second");
  assert.equal(
    reserveNextMessage(
      { projectRoot: "/project", ownerSessionId: "owner-2" },
      { path, now: () => 5 },
    ),
    null,
  );
  const job = getJob("job-1", { path });
  assert.equal(job.status, "accepted");
  assert.equal(job.bindingState, "provisioning");
  assert.equal(job.clientThreadId, "client-1");
});

test("acceptance followed by child observation finalizes and releases the channel", async () => {
  const path = await inbox();
  queue(path);
  reserve(path);
  acceptProvisioning(
    {
      jobId: "job-1",
      deliveryId: "delivery-1",
      clientThreadId: "client-1",
      projectId: "project-1",
      hostId: "local",
    },
    { path, now: () => 3 },
  );
  queue(path, "job-2", "demo", "second");
  assert.equal(
    observeProvisionedThread(
      {
        jobId: "job-1",
        deliveryId: "delivery-1",
        threadId: "thread-1",
      },
      { path, now: () => 4 },
    ).status,
    "completed",
  );

  const followUp = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-2" },
    { path, now: () => 5, createDeliveryId: () => "delivery-2" },
  );
  assert.equal(followUp.jobId, "job-2");
  assert.deepEqual(followUp.channel, {
    bindingState: "ready",
    bindingRole: "recipient",
    pauseReason: null,
    clientThreadId: "client-1",
    threadId: "thread-1",
    hostId: "local",
    projectId: "project-1",
  });
});

test("child observation may win the race before provisional acceptance", async () => {
  const path = await inbox();
  queue(path);
  reserve(path);
  assert.equal(
    observeProvisionedThread(
      {
        jobId: "job-1",
        deliveryId: "delivery-1",
        threadId: "thread-1",
      },
      { path, now: () => 3 },
    ).status,
    "completed",
  );
  const accepted = acceptProvisioning(
    {
      jobId: "job-1",
      deliveryId: "delivery-1",
      clientThreadId: "client-1",
      projectId: "project-1",
      hostId: "local",
    },
    { path, now: () => 4 },
  );
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.threadId, "thread-1");
  assert.equal(getJob("job-1", { path }).clientThreadId, "client-1");
});

test("stale and conflicting observations are rejected", async () => {
  const path = await inbox();
  queue(path);
  reserve(path);
  assert.throws(
    () =>
      observeProvisionedThread(
        {
          jobId: "job-1",
          deliveryId: "wrong",
          threadId: "thread-1",
        },
        { path },
      ),
    /Stale delivery/,
  );
  observeProvisionedThread(
    {
      jobId: "job-1",
      deliveryId: "delivery-1",
      threadId: "thread-1",
    },
    { path },
  );
  assert.throws(
    () =>
      observeProvisionedThread(
        {
          jobId: "job-1",
          deliveryId: "delivery-1",
          threadId: "thread-2",
        },
        { path },
      ),
    /Conflicting permanent task/,
  );
});

test("stale acknowledgements cannot complete a reserved message", async () => {
  const path = await inbox();
  queue(path);
  reserve(path);
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

test("an expired routing delivery retries only on the original owner with one identity", async () => {
  const path = await inbox();
  queue(path);
  reserve(path, "owner-1", { now: () => 100, leaseMs: 10 });
  assert.equal(
    reserveNextMessage(
      { projectRoot: "/project", ownerSessionId: "owner-2" },
      { path, now: () => 111 },
    ),
    null,
  );
  const retried = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path, now: () => 111, createDeliveryId: () => "delivery-2" },
  );
  assert.equal(retried.deliveryId, "delivery-1");
  assert.equal(
    retried.deliveryMarker,
    "synapse-delivery:v2 job=job-1 delivery=delivery-1",
  );
  assert.equal(retried.retrying, true);
});

test("an accepted task cannot be manually requeued", async () => {
  const path = await inbox();
  queue(path);
  reserve(path);
  acceptProvisioning(
    {
      jobId: "job-1",
      deliveryId: "delivery-1",
      clientThreadId: "client-1",
      projectId: "project-1",
    },
    { path },
  );
  assert.throws(
    () => recoverMessage({ jobId: "job-1", ownerStopped: true }, { path }),
    /must be reconciled, not retried/,
  );
});

test("legacy in-flight jobs migrate to explicit recovery", async () => {
  const path = await inbox();
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE channels (id TEXT PRIMARY KEY, project_root TEXT NOT NULL,
      thread_id TEXT, host_id TEXT, project_id TEXT);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, task TEXT NOT NULL,
      project_root TEXT NOT NULL, status TEXT NOT NULL, delivery_id TEXT,
      lease_expires_at INTEGER, thread_id TEXT, created_at INTEGER NOT NULL,
      completed_at INTEGER);
    INSERT INTO channels (id, project_root) VALUES ('demo', '/project');
    INSERT INTO jobs (id, channel_id, task, project_root, status, delivery_id,
      lease_expires_at, created_at) VALUES
      ('job-1', 'demo', 'legacy task', '/project', 'routing', 'delivery-1', 100, 1);
  `);
  database.close();

  assert.equal(getJob("job-1", { path }).status, "uncertain");
  assert.throws(
    () => recoverMessage({ jobId: "job-1", ownerStopped: false }, { path }),
    /prior owner task stopped/,
  );
  assert.equal(
    recoverMessage(
      { jobId: "job-1", ownerStopped: true },
      { path, now: () => 200 },
    ).status,
    "pending",
  );
  const retried = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-2" },
    { path, now: () => 201, createDeliveryId: () => "delivery-2" },
  );
  assert.equal(
    retried.deliveryMarker,
    "synapse-delivery:v2 job=job-1 delivery=delivery-2",
  );
  assert.deepEqual(retried.dedupeMarkers, [
    "synapse-delivery:v2 job=job-1 delivery=delivery-2",
    "synapse-delivery:job-1",
  ]);
});

test("an owned legacy in-flight delivery keeps its original marker on retry", async () => {
  const path = await inbox();
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE channels (id TEXT PRIMARY KEY, project_root TEXT NOT NULL,
      thread_id TEXT, host_id TEXT, project_id TEXT);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, task TEXT NOT NULL,
      project_root TEXT NOT NULL, status TEXT NOT NULL, delivery_id TEXT,
      lease_expires_at INTEGER, owner_session_id TEXT, thread_id TEXT,
      created_at INTEGER NOT NULL, completed_at INTEGER);
    INSERT INTO channels (id, project_root) VALUES ('demo', '/project');
    INSERT INTO jobs (id, channel_id, task, project_root, status, delivery_id,
      lease_expires_at, owner_session_id, created_at) VALUES
      ('job-1', 'demo', 'legacy task', '/project', 'routing', 'delivery-1',
       100, 'owner-1', 1);
  `);
  database.close();
  const retried = reserveNextMessage(
    { projectRoot: "/project", ownerSessionId: "owner-1" },
    { path, now: () => 101 },
  );
  assert.equal(retried.markerVersion, 1);
  assert.equal(retried.deliveryMarker, "synapse-delivery:job-1");
  assert.equal(
    retried.nativePrompt,
    "legacy task\n\n<!-- synapse-delivery:job-1 -->",
  );
});

test("a channel stays attached to its original project", async () => {
  const path = await inbox();
  queue(path);
  assert.throws(
    () =>
      queueMessage(
        {
          id: "job-2",
          channelId: "demo",
          task: "wrong",
          projectRoot: "/other",
        },
        { path },
      ),
    /attached to \/project/,
  );
});
