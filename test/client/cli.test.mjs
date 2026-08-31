import assert from "node:assert/strict";
import test from "node:test";

import {
  parseArguments,
  resolveProjectRoot,
  sendTask,
} from "../../src/client/cli.mjs";

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

test("the CLI attaches a message to a named project", () => {
  assert.deepEqual(
    parseArguments([
      "send",
      "person-a--person-b",
      "--project",
      "synapse",
      "create",
      "a",
      "file",
    ]),
    {
      command: "send",
      channelId: "person-a--person-b",
      task: "create a file",
      project: "synapse",
    },
  );
  assert.equal(
    resolveProjectRoot("synapse", "/Users/example/synapse"),
    "/Users/example/synapse",
  );
});

test("the CLI parses the internal native-delivery acknowledgement", () => {
  assert.deepEqual(
    parseArguments([
      "acknowledge",
      "job-1",
      "delivery-1",
      "thread-1",
      "local",
      "project-1",
    ]),
    {
      command: "acknowledge",
      jobId: "job-1",
      deliveryId: "delivery-1",
      threadId: "thread-1",
      hostId: "local",
      projectId: "project-1",
    },
  );
});

test("send queues a task without starting a detached Codex writer", async () => {
  let storedJob = null;

  const summary = await sendTask(
    {
      channelId: "person-a--person-b",
      sender: "person-a",
      task: "create a proof file",
      projectRoot: "/tmp/example-project",
    },
    {
      statePath: "/tmp/test-state.json",
      createJobId: () => "manual-1",
      addJob: async (_path, job) => {
        storedJob = job;
        return {
          jobId: job.id,
          channelId: job.channelId,
          sender: job.sender,
          status: "pending",
        };
      },
    },
  );

  assert.equal(storedJob.task, "create a proof file");
  assert.equal(storedJob.projectRoot, "/tmp/example-project");
  assert.deepEqual(summary, {
    jobId: "manual-1",
    channelId: "person-a--person-b",
    sender: "person-a",
    status: "pending",
    delivery: "codex-project",
  });
});
