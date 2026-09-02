import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acknowledgeMessage,
  getJob,
  queueMessage,
  reserveNextMessage,
} from "../../plugins/synapse/lib/inbox.mjs";

async function inbox() {
  return join(await mkdtemp(join(tmpdir(), "synapse-inbox-test-")), "inbox.sqlite");
}

test("a project prompt leases and acknowledges one queued message", async () => {
  const path = await inbox();
  queueMessage(
    { id: "job-1", channelId: "demo", task: "create a file", projectRoot: "/project" },
    { path, now: () => 1 },
  );
  const delivery = reserveNextMessage(
    { projectRoot: "/project" },
    { path, now: () => 2, createDeliveryId: () => "delivery-1" },
  );
  assert.equal(delivery.task, "create a file");
  assert.equal(delivery.channel.threadId, null);
  assert.equal(
    reserveNextMessage({ projectRoot: "/project" }, { path, now: () => 3 }),
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

test("a follow-up reuses the native channel and a channel stays in one project", async () => {
  const path = await inbox();
  queueMessage(
    { id: "job-1", channelId: "demo", task: "first", projectRoot: "/project" },
    { path },
  );
  const first = reserveNextMessage(
    { projectRoot: "/project" },
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
  const followUp = reserveNextMessage({ projectRoot: "/project" }, { path });
  assert.deepEqual(followUp.channel, {
    threadId: "thread-1",
    hostId: "local",
    projectId: "project-1",
  });
  assert.throws(
    () => queueMessage(
      { id: "job-3", channelId: "demo", task: "wrong", projectRoot: "/other" },
      { path },
    ),
    /attached to \/project/,
  );
});

test("an expired delivery is available on the next owner prompt", async () => {
  const path = await inbox();
  queueMessage(
    { id: "job-1", channelId: "demo", task: "retry", projectRoot: "/project" },
    { path },
  );
  reserveNextMessage(
    { projectRoot: "/project" },
    { path, now: () => 100, leaseMs: 10, createDeliveryId: () => "delivery-1" },
  );
  const retried = reserveNextMessage(
    { projectRoot: "/project" },
    { path, now: () => 111, createDeliveryId: () => "delivery-2" },
  );
  assert.equal(retried.deliveryId, "delivery-2");
});
