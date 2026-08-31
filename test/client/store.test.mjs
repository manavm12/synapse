import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  addJob,
  claimTask,
  completeTask,
  completeDeadJobRecovery,
  failTask,
  getChannel,
  readState,
  reserveDeadJobRecovery,
  reserveNextJob,
  setJobTurn,
  setJobWorker,
  setChannelThread,
} from "../../src/client/store.mjs";

async function statePath() {
  const directory = await mkdtemp(join(tmpdir(), "synapse-store-test-"));
  return join(directory, "state.json");
}

test("reserving a job exposes metadata once without leaking the task", async () => {
  const path = await statePath();
  const secret = "SECRET-TASK-CONTENTS";
  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: secret,
  });

  const first = await reserveNextJob(path, { createDispatchId: () => "dispatch-1" });
  const second = await reserveNextJob(path);

  assert.deepEqual(first, {
    jobId: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    status: "dispatched",
    dispatchId: "dispatch-1",
  });
  assert.equal(second, null);
  assert.equal(JSON.stringify(first).includes(secret), false);
});

test("a child can claim and complete the hidden task", async () => {
  const path = await statePath();
  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "write the proof file",
  });
  const dispatch = await reserveNextJob(path);

  const claim = await claimTask(path, "job-1", dispatch.dispatchId);
  await completeTask(path, "job-1", dispatch.dispatchId, "proof written");
  const state = await readState(path);

  assert.equal(claim.task, "write the proof file");
  assert.equal(state.jobs[0].status, "completed");
  assert.equal(state.jobs[0].result, "proof written");
});

test("a task cannot be claimed by a second caller", async () => {
  const path = await statePath();
  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "hidden task",
  });
  const dispatch = await reserveNextJob(path);
  await claimTask(path, "job-1", dispatch.dispatchId);

  await assert.rejects(
    () => claimTask(path, "job-1", dispatch.dispatchId),
    /cannot be claimed/,
  );
});

test("only one job per channel can be active", async () => {
  const path = await statePath();
  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "first",
  });
  await addJob(path, {
    id: "job-2",
    channelId: "channel-1",
    sender: "person-a",
    task: "second",
  });

  const first = await reserveNextJob(path);
  assert.equal(first.jobId, "job-1");
  assert.equal(await reserveNextJob(path), null);
  await claimTask(path, "job-1", first.dispatchId);
  await completeTask(path, "job-1", first.dispatchId, "done");
  assert.equal((await reserveNextJob(path)).jobId, "job-2");
});

test("a dispatched or claimed job can be marked failed", async () => {
  const path = await statePath();
  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "task",
  });
  const dispatch = await reserveNextJob(path);

  await failTask(path, "job-1", dispatch.dispatchId, "worker stopped");
  const state = await readState(path);

  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[0].error, "worker stopped");
});

test("state mutation recovers a lock owned by a dead process", async () => {
  const path = await statePath();
  await mkdir(`${path}.lock`, { recursive: true });
  await writeFile(join(`${path}.lock`, "owner-2147483647-stale"), "", "utf8");

  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "task",
  });

  assert.equal((await readState(path)).jobs.length, 1);
});

test("state mutation recovers a malformed lock", async () => {
  const path = await statePath();
  await mkdir(`${path}.lock`, { recursive: true });

  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "task",
  });

  assert.equal((await readState(path)).jobs.length, 1);
});

test("concurrent mutations do not lose jobs while recovering a stale lock", async () => {
  const path = await statePath();
  await mkdir(`${path}.lock`, { recursive: true });
  await writeFile(join(`${path}.lock`, "owner-2147483647-stale"), "", "utf8");

  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      addJob(path, {
        id: `job-${index}`,
        channelId: `channel-${index}`,
        sender: "person-a",
        task: "task",
      }),
    ),
  );

  const state = await readState(path);
  assert.equal(state.jobs.length, 10);
  assert.equal(new Set(state.jobs.map((job) => job.id)).size, 10);
});

test("a dead worker's turn is recovered before its job can be dispatched again", async () => {
  const path = await statePath();
  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "task",
  });
  const dispatch = await reserveNextJob(path, {
    createDispatchId: () => "dispatch-1",
  });
  await setJobWorker(path, "job-1", dispatch.dispatchId, 2147483647);
  await setJobTurn(path, "job-1", dispatch.dispatchId, {
    threadId: "thread-1",
    turnId: "turn-1",
  });

  const recovery = await reserveDeadJobRecovery(path, {
    createRecoveryId: () => "recovery-1",
  });

  assert.deepEqual(recovery, {
    jobId: "job-1",
    channelId: "channel-1",
    dispatchId: "dispatch-1",
    recoveryId: "recovery-1",
    threadId: "thread-1",
    turnId: "turn-1",
  });
  assert.equal(await reserveNextJob(path), null);
  assert.equal(
    await completeDeadJobRecovery(
      path,
      "job-1",
      "dispatch-1",
      "recovery-1",
    ),
    true,
  );
  const retried = await reserveNextJob(path, {
    createDispatchId: () => "dispatch-2",
  });
  assert.equal(retried.jobId, "job-1");
  assert.equal(retried.dispatchId, "dispatch-2");
});

test("a dead worker without a recorded turn blocks its channel", async () => {
  const path = await statePath();
  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "task",
  });
  await addJob(path, {
    id: "job-2",
    channelId: "channel-1",
    sender: "person-a",
    task: "follow-up",
  });
  const dispatch = await reserveNextJob(path);
  await setJobWorker(path, "job-1", dispatch.dispatchId, 2147483647);

  assert.equal(await reserveDeadJobRecovery(path), null);
  assert.equal(await reserveNextJob(path), null);

  const state = await readState(path);
  assert.equal(state.jobs[0].status, "blocked");
  assert.match(state.jobs[0].error, /could be identified safely/);
  assert.equal(state.jobs[1].status, "pending");
});

test("a task assignment cannot cross its server-bound channel", async () => {
  const path = await statePath();
  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "task",
  });
  const dispatch = await reserveNextJob(path);

  await assert.rejects(
    () => claimTask(path, "job-1", dispatch.dispatchId, "channel-2"),
    /does not belong to channel channel-2/,
  );
  assert.equal((await readState(path)).jobs[0].status, "dispatched");
});

test("an unowned dispatch is retried after its startup lease expires", async () => {
  const path = await statePath();
  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "task",
  });
  await reserveNextJob(path, { now: 1_000, unownedLeaseMs: 100 });

  const retried = await reserveNextJob(path, { now: 1_101, unownedLeaseMs: 100 });

  assert.equal(retried.jobId, "job-1");
});

test("a stale worker cannot modify a replacement dispatch attempt", async () => {
  const path = await statePath();
  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "task",
  });
  const first = await reserveNextJob(path, {
    now: 1_000,
    unownedLeaseMs: 100,
    createDispatchId: () => "attempt-a",
  });
  await reserveNextJob(path, {
    now: 1_101,
    unownedLeaseMs: 100,
    createDispatchId: () => "attempt-b",
  });

  await assert.rejects(
    () => setJobWorker(path, "job-1", first.dispatchId, process.pid),
    /Stale dispatch attempt/,
  );
  assert.equal(await failTask(path, "job-1", first.dispatchId, "stale worker"), false);
  assert.equal((await readState(path)).jobs[0].status, "dispatched");
});

test("job metadata rejects values that are unsafe for process boundaries", async () => {
  const path = await statePath();

  await assert.rejects(
    () =>
      addJob(path, {
        id: "../outside",
        channelId: "channel-1",
        sender: "person-a",
        task: "task",
      }),
    /Invalid job ID/,
  );
});

test("follow-up jobs reuse the channel thread", async () => {
  const path = await statePath();
  await setChannelThread(path, "channel-1", {
    threadId: "thread-123",
    worktreePath: "/tmp/synapse-channel-1",
  });
  await addJob(path, {
    id: "job-2",
    channelId: "channel-1",
    sender: "person-a",
    task: "follow up",
  });

  const channel = await getChannel(path, "channel-1");
  const metadata = await reserveNextJob(path);

  assert.equal(channel.threadId, "thread-123");
  assert.equal(metadata.jobId, "job-2");
});
