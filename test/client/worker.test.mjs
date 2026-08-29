import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeJob } from "../../src/client/worker.mjs";
import {
  addJob,
  claimTask,
  completeTask,
  readState,
  reserveNextJob,
} from "../../src/client/store.mjs";

test("a worker error marks its dispatched job failed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-worker-test-"));
  const statePath = join(directory, "state.json");
  await addJob(statePath, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "task",
  });
  const dispatch = await reserveNextJob(statePath);

  await assert.rejects(
    () =>
      executeJob({
        jobId: "job-1",
        channelId: "channel-1",
        dispatchId: dispatch.dispatchId,
        statePath,
        run: async () => {
          throw new Error("App Server stopped");
        },
      }),
    /App Server stopped/,
  );

  const state = await readState(statePath);
  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[0].error, "App Server stopped");
  assert.ok(state.jobs[0].workerFinishedAt);
});

test("a worker that exits without completing its job marks it failed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-worker-test-"));
  const statePath = join(directory, "state.json");
  await addJob(statePath, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "task",
  });
  const dispatch = await reserveNextJob(statePath);

  await assert.rejects(
    () =>
      executeJob({
        jobId: "job-1",
        channelId: "channel-1",
        dispatchId: dispatch.dispatchId,
        statePath,
        run: async () => {},
      }),
    /without completing job-1/,
  );

  assert.equal((await readState(statePath)).jobs[0].status, "failed");
});

test("a late worker error does not overwrite an already completed job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-worker-test-"));
  const statePath = join(directory, "state.json");
  await addJob(statePath, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "task",
  });
  const dispatch = await reserveNextJob(statePath);

  await executeJob({
    jobId: "job-1",
    channelId: "channel-1",
    dispatchId: dispatch.dispatchId,
    statePath,
    run: async () => {
      await claimTask(statePath, "job-1", dispatch.dispatchId);
      await completeTask(statePath, "job-1", dispatch.dispatchId, "done");
      throw new Error("late disconnect");
    },
  });

  const job = (await readState(statePath)).jobs[0];
  assert.equal(job.status, "completed");
  assert.ok(job.workerFinishedAt);
});
