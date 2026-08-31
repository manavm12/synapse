import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments, sendTask } from "../../src/client/cli.mjs";

test("the CLI parses a channel and multi-word task", () => {
  assert.deepEqual(
    parseArguments(["send", "person-a--person-b", "create", "a", "file"]),
    {
      command: "send",
      channelId: "person-a--person-b",
      task: "create a file",
    },
  );
});

test("the CLI dispatches a task and reports its project thread and worktree", async () => {
  let storedJob = null;
  let dispatches = 0;
  const statuses = [];

  const summary = await sendTask(
    {
      channelId: "person-a--person-b",
      sender: "person-a",
      task: "create a proof file",
    },
    {
      statePath: "/tmp/test-state.json",
      createJobId: () => "manual-1",
      addJob: async (_path, job) => {
        storedJob = { ...job, status: "pending", result: null, error: null };
      },
      getJob: async () => storedJob,
      getChannel: async () => ({
        threadId: "thread-1",
        worktreePath: "/tmp/project-worktree",
      }),
      dispatch: async () => {
        dispatches += 1;
        storedJob.status = "claimed";
      },
      wait: async () => {
        storedJob.status = "completed";
        storedJob.workerFinishedAt = "2026-08-31T00:00:00.000Z";
        storedJob.result = "proof created";
      },
      onStatus: ({ status }) => statuses.push(status),
    },
  );

  assert.equal(dispatches, 1);
  assert.equal(storedJob.task, "create a proof file");
  assert.deepEqual(statuses, ["pending", "completed"]);
  assert.deepEqual(summary, {
    jobId: "manual-1",
    channelId: "person-a--person-b",
    status: "completed",
    threadId: "thread-1",
    worktreePath: "/tmp/project-worktree",
    result: "proof created",
  });
});

test("the CLI surfaces a blocked job instead of waiting forever", async () => {
  await assert.rejects(
    () =>
      sendTask(
        { channelId: "channel-1", task: "task" },
        {
          createJobId: () => "manual-1",
          addJob: async () => {},
          getJob: async () => ({
            status: "blocked",
            error: "previous turn could not be stopped",
          }),
          onStatus: () => {},
        },
      ),
    /previous turn could not be stopped/,
  );
});
